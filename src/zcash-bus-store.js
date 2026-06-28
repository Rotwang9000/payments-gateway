// Zcash "Bus Station" — SQLite persistence for non-custodial mixing buses.
//
// Two tables: `buses` (a cohort: route + blend-in amount + min passengers +
// lifecycle) and `bus_seats` (a rider's intent: handle + owner-token hash +
// status). We deliberately store NO addresses, amounts-to-destinations, txids
// or payer identity — the gateway is a rendezvous, not a ledger. Abuse is
// bounded by the HTTP rate limit, not by logging who joined.
//
// Pure logic + projections live in zcash-bus.js; this file is the I/O side.

import Database from 'better-sqlite3';
import {
	BUS_CONSTANTS,
	BUS_STATUS,
	SEAT_STATUS,
	genBusId,
	genSeatId,
	genOwnerToken,
	hashToken,
	verifyOwner,
	effectiveBusStatus,
	isJoinable,
	busMatchKey,
	busKeyForBus
} from './zcash-bus.js';
import { claimNullifier, releaseNullifier } from './zcash-bus-nullifiers.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buses (
	id              TEXT PRIMARY KEY,
	route           TEXT NOT NULL,
	from_asset      TEXT NOT NULL,
	to_asset        TEXT NOT NULL,
	amount_zat      INTEGER NOT NULL,
	min_passengers  INTEGER NOT NULL,
	match_key       TEXT NOT NULL,
	status          TEXT NOT NULL DEFAULT 'boarding',
	created_ms      INTEGER NOT NULL,
	ready_ms        INTEGER,
	depart_by_ms    INTEGER,
	expires_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buses_match ON buses(match_key, status, created_ms);
CREATE INDEX IF NOT EXISTS idx_buses_status ON buses(status, created_ms);

CREATE TABLE IF NOT EXISTS bus_seats (
	id               TEXT PRIMARY KEY,
	bus_id           TEXT NOT NULL,
	handle           TEXT,
	note             TEXT,
	owner_token_hash TEXT NOT NULL,
	status           TEXT NOT NULL DEFAULT 'reserved',
	nullifier        TEXT,
	created_ms       INTEGER NOT NULL,
	updated_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seats_bus ON bus_seats(bus_id, status);

-- Anti-sybil (P4c): one anonymous identity -> one seat per bus. A seat claim in
-- sybil mode reveals a per-bus nullifier; we reject a repeat on the same
-- bus_key. PK enforces dedupe even under concurrent writers. Stores no identity
-- (the nullifier is unlinkable across buses by construction).
CREATE TABLE IF NOT EXISTS bus_nullifiers (
	bus_key     TEXT NOT NULL,
	nullifier   TEXT NOT NULL,
	seat_id     TEXT,
	created_ms  INTEGER NOT NULL,
	PRIMARY KEY (bus_key, nullifier)
);
`;

const ACTIVE_SEAT_STATUSES = [SEAT_STATUS.RESERVED, SEAT_STATUS.BOARDED];

export function openBusDb(path = ':memory:') {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 3000');
	db.exec(SCHEMA);
	migrate(db);
	return db;
}

// Idempotent migrations for DBs created before a column existed (CREATE TABLE IF
// NOT EXISTS never alters an existing table). Cheap to run on every open.
function migrate(db) {
	const seatCols = new Set(db.prepare('PRAGMA table_info(bus_seats)').all().map((c) => c.name));
	if (!seatCols.has('nullifier')) {
		db.exec('ALTER TABLE bus_seats ADD COLUMN nullifier TEXT');
	}
}

// One shared writable handle per path, so the per-request MCP server instances
// and the REST routes coordinate on the same buses. Mirrors the shield index.
let _sharedDb = null;
let _sharedDbPath = null;
export function openSharedBusDb(path) {
	if (!path) return null;
	if (_sharedDb && _sharedDbPath === path) return _sharedDb;
	try {
		_sharedDb = openBusDb(path);
		_sharedDbPath = path;
		return _sharedDb;
	} catch {
		return null;
	}
}

// ── reads ───────────────────────────────────────────────────────────

export function getBusRow(db, id) {
	return db.prepare('SELECT * FROM buses WHERE id = ?').get(id) ?? null;
}

export function getSeatRow(db, id) {
	return db.prepare('SELECT * FROM bus_seats WHERE id = ?').get(id) ?? null;
}

/** Count active (reserved+boarded) seats on a bus. */
export function countActiveSeats(db, busId) {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM bus_seats WHERE bus_id = ? AND status IN (${ACTIVE_SEAT_STATUSES.map(() => '?').join(',')})`
		)
		.get(busId, ...ACTIVE_SEAT_STATUSES);
	return Number(row?.n ?? 0);
}

