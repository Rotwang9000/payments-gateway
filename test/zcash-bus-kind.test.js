// Unit tests for shield/unshield bus "kind" support (pure helpers).
// Swap kind keeps its existing shape; shield/unshield are pool moves whose
// "destination" is transparent/shielded ZEC and need no `to`.

import { describe, test, expect } from '@jest/globals';
import {
	BUS_KIND,
	BUS_CONSTANTS,
	BUS_STATUS,
	normaliseBusKind,
	validateBusRoute,
	kindFromAssets,
	busKindMeta,
	buildBusSummary
} from '../src/zcash-bus.js';

const ZAT = 100_000_000;
const T = BUS_CONSTANTS.TRANSPARENT_ASSET;
const Z = BUS_CONSTANTS.FROM_ASSET;

describe('normaliseBusKind', () => {
	test('accepts the three kinds and the deshield synonym', () => {
		expect(normaliseBusKind('swap')).toBe(BUS_KIND.SWAP);
		expect(normaliseBusKind('UNSHIELD')).toBe(BUS_KIND.UNSHIELD);
		expect(normaliseBusKind('shield')).toBe(BUS_KIND.SHIELD);
		expect(normaliseBusKind('deshield')).toBe(BUS_KIND.UNSHIELD);
		expect(normaliseBusKind(undefined)).toBe(BUS_KIND.SWAP);
	});
	test('rejects nonsense', () => {
		expect(() => normaliseBusKind('teleport')).toThrow(/invalid bus kind/u);
	});
});

describe('validateBusRoute', () => {
	test('swap still requires + normalises a destination', () => {
		expect(validateBusRoute({ kind: 'swap', to: 'btc.btc' }))
			.toEqual({ kind: 'swap', from: Z, to: 'BTC.BTC', route: 'ZEC.ZEC>BTC.BTC' });
		expect(() => validateBusRoute({ kind: 'swap' })).toThrow(/CHAIN\.TICKER|invalid asset/u);
	});
	test('unshield is shielded → transparent ZEC, no destination needed', () => {
		expect(validateBusRoute({ kind: 'unshield' }))
			.toEqual({ kind: 'unshield', from: Z, to: T, route: `${Z}>${T}` });
	});
	test('shield is transparent → shielded ZEC', () => {
		expect(validateBusRoute({ kind: 'shield' }))
			.toEqual({ kind: 'shield', from: T, to: Z, route: `${T}>${Z}` });
	});
	test('the transparent token is reserved — a swap cannot squat on it', () => {
		expect(() => validateBusRoute({ kind: 'swap', to: 'ZEC.T' })).toThrow(/reserved for shield\/unshield/u);
	});
	test('swap and unshield/shield never collide on route', () => {
		const routes = [
			validateBusRoute({ kind: 'swap', to: 'BTC.BTC' }).route,
			validateBusRoute({ kind: 'unshield' }).route,
			validateBusRoute({ kind: 'shield' }).route
		];
		expect(new Set(routes).size).toBe(3);
	});
});

describe('kindFromAssets round-trips with validateBusRoute', () => {
	for (const kind of [BUS_KIND.SWAP, BUS_KIND.UNSHIELD, BUS_KIND.SHIELD]) {
		test(kind, () => {
			const r = validateBusRoute({ kind, to: 'BTC.BTC' });
			expect(kindFromAssets(r.from, r.to)).toBe(kind);
		});
	}
});

describe('busKindMeta', () => {
	test('nouns + labels per kind', () => {
		expect(busKindMeta(BUS_KIND.UNSHIELD).noun).toBe('unshields');
		expect(busKindMeta(BUS_KIND.SHIELD).noun).toBe('shields');
		expect(busKindMeta(BUS_KIND.SWAP, 'BTC.BTC').toLabel).toBe('BTC.BTC');
		expect(busKindMeta(BUS_KIND.UNSHIELD).toLabel).toBe('transparent ZEC');
	});
});

describe('buildBusSummary carries kind + kind-aware privacy noun', () => {
	const base = {
		id: 'bus_u', amount_zat: ZAT, min_passengers: 3, status: BUS_STATUS.READY,
		created_ms: 0, ready_ms: 1, depart_by_ms: 99_999, expires_ms: 10_000
	};
	test('unshield bus', () => {
		const s = buildBusSummary({ ...base, route: `${Z}>${T}`, from_asset: Z, to_asset: T }, { boarded: 6, nowMs: 5 });
		expect(s.kind).toBe('unshield');
		expect(s.to_label).toBe('transparent ZEC');
		expect(s.route_label).toMatch(/Unshield/u);
		expect(s.privacy.headline).toMatch(/look-alike unshields/u);
	});
	test('shield bus', () => {
		const s = buildBusSummary({ ...base, route: `${T}>${Z}`, from_asset: T, to_asset: Z }, { boarded: 6, nowMs: 5 });
		expect(s.kind).toBe('shield');
		expect(s.privacy.headline).toMatch(/look-alike shields/u);
	});
	test('swap bus keeps look-alike swaps', () => {
		const s = buildBusSummary({ ...base, route: 'ZEC.ZEC>BTC.BTC', from_asset: Z, to_asset: 'BTC.BTC' }, { boarded: 6, nowMs: 5 });
		expect(s.kind).toBe('swap');
		expect(s.privacy.headline).toMatch(/look-alike swaps/u);
	});
});
