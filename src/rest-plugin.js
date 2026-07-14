// Embeddable gateway routes — the reusable Fastify plugin.
//
// `registerGatewayRoutes(app, opts)` mounts the gateway's PAID surface onto
// any Fastify app:
//   - Privacy-chain atomic facts: GET /v1/q/xmr/* and /v1/q/zec/*
//   - Private Watch (view-key payment monitoring): the full /v1/private/* set
//
// It deliberately does NOT register the cross-cutting discovery routes
// (`/`, /v1/health, /v1/paywall, /.well-known/x402, the combined /v1/q
// catalogue) or call registerX402 — a host owns those because they merge the
// gateway's surface with the host's own (and x402 must be installed exactly
// once, after all routes). The standalone product wires them up in
// `buildGatewayApp` (rest-app.js).
//
// Everything is dependency-injectable via `opts` so the suite can drive it
// against a :memory: DB + stub NFPT/oracle/fetch in a few lines.

import gatewayConfig from './config.js';
import { buildX402Config } from './x402.js';
import {
	CHAIN_QUESTION_REGISTRY,
	createChainCache,
	dispatchChainQuestion
} from './queries-q-chain.js';
import { registerCustomTopupRoute, CUSTOM_TOPUP_LIMITS } from './private-watch-custom.js';
import { registerCryptoTopupRoutes } from './private-watch-crypto-topup.js';
import { openBoardDb } from './notice-board-store.js';
import { registerNoticeBoardRoutes } from './notice-board-routes.js';
import { openUnlockDb } from './paid-unlock-store.js';
import { registerPaidUnlockRoutes } from './paid-unlock-routes.js';
import { registerDonationOverlayRoutes } from './donation-overlay-routes.js';
import { registerZivingRoutes } from './ziving-routes.js';
import { registerAiRoutes, resolveAiConfig } from './ai-credits.js';
import { openAiDb } from './ai-session-store.js';
import { registerChatRoutes, resolveChatConfig } from './chat-routes.js';
import { createX402RelayService } from './x402-relay.js';
import { registerX402RelayRoutes } from './x402-relay-routes.js';

import {
	openWatchDb,
	createWatch as storeCreateWatch,
	getWatch as storeGetWatch,
	cancelWatch as storeCancelWatch,
	topupWatch as storeTopupWatch,
	statsSnapshot as storeStatsSnapshot
} from 'viewkey-watch/private-watch-store';
import {
	parseMasterKey,
	encryptViewKey,
	decryptViewKey,
	generateWebhookSecret
} from 'viewkey-watch/private-watch-crypto';
import {
	createNfptClient,
	healthCheck as nfptHealthCheck,
	scanHistorical,
	deriveUfvk
} from 'viewkey-watch/private-watch-nfpt';
import {
	resolveAndValidateWatchRequest,
	validateTopupRequest,
	validateHistoricalRequest,
	validateDeriveRequest,
	buildWatchSummary,
	buildPrivateInfo,
	buildCreditBlock,
	buildSyntheticTestBody,
	effectiveRatesForRow,
	WATCH_CONSTANTS
} from 'viewkey-watch/private-watch';
import { deliverWebhook } from 'viewkey-watch/private-watch-poller';
import { ensureCryptoTopupSchema, quoteStatsSnapshot } from 'viewkey-watch/crypto-topup-store';
import { createPriceOracle } from 'viewkey-watch/crypto-price';
import {
	buildPricingConfig,
	computeWatchRate,
	describeCurrentPricing
} from 'viewkey-watch/private-watch-pricing';

// Derive the webhook header prefix (e.g. "x-payment") from the configured
// signature header (e.g. "X-Payment-Signature"). viewkey-watch's poller
// appends "-signature"/"-watch-id"/"-event" to this prefix.
function headerPrefixFrom(signatureHeader) {
	return String(signatureHeader || 'X-Payment-Signature')
		.replace(/-signature$/i, '')
		.toLowerCase();
}

function safeHost(url) {
	try { return new URL(url).hostname; }
	catch { return null; }
}

async function safeHealth(nfptClient) {
	try { return await nfptHealthCheck(nfptClient); }
	catch (err) { return { ok: false, reason: err?.message ?? String(err) }; }
}

/**
 * Mount the gateway's paid routes onto `app`.
 *
 * Returns a handle the host uses to wire its cross-cutting routes:
 *   { x402Cfg, watchDb, privateWatchReady, requirePaywall,
 *     privateNotConfigured, pricingCfg, chainRpcConfigured,
 *     cryptoAcceptedChains, cryptoTopupPolicy, buildPrivateWatchStats }
 */
