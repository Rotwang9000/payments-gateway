// Route tests for paid unlock — Fastify-injected against a :memory: DB with a
// stubbed price oracle + facilitator. Native payment is simulated by calling
// the store's markOrderPaid directly (as the receive-poller would). Asserts
// the full flow: create → order/buy → pay → claim → secret, plus the gates.

import { describe, test, expect, beforeEach } from '@jest/globals';
import Fastify from 'fastify';

import { parseMasterKey } from 'viewkey-watch/private-watch-crypto';

import { registerPaidUnlockRoutes } from '../src/paid-unlock-routes.js';
import { openUnlockDb, markOrderPaid } from '../src/paid-unlock-store.js';

const MASTER_KEY = parseMasterKey('a'.repeat(64));
const SECRET = JSON.stringify({ key: 'k_9f2b', url: 'https://cdn.example/f.enc', name: 'report.pdf' });
const silentLog = { info() {}, warn() {}, error() {} };

const X402_ON = Object.freeze({ enabled: true, network: 'eip155:8453', recipient: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 120 });

function okFacilitator() {
	return { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: '0xfeed' }) };
}

function stubOracle(prices = { zcash: 50, monero: 200 }) {
	return { getUsdPrice: async (coin) => ({ usd: prices[coin], source: 'stub', asOfMs: 1 }) };
}

function buildApp(db, over = {}) {
	const app = Fastify();
	registerPaidUnlockRoutes(app, {
		unlockDb: db,
		masterKey: 'masterKey' in over ? over.masterKey : MASTER_KEY,
		x402Cfg: 'x402Cfg' in over ? over.x402Cfg : X402_ON,
		priceOracle: over.priceOracle ?? stubOracle(),
		recvAddresses: over.recvAddresses ?? { zcash: 'u1zcashreceiver', monero: '4'.repeat(95) },
		policy: { spreadBps: 400, confirmations: { zcash: 8, monero: 10 }, orderTtlSec: 1_800 },
		memoPrefix: 'WB',
		facilitatorFactory: over.facilitatorFactory ?? (async () => okFacilitator()),
		log: silentLog,
		now: over.now ?? (() => 1_000_000)
	});
	return app;
}

async function createListing(app, body = {}) {
	const res = await app.inject({
		method: 'POST', url: '/v1/unlock/listing',
		payload: { title: 'Secret report', description: 'A PDF', secret: SECRET, priceUsdCents: 500, ...body }
	});
	return res;
}

describe('listing lifecycle', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	test('create returns a listing + owner token and never leaks the secret', async () => {
		const app = buildApp(db);
		const res = await createListing(app);
		expect(res.statusCode).toBe(201);
		const b = res.json();
		expect(b.id).toMatch(/^ul_/);
		expect(typeof b.ownerToken).toBe('string');
		expect(b.price).toMatchObject({ usd: '$5.00', usdCents: 500 });
		expect(b.pay.native_chains).toEqual(['zcash', 'monero']);
		expect(b.pay.usdc_x402).toBe(true);
		expect(JSON.stringify(b)).not.toContain('report.pdf'); // secret stays sealed
		await app.close();
	});

	test('public GET shows the listing without the secret; 404 unknown', async () => {
		const app = buildApp(db);
		const id = (await createListing(app)).json().id;
		const got = await app.inject({ method: 'GET', url: `/v1/unlock/listing/${id}` });
		expect(got.statusCode).toBe(200);
		expect(got.json().secret).toBeUndefined();
		const missing = await app.inject({ method: 'GET', url: '/v1/unlock/listing/ul_nope' });
		expect(missing.statusCode).toBe(404);
		await app.close();
	});

	test('validation: missing secret / bad price → 400', async () => {
		const app = buildApp(db);
		expect((await createListing(app, { secret: undefined })).statusCode).toBe(400);
		expect((await createListing(app, { priceUsdCents: 1 })).statusCode).toBe(400);
		await app.close();
	});

	test('not configured (no master key) → 503', async () => {
		const app = buildApp(db, { masterKey: null });
		const res = await createListing(app);
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe('paid_unlock_not_configured');
		await app.close();
	});

	test('withdraw with the owner token; wrong token → 403', async () => {
		const app = buildApp(db);
		const created = (await createListing(app)).json();
		const bad = await app.inject({ method: 'DELETE', url: `/v1/unlock/listing/${created.id}`, headers: { 'x-unlock-token': 'nope' } });
		expect(bad.statusCode).toBe(403);
		const ok = await app.inject({ method: 'DELETE', url: `/v1/unlock/listing/${created.id}`, headers: { 'x-unlock-token': created.ownerToken } });
		expect(ok.statusCode).toBe(200);
		expect((await app.inject({ method: 'GET', url: `/v1/unlock/listing/${created.id}` })).statusCode).toBe(404);
		await app.close();
	});
});

