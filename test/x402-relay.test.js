// Tests for the x402 payer relay: pure helpers, the reserve→pay→settle→refund
// service (against a :memory: watch DB with a fake payer), and the MCP tool.
// Hermetic — no network, no key, no chain.

import { describe, it, expect, jest } from '@jest/globals';

import {
	openWatchDb,
	createWatch,
	getWatch
} from 'viewkey-watch/private-watch-store';

import {
	computeRelayFee,
	isPrivateIp,
	assertSafeTarget,
	validateRelayRequest,
	relayDayStartMs,
	atomicToUsd,
	usdToAtomic,
	createX402RelayService
} from '../src/x402-relay.js';
import { registerX402RelayMcpTools } from '../src/mcp-tools.js';

// ── fixtures ────────────────────────────────────────────────────────

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const PRIVATE_LOOKUP = async () => [{ address: '10.0.0.7', family: 4 }];

function makeWatchDb({ creditAtomic = 5_000_000 } = {}) {
	const db = openWatchDb(':memory:');
	const w = createWatch(db, {
		chain: 'monero',
		address: '4' + 'a'.repeat(94),
		viewKeyCiphertext: 'ciphertext',
		webhookUrl: 'https://hooks.example.com/x',
		webhookSecret: 'secret',
		creditAtomic,
		dayRateAtomic: 20_000
	});
	return { db, watchId: w.id, watchToken: w.token };
}

const okResponse = { status: 200, contentType: 'application/json', body: '{"height":123}', truncated: false };

function makeFakePayer(impl, { enabled = true } = {}) {
	return {
		enabled,
		address: '0xPayerFloat',
		network: 'eip155:8453',
		pay: jest.fn(impl ?? (async () => ({
			ok: true, paidAtomic: 2_000, quotedAtomic: 2_000, txHash: '0xtxhash', asset: '0xusdc', response: okResponse
		})))
	};
}

function makeService({ db, payer, config = {}, lookup = PUBLIC_LOOKUP, now } = {}) {
	return createX402RelayService({
		watchDb: db,
		payX402: payer,
		getWatch,
		config,
		lookup,
		now
	});
}

function callRelay(service, { watchId, watchToken, ...body }) {
	const validated = validateRelayRequest(body, { maxPerCallAtomic: service.limits.maxPerCallAtomic });
	return service.relay({ ...validated, watchId, watchToken });
}

const balanceOf = (db, id, token) => getWatch(db, id, token).credit_atomic;

// ── pure helpers ────────────────────────────────────────────────────

describe('computeRelayFee', () => {
	it('takes the greater of the flat floor and the percentage', () => {
		// 5% of $0.002 = $0.0001 (100 atomic) < $0.001 floor → floor wins.
		expect(computeRelayFee(2_000, { flatAtomic: 1_000, bps: 500 })).toBe(1_000);
		// 5% of $1.00 = $0.05 (50_000 atomic) > floor → percentage wins.
		expect(computeRelayFee(1_000_000, { flatAtomic: 1_000, bps: 500 })).toBe(50_000);
	});
	it('rounds the percentage up and clamps negatives to zero', () => {
		expect(computeRelayFee(1, { flatAtomic: 0, bps: 500 })).toBe(1); // ceil(0.05)
		expect(computeRelayFee(-5, { flatAtomic: 0, bps: 500 })).toBe(0);
	});
});

describe('atomic/usd conversion', () => {
	it('round-trips', () => {
		expect(usdToAtomic(1)).toBe(1_000_000);
		expect(atomicToUsd(2_500_000)).toBe(2.5);
	});
});

describe('isPrivateIp', () => {
	it('flags private/loopback/link-local/reserved ranges', () => {
		for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.9.9', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
			expect(isPrivateIp(ip)).toBe(true);
		}
	});
	it('passes public addresses', () => {
		for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
			expect(isPrivateIp(ip)).toBe(false);
		}
	});
	it('fails closed on non-IPs', () => {
		expect(isPrivateIp('not-an-ip')).toBe(true);
	});
});

describe('assertSafeTarget', () => {
	it('accepts a public https URL', async () => {
		const out = await assertSafeTarget('https://api.example.com/v1/q', { lookup: PUBLIC_LOOKUP });
		expect(out.hostname).toBe('api.example.com');
	});
	it('rejects http when allowHttp is false', async () => {
		await expect(assertSafeTarget('http://api.example.com', { lookup: PUBLIC_LOOKUP })).rejects.toThrow(/https/);
	});
	it('rejects credentials in the URL', async () => {
		await expect(assertSafeTarget('https://user:pw@api.example.com', { lookup: PUBLIC_LOOKUP })).rejects.toThrow(/credentials/);
	});
	it('rejects localhost and a host that resolves private', async () => {
		await expect(assertSafeTarget('https://localhost/x', { lookup: PUBLIC_LOOKUP })).rejects.toThrow(/public address/);
		await expect(assertSafeTarget('https://evil.example.com', { lookup: PRIVATE_LOOKUP })).rejects.toThrow(/private address/);
	});
	it('rejects a literal private IP without a lookup', async () => {
		await expect(assertSafeTarget('https://10.0.0.1/x', { lookup: PUBLIC_LOOKUP })).rejects.toThrow(/private address/);
	});
	it('honours the denyHosts list', async () => {
		await expect(assertSafeTarget('https://api.example.com', { lookup: PUBLIC_LOOKUP, denyHosts: ['example.com'] })).rejects.toThrow(/not allowed/);
	});
});

