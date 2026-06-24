// Paid unlock ("paid private file") — pure helpers.
//
// The winbit32-native answer to "pay to unlock a secret". A seller seals a
// small SECRET (a file decryption key + locator, a licence key, a download
// link, an access code…) behind a price; a buyer pays — NON-CUSTODIALLY —
// and we hand the secret over. Two payment rails, both reusing rails the
// gateway already runs:
//
//   • native ZEC/XMR  — create an order, get a one-quote (pay-to address,
//     exact coin amount, Zcash memo / Monero amount-tag, deadline). The
//     receive-poller detects the payment against a VIEW KEY only (never a
//     spend key) and flips the order to `paid`; the buyer then claims the
//     secret with their claim token. Mirrors the /v1/private/topup-crypto
//     quote rail.
//   • USDC via x402   — an instant variable-price buy (priced per listing),
//     settled in one hop like the notice-board boost; the secret comes back
//     in the 200.
//
// TRUST MODEL (be honest — see docs/PAID_UNLOCK.md):
//   • Payment is non-custodial: coin goes straight to the receiving wallet;
//     we only ever hold a view key to DETECT it.
//   • The file PLAINTEXT never touches us: the seller encrypts it in the
//     browser (WebCrypto) and hosts only the ciphertext; the sealed secret
//     is just the key + locator.
//   • The secret is sealed AT REST with the gateway master key (AES-256-GCM,
//     the same primitive used for view keys). The running process can open
//     it to deliver on payment, so we are NOT blind to the secret at release
//     time. Platform-blind delivery (key + file browser-to-browser over the
//     Nym mixnet) is the planned phase-2 — it is NOT claimed here.
//
// Pure helpers (validators, seal/open, quote/projection builders) are
// exported so the unit tests need neither Fastify nor a live RPC.

import { randomBytes } from 'node:crypto';

import { encryptViewKey, decryptViewKey } from 'viewkey-watch/private-watch-crypto';
import { usdCentsToCoinAtomic, formatCoinAmount } from 'viewkey-watch/crypto-price';

import { withMoneroTag, generateMemo, formatUsdCents } from './private-watch-crypto-topup.js';

// USDC has 6 decimals, so $0.01 = 10_000 atomic units.
const USDC_ATOMIC_PER_CENT = 10_000n;

export const UNLOCK_CONSTANTS = Object.freeze({
	TITLE_MIN: 3,
	TITLE_MAX: 120,
	DESC_MAX: 1_000,
	// The sealed secret is a KEY + locator, never the file itself. 8 KiB is
	// plenty for a JWK + URL + filename and keeps the DB row small.
	SECRET_MAX_BYTES: 8 * 1024,
	// Price band for a single listing (US cents). The floor keeps native
	// coin amounts comfortably above dust; the ceiling is a guard rail.
	PRICE_MIN_USD_CENTS: 50,
	PRICE_MAX_USD_CENTS: 100_000,
	// How many times one PAID order may reveal the secret (a re-download
	// allowance for flaky transfers), and the hard cap an operator allows.
	CLAIM_MAX_PER_ORDER_DEFAULT: 3,
	CLAIM_MAX_PER_ORDER_CAP: 20,
	// Optional limited-edition cap on a listing (null ⇒ sell to anyone).
	MAX_ORDERS_CAP: 100_000,
	// How long a buyer has to pay a native-coin order before it expires.
	ORDER_TTL_SEC_DEFAULT: 1_800,
	ORDER_TTL_SEC_CAP: 86_400,
	// Listing lifetime.
	LISTING_TTL_SEC_DEFAULT: 30 * 86_400,
	LISTING_TTL_SEC_CAP: 365 * 86_400,
	NATIVE_CHAINS: Object.freeze(['zcash', 'monero']),
	// Discovery: a listing is link-only by default ('unlisted'); a seller can
	// opt into the public shop feed ('public'). Nothing about a listing is
	// secret either way — discovery just controls whether it's *advertised*.
	VISIBILITIES: Object.freeze(['public', 'unlisted']),
	VISIBILITY_DEFAULT: 'unlisted',
	DISCOVERY_LIMIT_DEFAULT: 24,
	DISCOVERY_LIMIT_MAX: 100
});

const ID_RE = /^[0-9a-zA-Z_-]{8,64}$/u;