describe('public shop feed (discovery)', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	test('unlisted by default → not in the feed; public → shown without the secret', async () => {
		const app = buildApp(db);
		await createListing(app, { title: 'Hidden one' }); // default unlisted
		const pub = (await createListing(app, { title: 'Public one', visibility: 'public' })).json();

		const feed = await app.inject({ method: 'GET', url: '/v1/unlock/listings' });
		expect(feed.statusCode).toBe(200);
		const body = feed.json();
		const ids = body.listings.map((l) => l.id);
		expect(ids).toContain(pub.id);
		expect(body.listings.every((l) => l.title !== 'Hidden one')).toBe(true);
		expect(JSON.stringify(body)).not.toContain('report.pdf'); // never the secret
		expect(body.listings.find((l) => l.id === pub.id).visibility).toBe('public');
		await app.close();
	});

	test('invalid visibility → 400', async () => {
		const app = buildApp(db);
		const res = await createListing(app, { visibility: 'everyone' });
		expect(res.statusCode).toBe(400);
		await app.close();
	});

	test('limit is clamped and paging is reported', async () => {
		const app = buildApp(db);
		for (let i = 0; i < 3; i += 1) await createListing(app, { title: `Pub ${i}`, visibility: 'public' });
		const feed = await app.inject({ method: 'GET', url: '/v1/unlock/listings?limit=2' });
		const body = feed.json();
		expect(body.listings.length).toBe(2);
		expect(body.paging).toMatchObject({ limit: 2, offset: 0, count: 2 });
		await app.close();
	});

	test('withdrawn/expired public listings drop out of the feed', async () => {
		const app = buildApp(db);
		const pub = (await createListing(app, { title: 'Soon gone', visibility: 'public' })).json();
		await app.inject({ method: 'DELETE', url: `/v1/unlock/listing/${pub.id}`, headers: { 'x-unlock-token': pub.ownerToken } });
		const feed = await app.inject({ method: 'GET', url: '/v1/unlock/listings' });
		expect(feed.json().listings.map((l) => l.id)).not.toContain(pub.id);
		await app.close();
	});
});

