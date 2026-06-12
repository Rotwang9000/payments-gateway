// Tests for the wallet-kit view-key MCP tool family: registration shape,
// zod schema mapping, handler plumbing and error envelopes. Descriptors are
// injected with fake handlers, so no network I/O happens.

import { describe, it, expect } from '@jest/globals';
import { registerWalletKitMcpTools } from '../src/mcp-tools.js';
import { createWalletKitToolDescriptors } from '@winbit32/wallet-kit';

const makeFakeMcpServer = () => {
	const tools = new Map();
	return {
		tools,
		registerTool: (name, meta, handler) => tools.set(name, { meta, handler })
	};
};

const parseContent = (result) => JSON.parse(result.content[0].text);

describe('registerWalletKitMcpTools', () => {
	it('registers all descriptors with the prefix and zod schemas', () => {
		const server = makeFakeMcpServer();
		const fakeZec = {
			startOrchardScanJob: async () => ({ success: true, data: { jobId: 'j', jobToken: 't' } })
		};
		const descriptors = createWalletKitToolDescriptors({
			zcash: { client: fakeZec },
			monero: false
		});
		const { count, names } = registerWalletKitMcpTools(server, { toolPrefix: 'wb32', descriptors });

		expect(count).toBe(descriptors.length);
		expect(names).toContain('wb32_zec_scan_start');
		const tool = server.tools.get('wb32_zec_scan_start');
		expect(tool.meta.title).toMatch(/Zcash/);
		// Required param mapped as required zod string; optional param optional.
		expect(tool.meta.inputSchema.ufvk.isOptional()).toBe(false);
		expect(tool.meta.inputSchema.birthdayHeight.isOptional()).toBe(true);
	});

	it('wraps handler results in MCP content and surfaces errors as envelopes', async () => {
		const server = makeFakeMcpServer();
		const descriptors = [
			{
				name: 'demo_ok',
				title: 'Demo',
				description: 'demo',
				params: { x: { type: 'string', description: 'x', required: true } },
				handler: async (input) => ({ echoed: input.x })
			},
			{
				name: 'demo_fail',
				title: 'Demo fail',
				description: 'demo',
				params: {},
				handler: async () => { throw new Error('kaboom'); }
			}
		];
		registerWalletKitMcpTools(server, { descriptors });

		const ok = parseContent(await server.tools.get('gateway_demo_ok').handler({ x: 'hi' }));
		expect(ok).toEqual({ echoed: 'hi' });

		const fail = parseContent(await server.tools.get('gateway_demo_fail').handler({}));
		expect(fail.error.code).toBe('wallet_tool_failed');
		expect(fail.error.tool).toBe('demo_fail');
		expect(fail.error.message).toBe('kaboom');
	});

	it('kit descriptor validation errors flow through the envelope', async () => {
		const server = makeFakeMcpServer();
		const descriptors = createWalletKitToolDescriptors({
			zcash: { client: {} }, // handler never reached — validation fires first
			monero: false
		});
		registerWalletKitMcpTools(server, { descriptors });

		const res = parseContent(await server.tools.get('gateway_zec_scan_start').handler({}));
		expect(res.error.code).toBe('wallet_tool_failed');
		expect(res.error.message).toMatch(/missing required param 'ufvk'/);
	});

	it('defaults to both chains when no descriptors are injected', () => {
		const server = makeFakeMcpServer();
		const { names } = registerWalletKitMcpTools(server, { toolPrefix: 'p' });
		expect(names).toEqual(expect.arrayContaining([
			'p_zec_scan_start', 'p_zec_scan_status', 'p_zec_scan_cancel',
			'p_zec_utxos', 'p_zec_broadcast',
			'p_xmr_scan_start', 'p_xmr_scan_status', 'p_xmr_scan_cancel'
		]));
		expect(names).toHaveLength(8);
	});
});
