// Route tests for Ziving campaign pages.

import { describe, test, expect, beforeEach } from '@jest/globals';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

import { ensureCryptoTopupSchema } from 'viewkey-watch/crypto-topup-store';

import { registerZivingRoutes, validateZivingPageRequest } from '../src/ziving-routes.js';
import {
	ensureDonationOverlaySchema,
	getOverlayBySlug,
	recordDonationEvent
} from '../src/donation-overlay-store.js';

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
const ADDR = `u1${'y'.repeat(80)}`;

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
	registerZivingRoutes(app, {
		watchDb: db,
		priceOracle: over.priceOracle ?? stubOracle(),
		recvAddresses: 'recvAddresses' in over ? over.recvAddresses : { zcash: 'u1ourreceiver' },
		policy: POLICY,
		memoPrefix: 'PG',
		encryptViewKey: over.encryptViewKey ?? ((ufvk) => `ct:${ufvk.slice(0, 12)}`),
		nfptHealth: over.nfptHealth ?? (async () => ({ ok: true })),
		zivingPageUrlBase: over.zivingPageUrlBase ?? 'https://ziving.org',
		overlayPageUrlBase: over.overlayPageUrlBase ?? 'https://ziving.org/overlay.html',
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

async function createPage(app, body = {}) {
	const res = await app.inject({
		method: 'POST',
		url: '/v1/ziving/page',
		payload: {
			slug: 'alice-run',
			label: 'Alice runs for cats',
			story: 'Help me raise ZEC for the shelter.',
			goalZec: 10,
			ufvk: UFVK,
			address: ADDR,
			amountUsdCents: 500,
			...body
		}
	});
	return res;
}

describe('validateZivingPageRequest', () => {
	test('requires slug and normalises it', () => {
		const out = validateZivingPageRequest({
			slug: '  Alice-Run  ',
			ufvk: UFVK,
			address: ADDR,
			amountUsdCents: 500
		}, POLICY);
		expect(out.slug).toBe('alice-run');
	});

	test('rejects short slug', () => {
		expect(() => validateZivingPageRequest({ slug: 'ab', ufvk: UFVK, address: ADDR }, POLICY))
			.toThrow(/slug must be/);
	});
});

describe('ziving routes', () => {
	let db;
	let app;

	beforeEach(async () => {
		db = openDb();
		app = buildApp(db);
		await app.ready();
	});

	test('GET /v1/ziving returns metadata', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/ziving' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.service).toBe('ziving');
		expect(body.winbit32.createVault).toContain('createvault.exe');
	});

	test('POST /v1/ziving/page creates campaign with payment quote', async () => {
		const res = await createPage(app);
		expect(res.statusCode).toBe(201);
		const body = res.json();
		expect(body.slug).toBe('alice-run');
		expect(body.ownerToken).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(body.overlayId).toMatch(/^ov_/u);
		expect(body.payment.payTo).toBe('u1ourreceiver');
		expect(body.urls.page).toBe('https://ziving.org/p/alice-run');
		expect(body.page.goalZec).toBe(10);
		expect(body.page.story).toContain('shelter');
		const row = getOverlayBySlug(db, 'alice-run');
		expect(row).toBeTruthy();
		expect(row.ufvk_ct).toContain('ct:');
	});

	test('GET /v1/ziving/page/:slug returns public page with totals', async () => {
		await createPage(app);
		recordDonationEvent(db, {
			overlayId: getOverlayBySlug(db, 'alice-run').id,
			amountAtomic: '25000000',
			memo: 'Go Alice!',
			confirmed: true,
			nowMs: NOW
		});
		const res = await app.inject({ method: 'GET', url: '/v1/ziving/page/alice-run' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.raised.zec).toBe(0.25);
		expect(body.raised.donationCount).toBe(1);
		expect(body.raised.percentOfGoal).toBe(2.5);
		expect(body.address).toBe(ADDR);
		expect(body.ufvk).toBeUndefined();
	});

	test('GET /v1/ziving/page/:slug/events returns donation feed', async () => {
		await createPage(app);
		const overlayId = getOverlayBySlug(db, 'alice-run').id;
		recordDonationEvent(db, {
			overlayId,
			amountAtomic: '10000000',
			memo: 'hi',
			confirmed: true,
			nowMs: NOW
		});
		const res = await app.inject({ method: 'GET', url: '/v1/ziving/page/alice-run/events' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.events).toHaveLength(1);
		expect(body.events[0].amountZec).toBe(0.1);
		expect(body.events[0].memo).toBe('hi');
	});

	test('duplicate slug returns 409', async () => {
		await createPage(app);
		const res = await createPage(app);
		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe('slug_taken');
	});

	test('unknown slug returns 404', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/ziving/page/nobody-here' });
		expect(res.statusCode).toBe(404);
	});
});
