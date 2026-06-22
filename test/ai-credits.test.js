// Tests for the hosted-AI credit bundles + OpenAI-compatible proxy.
//
// Covers the pure helpers (config resolution, validators, cost maths, model
// resolution, upstream-body builder), the SQLite session store, and a full
// Fastify-injected run of both routes using a fake facilitator (for the x402
// buy) and a fake upstream fetch (for the proxy) — no real model or
// facilitator needed in CI.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify from 'fastify';

import {
	resolveAiConfig,
	validateCreditsBody,
	computeCostAtomic,
	estimateTokensFromMessages,
	resolveModel,
	bearerToken,
	buildUpstreamBody,
	usdToAtomic,
	atomicToUsd,
	registerAiRoutes
} from '../src/ai-credits.js';
import {
	openAiDb,
	createAiSession,
	getAiSessionByToken,
	debitAiSession,
	creditAiSession,
	purgeExpiredAiSessions,
	aiStatsSnapshot,
	hashToken
} from '../src/ai-session-store.js';

const X402_CFG = Object.freeze({
	enabled: true,
	recipient: '0x46Ba634261566CF242c853d1f49511f9268ba674',
	network: 'eip155:8453',
	facilitatorUrl: 'https://facilitator.example.com',
	maxTimeoutSeconds: 120,
	routes: {}
});

function aiConfig(overrides = {}) {
	return {
		enabled: true,
		upstreamBaseUrl: 'https://up.test/api/v1',
		upstreamApiKey: 'sk-upstream',
		upstreamHeaders: null,
		defaultModel: 'm-default',
		allowlist: ['m-default', 'm-allowed'],
		publicBaseUrl: '',
		dbPath: ':memory:',
		sessionTtlMs: 3_600_000,
		requestTimeoutMs: 5_000,
		maxTokensCap: 4096,
		bundleDefaultAtomic: 5_000_000,
		bundleMinAtomic: 500_000,
		bundleMaxAtomic: 20_000_000,
		pricing: { per1kInputAtomic: 1000, per1kOutputAtomic: 3000, minCallAtomic: 200 },
		...overrides
	};
}

/* ───────────────────────────── pure helpers ───────────────────────────── */

