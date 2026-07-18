// Brand-neutral, environment-driven config for the payments gateway.
//
// This is the STANDALONE config (the winbit32 / self-hosted product reads it
// straight from the environment). When the gateway is embedded in another
// service (e.g. Seneschal's data-api), that host builds an equivalent object
// from its own config and injects it into `registerGatewayRoutes` /
// `registerGatewayMcpTools` — nothing here reaches for a host-specific name.
//
// Primary env var names are brand-neutral (GATEWAY_*, X402_*, NFPT_*,
// PRIVATE_WATCH_*, CRYPTO_*). For the handful of keys that historically
// carried the Seneschal brand we accept the legacy SENESCHAL_* name as a
// fallback so an existing deployment migrates without an env rewrite.

const DEFAULTS = Object.freeze({
	restPort: 8820,
	mcpPort: 8821,
	host: '127.0.0.1'
});

function readFirst(env, keys) {
	for (const key of keys) {
		const raw = env[key];
		if (raw !== undefined && raw !== '') return raw;
	}
	return undefined;
}

function asInt(env, keys, fallback) {
	const raw = readFirst(env, Array.isArray(keys) ? keys : [keys]);
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) {
		throw new Error(`config: ${Array.isArray(keys) ? keys[0] : keys}=${raw} is not an integer`);
	}
	return n;
}

function asString(env, keys, fallback) {
	const raw = readFirst(env, Array.isArray(keys) ? keys : [keys]);
	return raw === undefined ? fallback : raw;
}

