// Zcash "Bus Station" — non-custodial mixing coordination (pure helpers).
//
// The amount-privacy advisor (zcash-amount-privacy.js) tells ONE user how to
// pick a blend-in amount. A "bus" coordinates MANY users so they each leave the
// Zcash pool with the SAME amount, on the SAME route, in the SAME short window —
// turning N look-alike swaps into one anonymity set.
//
// CRITICAL — this is a *rendezvous*, not a tumbler. The gateway:
//   • never holds anyone's funds (no pooled address, no custody),
//   • never sees keys, destinations, txids, or change,
//   • only tracks (route, blend-in amount, seat count, departure window).
// Each passenger signs and broadcasts THEIR OWN swap from THEIR OWN wallet at
// departure. That keeps it non-custodial (not money-transmission-shaped) and
// means the real anonymity set is the on-chain reality, not the seat count.
//
// This re-imagines the original custodial ZecBus (which pooled ZEC at a bus
// address and swapped on users' behalf) as a coordination-only service.
//
// Everything here is pure + unit-testable. The SQLite side lives in
// zcash-bus-store.js and the routes/MCP tools wire it up.

import {
	genNoticeId,
	genOwnerToken,
	hashToken,
	verifyOwner,
	normaliseHandle,
	sanitiseText
} from './notice-board.js';
import {
	zecToZats,
	zatsToZec,
	formatZec,
	isCommonAmount,
	suggestAmounts
} from './zcash-amount-privacy.js';

const MS_PER_MIN = 60_000;

export const BUS_CONSTANTS = Object.freeze({
	// The privacy point is *leaving* the Zcash shielded pool, so the source is
	// always ZEC. The destination is any swap target the user's own wallet can
	// reach (validated by format; the swap layer enforces real routes).
	FROM_ASSET: 'ZEC.ZEC',
	// CHAIN.TICKER, upper-case (e.g. BTC.BTC, ETH.ETH, THOR.RUNE, DASH.DASH).
	ASSET_RE: /^[A-Z0-9]{2,10}\.[A-Z0-9.-]{1,40}$/u,
	MIN_PASSENGERS_FLOOR: 2,
	MIN_PASSENGERS_CEIL: 50,
	MIN_PASSENGERS_DEFAULT: 5,
	// A single cohort never grows without bound — once it reaches min it departs.
	MAX_SEATS: 64,
	// Boarding TTL: an unfilled bus expires (and its seats are freed) after this.
	FILL_TTL_MS: 24 * 60 * MS_PER_MIN,
	// Once min passengers board, this is the window in which everyone must
	// broadcast their own swap. Short, so the on-chain cluster stays tight.
	DEPART_WINDOW_MS: 20 * MS_PER_MIN,
	HANDLE_MAX: 48,
	LIST_DEFAULT_LIMIT: 50,
	LIST_MAX_LIMIT: 200
});

// Bus lifecycle (status):
//   boarding  — filling; accepts new seats.
//   ready     — min reached; departure window open; broadcast your swap now.
//   departed  — departure window elapsed; the cohort has (hopefully) gone.
//   expired   — boarding TTL elapsed without filling; seats freed.
//   cancelled — operator/last-passenger closed it.
export const BUS_STATUS = Object.freeze({
	BOARDING: 'boarding',
	READY: 'ready',
	DEPARTED: 'departed',
	EXPIRED: 'expired',
	CANCELLED: 'cancelled'
});

// Seat lifecycle:
//   reserved — announced intent to ride.
//   boarded  — confirmed ready (saw the bus reach min; will broadcast).
//   departed — claims to have broadcast their swap.
//   left     — withdrew before departure.
//   no_show  — window passed without boarding.
export const SEAT_STATUS = Object.freeze({
	RESERVED: 'reserved',
	BOARDED: 'boarded',
	DEPARTED: 'departed',
	LEFT: 'left',
	NO_SHOW: 'no_show'
});

// Honest framing shown alongside every bus. The whole value of this feature is
// telling users exactly what it does and does NOT protect.
export const BUS_CAVEATS = Object.freeze([
	'Non-custodial: this service never holds your funds or keys. You broadcast your own swap from your own wallet.',
	'The anonymity set is only the number of *real, distinct* riders who actually broadcast in the window — not the seat count.',
	'Sybil risk: if one actor takes several seats, the set shrinks. Treat the seat count as an upper bound until reputation proofs land.',
	'Timing matters: broadcast during the departure window. Stragglers stand out and shrink everyone\'s set.',
	'Use a fresh destination and avoid reusing transparent change addresses — amount blending does not fix address reuse.',
	'This coordinates amount, route and timing only. It does not pool, mix, or alter custody of any coins.'
]);