describe('validateRelayRequest', () => {
	it('normalises defaults and clamps the max to the per-call ceiling', () => {
		const r = validateRelayRequest({ url: 'https://x.test/a' }, { maxPerCallAtomic: 1_000_000 });
		expect(r.method).toBe('GET');
		expect(r.maxAtomic).toBe(1_000_000);
		const clamped = validateRelayRequest({ url: 'https://x.test/a', maxAmountUsd: 99 }, { maxPerCallAtomic: 1_000_000 });
		expect(clamped.maxAtomic).toBe(1_000_000);
	});
	it('serialises an object body to JSON', () => {
		const r = validateRelayRequest({ url: 'https://x.test', method: 'post', body: { a: 1 } }, {});
		expect(r.method).toBe('POST');
		expect(r.forwardBody).toBe('{"a":1}');
	});
	it('rejects bad input', () => {
		expect(() => validateRelayRequest({}, {})).toThrow(/url/);
		expect(() => validateRelayRequest({ url: 'https://x', method: 'TRACE' }, {})).toThrow(/method/);
		expect(() => validateRelayRequest({ url: 'https://x', maxAmountUsd: -1 }, {})).toThrow(/positive/);
		expect(() => validateRelayRequest({ url: 'https://x', idempotencyKey: 'short' }, {})).toThrow(/idempotencyKey/);
	});
});

describe('relayDayStartMs', () => {
	it('floors to UTC midnight', () => {
		const noon = Date.parse('2026-06-15T12:34:56Z');
		expect(relayDayStartMs(noon)).toBe(Date.parse('2026-06-15T00:00:00Z'));
	});
});

// ── service ─────────────────────────────────────────────────────────

describe('createX402RelayService — happy path', () => {
	it('settles, debits (amount + fee), and writes a settled receipt', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer();
		const service = makeService({ db, payer });

		const before = balanceOf(db, watchId, watchToken);
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/v1/q', maxAmountUsd: 0.01 });

		expect(out.ok).toBe(true);
		expect(out.receipt.status).toBe('settled');
		expect(out.receipt.tx_hash).toBe('0xtxhash');
		expect(out.response).toEqual(okResponse);
		// paid 2000 + fee max(1000, 5% of 2000=100) = 1000 → net 3000 debited.
		expect(before - balanceOf(db, watchId, watchToken)).toBe(3_000);
		expect(out.receipt.paid_usd).toBeCloseTo(0.002);
		expect(out.receipt.fee_usd).toBeCloseTo(0.001);
		expect(payer.pay).toHaveBeenCalledTimes(1);
		// The payer is capped at the merchant max, not the reservation.
		expect(payer.pay.mock.calls[0][0].maxAtomic).toBe(10_000);
	});

	it('forwards method + body to the payer', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer();
		const service = makeService({ db, payer });
		await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/p', method: 'POST', body: { q: 1 }, maxAmountUsd: 0.01 });
		const arg = payer.pay.mock.calls[0][0];
		expect(arg.method).toBe('POST');
		expect(arg.body).toBe('{"q":1}');
	});
});

describe('createX402RelayService — rejections refund fully', () => {
	it('refunds when the price exceeds the cap', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer(async () => ({ ok: false, reason: 'price_exceeds_max', quotedAtomic: 500_000 }));
		const service = makeService({ db, payer });
		const before = balanceOf(db, watchId, watchToken);
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01 });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('price_exceeds_max');
		expect(out.error.httpStatus).toBe(422);
		expect(out.receipt.status).toBe('rejected');
		expect(balanceOf(db, watchId, watchToken)).toBe(before); // fully refunded
	});

	it('refunds when the payer throws', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer(async () => { throw new Error('rpc down'); });
		const service = makeService({ db, payer });
		const before = balanceOf(db, watchId, watchToken);
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01 });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('payment_error');
		expect(out.receipt.status).toBe('failed');
		expect(balanceOf(db, watchId, watchToken)).toBe(before);
	});

	it('refunds when settlement fails on-chain', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer(async () => ({ ok: false, reason: 'settlement_failed', quotedAtomic: 2_000 }));
		const service = makeService({ db, payer });
		const before = balanceOf(db, watchId, watchToken);
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01 });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('settlement_failed');
		expect(out.error.httpStatus).toBe(502);
		expect(balanceOf(db, watchId, watchToken)).toBe(before);
	});
});

