// Paid notice board — SQLite persistence.
//
// Its own small writable DB (one table). Privacy-respecting: we store the
// poster's chosen handle and an owner-token HASH (for edit/withdraw), but
// never the IP or any payer identity — free-post abuse is bounded by the
// HTTP rate limit, not by logging who posted.

import Database from 'better-sqlite3';
import {
	BOARD_CONSTANTS,
	genNoticeId,
	genOwnerToken,
	hashToken,
	verifyOwner
} from './notice-board.js';

// `parent_id` (nullable) turns the flat board into one-level threads: a row
// with parent_id = NULL is a root notice; a row with parent_id = <root id> is
// a reply under that thread. Replies are never boosted and never appear as
// top-level list items — they ride under their root. One level only: a reply
// to a reply collapses onto the same root (see the routes / setNoticeParent).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS notices (
	id              TEXT PRIMARY KEY,
	board           TEXT NOT NULL,
	handle          TEXT,
	title           TEXT NOT NULL,
	body            TEXT NOT NULL,
	url             TEXT,
	contact         TEXT,
	tags            TEXT,
	created_ms      INTEGER NOT NULL,
	bumped_ms       INTEGER NOT NULL,
	weight_atomic   INTEGER NOT NULL DEFAULT 0,
	boosts_count    INTEGER NOT NULL DEFAULT 0,
	reports_count   INTEGER NOT NULL DEFAULT 0,
	status          TEXT NOT NULL DEFAULT 'live',
	removed_reason  TEXT,
	owner_token_hash TEXT NOT NULL,
	parent_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_board_status
	ON notices(board, status, weight_atomic DESC, bumped_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_ms);
