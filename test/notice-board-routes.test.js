// HTTP integration tests for the notice-board routes. Uses a fake
// facilitator (no real x402 settlement in CI), mirroring the
// private-watch-custom route tests.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify from 'fastify';

import { registerNoticeBoardRoutes } from '../src/notice-board-routes.js';
import { openBoardDb } from '../src/notice-board-store.js';

const X402_CFG = Object.freeze({
	enabled: true,
	recipient: '0x46Ba634261566CF242c853d1f49511f9268ba674',
	network: 'eip155:8453',
	facilitatorUrl: 'https://facilitator.example.com',
	maxTimeoutSeconds: 120,
	routes: {}
});

const BOARDS = [
	{ id: 'features', title: 'Feature requests', description: 'ask + bugs' },
	{ id: 'data-requests', title: 'Data requests', description: 'paid data asks' }
];

function paymentHeader(value) {
	return Buffer.from(JSON.stringify({ payload: { authorization: { value: String(value) } } })).toString('base64');
}

describe('notice-board routes (HTTP)', () => {
	let app;
	let db;
	let fakeFacilitator;

	beforeEach(async () => {
		app = Fastify({ logger: false });
		db = openBoardDb(':memory:');
		fakeFacilitator = {
			verify: jest.fn(async () => ({ isValid: true })),
			settle: jest.fn(async () => ({ success: true, tx: '0xtx', payer: '0xpayer' }))
		};
		registerNoticeBoardRoutes(app, {
			boardDb: db,
			x402Cfg: X402_CFG,
			boards: BOARDS,
			adminKey: 'super-secret-admin',
			webBoardBaseUrl: 'https://board.test',
			facilitatorFactory: async () => fakeFacilitator
		});
		await app.ready();
	});

	afterEach(async () => {
		if (app) await app.close();
		if (db) db.close();
	});

	async function post(board, body) {
		return app.inject({ method: 'POST', url: `/v1/board/${board}`, payload: body });
	}

	test('GET /v1/board lists configured boards + pricing', async () => {
		const r = await app.inject({ method: 'GET', url: '/v1/board' });
		expect(r.statusCode).toBe(200);
		const body = JSON.parse(r.body);
		expect(body.boards.map((b) => b.id)).toEqual(['features', 'data-requests']);
		expect(body.posting.free).toBe(true);
		expect(body.posting.boost.min_usd).toBe(0.1);
	});

	test('free post → 201 with ownerToken; appears in the list', async () => {
		const r = await post('features', { title: 'Add CSV export', body: 'please add it', handle: 'agent-7' });
		expect(r.statusCode).toBe(201);
		const created = JSON.parse(r.body);
		expect(created.ownerToken).toBeTruthy();
		expect(created.weight_atomic).toBe('0');

		const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/board/features' })).body);
		expect(list.count).toBe(1);
		expect(list.notices[0].title).toBe('Add CSV export');
		expect(list.notices[0].handle).toBe('agent-7');

		const one = JSON.parse((await app.inject({ method: 'GET', url: `/v1/board/features/${created.id}` })).body);
		expect(one.id).toBe(created.id);
	});

	test('post to unknown board → 400; GET unknown board → 404', async () => {
		expect((await post('nope', { title: 'hello there', body: 'x' })).statusCode).toBe(400);
		expect((await app.inject({ method: 'GET', url: '/v1/board/nope' })).statusCode).toBe(404);
	});

	test('boost: 402 → mismatch 400 → success applies weight + raises rank', async () => {
		const small = JSON.parse((await post('features', { title: 'Small ask', body: 'x' })).body);
		const big = JSON.parse((await post('features', { title: 'Big ask', body: 'y' })).body);

		// no payment → 402 challenge for the requested amount
		const challenge = await app.inject({ method: 'POST', url: `/v1/board/features/${big.id}/boost`, payload: { amountAtomic: 5_000_000 } });
		expect(challenge.statusCode).toBe(402);
		const decoded = JSON.parse(Buffer.from(challenge.headers['payment-required'], 'base64').toString());
		expect(decoded.accepts[0].amount).toBe('5000000');

		// wrong header amount → 400
		const mismatch = await app.inject({
			method: 'POST', url: `/v1/board/features/${big.id}/boost`,
			headers: { 'x-payment': paymentHeader('1000000') }, payload: { amountAtomic: 5_000_000 }
		});
		expect(mismatch.statusCode).toBe(400);
		expect(JSON.parse(mismatch.body).error.code).toBe('amount_mismatch');

		// good payment → 200, weight applied, settlement header present
		const ok = await app.inject({
			method: 'POST', url: `/v1/board/features/${big.id}/boost`,
			headers: { 'x-payment': paymentHeader('5000000') }, payload: { amountAtomic: 5_000_000 }
		});
		expect(ok.statusCode).toBe(200);
		const boosted = JSON.parse(ok.body);
		expect(boosted.weight_atomic).toBe('5000000');
		expect(boosted.boosts_count).toBe(1);
		expect(ok.headers['x-payment-response']).toBeDefined();
		expect(fakeFacilitator.verify).toHaveBeenCalledTimes(1);
		expect(fakeFacilitator.settle).toHaveBeenCalledTimes(1);

		// the boosted notice now ranks first
		const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/board/features' })).body);
		expect(list.notices[0].id).toBe(big.id);
		expect(list.notices[1].id).toBe(small.id);
	});

	async function reply(board, id, body) {
		return app.inject({ method: 'POST', url: `/v1/board/${board}/${id}/reply`, payload: body });
	}

	test('reply: 201 → rides under root; list shows reply_count + inline replies; root count unchanged', async () => {
		const root = JSON.parse((await post('features', { title: 'Funding question', body: 'how do I fund?' })).body);

		const r1 = await reply('features', root.id, { body: 'use ZKP2P', handle: 'zk' });
		expect(r1.statusCode).toBe(201);
		const reply1 = JSON.parse(r1.body);
		expect(reply1.parent_id).toBe(root.id);
		expect(reply1.ownerToken).toBeTruthy();

		await reply('features', root.id, { body: 'or swap in your vault', handle: 'wb' });

		// List: still ONE top-level notice (the root), annotated with replies.
		const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/board/features' })).body);
		expect(list.count).toBe(1);
		expect(list.notices[0].id).toBe(root.id);
		expect(list.notices[0].reply_count).toBe(2);
		expect(list.notices[0].replies.map((x) => x.body)).toEqual(['use ZKP2P', 'or swap in your vault']);
		expect(list.notices[0].replies[0].is_reply).toBe(true);

		// Single GET on the root returns the full thread.
		const thread = JSON.parse((await app.inject({ method: 'GET', url: `/v1/board/features/${root.id}` })).body);
		expect(thread.reply_count).toBe(2);
		expect(thread.replies).toHaveLength(2);

		// Single GET on a reply resolves to its thread (root + siblings).
		const fromReply = JSON.parse((await app.inject({ method: 'GET', url: `/v1/board/features/${reply1.id}` })).body);
		expect(fromReply.id).toBe(root.id);
		expect(fromReply.replies).toHaveLength(2);
	});

	test('reply with no title derives "Re: <parent>"; reply-to-a-reply collapses to the root', async () => {
		const root = JSON.parse((await post('features', { title: 'Original ask', body: 'x' })).body);
		const r1 = JSON.parse((await reply('features', root.id, { body: 'first' })).body);
		expect(r1.title).toBe('Re: Original ask');

		// Replying to the reply attaches to the same root (one level deep).
		const r2 = JSON.parse((await reply('features', r1.id, { body: 'second' })).body);
		expect(r2.parent_id).toBe(root.id);

		const thread = JSON.parse((await app.inject({ method: 'GET', url: `/v1/board/features/${root.id}` })).body);
		expect(thread.reply_count).toBe(2);
	});

	test('a reply cannot be boosted (409); reply to a missing notice is 404', async () => {
		const root = JSON.parse((await post('features', { title: 'Boostable thread', body: 'x' })).body);
		const r1 = JSON.parse((await reply('features', root.id, { body: 'a reply' })).body);

		const boostReply = await app.inject({
			method: 'POST', url: `/v1/board/features/${r1.id}/boost`,
			headers: { 'x-payment': paymentHeader('1000000') }, payload: { amountAtomic: 1_000_000 }
		});
		expect(boostReply.statusCode).toBe(409);
		expect(JSON.parse(boostReply.body).error.code).toBe('cannot_boost_reply');

		expect((await reply('features', 'no-such-id', { body: 'hi' })).statusCode).toBe(404);
	});

	test('catalogue advertises feed + leaderboard pointers', async () => {
		const body = JSON.parse((await app.inject({ method: 'GET', url: '/v1/board' })).body);
		expect(body.leaderboard).toBe('GET /v1/board/leaderboard');
		expect(body.boards[0].feed_rss).toBe('GET /v1/board/features/feed.xml');
		expect(body.boards[0].feed_json).toBe('GET /v1/board/features/feed.json');
	});

	test('leaderboard ranks paid notices across boards; "leaderboard" is not treated as a board', async () => {
		const a = JSON.parse((await post('features', { title: 'Paid small', body: 'x' })).body);
		const b = JSON.parse((await post('data-requests', { title: 'Paid big', body: 'y' })).body);
		await post('features', { title: 'Free one', body: 'z' }); // unpaid → excluded
		await app.inject({ method: 'POST', url: `/v1/board/features/${a.id}/boost`, headers: { 'x-payment': paymentHeader('1000000') }, payload: { amountAtomic: 1_000_000 } });
		await app.inject({ method: 'POST', url: `/v1/board/data-requests/${b.id}/boost`, headers: { 'x-payment': paymentHeader('8000000') }, payload: { amountAtomic: 8_000_000 } });

		const lb = await app.inject({ method: 'GET', url: '/v1/board/leaderboard' });
		expect(lb.statusCode).toBe(200);
		const body = JSON.parse(lb.body);
		expect(body.top.map((n) => n.id)).toEqual([b.id, a.id]);
		expect(body.totals.paid).toBe(2);
		expect(body.totals.weight_usd).toBeCloseTo(9, 6);
	});

	test('feed.xml + feed.json serve a subscribable board page', async () => {
		const n = JSON.parse((await post('features', { title: 'Feed me <please>', body: 'a body' })).body);

		const rss = await app.inject({ method: 'GET', url: '/v1/board/features/feed.xml' });
		expect(rss.statusCode).toBe(200);
		expect(rss.headers['content-type']).toContain('application/rss+xml');
		expect(rss.body).toContain('<rss version="2.0"');
		expect(rss.body).toContain('Feed me &lt;please&gt;');
		expect(rss.body).toContain(`https://board.test/?board=features#${n.id}`);

		const json = await app.inject({ method: 'GET', url: '/v1/board/features/feed.json' });
		expect(json.statusCode).toBe(200);
		expect(json.headers['content-type']).toContain('application/feed+json');
		const feed = JSON.parse(json.body);
		expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
		expect(feed.items[0].title).toBe('Feed me <please>');
	});

	test('feed of an unknown board → 404', async () => {
		expect((await app.inject({ method: 'GET', url: '/v1/board/nope/feed.xml' })).statusCode).toBe(404);
	});

	test('owner can edit + withdraw; wrong token rejected', async () => {
		const created = JSON.parse((await post('features', { title: 'Mine', body: 'orig' })).body);

		const badEdit = await app.inject({
			method: 'PATCH', url: `/v1/board/features/${created.id}`,
			headers: { 'x-notice-token': 'nope' }, payload: { title: 'Hacked' }
		});
		expect(badEdit.statusCode).toBe(403);

		const goodEdit = await app.inject({
			method: 'PATCH', url: `/v1/board/features/${created.id}`,
			headers: { 'x-notice-token': created.ownerToken }, payload: { title: 'Edited title', body: 'updated' }
		});
		expect(goodEdit.statusCode).toBe(200);
		expect(JSON.parse(goodEdit.body).title).toBe('Edited title');

		const withdraw = await app.inject({
			method: 'DELETE', url: `/v1/board/features/${created.id}`,
			headers: { 'x-notice-token': created.ownerToken }
		});
		expect(withdraw.statusCode).toBe(200);
		expect(JSON.parse(withdraw.body).by).toBe('owner');
		expect((await app.inject({ method: 'GET', url: `/v1/board/features/${created.id}` })).statusCode).toBe(404);
	});

	test('operator can remove any notice with the admin key', async () => {
		const created = JSON.parse((await post('features', { title: 'Spam', body: 'junk' })).body);
		const r = await app.inject({
			method: 'DELETE', url: `/v1/board/features/${created.id}`,
			headers: { 'x-admin-key': 'super-secret-admin' }
		});
		expect(r.statusCode).toBe(200);
		expect(JSON.parse(r.body).by).toBe('operator');
	});

	test('report flags after threshold and hides from the list', async () => {
		const created = JSON.parse((await post('features', { title: 'Borderline', body: 'x' })).body);
		let last;
		for (let i = 0; i < 4; i++) {
			last = await app.inject({ method: 'POST', url: `/v1/board/features/${created.id}/report` });
		}
		expect(JSON.parse(last.body).status).toBe('flagged');
		const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/board/features' })).body);
		expect(list.count).toBe(0);
	});

	test('boost is 503 when x402 disabled', async () => {
		const app2 = Fastify({ logger: false });
		const db2 = openBoardDb(':memory:');
		registerNoticeBoardRoutes(app2, {
			boardDb: db2,
			x402Cfg: { ...X402_CFG, enabled: false },
			boards: BOARDS,
			facilitatorFactory: async () => fakeFacilitator
		});
		await app2.ready();
		const created = JSON.parse((await app2.inject({ method: 'POST', url: '/v1/board/features', payload: { title: 'X', body: 'y' } })).body);
		const r = await app2.inject({ method: 'POST', url: `/v1/board/features/${created.id}/boost`, payload: { amountAtomic: 100_000 } });
		expect(r.statusCode).toBe(503);
		await app2.close();
		db2.close();
	});

	test('routes 503 when no board DB', async () => {
		const app3 = Fastify({ logger: false });
		registerNoticeBoardRoutes(app3, { boardDb: null, x402Cfg: X402_CFG, boards: BOARDS });
		await app3.ready();
		expect((await app3.inject({ method: 'POST', url: '/v1/board/features', payload: { title: 'X', body: 'y' } })).statusCode).toBe(503);
		await app3.close();
	});
});
