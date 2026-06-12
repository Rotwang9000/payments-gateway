// Embeddable gateway MCP tools + standalone MCP server builder.
//
// `registerGatewayMcpTools(server, opts)` registers the Private Watch tool
// family onto an existing McpServer with a configurable tool-name prefix, so
// a host (Seneschal) can mount them alongside its own tools while keeping its
// own combined `q` / data tools. `buildGatewayMcpServer(opts)` assembles the
// full standalone server (private-watch tools + a privacy-chain `q` tool +
// paywall metadata) for the winbit32 product.
//
// Tools that take payment do NOT settle over MCP (the transport has no clean
// 402 hop) — they return the REST endpoint + body the agent's x402 client
// should call. Create/derive/info do real work against NFPT + the watch DB.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import gatewayConfig from './config.js';
import { buildX402Config } from './x402.js';
import {
	CHAIN_QUESTION_REGISTRY,
	createChainCache,
	dispatchChainQuestion
} from './queries-q-chain.js';
import { describePaywall } from './x402.js';

import {
	openWatchDb,
	createWatch as storeCreateWatch
} from 'viewkey-watch/private-watch-store';
import {
	parseMasterKey,
	encryptViewKey,
	generateWebhookSecret
} from 'viewkey-watch/private-watch-crypto';
import {
	createNfptClient,
	healthCheck as nfptHealthCheck,
	deriveUfvk
} from 'viewkey-watch/private-watch-nfpt';
import {
	resolveAndValidateWatchRequest,
	validateDeriveRequest,
	buildPrivateInfo,
	WATCH_CONSTANTS
} from 'viewkey-watch/private-watch';
import { createWalletKitToolDescriptors } from '@winbit32/wallet-kit';
import {
	validatePhrase,
	findChecksumWords,
	generatePhrase,
	splitSecretHex,
	combineSecretShares
} from './utility-tools.js';

