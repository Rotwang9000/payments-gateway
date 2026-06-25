// HTTP integration tests for the Zcash "Bus Station" routes. The bus DB is
// injected (in-memory) so the enabled path is exercised; a null injection
// proves the opt-in 503 guard.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify from 'fastify';

import { registerZcashBusRoutes } from '../src/zcash-bus-routes.js';
import { openBusDb } from '../src/zcash-bus-store.js';

const CONFIG = Object.freeze({ zecBusEnabled: false, zecBusDbPath: ':memory:', zecBusFillTtlMs: 86_400_000, zecBusDepartWindowMs: 1_200_000 });

async function makeApp(busDb) {
	const app = Fastify({ logger: false });
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
		return reply.code(500).send({ error: { code: 'internal_error', message: err.message } });
	});
	registerZcashBusRoutes(app, { config: CONFIG, busDb });
	await app.ready();
	return app;
}
const getJson = async (app, url) => {
	const r = await app.inject({ method: 'GET', url });
	return { status: r.statusCode, body: JSON.parse(r.body) };
};
const postJson = async (app, url, payload) => {
	const r = await app.inject({ method: 'POST', url, payload });
	return { status: r.statusCode, body: JSON.parse(r.body) };
};

describe('bus routes — disabled (no DB)', () => {
	let app;
	beforeEach(async () => { app = await makeApp(null); });
	afterEach(async () => { if (app) await app.close(); });

	test('every route answers 503 bus_not_enabled', async () => {
		const list = await getJson(app, '/v1/zec/bus');
		expect(list.status).toBe(503);
		expect(list.body.error.code).toBe('bus_not_enabled');
		const join = await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 1 });
		expect(join.status).toBe(503);
	});
});

describe('bus routes — enabled (injected DB)', () => {
	let app; let db;
	beforeEach(async () => { db = openBusDb(':memory:'); app = await makeApp(db); });
	afterEach(async () => { if (app) await app.close(); if (db) db.close(); });

	test('join returns 201 + a one-time owner token + a boarding bus', async () => {
		const { status, body } = await postJson(app, '/v1/zec/bus/join', { to: 'btc.btc', amount: 1, minPassengers: 3, handle: 'HyperHacker01' });
		expect(status).toBe(201);
		expect(body.joined).toBe(true);
		expect(typeof body.owner_token).toBe('string');
		expect(body.bus.status).toBe('boarding');
		expect(body.bus.route).toBe('ZEC.ZEC>BTC.BTC');
		expect(body.bus.seats_filled).toBe(1);
		expect(body.seat.handle).toBe('HyperHacker01');
		expect(body.caveats.length).toBeGreaterThan(0);
	});

	test('join rejects a bad amount (400) and a bad route (400)', async () => {
		const badAmt = await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 1.2345 });
		expect(badAmt.status).toBe(400);
		expect(badAmt.body.error.code).toBe('invalid_request');
		const badRoute = await postJson(app, '/v1/zec/bus/join', { to: 'NOPE', amount: 1 });
		expect(badRoute.status).toBe(400);
	});

	test('list shows the bus; filter by destination works', async () => {
		await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 1 });
		await postJson(app, '/v1/zec/bus/join', { to: 'ETH.ETH', amount: 1 });
		const all = await getJson(app, '/v1/zec/bus');
		expect(all.body.buses.length).toBe(2);
		const eth = await getJson(app, '/v1/zec/bus?to=ETH.ETH');
		expect(eth.body.buses.length).toBe(1);
		expect(eth.body.buses[0].to).toBe('ETH.ETH');
	});

	test('status by id; your seat is revealed only with the matching owner token', async () => {
		const joined = await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 1 });
		const { busId } = { busId: joined.body.bus.id };
		const seatId = joined.body.seat.id;
		const token = joined.body.owner_token;

		const noTok = await getJson(app, `/v1/zec/bus/${busId}`);
		expect(noTok.status).toBe(200);
		expect(noTok.body.seat).toBeUndefined();

		const withTok = await getJson(app, `/v1/zec/bus/${busId}?seatId=${seatId}&ownerToken=${encodeURIComponent(token)}`);
		expect(withTok.body.seat.id).toBe(seatId);

		const badTok = await getJson(app, `/v1/zec/bus/${busId}?seatId=${seatId}&ownerToken=wrong`);
		expect(badTok.body.seat_error).toBeTruthy();
	});

	test('board + leave are owner-token gated', async () => {
		const joined = await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 1 });
		const seatId = joined.body.seat.id;
		const token = joined.body.owner_token;

		const bad = await postJson(app, `/v1/zec/bus/seat/${seatId}/board`, { ownerToken: 'wrong' });
		expect(bad.status).toBe(403);

		const ok = await postJson(app, `/v1/zec/bus/seat/${seatId}/board`, { ownerToken: token });
		expect(ok.status).toBe(200);
		expect(ok.body.seat.status).toBe('boarded');

		const left = await postJson(app, `/v1/zec/bus/seat/${seatId}/leave`, { ownerToken: token });
		expect(left.body.seat.status).toBe('left');
	});

	test('reaching the minimum flips the bus to ready', async () => {
		await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 0.5, minPassengers: 2 });
		const second = await postJson(app, '/v1/zec/bus/join', { to: 'BTC.BTC', amount: 0.5, minPassengers: 2 });
		expect(second.body.bus.status).toBe('ready');
		expect(second.body.bus.depart_by_ms).toBeGreaterThan(0);
	});

	test('status 404 for an unknown bus', async () => {
		const { status, body } = await getJson(app, '/v1/zec/bus/bus_does_not_exist');
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});
