// Unit tests for the notice-board MCP tool handlers. We drive them with a
// stub server (records registerTool calls) so we exercise our logic without
// standing up the MCP SDK transport — the same shape the SDK invokes.

import { describe, test, expect } from '@jest/globals';

import { registerNoticeBoardMcpTools } from '../src/mcp-tools.js';
import { openBoardDb, createNotice, boostNotice } from '../src/notice-board-store.js';

function fakeServer() {
	const tools = new Map();
	return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}
function parse(res) { return JSON.parse(res.content[0].text); }

const BOARDS = [{ id: 'features', title: 'Features', description: 'asks' }];

describe('registerNoticeBoardMcpTools', () => {
	test('registers the five board tools under the prefix', () => {
		const s = fakeServer();
		const out = registerNoticeBoardMcpTools(s, { boards: BOARDS, toolPrefix: 'sns', boardDb: null });
		expect(out.names).toEqual(['sns_board_list', 'sns_board_read', 'sns_board_post', 'sns_board_reply', 'sns_board_boost']);
		expect([...s.tools.keys()]).toEqual(out.names);
	});

	test('board_post / board_reply / board_boost return ready-to-send REST pointers', async () => {
		const s = fakeServer();
		registerNoticeBoardMcpTools(s, { boards: BOARDS, toolPrefix: 'sns', boardDb: null });
		const post = parse(await s.tools.get('sns_board_post').handler({ board: 'features', title: 'Hi there', body: 'please' }));
		expect(post.post_endpoint).toBe('/v1/board/features');
		expect(post.body.title).toBe('Hi there');
		const replyT = parse(await s.tools.get('sns_board_reply').handler({ board: 'features', id: 'abc', body: 'me too' }));
		expect(replyT.reply_endpoint).toBe('/v1/board/features/abc/reply');
		expect(replyT.body.body).toBe('me too');
		const boost = parse(await s.tools.get('sns_board_boost').handler({ board: 'features', id: 'abc', amountAtomic: 100_000 }));
		expect(boost.boost_endpoint).toBe('/v1/board/features/abc/boost');
		expect(boost.body.amountAtomic).toBe(100_000);
	});

	test('board_list / board_read do real work against an injected DB', async () => {
		const db = openBoardDb(':memory:');
		const c = createNotice(db, { board: 'features', title: 'Real notice', body: 'x', nowMs: 1 });
		boostNotice(db, c.id, { addWeightAtomic: 1_000_000n, nowMs: 2 });
		const s = fakeServer();
		registerNoticeBoardMcpTools(s, { boards: BOARDS, toolPrefix: 'sns', boardDb: db });

		const list = parse(await s.tools.get('sns_board_list').handler({}));
		expect(list.boards[0].live).toBe(1);
		expect(list.boards[0].paid).toBe(1);

		const read = parse(await s.tools.get('sns_board_read').handler({ board: 'features' }));
		expect(read.count).toBe(1);
		expect(read.notices[0].title).toBe('Real notice');
		db.close();
	});
});
