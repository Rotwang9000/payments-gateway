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
		decryptViewKey: over.decryptViewKey ?? ((ct) => String(ct).replace(/^ct:/u, '')),
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

	test('creation demands at least 5 characters (reads still allow 3)', () => {
		expect(() => validateZivingPageRequest({ slug: 'abcd', ufvk: UFVK, address: ADDR, amountUsdCents: 500 }, POLICY))
			.toThrow(/at least 5 characters/);
		const ok = validateZivingPageRequest({ slug: 'abcde', ufvk: UFVK, address: ADDR, amountUsdCents: 500 }, POLICY);
		expect(ok.slug).toBe('abcde');
	});

	test('rejects reserved slugs (site routes + service impersonation)', () => {
		for (const slug of ['manage', 'ziving', 'zcash', 'admin', 'overlay']) {
			expect(() => validateZivingPageRequest({ slug, ufvk: UFVK, address: ADDR, amountUsdCents: 500 }, POLICY))
				.toThrow(/reserved/);
		}
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

	test('GET /v1/ziving/activity lists recent confirmed gifts and newest pages', async () => {
		await createPage(app);
		const overlayId = getOverlayBySlug(db, 'alice-run').id;
		recordDonationEvent(db, {
			overlayId,
			amountAtomic: '25000000',
			memo: 'go alice',
			confirmed: true,
			nowMs: NOW
		});
		// Unconfirmed ('seen') gifts must not leak into the public feed.
		recordDonationEvent(db, {
			overlayId,
			amountAtomic: '5000000',
			confirmed: false,
			nowMs: NOW
		});

		const res = await app.inject({ method: 'GET', url: '/v1/ziving/activity' });
		expect(res.statusCode).toBe(200);
		const body = res.json();

		expect(body.donations).toHaveLength(1);
		expect(body.donations[0]).toMatchObject({
			slug: 'alice-run',
			label: 'Alice runs for cats',
			amountZec: 0.25,
			memo: 'go alice',
			pageUrl: 'https://ziving.org/p/alice-run'
		});

		expect(body.pages).toHaveLength(1);
		expect(body.pages[0].slug).toBe('alice-run');
		expect(body.pages[0].raised.zec).toBe(0.25);
		expect(body.pages[0].urls.page).toBe('https://ziving.org/p/alice-run');
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

	test('GET /v1/ziving includes feature pricing', async () => {
		const res = await app.inject({ method: 'GET', url: '/v1/ziving' });
		const body = res.json();
		expect(Number(body.pricing.scan_rate_per_day_usd)).toBe(0.1);
		expect(Number(body.pricing.feature_rate_per_day_usd)).toBe(5);
		expect(body.mcp.note).toContain('ziving');
	});

	test('feature quote + settle appears on GET /featured', async () => {
		const { applyFeaturePurchase, featureUsdCentsForDays, getOverlayBySlug: bySlug } = await import('../src/donation-overlay-store.js');
		const created = await createPage(app);
		const { ownerToken, slug } = created.json();

		const bad = await app.inject({
			method: 'POST',
			url: `/v1/ziving/page/${slug}/feature`,
			payload: { days: 3 },
			headers: { 'x-overlay-token': 'wrong' }
		});
		expect(bad.statusCode).toBe(403);

		const ok = await app.inject({
			method: 'POST',
			url: `/v1/ziving/page/${slug}/feature`,
			payload: { days: 3 },
			headers: { 'x-overlay-token': ownerToken }
		});
		expect(ok.statusCode).toBe(201);
		const quote = ok.json();
		expect(quote.days).toBe(3);
		expect(quote.product).toBe('homepage_feature');
		expect(quote.payment.memo).toMatch(/^PGF/u);

		const usdCents = featureUsdCentsForDays(3);
		expect(usdCents).toBe(1500);
		const row = bySlug(db, slug);
		const settled = applyFeaturePurchase(db, row.id, { usdCents, nowMs: NOW });
		expect(settled.ok).toBe(true);
		expect(settled.featuredUntilMs).toBe(NOW + 3 * 86_400_000);

		const feat = await app.inject({ method: 'GET', url: '/v1/ziving/featured' });
		expect(feat.statusCode).toBe(200);
		const list = feat.json();
		expect(list.count).toBe(1);
		expect(list.campaigns[0].slug).toBe(slug);
		expect(list.campaigns[0].featured).toBe(true);
	});
});

describe('ziving auth: recovery codes, wallet login, paid lost-key recovery', () => {
	let db;
	let app;

	beforeEach(async () => {
		db = openDb();
		app = buildApp(db);
		await app.ready();
	});

	test('create returns a recovery code and stores hash + UFVK fingerprint', async () => {
		const res = await createPage(app);
		expect(res.statusCode).toBe(201);
		const body = res.json();
		expect(body.recoveryCode).toMatch(/^zrk-/u);
		const row = getOverlayBySlug(db, 'alice-run');
		expect(row.recovery_code_hash).toMatch(/^[0-9a-f]{64}$/u);
		expect(row.ufvk_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
		expect(body.recoveryCode).not.toBe(row.recovery_code_hash);
	});

	test('wallet login lists this wallet\'s pages and issues a working session token', async () => {
		await createPage(app);
		await createPage(app, { slug: 'alice-swim', label: 'Alice swims' });

		const miss = await app.inject({
			method: 'POST', url: '/v1/ziving/wallet/login', payload: { ufvk: `uview1${'z'.repeat(80)}` }
		});
		expect(miss.statusCode).toBe(404);

		const res = await app.inject({ method: 'POST', url: '/v1/ziving/wallet/login', payload: { ufvk: UFVK } });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.sessionToken).toMatch(/^zses_/u);
		expect(body.pages.map((p) => p.slug).sort()).toEqual(['alice-run', 'alice-swim']);

		// Session token authorises manage endpoints exactly like the owner token.
		const feat = await app.inject({
			method: 'POST',
			url: '/v1/ziving/page/alice-run/feature',
			payload: { days: 1 },
			headers: { 'x-overlay-token': body.sessionToken }
		});
		expect(feat.statusCode).toBe(201);
	});

	test('a bare UFVK no longer rotates the owner token via /recover', async () => {
		await createPage(app);
		const res = await app.inject({
			method: 'POST',
			url: '/v1/ziving/page/alice-run/recover',
			payload: { ufvk: UFVK }
		});
		expect(res.statusCode).toBe(403);
	});

	test('lost-key flow: code → paid quote → claim rotates token + code', async () => {
		const { applyRecoveryUnlock: unlock, OVERLAY_CONSTANTS: C } = await import('../src/donation-overlay-store.js');
		const created = (await createPage(app)).json();

		const wrong = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/recover', payload: { recoveryCode: 'zrk-nope-nope-nope' }
		});
		expect(wrong.statusCode).toBe(403);

		const start = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/recover', payload: { recoveryCode: created.recoveryCode }
		});
		expect(start.statusCode).toBe(201);
		const quote = start.json();
		expect(quote.product).toBe('lost_key_unlock');
		expect(quote.payment.memo).toMatch(/^PGR/u);

		// Claiming before the payment confirms is refused.
		const early = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/recover/claim', payload: { recoveryCode: created.recoveryCode }
		});
		expect(early.statusCode).toBe(402);

		// Simulate the receive-poller settling the unlock payment.
		const row = getOverlayBySlug(db, 'alice-run');
		const settled = unlock(db, row.id, { usdCents: C.RECOVERY_UNLOCK_USD_CENTS, nowMs: NOW });
		expect(settled.ok).toBe(true);

		const claim = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/recover/claim', payload: { recoveryCode: created.recoveryCode }
		});
		expect(claim.statusCode).toBe(200);
		const out = claim.json();
		expect(out.ownerToken).toBeTruthy();
		expect(out.ownerToken).not.toBe(created.ownerToken);
		expect(out.recoveryCode).toMatch(/^zrk-/u);
		expect(out.recoveryCode).not.toBe(created.recoveryCode);

		// Old owner token is revoked, new one works; old recovery code is retired.
		const oldTok = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/feature', payload: { days: 1 },
			headers: { 'x-overlay-token': created.ownerToken }
		});
		expect(oldTok.statusCode).toBe(403);
		const newTok = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/feature', payload: { days: 1 },
			headers: { 'x-overlay-token': out.ownerToken }
		});
		expect(newTok.statusCode).toBe(201);
		const oldCode = await app.inject({
			method: 'POST', url: '/v1/ziving/page/alice-run/recover', payload: { recoveryCode: created.recoveryCode }
		});
		expect(oldCode.statusCode).toBe(403);
	});

	test('owner can rotate the recovery code with the owner token', async () => {
		const created = (await createPage(app)).json();
		const res = await app.inject({
			method: 'POST',
			url: '/v1/ziving/page/alice-run/recovery-code',
			headers: { 'x-overlay-token': created.ownerToken }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.recoveryCode).toMatch(/^zrk-/u);
		expect(body.recoveryCode).not.toBe(created.recoveryCode);

		const denied = await app.inject({
			method: 'POST',
			url: '/v1/ziving/page/alice-run/recovery-code',
			headers: { 'x-overlay-token': 'wrong' }
		});
		expect(denied.statusCode).toBe(403);
	});
});