export function countSeatsByStatus(db, busId, status) {
	const row = db.prepare('SELECT COUNT(*) AS n FROM bus_seats WHERE bus_id = ? AND status = ?').get(busId, status);
	return Number(row?.n ?? 0);
}

export function getSeatsForBus(db, busId) {
	return db.prepare('SELECT * FROM bus_seats WHERE bus_id = ? ORDER BY created_ms ASC').all(busId);
}

// ── lifecycle ───────────────────────────────────────────────────────

/**
 * Recompute a bus's status from its seats + the clock and persist any
 * transition. Self-healing: called opportunistically on every read/join.
 * @returns {{ bus: object, boarded: number, departed: number }}
 */
export function refreshBus(db, busOrId, { nowMs = Date.now(), departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS } = {}) {
	const bus = typeof busOrId === 'string' ? getBusRow(db, busOrId) : busOrId;
	if (!bus) return null;
	const boarded = countActiveSeats(db, bus.id);
	const departed = countSeatsByStatus(db, bus.id, SEAT_STATUS.DEPARTED);
	const next = effectiveBusStatus(bus, { boarded, nowMs });
	if (next !== bus.status) {
		if (next === BUS_STATUS.READY) {
			const readyMs = bus.ready_ms ?? nowMs;
			const departBy = bus.depart_by_ms ?? readyMs + departWindowMs;
			db.prepare('UPDATE buses SET status = ?, ready_ms = ?, depart_by_ms = ? WHERE id = ?')
				.run(next, readyMs, departBy, bus.id);
			bus.status = next;
			bus.ready_ms = readyMs;
			bus.depart_by_ms = departBy;
		} else {
			db.prepare('UPDATE buses SET status = ? WHERE id = ?').run(next, bus.id);
			bus.status = next;
		}
	}
	return { bus, boarded, departed };
}

/** Find the oldest still-boarding bus matching {route, amountZat, minPassengers}. */
export function findJoinableBus(db, { route, amountZat, minPassengers, nowMs = Date.now() }) {
	const key = busMatchKey({ route, amountZat, minPassengers });
	const rows = db
		.prepare('SELECT * FROM buses WHERE match_key = ? AND status = ? ORDER BY created_ms ASC')
		.all(key, BUS_STATUS.BOARDING);
	for (const row of rows) {
		const { bus, boarded } = refreshBus(db, row, { nowMs });
		if (isJoinable(bus.status) && boarded < BUS_CONSTANTS.MAX_SEATS) return bus;
	}
	return null;
}

