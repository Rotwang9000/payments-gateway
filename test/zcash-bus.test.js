// Unit tests for the pure Zcash "Bus Station" helpers (zcash-bus.js).
// No DB, no Fastify — validation, lifecycle derivation, privacy read, projections.

import { describe, test, expect } from '@jest/globals';
import {
	BUS_CONSTANTS,
	BUS_STATUS,
	SEAT_STATUS,
	BUS_CAVEATS,
	normaliseAsset,
	validateRoute,
	validateAmount,
	validateMinPassengers,
	normaliseNote,
	busMatchKey,
	effectiveBusStatus,
	isJoinable,
	assessBusPrivacy,
	buildBusSummary,
	buildSeatSummary
} from '../src/zcash-bus.js';

const ZAT = 100_000_000;

describe('normaliseAsset / validateRoute', () => {
	test('upper-cases and validates CHAIN.TICKER', () => {
		expect(normaliseAsset('btc.btc')).toBe('BTC.BTC');
		expect(normaliseAsset(' eth.eth ')).toBe('ETH.ETH');
	});
	test('rejects malformed assets', () => {
		expect(() => normaliseAsset('btc')).toThrow(/CHAIN\.TICKER/u);
		expect(() => normaliseAsset('')).toThrow();
	});
	test('route is always from ZEC to a different asset', () => {
		const r = validateRoute({ to: 'btc.btc' });
		expect(r).toEqual({ from: 'ZEC.ZEC', to: 'BTC.BTC', route: 'ZEC.ZEC>BTC.BTC' });
	});
	test('rejects a non-ZEC source and a ZEC destination', () => {
		expect(() => validateRoute({ from: 'BTC.BTC', to: 'ETH.ETH' })).toThrow(/source must be ZEC/u);
		expect(() => validateRoute({ to: 'ZEC.ZEC' })).toThrow(/differ from the source/u);
	});
});

describe('validateAmount', () => {
	test('accepts a blend-in denomination', () => {
		expect(validateAmount(1)).toBe(ZAT);
		expect(validateAmount(0.1)).toBe(ZAT / 10);
	});
	test('rejects a non-positive amount', () => {
		expect(() => validateAmount(0)).toThrow(/positive/u);
		expect(() => validateAmount(-1)).toThrow(/positive/u);
	});
	test('rejects an odd, fingerprinting amount with nearby suggestions', () => {
		expect(() => validateAmount(1.2345)).toThrow(/blend-in/u);
	});
	test('honours a live popular feed for membership', () => {
		// 3 ZEC is not in the bundled list, but is in this feed.
		expect(validateAmount(3, { popular: [{ zec: 3, count: 50 }] })).toBe(3 * ZAT);
	});
});

describe('validateMinPassengers', () => {
	test('defaults and clamps to the allowed range', () => {
		expect(validateMinPassengers(undefined)).toBe(BUS_CONSTANTS.MIN_PASSENGERS_DEFAULT);
		expect(validateMinPassengers(3)).toBe(3);
	});
	test('rejects out-of-range or non-integers', () => {
		expect(() => validateMinPassengers(1)).toThrow();
		expect(() => validateMinPassengers(51)).toThrow();
		expect(() => validateMinPassengers(3.5)).toThrow();
	});
});

describe('normaliseNote', () => {
	test('trims and caps, never an address requirement', () => {
		expect(normaliseNote('  hi there  ')).toBe('hi there');
		expect(normaliseNote('')).toBeNull();
		expect(normaliseNote('x'.repeat(500)).length).toBe(120);
	});
});

describe('busMatchKey', () => {
	test('is deterministic and separates by route/amount/min', () => {
		const a = busMatchKey({ route: 'ZEC.ZEC>BTC.BTC', amountZat: ZAT, minPassengers: 5 });
		expect(a).toBe(busMatchKey({ route: 'ZEC.ZEC>BTC.BTC', amountZat: ZAT, minPassengers: 5 }));
		expect(a).not.toBe(busMatchKey({ route: 'ZEC.ZEC>BTC.BTC', amountZat: ZAT, minPassengers: 3 }));
		expect(a).not.toBe(busMatchKey({ route: 'ZEC.ZEC>ETH.ETH', amountZat: ZAT, minPassengers: 5 }));
	});
});

