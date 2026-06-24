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
		// are defined by the host (passed into registerGatewayRoutes);
		// standalone falls back to a single 'general' board.
		noticeBoardDbPath: asString(env, ['NOTICE_BOARD_DB', 'GATEWAY_NOTICE_BOARD_DB'], '/var/lib/payments-gateway/notice-board.db'),
		noticeBoardFreePostPerIpPerHour: asInt(env, 'NOTICE_BOARD_FREE_POST_PER_IP_PER_HOUR', 6),
		// Operator removal key for DELETE …/{id} with header x-admin-key.
		// Empty disables operator removal (owners can still withdraw).
		noticeBoardAdminKey: asString(env, 'NOTICE_BOARD_ADMIN_KEY', ''),
		// Human-facing board site, used only to build feed (RSS/JSON) item
		// links. Empty → feed links point at the API resource instead.
		webBoardBaseUrl: asString(env, ['NOTICE_BOARD_WEB_URL', 'GATEWAY_BOARD_WEB_URL'], ''),

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
		cryptoTopupMinUsdCents: asInt(env, 'CRYPTO_TOPUP_MIN_USD_CENTS', 200),
		cryptoTopupMaxUsdCents: asInt(env, 'CRYPTO_TOPUP_MAX_USD_CENTS', 50_000),
		cryptoTopupSpreadBps: asInt(env, 'CRYPTO_TOPUP_SPREAD_BPS', 400),
		cryptoTopupQuoteTtlSec: asInt(env, 'CRYPTO_TOPUP_QUOTE_TTL_SEC', 900),
		cryptoTopupXmrConfirmations: asInt(env, 'CRYPTO_TOPUP_XMR_CONFIRMATIONS', 10),
		cryptoTopupZecConfirmations: asInt(env, 'CRYPTO_TOPUP_ZEC_CONFIRMATIONS', 8),
		cryptoRecvPollIntervalSec: asInt(env, 'CRYPTO_RECV_POLL_INTERVAL_SEC', 60),
		cryptoPriceUrl: asString(env, 'CRYPTO_PRICE_URL', 'https://api.coingecko.com/api/v3/simple/price'),
		cryptoPriceCacheTtlMs: asInt(env, 'CRYPTO_PRICE_CACHE_TTL_MS', 60_000),
		cryptoPriceTimeoutMs: asInt(env, 'CRYPTO_PRICE_TIMEOUT_MS', 5_000),
		xmrUsdFallback: asInt(env, 'XMR_USD_FALLBACK', 0),
		zecUsdFallback: asInt(env, 'ZEC_USD_FALLBACK', 0),

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
