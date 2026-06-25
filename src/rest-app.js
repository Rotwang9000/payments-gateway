// Standalone gateway REST app (the winbit32 product).
//
// Wraps the embeddable plugin (registerGatewayRoutes) with the cross-cutting
// routes a standalone service needs: CORS, rate limiting, error handling, an
// index, health, the free paywall metadata (/v1/paywall + /.well-known/x402),
// and the privacy-chain `/v1/q` catalogue. Finishes by installing the x402
// paywall exactly once, after all routes are registered.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';

import gatewayConfig from './config.js';
import { buildX402Config, registerX402, describePaywall } from './x402.js';
import { CHAIN_QUESTION_REGISTRY } from './queries-q-chain.js';
import { registerGatewayRoutes } from './rest-plugin.js';
import { registerZcashAmountRoutes } from './zcash-amount-routes.js';

export async function buildGatewayApp(options = {}) {
	const config = options.config ?? gatewayConfig;
	const app = Fastify({
		logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
		trustProxy: options.trustProxy ?? true
	});

	const x402Cfg = options.x402Cfg ?? buildX402Config({ cfg: config });
	const paywallSummary = describePaywall(x402Cfg);

	await app.register(cors, {
		origin: true,
		methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['content-type', 'authorization', 'x-payment', 'x-watch-token'],
		exposedHeaders: ['payment-required', 'x-payment-response', 'x-ai-cost-usd', 'x-ai-credits-remaining-usd', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
		maxAge: 86400
	});

	if (options.rateLimit !== false) {
		await app.register(rateLimit, {
			max: options.rateLimitMax ?? config.rateLimitPerMin,
			timeWindow: options.rateLimitWindow ?? config.rateLimitTimeWindowMs,
			cache: 10000,
			allowList: options.rateLimitAllowList ?? []
		});
	}

	// Live chat is opt-in. Register the WebSocket plugin BEFORE the gateway
	// routes, because the chat WS route is defined inside registerGatewayRoutes
	// (@fastify/websocket must be present when the route is declared).
	if (config.chatEnabled && options.websocket !== false) {
		await app.register(fastifyWebsocket, {
			options: { maxPayload: (config.chatMaxMessageLen ?? 400) + 2048 }
		});
	}

	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) {
			req.log.warn({ err: err.message, url: req.url }, 'bad request');
			return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
		}
		if (err.statusCode === 429) {
			req.log.warn({ err: err.message, url: req.url }, 'rate limited');
			return reply.code(429).header('retry-after', '60').send({ error: { code: 'rate_limited', message: err.message ?? 'rate limit exceeded' } });
		}
		if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
			req.log.warn({ err: err.message, url: req.url, statusCode: err.statusCode }, 'client error');
			return reply.code(err.statusCode).send({ error: { code: err.code ?? 'client_error', message: err.message ?? 'client error' } });
		}
		req.log.error({ err: err.stack ?? err.message, url: req.url }, 'unhandled');
		return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
	});

	// Mount the gateway's paid surface and capture the handle for the
	// cross-cutting routes below.
	const gateway = registerGatewayRoutes(app, { ...options, config, x402Cfg });

	// Zcash amount-privacy advisor (free): suggestions + round-trip risk and the
	// live popular-amount feed. Always on — degrades to the bundled list when the
	// on-chain index is disabled/empty.
	registerZcashAmountRoutes(app, { config, ...(options.zecIndexDb !== undefined ? { indexDb: options.zecIndexDb } : {}) });

	app.get('/', async () => ({
		service: config.serviceName,
		version: config.apiVersion,
		endpoints: [
			'GET /v1/health',
			'GET /v1/paywall',
			'GET /.well-known/x402',
			'GET /v1/q (privacy-chain penny-oracle catalogue, free)',
			'GET /v1/q/xmr/* (Monero atomic facts, x402 paywall)',
			'GET /v1/q/zec/* (Zcash atomic facts, x402 paywall)',
			'GET /v1/zec/amount-advice (free — shield/deshield amount-privacy advisor)',
			'GET /v1/zec/split-plan (free — split a large shield/deshield into blend-in pieces)',
			'GET /v1/zec/popular-amounts (free — on-chain popular shield/deshield amounts)',
			'POST /v1/private/watch (x402 paywall — view-key payment monitor)',
			'POST /v1/private/topup|topup-1|topup-5|topup-custom (x402 paywall — credit top-ups)',
			'POST /v1/private/topup-crypto (free — pay in XMR/ZEC)',
			'POST /v1/private/historical (x402 paywall — one-off note scan)',
			'POST /v1/private/derive-viewkey (free, rate-limited)',
			'GET|DELETE /v1/private/watch/:id (owner-only)',
			'POST /v1/private/watch/:id/test (owner-only synthetic webhook)',
			'GET /v1/private/info (free service metadata)',
			'GET /v1/private/health (free counters, no PII)',
			'POST /v1/unlock/listing (free — seal a pay-to-unlock secret; opt-in)',
			'GET /v1/unlock/listings (free — public shop feed, opt-in listings only)',
			'GET /v1/unlock/listing/:id (free — public listing, no secret)',
			'POST /v1/unlock/listing/:id/order (free — ZEC/XMR pay quote)',
			'POST /v1/unlock/listing/:id/buy (x402 — instant USDC unlock)',
			'GET /v1/unlock/order/:orderId (claim-token — order status)',
			'POST /v1/unlock/order/:orderId/claim (claim-token — reveal secret)',
			'GET /v1/ai (free hosted-AI metadata)',
			'POST /v1/ai/credits (x402 paywall — buy a prepaid AI credit bundle)',
			'POST /v1/ai/chat/completions (OpenAI-compatible proxy — Bearer session token)',
			'GET /v1/ai/credits|models (Bearer session token)',
			'GET /v1/chat (free — live chat metadata + ws url)',
			'GET /v1/chat/:channel/history (free — recent messages)',
			'WS /v1/chat/ws (real-time AIRC-style channels; opt-in)'
		],
		paywall: paywallSummary
	}));

	app.get('/v1/health', async () => ({
		service: config.serviceName,
		version: config.apiVersion,
		status: 'ok',
		private_watch_enabled: gateway.privateWatchReady(),
		chains: gateway.chainRpcConfigured,
		crypto_topup_chains: gateway.cryptoAcceptedChains(),
		paywall_enabled: x402Cfg.enabled,
		hosted_ai_enabled: gateway.aiReady ? gateway.aiReady() : false,
		chat_enabled: gateway.chatReady ? gateway.chatReady() : false
	}));

	app.get('/v1/paywall', async () => paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' });

	app.get('/.well-known/x402', async (req, reply) => {
		if (!paywallSummary) {
			reply.code(404);
			return { error: { code: 'paywall_not_configured', message: 'No x402 paywall configured on this host.' } };
		}
		return {
			...paywallSummary,
			service: {
				name: config.serviceName,
				description: 'Monero & Zcash payment webhooks (HMAC-signed, view-key only, no node) plus live privacy-chain facts — payable per call over x402 on Base. Free read tier, no API key, no account.',
				...(options.serviceLinks ?? {})
			}
		};
	});

	app.get('/v1/q', async () => {
		const price = x402Cfg.enabled
			? (x402Cfg.routes['GET /v1/q/xmr/height']?.accepts?.price ?? config.x402QPrice)
			: null;
		const chain = Object.entries(CHAIN_QUESTION_REGISTRY).map(([name, meta]) => ({
			name,
			path: `/v1/q/${name}`,
			inputs: meta.inputs,
			category: meta.chain,
			available: gateway.chainRpcConfigured[meta.chain] === true
		}));
		return {
			price_per_call: price,
			network: x402Cfg.enabled ? x402Cfg.network : null,
			questions: chain,
			chain_status: gateway.chainRpcConfigured
		};
	});

	app.setNotFoundHandler((req, reply) => {
		reply.code(404).send({ error: { code: 'not_found', message: `route ${req.method} ${req.url} not found` } });
	});

	if (x402Cfg.enabled && options.installX402 !== false) {
		try {
			await registerX402(app, x402Cfg, { cfg: config });
		}
		catch (err) {
			app.log.error({ err: err?.stack ?? err?.message ?? String(err) }, 'x402 paywall registration failed; premium endpoints will answer 503');
		}
	}

	return app;
}

export async function startGatewayRest(options = {}) {
	const config = options.config ?? gatewayConfig;
	const app = await buildGatewayApp(options);
	await app.listen({ port: config.restPort, host: config.restHost });
	return app;
}

export default buildGatewayApp;
