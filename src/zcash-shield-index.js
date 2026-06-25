// Zcash shield/deshield amount index — SQLite persistence + chain scanner.
//
// Builds a histogram of the transparent BOUNDARY amounts people actually
// shield (t→z) and deshield (z→t), so the amount-privacy advisor can answer
// "how many others used this exact amount?" and suggest popular blend-in
// amounts from real on-chain behaviour instead of a hard-coded list.
//
// Data source: an operator-run zebra full node (the same one behind /v1/q/zec).
// `getblock(height, 2)` returns full verbose transactions inline (one RPC call
// per block, no per-tx round-trips), each carrying the Sapling/Orchard
// valueBalance fields the classifier needs (see classifyBoundaryTx). The
// scanner is incremental and rolling: it records a cursor and resumes, so a
// systemd timer can walk the chain a slice at a time.
//
// We store EXACT zatoshi amounts (per side) with a count + height range. Round
// human amounts (1, 10, 25, 100 ZEC …) naturally accumulate high counts; random
// one-off amounts stay near count=1 and are filtered out at query time (and can
// be pruned). Nothing here touches view keys or identities — only public
// transparent value balances that anyone with a node can read.

import Database from 'better-sqlite3';

import { zecRpc as defaultZecRpc } from './queries-q-chain.js';
import {
	classifyBoundaryTx,
	MIN_BOUNDARY_ZAT_DEFAULT,
	zatsToZec,
	formatZec
} from './zcash-amount-privacy.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shield_amounts (
	side         TEXT NOT NULL,
	amount_zat   INTEGER NOT NULL,
	count        INTEGER NOT NULL DEFAULT 0,
	first_height INTEGER NOT NULL,
	last_height  INTEGER NOT NULL,
	PRIMARY KEY (side, amount_zat)
);
CREATE INDEX IF NOT EXISTS idx_shield_amounts_pop ON shield_amounts(side, count DESC);

CREATE TABLE IF NOT EXISTS shield_index_meta (
	key   TEXT PRIMARY KEY,
	value TEXT
);
`;

export const SHIELD_SIDES = Object.freeze(['shield', 'deshield']);

// Query defaults. A "popular" amount needs at least this many independent
// observations before we advertise it as a place to hide — a count of 1 is a
// fingerprint, not a crowd.
export const DEFAULT_MIN_COUNT = 3;
export const DEFAULT_POPULAR_LIMIT = 16;
export const DEFAULT_NEARBY_LIMIT = 8;

export function openShieldIndexDb(path = ':memory:') {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 3000');
	db.exec(SCHEMA);
	return db;
}

// Memoised read handle, one per path. The REST app and the per-request MCP
// servers both want the index without each opening (and creating) their own
// file handle. Opening fails soft → callers degrade to the bundled blend-in
// list. Injected handles (tests) bypass this entirely.
let _sharedDb = null;
let _sharedDbPath = null;
export function openSharedShieldIndexDb(path) {
	if (!path) return null;
	if (_sharedDb && _sharedDbPath === path) return _sharedDb;
	try {
		_sharedDb = openShieldIndexDb(path);
		_sharedDbPath = path;
		return _sharedDb;
	} catch {
		return null;
	}
}

// ── meta / cursor ────────────────────────────────────────────────

export function setMeta(db, key, value) {
	db.prepare('INSERT INTO shield_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(key, String(value));
}

export function getMeta(db, key) {
	const row = db.prepare('SELECT value FROM shield_index_meta WHERE key = ?').get(key);
	return row ? row.value : null;
}

/** { indexedFrom, indexedThrough } — null when nothing scanned yet. */
export function getCursor(db) {
	const from = getMeta(db, 'indexed_from');
	const through = getMeta(db, 'indexed_through');
	return {
		indexedFrom: from === null ? null : Number(from),
		indexedThrough: through === null ? null : Number(through)
	};
}

export function setCursor(db, { from, through }) {
	const cur = getCursor(db);
	const newFrom = cur.indexedFrom === null ? from : Math.min(cur.indexedFrom, from);
	const newThrough = cur.indexedThrough === null ? through : Math.max(cur.indexedThrough, through);
	setMeta(db, 'indexed_from', newFrom);
	setMeta(db, 'indexed_through', newThrough);
	return { indexedFrom: newFrom, indexedThrough: newThrough };
}

// ── writes ───────────────────────────────────────────────────────

const BUMP_SQL = `
INSERT INTO shield_amounts (side, amount_zat, count, first_height, last_height)
VALUES (@side, @amount, 1, @height, @height)
ON CONFLICT(side, amount_zat) DO UPDATE SET
	count = count + 1,
	first_height = MIN(first_height, @height),
	last_height = MAX(last_height, @height)
