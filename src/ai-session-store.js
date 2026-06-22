// Prepaid AI session store — the credit meter behind the hosted-AI proxy.
//
// One row per purchased credit bundle. A bundle is bought with a single x402
// USDC payment (see ai-credits.js); in return the buyer gets an opaque session
// token they present as `Authorization: Bearer <token>` to the OpenAI-
// compatible proxy. Each completion debits the measured token cost from the
// row's credit balance until it runs dry, then the buyer tops up (buys another
// bundle).
//
// Security model mirrors viewkey-watch's watch tokens:
//   * the token is 32 random bytes (base64url) shown to the buyer ONCE,
//   * only its SHA-256 hash is persisted, looked up by an indexed equality on
//     the hash of the *presented* token (no plaintext token ever stored), and
//   * the proxy compares nothing in plaintext — a stolen DB yields only hashes.
//
// All money is atomic USDC (6 decimals) stored as plain INTEGER: a $20 ceiling
// (20_000_000) is nowhere near 2^53, so we avoid bigint ceremony.

import Database from 'better-sqlite3';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const AI_DDL = `
CREATE TABLE IF NOT EXISTS ai_sessions (
	id              TEXT PRIMARY KEY,
	token_hash      TEXT NOT NULL UNIQUE,
	credit_atomic   INTEGER NOT NULL DEFAULT 0,
	spent_atomic    INTEGER NOT NULL DEFAULT 0,
	topups_atomic   INTEGER NOT NULL DEFAULT 0,
	model           TEXT,
	calls           INTEGER NOT NULL DEFAULT 0,
	created_ms      INTEGER NOT NULL,
	expires_ms      INTEGER NOT NULL,
	last_used_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS ai_sessions_expires ON ai_sessions (expires_ms);
`;

function sha256Hex(input) {
	return createHash('sha256').update(input).digest('hex');
}

/** Hash a presented token to the form stored in the DB. */
export function hashToken(token) {
	return sha256Hex(Buffer.from(String(token), 'utf8'));
}

/**
 * Open (or create) the AI-session SQLite DB. `:memory:` is honoured for tests.
 * Same pragmas as the watch store so behaviour under concurrency matches.
 */
export function openAiDb(path) {
	if (typeof path !== 'string' || path.length === 0) {
		throw new TypeError('openAiDb: path must be a non-empty string');
	}
	if (path !== ':memory:') {
		try { mkdirSync(dirname(path), { recursive: true }); }
		catch { /* better-sqlite3 will surface a clearer error if the dir is unusable */ }
	}
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.exec(AI_DDL);
	return db;
}

/** Shape returned to callers — never includes the token hash. */
function publicRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		creditAtomic: row.credit_atomic,
		spentAtomic: row.spent_atomic,
		topupsAtomic: row.topups_atomic,
		remainingAtomic: Math.max(0, row.credit_atomic - row.spent_atomic),
		model: row.model ?? null,
		calls: row.calls,
		createdMs: row.created_ms,
		expiresMs: row.expires_ms,
		lastUsedMs: row.last_used_ms ?? null
	};
}

/**
 * Create a new prepaid session. Returns `{ token, session }` — `token` is the
 * plaintext shown to the buyer once; only its hash is stored.
 */
export function createAiSession(db, { creditAtomic, model = null, ttlMs, nowMs = Date.now() }) {
	if (!Number.isInteger(creditAtomic) || creditAtomic <= 0) {
		throw new TypeError('createAiSession: creditAtomic must be a positive integer (atomic USDC)');
	}
	if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
		throw new TypeError('createAiSession: ttlMs must be a positive integer');
	}
	const id = randomUUID();
	const token = randomBytes(32).toString('base64url');
	const tokenHash = hashToken(token);
	const expiresMs = nowMs + ttlMs;
	db.prepare(`
		INSERT INTO ai_sessions (id, token_hash, credit_atomic, topups_atomic, model, created_ms, expires_ms)
		VALUES (@id, @tokenHash, @creditAtomic, @creditAtomic, @model, @nowMs, @expiresMs)
	`).run({ id, tokenHash, creditAtomic, model, nowMs, expiresMs });
	return { token, session: publicRow(getRowById(db, id)) };
}

function getRowById(db, id) {
	return db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id);
}

/**
 * Look up a live session by its presented token. Returns the public row, or
 * `null` if unknown / expired. Lookup is an indexed equality on the hash of the
 * presented token, so timing leaks nothing about other tokens.
 */
export function getAiSessionByToken(db, token, { nowMs = Date.now() } = {}) {
	if (typeof token !== 'string' || token.length === 0) return null;
	const row = db.prepare('SELECT * FROM ai_sessions WHERE token_hash = ?').get(hashToken(token));
	if (!row) return null;
	if (row.expires_ms <= nowMs) return null;
	return publicRow(row);
}

/**
 * Debit `costAtomic` from a session. Always succeeds in recording the spend
 * (the upstream call already happened); the balance clamps at zero so a final
 * over-spend can't make the meter negative. Returns the updated public row.
 */
export function debitAiSession(db, id, costAtomic, { nowMs = Date.now() } = {}) {
	const cost = Math.max(0, Math.round(Number(costAtomic) || 0));
	const tx = db.transaction(() => {
		db.prepare(`
			UPDATE ai_sessions
			   SET spent_atomic = MIN(credit_atomic, spent_atomic + @cost),
			       calls = calls + 1,
			       last_used_ms = @nowMs
			 WHERE id = @id
		`).run({ id, cost, nowMs });
		return getRowById(db, id);
	});
	return publicRow(tx());
}

/** Add credit to an existing session (a top-up buys more for the same token). */
export function creditAiSession(db, id, addAtomic, { extendTtlMs = 0, nowMs = Date.now() } = {}) {
	const add = Math.max(0, Math.round(Number(addAtomic) || 0));
	const row = getRowById(db, id);
	if (!row) return null;
	const expiresMs = extendTtlMs > 0 ? Math.max(row.expires_ms, nowMs + extendTtlMs) : row.expires_ms;
	db.prepare(`
		UPDATE ai_sessions
		   SET credit_atomic = credit_atomic + @add,
		       topups_atomic = topups_atomic + @add,
		       expires_ms = @expiresMs
		 WHERE id = @id
	`).run({ id, add, expiresMs });
	return publicRow(getRowById(db, id));
}

/** Delete expired sessions. Returns the number removed. */
export function purgeExpiredAiSessions(db, { nowMs = Date.now() } = {}) {
	return db.prepare('DELETE FROM ai_sessions WHERE expires_ms <= ?').run(nowMs).changes;
}

/** Aggregate counters for /v1/ai health — no per-session PII. */
export function aiStatsSnapshot(db, { nowMs = Date.now() } = {}) {
	const row = db.prepare(`
		SELECT COUNT(*) AS total,
		       SUM(CASE WHEN expires_ms > @nowMs AND credit_atomic > spent_atomic THEN 1 ELSE 0 END) AS active,
		       COALESCE(SUM(spent_atomic), 0) AS spent_atomic,
		       COALESCE(SUM(credit_atomic), 0) AS credit_atomic,
		       COALESCE(SUM(calls), 0) AS calls
		  FROM ai_sessions
	`).get({ nowMs });
	return {
		total: row.total ?? 0,
		active: row.active ?? 0,
		spent_atomic: row.spent_atomic ?? 0,
		credit_atomic: row.credit_atomic ?? 0,
		calls: row.calls ?? 0
	};
}