export function createBus(db, { route, fromAsset, toAsset, amountZat, minPassengers, nowMs = Date.now(), fillTtlMs = BUS_CONSTANTS.FILL_TTL_MS }) {
	const id = genBusId();
	const expires = nowMs + fillTtlMs;
	db.prepare(
		`INSERT INTO buses (id, route, from_asset, to_asset, amount_zat, min_passengers, match_key, status, created_ms, expires_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(id, route, fromAsset, toAsset, amountZat, minPassengers, busMatchKey({ route, amountZat, minPassengers }), BUS_STATUS.BOARDING, nowMs, expires);
	return getBusRow(db, id);
}

/**
 * Find the oldest joinable bus for a cohort, or create one — WITHOUT seating
 * anyone. Used by the sybil flow's "open" step so a rider can read the bus's
 * public `bus_key` and build a membership proof bound to it before claiming a
 * seat (which they can't pre-compute for a bus id that doesn't exist yet).
 * @returns {{ bus: object, reused: boolean, boarded: number, departed: number }}
 */
export function findOrCreateBus(db, { route, fromAsset, toAsset, amountZat, minPassengers, nowMs = Date.now(), fillTtlMs = BUS_CONSTANTS.FILL_TTL_MS, departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS } = {}) {
	const txn = db.transaction(() => {
		let bus = findJoinableBus(db, { route, amountZat, minPassengers, nowMs });
		const reused = !!bus;
		if (!bus) bus = createBus(db, { route, fromAsset, toAsset, amountZat, minPassengers, nowMs, fillTtlMs });
		const refreshed = refreshBus(db, bus.id, { nowMs, departWindowMs });
		return { bus: refreshed.bus, reused, boarded: refreshed.boarded, departed: refreshed.departed };
	});
	return txn();
}

/**
 * Reserve a seat on a bus: find a matching boarding bus or create one, insert a
 * reserved seat, refresh status (may flip to ready). Atomic.
 * @returns {{ bus: object, seat: object, ownerToken: string, boarded: number, departed: number }}
 */
export function joinBus(db, {
	route,
	fromAsset,
	toAsset,
	amountZat,
	minPassengers,
	handle = 'anon',
	note = null,
	nowMs = Date.now(),
	fillTtlMs = BUS_CONSTANTS.FILL_TTL_MS,
	departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS,
	// Anti-sybil (P4c), optional. When provided, the rider's membership proof has
	// ALREADY been verified by the caller (async snarkjs lives in the route layer,
	// not in this synchronous txn); we only enforce the one-seat-per-bus dedupe
	// here, atomically with the seat insert. `busId` pins the exact bus the proof
	// was bound to, `nullifier` is the per-bus tag to burn.
	busId = null,
	nullifier = null
} = {}) {
	const ownerToken = genOwnerToken();
	const sybil = nullifier != null;
	const txn = db.transaction(() => {
		let bus;
		if (sybil) {
			// Sybil mode rides a SPECIFIC, already-existing bus (the one whose
			// bus_key the proof bound to) — never find-or-create, or the proof's
			// busKey wouldn't match the seat's bus.
			if (!busId) throw new TypeError('sybil join requires busId');
			bus = getBusRow(db, busId);
			if (!bus) throw new TypeError('bus not found');
			const view = refreshBus(db, bus, { nowMs, departWindowMs });
			bus = view.bus;
			if (!isJoinable(bus.status) || view.boarded >= BUS_CONSTANTS.MAX_SEATS) {
				throw new TypeError('bus is not accepting seats');
			}
			const busKey = busKeyForBus(bus);
			const claimed = claimNullifier(db, busKey, nullifier, { seatId: null, nowMs });
			if (!claimed.ok) throw new TypeError(`seat refused: ${claimed.reason}`);
		} else {
			bus = findJoinableBus(db, { route, amountZat, minPassengers, nowMs });
			if (!bus) {
				bus = createBus(db, { route, fromAsset, toAsset, amountZat, minPassengers, nowMs, fillTtlMs });
			}
		}
		const seatId = genSeatId();
		db.prepare(
			`INSERT INTO bus_seats (id, bus_id, handle, note, owner_token_hash, status, nullifier, created_ms, updated_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(seatId, bus.id, handle, note, hashToken(ownerToken), SEAT_STATUS.RESERVED, sybil ? String(nullifier) : null, nowMs, nowMs);
		if (sybil) {
			db.prepare('UPDATE bus_nullifiers SET seat_id = ? WHERE bus_key = ? AND nullifier = ?')
				.run(seatId, busKeyForBus(bus), String(nullifier));
		}
		const refreshed = refreshBus(db, bus.id, { nowMs, departWindowMs });
		const seat = getSeatRow(db, seatId);
		return { bus: refreshed.bus, seat, boarded: refreshed.boarded, departed: refreshed.departed };
	});
	const out = txn();
	return { ...out, ownerToken };
}

/**
 * Change a seat's status (requires the owner token). Used for board / leave /
 * mark-departed. Refreshes the parent bus afterwards.
 * @returns {{ ok: boolean, reason?: string, seat?: object, bus?: object, boarded?: number, departed?: number }}
 */