`;

// Idempotent column add for DBs created before threading shipped. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so probe table_info first.
function ensureColumn(db, table, column, decl) {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all();
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
	}
}

export function openBoardDb(path = ':memory:') {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 3000');
	db.exec(SCHEMA);
	// Migrate pre-threading DBs, THEN create the index that needs the column
	// (a fresh DB already has parent_id from SCHEMA; the index create is a
	// no-op the second time).
	ensureColumn(db, 'notices', 'parent_id', 'TEXT');
	db.exec('CREATE INDEX IF NOT EXISTS idx_notices_parent ON notices(parent_id, created_ms)');
	return db;
}

export function createNotice(db, { board, handle, title, body, url, contact, tags, parentId = null, nowMs = Date.now() }) {
	const id = genNoticeId();
	const token = genOwnerToken();
	db.prepare(`
		INSERT INTO notices
			(id, board, handle, title, body, url, contact, tags, created_ms, bumped_ms, weight_atomic, owner_token_hash, parent_id)
		VALUES
			(@id, @board, @handle, @title, @body, @url, @contact, @tags, @now, @now, 0, @hash, @parent)
	`).run({
		id,
		board,
		handle: handle ?? 'anon',
		title,
		body,
		url: url ?? null,
		contact: contact ?? null,
		tags: (Array.isArray(tags) && tags.length) ? tags.join(',') : null,
		now: nowMs,
		hash: hashToken(token),
		parent: parentId ?? null
	});
	return { id, token };
}

export function getNotice(db, id) {
	return db.prepare('SELECT * FROM notices WHERE id = ?').get(id) ?? null;
}

// Top-level (root) notices for a board — replies are excluded; they ride
// under their root via listReplies. This feeds the ranked list + the feeds.
export function listNotices(db, { board, status = 'live', limit = BOARD_CONSTANTS.SORT_SCAN_CAP } = {}) {
	return db.prepare(`
		SELECT * FROM notices
		WHERE board = ? AND status = ? AND parent_id IS NULL
		ORDER BY weight_atomic DESC, bumped_ms DESC
		LIMIT ?
	`).all(board, status, limit);
}

// Replies under one root, oldest-first (reads as a conversation).
export function listReplies(db, parentId, { status = 'live', limit = BOARD_CONSTANTS.REPLIES_MAX } = {}) {
	return db.prepare(`
		SELECT * FROM notices
		WHERE parent_id = ? AND status = ?
		ORDER BY created_ms ASC
		LIMIT ?
	`).all(parentId, status, limit);
}

export function countReplies(db, parentId, { status = 'live' } = {}) {
	return db.prepare('SELECT COUNT(*) AS n FROM notices WHERE parent_id = ? AND status = ?').get(parentId, status)?.n ?? 0;
}

// One grouped query → Map(rootId → live reply count) for a whole board, so
// the list route can annotate every root without N round-trips.
export function replyCountsForBoard(db, board, { status = 'live' } = {}) {
	const rows = db.prepare(`
		SELECT parent_id AS pid, COUNT(*) AS n
		FROM notices
		WHERE board = ? AND status = ? AND parent_id IS NOT NULL
		GROUP BY parent_id
	`).all(board, status);
	const m = new Map();
	for (const r of rows) m.set(r.pid, r.n);
	return m;
}

export function countNotices(db, { board, status = 'live' }) {
	return db.prepare("SELECT COUNT(*) AS n FROM notices WHERE board = ? AND status = ? AND parent_id IS NULL").get(board, status)?.n ?? 0;
}

// Look up a live notice by (board, title) — used by the seeder to find a
// thread opener so its replies can be linked idempotently.
export function getLiveByBoardTitle(db, board, title) {
	return db.prepare("SELECT * FROM notices WHERE board = ? AND title = ? AND status = 'live' LIMIT 1").get(board, title) ?? null;
}

// Link an existing notice as a reply under `parentId` (idempotent migration
// path for the seeder). Collapses to one level: if the parent is itself a
// reply, the child attaches to the parent's root. No-ops on cross-board or
// self-reference.
export function setNoticeParent(db, id, parentId) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	const parent = getNotice(db, parentId);
	if (!parent) return { ok: false, reason: 'parent_not_found' };
	if (parent.board !== row.board) return { ok: false, reason: 'cross_board' };
	const rootId = parent.parent_id ?? parentId;
	if (rootId === id) return { ok: false, reason: 'self' };
	if (row.parent_id === rootId) return { ok: true, parentId: rootId, changed: false };
	db.prepare('UPDATE notices SET parent_id = ? WHERE id = ?').run(rootId, id);
	return { ok: true, parentId: rootId, changed: true };
}

// Highest-weight live notices across ALL boards — feeds the cross-board
// "leaderboard" (top-boosted) view and the stats-page panel. Only paid
// (weight > 0) notices qualify; an un-boosted notice is never a leader.
export function topBoostedNotices(db, { limit = 10 } = {}) {
	const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
	return db.prepare(`
		SELECT * FROM notices
		WHERE status = 'live' AND weight_atomic > 0 AND parent_id IS NULL
		ORDER BY weight_atomic DESC, bumped_ms DESC
		LIMIT ?
	`).all(n);
}

// Add settled boost weight and bump the notice. Returns the updated row.
// Only boosts a 'live' notice — a removed/flagged one can't be paid up.
export function boostNotice(db, id, { addWeightAtomic, nowMs = Date.now() }) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.status !== 'live') return { ok: false, reason: 'not_live' };
	const add = Number(BigInt(addWeightAtomic));
	db.prepare(`
		UPDATE notices
		SET weight_atomic = weight_atomic + ?, boosts_count = boosts_count + 1, bumped_ms = ?
		WHERE id = ?
	`).run(add, nowMs, id);
	return { ok: true, row: getNotice(db, id) };
}

// Owner edit. Caller passes already-sanitised final values. Does not bump
// ranking (editing isn't a boost).
export function editNotice(db, id, token, { title, body, url, contact }) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (!verifyOwner(row, token)) return { ok: false, reason: 'forbidden' };
	if (row.status === 'removed') return { ok: false, reason: 'removed' };
	db.prepare('UPDATE notices SET title = ?, body = ?, url = ?, contact = ? WHERE id = ?')
		.run(title, body, url ?? null, contact ?? null, id);
	return { ok: true, row: getNotice(db, id) };
}

export function withdrawNotice(db, id, token) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (!verifyOwner(row, token)) return { ok: false, reason: 'forbidden' };
	db.prepare("UPDATE notices SET status = 'removed', removed_reason = 'withdrawn' WHERE id = ?").run(id);
	return { ok: true };
}

// Operator removal — no owner token, gated by the admin key at the route.
export function removeNotice(db, id, { reason = 'operator' } = {}) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	db.prepare("UPDATE notices SET status = 'removed', removed_reason = ? WHERE id = ?")
		.run(String(reason).slice(0, 120), id);
	return { ok: true };
}

// Community report. Auto-flags (hides from the default list, pending
// operator review) once reports cross the threshold.
export function reportNotice(db, id, { flagThreshold = BOARD_CONSTANTS.REPORTS_FLAG_THRESHOLD } = {}) {
	const row = getNotice(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.status !== 'live') return { ok: true, status: row.status, reports: row.reports_count };
	const reports = row.reports_count + 1;
	const status = reports >= flagThreshold ? 'flagged' : 'live';
	db.prepare('UPDATE notices SET reports_count = ?, status = ? WHERE id = ?').run(reports, status, id);
	return { ok: true, status, reports };
}

// Per-board rollup. `live` counts ROOT notices (threads); `replies` counts
// reply rows separately so "live" stays a thread count consistent with the
// list view, while replies still surface as visible activity.
export function statsSnapshot(db) {
	const rows = db.prepare(`
		SELECT board,
		       SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) AS live,
		       SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS replies,
		       COALESCE(SUM(weight_atomic), 0) AS weight,
		       SUM(CASE WHEN parent_id IS NULL AND weight_atomic > 0 THEN 1 ELSE 0 END) AS paid
		FROM notices WHERE status = 'live'
		GROUP BY board
	`).all();
	const boards = {};
	let totalLive = 0;
	let totalReplies = 0;
	let totalWeight = 0;
	let totalPaid = 0;
	for (const r of rows) {
		boards[r.board] = { live: r.live, replies: r.replies, paid: r.paid, weight_atomic: String(r.weight ?? 0) };
		totalLive += r.live;
		totalReplies += r.replies;
		totalWeight += Number(r.weight ?? 0);
		totalPaid += r.paid;
	}
	return {
		boards,
		total_live: totalLive,
		total_replies: totalReplies,
		total_paid: totalPaid,
		total_weight_atomic: String(totalWeight)
	};
}

// Opportunistic housekeeping (called on post). Drops faded un-boosted
// notices and long-removed rows so the table stays bounded without a cron.
// Threading-aware: orphan replies (whose root is gone or no longer a live
// root) are swept, and a free root is only pruned once its thread is empty —
// an active conversation keeps the opener alive past the free TTL.
export function pruneOld(db, {
	nowMs = Date.now(),
	freeTtlMs = BOARD_CONSTANTS.FREE_NOTICE_TTL_MS,
	removedTtlMs = BOARD_CONSTANTS.REMOVED_TTL_MS
} = {}) {
	const orphans = db.prepare(`
		DELETE FROM notices
		WHERE parent_id IS NOT NULL
		  AND parent_id NOT IN (SELECT id FROM notices WHERE status = 'live' AND parent_id IS NULL)
	`).run();
	const free = db.prepare(`
		DELETE FROM notices
		WHERE status = 'live' AND parent_id IS NULL AND weight_atomic = 0 AND created_ms < ?
		  AND id NOT IN (SELECT DISTINCT parent_id FROM notices WHERE parent_id IS NOT NULL AND status = 'live')
	`).run(nowMs - freeTtlMs);
	const removed = db.prepare("DELETE FROM notices WHERE status = 'removed' AND created_ms < ?")
		.run(nowMs - removedTtlMs);
	return { pruned_orphans: orphans.changes, pruned_free: free.changes, pruned_removed: removed.changes };
}
