// Tests for the outbound co-signed payment service + its MCP tool family.
// All chain/WASM/relay I/O is injected as fakes, so these run hermetically.

import { describe, it, expect, jest } from '@jest/globals';
import { buildConfig } from '../src/config.js';
import { createMakePaymentService, progressToStatus, buildCosignDeepLink, PAYMENT_STATUSES } from '../src/make-payment.js';
import { registerMakePaymentMcpTools } from '../src/mcp-tools.js';

const U1 = 'u1' + 'q'.repeat(60);

const makeConfig = (overrides = {}) => buildConfig({
	MAKE_PAYMENT_WULT_PATH: '/tmp/share.wult',
	MAKE_PAYMENT_WASM_DIR: '/tmp/wasm',
	MAKE_PAYMENT_MAX_ZEC: '0.5',
	MAKE_PAYMENT_MAX_PENDING: '2',
	...overrides
});

const FAKE_WALLET = {
	bundle: { myShare: { id: '01' }, publicKeyPackage: { groupPublic: 'ab', signerPubkeys: {} } },
	wasm: {},
	cosignConfig: { network: 'main' },
	scanner: {},
	ufvk: 'uview1fake',
	unifiedAddress: 'u1vaultaddress' + 'x'.repeat(40),
	minSigners: 2,
	maxSigners: 3
};

/**
 * runSend fake that emits the QR, then waits for `release` before resolving
 * — letting tests observe the intermediate awaiting_cosigner state.
 */
const makeRunSend = ({ txid = 'feedbeef', failWith = null, autoRelease = true } = {}) => {
	let release;
	const released = new Promise((r) => { release = r; });
	const runSend = jest.fn(async (params) => {
		params.onQrReady?.('WB32COSIGN:1:session-id:' + 'aa'.repeat(32), { sessionId: 'session-id' });
		if (failWith) throw new Error(failWith);
		if (!autoRelease) await released;
		params.callbacks?.onProgress?.('Submitting signatures to server for proving...');
		params.callbacks?.onProgress?.('Broadcasting transaction...');
		return { txid, signedPczt: 'SIGNED' };
	});
	return { runSend, release: () => release() };
};

const makeService = (opts = {}) => {
	const config = opts.config ?? makeConfig();
	const prepareWallet = opts.prepareWallet ?? jest.fn(async () => FAKE_WALLET);
	const { runSend, release } = makeRunSend(opts.runSendOpts);
	const service = createMakePaymentService({
		config,
		deps: { prepareWallet, runSend: opts.runSend ?? runSend }
	});
	return { service, prepareWallet, runSend, release, config };
};

