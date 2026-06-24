// Integration tests for the embeddable gateway plugin. We mount
// registerGatewayRoutes onto a bare Fastify app with an in-memory watch
// DB, a stubbed NFPT client and a stubbed chain-RPC fetch — no live
// daemons, no real DNS.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify from 'fastify';

import { buildConfig } from '../src/config.js';
import { registerGatewayRoutes } from '../src/rest-plugin.js';
import { openWatchDb } from 'viewkey-watch/private-watch-store';
import { createNfptClient } from 'viewkey-watch/private-watch-nfpt';

const MASTER_KEY_HEX = '11'.repeat(32);
const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678';

// NFPT stub: only the health/status path matters for watch creation
// (the scanner job itself is driven by the separate poller).
function nfptStubFetch(url) {
	const path = String(url).replace(/^https?:\/\/[^/]+/u, '');
	if (path === '/api/wallet-scanner/lightwallet/status') {
		return Promise.resolve({
			status: 200,
			text: async () => JSON.stringify({ success: true, data: { lightwallet: { connected: true, blockHeight: 3_400_000 } } })
		});
	}
	return Promise.resolve({ status: 200, text: async () => JSON.stringify({ success: true, data: {} }) });
}

// Chain-RPC stub: answer monerod get_info so /v1/q/xmr/height resolves.
function chainStubFetch() {
	return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { height: 3_678_000, target_height: 0, synchronized: true } }) });
}

const X402_ENABLED = Object.freeze({
	enabled: true,
	recipient: RECIPIENT,
	network: 'eip155:8453',
	facilitatorUrl: 'https://facilitator.example.com',
	routes: {
		'POST /v1/private/watch': { accepts: { price: '$0.10' } },
		'POST /v1/private/topup': { accepts: { price: '$0.10' } },
		'POST /v1/private/topup-1': { accepts: { price: '$1.00' } },
		'POST /v1/private/topup-5': { accepts: { price: '$5.00' } },
		'POST /v1/private/historical': { accepts: { price: '$0.50' } }
	}
});

function buildPluginApp(over = {}) {
	const app = Fastify({ logger: false });
	const config = buildConfig({
		PRIVATE_WATCH_ENCRYPTION_KEY: MASTER_KEY_HEX,
		MONERO_RPC_URL: 'http://stub-monero',
		ZCASH_RPC_URL: 'http://stub-zcash',
		...(over.env ?? {})
	});
	const handle = registerGatewayRoutes(app, {
		config,
		x402Cfg: over.x402Cfg ?? X402_ENABLED,
		watchDb: over.watchDb ?? openWatchDb(':memory:'),
		watchMasterKey: Buffer.from(MASTER_KEY_HEX, 'hex'),
		// Keep the notice board off disk in tests (defaults to a real path).
		boardDbPath: ':memory:',
		nfptClient: createNfptClient({ baseUrl: 'http://nfpt', apiKey: 'k', fetchImpl: nfptStubFetch }),
		webhookResolver: {
			resolve4: async (host) => host === 'example.com' ? ['93.184.216.34'] : (() => { const e = new Error('na'); e.code = 'ENODATA'; throw e; })(),
			resolve6: async () => { const e = new Error('na'); e.code = 'ENODATA'; throw e; }
		},
		webhookFetchImpl: nfptStubFetch,
		fetchImpl: chainStubFetch,
		chainRpcConfigured: over.chainRpcConfigured ?? { monero: true, zcash: true }
	});
	return { app, handle };
}

describe('plugin handle', () => {
	test('reports private watch ready + builds stats block', async () => {
		const { app, handle } = buildPluginApp();
		await app.ready();
		expect(handle.privateWatchReady()).toBe(true);
		const stats = handle.buildPrivateWatchStats();
		expect(stats.enabled).toBe(true);
		expect(stats.price_create).toBe('$0.10');
		await app.close();
	});
});

describe('privacy-chain facts', () => {
	test('GET /v1/q/xmr/height returns data when paywall enabled', async () => {
		const { app } = buildPluginApp();
		await app.ready();
		const r = await app.inject({ method: 'GET', url: '/v1/q/xmr/height' });
		expect(r.statusCode).toBe(200);
		expect(r.json().height).toBe(3_678_000);
		await app.close();
	});

	test('GET /v1/q/zec/height 503 when chain not configured', async () => {
		const { app } = buildPluginApp({ chainRpcConfigured: { monero: true, zcash: false } });
		await app.ready();
		const r = await app.inject({ method: 'GET', url: '/v1/q/zec/height' });
		expect(r.statusCode).toBe(503);
		expect(r.json().error.code).toBe('chain_not_configured');
		await app.close();
	});

	test('GET /v1/q/xmr/height 503 when paywall disabled', async () => {
		const { app } = buildPluginApp({ x402Cfg: { enabled: false, reason: 'no recipient' } });
		await app.ready();
		const r = await app.inject({ method: 'GET', url: '/v1/q/xmr/height' });
		expect(r.statusCode).toBe(503);
		expect(r.json().error.code).toBe('paywall_not_configured');
		await app.close();
	});
});

describe('notice board — boards from config (NOTICE_BOARDS)', () => {
	test('GET /v1/board uses NOTICE_BOARDS when the host passes no explicit boards', async () => {
		const { app } = buildPluginApp({
			env: { NOTICE_BOARDS: '[{"id":"agents","title":"Agents","description":"For AI agents."},{"id":"market","title":"Marketplace"}]' }
		});
		await app.ready();
		const r = await app.inject({ method: 'GET', url: '/v1/board' });
		expect(r.statusCode).toBe(200);
		expect(r.json().boards.map((b) => b.id)).toEqual(['agents', 'market']);
		await app.close();
	});

	test('GET /v1/board falls back to a single general board when NOTICE_BOARDS unset', async () => {
		const { app } = buildPluginApp();
		await app.ready();
		const r = await app.inject({ method: 'GET', url: '/v1/board' });
		expect(r.statusCode).toBe(200);
		expect(r.json().boards.map((b) => b.id)).toEqual(['general']);
		await app.close();
	});
});

describe('private watch routes', () => {
	let app;
	beforeAll(async () => { ({ app } = buildPluginApp()); await app.ready(); });
	afterAll(async () => { await app?.close?.(); });

	test('GET /v1/private/info returns metadata', async () => {
		const r = await app.inject({ method: 'GET', url: '/v1/private/info' });
		expect(r.statusCode).toBe(200);
	});

	test('GET /v1/private/health enabled', async () => {
		const r = await app.inject({ method: 'GET', url: '/v1/private/health' });
		expect(r.statusCode).toBe(200);
		expect(r.json().enabled).toBe(true);
	});

	test('POST /v1/private/watch creates a Monero watch with the configured signature header', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: { chain: 'monero', address: '4' + 'A'.repeat(94), viewKey: '5'.repeat(64), webhookUrl: 'https://example.com/hook' }
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.watchId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(body.watchToken.length).toBeGreaterThan(20);
		expect(body.signatureHeader).toMatch(/HMAC-SHA256/);
		expect(body.signatureHeader).toMatch(/^X-Payment-Signature/);
	});

	test('POST /v1/private/watch rejects invalid chain (400)', async () => {
		const r = await app.inject({ method: 'POST', url: '/v1/private/watch', payload: { chain: 'doge', address: 'x', viewKey: 'y', webhookUrl: 'https://example.com/hook' } });
		expect(r.statusCode).toBe(400);
	});
});