export function setSeatStatus(db, { seatId, token, status, nowMs = Date.now(), departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS }) {
	const validTargets = [SEAT_STATUS.BOARDED, SEAT_STATUS.DEPARTED, SEAT_STATUS.LEFT];
	if (!validTargets.includes(status)) {
		return { ok: false, reason: `invalid target status "${status}"` };
	}
	const seat = getSeatRow(db, seatId);
	if (!seat) return { ok: false, reason: 'seat not found' };
	if (!verifyOwner(seat, token)) return { ok: false, reason: 'not authorised (bad owner token)' };
	db.prepare('UPDATE bus_seats SET status = ?, updated_ms = ? WHERE id = ?').run(status, nowMs, seatId);
	// A rider who LEAVES frees their anti-sybil nullifier so they can re-board
	// elsewhere; one who DEPARTED keeps it burned (they used their seat).
	if (status === SEAT_STATUS.LEFT && seat.nullifier) {
		const bus = getBusRow(db, seat.bus_id);
		if (bus) releaseNullifier(db, busKeyForBus(bus), seat.nullifier);
	}
	const refreshed = refreshBus(db, seat.bus_id, { nowMs, departWindowMs });
	return { ok: true, seat: getSeatRow(db, seatId), bus: refreshed?.bus, boarded: refreshed?.boarded, departed: refreshed?.departed };
}

// ── listings / views ────────────────────────────────────────────────

/**
 * List buses (default: only joinable/boarding + ready) as {bus, boarded,
 * departed} views, freshest activity first. Refreshes each row it returns.
 */
export function listBusViews(db, { route = null, includeClosed = false, nowMs = Date.now(), departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS, limit = BUS_CONSTANTS.LIST_DEFAULT_LIMIT } = {}) {
	const cap = Math.max(1, Math.min(Number(limit) || BUS_CONSTANTS.LIST_DEFAULT_LIMIT, BUS_CONSTANTS.LIST_MAX_LIMIT));
	const params = [];
	let sql = 'SELECT * FROM buses';
	if (route) { sql += ' WHERE route = ?'; params.push(route); }
	sql += ' ORDER BY created_ms DESC';
	const rows = db.prepare(sql).all(...params);
	const open = [BUS_STATUS.BOARDING, BUS_STATUS.READY];
	const out = [];
	for (const row of rows) {
		const view = refreshBus(db, row, { nowMs, departWindowMs });
		if (!view) continue;
		if (!includeClosed && !open.includes(view.bus.status)) continue;
		out.push(view);
		if (out.length >= cap) break;
	}
	return out;
}

export function getBusView(db, id, { nowMs = Date.now(), departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS } = {}) {
	const row = getBusRow(db, id);
	if (!row) return null;
	return refreshBus(db, row, { nowMs, departWindowMs });
}

// ── housekeeping ────────────────────────────────────────────────────

/** Opportunistically transition stale boarding/ready buses (expire/depart). */
export function expireStale(db, { nowMs = Date.now(), departWindowMs = BUS_CONSTANTS.DEPART_WINDOW_MS } = {}) {
	const rows = db
		.prepare('SELECT * FROM buses WHERE status IN (?, ?)')
		.all(BUS_STATUS.BOARDING, BUS_STATUS.READY);
	let changed = 0;
	for (const row of rows) {
		const before = row.status;
		const view = refreshBus(db, row, { nowMs, departWindowMs });
		if (view && view.bus.status !== before) changed += 1;
	}
	return changed;
}

export function statsSnapshot(db, { nowMs = Date.now() } = {}) {
	expireStale(db, { nowMs });
	const byStatus = {};
	for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM buses GROUP BY status').all()) {
		byStatus[r.status] = Number(r.n);
	}
	const seats = db.prepare('SELECT COUNT(*) AS n FROM bus_seats').get();
	return { buses: byStatus, seats_total: Number(seats?.n ?? 0) };
}

export default {
	openBusDb,
	openSharedBusDb,
	getBusRow,
	getSeatRow,
	countActiveSeats,
	countSeatsByStatus,
	getSeatsForBus,
	refreshBus,
	findJoinableBus,
	createBus,
	findOrCreateBus,
	joinBus,
	setSeatStatus,
	listBusViews,
	getBusView,
	expireStale,
	statsSnapshot
};
