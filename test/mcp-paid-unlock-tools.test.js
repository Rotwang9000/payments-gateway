// Unit tests for the paid-unlock MCP tool handlers. Driven with a stub server
// (records registerTool calls) — same shape the SDK invokes — so we exercise
// the read tools + the buy pointer without the transport.

import { describe, test, expect } from '@jest/globals';

import { parseMasterKey } from 'viewkey-watch/private-watch-crypto';

import { registerPaidUnlockMcpTools, registerGatewayMcpTools } from '../src/mcp-tools.js';
import { openUnlockDb, createListing } from '../src/paid-unlock-store.js';
import { sealSecret } from '../src/paid-unlock.js';
import { buildConfig } from '../src/config.js';

function fakeServer() {
	const tools = new Map();
	return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}
function parse(res) { return JSON.parse(res.content[0].text); }

const MASTER_KEY = parseMasterKey('a'.repeat(64));

function seedListing(db, over = {}) {
	return createListing(db, {
		title: 'Secret report',
		description: 'A PDF',
		priceUsdCents: 500,
		payChains: ['zcash'],
		secretCt: sealSecret('k_9f2b|https://cdn/f.enc', MASTER_KEY),
		claimMax: 3,
		ttlSec: 3600,
		nowMs: Date.now(),
		...over
	});
}

describe('registerPaidUnlockMcpTools', () => {
	test('registers the three tools under the prefix', () => {
		const s = fakeServer();
		const out = registerPaidUnlockMcpTools(s, { toolPrefix: 'wb', unlockDb: null, x402Cfg: { enabled: true } });
		expect(out.names).toEqual(['wb_paid_unlock_info', 'wb_paid_unlock_listing', 'wb_paid_unlock_browse', 'wb_paid_unlock_buy']);
		expect([...s.tools.keys()]).toEqual(out.names);
	});

	test('info advertises the rails + trust model; buy returns REST pointers', async () => {
		const s = fakeServer();
		registerPaidUnlockMcpTools(s, {
			toolPrefix: 'wb',
			unlockDb: null,
			x402Cfg: { enabled: true },
			config: buildConfig({ ZEC_RECV_ADDRESS: 'u1zcash' })
		});
		const info = parse(await s.tools.get('wb_paid_unlock_info').handler({}));
		expect(info.product).toBe('paid-unlock');
		expect(info.pay.usdc_x402).toBe(true);
		expect(info.pay.native_chains).toContain('zcash');
		expect(info.trust_model).toMatch(/non-custodial/i);

		const buyUsdc = parse(await s.tools.get('wb_paid_unlock_buy').handler({ id: 'ul_abc', chain: 'usdc' }));
		expect(buyUsdc.buy_endpoint).toBe('/v1/unlock/listing/ul_abc/buy');
		const buyZec = parse(await s.tools.get('wb_paid_unlock_buy').handler({ id: 'ul_abc', chain: 'zcash' }));
		expect(buyZec.order_endpoint).toBe('/v1/unlock/listing/ul_abc/order');
		expect(buyZec.body.chain).toBe('zcash');
	});

	test('listing tool does real work against an injected DB (no secret leak)', async () => {
		const db = openUnlockDb(':memory:');
		const { id } = seedListing(db);
		const s = fakeServer();
		registerPaidUnlockMcpTools(s, { toolPrefix: 'wb', unlockDb: db, x402Cfg: { enabled: true } });

		const listing = parse(await s.tools.get('wb_paid_unlock_listing').handler({ id }));
		expect(listing.title).toBe('Secret report');
		expect(listing.price.usd).toBe('$5.00');
		expect(JSON.stringify(listing)).not.toContain('cdn/f.enc');

		const missing = parse(await s.tools.get('wb_paid_unlock_listing').handler({ id: 'ul_nope' }));
		expect(missing.error.code).toBe('not_found');
		db.close();
	});

	test('browse tool returns only public listings (no secret)', async () => {
		const db = openUnlockDb(':memory:');
		seedListing(db, { title: 'hidden' }); // unlisted
		const pub = seedListing(db, { title: 'shown', visibility: 'public' });
		const s = fakeServer();
		registerPaidUnlockMcpTools(s, { toolPrefix: 'wb', unlockDb: db, x402Cfg: { enabled: true } });

		const out = parse(await s.tools.get('wb_paid_unlock_browse').handler({}));
		const ids = out.listings.map((l) => l.id);
		expect(ids).toContain(pub.id);
		expect(out.listings.every((l) => l.title !== 'hidden')).toBe(true);
		expect(JSON.stringify(out)).not.toContain('cdn/f.enc');
		db.close();
	});
});

describe('opt-in gating in registerGatewayMcpTools', () => {
	test('paid-unlock tools are OFF by default and ON when enabled', () => {
		const off = fakeServer();
		registerGatewayMcpTools(off, { toolPrefix: 'g', config: buildConfig({}), disablePrivateWatch: true });
		expect([...off.tools.keys()].some((n) => n.includes('paid_unlock'))).toBe(false);

		const on = fakeServer();
		registerGatewayMcpTools(on, { toolPrefix: 'g', config: buildConfig({ PAID_UNLOCK_ENABLED: '1' }), disablePrivateWatch: true });
		expect([...on.tools.keys()].filter((n) => n.includes('paid_unlock')).sort())
			.toEqual(['g_paid_unlock_browse', 'g_paid_unlock_buy', 'g_paid_unlock_info', 'g_paid_unlock_listing']);
	});
});
