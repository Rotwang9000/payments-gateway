// Tests for the privacy-coin top-up quote/status routes: pure
// validators/formatters plus Fastify-injected happy + edge paths
// against a :memory: DB and a stubbed price oracle.

import { describe, test, expect, beforeEach } from '@jest/globals';
import Fastify from 'fastify';

import {
	validateCryptoTopupRequest,
	withMoneroTag,
	generateMemo,
	formatUsdCents,
	registerCryptoTopupRoutes
} from '../src/private-watch-crypto-topup.js';
import { openWatchDb, createWatch } from 'viewkey-watch/private-watch-store';
import { ensureCryptoTopupSchema } from 'viewkey-watch/crypto-topup-store';
import { WATCH_CONSTANTS } from 'viewkey-watch/private-watch';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const POLICY = Object.freeze({
	minUsdCents: 200,
	maxUsdCents: 50_000,
	spreadBps: 400,
	quoteTtlSec: 900,
	confirmations: { monero: 10, zcash: 8 }
});

const silentLog = { info() {}, warn() {}, error() {} };

function stubOracle(prices = { monero: 200, zcash: 50 }) {
	return { getUsdPrice: async (coin) => ({ usd: prices[coin], source: 'coingecko', asOfMs: 1 }) };
}

describe('validateCryptoTopupRequest', () => {
	test('accepts a well-formed request', () => {
		const out = validateCryptoTopupRequest(
			{ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'monero', amountUsdCents: 500 },
			POLICY
		);
		expect(out).toEqual({ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'monero', amountUsdCents: 500 });
	});

	test('accepts a numeric string amount', () => {
		const out = validateCryptoTopupRequest(
			{ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'zcash', amountUsdCents: '1000' },
			POLICY
		);
		expect(out.amountUsdCents).toBe(1000);
	});

	test('rejects bad chain / amount / id', () => {
		expect(() => validateCryptoTopupRequest({ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'doge', amountUsdCents: 500 }, POLICY)).toThrow(/chain/);
		expect(() => validateCryptoTopupRequest({ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'monero', amountUsdCents: 100 }, POLICY)).toThrow(/out of range/);
		expect(() => validateCryptoTopupRequest({ watchId: VALID_UUID, watchToken: 'tok-abcdef12', chain: 'monero', amountUsdCents: 60_000 }, POLICY)).toThrow(/out of range/);
		expect(() => validateCryptoTopupRequest({ watchId: 'nope', watchToken: 'tok-abcdef12', chain: 'monero', amountUsdCents: 500 }, POLICY)).toThrow(/watchId/);
		expect(() => validateCryptoTopupRequest({ watchId: VALID_UUID, watchToken: 'short', chain: 'monero', amountUsdCents: 500 }, POLICY)).toThrow(/watchToken/);
	});
});

describe('pure helpers', () => {
	test('withMoneroTag yields a larger, tagged amount', () => {
		const base = 26_000_000_000n;
		const tagged = withMoneroTag(base);
		expect(tagged).toBeGreaterThan(base);
		const tag = tagged % 1_000_000n;
		expect(tag).toBeGreaterThanOrEqual(1n);
		expect(tag).toBeLessThan(1_000_000n);
	});

	test('generateMemo is a short brand-neutral token by default', () => {
		expect(generateMemo()).toMatch(/^PG-[0-9a-f]{8}$/);
	});

	test('generateMemo honours a custom prefix', () => {
		expect(generateMemo('SNS')).toMatch(/^SNS-[0-9a-f]{8}$/);
	});

	test('formatUsdCents', () => {
		expect(formatUsdCents(500)).toBe('$5.00');
		expect(formatUsdCents(1234)).toBe('$12.34');
	});
});