describe('createX402RelayService — guards', () => {
	it('rejects an unsafe (private) target before charging', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer();
		const service = makeService({ db, payer, lookup: PRIVATE_LOOKUP });
		const before = balanceOf(db, watchId, watchToken);
		const out = await callRelay(service, { watchId, watchToken, url: 'https://internal.example.com/x' });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('unsafe_target');
		expect(payer.pay).not.toHaveBeenCalled();
		expect(balanceOf(db, watchId, watchToken)).toBe(before);
	});

	it('returns insufficient_credit when the reservation cannot be covered', async () => {
		const { db, watchId, watchToken } = makeWatchDb({ creditAtomic: 2_000 });
		const payer = makeFakePayer();
		const service = makeService({ db, payer });
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 1 });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('insufficient_credit');
		expect(out.error.httpStatus).toBe(402);
		expect(payer.pay).not.toHaveBeenCalled();
	});

	it('rejects a bad token / unknown / cancelled / expired account', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const service = makeService({ db, payer: makeFakePayer() });
		expect((await callRelay(service, { watchId, watchToken: 'wrong', url: 'https://api.example.com/x' })).error.code).toBe('forbidden');
		expect((await callRelay(service, { watchId: '00000000-0000-0000-0000-000000000000', watchToken, url: 'https://api.example.com/x' })).error.code).toBe('not_found');
		// expired: clock far in the future
		const future = makeService({ db, payer: makeFakePayer(), now: () => Date.now() + 10 * 365 * 86_400_000 });
		expect((await callRelay(future, { watchId, watchToken, url: 'https://api.example.com/x' })).error.code).toBe('account_expired');
	});

	it('enforces the per-account daily cap', async () => {
		const { db, watchId, watchToken } = makeWatchDb({ creditAtomic: 50_000_000 });
		const payer = makeFakePayer();
		// Tiny daily cap so two calls trip it. per-call $1, fee 5% → reserve ~$1.05.
		const service = makeService({ db, payer, config: { relayMaxPerDayPerWatchAtomic: 1_200_000 } });
		const first = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/a', maxAmountUsd: 1 });
		expect(first.ok).toBe(true);
		const second = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/b', maxAmountUsd: 1 });
		expect(second.ok).toBe(false);
		expect(second.error.code).toBe('daily_account_cap');
	});

	it('reports relay_not_configured when the payer is disabled', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const service = makeService({ db, payer: makeFakePayer(null, { enabled: false }) });
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x' });
		expect(out.ok).toBe(false);
		expect(out.error.code).toBe('relay_not_configured');
	});
});

describe('createX402RelayService — idempotency', () => {
	it('replays the original receipt without paying twice', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const payer = makeFakePayer();
		const service = makeService({ db, payer });
		const key = 'idem-key-123456';
		const first = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01, idempotencyKey: key });
		const balAfterFirst = balanceOf(db, watchId, watchToken);
		const second = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01, idempotencyKey: key });
		expect(second.replayed).toBe(true);
		expect(second.receipt.id).toBe(first.receipt.id);
		expect(payer.pay).toHaveBeenCalledTimes(1);
		expect(balanceOf(db, watchId, watchToken)).toBe(balAfterFirst); // no second debit
	});
});

describe('getReceipt', () => {
	it('returns a receipt only to the owning token', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const service = makeService({ db, payer: makeFakePayer() });
		const out = await callRelay(service, { watchId, watchToken, url: 'https://api.example.com/x', maxAmountUsd: 0.01 });
		const ok = service.getReceipt({ watchId, watchToken, id: out.receipt.id });
		expect(ok.receipt.id).toBe(out.receipt.id);
		const bad = service.getReceipt({ watchId, watchToken: 'nope', id: out.receipt.id });
		expect(bad.error.code).toBe('forbidden');
	});
});

// ── MCP tool ────────────────────────────────────────────────────────

describe('registerX402RelayMcpTools', () => {
	const makeFakeMcpServer = () => {
		const tools = new Map();
		return { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }), tools };
	};
	const parse = (result) => JSON.parse(result.content[0].text);

	it('requires a service', () => {
		expect(() => registerX402RelayMcpTools(makeFakeMcpServer(), {})).toThrow(/service/);
	});

	it('pay_x402 settles via the service and returns the receipt', async () => {
		const { db, watchId, watchToken } = makeWatchDb();
		const service = makeService({ db, payer: makeFakePayer() });
		const server = makeFakeMcpServer();
		registerX402RelayMcpTools(server, { service, toolPrefix: 'seneschal' });
		expect([...server.tools.keys()].sort()).toEqual(['seneschal_pay_x402', 'seneschal_pay_x402_info']);

		const out = parse(await server.tools.get('seneschal_pay_x402').handler({
			watchId, watchToken, url: 'https://api.example.com/v1/q', maxAmountUsd: 0.01
		}));
		expect(out.ok).toBe(true);
		expect(out.receipt.status).toBe('settled');
		expect(out.response.status).toBe(200);
	});

	it('pay_x402 surfaces validation errors as tool errors', async () => {
		const { db } = makeWatchDb();
		const service = makeService({ db, payer: makeFakePayer() });
		const server = makeFakeMcpServer();
		registerX402RelayMcpTools(server, { service });
		const out = parse(await server.tools.get('gateway_pay_x402').handler({
			watchId: 'x'.repeat(36), watchToken: 't', url: ''
		}));
		expect(out.error.code).toBe('invalid_request');
	});
});