`;

/** Record one observed boundary crossing. */
export function bumpAmount(db, { side, amountZat, height }) {
	if (!SHIELD_SIDES.includes(side)) throw new TypeError(`bumpAmount: bad side '${side}'`);
	const amount = Math.round(Number(amountZat));
	if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('bumpAmount: amountZat must be a positive integer');
	db.prepare(BUMP_SQL).run({ side, amount, height: Math.round(Number(height) || 0) });
}

// ── reads ────────────────────────────────────────────────────────

const rowToEntry = (r) => ({
	side: r.side,
	zats: r.amount_zat,
	zec: zatsToZec(r.amount_zat),
	label: `${formatZec(r.amount_zat)} ZEC`,
	count: r.count,
	firstHeight: r.first_height,
	lastHeight: r.last_height
});

/** Top-N most popular amounts for a side (count desc). */
export function popularAmounts(db, { side, limit = DEFAULT_POPULAR_LIMIT, minCount = DEFAULT_MIN_COUNT } = {}) {
	if (!SHIELD_SIDES.includes(side)) throw new TypeError(`popularAmounts: bad side '${side}'`);
	return db.prepare(
		'SELECT * FROM shield_amounts WHERE side = ? AND count >= ? ORDER BY count DESC, amount_zat ASC LIMIT ?'
	).all(side, minCount, Math.max(1, limit)).map(rowToEntry);
}

/** Amounts nearest a target (by absolute zatoshi distance), among those with
 *  enough observations to count as a crowd. */
export function nearbyAmounts(db, { side, nearZat, limit = DEFAULT_NEARBY_LIMIT, minCount = DEFAULT_MIN_COUNT } = {}) {
	if (!SHIELD_SIDES.includes(side)) throw new TypeError(`nearbyAmounts: bad side '${side}'`);
	const near = Math.round(Number(nearZat) || 0);
	return db.prepare(
		'SELECT * FROM shield_amounts WHERE side = ? AND count >= ? ORDER BY ABS(amount_zat - ?) ASC, count DESC LIMIT ?'
	).all(side, minCount, near, Math.max(1, limit)).map(rowToEntry);
}

/** How many times this EXACT amount was observed on this side (the
 *  "N others used this" number). Not gated by minCount — an exact 1 still
 *  means one other party did precisely this. */
export function exactCount(db, { side, amountZat }) {
	if (!SHIELD_SIDES.includes(side)) throw new TypeError(`exactCount: bad side '${side}'`);
	const row = db.prepare('SELECT count FROM shield_amounts WHERE side = ? AND amount_zat = ?')
		.get(side, Math.round(Number(amountZat) || 0));
	return row ? row.count : 0;
}

export function statsSnapshot(db) {
	const cur = getCursor(db);
	const per = db.prepare('SELECT side, COUNT(*) AS distinct_amounts, COALESCE(SUM(count),0) AS observations FROM shield_amounts GROUP BY side').all();
	const bySide = {};
	for (const side of SHIELD_SIDES) bySide[side] = { distinct_amounts: 0, observations: 0 };
	for (const r of per) bySide[r.side] = { distinct_amounts: r.distinct_amounts, observations: r.observations };
	return {
		indexed_from: cur.indexedFrom,
		indexed_through: cur.indexedThrough,
		shield: bySide.shield,
		deshield: bySide.deshield
	};
}

/**
 * The popularity feed the advisor consumes (and the REST/MCP response): nearby
 * amounts when a target is given, otherwise the global top-N, shaped as
 * { zec, zats, count }. Falls back to the global top-N if the target has too
 * few neighbours so a caller always gets a usable blend-in set when data exists.
 */
export function buildPopularFeed(db, { side, nearZat = null, limit = DEFAULT_POPULAR_LIMIT, minCount = DEFAULT_MIN_COUNT } = {}) {
	let rows = nearZat != null
		? nearbyAmounts(db, { side, nearZat, limit, minCount })
		: popularAmounts(db, { side, limit, minCount });
	if (nearZat != null && rows.length < Math.min(4, limit)) {
		const seen = new Set(rows.map((r) => r.zats));
		for (const r of popularAmounts(db, { side, limit, minCount })) {
			if (!seen.has(r.zats)) { rows.push(r); seen.add(r.zats); }
			if (rows.length >= limit) break;
		}
	}
	return rows.map((r) => ({ zec: r.zec, zats: r.zats, count: r.count, label: r.label }));
}

/** Delete rare one-off amounts below `minKeepCount` last seen before
 *  `beforeHeight` — keeps the table dominated by genuine crowds. Returns the
 *  number of rows removed. */
export function pruneRareAmounts(db, { minKeepCount = DEFAULT_MIN_COUNT, beforeHeight = Infinity } = {}) {
	const before = Number.isFinite(beforeHeight) ? Math.round(beforeHeight) : Number.MAX_SAFE_INTEGER;
	const info = db.prepare('DELETE FROM shield_amounts WHERE count < ? AND last_height < ?').run(minKeepCount, before);
	return info.changes;
}

// ── scanner ──────────────────────────────────────────────────────

/** Resolve the chain tip height via getblockchaininfo. */
export async function fetchTipHeight(rpcUrl, { zecRpc = defaultZecRpc, deps = {} } = {}) {
	const info = await zecRpc(rpcUrl, 'getblockchaininfo', [], deps);
	return Number(info?.blocks ?? 0);
}

/**
 * Scan a slice of the chain into the index. Incremental: resumes from the
 * stored cursor, stops after `maxBlocks` (so a timer makes steady progress
 * without one giant job). Idempotent re-scans double-count, so the scanner only
 * ever advances PAST the cursor — never re-walks indexed_through.
 *
 * @param {object} o
 * @param {string} o.rpcUrl                zebra JSON-RPC URL
 * @param {object} o.db                    open shield-index DB
 * @param {number} [o.fromHeight=0]        earliest height to ever index
 * @param {number} [o.toHeight]            stop height (default: chain tip)
 * @param {number} [o.maxBlocks=2000]      cap per invocation
 * @param {number} [o.minBoundaryZat]      drop crossings smaller than this
 * @param {Function} [o.zecRpc]            injected RPC (tests)
 * @param {object} [o.deps]                { fetchImpl, timeoutMs } for zecRpc
 * @param {Function} [o.onProgress]        ({height, scanned}) callback
 * @returns {Promise<object>} progress summary
 */
export async function scanShieldAmounts({
	rpcUrl,
	db,
	fromHeight = 0,
	toHeight = null,
	maxBlocks = 2000,
	minBoundaryZat = MIN_BOUNDARY_ZAT_DEFAULT,
	zecRpc = defaultZecRpc,
	deps = {},
	onProgress = null
} = {}) {
	if (!rpcUrl) throw new TypeError('scanShieldAmounts: rpcUrl is required');
	if (!db) throw new TypeError('scanShieldAmounts: db is required');

	const tip = toHeight != null ? Number(toHeight) : await fetchTipHeight(rpcUrl, { zecRpc, deps });
	const cur = getCursor(db);
	const start = cur.indexedThrough != null ? Math.max(cur.indexedThrough + 1, fromHeight) : fromHeight;
	const end = Math.min(tip, start + Math.max(1, maxBlocks) - 1);

	const summary = {
		scanned_from: start,
		scanned_through: cur.indexedThrough,
		blocks: 0,
		tip_height: tip,
		shield_obs: 0,
		deshield_obs: 0,
		caught_up: start > tip
	};
	if (start > end) return summary;

	const recordTx = db.transaction((classified, height) => {
		bumpAmount(db, { side: classified.side, amountZat: classified.amountZat, height });
	});

	for (let height = start; height <= end; height += 1) {
		const block = await zecRpc(rpcUrl, 'getblock', [String(height), 2], deps);
		const txs = Array.isArray(block?.tx) ? block.tx : [];
		for (const tx of txs) {
			const c = classifyBoundaryTx(tx, { minBoundaryZat });
			if (!c) continue;
			recordTx(c, height);
			if (c.side === 'shield') summary.shield_obs += 1; else summary.deshield_obs += 1;
		}
		summary.blocks += 1;
		summary.scanned_through = height;
		setCursor(db, { from: start, through: height });
		if (onProgress) onProgress({ height, scanned: summary.blocks, tip });
	}
	summary.caught_up = summary.scanned_through >= tip;
	return summary;
}

export default {
	SHIELD_SIDES,
	DEFAULT_MIN_COUNT,
	DEFAULT_POPULAR_LIMIT,
	DEFAULT_NEARBY_LIMIT,
	openShieldIndexDb,
	openSharedShieldIndexDb,
	setMeta,
	getMeta,
	getCursor,
	setCursor,
	bumpAmount,
	popularAmounts,
	nearbyAmounts,
	exactCount,
	statsSnapshot,
	buildPopularFeed,
	pruneRareAmounts,
	fetchTipHeight,
	scanShieldAmounts
};
