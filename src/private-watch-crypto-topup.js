// Privacy-coin (XMR/ZEC) credit top-ups — quote + status endpoints.
//
// Unlike the x402 top-up rails, these are FREE to call: the user is
// about to pay us in Monero or Zcash, not USDC. The flow is:
//
//   POST /v1/private/topup-crypto   { watchId, watchToken, chain, amountUsdCents }
//     -> 201 with a quote: the receiving address, the EXACT coin amount
//        to send (Monero: amount carries a unique invoice tag; Zcash: a
//        memo token), the locked rate, and the pay-by deadline.
//   GET  /v1/private/topup-crypto/:quoteId   (x-watch-token header)
//     -> the live quote status (pending -> confirming -> settled).
//
// The receive-poller (viewkey-watch/crypto-recv-poller, a separate
// process) detects the payment against our own view-key scan and credits
// the watch. This module never sees the receiving wallet's view key — it
// only knows the public receiving address to show the payer.
//
// Pure helpers are exported so the validators + formatting are unit
// tested without Fastify.

import { randomUUID, randomBytes } from 'node:crypto';

import {
	createQuote,
	getQuoteAuthorised,
	hasOpenQuoteWithAmount
} from 'viewkey-watch/crypto-topup-store';
import { getWatch as storeGetWatch } from 'viewkey-watch/private-watch-store';
import { usdCentsToCoinAtomic, formatCoinAmount } from 'viewkey-watch/crypto-price';

const UUID_RE = /^[0-9a-fA-F-]{36}$/u;
const SUPPORTED_CHAINS = Object.freeze(['monero', 'zcash', 'dash']);

/** Display ticker per payment chain (dash = shielded DASH on Evolution). */
const COIN_TICKER = Object.freeze({ monero: 'XMR', zcash: 'ZEC', dash: 'DASH' });

// Default attribution prefix for Zcash memos. Brand-neutral; a host can
// override per-deployment via the `memoPrefix` dep (e.g. Seneschal passes
// 'SNS'). Cosmetic only — payments are matched by the memo stored on the
// quote row, not by the prefix.
const DEFAULT_MEMO_PREFIX = 'PG';

// Monero invoice tagging: round the required amount up to a 1e6-piconero
// (1e-6 XMR) boundary then add a random tag in the low digits, so each
// open quote has a unique amount we can match an incoming tx against.
// The added value is ≤ ~2e-6 XMR — financially negligible.
const MONERO_TAG_SLOT = 1_000_000n;

/** Parse + validate the quote request body. Throws TypeError on bad input. */
export function validateCryptoTopupRequest(body, { minUsdCents, maxUsdCents }) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}
	if (typeof body.watchId !== 'string' || !UUID_RE.test(body.watchId)) {
		throw new TypeError('watchId must be a UUID');
	}
	if (typeof body.watchToken !== 'string' || body.watchToken.length < 8) {
		throw new TypeError('watchToken must be a non-empty string');
	}
	if (!SUPPORTED_CHAINS.includes(body.chain)) {
		throw new TypeError(`chain must be one of ${SUPPORTED_CHAINS.join(', ')}`);
	}
	const raw = body.amountUsdCents;
	let cents;
	if (typeof raw === 'number' && Number.isInteger(raw)) cents = raw;
	else if (typeof raw === 'string' && /^\d+$/u.test(raw)) cents = Number.parseInt(raw, 10);
	else throw new TypeError('amountUsdCents must be a positive integer (US cents)');
	if (cents < minUsdCents || cents > maxUsdCents) {
		throw new TypeError(`amountUsdCents out of range: ${minUsdCents}–${maxUsdCents} (i.e. $${(minUsdCents / 100).toFixed(2)}–$${(maxUsdCents / 100).toFixed(2)})`);
	}
	return Object.freeze({ watchId: body.watchId, watchToken: body.watchToken, chain: body.chain, amountUsdCents: cents });
}