const waitFor = async (predicate, timeoutMs = 2000) => {
	const t0 = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe('progressToStatus', () => {
	it('maps kit phases onto coarse lifecycle states', () => {
		expect(progressToStatus('Submitting signatures to server for proving...')).toBe('proving');
		expect(progressToStatus('Broadcasting transaction...')).toBe('broadcasting');
		expect(progressToStatus('Orchard FROST Round 1: committing nonces...')).toBeNull();
		expect(progressToStatus(undefined)).toBeNull();
	});
});

describe('buildCosignDeepLink', () => {
	it('URI-encodes the payload into the page hash', () => {
		const url = buildCosignDeepLink('https://winbit32.com/cosign.html', 'WB32COSIGN:1:sess:aa');
		expect(url).toBe('https://winbit32.com/cosign.html#WB32COSIGN%3A1%3Asess%3Aaa');
		// Decodes back to the exact payload the cosigner's hash intake expects.
		expect(decodeURIComponent(new URL(url).hash.slice(1))).toBe('WB32COSIGN:1:sess:aa');
	});

	it('drops any stale hash on the base URL', () => {
		expect(buildCosignDeepLink('https://example.com/c.html#old', 'WB32COSIGN:1:s:x'))
			.toBe('https://example.com/c.html#WB32COSIGN%3A1%3As%3Ax');
	});

	it('returns null when base or payload is missing', () => {
		expect(buildCosignDeepLink('', 'WB32COSIGN:1:s:x')).toBeNull();
		expect(buildCosignDeepLink('https://example.com', '')).toBeNull();
		expect(buildCosignDeepLink('https://example.com', null)).toBeNull();
	});
});

describe('createMakePaymentService — happy path', () => {
	it('returns the QR immediately and completes with a txid', async () => {
		// Hold the ceremony open so the intermediate state is observable.
		const { service, release } = makeService({ runSendOpts: { autoRelease: false } });

		const created = await service.createPayment({ toAddress: U1, amountZec: 0.01, memo: 'thanks' });

		expect(created.status).toBe('awaiting_cosigner');
		expect(created.qrPayload).toMatch(/^WB32COSIGN:1:/);
		// Clickable companion to the QR: default cosigner page + encoded payload.
		expect(created.cosignUrl).toBe(
			'https://winbit32.com/cosign.html#' + encodeURIComponent(created.qrPayload)
		);
		expect(created.paymentId).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.amountZec).toBeCloseTo(0.01);
		expect(PAYMENT_STATUSES).toContain(created.status);

		release(); // the "human" co-signs
		await waitFor(() => service.getPayment(created.paymentId)?.status === 'completed');
		const done = service.getPayment(created.paymentId);
		expect(done.txid).toBe('feedbeef');
		expect(done.error).toBeNull();
	});

	it('passes the request through to the send pipeline', async () => {
		const { service, runSend } = makeService();
		await service.createPayment({ toAddress: U1, amountZec: 0.2, memo: 'invoice 7' });
		await waitFor(() => runSend.mock.calls.length === 1);
		const params = runSend.mock.calls[0][0];
		expect(params.toAddress).toBe(U1);
		expect(params.amountZat).toBe(20_000_000);
		expect(params.memoText).toBe('invoice 7');
		expect(params.ufvk).toBe('uview1fake');
		expect(params.unifiedAddress).toBe(FAKE_WALLET.unifiedAddress);
	});

	it('loads the wallet once and reuses it across payments', async () => {
		const { service, prepareWallet } = makeService();
		await service.createPayment({ toAddress: U1, amountZec: 0.01 });
		await service.createPayment({ toAddress: U1, amountZec: 0.02 });
		expect(prepareWallet).toHaveBeenCalledTimes(1);
	});
});

describe('createMakePaymentService — failure handling', () => {
	it('marks the payment failed when the pipeline throws', async () => {
		const { service } = makeService({ runSendOpts: { failWith: 'relay unreachable' } });
		const created = await service.createPayment({ toAddress: U1, amountZec: 0.01 });
		await waitFor(() => service.getPayment(created.paymentId)?.status === 'failed');
		expect(service.getPayment(created.paymentId).error).toMatch(/relay unreachable/);
	});

	it('retries the wallet load after a transient failure', async () => {
		let calls = 0;
		const prepareWallet = jest.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error('share file missing');
			return FAKE_WALLET;
		});
		const { service } = makeService({ prepareWallet });
		await expect(service.createPayment({ toAddress: U1, amountZec: 0.01 }))
			.rejects.toThrow(/share file missing/);
		const ok = await service.createPayment({ toAddress: U1, amountZec: 0.01 });
		// Fake pipeline may already have finished; the point is the retry worked.
		expect(['awaiting_cosigner', 'completed']).toContain(ok.status);
		expect(ok.qrPayload).toMatch(/^WB32COSIGN:1:/);
	});
});

describe('createMakePaymentService — validation + caps', () => {
	it('rejects when not configured', async () => {
		const { service } = makeService({ config: makeConfig({ MAKE_PAYMENT_WULT_PATH: '' }) });
		await expect(service.createPayment({ toAddress: U1, amountZec: 0.01 }))
			.rejects.toThrow(/not configured/i);
		expect(service.enabled()).toBe(false);
	});

	it('rejects non-unified addresses', async () => {
		const { service } = makeService();
		await expect(service.createPayment({ toAddress: 't1transparent', amountZec: 0.01 }))
			.rejects.toThrow(/unified address/i);
	});

	it('rejects amounts above the operator cap', async () => {
		const { service } = makeService();
		await expect(service.createPayment({ toAddress: U1, amountZec: 0.6 }))
			.rejects.toThrow(/cap/i);
	});

	it('rejects zero/negative/NaN amounts', async () => {
		const { service } = makeService();
		for (const amountZec of [0, -1, Number.NaN, 'nope']) {
			await expect(service.createPayment({ toAddress: U1, amountZec })).rejects.toThrow(/positive number/i);
		}
	});

	it('rejects memos over 512 bytes', async () => {
		const { service } = makeService();
		await expect(service.createPayment({ toAddress: U1, amountZec: 0.01, memo: 'x'.repeat(513) }))
			.rejects.toThrow(/512/);
	});

	it('enforces the pending-payment cap', async () => {
		// Sends that never resolve keep payments in awaiting_cosigner.
		const { service } = makeService({ runSendOpts: { autoRelease: false } });
		await service.createPayment({ toAddress: U1, amountZec: 0.01 });
		await service.createPayment({ toAddress: U1, amountZec: 0.01 });
		await expect(service.createPayment({ toAddress: U1, amountZec: 0.01 }))
			.rejects.toThrow(/Too many pending/i);
	});
});

