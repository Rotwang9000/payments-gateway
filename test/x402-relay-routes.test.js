// HTTP integration tests for the x402 relay routes — real Fastify inject
// over a :memory: watch DB with a fake payer. Verifies the route layer
// (auth handling, status codes, receipt lookup) end to end.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify from 'fastify';

import { openWatchDb, createWatch, getWatch } from 'viewkey-watch/private-watch-store';
import { createX402RelayService } from '../src/x402-relay.js';
import { registerX402RelayRoutes } from '../src/x402-relay-routes.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function makeWatch(db) {
	return createWatch(db, {
		chain: 'monero',
		address: '4' + 'a'.repeat(94),
		viewKeyCiphertext: 'ct',
		webhookUrl: 'https://hooks.example.com/x',
		webhookSecret: 's',
		creditAtomic: 5_000_000,
		dayRateAtomic: 20_000
	});
}

describe('x402 relay routes (HTTP)', () => {
	let app;
	let db;
	let payer;
	let watch;

	beforeEach(async () => {
		app = Fastify({ logger: false });
		db = openWatchDb(':memory:');
		watch = makeWatch(db);
		payer = {
			enabled: true,
			address: '0xPayerFloat',
			network: 'eip155:8453',
			pay: jest.fn(async () => ({
				ok: true, paidAtomic: 2_000, quotedAtomic: 2_000, txHash: '0xtx',
				response: { status: 200, contentType: 'application/json', body: '{"height":9}', truncated: false }
			}))
		};
		const service = createX402RelayService({ watchDb: db, payX402: payer, getWatch, lookup: PUBLIC_LOOKUP });
		registerX402RelayRoutes(app, { service });
		await app.ready();
	});

	afterEach(async () => {
		if (app) await app.close();
		if (db) db.close();
	});

	test('GET /v1/pay returns relay metadata', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/pay' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.enabled).toBe(true);
		expect(body.payer_address).toBe('0xPayerFloat');
		expect(body.fee.model).toMatch(/greater/);
	});

	test('POST /v1/pay settles and returns a receipt', async () => {
		const res = await app.inject({
			method: 'POST', url: '/v1/pay',
			payload: { watchId: watch.id, watchToken: watch.token, url: 'https://api.example.com/v1/q', maxAmountUsd: 0.01 }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.receipt.status).toBe('settled');
		expect(body.response.status).toBe(200);
		expect(payer.pay).toHaveBeenCalledTimes(1);

		// The receipt is fetchable with the owning token.
		const got = await app.inject({ method: 'GET', url: `/v1/pay/${body.receipt.id}?watchId=${watch.id}`, headers: { 'x-watch-token': watch.token } });
		expect(got.statusCode).toBe(200);
		expect(got.json().id).toBe(body.receipt.id);
	});

	test('POST /v1/pay rejects missing auth with 400', async () => {
		const res = await app.inject({ method: 'POST', url: '/v1/pay', payload: { url: 'https://api.example.com/x' } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe('invalid_request');
	});

	test('POST /v1/pay maps a wrong token to 403', async () => {
		const res = await app.inject({
			method: 'POST', url: '/v1/pay',
			payload: { watchId: watch.id, watchToken: 'wrong', url: 'https://api.example.com/x' }
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().error.code).toBe('forbidden');
	});

	test('POST /v1/pay maps a price rejection to 422 and refunds', async () => {
		payer.pay.mockResolvedValueOnce({ ok: false, reason: 'price_exceeds_max', quotedAtomic: 9_000_000 });
		const before = getWatch(db, watch.id, watch.token).credit_atomic;
		const res = await app.inject({
			method: 'POST', url: '/v1/pay',
			payload: { watchId: watch.id, watchToken: watch.token, url: 'https://api.example.com/x', maxAmountUsd: 0.01 }
		});
		expect(res.statusCode).toBe(422);
		expect(res.json().error.code).toBe('price_exceeds_max');
		expect(getWatch(db, watch.id, watch.token).credit_atomic).toBe(before);
	});

	test('GET /v1/pay/:id requires the watch token', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/pay/some-id' });
		expect(res.statusCode).toBe(400);
	});
});
