// Paid public notice board — pure logic (no DB, no Fastify).
//
// The board is a freemium, pay-to-rank bulletin: anyone (agent or human)
// can post for free, and ANYONE can attach USDC to a notice to push it up
// the board. Prominence = cumulative boost weight with a gentle time-decay
// so a one-off big spend doesn't pin the top forever. Reads are always
// free; the free post tier is rate-limited at the HTTP layer.
//
// Everything here is pure + unit-testable: validation, sanitisation,
// decay scoring, and the public projection. The SQLite side lives in
// notice-board-store.js and the routes in notice-board-routes.js.

import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const MS_PER_DAY = 86_400_000;

export const BOARD_CONSTANTS = Object.freeze({
	TITLE_MIN: 3,
	TITLE_MAX: 160,
	BODY_MIN: 1,
	BODY_MAX: 1200,
	HANDLE_MAX: 48,
	URL_MAX: 400,
	CONTACT_MAX: 140,
	TAGS_MAX: 5,
	TAG_MAX: 24,
	LIST_DEFAULT_LIMIT: 50,
	LIST_MAX_LIMIT: 200,
	// Threading: replies inlined per root in the list view (full thread via
	// the single-notice endpoint), and the hard cap a thread fetch returns.
	REPLIES_INLINE_CAP: 10,
	REPLIES_MAX: 200,
	RE_PREFIX: 'Re: ',
	// In-memory candidate cap for the decay re-sort. Boards beyond this
	// many live notices would need an SQL-side approximation; well past
	// anything v1 will see.
	SORT_SCAN_CAP: 1000,
	BOOST_MIN_ATOMIC: 100_000n,    // $0.10
	BOOST_MAX_ATOMIC: 25_000_000n, // $25.00 per single boost
	DECAY_HALFLIFE_MS: 7 * MS_PER_DAY,
	// Housekeeping TTLs applied opportunistically on post.
	FREE_NOTICE_TTL_MS: 60 * MS_PER_DAY,  // un-boosted notices fade after 60d
	REMOVED_TTL_MS: 7 * MS_PER_DAY,       // withdrawn/removed rows purged after 7d
	REPORTS_FLAG_THRESHOLD: 4,            // auto-hide pending operator review
	BOARD_ID_RE: /^[a-z0-9][a-z0-9-]{1,38}$/u
});

// ── sanitisation ────────────────────────────────────────────────────

// Trim, strip control characters (keep newline/tab), collapse blank-line
// runs, and hard-cap length. Defensive against header-injection and
// console-garbling payloads; the HTML surface escapes on render too.
export function sanitiseText(value, max) {
	if (value == null) return '';
	let s = String(value)
		.replace(/\r\n?/gu, '\n')
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
		.replace(/\n{3,}/gu, '\n\n')
		.trim();
	if (typeof max === 'number' && s.length > max) s = s.slice(0, max);
	return s;
}

export function normaliseHandle(value) {
	const s = sanitiseText(value, BOARD_CONSTANTS.HANDLE_MAX)
		.replace(/[\n\t]+/gu, ' ')
		.replace(/[^\w .@/-]/gu, '')
		.trim()
		.slice(0, BOARD_CONSTANTS.HANDLE_MAX);
	return s || 'anon';
}

// Optional single link. Returns null when empty, throws on anything that
// isn't an absolute http(s) URL (no javascript:, data:, mailto: etc).
export function validateUrl(value) {
	if (value == null || value === '') return null;
	const s = String(value).trim();
	if (s.length > BOARD_CONSTANTS.URL_MAX) {
		throw new TypeError(`url exceeds ${BOARD_CONSTANTS.URL_MAX} characters`);
	}
	let u;
	try { u = new URL(s); }
	catch { throw new TypeError('url must be a valid absolute http(s) URL'); }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		throw new TypeError('url must use http:// or https://');
	}
	return u.toString();
}

export function normaliseTags(value) {
	if (value == null) return [];
	const arr = Array.isArray(value) ? value : String(value).split(',');
	const out = [];
	for (const raw of arr) {
		const tag = sanitiseText(raw, BOARD_CONSTANTS.TAG_MAX)
			.toLowerCase()
			.replace(/[^a-z0-9-]/gu, '');
		if (tag && !out.includes(tag)) out.push(tag);
		if (out.length >= BOARD_CONSTANTS.TAGS_MAX) break;
	}
	return out;
}

