// Tests for the notice-board pure logic + SQLite store.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
	BOARD_CONSTANTS,
	sanitiseText,
	normaliseHandle,
	validateUrl,
	normaliseTags,
	normaliseBoards,
	validatePostRequest,
	validateReplyRequest,
	deriveReplyTitle,
	validateBoostAmount,
	atomicToUsd,
	effectiveWeight,
	sortNotices,
	buildNoticeSummary,
	buildBoardRss,
	buildBoardJsonFeed,
	escapeXml,
	hashToken,
	verifyOwner,
	safeEqualHex
} from '../src/notice-board.js';
import {
	openBoardDb,
	createNotice,
	getNotice,
	listNotices,
	listReplies,
	countReplies,
	replyCountsForBoard,
	getLiveByBoardTitle,
	setNoticeParent,
	countNotices,
	boostNotice,
	editNotice,
	withdrawNotice,
	removeNotice,
	reportNotice,
	statsSnapshot,
	topBoostedNotices,
	pruneOld
} from '../src/notice-board-store.js';

const BOARDS = normaliseBoards([
	{ id: 'features', title: 'Features', description: 'requests' },
	{ id: 'data-requests', title: 'Data', description: 'asks' }
]);

describe('sanitiseText', () => {
	test('trims, strips control chars, caps length, collapses blank lines', () => {
		expect(sanitiseText('  hi \u0000\u0007 there  ', 100)).toBe('hi  there');
		expect(sanitiseText('a\r\nb\r\nc', 100)).toBe('a\nb\nc');
		expect(sanitiseText('x\n\n\n\n\ny', 100)).toBe('x\n\ny');
		expect(sanitiseText('abcdef', 3)).toBe('abc');
		expect(sanitiseText(null, 10)).toBe('');
	});
});

describe('normaliseHandle', () => {
	test('defaults to anon, strips junk, caps', () => {
		expect(normaliseHandle('')).toBe('anon');
		expect(normaliseHandle(null)).toBe('anon');
		expect(normaliseHandle('Alice <b>')).toBe('Alice b');
		expect(normaliseHandle('a'.repeat(80)).length).toBe(BOARD_CONSTANTS.HANDLE_MAX);
	});
});

describe('validateUrl', () => {
	test('null when empty; passes http(s); rejects other schemes + overlong', () => {
		expect(validateUrl('')).toBeNull();
		expect(validateUrl(null)).toBeNull();
		expect(validateUrl('https://seneschal.space/x')).toBe('https://seneschal.space/x');
		expect(() => validateUrl('javascript:alert(1)')).toThrow(/http/);
		expect(() => validateUrl('not a url')).toThrow();
		expect(() => validateUrl(`https://x.test/${'a'.repeat(500)}`)).toThrow(/exceeds/);
	});
});