describe('resolveAiConfig', () => {
	test('enabled when an upstream key is present; derives db path + bundle atomic', () => {
		const cfg = resolveAiConfig({
			aiUpstreamApiKey: 'sk-x', aiUpstreamBaseUrl: 'https://u/v1', aiDefaultModel: 'm1',
			aiModelAllowlist: 'm1, m2 ,', aiCreditDefaultUsdCents: 500, aiCreditMinUsdCents: 50,
			aiCreditMaxUsdCents: 2000, aiSessionTtlSec: 3600, privateWatchDbPath: '/var/lib/x/private-watches.db'
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.dbPath).toBe('/var/lib/x/ai-sessions.db');
		expect(cfg.allowlist).toEqual(['m1', 'm2']);
		expect(cfg.bundleDefaultAtomic).toBe(5_000_000);
		expect(cfg.bundleMinAtomic).toBe(500_000);
		expect(cfg.sessionTtlMs).toBe(3_600_000);
	});
	test('disabled when no key and AI_ENABLED off', () => {
		expect(resolveAiConfig({ aiUpstreamApiKey: '' }).enabled).toBe(false);
		expect(resolveAiConfig({ aiUpstreamApiKey: '', aiEnabled: true }).enabled).toBe(true);
	});
	test('builds OpenRouter attribution headers when configured', () => {
		const cfg = resolveAiConfig({ aiUpstreamApiKey: 'k', aiUpstreamReferer: 'https://winbit32.com', aiUpstreamTitle: 'WinBit32' });
		expect(cfg.upstreamHeaders['HTTP-Referer']).toBe('https://winbit32.com');
		expect(cfg.upstreamHeaders['X-Title']).toBe('WinBit32');
	});
});

describe('validateCreditsBody', () => {
	const limits = { defaultAtomic: 5_000_000, minAtomic: 500_000, maxAtomic: 20_000_000 };
	test('bundleUsd → atomic', () => {
		expect(validateCreditsBody({ bundleUsd: 5 }, limits).amountAtomic).toBe(5_000_000);
	});
	test('defaults when empty', () => {
		expect(validateCreditsBody({}, limits).amountAtomic).toBe(5_000_000);
	});
	test('clamps to range rather than throwing', () => {
		expect(validateCreditsBody({ bundleUsd: 1000 }, limits).amountAtomic).toBe(20_000_000);
		expect(validateCreditsBody({ bundleUsd: 0.01 }, limits).amountAtomic).toBe(500_000);
	});
	test('captures model hint, rejects bad bundleUsd', () => {
		expect(validateCreditsBody({ bundleUsd: 5, model: ' m-x ' }, limits).model).toBe('m-x');
		expect(() => validateCreditsBody({ bundleUsd: -1 }, limits)).toThrow(/bundleUsd/);
		expect(() => validateCreditsBody({ bundleUsd: 'x' }, limits)).toThrow();
	});
});

describe('computeCostAtomic', () => {
	const pricing = { per1kInputAtomic: 1000, per1kOutputAtomic: 3000, minCallAtomic: 200 };
	test('bills measured usage (input + output rates)', () => {
		expect(computeCostAtomic({ usage: { prompt_tokens: 1000, completion_tokens: 500 }, pricing })).toBe(2500);
	});
	test('applies the per-call floor', () => {
		expect(computeCostAtomic({ usage: { prompt_tokens: 1, completion_tokens: 1 }, pricing })).toBe(200);
	});
	test('falls back to estimate (output rate) when usage missing', () => {
		expect(computeCostAtomic({ usage: null, pricing, fallbackTokens: 1000 })).toBe(3000);
	});
});

describe('estimateTokensFromMessages', () => {
	test('roughly chars/4 over string + array content', () => {
		expect(estimateTokensFromMessages([{ content: 'a'.repeat(40) }])).toBe(10);
		expect(estimateTokensFromMessages([{ content: [{ text: 'b'.repeat(8) }] }])).toBe(2);
		expect(estimateTokensFromMessages('nope')).toBe(0);
	});
});

describe('resolveModel', () => {
	test("'auto'/'' fall back to session then default", () => {
		expect(resolveModel('auto', { defaultModel: 'd', allowlist: [] })).toBe('d');
		expect(resolveModel('', { sessionModel: 's', defaultModel: 'd', allowlist: [] })).toBe('s');
		expect(resolveModel('m-allowed', { defaultModel: 'd', allowlist: ['m-allowed'] })).toBe('m-allowed');
	});
	test('enforces allowlist', () => {
		expect(() => resolveModel('evil', { defaultModel: 'd', allowlist: ['d'] })).toThrow(/allowlist/);
	});
});

describe('bearerToken / buildUpstreamBody / usd maths', () => {
	test('parses Authorization: Bearer', () => {
		expect(bearerToken('Bearer abc.def')).toBe('abc.def');
		expect(bearerToken('bearer  spaced')).toBe('spaced');
		expect(bearerToken('Basic x')).toBeNull();
		expect(bearerToken(undefined)).toBeNull();
	});
	test('forces stream:false, caps max_tokens, passes through known fields', () => {
		const out = buildUpstreamBody({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999, stream: true, temperature: 0.5, foo: 'drop' }, { model: 'm', maxTokensCap: 4096 });
		expect(out.stream).toBe(false);
		expect(out.max_tokens).toBe(4096);
		expect(out.temperature).toBe(0.5);
		expect(out.foo).toBeUndefined();
		expect(out.model).toBe('m');
	});
	test('usd<->atomic round trips', () => {
		expect(usdToAtomic(5)).toBe(5_000_000);
		expect(atomicToUsd(2_500_000)).toBe(2.5);
	});
});

/* ───────────────────────────── session store ──────────────────────────── */

describe('ai-session-store', () => {
	let db;
	beforeEach(() => { db = openAiDb(':memory:'); });
	afterEach(() => { if (db) db.close(); });

	test('create → lookup by token → debit clamps at zero', () => {
		const { token, session } = createAiSession(db, { creditAtomic: 1_000_000, ttlMs: 3_600_000 });
		expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
		expect(session.remainingAtomic).toBe(1_000_000);

		const got = getAiSessionByToken(db, token);
		expect(got.id).toBe(session.id);

		const d1 = debitAiSession(db, session.id, 400_000);
		expect(d1.remainingAtomic).toBe(600_000);
		expect(d1.calls).toBe(1);

		const d2 = debitAiSession(db, session.id, 9_999_999); // over-spend clamps
		expect(d2.remainingAtomic).toBe(0);
		expect(d2.spentAtomic).toBe(1_000_000);
	});

	test('only the hash is stored; unknown/expired tokens return null', () => {
		const { token, session } = createAiSession(db, { creditAtomic: 1000, ttlMs: 3_600_000 });
		const raw = db.prepare('SELECT token_hash FROM ai_sessions WHERE id = ?').get(session.id);
		expect(raw.token_hash).toBe(hashToken(token));
		expect(raw.token_hash).not.toContain(token);
		expect(getAiSessionByToken(db, 'nope')).toBeNull();
		const past = createAiSession(db, { creditAtomic: 1000, ttlMs: 1, nowMs: Date.now() - 10_000 });
		expect(getAiSessionByToken(db, past.token)).toBeNull();
	});

	test('credit top-up adds balance + extends ttl; purge + stats', () => {
		const { session } = createAiSession(db, { creditAtomic: 1000, ttlMs: 3_600_000 });
		const up = creditAiSession(db, session.id, 5000);
		expect(up.creditAtomic).toBe(6000);
		expect(up.topupsAtomic).toBe(6000);

		createAiSession(db, { creditAtomic: 1000, ttlMs: 1, nowMs: Date.now() - 10_000 });
		expect(purgeExpiredAiSessions(db)).toBe(1);
		const snap = aiStatsSnapshot(db);
		expect(snap.total).toBe(1);
		expect(snap.active).toBe(1);
	});
});

/* ─────────────────────────── HTTP integration ─────────────────────────── */

describe('registerAiRoutes (HTTP integration)', () => {
	let app, db, fakeFacilitator, fakeFetch, cfg;

	function mintPayload(amountAtomic) {
		return Buffer.from(JSON.stringify({ payload: { authorization: { value: String(amountAtomic) } } })).toString('base64');
	}

	beforeEach(async () => {
		app = Fastify({ logger: false });
		db = openAiDb(':memory:');
		cfg = aiConfig();
		fakeFacilitator = {
			verify: jest.fn(async () => ({ isValid: true })),
			settle: jest.fn(async () => ({ success: true, tx: '0xtx', payer: '0xpayer' }))
		};
		fakeFetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({
				id: 'cmpl-1',
				choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 50 }
			})
		}));
		registerAiRoutes(app, {
			aiDb: db,
			aiConfig: cfg,
			x402Cfg: X402_CFG,
			requirePaywall: () => false,
			facilitatorFactory: async () => fakeFacilitator,
			fetchImpl: fakeFetch
		});
		await app.ready();
	});

	afterEach(async () => {
		if (app) await app.close();
		if (db) db.close();
	});

	async function buyBundle(bundleUsd = 5) {
		const amount = usdToAtomic(bundleUsd);
		const r = await app.inject({
			method: 'POST', url: '/v1/ai/credits',
			headers: { 'x-payment': mintPayload(amount) },
			payload: { bundleUsd }
		});
		return { r, body: JSON.parse(r.body) };
	}

	test('GET /v1/ai exposes metadata', async () => {
		const r = await app.inject({ method: 'GET', url: '/v1/ai' });
		expect(r.statusCode).toBe(200);
		const b = JSON.parse(r.body);
		expect(b.enabled).toBe(true);
		expect(b.default_model).toBe('m-default');
		expect(b.base_url).toMatch(/\/v1\/ai$/);
	});

	test('POST /v1/ai/credits → 402 challenge without x-payment', async () => {
		const r = await app.inject({ method: 'POST', url: '/v1/ai/credits', payload: { bundleUsd: 5 } });
		expect(r.statusCode).toBe(402);
		const decoded = JSON.parse(Buffer.from(r.headers['payment-required'], 'base64').toString());
		expect(decoded.accepts[0].amount).toBe('5000000');
	});

	test('POST /v1/ai/credits → 400 on amount mismatch', async () => {
		const r = await app.inject({ method: 'POST', url: '/v1/ai/credits', headers: { 'x-payment': mintPayload(123) }, payload: { bundleUsd: 5 } });
		expect(r.statusCode).toBe(400);
		expect(JSON.parse(r.body).error.code).toBe('amount_mismatch');
	});

	test('POST /v1/ai/credits → 200 mints a session token + baseUrl + credits', async () => {
		const { r, body } = await buyBundle(5);
		expect(r.statusCode).toBe(200);
		expect(typeof body.token).toBe('string');
		expect(body.baseUrl).toMatch(/\/v1\/ai$/);
		expect(body.credits).toBe(5);
		expect(body.creditAtomic).toBe('5000000');
		expect(fakeFacilitator.verify).toHaveBeenCalledTimes(1);
		expect(fakeFacilitator.settle).toHaveBeenCalledTimes(1);
		expect(getAiSessionByToken(db, body.token)).toBeTruthy();
	});

	test('chat/completions → 401 without / with bad token', async () => {
		const noTok = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', payload: { messages: [{ role: 'user', content: 'hi' }] } });
		expect(noTok.statusCode).toBe(401);
		const badTok = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: 'Bearer nope' }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
		expect(badTok.statusCode).toBe(401);
	});

	test('chat/completions → 200 proxies upstream, debits credit, sets headers', async () => {
		const { body: bundle } = await buyBundle(5);
		const r = await app.inject({
			method: 'POST', url: '/v1/ai/chat/completions',
			headers: { authorization: `Bearer ${bundle.token}` },
			payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }
		});
		expect(r.statusCode).toBe(200);
		const b = JSON.parse(r.body);
		expect(b.choices[0].message.content).toBe('hello');
		// 100 in * $0.001/1k + 50 out * $0.003/1k = 100 + 150 = 250 atomic
		expect(r.headers['x-ai-cost-usd']).toBe(String(atomicToUsd(250)));
		expect(r.headers['x-ai-credits-remaining-usd']).toBe(String(atomicToUsd(5_000_000 - 250)));
		// upstream was asked for the default model, non-streaming
		const sent = JSON.parse(fakeFetch.mock.calls[0][1].body);
		expect(sent.model).toBe('m-default');
		expect(sent.stream).toBe(false);
		// the session balance dropped
		expect(getAiSessionByToken(db, bundle.token).remainingAtomic).toBe(5_000_000 - 250);
	});

	test('chat/completions → 400 missing messages / disallowed model', async () => {
		const { body: bundle } = await buyBundle(5);
		const noMsg = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: `Bearer ${bundle.token}` }, payload: {} });
		expect(noMsg.statusCode).toBe(400);
		const badModel = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: `Bearer ${bundle.token}` }, payload: { model: 'evil', messages: [{ role: 'user', content: 'hi' }] } });
		expect(badModel.statusCode).toBe(400);
		expect(JSON.parse(badModel.body).error.code).toBe('model_not_allowed');
	});

	test('chat/completions → 402 when credits exhausted', async () => {
		// mint a tiny session directly below the per-call floor
		const { token } = createAiSession(db, { creditAtomic: 100, ttlMs: 3_600_000 });
		const r = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
		expect(r.statusCode).toBe(402);
		expect(JSON.parse(r.body).error.code).toBe('credits_exhausted');
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	test('chat/completions → passes through upstream error without debiting', async () => {
		const { body: bundle } = await buyBundle(5);
		fakeFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limited' } }) });
		const r = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: `Bearer ${bundle.token}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
		expect(r.statusCode).toBe(429);
		expect(getAiSessionByToken(db, bundle.token).remainingAtomic).toBe(5_000_000); // untouched
	});

	test('GET /v1/ai/credits + /v1/ai/models with Bearer', async () => {
		const { body: bundle } = await buyBundle(5);
		const bal = await app.inject({ method: 'GET', url: '/v1/ai/credits', headers: { authorization: `Bearer ${bundle.token}` } });
		expect(bal.statusCode).toBe(200);
		expect(JSON.parse(bal.body).credits).toBe(5);
		const models = await app.inject({ method: 'GET', url: '/v1/ai/models', headers: { authorization: `Bearer ${bundle.token}` } });
		expect(models.statusCode).toBe(200);
		expect(JSON.parse(models.body).default).toBe('m-default');
	});

	test('503 when hosted AI is not configured (no db)', async () => {
		const app2 = Fastify({ logger: false });
		registerAiRoutes(app2, { aiDb: null, aiConfig: aiConfig({ enabled: false }), x402Cfg: X402_CFG, requirePaywall: () => false, fetchImpl: fakeFetch });
		await app2.ready();
		const r = await app2.inject({ method: 'POST', url: '/v1/ai/chat/completions', headers: { authorization: 'Bearer x' }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
		expect(r.statusCode).toBe(503);
		expect(JSON.parse(r.body).error.code).toBe('ai_not_configured');
		await app2.close();
	});
});
