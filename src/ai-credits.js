// Hosted AI — prepaid credit bundles (x402) + an OpenAI-compatible proxy.
//
// Two routes make the "we provide AI at a cost" path work without us ever
// custodying the buyer's money or their provider key:
//
//   POST /v1/ai/credits            (x402, dynamic amount)
//     One USDC payment buys a credit bundle. On settlement we mint an opaque
//     session token and hand back { token, baseUrl, credits } — exactly the
//     shape WINBIT32's services/messenger/hostedCredits.js expects.
//
//   POST /v1/ai/chat/completions   (Bearer <token>)
//     OpenAI-compatible. Authenticated by the session token, it forwards the
//     request to the operator's configured upstream (one shared upstream key,
//     never exposed to the browser), measures the token usage on the way back,
//     and debits the matching cost from the session's credit meter.
//
// Design rules (same as private-watch-custom.js):
//   * Pure helpers (validators, cost maths, model resolution) are exported so
//     the unit tests need neither Fastify nor a live model.
//   * The credits route reuses the generic x402 helpers from
//     private-watch-custom.js (challenge encode/decode, requirement builder) so
//     the wire protocol stays identical to the other paid routes.
//   * The proxy forces `stream:false` upstream: the WINBIT32 client reads a
//     single JSON body and we need the `usage` block to bill accurately.

import {
	buildCustomPaymentRequirements,
	encodeChallenge,
	decodePaymentHeader
} from './private-watch-custom.js';
import { createFacilitatorClient } from './x402.js';
import {
	createAiSession,
	getAiSessionByToken,
	debitAiSession
} from './ai-session-store.js';

/** USDC has 6 decimals. Money is atomic everywhere; convert only at the edges. */
const USDC_DECIMALS = 6;
const ATOMIC_PER_USD = 10 ** USDC_DECIMALS;

export function usdToAtomic(usd) {
	return Math.round(Number(usd) * ATOMIC_PER_USD);
}
export function atomicToUsd(atomic) {
	return Math.round(Number(atomic)) / ATOMIC_PER_USD;
}
export function atomicToUsdString(atomic) {
	return `$${atomicToUsd(atomic).toFixed(USDC_DECIMALS)}`.replace(/0+$/, '').replace(/\.$/, '.0');
}

/** 1 US cent = 10_000 atomic USDC (6 decimals). */
const ATOMIC_PER_CENT = ATOMIC_PER_USD / 100;

/**
 * Shape the raw env-driven gateway config into the runtime object the AI routes
 * consume. Kept here (not in config.js) so config.js stays a pure env reader and
 * all AI-specific derivation lives beside the code that uses it.
 */
export function resolveAiConfig(cfg) {
	const enabled = Boolean(cfg.aiEnabled) || Boolean((cfg.aiUpstreamApiKey || '').trim());
	const allowlist = String(cfg.aiModelAllowlist || '')
		.split(',').map((s) => s.trim()).filter(Boolean);

	const upstreamHeaders = {};
	if (cfg.aiUpstreamReferer) {
		upstreamHeaders['HTTP-Referer'] = cfg.aiUpstreamReferer;
		upstreamHeaders['Referer'] = cfg.aiUpstreamReferer;
	}
	if (cfg.aiUpstreamTitle) upstreamHeaders['X-Title'] = cfg.aiUpstreamTitle;

	let dbPath = (cfg.aiDbPath || '').trim();
	if (!dbPath) {
		const base = cfg.privateWatchDbPath || '/var/lib/payments-gateway/private-watches.db';
		dbPath = base.replace(/[^/\\]*$/, 'ai-sessions.db');
	}

	return Object.freeze({
		enabled,
		upstreamBaseUrl: (cfg.aiUpstreamBaseUrl || '').trim(),
		upstreamApiKey: (cfg.aiUpstreamApiKey || '').trim(),
		upstreamHeaders: Object.keys(upstreamHeaders).length ? Object.freeze(upstreamHeaders) : null,
		defaultModel: (cfg.aiDefaultModel || '').trim(),
		allowlist,
		publicBaseUrl: (cfg.aiPublicBaseUrl || '').trim(),
		dbPath,
		sessionTtlMs: Math.max(1, cfg.aiSessionTtlSec ?? 0) * 1000,
		requestTimeoutMs: cfg.aiRequestTimeoutMs ?? 120_000,
		maxTokensCap: cfg.aiMaxTokensCap ?? 4096,
		bundleDefaultAtomic: (cfg.aiCreditDefaultUsdCents ?? 500) * ATOMIC_PER_CENT,
		bundleMinAtomic: (cfg.aiCreditMinUsdCents ?? 50) * ATOMIC_PER_CENT,
		bundleMaxAtomic: (cfg.aiCreditMaxUsdCents ?? 2000) * ATOMIC_PER_CENT,
		pricing: Object.freeze({
			per1kInputAtomic: cfg.aiPricePer1kInputAtomic ?? 1000,
			per1kOutputAtomic: cfg.aiPricePer1kOutputAtomic ?? 3000,
			minCallAtomic: cfg.aiMinCallAtomic ?? 200
		})
	});
}