// ── boards ──────────────────────────────────────────────────────────

// Normalise a host-supplied board list (array of {id,title,description})
// into a frozen Map keyed by slug. Falls back to a single 'general' board
// so the standalone gateway is usable with zero config. A function (not
// an exported array) so callers can't mutate shared board state.
export function normaliseBoards(boards) {
	const list = Array.isArray(boards) ? boards : [];
	const out = new Map();
	for (const b of list) {
		if (!b || typeof b !== 'object') continue;
		const id = String(b.id ?? '').trim().toLowerCase();
		if (!BOARD_CONSTANTS.BOARD_ID_RE.test(id) || out.has(id)) continue;
		out.set(id, Object.freeze({
			id,
			title: sanitiseText(b.title ?? id, 80) || id,
			description: sanitiseText(b.description ?? '', 240)
		}));
	}
	if (out.size === 0) {
		out.set('general', Object.freeze({ id: 'general', title: 'General', description: 'General notices.' }));
	}
	return out;
}

// ── request validation ──────────────────────────────────────────────

export function validatePostRequest(body, { boards } = {}) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}
	const board = String(body.board ?? '').trim().toLowerCase();
	if (!(boards instanceof Map) || !boards.has(board)) {
		const valid = boards instanceof Map ? [...boards.keys()].join(', ') : '(none configured)';
		throw new TypeError(`unknown board "${board}"; valid boards: ${valid}`);
	}
	const title = sanitiseText(body.title, BOARD_CONSTANTS.TITLE_MAX);
	if (title.length < BOARD_CONSTANTS.TITLE_MIN) {
		throw new TypeError(`title is required (${BOARD_CONSTANTS.TITLE_MIN}+ characters)`);
	}
	const text = sanitiseText(body.body, BOARD_CONSTANTS.BODY_MAX);
	if (text.length < BOARD_CONSTANTS.BODY_MIN) {
		throw new TypeError('body is required');
	}
	return Object.freeze({
		board,
		title,
		body: text,
		handle: normaliseHandle(body.handle),
		url: validateUrl(body.url),
		contact: sanitiseText(body.contact, BOARD_CONSTANTS.CONTACT_MAX) || null,
		tags: normaliseTags(body.tags)
	});
}

// Derive a reply title from the parent's when the poster gives none. Strips a
// leading "Re:" so a deep thread doesn't accrue "Re: Re: Re:", and guarantees
// the TITLE_MIN floor.
export function deriveReplyTitle(parentTitle) {
	const base = String(parentTitle ?? '').replace(/^\s*re:\s*/iu, '').trim();
	if (!base) return `${BOARD_CONSTANTS.RE_PREFIX}notice`;
	return `${BOARD_CONSTANTS.RE_PREFIX}${base}`.slice(0, BOARD_CONSTANTS.TITLE_MAX);
}

// Validate a reply. The board comes from the parent (a reply can't change
// boards), title is OPTIONAL (auto-derived from the parent when omitted), and
// body is required. Everything else mirrors validatePostRequest.
export function validateReplyRequest(body, { parent } = {}) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}
	if (!parent || typeof parent !== 'object' || !parent.id || !parent.board) {
		throw new TypeError('reply requires a parent notice');
	}
	const text = sanitiseText(body.body, BOARD_CONSTANTS.BODY_MAX);
	if (text.length < BOARD_CONSTANTS.BODY_MIN) {
		throw new TypeError('body is required');
	}
	let title = sanitiseText(body.title, BOARD_CONSTANTS.TITLE_MAX);
	if (title.length < BOARD_CONSTANTS.TITLE_MIN) {
		title = deriveReplyTitle(parent.title);
	}
	return Object.freeze({
		board: parent.board,
		parentId: parent.id,
		title,
		body: text,
		handle: normaliseHandle(body.handle),
		url: validateUrl(body.url),
		contact: sanitiseText(body.contact, BOARD_CONSTANTS.CONTACT_MAX) || null,
		tags: normaliseTags(body.tags)
	});
}

