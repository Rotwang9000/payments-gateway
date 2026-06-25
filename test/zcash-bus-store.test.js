// Unit tests for the Zcash "Bus Station" SQLite store (zcash-bus-store.js):
// join finds-or-creates a cohort, fills to ready, opens a departure window,
// honours owner tokens, and self-heals stale buses. In-memory DB; time is
// injected so the lifecycle is deterministic.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { BUS_STATUS, SEAT_STATUS } from '../src/zcash-bus.js';
import {
	openBusDb,
	joinBus,
	setSeatStatus,
	getBusView,
	listBusViews,
	getSeatRow,
	countActiveSeats,
	expireStale
} from '../src/zcash-bus-store.js';

const ZAT = 100_000_000;
const ROUTE = { route: 'ZEC.ZEC>BTC.BTC', fromAsset: 'ZEC.ZEC', toAsset: 'BTC.BTC' };
const join = (db, over = {}) => joinBus(db, { ...ROUTE, amountZat: ZAT, minPassengers: 3, handle: 'anon', nowMs: 1000, ...over });

let db;
beforeEach(() => { db = openBusDb(':memory:'); });
afterEach(() => { if (db) db.close(); });

describe('joinBus', () => {
	test('creates a boarding bus + a reserved seat and returns a one-time owner token', () => {
		const r = join(db);
		expect(r.bus.status).toBe(BUS_STATUS.BOARDING);
		expect(r.seat.status).toBe(SEAT_STATUS.RESERVED);
		expect(r.boarded).toBe(1);
		expect(typeof r.ownerToken).toBe('string');
		expect(r.ownerToken.length).toBeGreaterThan(16);
		// The token is never persisted in the clear.
		const seatRow = getSeatRow(db, r.seat.id);
		expect(seatRow.owner_token_hash).not.toContain(r.ownerToken);
	});

	test('a second matching rider joins the SAME boarding bus', () => {
		const a = join(db, { nowMs: 1000 });
		const b = join(db, { nowMs: 1001 });
		expect(b.bus.id).toBe(a.bus.id);
		expect(countActiveSeats(db, a.bus.id)).toBe(2);
		expect(b.bus.status).toBe(BUS_STATUS.BOARDING);
	});

	test('reaching the minimum flips the bus to ready and sets a departure window', () => {
		join(db, { nowMs: 1000 });
		join(db, { nowMs: 1001 });
		const third = join(db, { nowMs: 1002, departWindowMs: 5000 });
		expect(third.bus.status).toBe(BUS_STATUS.READY);
		expect(third.bus.ready_ms).toBe(1002);
		expect(third.bus.depart_by_ms).toBe(1002 + 5000);
	});

	test('a ready bus stops accepting riders — the next rider starts a new bus', () => {
		const a = join(db, { nowMs: 1000 });
		join(db, { nowMs: 1001 });
		join(db, { nowMs: 1002 }); // -> ready
		const fourth = join(db, { nowMs: 1003 });
		expect(fourth.bus.id).not.toBe(a.bus.id);
		expect(fourth.bus.status).toBe(BUS_STATUS.BOARDING);
	});

	test('different minPassengers form separate cohorts', () => {
		const a = join(db, { minPassengers: 3, nowMs: 1000 });
		const b = join(db, { minPassengers: 5, nowMs: 1001 });
		expect(b.bus.id).not.toBe(a.bus.id);
	});

	test('different routes form separate cohorts', () => {
		const a = join(db, { nowMs: 1000 });
		const b = join(db, { route: 'ZEC.ZEC>ETH.ETH', toAsset: 'ETH.ETH', nowMs: 1001 });
		expect(b.bus.id).not.toBe(a.bus.id);
	});
});

describe('setSeatStatus (owner-token gated)', () => {
	test('board with the correct token; reject a bad token', () => {
		const r = join(db);
		const bad = setSeatStatus(db, { seatId: r.seat.id, token: 'nope', status: SEAT_STATUS.BOARDED });
		expect(bad.ok).toBe(false);
		expect(bad.reason).toMatch(/authoris/u);

		const ok = setSeatStatus(db, { seatId: r.seat.id, token: r.ownerToken, status: SEAT_STATUS.BOARDED });
		expect(ok.ok).toBe(true);
		expect(ok.seat.status).toBe(SEAT_STATUS.BOARDED);
	});

	test('leaving frees the seat from the active count', () => {
		const a = join(db, { nowMs: 1000 });
		join(db, { nowMs: 1001 });
		expect(countActiveSeats(db, a.bus.id)).toBe(2);
		const left = setSeatStatus(db, { seatId: a.seat.id, token: a.ownerToken, status: SEAT_STATUS.LEFT });
		expect(left.ok).toBe(true);
		expect(countActiveSeats(db, a.bus.id)).toBe(1);
	});

	test('rejects an invalid target status', () => {
		const r = join(db);
		const res = setSeatStatus(db, { seatId: r.seat.id, token: r.ownerToken, status: 'teleported' });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/invalid target/u);
	});

	test('missing seat is reported, not thrown', () => {
		const res = setSeatStatus(db, { seatId: 'seat_nope', token: 'x', status: SEAT_STATUS.LEFT });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/not found/u);
	});
});

describe('views + housekeeping', () => {
	test('listBusViews returns open buses, excluding closed unless asked', () => {
		const a = join(db, { nowMs: 1000, fillTtlMs: 500 });
		// Expire it by reading far in the future.
		const later = 1000 + 10_000;
		expect(getBusView(db, a.bus.id, { nowMs: later }).bus.status).toBe(BUS_STATUS.EXPIRED);
		expect(listBusViews(db, { nowMs: later })).toHaveLength(0);
		const all = listBusViews(db, { nowMs: later, includeClosed: true });
		expect(all).toHaveLength(1);
		expect(all[0].bus.status).toBe(BUS_STATUS.EXPIRED);
	});

	test('a ready bus departs once its window elapses', () => {
		join(db, { nowMs: 1000 });
		join(db, { nowMs: 1000 });
		const ready = join(db, { nowMs: 1000, departWindowMs: 2000 });
		expect(ready.bus.status).toBe(BUS_STATUS.READY);
		const view = getBusView(db, ready.bus.id, { nowMs: 1000 + 5000, departWindowMs: 2000 });
		expect(view.bus.status).toBe(BUS_STATUS.DEPARTED);
	});

	test('expireStale transitions stale rows in bulk', () => {
		join(db, { nowMs: 1000, fillTtlMs: 100 });
		const changed = expireStale(db, { nowMs: 1000 + 10_000 });
		expect(changed).toBe(1);
	});

	test('filter by route', () => {
		join(db, { nowMs: 1000 });
		join(db, { route: 'ZEC.ZEC>ETH.ETH', toAsset: 'ETH.ETH', nowMs: 1000 });
		const eth = listBusViews(db, { route: 'ZEC.ZEC>ETH.ETH', nowMs: 1000 });
		expect(eth).toHaveLength(1);
		expect(eth[0].bus.to_asset).toBe('ETH.ETH');
	});
});