/**
 * Validate the credits-purchase body. Accepts `{ bundleUsd }` (preferred) or a
 * bare `{ model }` hint (uses the default bundle). Clamps to the configured
 * range rather than rejecting, so a generous client cap can't 400 the buy.
 */
export function validateCreditsBody(body, { defaultAtomic, minAtomic, maxAtomic }) {
	const b = body && typeof body === 'object' ? body : {};
	let amountAtomic;
	if (b.bundleUsd !== undefined && b.bundleUsd !== null) {
		const usd = Number(b.bundleUsd);
		if (!Number.isFinite(usd) || usd <= 0) {
			throw new TypeError('bundleUsd must be a positive number of US dollars');
		}
		amountAtomic = usdToAtomic(usd);
	}
	else if (b.amountAtomic !== undefined) {
		const n = Number(b.amountAtomic);
		if (!Number.isInteger(n) || n <= 0) {
			throw new TypeError('amountAtomic must be a positive integer (atomic USDC)');
		}
		amountAtomic = n;
	}
	else {
		amountAtomic = defaultAtomic;
	}
	amountAtomic = Math.min(maxAtomic, Math.max(minAtomic, amountAtomic));
	const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null;
	return Object.freeze({ amountAtomic, model });
}

/** Rough token estimate from message text — only used if upstream omits usage. */
export function estimateTokensFromMessages(messages) {
	if (!Array.isArray(messages)) return 0;
	let chars = 0;
	for (const m of messages) {
		if (typeof m?.content === 'string') chars += m.content.length;
		else if (Array.isArray(m?.content)) {
			for (const part of m.content) {
				if (typeof part?.text === 'string') chars += part.text.length;
			}
		}
	}
	return Math.ceil(chars / 4);
}

/**
 * Cost of one completion in atomic USDC. Uses the measured `usage` when present
 * (input + output token rates), else falls back to an estimate billed at the
 * output rate (conservative). Never charges below the per-call floor.
 */
export function computeCostAtomic({ usage, pricing, fallbackTokens = 0 }) {
	const inTok = Number(usage?.prompt_tokens);
	const outTok = Number(usage?.completion_tokens);
	let cost;
	if (Number.isFinite(inTok) && Number.isFinite(outTok)) {
		cost = (inTok / 1000) * pricing.per1kInputAtomic + (outTok / 1000) * pricing.per1kOutputAtomic;
	}
	else {
		cost = (Number(fallbackTokens) / 1000) * pricing.per1kOutputAtomic;
	}
	return Math.max(pricing.minCallAtomic, Math.ceil(cost));
}

/**
 * Map the requested model to the served one. Treats '', 'auto' and missing as
 * "operator's default". Enforces the allowlist when one is configured.
 */
export function resolveModel(requested, { sessionModel, defaultModel, allowlist }) {
	let model = (typeof requested === 'string' && requested.trim()) ? requested.trim() : '';
	if (!model || model === 'auto') model = sessionModel || defaultModel;
	if (!model) throw new TypeError('no model requested and no default model configured');
	if (Array.isArray(allowlist) && allowlist.length > 0 && !allowlist.includes(model)) {
		const err = new TypeError(`model '${model}' is not on this gateway's allowlist`);
		err.code = 'model_not_allowed';
		throw err;
	}
	return model;
}

/** Pull a Bearer token out of an Authorization header. Returns null if absent. */
export function bearerToken(headerValue) {
	if (typeof headerValue !== 'string') return null;
	const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
	return m ? m[1].trim() : null;
}

/**
 * Build the upstream chat-completions request body from the client's body:
 * pass through the OpenAI-shaped fields we support, pin the resolved model,
 * cap max_tokens, and force non-streaming so `usage` comes back.
 */