// Validate a boost amount (atomic USDC, 6 decimals). Accepts string,
// integer number, or bigint; returns a bigint. Throws on bad input or
// out-of-range. Mirrors the custom-topup validator's contract.
export function validateBoostAmount(raw) {
	let atomic;
	if (typeof raw === 'bigint') atomic = raw;
	else if (typeof raw === 'string' && /^\d+$/u.test(raw)) atomic = BigInt(raw);
	else if (typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) atomic = BigInt(raw);
	else throw new TypeError('amountAtomic must be a positive integer (atomic USDC, 6 decimals)');
	if (atomic < BOARD_CONSTANTS.BOOST_MIN_ATOMIC || atomic > BOARD_CONSTANTS.BOOST_MAX_ATOMIC) {
		throw new TypeError(`amountAtomic out of range: must be between ${BOARD_CONSTANTS.BOOST_MIN_ATOMIC} ($${atomicToUsd(BOARD_CONSTANTS.BOOST_MIN_ATOMIC)}) and ${BOARD_CONSTANTS.BOOST_MAX_ATOMIC} ($${atomicToUsd(BOARD_CONSTANTS.BOOST_MAX_ATOMIC)})`);
	}
	return atomic;
}

// ── scoring / ranking ───────────────────────────────────────────────

export function atomicToUsd(atomic) {
	return Math.round(Number(atomic ?? 0)) / 1_000_000;
}

// Effective rank weight: raw boost decayed by time since the last boost.
// Un-boosted (weight 0) notices always score 0 and sort by recency below
// any boosted notice.
export function effectiveWeight(row, { nowMs = Date.now(), halflifeMs = BOARD_CONSTANTS.DECAY_HALFLIFE_MS } = {}) {
	const w = Number(row?.weight_atomic ?? 0);
	if (w <= 0) return 0;
	const last = Number(row?.bumped_ms ?? row?.created_ms ?? nowMs);
	const age = Math.max(0, nowMs - last);
	return w * Math.pow(0.5, age / halflifeMs);
}

// Stable ranking: boosted notices by decayed weight (desc), then anything
// remaining by recency (desc). Pure — operates on a copy.
export function sortNotices(rows, { nowMs = Date.now(), halflifeMs } = {}) {
	return [...rows].sort((a, b) => {
		const ea = effectiveWeight(a, { nowMs, halflifeMs });
		const eb = effectiveWeight(b, { nowMs, halflifeMs });
		if (eb !== ea) return eb - ea;
		return Number(b.created_ms ?? 0) - Number(a.created_ms ?? 0);
	});
}

// Public projection — never leaks the owner-token hash or report count.
export function buildNoticeSummary(row, { nowMs = Date.now() } = {}) {
	return {
		id: row.id,
		board: row.board,
		handle: row.handle ?? 'anon',
		title: row.title,
		body: row.body,
		url: row.url ?? null,
		contact: row.contact ?? null,
		tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
		created_ms: Number(row.created_ms),
		bumped_ms: Number(row.bumped_ms),
		weight_atomic: String(row.weight_atomic ?? 0),
		weight_usd: atomicToUsd(row.weight_atomic),
		boosts_count: Number(row.boosts_count ?? 0),
		score: Math.round(effectiveWeight(row, { nowMs })),
		status: row.status ?? 'live',
		parent_id: row.parent_id ?? null,
		is_reply: Boolean(row.parent_id)
	};
}

// ── syndication feeds (RSS 2.0 + JSON Feed 1.1) ─────────────────────
//
// Pure: take already-projected notice summaries (buildNoticeSummary
// output) plus board metadata and base URLs, return a serialised feed
// string. No I/O — the route does the DB read + ranking and passes the
// page in. Lets agents/humans subscribe to a board instead of polling.

