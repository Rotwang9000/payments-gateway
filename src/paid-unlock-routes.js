// Paid unlock — Fastify routes.
//
// Surface:
//   POST   /v1/unlock/listing                 create a sealed listing (free, rate-limited)
//   GET    /v1/unlock/listing/:id             public listing view, NO secret (free)
//   DELETE /v1/unlock/listing/:id             withdraw (owner token)
//   POST   /v1/unlock/listing/:id/order       native-coin order → pay quote + claim token (free)
//   POST   /v1/unlock/listing/:id/buy         instant USDC buy → secret (x402, per-listing price)
//   GET    /v1/unlock/order/:orderId          order status (claim token)
//   POST   /v1/unlock/order/:orderId/claim    reveal the secret once paid (claim token)
//
// The native rail reuses the topup-crypto quote machinery (price oracle,
// memo / amount-tag); the receive-poller flips the order to `paid` on a
// view-key match and the buyer pulls the secret. The USDC rail reuses the
// notice-board boost's variable-price x402 settle dance. The secret is sealed
// at rest and only opened in-process at delivery.

import {
	UNLOCK_CONSTANTS,
	validateListingRequest,
	sealSecret,
	openSecret,
	buildNativeQuote,
	publicListing,
	publicOrder,
	buildOrderInstructions,
	usdCentsToUsdcAtomic
} from './paid-unlock.js';
import {
	createListing,
	getListing,
	isListingOpen,
	withdrawListing,
	listPublicListings,
	createOrder,
	getOrder,
	getOrderAuthorised,
	markOrderPaid,
	claimOrder,
	hasOpenOrderWithAmount,
	expireStaleOrders,
	statsSnapshot,
	pruneOld
} from './paid-unlock-store.js';
import {
	buildCustomPaymentRequirements,
	encodeChallenge,
	decodePaymentHeader
} from './private-watch-custom.js';
import { createFacilitatorClient } from './x402.js';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

async function defaultFacilitatorFactory(x402Cfg) {
	return createFacilitatorClient(x402Cfg);
}

/**
 * Mount the paid-unlock routes on `app`.
 *
 * deps:
 *   - unlockDb            open paid-unlock SQLite (null → routes 503)
 *   - masterKey           gateway master key for seal/open (null → 503)
 *   - x402Cfg             paywall config (buy needs enabled:true)
 *   - priceOracle         createPriceOracle() instance (native orders)
 *   - recvAddresses       { zcash, monero } receiving addresses
 *   - policy              { spreadBps, confirmations:{zcash,monero}, orderTtlSec }
 *   - memoPrefix          Zcash memo attribution prefix
 *   - facilitatorFactory  test override
 *   - freeCreateRateMax / freeCreateRateWindow   listing-create throttle
 *   - log / now           injectables
 *
 * Returns { unlockDb, buildUnlockStats }.
 */