export function asContent(obj) {
	return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// Resolve / open the watch subsystem from opts, falling back to config. The
// host normally injects already-open handles; standalone opens them here.
function resolveWatchSubsystem(opts, config) {
	const privateWatchEnabled = Boolean(config.privateWatchEncryptionKey);
	let watchDb = opts.watchDb ?? null;
	let watchMasterKey = opts.watchMasterKey ?? null;
	let nfptClient = opts.nfptClient ?? null;
	if (privateWatchEnabled && opts.disablePrivateWatch !== true) {
		if (!watchMasterKey) {
			try { watchMasterKey = parseMasterKey(config.privateWatchEncryptionKey); }
			catch { watchMasterKey = null; }
		}
		if (!watchDb) {
			try { watchDb = openWatchDb(opts.watchDbPath ?? config.privateWatchDbPath); }
			catch { watchDb = null; }
		}
		nfptClient = nfptClient ?? createNfptClient({
			baseUrl: config.nfptBaseUrl,
			apiKey: config.nfptApiKey,
			timeoutMs: config.nfptTimeoutMs,
			fetchImpl: opts.fetchImpl ?? globalThis.fetch
		});
	}
	return { watchDb, watchMasterKey, nfptClient };
}

/**
 * Register the Private Watch tool family on `server`.
 *
 * opts:
 *   - config       gateway config (defaults to standalone config)
 *   - x402Cfg      built x402 config (defaults to buildX402Config({cfg}))
 *   - toolPrefix   tool-name prefix (default 'gateway'); a host passes its own
 *   - watchDb / watchMasterKey / nfptClient  injected handles (optional)
 */
export function registerGatewayMcpTools(server, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const x402Cfg = opts.x402Cfg ?? buildX402Config({ cfg: config });
	const prefix = opts.toolPrefix ?? 'gateway';
	const signatureHeader = config.webhookSignatureHeader;
	const signatureHeaderHint = `${signatureHeader}: sha256=<HMAC-SHA256(webhookSecret, body)>`;
	const deriveOfflineHint = 'derive offline using the orchard-scanner binary on a trusted machine'
		+ (opts.deriveDocsUrl ? ` (see ${opts.deriveDocsUrl})` : '');
	const { watchDb, watchMasterKey, nfptClient } = resolveWatchSubsystem(opts, config);
	const privateWatchReady = () => Boolean(watchDb && watchMasterKey && nfptClient);

	server.registerTool(`${prefix}_private_watch_info`, {
		title: 'Private watch — service metadata',
		description: 'Returns the current price, supported chains, NFPT upstream health, and security notes for the view-key payment-monitoring service. Free to call.',
		inputSchema: {}
	}, async () => {
		const nfptHealth = privateWatchReady()
			? await nfptHealthCheck(nfptClient).catch((err) => ({ ok: false, reason: err?.message ?? String(err) }))
			: { ok: false, reason: 'private watch disabled on this server' };
		return asContent(buildPrivateInfo({
			x402Cfg,
			nfptHealth,
			requireHttps: config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks,
			serviceName: config.serviceName,
			signatureHeader
		}));
	});

	server.registerTool(`${prefix}_private_watch_create`, {
		title: 'Create a Monero/Zcash payment watch (paid via x402 at REST)',
		description: `Subscribe a Monero or Zcash address to view-key-based payment monitoring. The watch runs on a prepaid credit meter (${WATCH_CONSTANTS.DAY_RATE_ATOMIC} atomic USDC per day idle + ${WATCH_CONSTANTS.CALL_RATE_ATOMIC} per webhook delivered). Creation at the REST surface (POST /v1/private/watch) is paywalled at $0.10 via x402 and seeds the watch with $0.10 of credit. Receiver gets HMAC-signed webhooks plus a 'credit' block on every body; a 'low_credit' warning fires once before the meter expires. Top up via /v1/private/topup, topup-1, or topup-5. View keys are AES-256-GCM encrypted at rest.`,
		inputSchema: {
			chain: z.enum(['monero', 'zcash']).describe('Which privacy chain to monitor.'),
			address: z.string().min(1).describe('Public address for the chain. Monero: standard 95-char base58. Zcash: u1*, t1*, t3*, zs1*.'),
			viewKey: z.string().min(1).describe('Monero: 64-hex private view key. Zcash: UFVK starting with uview1.'),
			webhookUrl: z.string().min(1).describe('HTTPS endpoint we POST signed webhooks to. Private RFC1918/localhost addresses are rejected.'),
			birthdayHeight: z.number().int().nonnegative().optional().describe('Block height the wallet was created at. Monero: scans forward from this height. Zcash: defaults to NU6 (3_042_000) if unspecified.')
		}
	}, async (params) => {
		if (!privateWatchReady()) {
			return asContent({
				error: {
					code: 'private_watch_not_configured',
					message: 'PRIVATE_WATCH_ENCRYPTION_KEY or PRIVATE_WATCH_DB not configured on this server.'
				}
			});
		}
		let input;
		try {
			input = await resolveAndValidateWatchRequest(params, {
				allowPrivateWebhooks: config.privateWatchAllowPrivateWebhooks,
				requireHttps: config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks
			});
		}
		catch (err) {
			return asContent({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const health = await nfptHealthCheck(nfptClient).catch((err) => ({ ok: false, reason: err?.message ?? String(err) }));
		if (!health?.ok) {
			return asContent({ error: { code: 'nfpt_upstream_unavailable', message: 'Upstream NFPT scanner not reachable.', nfpt: health } });
		}
		const viewKeyCiphertext = encryptViewKey(input.viewKey, watchMasterKey);
		const webhookSecret = generateWebhookSecret();
		const created = storeCreateWatch(watchDb, {
			chain: input.chain,
			address: input.address,
			viewKeyCiphertext,
			webhookUrl: input.webhookUrl,
			webhookSecret,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: WATCH_CONSTANTS.STARTER_CREDIT_ATOMIC,
			dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC,
			maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS,
			nowMs: input.now
		});
		return asContent({
			watchId: created.id,
			watchToken: created.token,
			webhookSecret,
			chain: input.chain,
			address: input.address,
			creditAtomic: String(created.creditAtomic),
			ratePerDayAtomic: String(WATCH_CONSTANTS.DAY_RATE_ATOMIC),
			ratePerCallAtomic: String(WATCH_CONSTANTS.CALL_RATE_ATOMIC),
			expiresAt: new Date(created.expiresAt).toISOString(),
			pollIntervalSec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
			signatureHeader: signatureHeaderHint,
			topupEndpoints: { '10c': '/v1/private/topup', '1usd': '/v1/private/topup-1', '5usd': '/v1/private/topup-5' },
			note: `Watch is now active. Top up via the REST surface before the meter drains. Use ${prefix}_private_watch_topup or POST /v1/private/topup*; status/cancel via REST GET/DELETE /v1/private/watch/:id with header x-watch-token.`
		});
	});

	server.registerTool(`${prefix}_private_watch_topup`, {
		title: 'Top up an existing watch (paid via x402 at REST)',
		description: 'Add prepaid credit to an existing Private Watch. Three tiers — $0.10 (default), $1.00, and $5.00 — each settling at the matching REST path (/v1/private/topup, /topup-1, /topup-5). Credit is in atomic USDC ($0.02/day idle, $0.005/call). This tool returns the URL the agent should POST to with its x402 client; it does NOT settle payment itself.',
		inputSchema: {
			watchId: z.string().min(36).max(36).describe('The watchId returned from create.'),
			watchToken: z.string().min(1).describe('The watchToken returned from create (constant-time compared at the REST surface).'),
			tier: z.enum(['10c', '1', '5']).default('10c').describe('Top-up size. 10c = $0.10 (≈5 days idle), 1 = $1.00 (≈50 days), 5 = $5.00 (≈250 days).')
		}
	}, async (params) => {
		const tier = params.tier ?? '10c';
		const path = tier === '10c' ? '/v1/private/topup' : tier === '1' ? '/v1/private/topup-1' : '/v1/private/topup-5';
		const creditAtomic = tier === '10c'
			? WATCH_CONSTANTS.TOPUP_10C_ATOMIC
			: tier === '1' ? WATCH_CONSTANTS.TOPUP_1_ATOMIC : WATCH_CONSTANTS.TOPUP_5_ATOMIC;
		return asContent({
			topup_endpoint: path,
			tier,
			creditAtomic: String(creditAtomic),
			body: { watchId: params.watchId, watchToken: params.watchToken },
			x402_note: 'Post the body to this path with an x402 payment header. The route is paywalled — your client (e.g. @x402/client) settles on Base mainnet then re-POSTs. The handler debits the credit meter only after settlement is verified.'
		});
	});

	server.registerTool(`${prefix}_private_watch_topup_crypto`, {
		title: 'Top up an existing watch by paying in Monero or Zcash (FREE to quote)',
		description: 'Fund a Private Watch by paying in XMR or ZEC instead of USDC. Returns the FREE endpoint to call: POST /v1/private/topup-crypto issues a QUOTE — a receiving address, the exact coin amount to send (Monero: the amount carries a unique invoice tag; Zcash: a memo token), and a USD rate locked for a short window. Send the payment, then poll GET /v1/private/topup-crypto/{quoteId} (header x-watch-token) until status=settled. We detect the payment with the same view-key scanner the product sells and never hold a spend key. No x402, no API key — you pay in coin.',
		inputSchema: {
			watchId: z.string().min(36).max(36).describe('The watchId returned from create.'),
			watchToken: z.string().min(1).describe('The watchToken returned from create.'),
			chain: z.enum(['monero', 'zcash']).describe('Which privacy coin you will pay in.'),
			amountUsdCents: z.number().int().positive().describe('Credit to buy, in US cents (e.g. 500 = $5.00). Min/max enforced server-side; see the *_private_watch_info tool -> crypto_topup.')
		}
	}, async (params) => {
		return asContent({
			quote_endpoint: '/v1/private/topup-crypto',
			method: 'POST',
			body: { watchId: params.watchId, watchToken: params.watchToken, chain: params.chain, amountUsdCents: params.amountUsdCents },
			status_endpoint: '/v1/private/topup-crypto/{quoteId} (GET, header x-watch-token)',
			free_note: 'The quote call is FREE (no x402, no key) — you pay us in coin, not USDC. POST returns { quoteId, payTo, amount, memo, expiresAt, confirmations }. Monero: send the EXACT amount (the low digits are your invoice tag). Zcash: include the returned memo. Credit lands after the stated confirmations — poll the status endpoint.'
		});
	});

	server.registerTool(`${prefix}_private_watch_historical`, {
		title: 'One-off historical scan (paid via x402 at REST)',
		description: 'Return all spendable + spent notes for a view key without setting up a watch. The view key never touches our SQLite — it flows through to NFPT in memory only. Use this when you want to reconcile a wallet at a point in time. Priced at $0.50 / call at the REST surface.',
		inputSchema: {
			chain: z.enum(['monero', 'zcash']).describe('Which privacy chain to scan.'),
			address: z.string().min(1).describe('Address whose notes you want.'),
			viewKey: z.string().min(1).describe('Monero: 64-hex private view key. Zcash: UFVK starting with uview1.'),
			birthdayHeight: z.number().int().nonnegative().optional().describe('Skip scanning earlier blocks. Zcash auto-detects when omitted (slower but always correct).'),
			toHeight: z.number().int().nonnegative().optional().describe('Stop scanning at this block height. Defaults to chain tip.'),
			includeNotes: z.boolean().optional().describe('Include a per-note breakdown (value/height/tx_hash/spent) in the response. Default false — totals only.')
		}
	}, async (params) => {
		return asContent({
			historical_endpoint: '/v1/private/historical',
			body: {
				chain: params.chain,
				address: params.address,
				viewKey: params.viewKey,
				birthdayHeight: params.birthdayHeight ?? null,
				toHeight: params.toHeight ?? null,
				includeNotes: params.includeNotes ?? false
			},
			x402_note: 'Post the body to /v1/private/historical with an x402 payment header. View key is held in memory only during the request; nothing about it is logged or persisted.'
		});
	});

	server.registerTool(`${prefix}_private_watch_derive_viewkey`, {
		title: 'Derive a Zcash UFVK from a BIP-39 mnemonic (FREE, rate-limited)',
		description: `Hands a 12- or 24-word seed phrase to NFPT's orchard-scanner CLI, returns the matching UFVK. FREE but rate-limited to 6/minute/IP. Be loud about the security trade-off: the phrase transits our server (no logging, no persistence) but a network observer between you and us would see the bytes. The safer alternative is to ${deriveOfflineHint}. A UFVK is read-only; it cannot spend funds.`,
		inputSchema: {
			chain: z.enum(['zcash']).describe('Currently only Zcash (Orchard) UFVK derivation is supported; Monero coming later.'),
			phrase: z.string().min(1).describe('12- or 24-word BIP-39 mnemonic.'),
			network: z.enum(['mainnet', 'testnet', 'regtest']).default('mainnet').describe('Zcash network the wallet belongs to.')
		}
	}, async (params) => {
		if (!nfptClient) {
			return asContent({ error: { code: 'nfpt_not_configured', message: 'derive-viewkey requires NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateDeriveRequest(params); }
		catch (err) {
			return asContent({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		try {
			const result = await deriveUfvk(nfptClient, { mnemonic: input.phrase, network: input.network });
			return asContent({
				chain: input.chain,
				network: input.network,
				word_count: input.wordCount,
				ufvk: result.ufvk,
				sapling_fvk: result.sapling_fvk ?? null,
				transparent_fvk: result.transparent_fvk ?? null,
				WARNING: `Your seed phrase transited our server over TLS. We do NOT log or persist it, but a network observer between you and us would have seen the bytes. For maximum safety, ${deriveOfflineHint}.`
			});
		}
		catch (err) {
			return asContent({ error: { code: 'derive_failed', message: err?.message ?? String(err) } });
		}
	});

	return { x402Cfg, watchDb, privateWatchReady };
}

/**
 * Register the outbound-payment ("make") tool family on `server`.
 *
 * The service holds ONE Orchard FROST share; a human must co-sign every
 * payment by scanning the returned WB32COSIGN QR with their WINBIT32
 * cosigner, so the agent can *propose* spends but never move funds alone.
 *
 * opts:
 *   - service     a make-payment service (see make-payment.js); REQUIRED
 *   - toolPrefix  tool-name prefix (default 'gateway')
 */
export function registerMakePaymentMcpTools(server, opts = {}) {
	const service = opts.service;
	if (!service) throw new Error('registerMakePaymentMcpTools: opts.service is required');
	const prefix = opts.toolPrefix ?? 'gateway';

	server.registerTool(`${prefix}_make_payment_info`, {
		title: 'Outbound payments — service metadata (FREE)',
		description: 'Returns whether this gateway can MAKE payments (co-signed shielded ZEC), the vault\'s own unified address (fund it here), the per-payment cap, and the relay used for the human co-signing step. Free to call.',
		inputSchema: {}
	}, async () => asContent(await service.info()));

	server.registerTool(`${prefix}_make_payment`, {
		title: 'Make a shielded ZEC payment (human co-signature REQUIRED)',
		description: 'Start an outbound shielded Zcash payment from the gateway\'s FROST vault. The gateway scans the vault, builds the transaction, and returns a WB32COSIGN pairing payload two ways: `cosignUrl` (a clickable link that opens the standalone cosigner with the session pre-loaded — best for chat) and `qrPayload` (render as a QR code for camera scanning, or paste). The human approves by co-signing in their WINBIT32 cosigner; the transaction only exists once they do. Poll *_make_payment_status until status is `completed` (txid) or `failed`. The ceremony times out after ~3 minutes per signing step, so hand over the link/QR immediately.',
		inputSchema: {
			toAddress: z.string().min(20).describe('Recipient Zcash unified address (u1…). Shielded Orchard only.'),
			amountZec: z.number().positive().describe('Amount in ZEC (e.g. 0.01). Capped per payment by the operator — see *_make_payment_info.'),
			memo: z.string().max(512).optional().describe('Optional shielded memo (max 512 bytes), visible only to the recipient.')
		}
	}, async (params) => {
		try {
			const payment = await service.createPayment(params);
			return asContent({
				...payment,
				instructions: payment.qrPayload
					? 'Send the human cosignUrl as a clickable link (opens their cosigner with the session pre-loaded), or render qrPayload as a QR code to scan / string to paste. Then poll *_make_payment_status with this paymentId.'
					: 'No pairing payload yet — poll *_make_payment_status; cosignUrl/qrPayload appear once the transaction is built.'
			});
		} catch (err) {
			return asContent({ error: { code: 'make_payment_failed', message: err?.message ?? String(err) } });
		}
	});

	server.registerTool(`${prefix}_make_payment_status`, {
		title: 'Check an outbound payment (FREE)',
		description: 'Poll a payment started with *_make_payment. Statuses: preparing → awaiting_cosigner (link/QR live) → proving → broadcasting → completed (txid) | failed. cosignUrl and qrPayload stay in the response while the ceremony is open.',
		inputSchema: {
			paymentId: z.string().min(36).max(36).describe('The paymentId returned by *_make_payment.')
		}
	}, async ({ paymentId }) => {
		const payment = service.getPayment(paymentId);
		if (!payment) {
			return asContent({ error: { code: 'not_found', message: 'No payment with that id (records are pruned after completion).' } });
		}
		return asContent(payment);
	});

	return { service };
}

/** Map a wallet-kit flat param spec ({type, description, required}) to a zod raw shape. */
function kitParamsToZodShape(params) {
	const shape = {};
	for (const [key, spec] of Object.entries(params)) {
		let schema;
		switch (spec.type) {
			case 'string': schema = z.string(); break;
			case 'boolean': schema = z.boolean(); break;
			case 'integer': schema = z.number().int(); break;
			default: schema = z.number();
		}
		schema = schema.describe(spec.description);
		shape[key] = spec.required ? schema : schema.optional();
	}
	return shape;
}

/**
 * Register the @winbit32/wallet-kit view-key tool family on `server`:
 * zec/xmr scan jobs, transparent UTXOs and raw-tx broadcast. All view-only —
 * nothing here can move funds (broadcast requires an externally signed tx).
 *
 * opts:
 *   - toolPrefix   tool-name prefix (default 'gateway')
 *   - descriptors  inject prebuilt descriptors (tests)
 *   - walletKit    options forwarded to createWalletKitToolDescriptors
 *                  (per-chain { baseUrl, apiKey, client } or false to drop)
 */
export function registerWalletKitMcpTools(server, opts = {}) {
	const prefix = opts.toolPrefix ?? 'gateway';
	const descriptors = opts.descriptors ?? createWalletKitToolDescriptors(opts.walletKit ?? {});
	for (const tool of descriptors) {
		server.registerTool(`${prefix}_${tool.name}`, {
			title: tool.title,
			description: tool.description,
			inputSchema: kitParamsToZodShape(tool.params)
		}, async (input) => {
			try {
				return asContent(await tool.handler(input ?? {}));
			} catch (err) {
				return asContent({ error: { code: 'wallet_tool_failed', tool: tool.name, message: err?.message ?? String(err) } });
			}
		});
	}
	return { count: descriptors.length, names: descriptors.map((t) => `${prefix}_${t.name}`) };
}

/**
 * Register the SecTools utility family on `server`: BIP-39 phrase hygiene
 * and Shamir secret sharing. Local + offline — nothing is stored, logged
 * or sent anywhere — but inputs ARE secret material in flight, so the
 * descriptions tell agents to prefer self-hosted servers for real keys.
 *
 * opts:
 *   - toolPrefix  tool-name prefix (default 'gateway')
 */
export function registerUtilityMcpTools(server, opts = {}) {
	const prefix = opts.toolPrefix ?? 'gateway';
	const wrap = (fn) => async (input) => {
		try {
			return asContent(fn(input ?? {}));
		} catch (err) {
			return asContent({ error: { code: 'utility_tool_failed', message: err?.message ?? String(err) } });
		}
	};

	server.registerTool(`${prefix}_phrase_validate`, {
		title: 'Validate a BIP-39 seed phrase (local, FREE)',
		description: 'Check a BIP-39 mnemonic: word membership, length and checksum. Runs locally on the server, stores nothing. For real secrets prefer a self-hosted deployment.',
		inputSchema: {
			phrase: z.string().min(3).describe('The space-separated mnemonic to check.')
		}
	}, wrap(({ phrase }) => validatePhrase(phrase)));

	server.registerTool(`${prefix}_phrase_complete`, {
		title: 'Find BIP-39 checksum words (local, FREE)',
		description: 'Given a phrase missing its final word (11, 14, 17, 20 or 23 words), list every valid final (checksum) word. Useful for recovering a phrase with a lost last word.',
		inputSchema: {
			partialPhrase: z.string().min(3).describe('All words except the last, space-separated.')
		}
	}, wrap(({ partialPhrase }) => findChecksumWords(partialPhrase)));

	server.registerTool(`${prefix}_phrase_generate`, {
		title: 'Generate a BIP-39 seed phrase (local, FREE)',
		description: 'Generate a fresh mnemonic with server-side CSPRNG entropy. SECURITY: whoever sees this response controls the wallet — treat the transcript as sensitive, prefer self-hosted servers, and prefer the split-wult cosign model over raw phrases where possible.',
		inputSchema: {
			wordCount: z.number().int().optional().describe('12, 15, 18, 21 or 24 (default 12).')
		}
	}, wrap(({ wordCount }) => generatePhrase(wordCount ?? 12)));

	server.registerTool(`${prefix}_shamir_split`, {
		title: 'Shamir-split a hex secret (local, FREE)',
		description: 'Split a hex-encoded secret (key, seed, entropy) into N shares where any K reconstruct it (Shamir secret sharing, GF(256)). Shares are returned hex-encoded; distribute them to separate places.',
		inputSchema: {
			secretHex: z.string().min(2).describe('Even-length hex string to split.'),
			shares: z.number().int().min(2).max(255).describe('Total number of shares to create.'),
			threshold: z.number().int().min(2).max(255).describe('How many shares are needed to reconstruct.')
		}
	}, wrap(({ secretHex, shares, threshold }) => splitSecretHex(secretHex, shares, threshold)));

	server.registerTool(`${prefix}_shamir_combine`, {
		title: 'Reconstruct a Shamir-split secret (local, FREE)',
		description: 'Combine K or more hex shares from *_shamir_split back into the original hex secret.',
		inputSchema: {
			shares: z.array(z.string().min(2)).min(2).describe('Hex shares (at least the threshold count).')
		}
	}, wrap(({ shares }) => combineSecretShares(shares)));

	return {
		names: ['phrase_validate', 'phrase_complete', 'phrase_generate', 'shamir_split', 'shamir_combine']
			.map((n) => `${prefix}_${n}`)
	};
}

/**
 * Build a standalone MCP server (the winbit32 product): the Private Watch
 * tool family + a privacy-chain `q` tool + free paywall metadata.
 */
export function buildGatewayMcpServer(opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const x402Cfg = opts.x402Cfg ?? buildX402Config({ cfg: config });
	const prefix = opts.toolPrefix ?? 'gateway';
	const paywallSummary = describePaywall(x402Cfg);

	const chainRpcUrls = opts.chainRpcUrls ?? { monero: config.moneroRpcUrl, zcash: config.zcashRpcUrl };
	const chainRpcConfigured = opts.chainRpcConfigured ?? {
		monero: Boolean(chainRpcUrls.monero),
		zcash: Boolean(chainRpcUrls.zcash)
	};
	const chainCache = opts.chainCache ?? createChainCache({ ttlMs: opts.chainCacheTtlMs ?? config.chainCacheTtlMs });
	const chainDeps = {
		fetchImpl: opts.fetchImpl ?? globalThis.fetch,
		timeoutMs: opts.chainRpcTimeoutMs ?? config.chainRpcTimeoutMs
	};

	const server = new McpServer({
		name: opts.serverName ?? 'payments-gateway',
		version: config.apiVersion,
		title: opts.serverTitle ?? config.serviceName,
		description: 'Pay-per-call payments gateway: Monero/Zcash view-key payment webhooks (create watches, historical note scans, derive a Zcash UFVK), XMR/ZEC top-ups, and live privacy-chain facts. Settles via x402 (USDC on Base); free read tier.'
	});

	server.registerTool(`${prefix}_paywall_info`, {
		title: 'Paywall / x402 metadata',
		description: 'Returns the protocol, network, recipient address, and per-call price for every gated endpoint. Free to call.',
		inputSchema: {}
	}, async () => asContent(paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' }));

	const chainQuestions = Object.keys(CHAIN_QUESTION_REGISTRY);
	server.registerTool(`${prefix}_q`, {
		title: 'Penny Oracle: privacy-chain atomic facts',
		description: `Atomic single-fact endpoints for tight agent loops, sourced from operator-run Monero and Zcash full nodes. Questions: ${chainQuestions.join(', ')}. Flat $0.001/call at the REST surface.`,
		inputSchema: {
			question: z.enum(chainQuestions).describe('Which atomic fact to ask, e.g. xmr/height or zec/mempool.')
		}
	}, async ({ question }) => {
		try {
			const meta = CHAIN_QUESTION_REGISTRY[question];
			if (!chainRpcConfigured[meta.chain]) {
				return asContent({ error: { code: 'chain_not_configured', message: `${meta.chain.toUpperCase()} RPC is not configured on this server.`, chain: meta.chain } });
			}
			const result = await chainCache.get(`q:${question}`, () =>
				dispatchChainQuestion({ name: question, deps: chainDeps, rpcUrls: chainRpcUrls })
			);
			return asContent(result);
		} catch (err) {
			return asContent({ error: { code: 'q_validation', message: err?.message ?? String(err), question, available: chainQuestions } });
		}
	});

	registerGatewayMcpTools(server, { ...opts, config, x402Cfg, toolPrefix: prefix });
	// Outbound (make) payments are only offered when the host wired up a
	// service — i.e. a .wult share is configured. The service is created
	// once by the host (bin/mcp.mjs) and shared across the per-request
	// MCP server instances so payment state survives between calls.
	if (opts.makePaymentService) {
		registerMakePaymentMcpTools(server, { service: opts.makePaymentService, toolPrefix: prefix });
	}
	// Wallet-kit view-key tools (scan jobs, UTXOs, broadcast). On by
	// default — they only observe chains via the public scanner unless the
	// host overrides base URLs. `walletKitTools: false` drops them.
	if (opts.walletKitTools !== false) {
		registerWalletKitMcpTools(server, {
			toolPrefix: prefix,
			walletKit: opts.walletKit ?? {
				zcash: config.makePaymentScannerBase ? { baseUrl: config.makePaymentScannerBase } : {},
				monero: {}
			}
		});
	}
	// SecTools utility family (phrase hygiene, Shamir). Local + keyless;
	// `utilityTools: false` drops them.
	if (opts.utilityTools !== false) {
		registerUtilityMcpTools(server, { toolPrefix: prefix });
	}
	return server;
}

/**
 * Stateless Streamable-HTTP listener for the standalone MCP server.
 */
export function startGatewayMcpHttpServer(opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const port = opts.port ?? config.mcpPort;
	const host = opts.host ?? config.mcpHost;
	const buildServer = opts.buildServer ?? (() => buildGatewayMcpServer(opts));

	const server = http.createServer(async (req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'content-type,mcp-session-id,mcp-protocol-version');
		res.setHeader('Access-Control-Max-Age', '86400');
		if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
		if (req.url === '/health' && req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
			return;
		}
		if (req.url !== '/' && req.url !== '/mcp') {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_004, message: 'route not found' }, id: null }));
			return;
		}
		try {
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			const mcp = buildServer();
			res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
			await mcp.connect(transport);
			await transport.handleRequest(req, res);
		} catch (err) {
			console.error('mcp request failed:', err);
			if (!res.headersSent) {
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_603, message: 'internal error', data: err?.message }, id: randomUUID() }));
			}
		}
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}

export default registerGatewayMcpTools;