// ── identifiers (reused from the notice board) ──────────────────────
export { genOwnerToken, hashToken, verifyOwner };
export function genBusId() { return `bus_${genNoticeId()}`; }
export function genSeatId() { return `seat_${genNoticeId()}`; }

// ── validation ──────────────────────────────────────────────────────

/** Normalise + validate a single asset id ("chain.ticker"). Throws on bad input. */
export function normaliseAsset(value) {
	const s = String(value ?? '').trim().toUpperCase();
	if (!BUS_CONSTANTS.ASSET_RE.test(s)) {
		throw new TypeError(`invalid asset "${value}"; expected CHAIN.TICKER e.g. BTC.BTC`);
	}
	return s;
}

/**
 * Validate a route. The source is always ZEC (leaving the shielded pool); the
 * destination is any well-formed asset that isn't ZEC itself.
 * @returns {{ from: string, to: string, route: string }}
 */
export function validateRoute({ from = BUS_CONSTANTS.FROM_ASSET, to } = {}) {
	const fromAsset = normaliseAsset(from);
	if (fromAsset !== BUS_CONSTANTS.FROM_ASSET) {
		throw new TypeError(`bus source must be ${BUS_CONSTANTS.FROM_ASSET} (the point is leaving the Zcash pool)`);
	}
	const toAsset = normaliseAsset(to);
	if (toAsset === fromAsset) {
		throw new TypeError('destination asset must differ from the source');
	}
	return { from: fromAsset, to: toAsset, route: `${fromAsset}>${toAsset}` };
}

/**
 * Validate the per-passenger amount. It MUST be a blend-in amount (a common /
 * popular denomination) — a bus full of identical odd amounts would just be a
 * shared fingerprint. Throws with the nearest blend-in suggestions otherwise.
 * @param {number} amountZec
 * @param {Array|null} [popular] live popularity feed (else the bundled list)
 * @returns {number} integer zatoshis
 */
export function validateAmount(amountZec, { popular = null } = {}) {
	const zats = zecToZats(amountZec);
	if (!Number.isFinite(zats) || zats <= 0) {
		throw new TypeError('amount must be a positive number of ZEC');
	}
	if (!isCommonAmount(amountZec, popular)) {
		const near = suggestAmounts(amountZec, { count: 3, popular }).suggestions.map((s) => s.label);
		throw new TypeError(
			`amount ${formatZec(zats)} ZEC is not a blend-in denomination; ride a common one instead`
			+ (near.length ? ` (e.g. ${near.join(', ')})` : '')
		);
	}
	return zats;
}

/** Validate the minimum-passenger threshold for a bus. */
export function validateMinPassengers(value) {
	const n = Number(value ?? BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT);
	if (!Number.isInteger(n) || n < BUS_CONSTANTS.MIN_PASSENGERS_FLOOR || n > BUS_CONSTANTS.MIN_PASSENGERS_CEIL) {
		throw new TypeError(
			`minPassengers must be an integer between ${BUS_CONSTANTS.MIN_PASSENGERS_FLOOR} and ${BUS_CONSTANTS.MIN_PASSENGERS_CEIL}`
		);
	}
	return n;
}

export function normaliseBusHandle(value) {
	return normaliseHandle(value);
}

/** Optional rider note — a label only, never an address (we never store those). */
export function normaliseNote(value) {
	const s = sanitiseText(value, 120);
	return s || null;
}

/**
 * Matching key: riders are grouped onto the same boarding bus when route,
 * amount AND requested minimum all agree. Different minimums get different
 * cohorts so a "min 3" rider isn't merged into a "min 10" bus that may never
 * fill (and vice-versa).
 */
export function busMatchKey({ route, amountZat, minPassengers }) {
	return `${route}|${amountZat}|${minPassengers}`;
}

// ── lifecycle (pure status derivation) ──────────────────────────────

/**
 * Derive the status a bus *should* have right now from its stored fields, its
 * seat count, and the clock — without writing anything. The store applies this
 * opportunistically on read/join so status is always self-healing.
 *
 * @param {object} bus stored bus row (status, min_passengers, created_ms, ready_ms, depart_by_ms, expires_ms)
 * @param {object} o
 * @param {number} o.boarded count of active (reserved+boarded) seats
 * @param {number} [o.nowMs]
 * @returns {string} one of BUS_STATUS
 */
