// Route tests for the donation overlay — Fastify-injected against a
// :memory: DB with a stubbed price oracle and NFPT health. Funding is
// simulated by calling the poller's credit applier directly (as the
// receive-poller would on a confirmed ZEC payment).

import { describe, test, expect, beforeEach } from '@jest/globals';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

import { ensureCryptoTopupSchema, getQuote } from 'viewkey-watch/crypto-topup-store';

import { registerDonationOverlayRoutes, validateOverlayCreateRequest } from '../src/donation-overlay-routes.js';
import { ensureDonationOverlaySchema, getOverlay, recordDonationEvent } from '../src/donation-overlay-store.js';
import { makeOverlayCreditApplier } from '../src/donation-overlay-poller.js';

const NOW = 1_700_000_000_000;
const silentLog = { info() {}, warn() {}, error() {} };
const POLICY = Object.freeze({
	minUsdCents: 200,
	maxUsdCents: 50_000,
	spreadBps: 400,
	quoteTtlSec: 900,
	confirmations: { zcash: 8, monero: 10 }
});
const UFVK = `uview1${'x'.repeat(80)}`;

function stubOracle(usd = 50) {
	return { getUsdPrice: async () => ({ usd, source: 'stub', asOfMs: 1 }) };
}

function openDb() {
	const db = new Database(':memory:');
	ensureDonationOverlaySchema(db);
	ensureCryptoTopupSchema(db);
	return db;
}

function buildApp(db, over = {}) {
	const app = Fastify();
	registerDonationOverlayRoutes(app, {
		watchDb: db,
		priceOracle: over.priceOracle ?? stubOracle(),
		recvAddresses: 'recvAddresses' in over ? over.recvAddresses : { zcash: 'u1ourreceiver' },
		policy: POLICY,
		memoPrefix: 'PG',
		encryptViewKey: 'encryptViewKey' in over ? over.encryptViewKey : (ufvk) => `ct:${ufvk.slice(0, 12)}`,
		nfptHealth: over.nfptHealth ?? (async () => ({ ok: true })),
		overlayPageUrlBase: over.overlayPageUrlBase ?? 'https://example.com/donation-overlay.html',
		privateWatchReady: over.privateWatchReady ?? (() => true),
		privateNotConfigured: (reply) => {
			reply.code(503).send({ error: { code: 'private_watch_not_configured', message: 'not configured' } });
			return reply;
		},
		log: silentLog,
		now: () => NOW
	});
	return app;
}

async function register(app, body = {}) {
	return app.inject({
		method: 'POST',
		url: '/v1/overlay',
		payload: { ufvk: UFVK, address: 'u1streamer', label: 'Testy', ...body }
	});
}

describe('validateOverlayCreateRequest', () => {
	test('accepts a UFVK + address and normalises the extras', () => {
		const out = validateOverlayCreateRequest(
			{ ufvk: UFVK, address: 'u1abc', label: '  Testy  ', minZec: 0.05, amountUsdCents: 300 },
			POLICY
		);
		expect(out.ufvk).toBe(UFVK);
		expect(out.label).toBe('Testy');
		expect(out.minZatoshi).toBe('5000000');
		expect(out.amountUsdCents).toBe(300);
		expect(out.birthdayHeight).toBe(3_042_000); // NU6 default
	});

	test('rejects bad UFVKs, addresses and amounts', () => {
		expect(() => validateOverlayCreateRequest({ ufvk: 'not-a-key', address: 'u1a' }, POLICY)).toThrow(/UFVK/);
		expect(() => validateOverlayCreateRequest({ ufvk: UFVK, address: 'bc1qwrong' }, POLICY)).toThrow(/address/);
		expect(() => validateOverlayCreateRequest({ ufvk: UFVK, address: 'u1a', amountUsdCents: 1 }, POLICY)).toThrow(/out of range/);
		expect(() => validateOverlayCreateRequest({ ufvk: UFVK, address: 'u1a', minZec: -1 }, POLICY)).toThrow(/minZec/);
	});
});

describe('registration', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('201: returns overlay id, one-shot owner token, URLs and a ZEC funding quote', async () => {
		const app = buildApp(db);
		const res = await register(app);
		expect(res.statusCode).toBe(201);
		const b = res.json();
		expect(b.overlayId).toMatch(/^ov_/);
		expect(typeof b.ownerToken).toBe('string');
		expect(b.urls.events).toBe(`/v1/overlay/${b.overlayId}/events`);
		expect(b.urls.obsPage).toContain(b.overlayId);
		expect(b.payment.payTo).toBe('u1ourreceiver');
		expect(b.payment.memo).toMatch(/^PG-/);
		expect(b.payment.amount.coin).toBe('ZEC');
		// UFVK is stored encrypted, never echoed back.
		expect(JSON.stringify(b)).not.toContain(UFVK);
		expect(getOverlay(db, b.overlayId).ufvk_ct).toBe(`ct:${UFVK.slice(0, 12)}`);
		await app.close();
	});

	test('the funding quote settles through the overlay credit applier', async () => {
		const app = buildApp(db);
		const b = (await register(app, { amountUsdCents: 500 })).json();
		const quote = getQuote(db, b.payment.quoteId);
		expect(quote.watch_id).toBe(b.overlayId);
		const before = getOverlay(db, b.overlayId).credit_atomic;
		const out = makeOverlayCreditApplier(db)({ watchId: quote.watch_id, usdCents: 500 });
		expect(out.ok).toBe(true);
		expect(getOverlay(db, b.overlayId).credit_atomic).toBe(before + 5_000_000);
		await app.close();
	});

	test('gates: 400 bad body, 502 NFPT down, 503 unconfigured', async () => {
		const app = buildApp(db);
		expect((await register(app, { ufvk: 'junk' })).statusCode).toBe(400);
		await app.close();

		const down = buildApp(openDb(), { nfptHealth: async () => ({ ok: false }) });
		expect((await register(down)).statusCode).toBe(502);
		await down.close();

		const noZec = buildApp(openDb(), { recvAddresses: { zcash: '' } });
		expect((await register(noZec)).statusCode).toBe(503);
		await noZec.close();

		const noKey = buildApp(openDb(), { encryptViewKey: null });
		expect((await register(noKey)).statusCode).toBe(503);
		await noKey.close();
	});
});

