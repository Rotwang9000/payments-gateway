// Donation overlay — Fastify routes.
//
// Surface (all free to CALL — the product is funded in ZEC through the
// existing memo-token quote rail, not x402):
//
//   GET    /v1/overlay                     free metadata / how-to
//   POST   /v1/overlay                     register: UFVK → overlay + ZEC funding quote (rate-limited)
//   GET    /v1/overlay/:id                 public status (label, address, meter days) — no UFVK
//   GET    /v1/overlay/:id/events          public event feed the OBS page polls (?sinceId=N)
//   POST   /v1/overlay/:id/topup           owner token → fresh ZEC funding quote
//   GET    /v1/overlay/quote/:quoteId      quote status (header x-overlay-token)
//   DELETE /v1/overlay/:id                 owner token → cancel
//
// Registration is deliberately account-free: the overlay id is an
// unguessable capability (it IS the OBS browser-source URL) and the
// owner token is the only management credential. We ask for — and
// keep — as little as possible: the UFVK (encrypted at rest), the
// public receive address, an optional display label.
//
// Funding reuses the crypto_topup_quotes machinery wholesale: the
// quote's watch_id column carries the overlay id and the owner token
// stands in for the watch token. The receive-poller's credit applier
// falls through from the watch store to the overlay store (see
// makeOverlayCreditApplier), so one scan of OUR receiving wallet
// settles watches, checkouts AND overlays.

import { randomUUID } from 'node:crypto';

import { validateChainCredentials, atomicToUsdString } from 'viewkey-watch/private-watch';
import { createQuote, getQuoteAuthorised } from 'viewkey-watch/crypto-topup-store';
import { formatCoinAmount } from 'viewkey-watch/crypto-price';

import { allocateQuoteAmount, formatUsdCents } from './private-watch-crypto-topup.js';
import {
	OVERLAY_CONSTANTS,
	ensureDonationOverlaySchema,
	createOverlay,
	getOverlay,
	getOverlayAuthorised,
	cancelOverlay,
	listEventsSince,
	overlayStatsSnapshot,
	ufvkFingerprint
} from './donation-overlay-store.js';
import { OVERLAY_CONFIRMATIONS_DEFAULT } from './donation-overlay-poller.js';

// Registration spawns scan work upstream — same per-IP throttle as
// /v1/private/watch-crypto.
export const OVERLAY_CREATE_PER_IP_PER_MIN = 3;

const ZATOSHI_PER_ZEC = 100_000_000;

/**
 * Validate a POST /v1/overlay body. Reuses the shared chain-credential
 * validator (UFVK prefix, address prefix, birthday bounds) with the
 * chain pinned to Zcash, then layers the overlay-specific fields.
 * Throws TypeError on bad input.
 */
export function validateOverlayCreateRequest(body, { minUsdCents, maxUsdCents }) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}
	const creds = validateChainCredentials({ ...body, chain: 'zcash', viewKey: body.ufvk ?? body.viewKey });

	let label = null;
	if (body.label !== undefined && body.label !== null && body.label !== '') {
		label = String(body.label).trim().slice(0, OVERLAY_CONSTANTS.LABEL_MAX_LEN);
	}

	let minZatoshi = null;
	if (body.minZec !== undefined && body.minZec !== null && body.minZec !== '') {
		const z = Number(body.minZec);
		if (!Number.isFinite(z) || z < 0 || z > 100) {
			throw new TypeError('minZec must be a number between 0 and 100');
		}
		minZatoshi = String(Math.round(z * ZATOSHI_PER_ZEC));
	}

	const raw = body.amountUsdCents ?? minUsdCents;
	let cents;
	if (typeof raw === 'number' && Number.isInteger(raw)) cents = raw;
	else if (typeof raw === 'string' && /^\d+$/u.test(raw)) cents = Number.parseInt(raw, 10);
	else throw new TypeError('amountUsdCents must be a positive integer (US cents)');
	if (cents < minUsdCents || cents > maxUsdCents) {
		throw new TypeError(`amountUsdCents out of range: ${minUsdCents}–${maxUsdCents}`);
	}

	return Object.freeze({
		address: creds.address,
		ufvk: creds.viewKey,
		birthdayHeight: creds.birthdayHeight,
		label,
		minZatoshi,
		amountUsdCents: cents
	});
}