function asFlag(env, keys, fallback = false) {
	const raw = readFirst(env, Array.isArray(keys) ? keys : [keys]);
	if (raw === undefined) return fallback;
	return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Parse a JSON-array env var into a plain array. Used for NOTICE_BOARDS.
 *
 * Deliberately LENIENT: returns `fallback` when the var is unset, empty,
 * not valid JSON, or not an array. The downstream normaliser
 * (`normaliseBoards`) does the field-level validation (id shape, dedupe),
 * so a stray entry can't take down a gateway that also serves payments —
 * a malformed value simply falls back to the default board. Operators
 * confirm the result via `GET /v1/board`.
 */
function asJsonArray(env, keys, fallback = null) {
	const raw = readFirst(env, Array.isArray(keys) ? keys : [keys]);
	if (raw === undefined) return fallback;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Build a frozen gateway config from an environment map. Exported so tests
 * (and embedding hosts) can construct alternate configs without mutating
 * process.env.
 */
export function buildConfig(env = process.env) {
	return Object.freeze({
		// ── Server ────────────────────────────────────────────────────
		restPort: asInt(env, ['GATEWAY_REST_PORT', 'SENESCHAL_REST_PORT'], DEFAULTS.restPort),
		restHost: asString(env, ['GATEWAY_REST_HOST', 'SENESCHAL_REST_HOST'], DEFAULTS.host),
		mcpPort: asInt(env, ['GATEWAY_MCP_PORT', 'SENESCHAL_MCP_PORT'], DEFAULTS.mcpPort),
		mcpHost: asString(env, ['GATEWAY_MCP_HOST', 'SENESCHAL_MCP_HOST'], DEFAULTS.host),

		// ── Brand (configurable so any operator can adopt the gateway) ──
		serviceName: asString(env, 'GATEWAY_SERVICE_NAME', 'Payments Gateway'),
		// MCP tool-name prefix ('gateway' → gateway_q; winbit32 deployment
		// sets 'winbit32'). Keep stable per deployment — agents cache names.
		toolPrefix: asString(env, 'GATEWAY_TOOL_PREFIX', 'gateway'),
		apiVersion: '0.1.0',
		// HMAC header name used to sign outbound webhooks. Keep this stable
		// per deployment — changing it breaks existing receivers. A host
		// embedding the gateway sets it to whatever its receivers expect
		// (e.g. Seneschal passes 'X-Seneschal-Signature').
		webhookSignatureHeader: asString(env, 'GATEWAY_WEBHOOK_SIGNATURE_HEADER', 'X-Payment-Signature'),

		// ── Limits ────────────────────────────────────────────────────
		rateLimitPerMin: asInt(env, ['GATEWAY_RATE_LIMIT_PER_MIN', 'SENESCHAL_RATE_LIMIT_PER_MIN'], 120),
		rateLimitTimeWindowMs: 60_000,
		sqliteBusyTimeoutMs: asInt(env, ['GATEWAY_SQLITE_BUSY_TIMEOUT_MS', 'SENESCHAL_SQLITE_BUSY_TIMEOUT_MS'], 500),

		// ── x402 paywall (accept USDC micropayments) ──────────────────
		x402Enabled: asFlag(env, 'X402_ENABLED'),
		x402Network: asString(env, 'X402_NETWORK', 'eip155:8453'),
		x402RecipientAddress: asString(env, 'X402_RECIPIENT_ADDRESS', ''),
		x402FacilitatorUrl: asString(env, 'X402_FACILITATOR_URL', 'https://facilitator.openx402.ai'),
		// CDP facilitator creds. When both present, settlement routes through
		// Coinbase's hosted facilitator and the service is auto-catalogued in
		// the x402 Bazaar. Accepts the generic COINBASE_API_* pair too.
		x402CdpApiKeyId: asString(env, ['X402_CDP_API_KEY_ID', 'CDP_API_KEY_ID', 'COINBASE_API_KEY'], ''),
		x402CdpApiKeySecret: asString(env, ['X402_CDP_API_KEY_SECRET', 'CDP_API_KEY_SECRET', 'COINBASE_API_SECRET'], ''),
		x402FeedPrice: asString(env, 'X402_FEED_PRICE', '$0.05'),
		x402MaxTimeoutSeconds: asInt(env, 'X402_MAX_TIMEOUT_SECONDS', 120),
		x402QPrice: asString(env, 'X402_Q_PRICE', '$0.001'),
		// Private-watch route prices.
		x402PrivateWatchPrice: asString(env, 'X402_PRIVATE_WATCH_PRICE', '$0.10'),
		x402PrivateTopupPrice: asString(env, 'X402_PRIVATE_TOPUP_PRICE', '$0.10'),
		x402PrivateTopup1Price: asString(env, 'X402_PRIVATE_TOPUP_1_PRICE', '$1.00'),
		x402PrivateTopup5Price: asString(env, 'X402_PRIVATE_TOPUP_5_PRICE', '$5.00'),
		x402PrivateHistoricalPrice: asString(env, 'X402_PRIVATE_HISTORICAL_PRICE', '$0.50'),

		// ── x402 payer relay (spend a prepaid balance at ANY x402 endpoint) ─
		// Off until the host injects a funded payer (a Base signer + x402
		// client). Caps are atomic USDC (1_000_000 = $1). The global daily cap
		// is the float guard — the ceiling on USDC the hot wallet fronts/day.
		// Fee model: GREATER of a flat floor and a percentage (basis points).
		relayMaxPerCallAtomic: asInt(env, 'RELAY_MAX_PER_CALL_ATOMIC', 1_000_000),
		relayMaxPerDayPerWatchAtomic: asInt(env, 'RELAY_MAX_PER_DAY_PER_ACCOUNT_ATOMIC', 10_000_000),
		relayMaxPerDayGlobalAtomic: asInt(env, 'RELAY_MAX_PER_DAY_GLOBAL_ATOMIC', 25_000_000),
		relayFeeFlatAtomic: asInt(env, 'RELAY_FEE_FLAT_ATOMIC', 1_000),
		relayFeeBps: asInt(env, 'RELAY_FEE_BPS', 500),
		relayNetwork: asString(env, ['RELAY_NETWORK', 'X402_NETWORK'], 'eip155:8453'),
		relayUsdcAsset: asString(env, 'RELAY_USDC_ASSET', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
		relayPerIpPerMin: asInt(env, 'RELAY_PER_IP_PER_MIN', 30),
		relayAllowHttp: asFlag(env, 'RELAY_ALLOW_HTTP', false),

		// ── Paid notice board (freemium bulletin; pay-to-rank) ────────
		// Reads are free; posting is free but rate-limited; boosting a
		// notice up the board is a variable-amount x402 payment. Own small
		// writable SQLite, separate from the watch DB. Boards themselves
		// are defined by the host (passed into registerGatewayRoutes); a
		// standalone deployment can instead declare them here via the
		// NOTICE_BOARDS env var — a JSON array of { id, title, description }
		// (e.g. '[{"id":"agents","title":"Agents","description":"For AI agents."}]').
		// Unset/malformed → falls back to a single 'general' board.
		noticeBoards: asJsonArray(env, 'NOTICE_BOARDS', null),
		noticeBoardDbPath: asString(env, ['NOTICE_BOARD_DB', 'GATEWAY_NOTICE_BOARD_DB'], '/var/lib/payments-gateway/notice-board.db'),
		noticeBoardFreePostPerIpPerHour: asInt(env, 'NOTICE_BOARD_FREE_POST_PER_IP_PER_HOUR', 6),
		// Operator removal key for DELETE …/{id} with header x-admin-key.
		// Empty disables operator removal (owners can still withdraw).
		noticeBoardAdminKey: asString(env, 'NOTICE_BOARD_ADMIN_KEY', ''),
		// Human-facing board site, used only to build feed (RSS/JSON) item
		// links. Empty → feed links point at the API resource instead.
		webBoardBaseUrl: asString(env, ['NOTICE_BOARD_WEB_URL', 'GATEWAY_BOARD_WEB_URL'], ''),

		// ── Live chat (AIRC-style real-time WebSocket channels) ───────
		// OPT-IN (CHAT_ENABLED): a lightweight, ephemeral chat — agents and
		// humans join channels, post short messages, and get a small recent-
		// history replay on join. No database (in-memory, transient). The
		// channel list defaults to the notice boards above (so the live chat
		// mirrors the board topics); CHAT_CHANNELS overrides with its own JSON
		// array of { id, title }. Ad-hoc channels can be created by joining
		// (rate-limited), AIRC-style.
		chatEnabled: asFlag(env, 'CHAT_ENABLED'),
		chatChannels: asJsonArray(env, 'CHAT_CHANNELS', null),
		chatAllowAdhocChannels: asFlag(env, 'CHAT_ALLOW_ADHOC_CHANNELS', true),
		chatMaxMessageLen: asInt(env, 'CHAT_MAX_MESSAGE_LEN', 400),
		chatMaxChannelsPerClient: asInt(env, 'CHAT_MAX_CHANNELS_PER_CLIENT', 10),
		chatHistorySize: asInt(env, 'CHAT_HISTORY_SIZE', 50),
		chatRatePerMin: asInt(env, 'CHAT_RATE_PER_MIN', 30),
		chatMaxChannels: asInt(env, 'CHAT_MAX_CHANNELS', 100),
		chatMaxClients: asInt(env, 'CHAT_MAX_CLIENTS', 500),

		// ── Paid unlock ("paid private file") — pay-to-reveal a sealed secret ─
		// A winbit32-native digital-goods rail: a seller seals a secret (a
		// file decryption key + locator, a licence key, a download link)
		// behind a price; a buyer pays in ZEC/XMR (view-key detected, NON-
		// custodial) or USDC (x402) and pulls the secret. OPT-IN
		// (PAID_UNLOCK_ENABLED) because it stores sealed secrets — off by
		// default so an embedding host isn't surprised by a new write surface.
		// Reuses PRIVATE_WATCH_ENCRYPTION_KEY (sealing), the ZEC/XMR receiving
		// wallet + crypto price oracle (native quotes) and the x402 paywall
		// (USDC buys). Its own small writable SQLite.
		paidUnlockEnabled: asFlag(env, 'PAID_UNLOCK_ENABLED', false),
		paidUnlockDbPath: asString(env, ['PAID_UNLOCK_DB', 'GATEWAY_PAID_UNLOCK_DB'], '/var/lib/payments-gateway/paid-unlock.db'),
		paidUnlockFreeCreatePerIpPerHour: asInt(env, 'PAID_UNLOCK_FREE_CREATE_PER_IP_PER_HOUR', 12),
		paidUnlockOrderTtlSec: asInt(env, 'PAID_UNLOCK_ORDER_TTL_SEC', 1_800),

		// ── Hosted AI (prepaid credit bundles + OpenAI-compatible proxy) ──
		// Enabled when AI_UPSTREAM_API_KEY is set (or AI_ENABLED=1). The
		// upstream key never reaches the browser — callers authenticate with a
		// short-lived session token bought via x402 at POST /v1/ai/credits.
		aiEnabled: asFlag(env, 'AI_ENABLED'),
		aiUpstreamBaseUrl: asString(env, 'AI_UPSTREAM_BASE_URL', 'https://openrouter.ai/api/v1'),
		aiUpstreamApiKey: asString(env, 'AI_UPSTREAM_API_KEY', ''),
		// Optional OpenRouter attribution headers (ignored by other upstreams).
		aiUpstreamReferer: asString(env, 'AI_UPSTREAM_REFERER', ''),
		aiUpstreamTitle: asString(env, 'AI_UPSTREAM_TITLE', ''),
		aiDefaultModel: asString(env, 'AI_DEFAULT_MODEL', 'openai/gpt-4o-mini'),
		// Comma-separated allowlist; empty means "any model the upstream serves".
		aiModelAllowlist: asString(env, 'AI_MODEL_ALLOWLIST', ''),
		// Public base URL returned in the credits response (client appends
		// /chat/completions). Empty → derived from the request host.
		aiPublicBaseUrl: asString(env, 'AI_PUBLIC_BASE_URL', ''),
		// Session DB. Empty → sibling of the private-watch DB (ai-sessions.db).
		aiDbPath: asString(env, ['AI_DB', 'AI_SESSIONS_DB'], ''),
		aiSessionTtlSec: asInt(env, 'AI_SESSION_TTL_SEC', 30 * 86400),
		aiRequestTimeoutMs: asInt(env, 'AI_REQUEST_TIMEOUT_MS', 120_000),
		aiMaxTokensCap: asInt(env, 'AI_MAX_TOKENS_CAP', 4096),
		// Credit-bundle sizing (US cents). Default $5, range $0.50–$20.
		aiCreditDefaultUsdCents: asInt(env, 'AI_CREDIT_DEFAULT_USD_CENTS', 500),
		aiCreditMinUsdCents: asInt(env, 'AI_CREDIT_MIN_USD_CENTS', 50),
		aiCreditMaxUsdCents: asInt(env, 'AI_CREDIT_MAX_USD_CENTS', 2000),
		// Per-token billing in atomic USDC (6dp). Defaults margin over a cheap
		// upstream like gpt-4o-mini; the operator tunes to their upstream costs.
		aiPricePer1kInputAtomic: asInt(env, 'AI_PRICE_PER_1K_INPUT_ATOMIC', 1000),   // $0.001 / 1k input
		aiPricePer1kOutputAtomic: asInt(env, 'AI_PRICE_PER_1K_OUTPUT_ATOMIC', 3000), // $0.003 / 1k output
		aiMinCallAtomic: asInt(env, 'AI_MIN_CALL_ATOMIC', 200),                      // $0.0002 per-call floor

		// ── Privacy-chain JSON-RPC (for /v1/q/xmr|zec facts) ──────────
		moneroRpcUrl: asString(env, 'MONERO_RPC_URL', 'http://127.0.0.1:18081'),
		zcashRpcUrl: asString(env, 'ZCASH_RPC_URL', 'http://127.0.0.1:8232'),
		chainCacheTtlMs: asInt(env, 'CHAIN_CACHE_TTL_MS', 10_000),
		chainRpcTimeoutMs: asInt(env, 'CHAIN_RPC_TIMEOUT_MS', 4_000),

		// ── Zcash shield-amount index (popular blend-in amounts) ──────
		// Builds a histogram of the transparent boundary amounts people shield
		// (t→z) and deshield (z→t) from the zebra node, so the amount-privacy
		// advisor can suggest amounts a real crowd uses and answer "N others
		// used this exact amount". The READ side (/v1/zec/amount-advice and
		// /v1/zec/popular-amounts, the zec_amount_advice + zec_popular_amounts
		// MCP tools) is always on — it just returns the bundled list until the
		// poller has populated the index. The SCANNER is the
		// gateway-zec-shield-index-poller bin, driven by a systemd .timer; it
		// resumes from a cursor and walks `maxBlocksPerTick` each run. When the
		// cursor is empty and fromHeight is 0 the poller seeds the start at
		// tip − windowBlocks (a rolling recent window — recent behaviour is the
		// most useful crowd to blend into).
		zecShieldIndexEnabled: asFlag(env, 'ZEC_SHIELD_INDEX_ENABLED', false),
		zecShieldIndexDbPath: asString(env, ['ZEC_SHIELD_INDEX_DB', 'GATEWAY_ZEC_SHIELD_INDEX_DB'], '/var/lib/payments-gateway/zec-shield-index.db'),
		zecShieldIndexFromHeight: asInt(env, 'ZEC_SHIELD_INDEX_FROM_HEIGHT', 0),
		zecShieldIndexWindowBlocks: asInt(env, 'ZEC_SHIELD_INDEX_WINDOW_BLOCKS', 100_000),
		zecShieldIndexMaxBlocksPerTick: asInt(env, 'ZEC_SHIELD_INDEX_MAX_BLOCKS_PER_TICK', 2_000),
		zecShieldIndexMinBoundaryZat: asInt(env, 'ZEC_SHIELD_INDEX_MIN_BOUNDARY_ZAT', 100_000),

		// ── Zcash "Bus Station" — non-custodial mixing coordination ───
		// OPT-IN. A rendezvous for many users to leave the Zcash pool with the
		// same blend-in amount, route and short window — so N look-alike swaps
		// become one anonymity set. The gateway holds NO funds and NO keys and
		// stores NO destinations/txids; it only tracks (route, amount, seat
		// count, departure window). Each rider broadcasts their OWN swap. The
		// tools + REST routes only appear when this is enabled (a writable DB is
		// required — there is no read-only fallback like the shield index).
		zecBusEnabled: asFlag(env, 'ZEC_BUS_ENABLED', false),
		zecBusDbPath: asString(env, ['ZEC_BUS_DB', 'GATEWAY_ZEC_BUS_DB'], '/var/lib/payments-gateway/zec-bus.db'),
		zecBusFillTtlMs: asInt(env, 'ZEC_BUS_FILL_TTL_MS', 24 * 60 * 60_000),
		zecBusDepartWindowMs: asInt(env, 'ZEC_BUS_DEPART_WINDOW_MS', 20 * 60_000),
		// Anti-sybil (P4c): when on, a seat claim REQUIRES a zk membership proof
		// (one anonymous identity → one seat per bus). OFF by default — it needs a
		// real trusted-setup ceremony + an injected verifier (registerZcashBusRoutes
		// `verifyProof`), so the public good keeps working anonymously until then.
		zecBusSybilRequired: asFlag(env, 'ZEC_BUS_SYBIL_REQUIRED', false),
		zecBusVerificationKeyPath: asString(env, 'ZEC_BUS_VERIFICATION_KEY', ''),

		// ── NFPT view-key scanner ─────────────────────────────────────
		nfptBaseUrl: asString(env, 'NFPT_BASE_URL', 'http://127.0.0.1:3555'),
		nfptApiKey: asString(env, 'NFPT_API_KEY', 'development-key-for-testing'),
		nfptTimeoutMs: asInt(env, 'NFPT_TIMEOUT_MS', 30_000),

		// ── Private watch (view-key payment monitoring) ───────────────
		privateWatchDbPath: asString(env, ['PRIVATE_WATCH_DB', 'GATEWAY_DB'], '/var/lib/payments-gateway/private-watches.db'),
		privateWatchEncryptionKey: asString(env, 'PRIVATE_WATCH_ENCRYPTION_KEY', ''),
		privateWatchAllowPrivateWebhooks: asFlag(env, 'PRIVATE_WATCH_ALLOW_PRIVATE_WEBHOOKS'),
		privateWatchRequireHttps: asFlag(env, 'PRIVATE_WATCH_REQUIRE_HTTPS', true),
		privateWatchPollIntervalSec: asInt(env, 'PRIVATE_WATCH_POLL_INTERVAL_SEC', 180),
		privateWatchWebhookTimeoutMs: asInt(env, 'PRIVATE_WATCH_WEBHOOK_TIMEOUT_MS', 8_000),
		privateWatchResponseMaxBytes: asInt(env, 'PRIVATE_WATCH_RESPONSE_MAX_BYTES', 4 * 1024),
		privateWatchMaxPerIp: asInt(env, 'PRIVATE_WATCH_MAX_PER_IP', 32),
		privateWatchDerivePerIpPerMin: asInt(env, 'PRIVATE_WATCH_DERIVE_PER_IP_PER_MIN', 6),

		// ── Privacy-coin credit top-ups (fund a watch in XMR/ZEC) ─────
		xmrRecvAddress: asString(env, ['XMR_RECV_ADDRESS', 'SENESCHAL_XMR_RECV_ADDRESS'], ''),
		xmrRecvViewKey: asString(env, ['XMR_RECV_VIEW_KEY', 'SENESCHAL_XMR_RECV_VIEW_KEY'], ''),
		// Monero scan-from height for the receiving wallet (single source of
		// truth — the legacy data-api config defined this key twice).
		xmrRecvFromHeight: asInt(env, ['XMR_RECV_FROM_HEIGHT', 'SENESCHAL_XMR_RECV_FROM_HEIGHT'], 0),
		zecRecvAddress: asString(env, ['ZEC_RECV_ADDRESS', 'SENESCHAL_ZEC_RECV_ADDRESS'], ''),
		zecRecvUfvk: asString(env, ['ZEC_RECV_UFVK', 'SENESCHAL_ZEC_RECV_UFVK'], ''),
		zecRecvBirthdayHeight: asInt(env, ['ZEC_RECV_BIRTHDAY_HEIGHT', 'SENESCHAL_ZEC_RECV_BIRTHDAY_HEIGHT'], 0),
		// Dash Evolution (Platform) Orchard shielded top-ups. The address
		// is the dash1z… Bech32m form of the FVK's default address; the
		// FVK scans Platform's flat note stream (no birthday height —
		// FROM_INDEX is a stream cursor, 0 = whole stream, fine while
		// the pool is young). Needs viewkey-watch >= 0.2.0 and
		// @dashevo/evo-sdk installed to activate.
		dashRecvAddress: asString(env, 'DASH_RECV_ADDRESS', ''),
		dashRecvFvk: asString(env, 'DASH_RECV_FVK', ''),
		dashRecvFromIndex: asInt(env, 'DASH_RECV_FROM_INDEX', 0),
		cryptoTopupMinUsdCents: asInt(env, 'CRYPTO_TOPUP_MIN_USD_CENTS', 200),
		cryptoTopupMaxUsdCents: asInt(env, 'CRYPTO_TOPUP_MAX_USD_CENTS', 50_000),
		cryptoTopupSpreadBps: asInt(env, 'CRYPTO_TOPUP_SPREAD_BPS', 400),
		// Pay-by window. ZEC settling alone needs 8 confs (~10 min of blocks),
		// so anything under an hour risks expiring a quote the payer honoured —
		// the grace window below is the safety net, not the primary path.
		cryptoTopupQuoteTtlSec: asInt(env, 'CRYPTO_TOPUP_QUOTE_TTL_SEC', 3_600),
		// How long after expiry a matching payment can still settle a quote.
		// Memo/amount attribution makes late settling honest; the deadline
		// only locked the rate.
		cryptoTopupMatchGraceMs: asInt(env, 'CRYPTO_TOPUP_MATCH_GRACE_MS', 7 * 86_400_000),
		cryptoTopupXmrConfirmations: asInt(env, 'CRYPTO_TOPUP_XMR_CONFIRMATIONS', 10),
		cryptoTopupZecConfirmations: asInt(env, 'CRYPTO_TOPUP_ZEC_CONFIRMATIONS', 8),
		// Platform notes are final on arrival (1s finality) — 1 means
		// "settle the tick it is seen".
		cryptoTopupDashConfirmations: asInt(env, 'CRYPTO_TOPUP_DASH_CONFIRMATIONS', 1),
		cryptoRecvPollIntervalSec: asInt(env, 'CRYPTO_RECV_POLL_INTERVAL_SEC', 60),
		// Per-tick cap on waiting for the NFPT receive-wallet scan. The old
		// library default (2 min) was shorter than a cold scan could ever
		// finish in, so the scan restarted from scratch every tick and no
		// payment was ever seen. The timer unit is oneshot, so a long run
		// simply delays the next tick.
		zecRecvScanMaxWaitMs: asInt(env, 'ZEC_RECV_SCAN_MAX_WAIT_MS', 480_000),
		// Donation overlay + Ziving (ziving.org campaign pages)
		overlayPageUrlBase: asString(env, 'OVERLAY_PAGE_URL_BASE', ''),
		overlayMaxPerTick: asInt(env, 'OVERLAY_MAX_PER_TICK', 4),
		zivingPageUrlBase: asString(env, 'ZIVING_PAGE_URL_BASE', ''),
		cryptoPriceUrl: asString(env, 'CRYPTO_PRICE_URL', 'https://api.coingecko.com/api/v3/simple/price'),
		cryptoPriceCacheTtlMs: asInt(env, 'CRYPTO_PRICE_CACHE_TTL_MS', 60_000),
		cryptoPriceTimeoutMs: asInt(env, 'CRYPTO_PRICE_TIMEOUT_MS', 5_000),
		xmrUsdFallback: asInt(env, 'XMR_USD_FALLBACK', 0),
		zecUsdFallback: asInt(env, 'ZEC_USD_FALLBACK', 0),
		dashUsdFallback: asInt(env, 'DASH_USD_FALLBACK', 0),

		// ── Make payments (outbound co-signed ZEC via a .wult share) ──
		// The gateway holds ONE FROST share; every send needs a human to
		// scan the WB32COSIGN QR with their cosigner (WINBIT32 cosign.exe)
		// and co-sign. The share alone cannot spend, so a compromised
		// gateway cannot move funds by itself.
		makePaymentWultPath: asString(env, 'MAKE_PAYMENT_WULT_PATH', ''),
		makePaymentWultPassword: asString(env, 'MAKE_PAYMENT_WULT_PASSWORD', ''),
		makePaymentRelayUrl: asString(env, 'MAKE_PAYMENT_RELAY_URL', 'https://cosign.winbit32.com'),
		// PCZT + scanner endpoints default to the configured NFPT host.
		makePaymentPcztApiBase: asString(env, 'MAKE_PAYMENT_PCZT_API_BASE', ''),
		makePaymentScannerBase: asString(env, 'MAKE_PAYMENT_SCANNER_BASE', ''),
		// Directory containing orchard_frost_wasm.js + orchard_frost_wasm_bg.wasm
		// (WINBIT32 stages these under public/orchard-frost/).
		makePaymentWasmDir: asString(env, 'MAKE_PAYMENT_WASM_DIR', ''),
		makePaymentNetwork: asString(env, 'MAKE_PAYMENT_NETWORK', 'main'),
		makePaymentBirthdayHeight: asInt(env, 'MAKE_PAYMENT_BIRTHDAY_HEIGHT', 0),
		// Operator safety rails for agent-initiated sends.
		makePaymentMaxZec: Number.parseFloat(asString(env, 'MAKE_PAYMENT_MAX_ZEC', '0.1')),
		makePaymentMaxPending: asInt(env, 'MAKE_PAYMENT_MAX_PENDING', 4),
		// Standalone cosigner page used to build clickable deep links from
		// qrPayload (the page consumes #WB32COSIGN:… from its URL hash).
		// /cosign.html is the static entry, safe under any SPA fallback.
		cosignAppUrl: asString(env, 'COSIGN_APP_URL', 'https://winbit32.com/cosign.html')
	});
}

export const config = buildConfig();

export default config;