describe('public surface', () => {
	let db;
	let app;
	let created;
	beforeEach(async () => {
		db = openDb();
		app = buildApp(db);
		created = (await register(app)).json();
	});

	test('GET /v1/overlay is free metadata with stats', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/overlay' });
		expect(res.statusCode).toBe(200);
		expect(res.json().stats.overlays_total).toBe(1);
		await app.close();
	});

	test('GET /v1/overlay/:id is public status without secrets', async () => {
		const res = await app.inject({ method: 'GET', url: `/v1/overlay/${created.overlayId}` });
		expect(res.statusCode).toBe(200);
		const b = res.json();
		expect(b.label).toBe('Testy');
		expect(b.state).toBe('active');
		expect(JSON.stringify(b)).not.toContain('ct:');
		expect((await app.inject({ method: 'GET', url: '/v1/overlay/ov_missing' })).statusCode).toBe(404);
		await app.close();
	});

	test('GET /v1/overlay/:id/owner gates on the owner token', async () => {
		const bad = await app.inject({
			method: 'GET',
			url: `/v1/overlay/${created.overlayId}/owner`,
			headers: { 'x-overlay-token': 'wrong' }
		});
		expect(bad.statusCode).toBe(403);
		const ok = await app.inject({
			method: 'GET',
			url: `/v1/overlay/${created.overlayId}/owner`,
			headers: { 'x-overlay-token': created.ownerToken }
		});
		expect(ok.statusCode).toBe(200);
		expect(ok.json().ok).toBe(true);
		expect(ok.json().overlay.overlayId).toBe(created.overlayId);
		await app.close();
	});

	test('events feed pages by cursor and hides suppressed rows', async () => {
		recordDonationEvent(db, { overlayId: created.overlayId, txHash: 'base', amountAtomic: '1', blockHeight: 1, suppressed: true, nowMs: NOW });
		recordDonationEvent(db, { overlayId: created.overlayId, txHash: 'don', amountAtomic: '50000000', memo: 'hi!', blockHeight: 2, nowMs: NOW });
		const res = await app.inject({ method: 'GET', url: `/v1/overlay/${created.overlayId}/events` });
		const b = res.json();
		expect(b.events).toHaveLength(1);
		expect(b.events[0]).toMatchObject({ amountZec: 0.5, memo: 'hi!', status: 'seen' });
		const again = await app.inject({ method: 'GET', url: `/v1/overlay/${created.overlayId}/events?sinceId=${b.cursor}` });
		expect(again.json().events).toHaveLength(0);
		await app.close();
	});
});

describe('owner surface', () => {
	let db;
	let app;
	let created;
	beforeEach(async () => {
		db = openDb();
		app = buildApp(db);
		created = (await register(app)).json();
	});

	test('top-up mints a fresh quote with the owner token; 403 otherwise', async () => {
		const bad = await app.inject({
			method: 'POST', url: `/v1/overlay/${created.overlayId}/topup`,
			headers: { 'x-overlay-token': 'wrong' }, payload: { amountUsdCents: 300 }
		});
		expect(bad.statusCode).toBe(403);
		const ok = await app.inject({
			method: 'POST', url: `/v1/overlay/${created.overlayId}/topup`,
			headers: { 'x-overlay-token': created.ownerToken }, payload: { amountUsdCents: 300 }
		});
		expect(ok.statusCode).toBe(201);
		expect(ok.json().credit.usdCents).toBe(300);
		await app.close();
	});

	test('quote status honours the owner token', async () => {
		const quoteId = created.payment.quoteId;
		const forbidden = await app.inject({ method: 'GET', url: `/v1/overlay/quote/${quoteId}`, headers: { 'x-overlay-token': 'wrong' } });
		expect(forbidden.statusCode).toBe(403);
		const ok = await app.inject({ method: 'GET', url: `/v1/overlay/quote/${quoteId}`, headers: { 'x-overlay-token': created.ownerToken } });
		expect(ok.statusCode).toBe(200);
		expect(ok.json().status).toBe('pending');
		await app.close();
	});

	test('cancel with the owner token; topping up a cancelled overlay is refused', async () => {
		const del = await app.inject({ method: 'DELETE', url: `/v1/overlay/${created.overlayId}`, headers: { 'x-overlay-token': created.ownerToken } });
		expect(del.statusCode).toBe(200);
		expect(getOverlay(db, created.overlayId).cancelled).toBe(1);
		const topup = await app.inject({
			method: 'POST', url: `/v1/overlay/${created.overlayId}/topup`,
			headers: { 'x-overlay-token': created.ownerToken }, payload: {}
		});
		expect(topup.statusCode).toBe(409);
		await app.close();
	});
});
