// Tests for the Zcash shield-amount index: store CRUD, queries, and the
// incremental scanner (with an injected zecRpc serving getblock-verbosity-2
// fixtures so it's fully deterministic and never touches a node).

import { describe, test, expect } from '@jest/globals';

import {
	openShieldIndexDb,
	bumpAmount,
	popularAmounts,
	nearbyAmounts,
	exactCount,
	statsSnapshot,
	buildPopularFeed,
	pruneRareAmounts,
	getCursor,
	scanShieldAmounts
} from '../src/zcash-shield-index.js';

const ZEC = 100_000_000;

function freshDb() {
	return openShieldIndexDb(':memory:');
}

describe('store CRUD + queries', () => {
	test('bumpAmount accumulates counts and height range', () => {
		const db = freshDb();
		bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 100 });
		bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 110 });
		bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 105 });
		expect(exactCount(db, { side: 'deshield', amountZat: 1 * ZEC })).toBe(3);
		const [row] = popularAmounts(db, { side: 'deshield', minCount: 1 });
		expect(row.firstHeight).toBe(100);
		expect(row.lastHeight).toBe(110);
		db.close();
	});

	test('popularAmounts ranks by count and honours minCount', () => {
		const db = freshDb();
		for (let i = 0; i < 5; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 1 });
		for (let i = 0; i < 2; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 10 * ZEC, height: 1 });
		bumpAmount(db, { side: 'deshield', amountZat: 0.123456 * ZEC, height: 1 });
		const top = popularAmounts(db, { side: 'deshield', minCount: 2 });
		expect(top.map((r) => r.zec)).toEqual([1, 10]); // singleton 0.123456 excluded
		expect(top[0].count).toBe(5);
		db.close();
	});

	test('nearbyAmounts sorts by distance to target', () => {
		const db = freshDb();
		for (const zec of [0.5, 1, 2, 10]) {
			for (let i = 0; i < 3; i += 1) bumpAmount(db, { side: 'shield', amountZat: zec * ZEC, height: 1 });
		}
		const near = nearbyAmounts(db, { side: 'shield', nearZat: 1.8 * ZEC, limit: 2 });
		expect(near.map((r) => r.zec)).toEqual([2, 1]);
		db.close();
	});

	test('exactCount is not gated by minCount', () => {
		const db = freshDb();
		bumpAmount(db, { side: 'deshield', amountZat: 7 * ZEC, height: 1 });
		expect(exactCount(db, { side: 'deshield', amountZat: 7 * ZEC })).toBe(1);
		expect(popularAmounts(db, { side: 'deshield', minCount: 3 })).toHaveLength(0);
		db.close();
	});

	test('buildPopularFeed falls back to global top when target has few neighbours', () => {
		const db = freshDb();
		for (let i = 0; i < 5; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 1 });
		for (let i = 0; i < 5; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 100 * ZEC, height: 1 });
		const feed = buildPopularFeed(db, { side: 'deshield', nearZat: 50 * ZEC, limit: 8, minCount: 3 });
		const zecs = feed.map((f) => f.zec).sort((a, b) => a - b);
		expect(zecs).toEqual([1, 100]);
		db.close();
	});

	test('pruneRareAmounts drops one-offs below the threshold', () => {
		const db = freshDb();
		bumpAmount(db, { side: 'deshield', amountZat: 0.111 * ZEC, height: 10 });
		for (let i = 0; i < 4; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 1 * ZEC, height: 10 });
		const removed = pruneRareAmounts(db, { minKeepCount: 3, beforeHeight: 1000 });
		expect(removed).toBe(1);
		expect(exactCount(db, { side: 'deshield', amountZat: 0.111 * ZEC })).toBe(0);
		expect(exactCount(db, { side: 'deshield', amountZat: 1 * ZEC })).toBe(4);
		db.close();
	});

	test('rejects bad side / amount', () => {
		const db = freshDb();
		expect(() => bumpAmount(db, { side: 'nope', amountZat: 1, height: 1 })).toThrow(/bad side/);
		expect(() => bumpAmount(db, { side: 'shield', amountZat: 0, height: 1 })).toThrow(/positive integer/);
		db.close();
	});
});

// ── scanner ──────────────────────────────────────────────────────