describe('normaliseTags', () => {
	test('splits, lowercases, dedupes, caps count', () => {
		expect(normaliseTags('AMM, mev , mev,defi')).toEqual(['amm', 'mev', 'defi']);
		expect(normaliseTags(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length).toBe(BOARD_CONSTANTS.TAGS_MAX);
		expect(normaliseTags(null)).toEqual([]);
	});
});

describe('normaliseBoards', () => {
	test('keys by slug, rejects bad ids, falls back to general', () => {
		const m = normaliseBoards([{ id: 'Good-1', title: 'G' }, { id: 'BAD ID' }, { id: 'good-1' }]);
		expect(m.has('good-1')).toBe(true);
		expect(m.size).toBe(1); // dup slug ignored, bad id ignored
		expect(normaliseBoards([]).has('general')).toBe(true);
		expect(normaliseBoards(null).has('general')).toBe(true);
	});
});

describe('validatePostRequest', () => {
	test('accepts a good post and normalises fields', () => {
		const out = validatePostRequest({
			board: 'features', title: 'Add CSV export', body: 'please', handle: 'bot', url: 'https://x.test', tags: 'csv,export'
		}, { boards: BOARDS });
		expect(out.board).toBe('features');
		expect(out.handle).toBe('bot');
		expect(out.tags).toEqual(['csv', 'export']);
	});
	test('rejects unknown board, short title, empty body, non-object', () => {
		expect(() => validatePostRequest({ board: 'nope', title: 'hello there', body: 'x' }, { boards: BOARDS })).toThrow(/unknown board/);
		expect(() => validatePostRequest({ board: 'features', title: 'ab', body: 'x' }, { boards: BOARDS })).toThrow(/title/);
		expect(() => validatePostRequest({ board: 'features', title: 'long enough', body: '' }, { boards: BOARDS })).toThrow(/body/);
		expect(() => validatePostRequest(null, { boards: BOARDS })).toThrow(/object/);
	});
});

describe('validateBoostAmount', () => {
	test('accepts string/number/bigint, enforces range', () => {
		expect(validateBoostAmount('100000')).toBe(100_000n);
		expect(validateBoostAmount(250_000)).toBe(250_000n);
		expect(validateBoostAmount(1_000_000n)).toBe(1_000_000n);
		expect(() => validateBoostAmount(99_999)).toThrow(/out of range/);
		expect(() => validateBoostAmount(25_000_001)).toThrow(/out of range/);
		expect(() => validateBoostAmount(-1)).toThrow();
		expect(() => validateBoostAmount(1.5)).toThrow();
	});
});

describe('effectiveWeight / sortNotices / atomicToUsd', () => {
	test('atomicToUsd converts 6dp', () => {
		expect(atomicToUsd(1_000_000n)).toBe(1);
		expect(atomicToUsd(100_000)).toBe(0.1);
		expect(atomicToUsd(0)).toBe(0);
	});
	test('weight 0 scores 0; decay halves over one half-life', () => {
		const now = 1_000_000_000_000;
		expect(effectiveWeight({ weight_atomic: 0 }, { nowMs: now })).toBe(0);
		const w = effectiveWeight(
			{ weight_atomic: 1_000_000, bumped_ms: now - BOARD_CONSTANTS.DECAY_HALFLIFE_MS },
			{ nowMs: now }
		);
		expect(Math.round(w)).toBe(500_000);
	});
	test('boosted notices rank above free ones; free by recency', () => {
		const now = 2_000_000_000_000;
		const rows = [
			{ id: 'free-old', weight_atomic: 0, created_ms: now - 10_000, bumped_ms: now - 10_000 },
			{ id: 'free-new', weight_atomic: 0, created_ms: now - 1_000, bumped_ms: now - 1_000 },
			{ id: 'paid-small', weight_atomic: 200_000, created_ms: now - 5_000, bumped_ms: now - 5_000 },
			{ id: 'paid-big', weight_atomic: 5_000_000, created_ms: now - 5_000, bumped_ms: now - 5_000 }
		];
		const order = sortNotices(rows, { nowMs: now }).map((r) => r.id);
		expect(order).toEqual(['paid-big', 'paid-small', 'free-new', 'free-old']);
	});
});

describe('syndication feeds', () => {
	const board = { id: 'features', title: 'Feature requests', description: 'Ask & vote' };
	const notices = [
		buildNoticeSummary({
			id: 'n1', board: 'features', handle: 'alice', title: 'Add <CSV> export & "filters"',
			body: 'Please add a CSV.', url: 'https://x.test/a', tags: 'csv,export',
			created_ms: 1_700_000_000_000, bumped_ms: 1_700_000_500_000, weight_atomic: 2_000_000, boosts_count: 2, status: 'live'
		}, { nowMs: 1_700_000_600_000 }),
		buildNoticeSummary({
			id: 'n2', board: 'features', handle: 'bob', title: 'Plain idea',
			body: 'No url here', url: null, tags: '', created_ms: 1_700_000_100_000, bumped_ms: 1_700_000_100_000,
			weight_atomic: 0, boosts_count: 0, status: 'live'
		}, { nowMs: 1_700_000_600_000 })
	];

	test('escapeXml neutralises markup-significant characters', () => {
		expect(escapeXml('a<b>&"\'')).toBe('a&lt;b&gt;&amp;&quot;&apos;');
		expect(escapeXml(null)).toBe('');
	});

	test('buildBoardRss emits well-formed, escaped RSS with a site link', () => {
		const xml = buildBoardRss({ board, notices, siteUrl: 'https://board.test', apiBase: 'https://api.test', feedUrl: 'https://api.test/v1/board/features/feed.xml', nowMs: 1_700_000_600_000 });
		expect(xml.startsWith('<?xml')).toBe(true);
		expect(xml).toContain('<rss version="2.0"');
		expect(xml).toContain('<title>Feature requests</title>');
		// raw title characters must be escaped, never leak as live markup
		expect(xml).toContain('Add &lt;CSV&gt; export &amp; &quot;filters&quot;');
		expect(xml).not.toContain('<CSV>');
		// site link preferred over the API resource for human items
		expect(xml).toContain('https://board.test/?board=features#n1');
		expect(xml).toContain('<atom:link href="https://api.test/v1/board/features/feed.xml"');
		expect(xml).toContain('<category>csv</category>');
	});

	test('buildBoardRss falls back to API resource links when no site URL', () => {
		const xml = buildBoardRss({ board, notices, apiBase: 'https://api.test' });
		expect(xml).toContain('https://api.test/v1/board/features/n1');
	});

	test('buildBoardJsonFeed is JSON Feed 1.1 with per-item boost metadata', () => {
		const feed = buildBoardJsonFeed({ board, notices, siteUrl: 'https://board.test', apiBase: 'https://api.test', feedUrl: 'https://api.test/v1/board/features/feed.json' });
		expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
		expect(feed.items).toHaveLength(2);
		expect(feed.items[0].url).toBe('https://board.test/?board=features#n1');
		expect(feed.items[0].id).toBe('https://api.test/v1/board/features/n1');
		expect(feed.items[0]._seneschal.weight_usd).toBeCloseTo(2, 6);
		expect(feed.items[0].date_published).toBe(new Date(1_700_000_000_000).toISOString());
		expect(feed.items[1].content_text).toContain('No url here');
	});
});

describe('token hashing', () => {
	test('hashToken is deterministic; verifyOwner constant-time matches', () => {
		const h = hashToken('secrettoken');
		expect(h).toBe(hashToken('secrettoken'));
		expect(verifyOwner({ owner_token_hash: h }, 'secrettoken')).toBe(true);
		expect(verifyOwner({ owner_token_hash: h }, 'wrong')).toBe(false);
		expect(verifyOwner(null, 'x')).toBe(false);
		expect(safeEqualHex('aa', 'aabb')).toBe(false);
	});
});

describe('store CRUD + ranking + moderation', () => {
	let db;
	beforeEach(() => { db = openBoardDb(':memory:'); });
	afterEach(() => { db.close(); });

	test('create → get → list → boost lifts rank', () => {
		const now = 1_700_000_000_000;
		const a = createNotice(db, { board: 'features', title: 'A feature', body: 'a', handle: 'x', nowMs: now });
		const b = createNotice(db, { board: 'features', title: 'B feature', body: 'b', handle: 'y', nowMs: now + 1 });
		expect(getNotice(db, a.id).title).toBe('A feature');
		expect(countNotices(db, { board: 'features' })).toBe(2);

		const boosted = boostNotice(db, a.id, { addWeightAtomic: 5_000_000n, nowMs: now + 10 });
		expect(boosted.ok).toBe(true);
		expect(boosted.row.weight_atomic).toBe(5_000_000);
		expect(boosted.row.boosts_count).toBe(1);

		const ordered = sortNotices(listNotices(db, { board: 'features' }), { nowMs: now + 20 }).map((r) => r.id);
		expect(ordered[0]).toBe(a.id);
		expect(ordered).toContain(b.id);
	});

	test('owner edit/withdraw enforced by token; admin remove unconditional', () => {
		const created = createNotice(db, { board: 'features', title: 'Editable', body: 'orig', nowMs: 1 });
		expect(editNotice(db, created.id, 'wrong', { title: 'x', body: 'y' }).reason).toBe('forbidden');
		const ed = editNotice(db, created.id, created.token, { title: 'New title', body: 'new body', url: null, contact: null });
		expect(ed.ok).toBe(true);
		expect(ed.row.title).toBe('New title');

		expect(withdrawNotice(db, created.id, 'wrong').reason).toBe('forbidden');
		expect(withdrawNotice(db, created.id, created.token).ok).toBe(true);
		expect(getNotice(db, created.id).status).toBe('removed');

		const c2 = createNotice(db, { board: 'features', title: 'Spammy', body: 'junk', nowMs: 2 });
		expect(removeNotice(db, c2.id, { reason: 'abuse' }).ok).toBe(true);
		expect(getNotice(db, c2.id).status).toBe('removed');
		expect(getNotice(db, c2.id).removed_reason).toBe('abuse');
	});

	test('reportNotice auto-flags at threshold', () => {
		const c = createNotice(db, { board: 'features', title: 'Reportable', body: 'x', nowMs: 1 });
		let res;
		for (let i = 0; i < BOARD_CONSTANTS.REPORTS_FLAG_THRESHOLD; i++) res = reportNotice(db, c.id);
		expect(res.status).toBe('flagged');
		expect(getNotice(db, c.id).status).toBe('flagged');
		// flagged notices are excluded from the live list
		expect(listNotices(db, { board: 'features', status: 'live' }).length).toBe(0);
	});

	test('boost refuses non-live notices', () => {
		const c = createNotice(db, { board: 'features', title: 'Gone', body: 'x', nowMs: 1 });
		removeNotice(db, c.id);
		expect(boostNotice(db, c.id, { addWeightAtomic: 100_000n }).reason).toBe('not_live');
		expect(boostNotice(db, 'no-such-id', { addWeightAtomic: 100_000n }).reason).toBe('not_found');
	});

	test('statsSnapshot aggregates per board', () => {
		createNotice(db, { board: 'features', title: 'F1', body: 'x', nowMs: 1 });
		const paid = createNotice(db, { board: 'features', title: 'F2', body: 'x', nowMs: 2 });
		createNotice(db, { board: 'data-requests', title: 'D1', body: 'x', nowMs: 3 });
		boostNotice(db, paid.id, { addWeightAtomic: 1_000_000n, nowMs: 4 });
		const snap = statsSnapshot(db);
		expect(snap.boards.features.live).toBe(2);
		expect(snap.boards.features.paid).toBe(1);
		expect(snap.boards['data-requests'].live).toBe(1);
		expect(snap.total_live).toBe(3);
		expect(snap.total_paid).toBe(1);
		expect(snap.total_weight_atomic).toBe('1000000');
	});

	test('topBoostedNotices ranks paid notices across boards, excludes free', () => {
		createNotice(db, { board: 'features', title: 'Free one', body: 'x', nowMs: 1 });
		const a = createNotice(db, { board: 'features', title: 'Paid small', body: 'x', nowMs: 2 });
		const b = createNotice(db, { board: 'data-requests', title: 'Paid big', body: 'x', nowMs: 3 });
		boostNotice(db, a.id, { addWeightAtomic: 1_000_000n, nowMs: 4 });
		boostNotice(db, b.id, { addWeightAtomic: 9_000_000n, nowMs: 5 });
		const top = topBoostedNotices(db, { limit: 10 });
		expect(top.map((r) => r.id)).toEqual([b.id, a.id]); // big first, free excluded
		expect(topBoostedNotices(db, { limit: 1 }).map((r) => r.id)).toEqual([b.id]);
	});

	test('pruneOld drops faded free + long-removed rows', () => {
		const now = 5_000_000_000_000;
		const oldFree = createNotice(db, { board: 'features', title: 'Old free', body: 'x', nowMs: now - BOARD_CONSTANTS.FREE_NOTICE_TTL_MS - 1 });
		const oldPaid = createNotice(db, { board: 'features', title: 'Old paid', body: 'x', nowMs: now - BOARD_CONSTANTS.FREE_NOTICE_TTL_MS - 1 });
		boostNotice(db, oldPaid.id, { addWeightAtomic: 500_000n, nowMs: now - 1 });
		createNotice(db, { board: 'features', title: 'Fresh', body: 'x', nowMs: now });
		const res = pruneOld(db, { nowMs: now });
		expect(res.pruned_free).toBe(1);
		expect(getNotice(db, oldFree.id)).toBeNull();
		expect(getNotice(db, oldPaid.id)).not.toBeNull(); // boosted survives
	});

	// ── threading: replies, counts, linking, prune ───────────────
	test('replies ride under a root: listNotices is roots-only, listReplies is chronological', () => {
		const root = createNotice(db, { board: 'features', title: 'Thread root', body: 'x', nowMs: 100 });
		createNotice(db, { board: 'features', title: 'Re: Thread root', body: 'first', parentId: root.id, nowMs: 200 });
		createNotice(db, { board: 'features', title: 'Re: Thread root', body: 'second', parentId: root.id, nowMs: 300 });

		expect(listNotices(db, { board: 'features' }).map((r) => r.id)).toEqual([root.id]); // roots only
		expect(countNotices(db, { board: 'features' })).toBe(1); // thread count
		expect(countReplies(db, root.id)).toBe(2);
		expect(listReplies(db, root.id).map((r) => r.body)).toEqual(['first', 'second']); // oldest-first
		expect(replyCountsForBoard(db, 'features').get(root.id)).toBe(2);
	});

	test('statsSnapshot counts roots as live and replies separately; topBoosted excludes replies', () => {
		const root = createNotice(db, { board: 'features', title: 'Root', body: 'x', nowMs: 1 });
		createNotice(db, { board: 'features', title: 'Re: Root', body: 'r', parentId: root.id, nowMs: 2 });
		boostNotice(db, root.id, { addWeightAtomic: 1_000_000n, nowMs: 3 });
		const snap = statsSnapshot(db);
		expect(snap.boards.features.live).toBe(1);
		expect(snap.boards.features.replies).toBe(1);
		expect(snap.boards.features.paid).toBe(1);
		expect(snap.total_replies).toBe(1);
		expect(topBoostedNotices(db, { limit: 10 }).map((r) => r.id)).toEqual([root.id]); // reply never a leader
	});

	test('setNoticeParent links by id (collapsing to root); getLiveByBoardTitle finds the opener', () => {
		const root = createNotice(db, { board: 'features', title: 'Opener', body: 'x', nowMs: 1 });
		const flat = createNotice(db, { board: 'features', title: 'Re: Opener', body: 'a flat reply', nowMs: 2 });
		expect(getLiveByBoardTitle(db, 'features', 'Opener').id).toBe(root.id);

		const res = setNoticeParent(db, flat.id, root.id);
		expect(res).toEqual({ ok: true, parentId: root.id, changed: true });
		expect(getNotice(db, flat.id).parent_id).toBe(root.id);
		// idempotent: re-linking is a no-op
		expect(setNoticeParent(db, flat.id, root.id).changed).toBe(false);

		// reply-to-a-reply collapses onto the same root
		const deep = createNotice(db, { board: 'features', title: 'Re: Re', body: 'deep', nowMs: 3 });
		expect(setNoticeParent(db, deep.id, flat.id).parentId).toBe(root.id);
	});

	test('pruneOld sweeps orphan replies but protects a thread with live replies', () => {
		const now = 5_000_000_000_000;
		const oldRoot = createNotice(db, { board: 'features', title: 'Old root w/ reply', body: 'x', nowMs: now - BOARD_CONSTANTS.FREE_NOTICE_TTL_MS - 1 });
		createNotice(db, { board: 'features', title: 'Re: keep', body: 'recent reply', parentId: oldRoot.id, nowMs: now });
		const goneRoot = createNotice(db, { board: 'features', title: 'Removed root', body: 'x', nowMs: now });
		const orphan = createNotice(db, { board: 'features', title: 'Re: orphan', body: 'orphaned', parentId: goneRoot.id, nowMs: now });
		removeNotice(db, goneRoot.id, { reason: 'test' });

		const res = pruneOld(db, { nowMs: now });
		expect(getNotice(db, oldRoot.id)).not.toBeNull(); // protected: has a live reply
		expect(getNotice(db, orphan.id)).toBeNull();      // swept: parent no longer a live root
		expect(res.pruned_orphans).toBeGreaterThanOrEqual(1);
	});

	test('deriveReplyTitle strips a leading Re: and floors the length', () => {
		expect(deriveReplyTitle('Funding question')).toBe('Re: Funding question');
		expect(deriveReplyTitle('Re: Funding question')).toBe('Re: Funding question'); // no Re: Re:
		expect(deriveReplyTitle('')).toBe('Re: notice');
	});

	test('validateReplyRequest: board from parent, optional title, body required', () => {
		const parent = { id: 'root-1', board: 'features', title: 'Help me' };
		const v = validateReplyRequest({ body: 'sure', handle: 'bob' }, { parent });
		expect(v).toMatchObject({ board: 'features', parentId: 'root-1', title: 'Re: Help me', body: 'sure', handle: 'bob' });

		const withTitle = validateReplyRequest({ body: 'x', title: 'Custom' }, { parent });
		expect(withTitle.title).toBe('Custom');

		expect(() => validateReplyRequest({ body: '' }, { parent })).toThrow(/body is required/);
		expect(() => validateReplyRequest({ body: 'x' }, {})).toThrow(/parent/);
	});
});