describe('native ZEC/XMR order → pay → claim', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	test('full flow: order, unpaid claim 402, pay, claim secret, over-limit 409', async () => {
		const app = buildApp(db);
		const id = (await createListing(app)).json().id;

		const order = await app.inject({ method: 'POST', url: `/v1/unlock/listing/${id}/order`, payload: { chain: 'zcash' } });
		expect(order.statusCode).toBe(201);
		const o = order.json();
		expect(o.orderId).toMatch(/^uo_/);
		expect(o.payTo).toBe('u1zcashreceiver');
		expect(o.memo).toMatch(/^WB-/);
		expect(o.amount.coin).toBe('ZEC');
		expect(o.status).toBe('pending');
		expect(typeof o.claimToken).toBe('string');

		// status gated by claim token
		const status = await app.inject({ method: 'GET', url: `/v1/unlock/order/${o.orderId}`, headers: { 'x-claim-token': o.claimToken } });
		expect(status.json().status).toBe('pending');
		expect((await app.inject({ method: 'GET', url: `/v1/unlock/order/${o.orderId}`, headers: { 'x-claim-token': 'wrong' } })).statusCode).toBe(403);

		// claim before payment → 402
		const early = await app.inject({ method: 'POST', url: `/v1/unlock/order/${o.orderId}/claim`, headers: { 'x-claim-token': o.claimToken } });
		expect(early.statusCode).toBe(402);

		// receive-poller confirms the payment
		markOrderPaid(db, o.orderId, { txid: 'zectx', seenAtomic: o.amount.atomic, nowMs: 1_000_001 });

		// claim now delivers the (decrypted) secret, up to claim_max (3)
		for (let i = 0; i < 3; i += 1) {
			const c = await app.inject({ method: 'POST', url: `/v1/unlock/order/${o.orderId}/claim`, headers: { 'x-claim-token': o.claimToken } });
			expect(c.statusCode).toBe(200);
			expect(c.json().secret).toBe(SECRET);
		}
		const over = await app.inject({ method: 'POST', url: `/v1/unlock/order/${o.orderId}/claim`, headers: { 'x-claim-token': o.claimToken } });
		expect(over.statusCode).toBe(409);
		expect(over.json().error.code).toBe('claim_limit_reached');
		await app.close();
	});

	test('chain not accepted by the listing → 503', async () => {
		const app = buildApp(db);
		const id = (await createListing(app, { payChains: ['zcash'] })).json().id;
		const res = await app.inject({ method: 'POST', url: `/v1/unlock/listing/${id}/order`, payload: { chain: 'monero' } });
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe('chain_not_accepted');
		await app.close();
	});

	test('order on unknown listing → 404; bad chain → 400', async () => {
		const app = buildApp(db);
		expect((await app.inject({ method: 'POST', url: '/v1/unlock/listing/ul_nope/order', payload: { chain: 'zcash' } })).statusCode).toBe(404);
		const id = (await createListing(app)).json().id;
		expect((await app.inject({ method: 'POST', url: `/v1/unlock/listing/${id}/order`, payload: { chain: 'usdc' } })).statusCode).toBe(400);
		await app.close();
	});
});

describe('instant USDC buy (x402)', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	function xPaymentHeader(amountAtomic) {
		const payload = { payload: { authorization: { value: String(amountAtomic) } } };
		return Buffer.from(JSON.stringify(payload)).toString('base64');
	}

	test('402 challenge without payment, then 200 + secret on settle', async () => {
		const app = buildApp(db);
		const id = (await createListing(app)).json().id;

		const challenge = await app.inject({ method: 'POST', url: `/v1/unlock/listing/${id}/buy` });
		expect(challenge.statusCode).toBe(402);
		expect(challenge.headers['payment-required']).toBeTruthy();

		const paid = await app.inject({
			method: 'POST', url: `/v1/unlock/listing/${id}/buy`,
			headers: { 'x-payment': xPaymentHeader(5_000_000) } // $5.00 → 5_000_000 atomic USDC
		});
		expect(paid.statusCode).toBe(200);
		const b = paid.json();
		expect(b.secret).toBe(SECRET);
		expect(typeof b.claimToken).toBe('string');
		expect(b.chain).toBe('usdc');
		await app.close();
	});

	test('amount mismatch → 400', async () => {
		const app = buildApp(db);
		const id = (await createListing(app)).json().id;
		const res = await app.inject({
			method: 'POST', url: `/v1/unlock/listing/${id}/buy`,
			headers: { 'x-payment': xPaymentHeader(123) }
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe('amount_mismatch');
		await app.close();
	});

	test('buy with the paywall disabled → 503', async () => {
		const app = buildApp(db, { x402Cfg: { enabled: false } });
		const id = (await createListing(app)).json().id;
		const res = await app.inject({ method: 'POST', url: `/v1/unlock/listing/${id}/buy` });
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe('paywall_not_configured');
		await app.close();
	});
});
