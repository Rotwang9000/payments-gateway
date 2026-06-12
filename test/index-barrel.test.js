// The package barrel is the public embedding API — hosts import servers,
// registrars and the make-payment service from 'payments-gateway'. This
// guard keeps every advertised entry point exported and callable-shaped.

import { describe, it, expect } from '@jest/globals';
import * as gateway from '../src/index.js';

describe('package barrel (public embedding API)', () => {
	it('exports the config builders', () => {
		expect(typeof gateway.buildConfig).toBe('function');
		expect(gateway.config).toBeDefined();
	});

	it('exports the MCP server builders and tool registrars', () => {
		for (const fn of [
			'registerGatewayMcpTools',
			'registerMakePaymentMcpTools',
			'registerWalletKitMcpTools',
			'registerUtilityMcpTools',
			'buildGatewayMcpServer',
			'startGatewayMcpHttpServer',
			'asContent'
		]) {
			expect(typeof gateway[fn]).toBe('function');
		}
	});

	it('exports the REST builders', () => {
		expect(typeof gateway.buildGatewayApp).toBe('function');
		expect(typeof gateway.startGatewayRest).toBe('function');
		expect(typeof gateway.registerGatewayRoutes).toBe('function');
	});

	it('exports the make-payment service surface', () => {
		expect(typeof gateway.createMakePaymentService).toBe('function');
		expect(typeof gateway.buildMakePaymentDeps).toBe('function');
		expect(typeof gateway.buildCosignDeepLink).toBe('function');
		expect(Array.isArray(gateway.PAYMENT_STATUSES)).toBe(true);
	});

	it('exports the offline utility helpers', () => {
		for (const fn of [
			'validatePhrase',
			'findChecksumWords',
			'generatePhrase',
			'splitSecretHex',
			'combineSecretShares'
		]) {
			expect(typeof gateway[fn]).toBe('function');
		}
	});

	it('exports the x402 catalogue used for combined paywalls', () => {
		expect(Array.isArray(gateway.GATEWAY_PREMIUM_ROUTES)).toBe(true);
		expect(gateway.GATEWAY_PREMIUM_ROUTES.length).toBeGreaterThan(0);
		expect(typeof gateway.qFact).toBe('function');
	});
});