export function registerGatewayRoutes(app, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const x402Cfg = opts.x402Cfg ?? buildX402Config({ cfg: config });
	const signatureHeader = config.webhookSignatureHeader;
	const headerPrefix = headerPrefixFrom(signatureHeader);
	const webhookUserAgent = opts.webhookUserAgent
		?? `${String(config.serviceName || 'PaymentsGateway').replace(/\s+/g, '')}-PrivateWatch/1.0`;
	const signatureHeaderHint = `${signatureHeader}: sha256=<HMAC-SHA256(webhookSecret, body)>`;
	// Optional operator docs link for the safer offline-derivation path,
	// folded into the derive-viewkey WARNING when provided.
	const deriveOfflineHint = 'derive offline using the orchard-scanner binary on a trusted machine'
		+ (opts.deriveDocsUrl ? ` (see ${opts.deriveDocsUrl})` : '');

	// Gate used by every paywalled route: when the paywall is off (no
	// recipient configured), answer 503 rather than serving for free.
	const requirePaywall = opts.requirePaywall ?? ((reply) => {
		if (x402Cfg.enabled) return null;
		reply.code(503).send({
			error: {
				code: 'paywall_not_configured',
				message: 'This endpoint requires the operator to set X402_RECIPIENT_ADDRESS (see /v1/paywall).'
			}
		});
		return reply;
	});

	// ── Privacy-chain atomic facts: /v1/q/xmr/* and /v1/q/zec/* ──
	const chainRpcUrls = opts.chainRpcUrls ?? {
		monero: config.moneroRpcUrl,
		zcash: config.zcashRpcUrl
	};
	const chainRpcConfigured = opts.chainRpcConfigured ?? {
		monero: Boolean(chainRpcUrls.monero),
		zcash: Boolean(chainRpcUrls.zcash)
	};
	const chainCache = opts.chainCache ?? createChainCache({
		ttlMs: opts.chainCacheTtlMs ?? config.chainCacheTtlMs
	});
	const chainDeps = {
		fetchImpl: opts.fetchImpl ?? globalThis.fetch,
		timeoutMs: opts.chainRpcTimeoutMs ?? config.chainRpcTimeoutMs
	};

	function chainNotConfigured(reply, chain) {
		reply.code(503).send({
			error: {
				code: 'chain_not_configured',
				message: `${chain.toUpperCase()} RPC is not configured on this server. Set ${chain === 'monero' ? 'MONERO_RPC_URL' : 'ZCASH_RPC_URL'} to enable.`
			}
		});
	}

	for (const [name, meta] of Object.entries(CHAIN_QUESTION_REGISTRY)) {
		app.get(`/v1/q/${name}`, async (req, reply) => {
			if (requirePaywall(reply)) return;
			if (!chainRpcConfigured[meta.chain]) {
				chainNotConfigured(reply, meta.chain);
				return;
			}
			try {
				return await chainCache.get(`q:${name}`, () =>
					dispatchChainQuestion({ name, deps: chainDeps, rpcUrls: chainRpcUrls })
				);
			} catch (err) {
				req.log.error({ err: err?.message ?? String(err), name }, 'chain question failed');
				reply.code(502);
				return {
					error: {
						code: 'chain_rpc_failed',
						message: err?.message ?? 'upstream RPC error',
						chain: meta.chain
					}
				};
			}
		});
	}

	// ── Private watch (view-key based payment monitoring) ─────────
	const privateWatchEnabled = Boolean(config.privateWatchEncryptionKey);
	const pricingCfg = buildPricingConfig(config);
	let watchDb = opts.watchDb ?? null;
	let watchMasterKey = opts.watchMasterKey ?? null;
	let nfptClient = opts.nfptClient ?? null;
	const webhookResolver = opts.webhookResolver ?? undefined;
	const privateWatchRequireHttps = opts.privateWatchRequireHttps
		?? (config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks);
	const webhookFetchImpl = opts.webhookFetchImpl ?? globalThis.fetch;
	// x402 payer relay (assigned later, once watchDb is resolved). Declared
	// here so /v1/private/info can advertise it when enabled.
	let x402Relay = null;

	if (privateWatchEnabled && opts.disablePrivateWatch !== true) {
		try {
			watchMasterKey = watchMasterKey ?? parseMasterKey(config.privateWatchEncryptionKey);
		}
		catch (err) {
			app.log.error({ err: err?.message ?? String(err) }, 'private-watch: encryption key invalid — POST /v1/private/watch will 503');
			watchMasterKey = null;
		}
		try {
			watchDb = watchDb ?? openWatchDb(opts.watchDbPath ?? config.privateWatchDbPath);
		}
		catch (err) {
			app.log.error({ err: err?.message ?? String(err), path: config.privateWatchDbPath }, 'private-watch: failed to open watch DB');
			watchDb = null;
		}
		nfptClient = nfptClient ?? createNfptClient({
			baseUrl: config.nfptBaseUrl,
			apiKey: config.nfptApiKey,
			timeoutMs: config.nfptTimeoutMs,
			fetchImpl: opts.fetchImpl ?? globalThis.fetch
		});
	}

	if (watchDb) {
		try { ensureCryptoTopupSchema(watchDb); }
		catch (err) { app.log.error({ err: err?.message ?? String(err) }, 'crypto-topup: failed to ensure quotes schema'); }
	}

	const privateWatchReady = () => Boolean(watchDb && watchMasterKey && nfptClient);

	function privateNotConfigured(reply, extra = {}) {
		reply.code(503).send({
			error: {
				code: 'private_watch_not_configured',
				message: 'POST /v1/private/watch requires PRIVATE_WATCH_ENCRYPTION_KEY and a writable PRIVATE_WATCH_DB (see /v1/private/info).',
				...extra
			}
		});
	}

	// Privacy-coin (XMR/ZEC) credit top-up config — shared by /v1/private/info
	// and the route registration. Inert per chain until the receiving address
	// is set, so safe to register unconditionally.
	const cryptoRecvAddresses = opts.cryptoRecvAddresses ?? {
		monero: config.xmrRecvAddress,
		zcash: config.zecRecvAddress
	};
	const cryptoPriceOracle = opts.cryptoPriceOracle ?? createPriceOracle({
		url: config.cryptoPriceUrl,
		timeoutMs: config.cryptoPriceTimeoutMs,
		cacheTtlMs: config.cryptoPriceCacheTtlMs,
		fetchImpl: opts.fetchImpl ?? globalThis.fetch,
		fallback: { monero: config.xmrUsdFallback, zcash: config.zecUsdFallback }
	});
	const cryptoTopupPolicy = {
		minUsdCents: config.cryptoTopupMinUsdCents,
		maxUsdCents: config.cryptoTopupMaxUsdCents,
		spreadBps: config.cryptoTopupSpreadBps,
		quoteTtlSec: config.cryptoTopupQuoteTtlSec,
		confirmations: {
			monero: config.cryptoTopupXmrConfirmations,
			zcash: config.cryptoTopupZecConfirmations
		}
	};
	const cryptoAcceptedChains = () => ['monero', 'zcash'].filter(
		(c) => typeof cryptoRecvAddresses[c] === 'string' && cryptoRecvAddresses[c].length > 0
	);

	app.get('/v1/private/info', async () => {
		const nfptHealth = privateWatchReady()
			? await safeHealth(nfptClient)
			: { ok: false, reason: 'private watch disabled' };
		const info = buildPrivateInfo({
			x402Cfg,
			nfptHealth,
			requireHttps: privateWatchRequireHttps,
			serviceName: config.serviceName,
			signatureHeader
		});
		if (watchDb) {
			const snap = storeStatsSnapshot(watchDb);
			info.surge_pricing = describeCurrentPricing({
				pricing: pricingCfg,
				activeWatches: snap?.active ?? 0
			});
		}
		info.crypto_topup = {
			accepted_chains: cryptoAcceptedChains(),
			min_usd: cryptoTopupPolicy.minUsdCents / 100,
			max_usd: cryptoTopupPolicy.maxUsdCents / 100,
			spread_bps: cryptoTopupPolicy.spreadBps,
			quote_ttl_sec: cryptoTopupPolicy.quoteTtlSec,
			confirmations: cryptoTopupPolicy.confirmations,
			endpoints: {
				quote: 'POST /v1/private/topup-crypto { watchId, watchToken, chain, amountUsdCents }',
				status: 'GET /v1/private/topup-crypto/{quoteId} (header x-watch-token)'
			},
			note: 'Fund a watch by paying in Monero or Zcash. We detect the payment with the same view-key scanner the product sells: the box holds only a view key for the receiving wallet, never a spend key.'
		};
		if (watchDb) info.crypto_topup.quotes = quoteStatsSnapshot(watchDb);
		if (x402Relay?.enabled()) {
			const relayInfo = x402Relay.info();
			info.x402_relay = {
				enabled: true,
				network: relayInfo.network,
				fee: relayInfo.fee,
				limits: relayInfo.limits,
				endpoints: {
					info: 'GET /v1/pay',
					pay: 'POST /v1/pay { watchId, watchToken, url, method?, body?, maxAmountUsd?, idempotencyKey? }',
					receipt: 'GET /v1/pay/{id} (header x-watch-token)'
				},
				note: 'Spend your prepaid balance at ANY x402 endpoint. We pay from our float and debit your credit for (amount + fee). Fund in USDC (/v1/private/topup*) or in XMR/ZEC (/v1/private/topup-crypto).'
			};
		}
		return info;
	});

	app.get('/v1/private/health', async () => {
		if (!watchDb) return { enabled: false, reason: 'watch DB not opened' };
		return {
			enabled: privateWatchReady(),
			stats: storeStatsSnapshot(watchDb)
		};
	});

	app.post('/v1/private/watch', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!privateWatchReady()) {
			return privateNotConfigured(reply);
		}
		let input;
		try {
			input = await resolveAndValidateWatchRequest(req.body ?? {}, {
				allowPrivateWebhooks: config.privateWatchAllowPrivateWebhooks,
				requireHttps: privateWatchRequireHttps,
				resolver: webhookResolver
			});
		}
		catch (err) {
			return reply.code(400).send({
				error: { code: 'invalid_request', message: err?.message ?? String(err) }
			});
		}
		const health = await safeHealth(nfptClient);
		if (!health?.ok) {
			return reply.code(502).send({
				error: {
					code: 'nfpt_upstream_unavailable',
					message: 'Upstream NFPT scanner is not reachable; refusing to create watch.',
					nfpt: health
				}
			});
		}
		const viewKeyCiphertext = encryptViewKey(input.viewKey, watchMasterKey);
		const webhookSecret = generateWebhookSecret();
		const snapshot = storeStatsSnapshot(watchDb);
		const rate = computeWatchRate({ ...pricingCfg, activeWatches: snapshot?.active ?? 0 });
		const created = storeCreateWatch(watchDb, {
			chain: input.chain,
			address: input.address,
			viewKeyCiphertext,
			webhookUrl: input.webhookUrl,
			webhookSecret,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: WATCH_CONSTANTS.STARTER_CREDIT_ATOMIC,
			dayRateAtomic: rate.dayRateAtomic,
			callRateAtomic: rate.callRateAtomic,
			lowCreditThresholdAtomic: rate.lowCreditThresholdAtomic,
			maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS,
			nowMs: input.now
		});
		req.log.info({
			watchId: created.id,
			chain: input.chain,
			webhookHost: safeHost(input.webhookUrl),
			creditAtomic: created.creditAtomic,
			dayRateAtomic: rate.dayRateAtomic,
			callRateAtomic: rate.callRateAtomic,
			activeWatchesAtCreation: rate.activeWatches,
			tier: rate.source
		}, 'private-watch: created');
		return {
			watchId: created.id,
			watchToken: created.token,
			webhookSecret,
			chain: input.chain,
			address: input.address,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: String(created.creditAtomic),
			expiresAt: new Date(created.expiresAt).toISOString(),
			pollIntervalSec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
			ratePerDayAtomic: String(rate.dayRateAtomic),
			ratePerCallAtomic: String(rate.callRateAtomic),
			lowCreditThresholdAtomic: String(rate.lowCreditThresholdAtomic),
			pricingTier: rate.source,
			activeWatchesAtCreation: rate.activeWatches,
			topupEndpoints: {
				'10c': '/v1/private/topup',
				'1usd': '/v1/private/topup-1',
				'5usd': '/v1/private/topup-5'
			},
			testEndpoint: `/v1/private/watch/${created.id}/test`,
			signatureHeader: signatureHeaderHint
		};
	});

	const TOPUP_TIERS = Object.freeze({
		'/v1/private/topup':    WATCH_CONSTANTS.TOPUP_10C_ATOMIC,
		'/v1/private/topup-1':  WATCH_CONSTANTS.TOPUP_1_ATOMIC,
		'/v1/private/topup-5':  WATCH_CONSTANTS.TOPUP_5_ATOMIC
	});

	for (const [path, creditAtomic] of Object.entries(TOPUP_TIERS)) {
		app.post(path, async (req, reply) => {
			if (requirePaywall(reply)) return;
			if (!privateWatchReady()) return privateNotConfigured(reply);
			let body;
			try { body = validateTopupRequest(req.body ?? {}); }
			catch (err) {
				return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
			}
			const existing = storeGetWatch(watchDb, body.watchId, body.watchToken);
			const ratesForTopup = existing && !existing.error
				? effectiveRatesForRow(existing)
				: { dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC, lowCreditThresholdAtomic: WATCH_CONSTANTS.LOW_CREDIT_THRESHOLD_ATOMIC };
			const out = storeTopupWatch(watchDb, body.watchId, body.watchToken, {
				creditAtomic,
				dayRateAtomic: ratesForTopup.dayRateAtomic,
				lowThresholdAtomic: ratesForTopup.lowCreditThresholdAtomic,
				maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS
			});
			if (!out.ok) {
				const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 409;
				return reply.code(code).send({ error: { code: out.reason, message: `top-up rejected: ${out.reason}` } });
			}
			req.log.info({
				watchId: body.watchId,
				tier: path,
				creditAtomic,
				newBalanceAtomic: out.row.credit_atomic
			}, 'private-watch: topup applied');
			return {
				watchId: out.row.id,
				tier: path,
				creditAppliedAtomic: String(creditAtomic),
				credit: buildCreditBlock(out.row),
				expiresAt: new Date(out.row.expires_at_ms).toISOString()
			};
		});
	}

	// Variable-amount top-up (bypasses @x402/fastify's fixed-price model).
	registerCustomTopupRoute(app, {
		watchDb,
		x402Cfg,
		requirePaywall,
		privateWatchReady,
		privateNotConfigured,
		log: app.log
	});

	// Privacy-coin (XMR/ZEC) credit top-ups — free to call; the payer funds
	// in coin and the receive-poller credits the watch.
	registerCryptoTopupRoutes(app, {
		watchDb,
		priceOracle: cryptoPriceOracle,
		recvAddresses: cryptoRecvAddresses,
		policy: cryptoTopupPolicy,
		memoPrefix: opts.memoPrefix ?? config.memoPrefix,
		privateWatchReady,
		privateNotConfigured,
		log: app.log
	});

	app.post('/v1/private/historical', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!nfptClient) {
			return reply.code(503).send({ error: { code: 'nfpt_not_configured', message: 'historical lookups require NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateHistoricalRequest(req.body ?? {}); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const health = await safeHealth(nfptClient);
		if (!health?.ok) {
			return reply.code(502).send({ error: { code: 'nfpt_upstream_unavailable', message: 'NFPT scanner unreachable', nfpt: health } });
		}
		const startedAt = Date.now();
		let result;
		try {
			result = await scanHistorical(nfptClient, {
				chain: input.chain,
				address: input.address,
				viewKey: input.viewKey,
				birthdayHeight: input.birthdayHeight,
				toHeight: input.toHeight,
				includeNotes: input.includeNotes,
				maxNotes: WATCH_CONSTANTS.HISTORICAL_MAX_NOTES
			});
		}
		catch (err) {
			req.log.warn({ err: err?.message ?? String(err) }, 'private-watch: historical scan failed');
			return reply.code(502).send({ error: { code: 'historical_scan_failed', message: err?.message ?? String(err) } });
		}
		req.log.info({
			chain: input.chain,
			notes_returned: result?.notes?.length ?? 0,
			elapsed_ms: Date.now() - startedAt
		}, 'private-watch: historical scan complete');
		return {
			chain: input.chain,
			address: input.address,
			birthdayHeight: input.birthdayHeight,
			toHeight: input.toHeight,
			scanned_at_ms: startedAt,
			elapsed_ms: Date.now() - startedAt,
			...result,
			view_key_handling: 'streamed to NFPT in memory only; not persisted to gateway DB or logs'
		};
	});

	app.post('/v1/private/derive-viewkey', { config: { rateLimit: { max: config.privateWatchDerivePerIpPerMin ?? 6, timeWindow: '1 minute' } } }, async (req, reply) => {
		if (!nfptClient) {
			return reply.code(503).send({ error: { code: 'nfpt_not_configured', message: 'derive-viewkey requires NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateDeriveRequest(req.body ?? {}); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		try {
			const result = await deriveUfvk(nfptClient, { mnemonic: input.phrase, network: input.network });
			req.log.info({ chain: input.chain, network: input.network, wordCount: input.wordCount }, 'private-watch: derive-viewkey ok');
			return {
				chain: input.chain,
				network: input.network,
				word_count: input.wordCount,
				ufvk: result.ufvk,
				sapling_fvk: result.sapling_fvk ?? null,
				transparent_fvk: result.transparent_fvk ?? null,
				WARNING: `Your seed phrase transited our server over TLS. We do NOT log or persist it, but a network observer between you and us would have seen the bytes. For maximum safety, ${deriveOfflineHint}. A UFVK is read-only and can ONLY observe incoming transactions; it cannot spend funds.`
			};
		}
		catch (err) {
			req.log.warn({ err: err?.message ?? String(err) }, 'private-watch: derive-viewkey failed');
			return reply.code(502).send({ error: { code: 'derive_failed', message: err?.message ?? String(err) } });
		}
	});

	app.get('/v1/private/watch/:id', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const row = storeGetWatch(watchDb, req.params.id, token);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found' } });
		if (row.error === 'forbidden') {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch' } });
		}
		return buildWatchSummary(row, { pollIntervalSec: config.privateWatchPollIntervalSec });
	});

	app.delete('/v1/private/watch/:id', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const ok = storeCancelWatch(watchDb, req.params.id, token);
		if (!ok) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found or forbidden' } });
		return { cancelled: true };
	});

	app.post('/v1/private/watch/:id/test', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const row = storeGetWatch(watchDb, req.params.id, token);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found' } });
		if (row.error === 'forbidden') {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch' } });
		}
		if (row.cancelled || row.dead) {
			return reply.code(409).send({ error: { code: 'watch_inactive', message: 'watch is cancelled or dead; create a new one' } });
		}
		const body = buildSyntheticTestBody({
			watchId: row.id,
			chain: row.chain,
			address: row.address,
			row,
			nowMs: Date.now()
		});
		const result = await deliverWebhook({
			url: row.webhook_url,
			body,
			secret: row.webhook_secret,
			watchId: row.id,
			fetchImpl: webhookFetchImpl,
			timeoutMs: config.privateWatchWebhookTimeoutMs,
			responseMaxBytes: config.privateWatchResponseMaxBytes,
			headerPrefix,
			userAgent: webhookUserAgent
		});
		req.log.info({
			watchId: row.id,
			ok: result.ok,
			status: result.status,
			webhookHost: safeHost(row.webhook_url)
		}, 'private-watch: synthetic test delivered');
		const code = result.ok ? 200 : 502;
		return reply.code(code).send({
			delivered: result.ok,
			status: result.status,
			error: result.error,
			signature_header: signatureHeaderHint,
			event: 'synthetic_test'
		});
	});

	// ── Paid notice board (freemium bulletin; pay-to-rank) ────────
	// Independent of the private-watch subsystem — its own SQLite, free
	// reads, free (rate-limited) posts, variable-amount x402 boosts. The
	// host supplies the board list via opts.boards; standalone defaults to
	// a single 'general' board.
	let boardDb = opts.boardDb ?? null;
	if (!boardDb && opts.disableNoticeBoard !== true) {
		try { boardDb = openBoardDb(opts.boardDbPath ?? config.noticeBoardDbPath); }
		catch (err) {
			app.log.error({ err: err?.message ?? String(err), path: config.noticeBoardDbPath }, 'notice-board: failed to open DB; board routes will 503');
			boardDb = null;
		}
	}
	const noticeBoard = registerNoticeBoardRoutes(app, {
		boardDb,
		x402Cfg,
		boards: opts.boards ?? config.noticeBoards,
		adminKey: opts.noticeBoardAdminKey ?? config.noticeBoardAdminKey,
		facilitatorFactory: opts.facilitatorFactory,
		freePostRateMax: opts.noticeBoardFreePostPerIpPerHour ?? config.noticeBoardFreePostPerIpPerHour,
		webBoardBaseUrl: opts.webBoardBaseUrl ?? config.webBoardBaseUrl,
		log: app.log,
		now: opts.now
	});

	// ── Paid unlock ("paid private file") — opt-in pay-to-reveal ──
	// Off unless the host opts in (PAID_UNLOCK_ENABLED or an injected DB), so
	// an embedding host doesn't gain a secret-storing write surface by
	// surprise. Reuses the view-key receiving wallet + price oracle (native
	// orders), the x402 paywall (USDC buys), and the watch master key for
	// sealing — the secret is encrypted at rest and only opened on delivery.
	let unlock = null;
	let unlockDb = opts.unlockDb ?? null;
	const paidUnlockOn = opts.paidUnlock === true || config.paidUnlockEnabled === true || Boolean(opts.unlockDb);
	if (paidUnlockOn && opts.disablePaidUnlock !== true) {
		if (!unlockDb) {
			try { unlockDb = openUnlockDb(opts.unlockDbPath ?? config.paidUnlockDbPath); }
			catch (err) {
				app.log.error({ err: err?.message ?? String(err), path: config.paidUnlockDbPath }, 'paid-unlock: failed to open DB; routes will 503');
				unlockDb = null;
			}
		}
		let unlockMasterKey = watchMasterKey ?? opts.watchMasterKey ?? null;
		if (!unlockMasterKey && config.privateWatchEncryptionKey) {
			try { unlockMasterKey = parseMasterKey(config.privateWatchEncryptionKey); }
			catch { unlockMasterKey = null; }
		}
		if (unlockDb) {
			unlock = registerPaidUnlockRoutes(app, {
				unlockDb,
				masterKey: unlockMasterKey,
				x402Cfg,
				priceOracle: cryptoPriceOracle,
				recvAddresses: cryptoRecvAddresses,
				policy: {
					spreadBps: config.cryptoTopupSpreadBps,
					confirmations: {
						zcash: config.cryptoTopupZecConfirmations,
						monero: config.cryptoTopupXmrConfirmations
					},
					orderTtlSec: config.paidUnlockOrderTtlSec
				},
				memoPrefix: opts.memoPrefix ?? config.memoPrefix,
				facilitatorFactory: opts.facilitatorFactory,
				freeCreateRateMax: opts.paidUnlockFreeCreatePerIpPerHour ?? config.paidUnlockFreeCreatePerIpPerHour,
				log: app.log,
				now: opts.now
			});
		}
	}

	// Donation overlay — streamer ZEC alerts from a UFVK (OBS browser source).
	const donationOverlay = registerDonationOverlayRoutes(app, {
		watchDb,
		priceOracle: cryptoPriceOracle,
		recvAddresses: cryptoRecvAddresses,
		policy: cryptoTopupPolicy,
		memoPrefix: opts.memoPrefix ?? config.memoPrefix,
		encryptViewKey: watchMasterKey ? (ufvk) => encryptViewKey(ufvk, watchMasterKey) : null,
		nfptHealth: () => safeHealth(nfptClient),
		overlayPageUrlBase: opts.overlayPageUrlBase ?? config.overlayPageUrlBase ?? '',
		privateWatchReady,
		privateNotConfigured,
		log: app.log,
		now: opts.now
	});

	// Ziving — JustGiving-style campaign pages (extends donation overlay).
	const ziving = registerZivingRoutes(app, {
		watchDb,
		priceOracle: cryptoPriceOracle,
		recvAddresses: cryptoRecvAddresses,
		policy: cryptoTopupPolicy,
		memoPrefix: opts.memoPrefix ?? config.memoPrefix,
		encryptViewKey: watchMasterKey ? (ufvk) => encryptViewKey(ufvk, watchMasterKey) : null,
		decryptViewKey: watchMasterKey ? (ct) => decryptViewKey(ct, watchMasterKey) : null,
		nfptHealth: () => safeHealth(nfptClient),
		zivingPageUrlBase: opts.zivingPageUrlBase ?? config.zivingPageUrlBase ?? '',
		overlayPageUrlBase: opts.overlayPageUrlBase ?? config.overlayPageUrlBase ?? '',
		privateWatchReady,
		privateNotConfigured,
		log: app.log,
		now: opts.now
	});

	// ── x402 payer relay (spend prepaid credit at ANY x402 endpoint) ──
	// Off unless the host injects a funded payer (opts.x402Payer) AND the
	// watch DB (the prepaid balance ledger) is open. Brand-neutral: the
	// signing key lives entirely in the host-built payer.
	if (opts.x402Payer && watchDb) {
		x402Relay = createX402RelayService({
			watchDb,
			payX402: opts.x402Payer,
			getWatch: storeGetWatch,
			config,
			lookup: opts.relayLookup,
			now: opts.now,
			log: app.log
		});
		registerX402RelayRoutes(app, {
			service: x402Relay,
			rateMax: opts.relayPerIpPerMin ?? config.relayPerIpPerMin,
			log: app.log
		});
	}

	// ── Hosted AI: prepaid credit bundles (x402) + OpenAI-compatible proxy ──
	// Independent of the private-watch subsystem: AI can be enabled even when
	// view-key watching is off. Opens its own session DB so the two meters
	// never share a table.
	const aiConfig = opts.aiConfig ?? resolveAiConfig(config);
	let aiDb = opts.aiDb ?? null;
	if (!aiDb && aiConfig.enabled) {
		try { aiDb = openAiDb(aiConfig.dbPath); }
		catch (err) {
			app.log.error({ err: err?.message ?? String(err), dbPath: aiConfig.dbPath }, 'ai: failed to open session DB; hosted AI disabled');
			aiDb = null;
		}
	}
	const aiHandle = registerAiRoutes(app, {
		aiDb,
		aiConfig,
		x402Cfg,
		requirePaywall,
		facilitatorFactory: opts.aiFacilitatorFactory,
		fetchImpl: opts.aiFetchImpl,
		log: app.log
	});

	// ── Live chat: AIRC-style real-time WebSocket channels (opt-in) ──
	// Ephemeral + in-memory; channels mirror the notice boards by default.
	// The WS endpoint mounts only when @fastify/websocket is registered on
	// the app (the standalone product does this in rest-app.js); the REST
	// /v1/chat metadata + history are always served.
	const chatHandle = registerChatRoutes(app, {
		chatConfig: opts.chatConfig ?? resolveChatConfig(config),
		log: app.log,
		now: opts.now
	});

	// Build the private-watch stats block a host folds into its own
	// stats overview. Mirrors the shape the standalone /v1/stats embeds.
	function buildPrivateWatchStats() {
		if (!watchDb) return { enabled: false, reason: 'watch DB not opened' };
		const routes = x402Cfg?.routes ?? {};
		return {
			enabled: privateWatchReady(),
			price_create: routes['POST /v1/private/watch']?.accepts?.price ?? null,
			price_topup_10c: routes['POST /v1/private/topup']?.accepts?.price ?? null,
			price_topup_1: routes['POST /v1/private/topup-1']?.accepts?.price ?? null,
			price_topup_5: routes['POST /v1/private/topup-5']?.accepts?.price ?? null,
			price_historical: routes['POST /v1/private/historical']?.accepts?.price ?? null,
			topup_custom: {
				min_atomic: String(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC),
				max_atomic: String(CUSTOM_TOPUP_LIMITS.MAX_ATOMIC),
				step_atomic: String(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC)
			},
			rate_per_day_atomic: String(WATCH_CONSTANTS.DAY_RATE_ATOMIC),
			rate_per_call_atomic: String(WATCH_CONSTANTS.CALL_RATE_ATOMIC),
			low_credit_threshold_atomic: String(WATCH_CONSTANTS.LOW_CREDIT_THRESHOLD_ATOMIC),
			surge_pricing: describeCurrentPricing({
				pricing: pricingCfg,
				activeWatches: storeStatsSnapshot(watchDb)?.active ?? 0
			}),
			poll_interval_sec: config.privateWatchPollIntervalSec,
			crypto_topup_chains: cryptoAcceptedChains(),
			stats: storeStatsSnapshot(watchDb)
		};
	}

	return {
		x402Cfg,
		watchDb,
		privateWatchReady,
		requirePaywall,
		privateNotConfigured,
		pricingCfg,
		chainRpcConfigured,
		cryptoAcceptedChains,
		cryptoTopupPolicy,
		buildPrivateWatchStats,
		boardDb: noticeBoard.boardDb,
		noticeBoards: noticeBoard.boards,
		buildNoticeBoardStats: noticeBoard.buildNoticeBoardStats,
		unlockDb: unlock?.unlockDb ?? null,
		buildUnlockStats: unlock?.buildUnlockStats ?? null,
		buildOverlayStats: donationOverlay.buildOverlayStats,
		buildZivingStats: ziving.buildZivingStats,
		aiDb,
		aiReady: aiHandle.aiReady,
		chatReady: chatHandle.chatReady,
		chatChannels: chatHandle.channels,
		x402Relay
	};
}

export default registerGatewayRoutes;