describe('routes (Fastify injected)', () => {
	let db;
	let watch;

	function buildApp(over = {}) {
		const app = Fastify();
		registerCryptoTopupRoutes(app, {
			watchDb: db,
			priceOracle: over.priceOracle ?? stubOracle(),
			recvAddresses: over.recvAddresses ?? { monero: '4'.repeat(95), zcash: 'u1zcashreceiver' },
			policy: POLICY,
			memoPrefix: over.memoPrefix,
			privateWatchReady: over.privateWatchReady ?? (() => true),
			privateNotConfigured: (reply) => reply.code(503).send({ error: { code: 'private_watch_not_configured' } }),
			now: () => 1_000,
			log: silentLog
		});
		return app;
	}

	beforeEach(() => {
		db = openWatchDb(':memory:');
		ensureCryptoTopupSchema(db);
		watch = createWatch(db, {
			chain: 'monero',
			address: '4'.repeat(95),
			viewKeyCiphertext: 'ct',
			webhookUrl: 'https://example.com/hook',
			webhookSecret: 'a'.repeat(64),
			creditAtomic: 100_000,
			dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC,
			nowMs: 1_000
		});
	});

	test('POST creates a Monero quote (no memo, tagged amount)', async () => {
		const app = buildApp();
		const res = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'monero', amountUsdCents: 500 } });
		expect(res.statusCode).toBe(201);
		const b = res.json();
		expect(b).toMatchObject({ chain: 'monero', status: 'pending', payTo: '4'.repeat(95), memo: null });
		expect(b.amount.coin).toBe('XMR');
		expect(b.credit).toMatchObject({ usd: '$5.00', usdCents: 500 });
		expect(b.confirmations.required).toBe(10);
		await app.close();
	});

	test('POST creates a Zcash quote with a brand-neutral memo token', async () => {
		const app = buildApp();
		const res = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'zcash', amountUsdCents: 1000 } });
		expect(res.statusCode).toBe(201);
		const b = res.json();
		expect(b.chain).toBe('zcash');
		expect(b.memo).toMatch(/^PG-[0-9a-f]{8}$/);
		expect(b.amount.coin).toBe('ZEC');
		await app.close();
	});

	test('POST honours a custom memoPrefix', async () => {
		const app = buildApp({ memoPrefix: 'SNS' });
		const res = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'zcash', amountUsdCents: 1000 } });
		expect(res.json().memo).toMatch(/^SNS-[0-9a-f]{8}$/);
		await app.close();
	});

	test('POST 503 when the chain is not configured', async () => {
		const app = buildApp({ recvAddresses: { monero: '', zcash: '' } });
		const res = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'monero', amountUsdCents: 500 } });
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe('crypto_topup_not_configured');
		await app.close();
	});

	test('POST 400 on a sub-minimum amount', async () => {
		const app = buildApp();
		const res = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'monero', amountUsdCents: 50 } });
		expect(res.statusCode).toBe(400);
		await app.close();
	});

	test('POST 403 wrong token, 404 unknown watch', async () => {
		const app = buildApp();
		const bad = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: 'definitely-the-wrong-token', chain: 'monero', amountUsdCents: 500 } });
		expect(bad.statusCode).toBe(403);
		const missing = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: VALID_UUID, watchToken: 'token-abcdef12', chain: 'monero', amountUsdCents: 500 } });
		expect(missing.statusCode).toBe(404);
		await app.close();
	});

	test('GET returns status with the right token, 403/404 otherwise', async () => {
		const app = buildApp();
		const created = await app.inject({ method: 'POST', url: '/v1/private/topup-crypto', payload: { watchId: watch.id, watchToken: watch.token, chain: 'monero', amountUsdCents: 500 } });
		const quoteId = created.json().quoteId;
		const ok = await app.inject({ method: 'GET', url: `/v1/private/topup-crypto/${quoteId}`, headers: { 'x-watch-token': watch.token } });
		expect(ok.statusCode).toBe(200);
		const forbidden = await app.inject({ method: 'GET', url: `/v1/private/topup-crypto/${quoteId}`, headers: { 'x-watch-token': 'nope' } });
		expect(forbidden.statusCode).toBe(403);
		const notFound = await app.inject({ method: 'GET', url: '/v1/private/topup-crypto/unknown-id', headers: { 'x-watch-token': watch.token } });
		expect(notFound.statusCode).toBe(404);
		await app.close();
	});
});