/** Public, safe-to-return view of an overlay row (no UFVK, no token hash). */
export function publicOverlay(row, { nowMs = Date.now() } = {}) {
	const credit = Number(row.credit_atomic ?? 0);
	const active = row.cancelled !== 1 && credit > 0 && row.expires_at_ms > nowMs;
	return {
		overlayId: row.id,
		chain: row.chain,
		label: row.label ?? null,
		address: row.address,
		minZec: row.min_zatoshi != null ? Number(row.min_zatoshi) / ZATOSHI_PER_ZEC : null,
		state: row.cancelled === 1 ? 'cancelled' : credit <= 0 ? 'out_of_credit' : 'active',
		active,
		credit: {
			remaining_usd: atomicToUsdString(credit),
			days_remaining: Number((credit / OVERLAY_CONSTANTS.DAY_RATE_ATOMIC).toFixed(2)),
			rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.DAY_RATE_ATOMIC)
		},
		created_at: new Date(row.created_at_ms).toISOString(),
		expires_at: new Date(row.expires_at_ms).toISOString()
	};
}

/** Public view of a funding quote row (mirrors topup-crypto's shape, overlay-flavoured). */
export function publicOverlayQuote(row, { confirmationsRequired }) {
	return {
		quoteId: row.id,
		chain: row.chain,
		status: row.status,
		payTo: row.recv_address,
		memo: row.memo ?? null,
		amount: {
			coin: 'ZEC',
			atomic: String(row.expected_atomic),
			display: formatCoinAmount(BigInt(row.expected_atomic), 'zcash')
		},
		credit: { usd: formatUsdCents(row.quoted_usd_cents), usdCents: row.quoted_usd_cents },
		confirmations: { required: confirmationsRequired, seen: row.confirmations ?? 0 },
		createdAt: new Date(row.created_at_ms).toISOString(),
		expiresAt: new Date(row.expires_at_ms).toISOString(),
		instructions: `Send ${formatCoinAmount(BigInt(row.expected_atomic), 'zcash')} ZEC to ${row.recv_address} with the memo "${row.memo}" before the quote expires. ${formatUsdCents(row.quoted_usd_cents)} of overlay credit lands after ${confirmationsRequired} confirmations. Check status: GET /v1/overlay/quote/${row.id} (header x-overlay-token).`
	};
}

/** Public event feed item. */
function publicEvent(row) {
	return {
		id: row.id,
		amountZec: Number(row.amount_atomic) / ZATOSHI_PER_ZEC,
		amountZatoshi: String(row.amount_atomic),
		memo: row.memo ?? null,
		status: row.status,
		confirmations: row.confirmations ?? 0,
		txHash: row.tx_hash ?? null,
		firstSeenAt: new Date(row.first_seen_ms).toISOString()
	};
}

/**
 * Mount the donation-overlay routes on `app`.
 *
 * deps:
 *   - watchDb              shared SQLite handle (overlays + quotes live here)
 *   - priceOracle          createPriceOracle() instance
 *   - recvAddresses        { zcash: <addr|''> } — OUR receiving wallet
 *   - policy               { minUsdCents, maxUsdCents, spreadBps, quoteTtlSec,
 *                            confirmations: { zcash } }
 *   - memoPrefix           Zcash memo attribution prefix
 *   - encryptViewKey(ufvk) closure binding the gateway master key
 *   - nfptHealth()         upstream gate before taking a payment quote
 *   - overlayPageUrlBase   optional public URL of the OBS overlay page
 *   - privateWatchReady()/privateNotConfigured(reply)  plugin gate helpers
 *   - log / now            injectables
 *
 * Returns { buildOverlayStats }.
 */