/** Add a unique low-digit invoice tag to a Monero amount (BigInt piconero). */
export function withMoneroTag(atomic) {
	const aligned = atomic + ((MONERO_TAG_SLOT - (atomic % MONERO_TAG_SLOT)) % MONERO_TAG_SLOT);
	const tag = BigInt(1 + Math.floor(Math.random() * (Number(MONERO_TAG_SLOT) - 1)));
	return aligned + tag;
}

/** A short Zcash attribution memo, e.g. "PG-1a2b3c4d". */
export function generateMemo(prefix = DEFAULT_MEMO_PREFIX) {
	return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/**
 * Allocate the payable amount + memo for a new quote: Monero gets a
 * unique invoice-tagged amount (collision-checked against open quotes),
 * Zcash gets an attribution memo. Returns { expectedAtomic, memo }.
 * Throws Error('quote_collision') if a unique Monero amount could not
 * be found — the caller maps that to a 503.
 */
export function allocateQuoteAmount(watchDb, { chain, amountUsdCents, priceUsd, spreadBps, memoPrefix = DEFAULT_MEMO_PREFIX }) {
	let expectedAtomic = usdCentsToCoinAtomic(amountUsdCents, priceUsd, chain, spreadBps);
	if (chain !== 'monero') {
		return { expectedAtomic, memo: generateMemo(memoPrefix) };
	}
	for (let i = 0; i < 8; i += 1) {
		const candidate = withMoneroTag(expectedAtomic);
		if (!hasOpenQuoteWithAmount(watchDb, 'monero', candidate)) {
			return { expectedAtomic: candidate, memo: null };
		}
	}
	throw new Error('quote_collision');
}

/** "$12.34" from integer US cents. */
export function formatUsdCents(cents) {
	return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** Human pay instructions for a quote row. */
export function buildInstructions(row, confirmationsRequired) {
	const display = formatCoinAmount(BigInt(row.expected_atomic), row.chain);
	const credit = formatUsdCents(row.quoted_usd_cents);
	if (row.chain === 'monero') {
		return `Send EXACTLY ${display} XMR to ${row.recv_address} before the quote expires. The amount's final digits are your invoice tag — send the exact amount or we can't match it. ${credit} of credit lands after ${confirmationsRequired} confirmations.`;
	}
	if (row.chain === 'dash') {
		return `Send ${display} shielded DASH (Dash Evolution Orchard pool) to ${row.recv_address} and include the memo "${row.memo}" before the quote expires. Platform transfers are final in ~1 second — ${credit} of credit lands on the next poll after your payment.`;
	}
	return `Send ${display} ZEC to ${row.recv_address} and include the memo "${row.memo}" before the quote expires. ${credit} of credit lands after ${confirmationsRequired} confirmations.`;
}

/** Public, safe-to-return view of a quote row. */
export function publicQuote(row, { confirmationsRequired }) {
	return {
		quoteId: row.id,
		chain: row.chain,
		status: row.status,
		payTo: row.recv_address,
		memo: row.memo ?? null,
		amount: {
			coin: COIN_TICKER[row.chain] ?? row.chain.toUpperCase(),
			atomic: String(row.expected_atomic),
			display: formatCoinAmount(BigInt(row.expected_atomic), row.chain)
		},
		credit: { usd: formatUsdCents(row.quoted_usd_cents), usdCents: row.quoted_usd_cents },
		rate: { usdPerCoin: row.usd_price_milli / 1000, spreadBps: row.spread_bps },
		confirmations: { required: confirmationsRequired, seen: row.confirmations ?? 0 },
		seenTxHash: row.seen_tx_hash ?? null,
		creditedUsdCents: row.credited_usd_cents ?? null,
		createdAt: new Date(row.created_at_ms).toISOString(),
		expiresAt: new Date(row.expires_at_ms).toISOString(),
		instructions: buildInstructions(row, confirmationsRequired),
		api_hint: 'Pure HTTP, no key, no x402: POST /v1/private/topup-crypto {watchId, watchToken, chain, amountUsdCents}; poll GET /v1/private/topup-crypto/{quoteId} with header x-watch-token. You pay in coin — we detect it with the same view-key scanner the product sells.'
	};
}

/**
 * Install the crypto top-up routes.
 *
 * deps:
 *   - watchDb              shared SQLite handle (watches + quotes)
 *   - priceOracle          createPriceOracle() instance
 *   - recvAddresses        { monero: <addr|''>, zcash: <addr|''> }
 *   - policy               { minUsdCents, maxUsdCents, spreadBps,
 *                            quoteTtlSec, confirmations: {monero,zcash} }
 *   - memoPrefix           optional Zcash memo attribution prefix
 *   - privateWatchReady()  gate helper from the plugin
 *   - privateNotConfigured(reply) gate helper from the plugin
 *   - now()                clock (testable; defaults to Date.now)
 *   - log                  optional logger
 */
export function registerCryptoTopupRoutes(app, deps) {
	const {
		watchDb,
		priceOracle,
		recvAddresses = {},
		policy,
		memoPrefix = DEFAULT_MEMO_PREFIX,
		privateWatchReady,
		privateNotConfigured,
		now = () => Date.now(),
		log = { info() {}, warn() {}, error() {} }
	} = deps;

	if (!privateWatchReady || !privateNotConfigured) {
		throw new Error('registerCryptoTopupRoutes: missing gate helpers');
	}
	if (!policy || typeof policy !== 'object') {
		throw new Error('registerCryptoTopupRoutes: policy is required');
	}

	function chainEnabled(chain) {
		return typeof recvAddresses[chain] === 'string' && recvAddresses[chain].length > 0;
	}

	app.post('/v1/private/topup-crypto', async (req, reply) => {
		if (!privateWatchReady() || !watchDb || !priceOracle) return privateNotConfigured(reply);

		let body;
		try { body = validateCryptoTopupRequest(req.body || {}, policy); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		if (!chainEnabled(body.chain)) {
			return reply.code(503).send({
				error: {
					code: 'crypto_topup_not_configured',
					message: `${body.chain.toUpperCase()} top-ups are not enabled on this server yet. USDC via x402 (/v1/private/topup*) is always available.`
				}
			});
		}

		const watch = storeGetWatch(watchDb, body.watchId, body.watchToken);
		if (!watch) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found' } });
		if (watch.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch' } });
		if (watch.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'watch is cancelled' } });

		let price;
		try { price = await priceOracle.getUsdPrice(body.chain); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err), chain: body.chain }, 'crypto-topup: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		let expectedAtomic;
		let memo;
		try {
			({ expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
				chain: body.chain,
				amountUsdCents: body.amountUsdCents,
				priceUsd: price.usd,
				spreadBps: policy.spreadBps,
				memoPrefix
			}));
		} catch (err) {
			if (err?.message === 'quote_collision') {
				return reply.code(503).send({ error: { code: 'quote_collision', message: 'could not allocate a unique invoice amount; please retry' } });
			}
			throw err;
		}

		const nowMs = now();
		const row = createQuote(watchDb, {
			id: randomUUID(),
			watchId: body.watchId,
			watchToken: body.watchToken,
			chain: body.chain,
			recvAddress: recvAddresses[body.chain],
			memo,
			quotedUsdCents: body.amountUsdCents,
			expectedAtomic,
			usdPriceMilli: Math.round(price.usd * 1000),
			spreadBps: policy.spreadBps,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + policy.quoteTtlSec * 1000
		});
		log.info({ quoteId: row.id, chain: body.chain, usdCents: body.amountUsdCents, source: price.source }, 'crypto-topup: quote created');
		return reply.code(201).send(publicQuote(row, { confirmationsRequired: policy.confirmations?.[body.chain] }));
	});

	app.get('/v1/private/topup-crypto/:quoteId', async (req, reply) => {
		if (!privateWatchReady() || !watchDb) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'] || (req.query?.watchToken ?? '');
		const got = getQuoteAuthorised(watchDb, req.params.quoteId, token);
		if (got?.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'quote not found' } });
		if (got?.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch (pass it via the x-watch-token header)' } });
		return publicQuote(got, { confirmationsRequired: policy.confirmations?.[got.chain] });
	});
}
