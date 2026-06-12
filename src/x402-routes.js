// The gateway's x402 premium-route catalogue. These are the *payment* routes —
// Monero/Zcash view-key webhooks (Private Watch) and the privacy-chain
// single-fact ("Penny Oracle") queries. A host that also serves other paid
// routes (e.g. Seneschal's DeFi feeds) concatenates its own catalogue with
// this one before handing the combined list to x402-server-kit.
//
// @x402/fastify matches `"METHOD /path"` exactly (no wildcards), so each path
// is enumerated explicitly.

/**
 * Build an atomic single-fact ("Penny Oracle") route descriptor. All such
 * routes share the micro price tier (`X402_Q_PRICE`, default $0.001) so agents
 * can hammer them in tight loops without subscription friction.
 */
export const qFact = (path, description) => Object.freeze({
	method: 'GET',
	path,
	description,
	mimeType: 'application/json',
	priceEnvKey: 'X402_Q_PRICE'
});

export const GATEWAY_PREMIUM_ROUTES = Object.freeze([
	// === Private Watch — Monero/Zcash view-key payment webhooks ===
	Object.freeze({
		method: 'POST',
		path: '/v1/private/watch',
		description: 'Create a Monero or Zcash view-key payment watch. Body: { chain, address, viewKey, webhookUrl, birthdayHeight? }. Returns { watchId, watchToken, webhookSecret, expiresAt, creditAtomic } — the receiver verifies inbound webhooks with HMAC-SHA256(webhookSecret, body) and tops up via /v1/private/topup* before the meter runs dry.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_WATCH_PRICE'
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup',
		description: 'Add $0.10 of credit (100_000 atomic USDC) to an existing watch. Body: { watchId, watchToken }. Returns the post-top-up credit block.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_PRICE'
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup-1',
		description: 'Add $1.00 of credit (1_000_000 atomic USDC) to an existing watch. Same body/response shape as /v1/private/topup.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_1_PRICE'
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup-5',
		description: 'Add $5.00 of credit (5_000_000 atomic USDC) to an existing watch. Best value tier for high-volume receivers. Same body/response shape as /v1/private/topup.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_5_PRICE'
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/historical',
		description: 'One-off historical scan of a Zcash UFVK or Monero address+viewKey. Returns spendable + spent note totals and (optional) per-note breakdown. The view key streams to NFPT in-memory only — nothing is persisted to our DB. Body: { chain, address, viewKey, birthdayHeight?, toHeight?, includeNotes? }.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_HISTORICAL_PRICE'
	}),
	// POST /v1/private/derive-viewkey is intentionally FREE — it's
	// rate-limited per-IP at the handler level. Excluded from
	// GATEWAY_PREMIUM_ROUTES so x402 doesn't try to gate it.

	// === Privacy-chain atomic facts (Monero/Zcash) ===
	qFact('/v1/q/xmr/height',     'Single-fact: current Monero chain height + sync status. Sourced from a live operator-run monerod node.'),
	qFact('/v1/q/xmr/mempool',    'Single-fact: number of pending transactions in the Monero mempool right now.'),
	qFact('/v1/q/xmr/fee',        'Single-fact: recommended Monero per-byte fee in piconero (also exposed per-kB for convenience).'),
	qFact('/v1/q/xmr/last-block', 'Single-fact: timestamp + age of the most recent Monero block, plus hash, difficulty, and size.'),
	qFact('/v1/q/zec/height',     'Single-fact: current Zcash chain height + verification progress + best block hash. Sourced from a live operator-run zebra node.'),
	qFact('/v1/q/zec/mempool',    'Single-fact: Zcash mempool count + bytes.'),
	qFact('/v1/q/zec/last-block', 'Single-fact: timestamp + age of the most recent Zcash block, plus hash, difficulty, and size.')
]);

export default GATEWAY_PREMIUM_ROUTES;
