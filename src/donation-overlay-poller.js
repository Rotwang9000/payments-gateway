// Donation-overlay poller: scans streamer wallets (UFVK, read-only)
// through NFPT and turns new incoming shielded notes into donation
// events the OBS overlay page polls.
//
// Piggybacks the crypto-recv-poller cadence (one systemd timer tick):
//
//   1. Per-day billing off the overlay's prepaid credit meter (same
//      maths as private watches — applyDayCharge). Out of credit →
//      the overlay silently pauses until topped up.
//   2. Decrypt the UFVK, scan the wallet bounded from the overlay's
//      last scanned height (reorg margin below), so we never re-walk
//      the chain for a long-lived overlay.
//   3. First-ever scan is the BASELINE: every pre-existing note is
//      recorded suppressed so a streamer's history never floods the
//      stream as fake "donations".
//   4. Subsequent scans: new notes (>= the overlay's minimum) become
//      visible events, first as 'seen' (1+ conf — NFPT only sees
//      mined blocks) then 'confirmed' at the chain threshold. The
//      overlay page can announce at either state.
//
// Everything side-effecty is dependency-injected (`scanWallet`,
// `decryptViewKey`, clock, logger) so tests run the full state
// machine against a :memory: DB with zero network.

import { applyDayCharge } from 'viewkey-watch/private-watch';
import { computeConfirmations } from 'viewkey-watch/crypto-recv-poller';
import { scanReceiving } from 'viewkey-watch/private-watch-nfpt';

import {
	OVERLAY_CONSTANTS,
	listActiveOverlays,
	updateOverlayState,
	recordDonationEvent,
	updateEventConfirmations,
	listUnconfirmedEvents,
	pruneOverlayData,
	topupOverlayById
} from './donation-overlay-store.js';

// Zcash reorg safety margin (blocks) below the last scanned height —
// ~1 day of 75-second blocks, matching the checkout poller.
const ZCASH_RESCAN_MARGIN_BLOCKS = 1_200;

// NU6 mainnet activation — safe default birthday so an unconfigured
// overlay never triggers a multi-hour autoDetect walk.
const ZCASH_NU6_HEIGHT = 3_042_000;

// Per-tick scan fan-out cap: NFPT scans are start→poll→cancel jobs, so
// keep one tick comfortably inside the ~60 s timer cadence.
const DEFAULT_MAX_OVERLAYS_PER_TICK = 4;

// Display threshold: an event flips 'seen' → 'confirmed' here. Small
// donations don't warrant the 8-conf payment threshold; 3 is plenty
// for an on-screen alert.
export const OVERLAY_CONFIRMATIONS_DEFAULT = 3;

/** Scan lower bound for an overlay: last scanned height minus the reorg margin, floored at the birthday. */
export function scanBoundsForOverlay(overlay) {
	const floor = overlay.birthday_height ?? ZCASH_NU6_HEIGHT;
	const scanned = Number(overlay.last_scanned_height ?? 0) || 0;
	const birthday = scanned > ZCASH_RESCAN_MARGIN_BLOCKS
		? Math.max(floor, scanned - ZCASH_RESCAN_MARGIN_BLOCKS)
		: floor;
	return { birthdayHeight: birthday };
}

function safeBig(v) {
	try { return BigInt(v); }
	catch { return null; }
}

/** Default production scanner: one bounded NFPT UFVK scan. */
export function makeOverlayScanner(nfptClient, { pollIntervalMs = 4_000, maxWaitMs = 90_000 } = {}) {
	return async ({ address, viewKey, birthdayHeight }) => scanReceiving(nfptClient, {
		chain: 'zcash',
		address,
		viewKey,
		birthdayHeight,
		pollIntervalMs,
		maxWaitMs
	});
}

/**
 * Credit applier for overlay funding quotes (crypto_topup_quotes rows
 * whose watch_id is an overlay id). Chain it after the watch applier
 * in the receive-poller: if the watch store says not_found, try here.
 */
export function makeOverlayCreditApplier(db) {
	if (!db) throw new TypeError('makeOverlayCreditApplier: db required');
	const CENTS_TO_ATOMIC_USDC = 10_000;
	return ({ watchId, usdCents }) => {
		if (!Number.isInteger(usdCents) || usdCents <= 0) return { ok: false, reason: 'invalid_amount' };
		const out = topupOverlayById(db, watchId, { creditAtomic: usdCents * CENTS_TO_ATOMIC_USDC });
		return out.ok
			? { ok: true, newBalanceAtomic: out.row.credit_atomic }
			: { ok: false, reason: out.reason };
	};
}

/**
 * Ingest one scan result for an overlay. Pure DB state machine —
 * exported for direct unit testing.
 *
 * Baseline rule: when the overlay has never been scanned
 * (last_scanned_height IS NULL) every note is recorded suppressed.
 */