export function registerPaidUnlockRoutes(app, deps = {}) {
	const {
		unlockDb = null,
		masterKey = null,
		x402Cfg = null,
		priceOracle = null,
		recvAddresses = {},
		policy = {},
		memoPrefix,
		facilitatorFactory = defaultFacilitatorFactory,
		freeCreateRateMax = 12,
		freeCreateRateWindow = '1 hour',
		log = NOOP_LOG,
		now = () => Date.now()
	} = deps;

	const spreadBps = policy.spreadBps ?? 400;
	const confirmations = policy.confirmations ?? { zcash: 8, monero: 10 };
	const orderTtlSec = policy.orderTtlSec ?? UNLOCK_CONSTANTS.ORDER_TTL_SEC_DEFAULT;

	const unlockReady = () => Boolean(unlockDb && masterKey);

	function unlockNotConfigured(reply) {
		reply.code(503).send({
			error: {
				code: 'paid_unlock_not_configured',
				message: 'Paid unlock requires PRIVATE_WATCH_ENCRYPTION_KEY (to seal secrets) and a writable paid-unlock DB.'
			}
		});
		return reply;
	}

	function enabledNativeChains() {
		return UNLOCK_CONSTANTS.NATIVE_CHAINS.filter(
			(c) => typeof recvAddresses[c] === 'string' && recvAddresses[c].length > 0
		);
	}

	let facilitatorP = null;
	function getFacilitator() {
		if (!x402Cfg?.enabled) throw new Error('x402 paywall disabled; cannot dispatch to facilitator');
		if (!facilitatorP) facilitatorP = Promise.resolve(facilitatorFactory(x402Cfg));
		return facilitatorP;
	}

	// ── POST /v1/unlock/listing — create (free, rate-limited) ─────
	app.post('/v1/unlock/listing', {
		config: { rateLimit: { max: freeCreateRateMax, timeWindow: freeCreateRateWindow } }
	}, async (req, reply) => {
		if (!unlockReady()) return unlockNotConfigured(reply);
		let input;
		try {
			input = validateListingRequest(req.body ?? {}, { enabledNativeChains: enabledNativeChains() });
		} catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		if (input.payChains.length === 0 && !x402Cfg?.enabled) {
			return reply.code(503).send({
				error: {
					code: 'no_payment_rail',
					message: 'No payment rail available: enable x402 (USDC) and/or configure a ZEC/XMR receiving address before listing.'
				}
			});
		}
		const nowMs = now();
		try { pruneOld(unlockDb, { nowMs }); }
		catch (err) { log.warn?.({ err: err?.message ?? String(err) }, 'paid-unlock: prune failed'); }
		const secretCt = sealSecret(input.secret, masterKey);
		const created = createListing(unlockDb, {
			title: input.title,
			description: input.description,
			priceUsdCents: input.priceUsdCents,
			payChains: input.payChains,
			secretCt,
			claimMax: input.claimMax,
			maxOrders: input.maxOrders,
			ttlSec: input.ttlSec,
			visibility: input.visibility,
			nowMs
		});
		log.info?.({ id: created.id, priceUsdCents: input.priceUsdCents, payChains: input.payChains, visibility: input.visibility }, 'paid-unlock: listing created');
		const row = getListing(unlockDb, created.id);
		return reply.code(201).send({
			...publicListing(row, { nativeChains: enabledNativeChains(), x402Enabled: Boolean(x402Cfg?.enabled) }),
			ownerToken: created.ownerToken,
			manageWith: 'DELETE /v1/unlock/listing/{id} with header x-unlock-token: <ownerToken>',
			note: 'Share the listing id. Buyers pay in ZEC/XMR (POST .../order) or instantly in USDC (POST .../buy). The secret is sealed at rest and only revealed after payment confirms. Keep the ownerToken to withdraw it.'
		});
	});

	// ── GET /v1/unlock/listings — public shop feed (opt-in, no secret) ──
	app.get('/v1/unlock/listings', async (req, reply) => {
		if (!unlockDb) return unlockNotConfigured(reply);
		const clampInt = (v, fallback, min, max) => {
			if (v === undefined || v === null || v === '') return fallback;
			const n = Number.parseInt(v, 10);
			if (!Number.isFinite(n)) return fallback;
			return Math.min(max, Math.max(min, n));
		};
		const limit = clampInt(req.query?.limit, UNLOCK_CONSTANTS.DISCOVERY_LIMIT_DEFAULT, 1, UNLOCK_CONSTANTS.DISCOVERY_LIMIT_MAX);
		const offset = clampInt(req.query?.offset, 0, 0, 1_000_000);
		const rows = listPublicListings(unlockDb, { limit, offset, nowMs: now() });
		const nativeChains = enabledNativeChains();
		const x402Enabled = Boolean(x402Cfg?.enabled);
		return {
			listings: rows.map((r) => publicListing(r, { nativeChains, x402Enabled })),
			paging: { limit, offset, count: rows.length },
			note: 'Public shop feed — opt-in listings only (created with visibility:"public"). Everything else is link-only. Never contains the secret.'
		};
	});

	// ── GET /v1/unlock/listing/:id — public view (no secret) ──────
	app.get('/v1/unlock/listing/:id', async (req, reply) => {
		if (!unlockDb) return unlockNotConfigured(reply);
		const row = getListing(unlockDb, req.params.id);
		if (!row || row.status !== 'live') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'listing not found' } });
		}
		if (!isListingOpen(row, now())) {
			return reply.code(410).send({ error: { code: 'expired', message: 'listing has expired' } });
		}
		return publicListing(row, { nativeChains: enabledNativeChains(), x402Enabled: Boolean(x402Cfg?.enabled) });
	});

	// ── DELETE /v1/unlock/listing/:id — withdraw (owner) ──────────
	app.delete('/v1/unlock/listing/:id', async (req, reply) => {
		if (!unlockDb) return unlockNotConfigured(reply);
		const token = req.headers['x-unlock-token'] ?? (req.body ?? {}).ownerToken;
		const res = withdrawListing(unlockDb, req.params.id, token);
		if (!res.ok) {
			const code = res.reason === 'forbidden' ? 403 : 404;
			return reply.code(code).send({ error: { code: res.reason } });
		}
		return { withdrawn: true };
	});

	// ── POST /v1/unlock/listing/:id/order — native-coin quote ─────
	app.post('/v1/unlock/listing/:id/order', async (req, reply) => {
		if (!unlockReady()) return unlockNotConfigured(reply);
		if (!priceOracle) {
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'native-coin orders require a price oracle' } });
		}
		const nowMs = now();
		try { expireStaleOrders(unlockDb, nowMs); }
		catch (err) { log.warn?.({ err: err?.message ?? String(err) }, 'paid-unlock: expire failed'); }

		const row = getListing(unlockDb, req.params.id);
		if (!row || row.status !== 'live') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'listing not found' } });
		}
		if (!isListingOpen(row, nowMs)) {
			return reply.code(410).send({ error: { code: 'expired', message: 'listing has expired' } });
		}
		const chain = (req.body ?? {}).chain;
		if (!UNLOCK_CONSTANTS.NATIVE_CHAINS.includes(chain)) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: `chain must be one of ${UNLOCK_CONSTANTS.NATIVE_CHAINS.join(', ')} (for USDC use POST .../buy)` } });
		}
		const listingChains = row.pay_chains ? row.pay_chains.split(',') : [];
		if (!listingChains.includes(chain) || !enabledNativeChains().includes(chain)) {
			return reply.code(503).send({
				error: { code: 'chain_not_accepted', message: `${chain.toUpperCase()} is not accepted for this listing here. Accepted: ${listingChains.filter((c) => enabledNativeChains().includes(c)).join(', ') || '(none — use USDC /buy)'}.` }
			});
		}

		let price;
		try { price = await priceOracle.getUsdPrice(chain); }
		catch (err) {
			log.warn?.({ err: err?.message ?? String(err), chain }, 'paid-unlock: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		let quote;
		try {
			quote = buildNativeQuote({
				chain,
				priceUsdCents: row.price_usd_cents,
				usdPerCoin: price.usd,
				spreadBps,
				memoPrefix,
				isAmountTaken: (c, atomic) => hasOpenOrderWithAmount(unlockDb, c, atomic)
			});
		} catch (err) {
			return reply.code(503).send({ error: { code: 'quote_failed', message: err?.message ?? String(err) } });
		}

		const created = createOrder(unlockDb, {
			listingId: row.id,
			chain,
			recvAddress: recvAddresses[chain],
			memo: quote.memo,
			expectedAtomic: quote.expectedAtomic,
			claimsMax: row.claim_max,
			ttlSec: orderTtlSec,
			nowMs
		});
		if (!created.ok) {
			const code = created.reason === 'sold_out' ? 409 : created.reason === 'listing_unavailable' ? 410 : 400;
			return reply.code(code).send({ error: { code: created.reason } });
		}
		log.info?.({ orderId: created.id, listingId: row.id, chain }, 'paid-unlock: order created');
		const confs = confirmations[chain];
		return reply.code(201).send({
			...publicOrder(created.row, { confirmationsRequired: confs }),
			claimToken: created.claimToken,
			instructions: buildOrderInstructions(created.row, confs),
			statusEndpoint: `GET /v1/unlock/order/${created.id} (header x-claim-token)`,
			claimEndpoint: `POST /v1/unlock/order/${created.id}/claim (header x-claim-token)`,
			note: 'Pay the exact amount, then poll the status endpoint. Once status=paid, claim the secret. We detect the payment with a VIEW KEY only — funds go straight to the seller, never through us.'
		});
	});

	// ── GET /v1/unlock/order/:orderId — status (claim token) ──────
	app.get('/v1/unlock/order/:orderId', async (req, reply) => {
		if (!unlockDb) return unlockNotConfigured(reply);
		try { expireStaleOrders(unlockDb, now()); } catch { /* best effort */ }
		const token = req.headers['x-claim-token'] ?? (req.query?.claimToken ?? '');
		const got = getOrderAuthorised(unlockDb, req.params.orderId, token);
		if (got?.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'order not found' } });
		if (got?.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'claim token mismatch (pass it via the x-claim-token header)' } });
		const confs = got.chain === 'usdc' ? null : confirmations[got.chain];
		return publicOrder(got, { confirmationsRequired: confs });
	});

	// ── POST /v1/unlock/order/:orderId/claim — reveal secret ──────
	app.post('/v1/unlock/order/:orderId/claim', async (req, reply) => {
		if (!unlockReady()) return unlockNotConfigured(reply);
		const token = req.headers['x-claim-token'] ?? (req.body ?? {}).claimToken;
		const got = getOrderAuthorised(unlockDb, req.params.orderId, token);
		if (got?.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'order not found' } });
		if (got?.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'claim token mismatch' } });

		const claimed = claimOrder(unlockDb, req.params.orderId, { nowMs: now() });
		if (!claimed.ok) {
			const map = { unpaid: 402, expired: 410, claim_limit_reached: 409, not_found: 404 };
			const code = map[claimed.reason] ?? 409;
			const message = claimed.reason === 'unpaid'
				? 'order is not paid yet — pay the quote then claim'
				: claimed.reason === 'claim_limit_reached'
					? 'claim limit reached for this order'
					: claimed.reason;
			return reply.code(code).send({ error: { code: claimed.reason, message } });
		}
		const listing = getListing(unlockDb, claimed.row.listing_id);
		let secret;
		try { secret = openSecret(listing.secret_ct, masterKey); }
		catch (err) {
			log.error?.({ err: err?.message ?? String(err), orderId: req.params.orderId }, 'paid-unlock: secret open failed');
			return reply.code(500).send({ error: { code: 'unseal_failed', message: 'could not open the sealed secret; contact the operator' } });
		}
		log.info?.({ orderId: req.params.orderId, claimsUsed: claimed.row.claims_used }, 'paid-unlock: secret claimed');
		return publicOrder(claimed.row, { secret });
	});

	// ── POST /v1/unlock/listing/:id/buy — instant USDC (x402) ─────
	app.post('/v1/unlock/listing/:id/buy', async (req, reply) => {
		if (!unlockReady()) return unlockNotConfigured(reply);
		if (!x402Cfg?.enabled) {
			return reply.code(503).send({ error: { code: 'paywall_not_configured', message: 'USDC buy requires the operator to enable x402 (set X402_RECIPIENT_ADDRESS). Pay in ZEC/XMR via POST .../order instead.' } });
		}
		const nowMs = now();
		const row = getListing(unlockDb, req.params.id);
		if (!row || row.status !== 'live') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'listing not found' } });
		}
		if (!isListingOpen(row, nowMs)) {
			return reply.code(410).send({ error: { code: 'expired', message: 'listing has expired' } });
		}
		if (row.max_orders != null && row.orders_count >= row.max_orders) {
			return reply.code(409).send({ error: { code: 'sold_out', message: 'this listing is sold out' } });
		}

		const amountAtomic = usdCentsToUsdcAtomic(row.price_usd_cents);
		const requirements = buildCustomPaymentRequirements({ x402Cfg, amountAtomic });
		const description = `Unlock "${row.title}" for $${(row.price_usd_cents / 100).toFixed(2)} (${amountAtomic} atomic USDC). The secret is returned in the response on settlement.`;
		const resourceUrl = `${req.protocol}://${req.hostname}/v1/unlock/listing/${row.id}/buy`;
		const challenge = encodeChallenge({ resourceUrl, description, accepts: requirements });

		const xPayment = req.headers['x-payment'];
		if (!xPayment) return reply.code(402).header('payment-required', challenge).send({});
		const payload = decodePaymentHeader(xPayment);
		if (!payload) return reply.code(400).send({ error: { code: 'invalid_payment_header', message: 'x-payment is not valid base64 JSON' } });
		const sentValue = String(payload?.payload?.authorization?.value ?? '');
		if (sentValue !== String(amountAtomic)) {
			return reply.code(400).send({ error: { code: 'amount_mismatch', message: `x-payment value (${sentValue}) does not match the listing price (${amountAtomic})` } });
		}

		let facilitator;
		try { facilitator = await getFacilitator(); }
		catch (err) {
			log.error?.({ err: err?.message ?? String(err) }, 'paid-unlock buy: facilitator init failed');
			return reply.code(503).send({ error: { code: 'facilitator_unavailable', message: 'payment facilitator could not be initialised' } });
		}
		let verifyResult;
		try { verifyResult = await facilitator.verify(payload, requirements); }
		catch (err) {
			log.warn?.({ err: err?.message ?? String(err) }, 'paid-unlock buy: verify threw');
			return reply.code(502).send({ error: { code: 'verify_failed', message: err?.message ?? 'facilitator verify threw' } });
		}
		if (!verifyResult?.isValid) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_verification_failed', message: verifyResult?.invalidReason ?? 'facilitator rejected signature' } });
		}
		let settleResult;
		try { settleResult = await facilitator.settle(payload, requirements); }
		catch (err) {
			log.warn?.({ err: err?.message ?? String(err) }, 'paid-unlock buy: settle threw');
			return reply.code(502).send({ error: { code: 'settle_failed', message: err?.message ?? 'facilitator settle threw' } });
		}
		if (!settleResult?.success) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_settle_failed', message: settleResult?.errorReason ?? 'facilitator settle did not succeed' } });
		}
		reply.header('x-payment-response', Buffer.from(JSON.stringify(settleResult)).toString('base64'));

		// Payment settled. Record a paid order, consume one claim, and return
		// the secret. If anything below fails the buyer has paid — log loudly
		// and hand back the settlement so the operator can reconcile.
		const created = createOrder(unlockDb, {
			listingId: row.id,
			chain: 'usdc',
			claimsMax: row.claim_max,
			ttlSec: UNLOCK_CONSTANTS.LISTING_TTL_SEC_CAP,
			nowMs
		});
		if (!created.ok) {
			log.error?.({ id: row.id, reason: created.reason, settlement: settleResult }, 'paid-unlock buy: captured but order failed');
			return reply.code(409).send({ error: { code: `${created.reason}_after_payment`, message: 'payment captured but the order could not be created — contact the operator', captured: { settlement: settleResult } } });
		}
		markOrderPaid(unlockDb, created.id, { txid: settleResult?.transaction ?? null, seenAtomic: amountAtomic, nowMs });
		const claimed = claimOrder(unlockDb, created.id, { nowMs });
		let secret;
		try { secret = openSecret(row.secret_ct, masterKey); }
		catch (err) {
			log.error?.({ err: err?.message ?? String(err), id: row.id, settlement: settleResult }, 'paid-unlock buy: captured but unseal failed');
			return reply.code(500).send({ error: { code: 'unseal_after_payment', message: 'payment captured but the secret could not be opened — contact the operator', captured: { settlement: settleResult } } });
		}
		log.info?.({ orderId: created.id, listingId: row.id, amountAtomic: String(amountAtomic) }, 'paid-unlock: instant USDC buy delivered');
		return reply.code(200).send({
			...publicOrder(claimed.ok ? claimed.row : getOrder(unlockDb, created.id), { secret }),
			claimToken: created.claimToken,
			note: 'Paid and unlocked. Keep the claimToken to re-fetch the secret (up to the listing\u2019s claim limit) via POST /v1/unlock/order/{orderId}/claim.'
		});
	});

	function buildUnlockStats() {
		if (!unlockDb) return { enabled: false, reason: 'paid-unlock DB not opened' };
		return {
			enabled: unlockReady(),
			native_chains: enabledNativeChains(),
			usdc_x402: Boolean(x402Cfg?.enabled),
			price_band_usd: {
				min: (UNLOCK_CONSTANTS.PRICE_MIN_USD_CENTS / 100).toFixed(2),
				max: (UNLOCK_CONSTANTS.PRICE_MAX_USD_CENTS / 100).toFixed(2)
			},
			stats: statsSnapshot(unlockDb)
		};
	}

	return { unlockDb, buildUnlockStats };
}

export default registerPaidUnlockRoutes;