export function registerDonationOverlayRoutes(app, deps) {
	const {
		watchDb,
		priceOracle,
		recvAddresses = {},
		policy,
		memoPrefix = 'PG',
		encryptViewKey,
		nfptHealth,
		overlayPageUrlBase = '',
		privateWatchReady,
		privateNotConfigured,
		now = () => Date.now(),
		log = { info() {}, warn() {}, error() {} }
	} = deps;

	if (!privateWatchReady || !privateNotConfigured) {
		throw new Error('registerDonationOverlayRoutes: missing gate helpers');
	}
	if (!policy || typeof policy !== 'object') {
		throw new Error('registerDonationOverlayRoutes: policy is required');
	}

	if (watchDb) ensureDonationOverlaySchema(watchDb);

	const zecEnabled = () => typeof recvAddresses.zcash === 'string' && recvAddresses.zcash.length > 0;
	const overlayReady = () => Boolean(privateWatchReady() && watchDb && priceOracle && typeof encryptViewKey === 'function');
	const confirmationsRequired = policy.confirmations?.zcash ?? 8;

	function urlsFor(overlayId) {
		const eventsPath = `/v1/overlay/${overlayId}/events`;
		return {
			events: eventsPath,
			obsPage: overlayPageUrlBase
				? `${overlayPageUrlBase.replace(/\/$/u, '')}?overlay=${overlayId}`
				: null
		};
	}

	// ── GET /v1/overlay — free metadata ───────────────────────────
	app.get('/v1/overlay', async () => {
		const info = {
			service: 'donation overlay',
			spec: 'UFVK-watched Zcash donation alerts for streamers (OBS browser source). No accounts, no custody: your UFVK is read-only and encrypted at rest; donations pay YOUR wallet directly.',
			how_it_works: [
				'1. POST /v1/overlay { ufvk, address, label?, minZec?, birthdayHeight?, amountUsdCents? } — returns your overlayId, ownerToken and a ZEC funding quote (pay us with the memo shown).',
				'2. Add the overlay page (or poll the events feed) as an OBS browser source.',
				'3. Donations to your wallet appear as events: amount + shielded memo, first "seen" (~1 block) then "confirmed".'
			],
			pricing: {
				model: 'prepaid credit meter, funded in ZEC (memo-token quote)',
				rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.DAY_RATE_ATOMIC),
				grace_credit_usd: atomicToUsdString(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC),
				min_usd: policy.minUsdCents / 100,
				max_usd: policy.maxUsdCents / 100
			},
			display_confirmations: OVERLAY_CONFIRMATIONS_DEFAULT,
			privacy: 'we store: your UFVK (AES-256-GCM encrypted), your public receive address, an optional label. Donation events (amount + memo) are pruned after 30 days. No accounts, no email, no IPs.',
			zec_funding_enabled: zecEnabled()
		};
		if (watchDb) info.stats = overlayStatsSnapshot(watchDb);
		return info;
	});

	// ── POST /v1/overlay — register (free, rate-limited) ──────────
	const createRouteOpts = { config: { rateLimit: { max: OVERLAY_CREATE_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/overlay', createRouteOpts, async (req, reply) => {
		if (!overlayReady()) return privateNotConfigured(reply);
		if (!zecEnabled()) {
			return reply.code(503).send({
				error: { code: 'zec_funding_not_configured', message: 'ZEC funding is not enabled on this server (ZEC_RECV_ADDRESS unset).' }
			});
		}

		let input;
		try { input = validateOverlayCreateRequest(req.body ?? {}, policy); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		// Upstream must be healthy before we take a payment quote.
		const health = await nfptHealth();
		if (!health?.ok) {
			return reply.code(502).send({
				error: { code: 'nfpt_upstream_unavailable', message: 'Upstream scanner is not reachable; refusing to create overlay.', nfpt: health }
			});
		}

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'overlay: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		let created;
		try {
			created = createOverlay(watchDb, {
				address: input.address,
				ufvkCiphertext: encryptViewKey(input.ufvk),
				birthdayHeight: input.birthdayHeight,
				label: input.label,
				minZatoshi: input.minZatoshi,
				ufvkFingerprintHex: ufvkFingerprint(input.ufvk),
				nowMs: now()
			});
		} catch (err) {
			if (err?.code === 'wallet_already_has_page') {
				return reply.code(409).send({
					error: {
						code: 'wallet_already_has_page',
						message: err.message,
						existingOverlayId: err.existingOverlayId ?? null
					}
				});
			}
			const msg = String(err?.message ?? '');
			if (msg.includes('UNIQUE constraint failed') && /ufvk_fingerprint|one_live_ufvk|one_live_address|\.address/i.test(msg)) {
				return reply.code(409).send({
					error: {
						code: 'wallet_already_has_page',
						message: 'This wallet already has an active overlay. Cancel it before creating another.'
					}
				});
			}
			throw err;
		}

		// Funding quote: same store as watch top-ups; watch_id carries
		// the overlay id, the owner token stands in for the watch token.
		const { expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
			chain: 'zcash',
			amountUsdCents: input.amountUsdCents,
			priceUsd: price.usd,
			spreadBps: policy.spreadBps,
			memoPrefix
		});
		const nowMs = now();
		const quoteRow = createQuote(watchDb, {
			id: randomUUID(),
			watchId: created.id,
			watchToken: created.ownerToken,
			chain: 'zcash',
			recvAddress: recvAddresses.zcash,
			memo,
			quotedUsdCents: input.amountUsdCents,
			expectedAtomic,
			usdPriceMilli: Math.round(price.usd * 1000),
			spreadBps: policy.spreadBps,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + policy.quoteTtlSec * 1000
		});

		log.info({ overlayId: created.id, usdCents: input.amountUsdCents, quoteId: quoteRow.id }, 'overlay: created awaiting ZEC funding');
		return reply.code(201).send({
			overlayId: created.id,
			ownerToken: created.ownerToken,
			status: 'active_awaiting_payment',
			graceNote: `The overlay is live NOW on $${atomicToUsdString(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC)} of grace credit (~1.5 days). Pay the quote below and ${formatUsdCents(input.amountUsdCents)} of credit lands automatically after ${confirmationsRequired} confirmations.`,
			urls: urlsFor(created.id),
			payment: publicOverlayQuote(quoteRow, { confirmationsRequired }),
			overlay: publicOverlay(getOverlay(watchDb, created.id), { nowMs }),
			note: 'Keep the ownerToken safe — it is shown exactly ONCE and is the only way to top up or cancel. The overlayId is the public capability for the OBS page; anyone holding it can read your donation feed.'
		});
	});

	// ── GET /v1/overlay/:id — public status ───────────────────────
	app.get('/v1/overlay/:id', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		const row = getOverlay(watchDb, req.params.id);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'overlay not found' } });
		return publicOverlay(row, { nowMs: now() });
	});

	// ── GET /v1/overlay/:id/owner — prove owner token (manage UI) ─
	app.get('/v1/overlay/:id/owner', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		const token = req.headers['x-overlay-token'] ?? '';
		const got = getOverlayAuthorised(watchDb, req.params.id, String(token));
		if (got.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'overlay not found' } });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		return { ok: true, overlay: publicOverlay(got, { nowMs: now() }) };
	});

	// ── GET /v1/overlay/:id/events — the OBS feed ─────────────────
	app.get('/v1/overlay/:id/events', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		const row = getOverlay(watchDb, req.params.id);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'overlay not found' } });
		const sinceId = Number(req.query?.sinceId ?? 0) || 0;
		const events = listEventsSince(watchDb, row.id, { sinceId });
		return {
			overlayId: row.id,
			label: row.label ?? null,
			active: row.cancelled !== 1 && Number(row.credit_atomic ?? 0) > 0,
			cursor: events.length > 0 ? events[events.length - 1].id : sinceId,
			pollSeconds: 10,
			events: events.map(publicEvent)
		};
	});

	// ── POST /v1/overlay/:id/topup — fresh funding quote ──────────
	app.post('/v1/overlay/:id/topup', async (req, reply) => {
		if (!overlayReady()) return privateNotConfigured(reply);
		if (!zecEnabled()) {
			return reply.code(503).send({ error: { code: 'zec_funding_not_configured', message: 'ZEC funding is not enabled on this server.' } });
		}
		const token = req.headers['x-overlay-token'] ?? req.body?.ownerToken;
		const got = getOverlayAuthorised(watchDb, req.params.id, typeof token === 'string' ? token : '');
		if (got.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'overlay not found' } });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		if (got.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'overlay is cancelled' } });

		const raw = req.body?.amountUsdCents ?? policy.minUsdCents;
		const cents = typeof raw === 'number' && Number.isInteger(raw)
			? raw
			: (typeof raw === 'string' && /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : NaN);
		if (!Number.isInteger(cents) || cents < policy.minUsdCents || cents > policy.maxUsdCents) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: `amountUsdCents out of range: ${policy.minUsdCents}–${policy.maxUsdCents}` } });
		}

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'overlay-topup: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		const { expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
			chain: 'zcash',
			amountUsdCents: cents,
			priceUsd: price.usd,
			spreadBps: policy.spreadBps,
			memoPrefix
		});
		const nowMs = now();
		const quoteRow = createQuote(watchDb, {
			id: randomUUID(),
			watchId: got.id,
			watchToken: String(token),
			chain: 'zcash',
			recvAddress: recvAddresses.zcash,
			memo,
			quotedUsdCents: cents,
			expectedAtomic,
			usdPriceMilli: Math.round(price.usd * 1000),
			spreadBps: policy.spreadBps,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + policy.quoteTtlSec * 1000
		});
		log.info({ overlayId: got.id, usdCents: cents, quoteId: quoteRow.id }, 'overlay: top-up quote created');
		return reply.code(201).send(publicOverlayQuote(quoteRow, { confirmationsRequired }));
	});

	// ── GET /v1/overlay/quote/:quoteId — funding quote status ─────
	app.get('/v1/overlay/quote/:quoteId', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		const token = req.headers['x-overlay-token'] ?? '';
		const got = getQuoteAuthorised(watchDb, req.params.quoteId, String(token));
		if (got?.error === 'not_found') return reply.code(404).send({ error: { code: 'not_found', message: 'quote not found' } });
		if (got?.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		return publicOverlayQuote(got, { confirmationsRequired });
	});

	// ── DELETE /v1/overlay/:id — cancel (owner token) ─────────────
	app.delete('/v1/overlay/:id', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		const token = req.headers['x-overlay-token'] ?? '';
		const out = cancelOverlay(watchDb, req.params.id, String(token));
		if (!out.ok) {
			const code = out.reason === 'forbidden' ? 403 : 404;
			return reply.code(code).send({ error: { code: out.reason, message: `cancel rejected: ${out.reason}` } });
		}
		return { cancelled: true };
	});

	function buildOverlayStats() {
		if (!watchDb) return { enabled: false, reason: 'watch DB not opened' };
		return {
			enabled: overlayReady() && zecEnabled(),
			rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.DAY_RATE_ATOMIC),
			stats: overlayStatsSnapshot(watchDb)
		};
	}

	return { buildOverlayStats };
}
