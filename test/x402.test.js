// Tests for the gateway x402 adapter + route catalogue.

import { describe, test, expect } from '@jest/globals';

import { buildConfig } from '../src/config.js';
import { buildX402Config, resolveRoutePrices, GATEWAY_PREMIUM_ROUTES } from '../src/x402.js';

const RECIPIENT = '0x' + '12'.repeat(20);

describe('GATEWAY_PREMIUM_ROUTES', () => {
	test('catalogue covers the private + privacy-chain routes', () => {
		const paths = GATEWAY_PREMIUM_ROUTES.map((r) => `${r.method} ${r.path}`);
		expect(paths).toContain('POST /v1/private/watch');
		expect(paths).toContain('POST /v1/private/historical');
		expect(paths).toContain('GET /v1/q/xmr/height');
		expect(paths).toContain('GET /v1/q/zec/last-block');
		// 5 private + 7 chain facts
		expect(GATEWAY_PREMIUM_ROUTES.length).toBe(12);
	});
});

describe('buildX402Config', () => {
	test('disabled when no recipient is set', () => {
		const cfg = buildConfig({});
		const out = buildX402Config({ cfg });
		expect(out.enabled).toBe(false);
		expect(out.reason).toMatch(/RECIPIENT/);
	});

	test('enabled with a recipient; gates the private-watch route', () => {
		const cfg = buildConfig({ X402_RECIPIENT_ADDRESS: RECIPIENT });
		const out = buildX402Config({ cfg });
		expect(out.enabled).toBe(true);
		expect(out.network).toBe('eip155:8453');
		expect(out.routes['POST /v1/private/watch']).toBeDefined();
	});
});

describe('resolveRoutePrices', () => {
	test('resolves the per-route price from env → cfg → feed default', () => {
		const cfg = buildConfig({ X402_RECIPIENT_ADDRESS: RECIPIENT });
		const resolved = resolveRoutePrices(GATEWAY_PREMIUM_ROUTES, { cfg, env: { X402_PRIVATE_WATCH_PRICE: '$0.42' } });
		const watch = resolved.find((r) => r.path === '/v1/private/watch');
		expect(watch.price).toBe('$0.42');
		// q facts fall back to the X402_Q_PRICE tier
		const qFact = resolved.find((r) => r.path === '/v1/q/xmr/height');
		expect(qFact.price).toBe('$0.001');
	});
});
