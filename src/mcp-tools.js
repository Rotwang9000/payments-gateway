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
import { openBoardDb, listNotices, replyCountsForBoard, statsSnapshot as boardStatsSnapshot } from './notice-board-store.js';
import { normaliseBoards, sortNotices, buildNoticeSummary, atomicToUsd, BOARD_CONSTANTS } from './notice-board.js';
import { openUnlockDb, getListing as getUnlockListing, isListingOpen, listPublicListings as listPublicUnlockListings, statsSnapshot as unlockStatsSnapshot } from './paid-unlock-store.js';
import { publicListing as publicUnlockListing, UNLOCK_CONSTANTS } from './paid-unlock.js';

import {
	openWatchDb,
	createWatch as storeCreateWatch,
	getWatch as storeGetWatch
} from 'viewkey-watch/private-watch-store';
import { createX402RelayService, validateRelayRequest } from './x402-relay.js';
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
import {
	buildAmountAdvice,
	COMMON_AMOUNTS_ZEC
} from './zcash-amount-privacy.js';
import {
	openSharedShieldIndexDb,
	buildPopularFeed,
	exactCount,
	statsSnapshot,
	SHIELD_SIDES,
	DEFAULT_POPULAR_LIMIT
} from './zcash-shield-index.js';

export function asContent(obj) {
	return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// Shared, lazily-opened read handle for the notice board. The MCP HTTP
// transport may build a fresh McpServer per request, so we memoise the
// SQLite handle at module scope (one per path) instead of per server
// instance — otherwise every read tool call would leak a file handle.
// Injected handles (tests) bypass this entirely.
let _sharedBoardDb = null;
let _sharedBoardDbPath = null;
function openSharedBoardDb(path) {
	if (_sharedBoardDb && _sharedBoardDbPath === path) return _sharedBoardDb;
	try {
		_sharedBoardDb = openBoardDb(path);
		_sharedBoardDbPath = path;
		return _sharedBoardDb;
	} catch {
		return null;
	}
}

// Same memoised-handle trick for the paid-unlock read DB (info/listing).
let _sharedUnlockDb = null;
let _sharedUnlockDbPath = null;
function openSharedUnlockDb(path) {
	if (_sharedUnlockDb && _sharedUnlockDbPath === path) return _sharedUnlockDb;
	try {
		_sharedUnlockDb = openUnlockDb(path);
		_sharedUnlockDbPath = path;
		return _sharedUnlockDb;
	} catch {
		return null;
	}
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

	registerNoticeBoardMcpTools(server, { ...opts, config, x402Cfg, toolPrefix: prefix });

	// Paid-unlock tools (info/listing reads + a buy pointer). OPT-IN, matching
	// the REST plugin: only when the host turned the product on, so embedding
	// hosts don't gain the tools by surprise.
	if (opts.paidUnlock === true || config.paidUnlockEnabled === true || opts.unlockDb) {
		registerPaidUnlockMcpTools(server, { ...opts, config, x402Cfg, toolPrefix: prefix });
	}

	// x402 payer relay (spend prepaid credit anywhere). Only when the host
	// injects a FUNDED, enabled payer AND the watch DB (balance ledger) is
	// open — no point advertising the tool when it can't pay (matches the
	// make_payment family, which only registers when its service exists).
	if (opts.x402Payer?.enabled && watchDb) {
		const relayService = opts.x402RelayService ?? createX402RelayService({
			watchDb,
			payX402: opts.x402Payer,
			getWatch: storeGetWatch,
			config,
			now: opts.now
		});
		registerX402RelayMcpTools(server, { service: relayService, toolPrefix: prefix });
	}

	return { x402Cfg, watchDb, privateWatchReady };
}

/**
 * Register the paid notice-board tool family on `server`.
 *
 * Read tools (list/read) do real work against the board DB when one is
 * reachable (opened lazily, read path only). Write tools (post/boost)
 * return the REST endpoint + a ready-to-send body so the single, rate-
 * limited, sanitising write path stays at the REST surface (and boosts
 * settle over a real x402 hop, which MCP has no clean way to do).
 *
 * opts:
 *   - boards       host board list (array of {id,title,description})
 *   - boardDb / boardDbPath  inject or locate the board SQLite (reads)
 *   - toolPrefix   tool-name prefix (default 'gateway')
 */
export function registerNoticeBoardMcpTools(server, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const prefix = opts.toolPrefix ?? 'gateway';
	const boards = normaliseBoards(opts.boards);
	const boardIds = [...boards.keys()];
	const boostMin = atomicToUsd(BOARD_CONSTANTS.BOOST_MIN_ATOMIC);
	const boostMax = atomicToUsd(BOARD_CONSTANTS.BOOST_MAX_ATOMIC);

	// Read handle: an injected handle (tests) wins; otherwise use the
	// module-scoped shared opener so per-request MCP servers don't each
	// open their own. null on failure → tools degrade to a REST pointer.
	const injectedDb = opts.boardDb;
	function db() {
		if (injectedDb !== undefined) return injectedDb;
		return openSharedBoardDb(opts.boardDbPath ?? config.noticeBoardDbPath);
	}

	server.registerTool(`${prefix}_board_list`, {
		title: 'Public notice board — list boards (FREE)',
		description: `List the public notice boards and how many notices each holds. Boards: ${boardIds.join(', ')}. Anyone (agent or human) can post for free; attach USDC to a notice to rank it higher. Reads are free.`,
		inputSchema: {}
	}, async () => {
		const handle = db();
		const snap = handle ? boardStatsSnapshot(handle) : { boards: {} };
		return asContent({
			boards: [...boards.values()].map((b) => ({
				id: b.id,
				title: b.title,
				description: b.description,
				live: snap.boards?.[b.id]?.live ?? 0,
				paid: snap.boards?.[b.id]?.paid ?? 0,
				read: `GET /v1/board/${b.id}`,
				post: `POST /v1/board/${b.id}`
			})),
			posting: { free: true, boost_endpoint: 'POST /v1/board/{board}/{id}/boost', boost_min_usd: boostMin, boost_max_usd: boostMax }
		});
	});

	server.registerTool(`${prefix}_board_read`, {
		title: 'Public notice board — read a board (FREE)',
		description: 'Return the ranked notices on a board (boosted first by decayed weight, then most recent). Free to call.',
		inputSchema: {
			board: z.enum(boardIds).describe('Which board to read.'),
			limit: z.number().int().min(1).max(BOARD_CONSTANTS.LIST_MAX_LIMIT).optional().describe(`Max notices (default ${BOARD_CONSTANTS.LIST_DEFAULT_LIMIT}).`)
		}
	}, async ({ board, limit }) => {
		const handle = db();
		if (!handle) {
			return asContent({ board, notices: [], note: `Board DB not reachable here; read via GET /v1/board/${board}` });
		}
		const nowMs = Date.now();
		const rows = sortNotices(listNotices(handle, { board, status: 'live' }), { nowMs })
			.slice(0, limit ?? BOARD_CONSTANTS.LIST_DEFAULT_LIMIT);
		const replyCounts = replyCountsForBoard(handle, board);
		return asContent({
			board,
			count: rows.length,
			notices: rows.map((r) => ({ ...buildNoticeSummary(r, { nowMs }), reply_count: replyCounts.get(r.id) ?? 0 }))
		});
	});

	server.registerTool(`${prefix}_board_post`, {
		title: 'Public notice board — post a notice (FREE, via REST)',
		description: 'Prepare a free notice. Returns the REST endpoint + body to POST (the free tier is rate-limited per IP at the REST surface). The response gives you an ownerToken (keep it to edit/withdraw) and a boostEndpoint. New notices start at the bottom — boost to rank up.',
		inputSchema: {
			board: z.enum(boardIds).describe('Which board to post to.'),
			title: z.string().min(BOARD_CONSTANTS.TITLE_MIN).max(BOARD_CONSTANTS.TITLE_MAX).describe('Short title.'),
			body: z.string().min(1).max(BOARD_CONSTANTS.BODY_MAX).describe('The notice text.'),
			handle: z.string().max(BOARD_CONSTANTS.HANDLE_MAX).optional().describe('Display name (default anon).'),
			url: z.string().max(BOARD_CONSTANTS.URL_MAX).optional().describe('Optional http(s) link.'),
			contact: z.string().max(BOARD_CONSTANTS.CONTACT_MAX).optional().describe('Optional contact handle or URL.'),
			tags: z.array(z.string()).max(BOARD_CONSTANTS.TAGS_MAX).optional().describe('Up to 5 tags.')
		}
	}, async (params) => asContent({
		post_endpoint: `/v1/board/${params.board}`,
		method: 'POST',
		body: {
			title: params.title,
			body: params.body,
			handle: params.handle ?? undefined,
			url: params.url ?? undefined,
			contact: params.contact ?? undefined,
			tags: params.tags ?? undefined
		},
		free_note: 'POST the body to this path — no payment or key needed (rate-limited per IP). Keep the returned ownerToken; boost via the returned boostEndpoint to rank higher.'
	}));

	server.registerTool(`${prefix}_board_reply`, {
		title: 'Public notice board — reply in a thread (FREE, via REST)',
		description: 'Prepare a free reply to an existing notice (starts/continues a thread, one level deep). Returns the REST endpoint + body to POST. Title is optional — it defaults to "Re: <thread title>". Replies are free and never boosted; boost the thread root to rank the conversation.',
		inputSchema: {
			board: z.enum(boardIds).describe('The board the notice is on.'),
			id: z.string().min(1).describe('The notice id to reply to (from board_read).'),
			body: z.string().min(1).max(BOARD_CONSTANTS.BODY_MAX).describe('The reply text.'),
			title: z.string().min(BOARD_CONSTANTS.TITLE_MIN).max(BOARD_CONSTANTS.TITLE_MAX).optional().describe('Optional title (default "Re: <thread title>").'),
			handle: z.string().max(BOARD_CONSTANTS.HANDLE_MAX).optional().describe('Display name (default anon).'),
			url: z.string().max(BOARD_CONSTANTS.URL_MAX).optional().describe('Optional http(s) link.'),
			tags: z.array(z.string()).max(BOARD_CONSTANTS.TAGS_MAX).optional().describe('Up to 5 tags.')
		}
	}, async (params) => asContent({
		reply_endpoint: `/v1/board/${params.board}/${params.id}/reply`,
		method: 'POST',
		body: {
			body: params.body,
			title: params.title ?? undefined,
			handle: params.handle ?? undefined,
			url: params.url ?? undefined,
			tags: params.tags ?? undefined
		},
		free_note: 'POST the body to this path — no payment or key needed (rate-limited per IP). The reply attaches to the thread root. Keep the returned ownerToken to edit or withdraw it.'
	}));

	server.registerTool(`${prefix}_board_boost`, {
		title: 'Public notice board — boost a notice (paid via x402 at REST)',
		description: `Rank a notice higher by attaching USDC. Returns the REST endpoint + body for your x402 client to settle (any amount $${boostMin}-$${boostMax}). Anyone can boost any notice. This tool does NOT settle payment itself.`,
		inputSchema: {
			board: z.enum(boardIds).describe('The board the notice is on.'),
			id: z.string().min(1).describe('The notice id (from board_read).'),
			amountAtomic: z.number().int().positive().describe(`Boost amount in atomic USDC (6 decimals). Min ${BOARD_CONSTANTS.BOOST_MIN_ATOMIC} ($${boostMin}), max ${BOARD_CONSTANTS.BOOST_MAX_ATOMIC} ($${boostMax}).`)
		}
	}, async (params) => asContent({
		boost_endpoint: `/v1/board/${params.board}/${params.id}/boost`,
		method: 'POST',
		body: { amountAtomic: params.amountAtomic },
		x402_note: 'POST the body to this path with an x402 payment header for the same amount. Your client settles on Base mainnet then re-POSTs; weight is added only after settlement verifies. Boosts decay gently over ~7 days, so periodic re-boosting keeps a notice on top.'
	}));

	return { names: ['board_list', 'board_read', 'board_post', 'board_reply', 'board_boost'].map((n) => `${prefix}_${n}`) };
}

/**
 * Register the paid-unlock ("paid private file") tool family on `server`.
 *
 * Reads (info/listing) do real work against the unlock DB when reachable.
 * The buy is a REST pointer — the agent's x402 client settles at the REST
 * surface (MCP has no clean 402 hop), and we never hand a paid secret over
 * the free transport.
 *
 * opts:
 *   - unlockDb / unlockDbPath  inject or locate the unlock SQLite (reads)
 *   - x402Cfg                  paywall config (advertises the USDC buy rail)
 *   - toolPrefix               tool-name prefix (default 'gateway')
 */
export function registerPaidUnlockMcpTools(server, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const x402Cfg = opts.x402Cfg ?? buildX402Config({ cfg: config });
	const prefix = opts.toolPrefix ?? 'gateway';

	const nativeChains = ['zcash', 'monero'].filter((c) => {
		const addr = c === 'zcash' ? config.zecRecvAddress : config.xmrRecvAddress;
		return typeof addr === 'string' && addr.length > 0;
	});

	const injectedDb = opts.unlockDb;
	function db() {
		if (injectedDb !== undefined) return injectedDb;
		return openSharedUnlockDb(opts.unlockDbPath ?? config.paidUnlockDbPath);
	}

	const trustModel = 'Payment is non-custodial: the coin goes straight to the seller; we only ever hold a VIEW KEY to detect it. The file plaintext never touches us — encrypt it in-browser, host the ciphertext, and seal only the key + locator. The sealed secret is opened in-process to deliver on payment (we are NOT blind to it at release); platform-blind delivery over the Nym mixnet is the planned phase-2.';

	server.registerTool(`${prefix}_paid_unlock_info`, {
		title: 'Paid unlock — pay to reveal a sealed secret (FREE to query)',
		description: 'Returns how the pay-to-unlock ("paid private file") rail works: the supported price band, which payment rails are live (native ZEC/XMR detected via view key, and/or USDC via x402), the endpoints, the trust model, and current counters. Free to call.',
		inputSchema: {}
	}, async () => {
		const handle = db();
		return asContent({
			product: 'paid-unlock',
			what: 'Pay to unlock a sealed secret (a file decryption key + locator, a licence key, a download link). A seller seals it behind a price; a buyer pays and pulls it.',
			price_band_usd: {
				min: (UNLOCK_CONSTANTS.PRICE_MIN_USD_CENTS / 100).toFixed(2),
				max: (UNLOCK_CONSTANTS.PRICE_MAX_USD_CENTS / 100).toFixed(2)
			},
			pay: { native_chains: nativeChains, usdc_x402: Boolean(x402Cfg?.enabled) },
			endpoints: {
				listing: 'GET /v1/unlock/listing/{id}',
				order_native: 'POST /v1/unlock/listing/{id}/order { chain }',
				buy_usdc: x402Cfg?.enabled ? 'POST /v1/unlock/listing/{id}/buy (x402)' : null,
				status: 'GET /v1/unlock/order/{orderId} (header x-claim-token)',
				claim: 'POST /v1/unlock/order/{orderId}/claim (header x-claim-token)'
			},
			trust_model: trustModel,
			stats: handle ? unlockStatsSnapshot(handle) : null
		});
	});

	server.registerTool(`${prefix}_paid_unlock_listing`, {
		title: 'Paid unlock — look up a listing (FREE)',
		description: 'Return the public view of a paid-unlock listing by id: title, description, price, and which payment rails it accepts. Never returns the secret (that needs a paid + claimed order). Free to call.',
		inputSchema: {
			id: z.string().min(1).describe('The listing id (e.g. ul_… shared by the seller).')
		}
	}, async ({ id }) => {
		const handle = db();
		if (!handle) return asContent({ error: { code: 'paid_unlock_unavailable', message: `Unlock DB not reachable here; read via GET /v1/unlock/listing/${id}` } });
		const row = getUnlockListing(handle, id);
		if (!row || row.status !== 'live' || !isListingOpen(row)) {
			return asContent({ error: { code: 'not_found', message: 'listing not found, withdrawn or expired' } });
		}
		return asContent(publicUnlockListing(row, { nativeChains, x402Enabled: Boolean(x402Cfg?.enabled) }));
	});

	server.registerTool(`${prefix}_paid_unlock_browse`, {
		title: 'Paid unlock — browse the public shop (FREE)',
		description: 'List the publicly-advertised paid-unlock listings (those a seller opted into discovery with visibility:"public"). Newest first; never returns the secret. Link-only listings are intentionally excluded. Free to call.',
		inputSchema: {
			limit: z.number().int().min(1).max(UNLOCK_CONSTANTS.DISCOVERY_LIMIT_MAX).optional().describe(`Max listings to return (default ${UNLOCK_CONSTANTS.DISCOVERY_LIMIT_DEFAULT}).`),
			offset: z.number().int().min(0).optional().describe('Pagination offset.')
		}
	}, async ({ limit, offset }) => {
		const handle = db();
		if (!handle) return asContent({ error: { code: 'paid_unlock_unavailable', message: 'Unlock DB not reachable here; read via GET /v1/unlock/listings' } });
		const rows = listPublicUnlockListings(handle, {
			limit: limit ?? UNLOCK_CONSTANTS.DISCOVERY_LIMIT_DEFAULT,
			offset: offset ?? 0
		});
		return asContent({
			listings: rows.map((r) => publicUnlockListing(r, { nativeChains, x402Enabled: Boolean(x402Cfg?.enabled) })),
			count: rows.length,
			note: 'Public shop feed — opt-in listings only.'
		});
	});

	server.registerTool(`${prefix}_paid_unlock_buy`, {
		title: 'Paid unlock — buy a listing (paid; settle at REST)',
		description: 'Prepare to unlock a listing. Returns the REST endpoints + bodies: the instant USDC buy (POST .../buy — your x402 client settles, the secret comes back in the response) and the native ZEC/XMR order (POST .../order — get a pay quote, then claim once it confirms). This tool does NOT settle payment or reveal the secret itself.',
		inputSchema: {
			id: z.string().min(1).describe('The listing id to unlock.'),
			chain: z.enum(['usdc', 'zcash', 'monero']).default('usdc').describe('Payment rail: usdc (instant x402 buy) or a native coin (order + claim).')
		}
	}, async ({ id, chain }) => {
		const rail = chain ?? 'usdc';
		if (rail === 'usdc') {
			return asContent({
				buy_endpoint: `/v1/unlock/listing/${id}/buy`,
				method: 'POST',
				body: {},
				x402_note: 'POST to this path with an x402 payment header for the listing price (see the listing). Your client settles on Base then re-POSTs; the secret is returned in the 200 along with a claimToken for re-fetches.'
			});
		}
		return asContent({
			order_endpoint: `/v1/unlock/listing/${id}/order`,
			method: 'POST',
			body: { chain: rail },
			free_note: `POST { chain: "${rail}" } to get a pay quote (address, exact amount, ${rail === 'zcash' ? 'memo' : 'amount-tag'}, deadline) plus a claimToken. Pay it, poll GET /v1/unlock/order/{orderId} (x-claim-token) until status=paid, then POST .../claim to reveal the secret. Non-custodial: funds go to the seller; we detect via a view key.`
		});
	});

	return { names: ['paid_unlock_info', 'paid_unlock_listing', 'paid_unlock_browse', 'paid_unlock_buy'].map((n) => `${prefix}_${n}`) };
}

/**
 * Register the x402 payer-relay tool family on `server`.
 *
 * Unlike the other paid tools (which hand back a REST endpoint for the
 * agent's own x402 client to settle), `pay_x402` DOES the payment: it spends
 * the caller's prepaid balance, so it can settle directly over MCP with no
 * 402 hop. The agent never needs a Base wallet or USDC.
 *
 * opts:
 *   - service     a createX402RelayService instance (REQUIRED)
 *   - toolPrefix  tool-name prefix (default 'gateway')
 */
export function registerX402RelayMcpTools(server, opts = {}) {
	const service = opts.service;
	if (!service) throw new Error('registerX402RelayMcpTools: opts.service is required');
	const prefix = opts.toolPrefix ?? 'gateway';

	server.registerTool(`${prefix}_pay_x402_info`, {
		title: 'x402 relay — spend your prepaid balance anywhere (FREE to query)',
		description: 'Returns whether this gateway can pay OTHER x402 endpoints from your prepaid balance, plus the settlement network, the relay fee (the greater of a flat floor or a percentage), and the per-call/daily caps. Free to call.',
		inputSchema: {}
	}, async () => asContent(service.info()));

	server.registerTool(`${prefix}_pay_x402`, {
		title: 'Pay any x402 endpoint from your prepaid balance (SETTLES — debits credit)',
		description: 'Pay a third-party x402 resource from your prepaid balance (the credit meter funded via topup / topup-crypto). Unlike the other paid tools this one DOES settle: we probe the target\'s 402 challenge, pay it from our Base USDC float (only if the price is within your maxAmountUsd and the caps), return the upstream response, and debit your balance for (amount + relay fee). No Base wallet or USDC needed on your side — fund once in USDC or XMR/ZEC and spend everywhere. Pass an idempotencyKey to make retries safe.',
		inputSchema: {
			watchId: z.string().min(36).max(36).describe('The account (watchId) whose prepaid balance pays.'),
			watchToken: z.string().min(1).describe('The matching watchToken (constant-time compared).'),
			url: z.string().min(1).describe('The x402 endpoint to pay. Must be a public https URL that returns an x402 402 challenge on the relay network.'),
			method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method (default GET).'),
			body: z.union([z.string(), z.record(z.any())]).optional().describe('Optional request body for POST/PUT/PATCH (an object is sent as JSON).'),
			maxAmountUsd: z.number().positive().optional().describe('Cap on what we will pay the merchant, in USD. Clamped to the per-call ceiling.'),
			idempotencyKey: z.string().min(8).max(80).optional().describe('Optional dedupe key: a repeat returns the original receipt without paying again.')
		}
	}, async (params) => {
		if (!service.enabled()) {
			return asContent({ error: { code: 'relay_not_configured', message: 'x402 relay is not enabled on this server.' } });
		}
		let validated;
		try { validated = validateRelayRequest(params, { maxPerCallAtomic: service.limits.maxPerCallAtomic }); }
		catch (err) { return asContent({ error: { code: 'invalid_request', message: err?.message ?? String(err) } }); }
		const result = await service.relay({ ...validated, watchId: params.watchId, watchToken: params.watchToken });
		if (!result.ok) {
			return asContent({ error: { code: result.error?.code ?? 'relay_failed', message: result.error?.message ?? 'relay failed' }, receipt: result.receipt ?? null });
		}
		return asContent({
			ok: true,
			replayed: result.replayed ?? false,
			receipt: result.receipt,
			balance_usd: result.balance_usd ?? null,
			response: result.response ?? null
		});
	});

	return { names: ['pay_x402_info', 'pay_x402'].map((n) => `${prefix}_${n}`) };
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
 * Register the Zcash amount-privacy advisor family on `server`. Both tools are
 * FREE and local-first: the advice is pure math (no chain call), and when the
 * operator has enabled + populated the shield-amount index they are enriched
 * with the live on-chain popularity feed ("N others used this exact amount").
 *
 * opts:
 *   - config       gateway config (defaults to standalone config)
 *   - indexDb      inject an open shield-index DB (tests); else opened from
 *                  config when ZEC_SHIELD_INDEX_ENABLED
 *   - toolPrefix   tool-name prefix (default 'gateway')
 */
export function registerZcashAmountMcpTools(server, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const prefix = opts.toolPrefix ?? 'gateway';
	const injected = opts.indexDb;
	function db() {
		if (injected !== undefined) return injected;
		if (!config.zecShieldIndexEnabled) return null;
		return openSharedShieldIndexDb(config.zecShieldIndexDbPath);
	}
	const liveFeed = (handle, { side, nearZat = null, limit = DEFAULT_POPULAR_LIMIT }) => {
		if (!handle) return null;
		try {
			const feed = buildPopularFeed(handle, { side, nearZat, limit });
			return feed.length ? feed : null;
		} catch { return null; }
	};

	server.registerTool(`${prefix}_zec_amount_advice`, {
		title: 'Zcash amount privacy — shield/deshield "blend in" advisor (FREE)',
		description: 'Advise on a Zcash shield (t→z) or deshield (z→t) amount so it blends with the crowd instead of fingerprinting the user. Zcash hides amounts inside the pool, so the only leak is the TRANSPARENT boundary value. Given an amount + action this returns: nearby popular "blend-in" amounts (from real on-chain behaviour when the operator runs the shield-amount index, else a curated list), a round-trip self-dox risk assessment, and — if the user pastes their own shielded note values — whether deshielding any 1:1 would link a note to a transparent address (the "Wall of Shame" leak). Pure + free; no wallet, view key, or payment. Blending REDUCES linkability, it does not guarantee anonymity.',
		inputSchema: {
			amountZec: z.number().positive().describe('The amount of ZEC you intend to shield or deshield (e.g. 1.5).'),
			action: z.enum(['shield', 'deshield']).default('deshield').describe('shield = move transparent ZEC into the pool (t→z); deshield = move shielded ZEC out to a transparent address (z→t).'),
			noteAmountsZec: z.array(z.number().positive()).max(500).optional().describe('OPTIONAL: the ZEC values of your own shielded notes. Used only to warn about deshielding one 1:1 (a self-dox). Sent to the server in the clear — omit for sensitive wallets and rely on the in-app wizard which checks locally.'),
			count: z.number().int().min(1).max(32).optional().describe('How many blend-in suggestions to return (default 6).')
		}
	}, async (params) => {
		const action = params.action === 'shield' ? 'shield' : 'deshield';
		const handle = db();
		const popular = liveFeed(handle, { side: action, nearZat: Math.round(params.amountZec * 1e8) });
		const advice = buildAmountAdvice({
			amountZec: params.amountZec,
			action,
			noteAmountsZec: params.noteAmountsZec ?? [],
			popular,
			count: params.count ?? 6
		});
		if (handle) {
			try { advice.others_used_exact = exactCount(handle, { side: action, amountZat: advice.amount_zats }); }
			catch { /* degrade silently */ }
		}
		return asContent(advice);
	});

	server.registerTool(`${prefix}_zec_popular_amounts`, {
		title: 'Zcash amount privacy — popular shield/deshield amounts (FREE)',
		description: 'Return the amounts people most commonly shield or deshield, so a wallet can pick one with a large crowd to hide in. When the operator runs the on-chain shield-amount index this is REAL data from the zebra node (each amount carries the number of observed crossings); otherwise it is a curated list of human round numbers. Optionally pass `nearZec` to rank by closeness to a target amount. Free — no node, key or payment on the caller side.',
		inputSchema: {
			side: z.enum(['shield', 'deshield']).default('deshield').describe('Which boundary to summarise: amounts shielded (t→z) or deshielded (z→t).'),
			nearZec: z.number().positive().optional().describe('OPTIONAL: rank popular amounts by closeness to this ZEC amount instead of by raw popularity.'),
			limit: z.number().int().min(1).max(64).optional().describe('Max amounts to return (default 16).')
		}
	}, async (params) => {
		const side = SHIELD_SIDES.includes(params.side) ? params.side : 'deshield';
		const limit = Math.min(64, Math.max(1, params.limit ?? DEFAULT_POPULAR_LIMIT));
		const handle = db();
		const nearZat = params.nearZec != null ? Math.round(params.nearZec * 1e8) : null;
		const feed = liveFeed(handle, { side, nearZat, limit });
		if (feed) {
			return asContent({ side, source: 'live_index', amounts: feed, stats: statsSnapshot(handle) });
		}
		return asContent({
			side,
			source: 'bundled_list',
			amounts: COMMON_AMOUNTS_ZEC.map((zec) => ({ zec, zats: Math.round(zec * 1e8), count: null })),
			note: config.zecShieldIndexEnabled
				? 'On-chain index not populated yet; returning the curated blend-in list.'
				: 'On-chain index disabled on this server; returning the curated blend-in list.'
		});
	});

	return { names: ['zec_amount_advice', 'zec_popular_amounts'].map((n) => `${prefix}_${n}`) };
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
	// Zcash amount-privacy advisor (free; pure advice + live popularity feed
	// when the shield-amount index is enabled). `zcashAmountTools: false` drops.
	if (opts.zcashAmountTools !== false) {
		registerZcashAmountMcpTools(server, {
			config,
			toolPrefix: prefix,
			...(opts.zecIndexDb !== undefined ? { indexDb: opts.zecIndexDb } : {})
		});
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