describe('effectiveBusStatus', () => {
	const base = { status: BUS_STATUS.BOARDING, min_passengers: 3, created_ms: 0, expires_ms: 1000, depart_by_ms: null };
	test('boarding below min stays boarding', () => {
		expect(effectiveBusStatus(base, { boarded: 2, nowMs: 10 })).toBe(BUS_STATUS.BOARDING);
	});
	test('boarding reaching min becomes ready', () => {
		expect(effectiveBusStatus(base, { boarded: 3, nowMs: 10 })).toBe(BUS_STATUS.READY);
	});
	test('boarding past its TTL expires', () => {
		expect(effectiveBusStatus(base, { boarded: 1, nowMs: 2000 })).toBe(BUS_STATUS.EXPIRED);
	});
	test('ready past the departure window departs; before it stays ready', () => {
		const ready = { ...base, status: BUS_STATUS.READY, depart_by_ms: 1500 };
		expect(effectiveBusStatus(ready, { boarded: 3, nowMs: 1000 })).toBe(BUS_STATUS.READY);
		expect(effectiveBusStatus(ready, { boarded: 3, nowMs: 2000 })).toBe(BUS_STATUS.DEPARTED);
	});
	test('terminal states are sticky', () => {
		for (const s of [BUS_STATUS.DEPARTED, BUS_STATUS.EXPIRED, BUS_STATUS.CANCELLED]) {
			expect(effectiveBusStatus({ ...base, status: s }, { boarded: 99, nowMs: 0 })).toBe(s);
		}
	});
	test('isJoinable only while boarding', () => {
		expect(isJoinable(BUS_STATUS.BOARDING)).toBe(true);
		expect(isJoinable(BUS_STATUS.READY)).toBe(false);
	});
});

describe('assessBusPrivacy', () => {
	test('forming below min', () => {
		expect(assessBusPrivacy({ status: BUS_STATUS.BOARDING, boarded: 2, minPassengers: 5 }).level).toBe('forming');
	});
	test('tiers by realized seats once ready', () => {
		expect(assessBusPrivacy({ status: BUS_STATUS.READY, boarded: 3, minPassengers: 3 }).level).toBe('fair');
		expect(assessBusPrivacy({ status: BUS_STATUS.READY, boarded: 6, minPassengers: 5 }).level).toBe('good');
		expect(assessBusPrivacy({ status: BUS_STATUS.READY, boarded: 12, minPassengers: 5 }).level).toBe('strong');
	});
	test('departed/closed read', () => {
		expect(assessBusPrivacy({ status: BUS_STATUS.DEPARTED, boarded: 5 }).level).toBe('departed');
		expect(assessBusPrivacy({ status: BUS_STATUS.EXPIRED, boarded: 0 }).level).toBe('closed');
	});
});

describe('projections', () => {
	const busRow = {
		id: 'bus_1', route: 'ZEC.ZEC>BTC.BTC', from_asset: 'ZEC.ZEC', to_asset: 'BTC.BTC',
		amount_zat: ZAT, min_passengers: 3, status: BUS_STATUS.BOARDING,
		created_ms: 0, ready_ms: null, depart_by_ms: null, expires_ms: 10_000
	};
	test('buildBusSummary carries amounts, counts and a privacy read', () => {
		const s = buildBusSummary(busRow, { boarded: 2, departed: 0, nowMs: 5 });
		expect(s.id).toBe('bus_1');
		expect(s.amount_zec).toBe(1);
		expect(s.amount_label).toBe('1 ZEC.ZEC');
		expect(s.seats_filled).toBe(2);
		expect(s.status).toBe(BUS_STATUS.BOARDING);
		expect(s.privacy.level).toBe('forming');
		expect(s).not.toHaveProperty('owner_token_hash');
		expect(s).not.toHaveProperty('match_key');
	});
	test('buildBusSummary reflects derived ready status', () => {
		const s = buildBusSummary(busRow, { boarded: 3, departed: 0, nowMs: 5 });
		expect(s.status).toBe(BUS_STATUS.READY);
	});
	test('buildSeatSummary never leaks the owner-token hash', () => {
		const seat = buildSeatSummary({ id: 'seat_1', bus_id: 'bus_1', handle: 'HyperHacker01', note: null, status: SEAT_STATUS.RESERVED, owner_token_hash: 'deadbeef', created_ms: 1, updated_ms: 1 });
		expect(seat.handle).toBe('HyperHacker01');
		expect(seat).not.toHaveProperty('owner_token_hash');
	});
});

describe('caveats', () => {
	test('the honest framing is non-empty and leads with non-custodial', () => {
		expect(BUS_CAVEATS.length).toBeGreaterThan(3);
		expect(BUS_CAVEATS[0]).toMatch(/[Nn]on-custodial/u);
	});
});
