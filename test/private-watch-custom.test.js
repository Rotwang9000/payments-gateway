// Tests for the variable-amount Private Watch top-up module.
// Covers the pure validators / requirement-builders / challenge
// encoders, plus an end-to-end Fastify-injected smoke test using a
// fake facilitator client so we don't need a real facilitator in CI.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify from 'fastify';

import {
	CUSTOM_TOPUP_LIMITS,
	validateCustomTopupRequest,
	buildCustomPaymentRequirements,
	encodeChallenge,
	decodePaymentHeader,
	registerCustomTopupRoute
} from '../src/private-watch-custom.js';
import { openWatchDb, createWatch } from 'viewkey-watch/private-watch-store';
import { WATCH_CONSTANTS } from 'viewkey-watch/private-watch';

function makeWatchRow(db, { credit = 100_000 } = {}) {
	return createWatch(db, {
		chain: 'monero',
		address: '4'.repeat(95),
		viewKeyCiphertext: 'b64ciphertext',
		webhookUrl: 'https://example.com/hook',
		webhookSecret: 'a'.repeat(64),
		birthdayHeight: null,
		creditAtomic: credit,
		dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC,
		maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS,
		nowMs: Date.now()
	});
}

const X402_CFG = Object.freeze({
	enabled: true,
	recipient: '0x46Ba634261566CF242c853d1f49511f9268ba674',
	network: 'eip155:8453',
	facilitatorUrl: 'https://facilitator.example.com',
	maxTimeoutSeconds: 120,
	routes: {}
});

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('validateCustomTopupRequest', () => {
	test('accepts a well-formed request (string amount)', () => {
		const out = validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: '500000' });
		expect(out.amountAtomic).toBe(500_000n);
	});
	test('accepts numeric + bigint amounts', () => {
		expect(validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: 250_000 }).amountAtomic).toBe(250_000n);
		expect(validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: 1_500_000n }).amountAtomic).toBe(1_500_000n);
	});
	test('rejects malformed watchId / token', () => {
		expect(() => validateCustomTopupRequest({ watchId: 'not-a-uuid', watchToken: 'tokabcdef', amountAtomic: 500_000 })).toThrow(/watchId/);
		expect(() => validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'short', amountAtomic: 500_000 })).toThrow(/watchToken/);
	});
	test('rejects amount out of range', () => {
		expect(() => validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: 99_999 })).toThrow(/out of range/);
		expect(() => validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: 25_000_001 })).toThrow(/out of range/);
	});
	test('rejects non-integer / NaN / negative / non-object', () => {
		expect(() => validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: -1 })).toThrow();
		expect(() => validateCustomTopupRequest({ watchId: VALID_UUID, watchToken: 'tokabcdef', amountAtomic: 1.5 })).toThrow();
		expect(() => validateCustomTopupRequest(null)).toThrow();
	});
});

describe('CUSTOM_TOPUP_LIMITS', () => {
	test('min $0.10, max $25.00', () => {
		expect(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC).toBe(100_000n);
		expect(CUSTOM_TOPUP_LIMITS.MAX_ATOMIC).toBe(25_000_000n);
	});
});