/** A URL-safe random id (listings, orders). */
export function genUnlockId(prefix = 'ul') {
	return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** A buyer-facing claim token (bearer credential for an order). */
export function genClaimToken() {
	return randomBytes(24).toString('base64url');
}

/** $0.01 → 10_000 atomic USDC. Returns a BigInt. */
export function usdCentsToUsdcAtomic(cents) {
	return BigInt(cents) * USDC_ATOMIC_PER_CENT;
}

function asTrimmedString(value, field) {
	if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
	return value.trim();
}

function intInRange(value, { field, min, max, fallback }) {
	if (value === undefined || value === null || value === '') {
		if (fallback !== undefined) return fallback;
		throw new TypeError(`${field} is required`);
	}
	let n;
	if (typeof value === 'number' && Number.isInteger(value)) n = value;
	else if (typeof value === 'string' && /^\d+$/u.test(value)) n = Number.parseInt(value, 10);
	else throw new TypeError(`${field} must be an integer`);
	if (n < min || n > max) throw new TypeError(`${field} out of range: ${min}–${max}`);
	return n;
}

/**
 * Validate + normalise a listing-create request body. Throws TypeError on
 * bad input. `enabledNativeChains` is the set the operator actually accepts
 * (receiving address configured); requested chains are intersected with it.
 */
export function validateListingRequest(body, { enabledNativeChains = [] } = {}) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}

	const title = asTrimmedString(body.title, 'title');
	if (title.length < UNLOCK_CONSTANTS.TITLE_MIN || title.length > UNLOCK_CONSTANTS.TITLE_MAX) {
		throw new TypeError(`title must be ${UNLOCK_CONSTANTS.TITLE_MIN}–${UNLOCK_CONSTANTS.TITLE_MAX} characters`);
	}

	let description = '';
	if (body.description !== undefined && body.description !== null) {
		description = asTrimmedString(body.description, 'description');
		if (description.length > UNLOCK_CONSTANTS.DESC_MAX) {
			throw new TypeError(`description must be ≤ ${UNLOCK_CONSTANTS.DESC_MAX} characters`);
		}
	}

	const secret = typeof body.secret === 'string' ? body.secret : null;
	if (!secret || secret.length === 0) throw new TypeError('secret is required (the key/locator to reveal on payment)');
	if (Buffer.byteLength(secret, 'utf8') > UNLOCK_CONSTANTS.SECRET_MAX_BYTES) {
		throw new TypeError(`secret must be ≤ ${UNLOCK_CONSTANTS.SECRET_MAX_BYTES} bytes (it is a KEY + locator, not the file — host the ciphertext yourself)`);
	}

	const priceUsdCents = intInRange(body.priceUsdCents, {
		field: 'priceUsdCents',
		min: UNLOCK_CONSTANTS.PRICE_MIN_USD_CENTS,
		max: UNLOCK_CONSTANTS.PRICE_MAX_USD_CENTS
	});

	// payChains: requested native coins, intersected with what's enabled.
	let payChains;
	if (body.payChains === undefined || body.payChains === null) {
		payChains = [...enabledNativeChains];
	} else {
		if (!Array.isArray(body.payChains)) throw new TypeError('payChains must be an array');
		for (const c of body.payChains) {
			if (!UNLOCK_CONSTANTS.NATIVE_CHAINS.includes(c)) {
				throw new TypeError(`payChains entries must be one of ${UNLOCK_CONSTANTS.NATIVE_CHAINS.join(', ')}`);
			}
		}
		payChains = UNLOCK_CONSTANTS.NATIVE_CHAINS.filter(
			(c) => body.payChains.includes(c) && enabledNativeChains.includes(c)
		);
	}

	const claimMax = intInRange(body.claimMax, {
		field: 'claimMax',
		min: 1,
		max: UNLOCK_CONSTANTS.CLAIM_MAX_PER_ORDER_CAP,
		fallback: UNLOCK_CONSTANTS.CLAIM_MAX_PER_ORDER_DEFAULT
	});

	let maxOrders = null;
	if (body.maxOrders !== undefined && body.maxOrders !== null) {
		maxOrders = intInRange(body.maxOrders, { field: 'maxOrders', min: 1, max: UNLOCK_CONSTANTS.MAX_ORDERS_CAP });
	}

	const ttlSec = intInRange(body.expiresInSec, {
		field: 'expiresInSec',
		min: 60,
		max: UNLOCK_CONSTANTS.LISTING_TTL_SEC_CAP,
		fallback: UNLOCK_CONSTANTS.LISTING_TTL_SEC_DEFAULT
	});

	// Discovery opt-in: default link-only so a seller is never advertised
	// without asking. 'public' lists it in the shop feed (still never the secret).
	let visibility = UNLOCK_CONSTANTS.VISIBILITY_DEFAULT;
	if (body.visibility !== undefined && body.visibility !== null && body.visibility !== '') {
		const v = asTrimmedString(body.visibility, 'visibility').toLowerCase();
		if (!UNLOCK_CONSTANTS.VISIBILITIES.includes(v)) {
			throw new TypeError(`visibility must be one of ${UNLOCK_CONSTANTS.VISIBILITIES.join(', ')}`);
		}
		visibility = v;
	}

	return Object.freeze({ title, description, secret, priceUsdCents, payChains, claimMax, maxOrders, ttlSec, visibility });
}