// Build a deterministic fake chain. Each block is a getblock-verbosity-2 result
// ({ tx: [verboseTx, ...] }). The injected zecRpc serves getblockchaininfo (tip)
// and getblock by height.
function makeChain(tip, blocksByHeight) {
	return async (_url, method, params) => {
		if (method === 'getblockchaininfo') return { blocks: tip };
		if (method === 'getblock') {
			const height = Number(params[0]);
			return blocksByHeight[height] ?? { tx: [] };
		}
		throw new Error(`unexpected method ${method}`);
	};
}

const coinbase = { vin: [{ coinbase: 'aa' }], vout: [{ valueZat: 125_000_000 }], orchard: { actions: [] } };
const shield = (zec) => ({ vin: [{ txid: 'p', vout: 0 }], vout: [], orchard: { actions: [{}], valueBalanceZat: -zec * ZEC } });
const deshield = (zec) => ({ vin: [], vout: [{ valueZat: zec * ZEC }], orchard: { actions: [{}], valueBalanceZat: zec * ZEC + 10_000 } });

describe('scanShieldAmounts', () => {
	test('walks blocks, classifies, records cursor + counts', async () => {
		const db = freshDb();
		const blocks = {
			200: { tx: [coinbase, shield(1), shield(1)] },
			201: { tx: [coinbase, deshield(1)] },
			202: { tx: [coinbase, shield(10), deshield(1)] }
		};
		const zecRpc = makeChain(202, blocks);
		const summary = await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 200, zecRpc, maxBlocks: 100 });

		expect(summary.scanned_from).toBe(200);
		expect(summary.scanned_through).toBe(202);
		expect(summary.blocks).toBe(3);
		expect(summary.shield_obs).toBe(3); // 1,1,10
		expect(summary.deshield_obs).toBe(2); // 1,1
		expect(summary.caught_up).toBe(true);

		expect(exactCount(db, { side: 'shield', amountZat: 1 * ZEC })).toBe(2);
		expect(exactCount(db, { side: 'deshield', amountZat: 1 * ZEC })).toBe(2);
		expect(getCursor(db)).toEqual({ indexedFrom: 200, indexedThrough: 202 });
		db.close();
	});

	test('is incremental: a second run resumes past the cursor, no double-count', async () => {
		const db = freshDb();
		const blocks = {
			10: { tx: [shield(1)] },
			11: { tx: [shield(1)] },
			12: { tx: [shield(1)] }
		};
		// First run caps at 2 blocks.
		const s1 = await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 10, zecRpc: makeChain(12, blocks), maxBlocks: 2 });
		expect(s1.scanned_through).toBe(11);
		expect(s1.caught_up).toBe(false);
		expect(exactCount(db, { side: 'shield', amountZat: 1 * ZEC })).toBe(2);

		// Second run resumes at 12 only.
		const s2 = await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 10, zecRpc: makeChain(12, blocks), maxBlocks: 2 });
		expect(s2.scanned_from).toBe(12);
		expect(s2.scanned_through).toBe(12);
		expect(s2.caught_up).toBe(true);
		expect(exactCount(db, { side: 'shield', amountZat: 1 * ZEC })).toBe(3); // not 4 — no re-walk
		db.close();
	});

	test('nothing to do when already at tip', async () => {
		const db = freshDb();
		await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 5, zecRpc: makeChain(5, { 5: { tx: [shield(1)] } }), maxBlocks: 10 });
		const again = await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 5, zecRpc: makeChain(5, { 5: { tx: [shield(1)] } }), maxBlocks: 10 });
		expect(again.blocks).toBe(0);
		expect(again.caught_up).toBe(true);
		db.close();
	});

	test('statsSnapshot reflects the index state', async () => {
		const db = freshDb();
		await scanShieldAmounts({ rpcUrl: 'http://x', db, fromHeight: 1, zecRpc: makeChain(2, { 1: { tx: [shield(1)] }, 2: { tx: [deshield(2)] } }), maxBlocks: 10 });
		const s = statsSnapshot(db);
		expect(s.indexed_from).toBe(1);
		expect(s.indexed_through).toBe(2);
		expect(s.shield.observations).toBe(1);
		expect(s.deshield.observations).toBe(1);
		db.close();
	});
});