// Minimal XML text escape for element content + double-quoted attrs.
export function escapeXml(value) {
	return String(value ?? '')
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;')
		.replace(/"/gu, '&quot;')
		.replace(/'/gu, '&apos;');
}

// Per-notice public link. Prefers the human board page (with a board
// filter + id anchor) when a site URL is given; falls back to the API
// single-notice resource so the link always resolves to something.
function noticeLink(notice, { siteUrl, apiBase }) {
	const board = encodeURIComponent(notice.board);
	const id = encodeURIComponent(notice.id);
	if (siteUrl) return `${siteUrl.replace(/\/$/u, '')}/?board=${board}#${id}`;
	return `${(apiBase ?? '').replace(/\/$/u, '')}/v1/board/${board}/${id}`;
}

function noticeGuid(notice, { apiBase }) {
	return `${(apiBase ?? '').replace(/\/$/u, '')}/v1/board/${encodeURIComponent(notice.board)}/${encodeURIComponent(notice.id)}`;
}

function feedItemDescription(notice) {
	const w = Number(notice.weight_usd ?? 0);
	const rank = w > 0
		? ` [boosted $${w.toFixed(2)} · ${notice.boosts_count ?? 0} boost${notice.boosts_count === 1 ? '' : 's'}]`
		: '';
	const link = notice.url ? `\n\nLink: ${notice.url}` : '';
	return `${notice.body ?? ''}${link}${rank}`;
}

export function buildBoardRss({ board, notices = [], siteUrl = null, apiBase = '', feedUrl = '', nowMs = Date.now() }) {
	const channelLink = siteUrl ? `${siteUrl.replace(/\/$/u, '')}/?board=${encodeURIComponent(board.id)}` : `${apiBase}/v1/board/${board.id}`;
	const items = notices.map((n) => {
		const pub = new Date(Number(n.created_ms ?? nowMs)).toUTCString();
		return [
			'    <item>',
			`      <title>${escapeXml(n.title)}</title>`,
			`      <link>${escapeXml(noticeLink(n, { siteUrl, apiBase }))}</link>`,
			`      <guid isPermaLink="false">${escapeXml(noticeGuid(n, { apiBase }))}</guid>`,
			`      <pubDate>${pub}</pubDate>`,
			`      <author>${escapeXml(n.handle ?? 'anon')}</author>`,
			...(n.tags ?? []).map((t) => `      <category>${escapeXml(t)}</category>`),
			`      <description>${escapeXml(feedItemDescription(n))}</description>`,
			'    </item>'
		].join('\n');
	}).join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		'  <channel>',
		`    <title>${escapeXml(board.title ?? board.id)}</title>`,
		`    <link>${escapeXml(channelLink)}</link>`,
		`    <description>${escapeXml(board.description ?? '')}</description>`,
		...(feedUrl ? [`    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`] : []),
		`    <lastBuildDate>${new Date(nowMs).toUTCString()}</lastBuildDate>`,
		items,
		'  </channel>',
		'</rss>',
		''
	].join('\n');
}

export function buildBoardJsonFeed({ board, notices = [], siteUrl = null, apiBase = '', feedUrl = '' }) {
	return {
		version: 'https://jsonfeed.org/version/1.1',
		title: board.title ?? board.id,
		home_page_url: siteUrl ? `${siteUrl.replace(/\/$/u, '')}/?board=${encodeURIComponent(board.id)}` : `${apiBase}/v1/board/${board.id}`,
		feed_url: feedUrl || undefined,
		description: board.description ?? '',
		items: notices.map((n) => ({
			id: noticeGuid(n, { apiBase }),
			url: noticeLink(n, { siteUrl, apiBase }),
			title: n.title,
			content_text: feedItemDescription(n),
			date_published: new Date(Number(n.created_ms ?? Date.now())).toISOString(),
			date_modified: new Date(Number(n.bumped_ms ?? n.created_ms ?? Date.now())).toISOString(),
			tags: n.tags ?? [],
			authors: [{ name: n.handle ?? 'anon' }],
			_seneschal: { weight_usd: n.weight_usd ?? 0, boosts_count: n.boosts_count ?? 0, score: n.score ?? 0 }
		}))
	};
}

// ── identifiers / token hashing ─────────────────────────────────────

export function genNoticeId() {
	return randomUUID();
}

export function genOwnerToken() {
	return randomBytes(24).toString('base64url');
}

export function hashToken(token) {
	return createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time hex-string compare; false on length mismatch or bad input
// rather than throwing (callers treat any non-true as "not authorised").
export function safeEqualHex(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
		return false;
	}
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
	} catch {
		return false;
	}
}

export function verifyOwner(row, token) {
	if (!row || !token) return false;
	return safeEqualHex(row.owner_token_hash ?? '', hashToken(token));
}