/** Seal the secret for at-rest storage with the gateway master key. */
export function sealSecret(secret, masterKey) {
	if (!masterKey) throw new Error('sealSecret: master key is required');
	return encryptViewKey(secret, masterKey);
}

/** Open a sealed secret. Throws if the ciphertext/key don't match. */
export function openSecret(ciphertext, masterKey) {
	if (!masterKey) throw new Error('openSecret: master key is required');
	return decryptViewKey(ciphertext, masterKey);
}

/**
 * Build a native-coin payment quote for an order (mirrors the topup-crypto
 * route). Returns the exact atomic amount to send plus the Zcash memo
 * (Monero carries a low-digit amount-tag instead). `isAmountTaken` lets the
 * caller reject a Monero amount that collides with another open order.
 */
export function buildNativeQuote({ chain, priceUsdCents, usdPerCoin, spreadBps, memoPrefix, isAmountTaken = () => false }) {
	if (!UNLOCK_CONSTANTS.NATIVE_CHAINS.includes(chain)) {
		throw new TypeError(`chain must be one of ${UNLOCK_CONSTANTS.NATIVE_CHAINS.join(', ')}`);
	}
	let expectedAtomic = usdCentsToCoinAtomic(priceUsdCents, usdPerCoin, chain, spreadBps);
	let memo = null;
	if (chain === 'monero') {
		let allocated = false;
		for (let i = 0; i < 8; i += 1) {
			const candidate = withMoneroTag(expectedAtomic);
			if (!isAmountTaken('monero', candidate)) { expectedAtomic = candidate; allocated = true; break; }
		}
		if (!allocated) throw new Error('could not allocate a unique Monero amount; please retry');
	} else {
		memo = generateMemo(memoPrefix);
	}
	return {
		expectedAtomic,
		memo,
		display: formatCoinAmount(BigInt(expectedAtomic), chain),
		coin: chain === 'monero' ? 'XMR' : 'ZEC'
	};
}

/** Public (no-secret) projection of a listing row for the buyer-facing view. */
export function publicListing(row, { nativeChains = [], x402Enabled = false } = {}) {
	const sold = row.max_orders != null && row.orders_count >= row.max_orders;
	return {
		id: row.id,
		title: row.title,
		description: row.description ?? '',
		price: { usd: formatUsdCents(row.price_usd_cents), usdCents: row.price_usd_cents },
		status: row.status,
		visibility: row.visibility ?? UNLOCK_CONSTANTS.VISIBILITY_DEFAULT,
		sold_out: sold,
		pay: {
			native_chains: (row.pay_chains ? row.pay_chains.split(',') : []).filter((c) => nativeChains.includes(c)),
			usdc_x402: x402Enabled
		},
		claim_max_per_order: row.claim_max,
		max_orders: row.max_orders ?? null,
		orders_count: row.orders_count,
		created_at: new Date(row.created_ms).toISOString(),
		expires_at: new Date(row.expires_ms).toISOString(),
		endpoints: {
			order: `POST /v1/unlock/listing/${row.id}/order { chain }`,
			buy_usdc: x402Enabled ? `POST /v1/unlock/listing/${row.id}/buy (x402, ${formatUsdCents(row.price_usd_cents)})` : null
		}
	};
}

/** Public projection of an order row. `revealSecret` is only ever non-null
 * on a successful claim. */
export function publicOrder(row, { confirmationsRequired = null, secret = null } = {}) {
	const out = {
		orderId: row.id,
		listingId: row.listing_id,
		status: row.status,
		chain: row.chain,
		payTo: row.recv_address,
		memo: row.memo ?? null,
		amount: row.expected_atomic != null
			? {
				coin: row.chain === 'monero' ? 'XMR' : 'ZEC',
				atomic: String(row.expected_atomic),
				display: formatCoinAmount(BigInt(row.expected_atomic), row.chain)
			}
			: null,
		confirmations: confirmationsRequired != null ? { required: confirmationsRequired } : undefined,
		claims_used: row.claims_used,
		claims_max: row.claims_max,
		paid_tx: row.paid_txid ?? null,
		createdAt: new Date(row.created_ms).toISOString(),
		expiresAt: new Date(row.expires_ms).toISOString()
	};
	if (secret != null) out.secret = secret;
	return out;
}

/** Human pay instructions for a native order. */
export function buildOrderInstructions(row, confirmationsRequired) {
	const display = formatCoinAmount(BigInt(row.expected_atomic), row.chain);
	if (row.chain === 'monero') {
		return `Send EXACTLY ${display} XMR to ${row.recv_address} before the order expires — the amount's final digits are your invoice tag, so send the exact amount or we can't match it. Then poll the order; the secret unlocks after ${confirmationsRequired} confirmations.`;
	}
	return `Send ${display} ZEC to ${row.recv_address} and include the memo "${row.memo}" before the order expires. Then poll the order; the secret unlocks after ${confirmationsRequired} confirmations.`;
}