describe('createMakePaymentService — views', () => {
	it('returns null for unknown payment ids', () => {
		const { service } = makeService();
		expect(service.getPayment('not-a-real-id-not-a-real-id-not-a-re')).toBeNull();
	});

	it('info() reports vault address + threshold when configured', async () => {
		const { service } = makeService();
		const info = await service.info();
		expect(info.enabled).toBe(true);
		expect(info.vaultAddress).toBe(FAKE_WALLET.unifiedAddress);
		expect(info.threshold).toBe('2-of-3');
		expect(info.maxAmountZec).toBeCloseTo(0.5);
	});

	it('info() reports disabled when no share is configured', async () => {
		const { service } = makeService({ config: makeConfig({ MAKE_PAYMENT_WULT_PATH: '' }) });
		const info = await service.info();
		expect(info.enabled).toBe(false);
		expect(info.reason).toMatch(/MAKE_PAYMENT_WULT_PATH/);
	});

	it('info() surfaces wallet-load errors without throwing', async () => {
		const prepareWallet = jest.fn(async () => { throw new Error('bad password'); });
		const { service } = makeService({ prepareWallet });
		const info = await service.info();
		expect(info.enabled).toBe(true);
		expect(info.walletError).toMatch(/bad password/);
	});
});

describe('registerMakePaymentMcpTools', () => {
	const makeFakeMcpServer = () => {
		const tools = new Map();
		return {
			registerTool: (name, meta, handler) => tools.set(name, { meta, handler }),
			tools
		};
	};
	const parse = (result) => JSON.parse(result.content[0].text);

	it('requires a service', () => {
		expect(() => registerMakePaymentMcpTools(makeFakeMcpServer(), {})).toThrow(/service/);
	});

	it('registers the three tools under the prefix', () => {
		const server = makeFakeMcpServer();
		const { service } = makeService();
		registerMakePaymentMcpTools(server, { service, toolPrefix: 'wb32' });
		expect([...server.tools.keys()].sort()).toEqual([
			'wb32_make_payment',
			'wb32_make_payment_info',
			'wb32_make_payment_status'
		]);
	});

	it('make_payment returns the QR + instructions and status polls it', async () => {
		const server = makeFakeMcpServer();
		const { service } = makeService();
		registerMakePaymentMcpTools(server, { service });

		const created = parse(await server.tools.get('gateway_make_payment').handler({
			toAddress: U1, amountZec: 0.01
		}));
		expect(created.qrPayload).toMatch(/^WB32COSIGN:1:/);
		expect(created.instructions).toMatch(/QR/);

		await waitFor(() => service.getPayment(created.paymentId)?.status === 'completed');
		const status = parse(await server.tools.get('gateway_make_payment_status').handler({
			paymentId: created.paymentId
		}));
		expect(status.status).toBe('completed');
		expect(status.txid).toBe('feedbeef');
	});

	it('make_payment surfaces validation failures as tool errors, not throws', async () => {
		const server = makeFakeMcpServer();
		const { service } = makeService();
		registerMakePaymentMcpTools(server, { service });
		const out = parse(await server.tools.get('gateway_make_payment').handler({
			toAddress: 'bogus', amountZec: 0.01
		}));
		expect(out.error.code).toBe('make_payment_failed');
		expect(out.error.message).toMatch(/unified address/i);
	});

	it('status returns not_found for unknown ids', async () => {
		const server = makeFakeMcpServer();
		const { service } = makeService();
		registerMakePaymentMcpTools(server, { service });
		const out = parse(await server.tools.get('gateway_make_payment_status').handler({
			paymentId: '00000000-0000-0000-0000-000000000000'
		}));
		expect(out.error.code).toBe('not_found');
	});
});
