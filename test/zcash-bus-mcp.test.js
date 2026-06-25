// Tests for the Zcash "Bus Station" MCP tools:
//   - end-to-end behaviour via a fake MCP server that captures handlers, and
//   - the opt-in gating on buildGatewayMcpServer (hidden unless a DB is wired).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { registerZcashBusMcpTools, buildGatewayMcpServer } from '../src/mcp-tools.js';
import { openBusDb } from '../src/zcash-bus-store.js';
import config from '../src/config.js';

const CONFIG = Object.freeze({ zecBusDbPath: ':memory:', zecBusFillTtlMs: 86_400_000, zecBusDepartWindowMs: 1_200_000 });

// Minimal stand-in for the MCP server: records (name -> handler) so we can
// invoke tools directly and parse the asContent JSON payload they return.
function fakeServer() {
	const tools = {};
	return {
		tools,
		registerTool(name, _meta, handler) { tools[name] = handler; }
	};
}
const call = async (srv, name, args) => {
	const res = await srv.tools[name](args ?? {});
	return JSON.parse(res.content[0].text);
};

describe('zec_bus_* MCP tools (functional)', () => {
	let srv; let db;
	beforeEach(() => {
		db = openBusDb(':memory:');
		srv = fakeServer();
		registerZcashBusMcpTools(srv, { config: CONFIG, busDb: db });
	});
	afterEach(() => { if (db) db.close(); });

	test('registers exactly the five bus tools', () => {
		expect(Object.keys(srv.tools).sort()).toEqual([
			'gateway_zec_bus_board',
			'gateway_zec_bus_join',
			'gateway_zec_bus_leave',
			'gateway_zec_bus_list',
			'gateway_zec_bus_status'
		]);
	});

	test('join → list → status → board → leave round-trips', async () => {
		const joined = await call(srv, 'gateway_zec_bus_join', { to: 'BTC.BTC', amountZec: 1, minPassengers: 3, handle: 'HyperHacker01' });
		expect(joined.joined).toBe(true);
		expect(joined.owner_token).toBeTruthy();
		expect(joined.bus.status).toBe('boarding');
		expect(joined.next).toMatch(/broadcast your own swap/u);

		const list = await call(srv, 'gateway_zec_bus_list', {});
		expect(list.buses).toHaveLength(1);
		expect(list.caveats[0]).toMatch(/[Nn]on-custodial/u);

		const status = await call(srv, 'gateway_zec_bus_status', { busId: joined.bus.id, seatId: joined.seat.id, ownerToken: joined.owner_token });
		expect(status.seat.id).toBe(joined.seat.id);

		const board = await call(srv, 'gateway_zec_bus_board', { seatId: joined.seat.id, ownerToken: joined.owner_token });
		expect(board.ok).toBe(true);
		expect(board.seat.status).toBe('boarded');

		const leave = await call(srv, 'gateway_zec_bus_leave', { seatId: joined.seat.id, ownerToken: joined.owner_token });
		expect(leave.ok).toBe(true);
		expect(leave.seat.status).toBe('left');
	});

	test('join validates the amount + route', async () => {
		const badAmt = await call(srv, 'gateway_zec_bus_join', { to: 'BTC.BTC', amountZec: 1.2345 });
		expect(badAmt.error.code).toBe('bad_request');
		const badRoute = await call(srv, 'gateway_zec_bus_join', { to: 'NOPE', amountZec: 1 });
		expect(badRoute.error.code).toBe('bad_request');
	});

	test('board rejects a wrong owner token', async () => {
		const joined = await call(srv, 'gateway_zec_bus_join', { to: 'BTC.BTC', amountZec: 1 });
		const res = await call(srv, 'gateway_zec_bus_board', { seatId: joined.seat.id, ownerToken: 'nope' });
		expect(res.ok).toBe(false);
		expect(res.error.message).toMatch(/authoris/u);
	});

	test('the same route + amount + min shares one bus until it is ready', async () => {
		const a = await call(srv, 'gateway_zec_bus_join', { to: 'BTC.BTC', amountZec: 0.5, minPassengers: 2 });
		const b = await call(srv, 'gateway_zec_bus_join', { to: 'BTC.BTC', amountZec: 0.5, minPassengers: 2 });
		expect(b.bus.id).toBe(a.bus.id);
		expect(b.bus.status).toBe('ready');
	});

	test('a null DB yields the not-enabled error (defensive)', async () => {
		const off = fakeServer();
		registerZcashBusMcpTools(off, { config: CONFIG, busDb: null });
		const res = await call(off, 'gateway_zec_bus_list', {});
		expect(res.error.code).toBe('bus_not_enabled');
	});
});

describe('opt-in gating on buildGatewayMcpServer', () => {
	test('bus tools are hidden by default', () => {
		const server = buildGatewayMcpServer({ config });
		const names = Object.keys(server._registeredTools ?? {});
		expect(names.filter((n) => n.includes('zec_bus'))).toHaveLength(0);
	});

	test('bus tools appear when a DB is injected', () => {
		const db = openBusDb(':memory:');
		const server = buildGatewayMcpServer({ config, zecBusDb: db });
		const names = Object.keys(server._registeredTools ?? {});
		expect(names.filter((n) => n.includes('zec_bus'))).toHaveLength(5);
		db.close();
	});
});