export function effectiveBusStatus(bus, { boarded, nowMs = Date.now() } = {}) {
	const status = bus?.status ?? BUS_STATUS.BOARDING;
	if (status === BUS_STATUS.CANCELLED) return BUS_STATUS.CANCELLED;
	if (status === BUS_STATUS.DEPARTED) return BUS_STATUS.DEPARTED;
	if (status === BUS_STATUS.EXPIRED) return BUS_STATUS.EXPIRED;

	const min = Number(bus?.min_passengers ?? BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT);
	const count = Number(boarded ?? 0);

	if (status === BUS_STATUS.READY) {
		const departBy = Number(bus?.depart_by_ms ?? 0);
		if (departBy && nowMs > departBy) return BUS_STATUS.DEPARTED;
		return BUS_STATUS.READY;
	}

	// boarding
	if (count >= min) return BUS_STATUS.READY;
	const expires = Number(bus?.expires_ms ?? 0);
	if (expires && nowMs > expires) return BUS_STATUS.EXPIRED;
	return BUS_STATUS.BOARDING;
}

/** Is this status one that still accepts new riders? */
export function isJoinable(status) {
	return status === BUS_STATUS.BOARDING;
}

// ── privacy assessment ──────────────────────────────────────────────

/**
 * Honest anonymity read for a bus. The set is the number of distinct riders who
 * will actually broadcast — we can only show the seat count as an UPPER BOUND.
 */
export function assessBusPrivacy({ status, boarded = 0, minPassengers = BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT } = {}) {
	const count = Number(boarded) || 0;
	const min = Number(minPassengers) || BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT;

	if (status === BUS_STATUS.DEPARTED) {
		return { level: 'departed', anonymitySetMax: count, headline: 'This bus has departed.' };
	}
	if (status === BUS_STATUS.EXPIRED || status === BUS_STATUS.CANCELLED) {
		return { level: 'closed', anonymitySetMax: 0, headline: 'This bus is closed.' };
	}
	if (status === BUS_STATUS.READY || count >= min) {
		return {
			level: count >= 10 ? 'strong' : count >= 5 ? 'good' : 'fair',
			anonymitySetMax: count,
			headline: `Ready to depart — up to ${count} look-alike swaps (anonymity set ≤ ${count}, sybil-permitting).`
		};
	}
	return {
		level: 'forming',
		anonymitySetMax: count,
		headline: `Filling — ${count}/${min} seats. Bigger cohorts hide you better.`
	};
}

// ── public projection ───────────────────────────────────────────────

/**
 * Public view of a bus. NEVER leaks owner-token hashes or anything that could
 * link a rider to a destination (we don't store those in the first place).
 */
export function buildBusSummary(bus, { boarded = 0, departed = 0, nowMs = Date.now() } = {}) {
	const status = effectiveBusStatus(bus, { boarded, nowMs });
	const min = Number(bus.min_passengers ?? BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT);
	const amountZat = Number(bus.amount_zat ?? 0);
	return {
		id: bus.id,
		route: bus.route,
		from: bus.from_asset,
		to: bus.to_asset,
		amount_zat: amountZat,
		amount_zec: zatsToZec(amountZat),
		amount_label: `${formatZec(amountZat)} ${bus.from_asset}`,
		min_passengers: min,
		seats_filled: Number(boarded) || 0,
		seats_departed: Number(departed) || 0,
		seats_max: BUS_CONSTANTS.MAX_SEATS,
		status,
		created_ms: Number(bus.created_ms) || null,
		ready_ms: bus.ready_ms != null ? Number(bus.ready_ms) : null,
		depart_by_ms: bus.depart_by_ms != null ? Number(bus.depart_by_ms) : null,
		expires_ms: bus.expires_ms != null ? Number(bus.expires_ms) : null,
		privacy: assessBusPrivacy({ status, boarded, minPassengers: min })
	};
}

/** Public view of a single seat (the rider's own; owner token never leaked). */
export function buildSeatSummary(seat) {
	return {
		id: seat.id,
		bus_id: seat.bus_id,
		handle: seat.handle ?? 'anon',
		status: seat.status ?? SEAT_STATUS.RESERVED,
		note: seat.note ?? null,
		created_ms: Number(seat.created_ms) || null,
		updated_ms: Number(seat.updated_ms) || null
	};
}

export default {
	BUS_CONSTANTS,
	BUS_STATUS,
	SEAT_STATUS,
	BUS_CAVEATS,
	genBusId,
	genSeatId,
	genOwnerToken,
	hashToken,
	verifyOwner,
	normaliseAsset,
	validateRoute,
	validateAmount,
	validateMinPassengers,
	normaliseBusHandle,
	normaliseNote,
	busMatchKey,
	effectiveBusStatus,
	isJoinable,
	assessBusPrivacy,
	buildBusSummary,
	buildSeatSummary
};
