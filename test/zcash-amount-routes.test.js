// HTTP integration tests for the free Zcash amount-privacy routes:
//   GET /v1/zec/amount-advice, /v1/zec/split-plan, /v1/zec/popular-amounts
// The index DB is injected (in-memory) so the live-vs-bundled branches are both
// exercised without a zebra node.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify from 'fastify';

import { registerZcashAmountRoutes } from '../src/zcash-amount-routes.js';
import { openShieldIndexDb, bumpAmount } from '../src/zcash-shield-index.js';

const CONFIG = Object.freeze({ zecShieldIndexEnabled: false, zecShieldIndexDbPath: ':memory:' });
const ZAT = 100_000_000;

async function makeApp(indexDb) {
	const app = Fastify({ logger: false });
	registerZcashAmountRoutes(app, { config: CONFIG, indexDb });
	await app.ready();
	return app;
}
const getJson = async (app, url) => {
	const r = await app.inject({ method: 'GET', url });
	return { status: r.statusCode, body: JSON.parse(r.body) };
};

describe('zcash amount routes — bundled (no index)', () => {
	let app;
	beforeEach(async () => { app = await makeApp(null); });
	afterEach(async () => { if (app) await app.close(); });

	test('GET /v1/zec/amount-advice returns risk + suggestions', async () => {
		const { status, body } = await getJson(app, '/v1/zec/amount-advice?amount=1&action=deshield&notes=1,5');
		expect(status).toBe(200);
		expect(body.amount_zats).toBe(ZAT);
		expect(body.blend_in_source).toBe('bundled_list');
		expect(body.risk.level).toBe('warn'); // 1 matches a pasted note
		expect(body.suggestions.length).toBeGreaterThan(0);
	});

	test('GET /v1/zec/amount-advice rejects a bad amount with 400', async () => {
		const { status, body } = await getJson(app, '/v1/zec/amount-advice?amount=nope');
		expect(status).toBe(400);
		expect(body.error.code).toBe('invalid_request');
	});

	test('GET /v1/zec/split-plan splits a large amount into blend-in pieces', async () => {
		const { status, body } = await getJson(app, '/v1/zec/split-plan?amount=17.3');
		expect(status).toBe(200);
		expect(body.action).toBe('deshield');
		expect(body.exact).toBe(true);
		expect(body.pieceCount).toBe(5);
		expect(body.source).toBe('bundled_list');
		expect(body.cautions.length).toBeGreaterThan(0);
	});

	test('GET /v1/zec/split-plan honours maxPieces (partial remainder)', async () => {
		const { body } = await getJson(app, '/v1/zec/split-plan?amount=88&maxPieces=2');
		expect(body.pieceCount).toBe(2);
		expect(body.exact).toBe(false);
		expect(body.remainder.zec).toBe(13);
		expect(body.effectiveness.level).toBe('partial');
	});

	test('GET /v1/zec/split-plan rejects a bad amount with 400', async () => {
		const { status } = await getJson(app, '/v1/zec/split-plan?amount=0');
		expect(status).toBe(400);
	});

	test('GET /v1/zec/popular-amounts falls back to the bundled list', async () => {
		const { status, body } = await getJson(app, '/v1/zec/popular-amounts?side=shield');
		expect(status).toBe(200);
		expect(body.source).toBe('bundled_list');
		expect(body.amounts.length).toBeGreaterThan(0);
		expect(body.amounts.every((a) => a.count === null)).toBe(true);
	});
});

describe('zcash amount routes — live index injected', () => {
	let app;
	let db;
	beforeEach(async () => {
		db = openShieldIndexDb(':memory:');
		// Seed: three 1-ZEC and three 0.5-ZEC deshields (>= the min count of 3).
		for (let i = 0; i < 3; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 1 * ZAT, height: 100 + i });
		for (let i = 0; i < 3; i += 1) bumpAmount(db, { side: 'deshield', amountZat: 0.5 * ZAT, height: 110 + i });
		app = await makeApp(db);
	});
	afterEach(async () => { if (app) await app.close(); if (db) db.close(); });

	test('popular-amounts reports live_index with real counts', async () => {
		const { body } = await getJson(app, '/v1/zec/popular-amounts?side=deshield');
		expect(body.source).toBe('live_index');
		const one = body.amounts.find((a) => a.zec === 1);
		expect(one.count).toBe(3);
		expect(body.stats).toBeTruthy();
	});

	test('amount-advice annotates others_used_exact from the index', async () => {
		const { body } = await getJson(app, '/v1/zec/amount-advice?amount=1&action=deshield');
		expect(body.blend_in_source).toBe('live_index');
		expect(body.others_used_exact).toBe(3);
	});

	test('split-plan uses the live denominations', async () => {
		const { body } = await getJson(app, '/v1/zec/split-plan?amount=2.5&action=deshield');
		expect(body.source).toBe('live_index');
		// Only 1 and 0.5 are popular → 2 × 1 + 1 × 0.5
		expect(body.pieces.map((g) => g.zec)).toEqual([1, 0.5]);
		expect(body.exact).toBe(true);
	});
});