export function buildUpstreamBody(clientBody, { model, maxTokensCap }) {
	const src = clientBody && typeof clientBody === 'object' ? clientBody : {};
	const out = { model, stream: false };
	if (Array.isArray(src.messages)) out.messages = src.messages;
	const cap = Number.isInteger(maxTokensCap) && maxTokensCap > 0 ? maxTokensCap : 4096;
	const wanted = Number(src.max_tokens);
	out.max_tokens = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, cap) : Math.min(1024, cap);
	for (const k of ['temperature', 'top_p', 'tools', 'tool_choice', 'response_format', 'stop', 'presence_penalty', 'frequency_penalty', 'seed']) {
		if (src[k] !== undefined) out[k] = src[k];
	}
	return out;
}

async function defaultFacilitatorFactory(x402Cfg) {
	return createFacilitatorClient(x402Cfg);
}

/**
 * Mount the hosted-AI routes. `deps`:
 *   - aiDb         : open ai-session DB (from openAiDb) or null when AI is off
 *   - aiConfig     : resolved AI settings (see buildAiConfig in config consumer)
 *   - x402Cfg      : the gateway x402 config (for the credits paywall)
 *   - requirePaywall / aiNotConfigured : gate helpers (kept as params, no imports)
 *   - facilitatorFactory : optional override for tests
 *   - fetchImpl    : optional fetch override for tests
 *   - log          : optional logger
 */