describe('buildCustomPaymentRequirements', () => {
	test('emits a spec-shaped requirements object for Base mainnet', () => {
		const r = buildCustomPaymentRequirements({ x402Cfg: X402_CFG, amountAtomic: 750_000n });
		expect(r.scheme).toBe('exact');
		expect(r.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
		expect(r.amount).toBe('750000');
		expect(r.payTo).toBe(X402_CFG.recipient);
	});
	test('emits Base Sepolia USDC for testnet network', () => {
		const r = buildCustomPaymentRequirements({ x402Cfg: { ...X402_CFG, network: 'eip155:84532' }, amountAtomic: 200_000n });
		expect(r.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
	});
	test('throws on unknown network / disabled paywall', () => {
		expect(() => buildCustomPaymentRequirements({ x402Cfg: { ...X402_CFG, network: 'eip155:1' }, amountAtomic: 100_000n })).toThrow(/canonical USDC/);
		expect(() => buildCustomPaymentRequirements({ x402Cfg: { enabled: false }, amountAtomic: 100_000n })).toThrow(/not configured/);
	});
});

describe('encodeChallenge / decodePaymentHeader', () => {
	test('produces base64 JSON matching the x402 v2 schema', () => {
		const accepts = buildCustomPaymentRequirements({ x402Cfg: X402_CFG, amountAtomic: 300_000n });
		const b64 = encodeChallenge({ resourceUrl: 'https://x.test/y', description: 'test', accepts });
		const decoded = JSON.parse(Buffer.from(b64, 'base64').toString());
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts[0].amount).toBe('300000');
	});
	test('decodePaymentHeader round-trips / rejects garbage', () => {
		const payload = { x402Version: 2, payload: { authorization: { value: '500000' } } };
		const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
		expect(decodePaymentHeader(b64)).toEqual(payload);
		expect(decodePaymentHeader('')).toBeNull();
		expect(decodePaymentHeader('not-base64-!')).toBeNull();
	});
});

describe('registerCustomTopupRoute (HTTP integration)', () => {
	let app, db, fakeFacilitator, fixture;

	beforeEach(async () => {
		app = Fastify({ logger: false });
		db = openWatchDb(':memory:');
		fixture = makeWatchRow(db);
		fakeFacilitator = {
			verify: jest.fn(async () => ({ isValid: true })),
			settle: jest.fn(async () => ({ success: true, tx: '0xtx', payer: '0xpayer' }))
		};
		registerCustomTopupRoute(app, {
			watchDb: db,
			x402Cfg: X402_CFG,
			facilitatorFactory: async () => fakeFacilitator,
			requirePaywall: () => false,
			privateWatchReady: () => true,
			privateNotConfigured: (reply) => reply.code(503).send({ error: 'not configured' })
		});
		await app.ready();
	});

	afterEach(async () => {
		if (app) await app.close();
		if (db) db.close();
	});

	test('402 challenge when no x-payment header', async () => {
		const r = await app.inject({ method: 'POST', url: '/v1/private/topup-custom', payload: { watchId: fixture.id, watchToken: fixture.token, amountAtomic: 750_000 } });
		expect(r.statusCode).toBe(402);
		const decoded = JSON.parse(Buffer.from(r.headers['payment-required'], 'base64').toString());
		expect(decoded.accepts[0].amount).toBe('750000');
	});

	test('400 when x-payment value does not match requested amount', async () => {
		const wrongPayload = Buffer.from(JSON.stringify({ payload: { authorization: { value: '500000' } } })).toString('base64');
		const r = await app.inject({ method: 'POST', url: '/v1/private/topup-custom', headers: { 'x-payment': wrongPayload }, payload: { watchId: fixture.id, watchToken: fixture.token, amountAtomic: 750_000 } });
		expect(r.statusCode).toBe(400);
		expect(JSON.parse(r.body).error.code).toBe('amount_mismatch');
	});

	test('200 on successful verify+settle, credit applied', async () => {
		const goodPayload = Buffer.from(JSON.stringify({ payload: { authorization: { value: '750000' } } })).toString('base64');
		const r = await app.inject({ method: 'POST', url: '/v1/private/topup-custom', headers: { 'x-payment': goodPayload }, payload: { watchId: fixture.id, watchToken: fixture.token, amountAtomic: 750_000 } });
		expect(r.statusCode).toBe(200);
		const body = JSON.parse(r.body);
		expect(body.tier).toBe('custom');
		expect(body.creditAppliedAtomic).toBe('750000');
		expect(r.headers['x-payment-response']).toBeDefined();
		expect(fakeFacilitator.verify).toHaveBeenCalledTimes(1);
		expect(fakeFacilitator.settle).toHaveBeenCalledTimes(1);
	});

	test('403 when watchToken does not match (after payment captured)', async () => {
		const goodPayload = Buffer.from(JSON.stringify({ payload: { authorization: { value: '750000' } } })).toString('base64');
		const r = await app.inject({ method: 'POST', url: '/v1/private/topup-custom', headers: { 'x-payment': goodPayload }, payload: { watchId: fixture.id, watchToken: 'wrongtokenwrong', amountAtomic: 750_000 } });
		expect(r.statusCode).toBe(403);
		expect(JSON.parse(r.body).error.code).toBe('forbidden_after_payment');
	});

	test('503 when paywall is disabled (gate runs first)', async () => {
		const app2 = Fastify({ logger: false });
		const db2 = openWatchDb(':memory:');
		registerCustomTopupRoute(app2, {
			watchDb: db2,
			x402Cfg: { ...X402_CFG, enabled: false },
			facilitatorFactory: async () => fakeFacilitator,
			requirePaywall: (reply) => { reply.code(503).send({ error: 'paywall disabled' }); return true; },
			privateWatchReady: () => true,
			privateNotConfigured: () => {}
		});
		await app2.ready();
		const r = await app2.inject({ method: 'POST', url: '/v1/private/topup-custom', payload: { watchId: fixture.id, watchToken: fixture.token, amountAtomic: 750_000 } });
		expect(r.statusCode).toBe(503);
		await app2.close();
		db2.close();
	});
});