export function ingestScanResult(db, overlay, { chainHeight = 0, scannedHeight = 0, incoming = [] }, {
	confirmationsRequired = OVERLAY_CONFIRMATIONS_DEFAULT,
	nowMs = Date.now()
} = {}) {
	const baseline = overlay.last_scanned_height == null;
	const minZat = safeBig(overlay.min_zatoshi) ?? 0n;
	const out = { inserted: 0, suppressed: 0, confirmed_updates: 0 };

	for (const p of incoming) {
		const amount = safeBig(p.amountAtomic);
		if (amount === null || amount <= 0n) continue;
		if (!baseline && minZat > 0n && amount < minZat) continue;
		const confs = computeConfirmations(chainHeight, p.blockHeight);
		const { inserted } = recordDonationEvent(db, {
			overlayId: overlay.id,
			txHash: p.txHash ?? null,
			amountAtomic: amount.toString(),
			memo: p.memo ?? null,
			blockHeight: p.blockHeight ?? null,
			confirmations: confs,
			confirmed: confs >= confirmationsRequired,
			suppressed: baseline,
			nowMs
		});
		if (inserted) {
			out.inserted += 1;
			if (baseline) out.suppressed += 1;
		}
	}

	// Confirmation tracking for events sighted on earlier ticks.
	for (const ev of listUnconfirmedEvents(db, overlay.id)) {
		if (ev.block_height == null) continue;
		const confs = computeConfirmations(chainHeight, ev.block_height);
		if (confs > Number(ev.confirmations ?? 0)) {
			out.confirmed_updates += updateEventConfirmations(db, ev.id, confs, confirmationsRequired);
		}
	}

	updateOverlayState(db, overlay.id, {
		last_scanned_height: Math.max(Number(overlay.last_scanned_height ?? 0), Number(scannedHeight) || 0),
		last_polled_at_ms: nowMs,
		scan_errors: 0
	});
	return out;
}

/**
 * One overlay poller pass. Returns a summary object.
 *
 * deps:
 *   - db                     shared watch DB handle
 *   - decryptViewKey(ct)     -> plaintext UFVK (host binds the master key)
 *   - scanWallet(opts)       -> { chainHeight, scannedHeight, incoming } (makeOverlayScanner in prod)
 *   - confirmationsRequired  'seen' → 'confirmed' display threshold
 *   - maxOverlaysPerTick     scan fan-out cap (default 4)
 *   - now() / logger         clock + pino-like logger (testable)
 */
export async function runOverlayTick({
	db,
	decryptViewKey,
	scanWallet,
	confirmationsRequired = OVERLAY_CONFIRMATIONS_DEFAULT,
	maxOverlaysPerTick = DEFAULT_MAX_OVERLAYS_PER_TICK,
	now = () => Date.now(),
	logger = { info() {}, warn() {}, error() {} }
}) {
	if (!db) throw new TypeError('runOverlayTick: db is required');
	if (typeof decryptViewKey !== 'function') throw new TypeError('runOverlayTick: decryptViewKey must be a function');
	if (typeof scanWallet !== 'function') throw new TypeError('runOverlayTick: scanWallet must be a function');

	const startMs = now();
	const summary = {
		started_at_ms: startMs,
		overlays_seen: 0,
		overlays_scanned: 0,
		overlays_out_of_credit: 0,
		overlays_skipped: 0,
		events_inserted: 0,
		events_suppressed: 0,
		scan_errors: 0,
		credit_billed_atomic: 0
	};

	const active = listActiveOverlays(db, { nowMs: startMs, limit: maxOverlaysPerTick });
	summary.overlays_seen = active.length;

	for (const overlay of active) {
		// 1) Per-day billing first, so the meter reflects reality even
		//    when the scan below fails.
		const dayPatch = applyDayCharge(overlay, startMs, { dayRateAtomic: OVERLAY_CONSTANTS.DAY_RATE_ATOMIC });
		if (dayPatch.chargeAtomic > 0) {
			updateOverlayState(db, overlay.id, {
				credit_atomic: dayPatch.credit_atomic,
				credit_billed_atomic: dayPatch.credit_billed_atomic,
				credit_last_billed_ms: dayPatch.credit_last_billed_ms,
				expires_at_ms: dayPatch.expires_at_ms
			});
			overlay.credit_atomic = dayPatch.credit_atomic;
			summary.credit_billed_atomic += dayPatch.chargeAtomic;
		}
		if (Number(overlay.credit_atomic ?? 0) <= 0) {
			summary.overlays_out_of_credit += 1;
			updateOverlayState(db, overlay.id, { last_polled_at_ms: startMs });
			continue;
		}

		// 2) Decrypt + scan (bounded).
		let viewKey;
		try { viewKey = decryptViewKey(overlay.ufvk_ct); }
		catch (err) {
			summary.overlays_skipped += 1;
			logger.error({ overlayId: overlay.id, err: err?.message ?? String(err) }, 'overlay-poller: UFVK decrypt failed');
			continue;
		}
		let scanResult;
		try {
			scanResult = await scanWallet({
				address: overlay.address,
				viewKey,
				...scanBoundsForOverlay(overlay)
			});
		}
		catch (err) {
			summary.scan_errors += 1;
			updateOverlayState(db, overlay.id, {
				last_polled_at_ms: startMs,
				scan_errors: Number(overlay.scan_errors ?? 0) + 1
			});
			logger.warn({ overlayId: overlay.id, err: err?.message ?? String(err) }, 'overlay-poller: wallet scan failed');
			continue;
		}

		// 3) Ingest.
		const res = ingestScanResult(db, overlay, scanResult ?? {}, { confirmationsRequired, nowMs: now() });
		summary.overlays_scanned += 1;
		summary.events_inserted += res.inserted;
		summary.events_suppressed += res.suppressed;
		if (res.inserted > res.suppressed) {
			logger.info({ overlayId: overlay.id, new_events: res.inserted - res.suppressed }, 'overlay-poller: new donations');
		}
	}

	try { summary.pruned = pruneOverlayData(db, { nowMs: startMs }); }
	catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'overlay-poller: prune failed'); }

	summary.finished_at_ms = now();
	return summary;
}