export function registerAiRoutes(app, deps) {
	const {
		aiDb,
		aiConfig,
		x402Cfg,
		requirePaywall,
		facilitatorFactory = defaultFacilitatorFactory,
		fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null),
		log = { info: () => {}, warn: () => {}, error: () => {} }
	} = deps;

	if (!requirePaywall) throw new Error('registerAiRoutes: missing requirePaywall helper');

	const aiReady = () => Boolean(aiDb && aiConfig?.enabled && aiConfig?.upstreamApiKey);

	function aiNotConfigured(reply, extra = {}) {
		return reply.code(503).send({
			error: {
				code: 'ai_not_configured',
				message: 'Hosted AI is not enabled on this gateway (operator must set AI_UPSTREAM_API_KEY).',
				...extra
			}
		});
	}

	let facilitatorP = null;
	function getFacilitator() {
		if (!x402Cfg?.enabled) throw new Error('x402 paywall disabled; cannot dispatch to facilitator');
		if (!facilitatorP) facilitatorP = Promise.resolve(facilitatorFactory(x402Cfg));
		return facilitatorP;
	}

	function resolveBaseUrl(req) {
		if (aiConfig?.publicBaseUrl) return aiConfig.publicBaseUrl.replace(/\/$/, '');
		return `${req.protocol}://${req.hostname}/v1/ai`;
	}

	// ── Free metadata ──────────────────────────────────────────────
	app.get('/v1/ai', async (req) => ({
		enabled: aiReady(),
		paywall_enabled: Boolean(x402Cfg?.enabled),
		base_url: resolveBaseUrl(req),
		credits_url: `${resolveBaseUrl(req)}/credits`,
		default_model: aiConfig?.defaultModel ?? null,
		models: aiConfig?.allowlist ?? [],
		bundle: {
			default_usd: atomicToUsd(aiConfig?.bundleDefaultAtomic ?? 0),
			min_usd: atomicToUsd(aiConfig?.bundleMinAtomic ?? 0),
			max_usd: atomicToUsd(aiConfig?.bundleMaxAtomic ?? 0)
		},
		price: {
			per_1k_input_usd: atomicToUsd(aiConfig?.pricing?.per1kInputAtomic ?? 0),
			per_1k_output_usd: atomicToUsd(aiConfig?.pricing?.per1kOutputAtomic ?? 0),
			min_call_usd: atomicToUsd(aiConfig?.pricing?.minCallAtomic ?? 0)
		},
		session_ttl_sec: Math.round((aiConfig?.sessionTtlMs ?? 0) / 1000)
	}));

	// ── Buy a credit bundle (x402) ─────────────────────────────────
	app.post('/v1/ai/credits', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!aiReady()) return aiNotConfigured(reply);

		let parsed;
		try {
			parsed = validateCreditsBody(req.body || {}, {
				defaultAtomic: aiConfig.bundleDefaultAtomic,
				minAtomic: aiConfig.bundleMinAtomic,
				maxAtomic: aiConfig.bundleMaxAtomic
			});
		}
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		const requirements = buildCustomPaymentRequirements({ x402Cfg, amountAtomic: parsed.amountAtomic });
		const description = `Buy ${atomicToUsdString(parsed.amountAtomic)} of hosted-AI credit. Returns { token, baseUrl, credits }; spend the token at POST /v1/ai/chat/completions (OpenAI-compatible, Authorization: Bearer <token>).`;
		const resourceUrl = `${resolveBaseUrl(req)}/credits`;
		const challenge = encodeChallenge({ resourceUrl, description, accepts: requirements });

		const xPayment = req.headers['x-payment'];
		if (!xPayment) {
			return reply.code(402).header('payment-required', challenge).send({});
		}

		const payload = decodePaymentHeader(xPayment);
		if (!payload) {
			return reply.code(400).send({ error: { code: 'invalid_payment_header', message: 'x-payment is not valid base64 JSON' } });
		}
		const sentValue = String(payload?.payload?.authorization?.value ?? '');
		if (sentValue !== String(parsed.amountAtomic)) {
			return reply.code(400).send({ error: { code: 'amount_mismatch', message: `x-payment authorization.value (${sentValue}) does not match required amount (${parsed.amountAtomic})` } });
		}

		let facilitator;
		try { facilitator = await getFacilitator(); }
		catch (err) {
			log.error({ err: err?.message ?? String(err) }, 'ai/credits: facilitator init failed');
			return reply.code(503).send({ error: { code: 'facilitator_unavailable', message: 'payment facilitator could not be initialised' } });
		}

		let verifyResult;
		try { verifyResult = await facilitator.verify(payload, requirements); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ai/credits: verify threw');
			return reply.code(502).send({ error: { code: 'verify_failed', message: err?.message ?? 'facilitator verify threw' } });
		}
		if (!verifyResult?.isValid) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_verification_failed', message: verifyResult?.invalidReason ?? 'facilitator rejected signature' } });
		}

		let settleResult;
		try { settleResult = await facilitator.settle(payload, requirements); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ai/credits: settle threw');
			return reply.code(502).send({ error: { code: 'settle_failed', message: err?.message ?? 'facilitator settle threw' } });
		}
		if (!settleResult?.success) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_settle_failed', message: settleResult?.errorReason ?? 'facilitator settle did not succeed' } });
		}
		reply.header('x-payment-response', Buffer.from(JSON.stringify(settleResult)).toString('base64'));

		let token, session;
		try {
			({ token, session } = createAiSession(aiDb, {
				creditAtomic: parsed.amountAtomic,
				model: parsed.model,
				ttlMs: aiConfig.sessionTtlMs
			}));
		}
		catch (err) {
			log.error({ err: err?.message ?? String(err), amountAtomic: parsed.amountAtomic, settlement: settleResult }, 'ai/credits: payment captured but session mint failed');
			return reply.code(500).send({
				error: {
					code: 'session_mint_failed_after_payment',
					message: 'payment captured but credit session could not be created — contact the operator with the settlement payload',
					captured: { amountAtomic: String(parsed.amountAtomic), settlement: settleResult }
				}
			});
		}

		log.info({ sessionId: session.id, creditAtomic: parsed.amountAtomic }, 'ai/credits: bundle issued');
		return {
			token,
			baseUrl: resolveBaseUrl(req),
			credits: atomicToUsd(session.creditAtomic),
			creditsUsd: atomicToUsd(session.creditAtomic),
			creditAtomic: String(session.creditAtomic),
			model: session.model ?? aiConfig.defaultModel,
			expiresAt: new Date(session.expiresMs).toISOString()
		};
	});

	// ── OpenAI-compatible proxy (spends credit) ────────────────────
	app.post('/v1/ai/chat/completions', async (req, reply) => {
		if (!aiReady()) return aiNotConfigured(reply);

		const token = bearerToken(req.headers['authorization']);
		if (!token) {
			return reply.code(401).send({ error: { code: 'missing_token', message: 'Authorization: Bearer <session token> required (buy one at POST /v1/ai/credits).' } });
		}
		const session = getAiSessionByToken(aiDb, token);
		if (!session) {
			return reply.code(401).send({ error: { code: 'invalid_token', message: 'session token is unknown or expired — buy a new credit bundle.' } });
		}
		if (session.remainingAtomic < aiConfig.pricing.minCallAtomic) {
			return reply.code(402).send({
				error: { code: 'credits_exhausted', message: 'AI credits exhausted — buy another bundle at /v1/ai/credits.' },
				remaining_usd: atomicToUsd(session.remainingAtomic)
			});
		}

		const body = req.body && typeof req.body === 'object' ? req.body : {};
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: 'messages[] is required' } });
		}
		let model;
		try {
			model = resolveModel(body.model, {
				sessionModel: session.model,
				defaultModel: aiConfig.defaultModel,
				allowlist: aiConfig.allowlist
			});
		}
		catch (err) {
			return reply.code(400).send({ error: { code: err?.code ?? 'invalid_model', message: err?.message ?? String(err) } });
		}

		const upstreamBody = buildUpstreamBody(body, { model, maxTokensCap: aiConfig.maxTokensCap });
		const upstreamUrl = `${aiConfig.upstreamBaseUrl.replace(/\/$/, '')}/chat/completions`;
		const headers = { 'content-type': 'application/json', authorization: `Bearer ${aiConfig.upstreamApiKey}` };
		if (aiConfig.upstreamHeaders) Object.assign(headers, aiConfig.upstreamHeaders);

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), aiConfig.requestTimeoutMs);
		let res, text;
		try {
			res = await fetchImpl(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: ac.signal });
			text = await res.text();
		}
		catch (err) {
			clearTimeout(timer);
			log.warn({ err: err?.message ?? String(err) }, 'ai/chat: upstream fetch failed');
			return reply.code(502).send({ error: { code: 'upstream_unavailable', message: 'AI upstream did not respond' } });
		}
		clearTimeout(timer);

		let data = null;
		try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON upstream error */ }

		if (!res.ok) {
			// Surface the upstream status; do NOT debit a failed call.
			log.warn({ status: res.status, sessionId: session.id }, 'ai/chat: upstream error');
			return reply.code(res.status >= 400 && res.status < 600 ? res.status : 502).send(
				data ?? { error: { code: 'upstream_error', message: text || `upstream HTTP ${res.status}` } }
			);
		}

		const cost = computeCostAtomic({
			usage: data?.usage,
			pricing: aiConfig.pricing,
			fallbackTokens: estimateTokensFromMessages(body.messages) + (upstreamBody.max_tokens || 0)
		});
		let updated;
		try { updated = debitAiSession(aiDb, session.id, cost); }
		catch (err) {
			log.error({ err: err?.message ?? String(err), sessionId: session.id }, 'ai/chat: debit failed');
			updated = null;
		}
		const remaining = updated ? updated.remainingAtomic : Math.max(0, session.remainingAtomic - cost);
		reply.header('x-ai-cost-usd', String(atomicToUsd(cost)));
		reply.header('x-ai-credits-remaining-usd', String(atomicToUsd(remaining)));
		log.info({ sessionId: session.id, model, costUsd: atomicToUsd(cost), remainingUsd: atomicToUsd(remaining) }, 'ai/chat: completion billed');
		return data;
	});

	// ── Balance + model list (Bearer) ──────────────────────────────
	app.get('/v1/ai/credits', async (req, reply) => {
		if (!aiReady()) return aiNotConfigured(reply);
		const token = bearerToken(req.headers['authorization']);
		const session = token ? getAiSessionByToken(aiDb, token) : null;
		if (!session) return reply.code(401).send({ error: { code: 'invalid_token', message: 'unknown or expired session token' } });
		return {
			credits: atomicToUsd(session.remainingAtomic),
			creditsUsd: atomicToUsd(session.remainingAtomic),
			remainingAtomic: String(session.remainingAtomic),
			creditAtomic: String(session.creditAtomic),
			spentAtomic: String(session.spentAtomic),
			calls: session.calls,
			expiresAt: new Date(session.expiresMs).toISOString()
		};
	});

	app.get('/v1/ai/models', async (req, reply) => {
		if (!aiReady()) return aiNotConfigured(reply);
		const list = (Array.isArray(aiConfig.allowlist) && aiConfig.allowlist.length)
			? aiConfig.allowlist
			: (aiConfig.defaultModel ? [aiConfig.defaultModel] : []);
		return { object: 'list', default: aiConfig.defaultModel ?? null, data: list.map((id) => ({ id, object: 'model' })) };
	});

	return { aiReady };
}

export default registerAiRoutes;
