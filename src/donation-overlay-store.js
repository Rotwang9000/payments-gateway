// Donation overlay — SQLite persistence.
//
// A "donation overlay" is a streamer-facing product built on the same
// UFVK machinery as Private Watch: the streamer hands us their Zcash
// UFVK (read-only — it can NEVER spend), we scan their wallet through
// NFPT on the receive-poller cadence, and every new incoming shielded
// note becomes a "donation event" (amount + decrypted memo) that an
// OBS browser-source page polls and animates on stream.
//
// No accounts, no email, no viewer sign-up. The overlay id is an
// unguessable capability token (it IS the OBS URL); a separate owner
// token manages/cancels/tops-up. We store:
//   - the UFVK encrypted at rest (AES-256-GCM under the gateway
//     master key — same posture as private watches)
//   - the receive address (public by definition — donors pay it)
//   - an optional display label; nothing else about the streamer
// Events are pruned after EVENT_TTL_MS so old donor memos don't
// accumulate forever. Data-minimal by design.
//
// Both tables live in the SAME SQLite file as `private_watches` so the
// poller shares one handle and the crypto top-up quotes (which fund
// the overlay's credit meter) settle in one place. Every function
// takes the `db` handle first; tests use `:memory:`.

import { randomUUID, randomBytes } from 'node:crypto';

import { hashToken, safeEqualHex } from './notice-board.js';

export const OVERLAY_CONSTANTS = Object.freeze({
	// Prepaid meter (atomic USDC; 1_000_000 = $1.00).
	// Ziving scanning — raised from $0.02 so the product funds itself.
	DAY_RATE_ATOMIC: 100_000,         // $0.10 / day
	// Grace credit at creation so the page is live until the funding
	// ZEC payment confirms (~10 min + TTL).
	GRACE_CREDIT_ATOMIC: 150_000,     // $0.15 ≈ 1.5 days
	// Homepage featured placement (sold separately, ZEC memo quote).
	FEATURE_DAY_RATE_ATOMIC: 5_000_000, // $5.00 / day on the homepage
	FEATURE_DAYS_MIN: 1,
	FEATURE_DAYS_MAX: 30,
	// Hard cap on overlay lifetime per funding cycle (same as watches).
	MAX_LIFETIME_MS: 365 * 86_400_000,
	// Donation events older than this are pruned (donor memos should
	// not sit in our DB forever).
	EVENT_TTL_MS: 30 * 86_400_000,
	// Cancelled/expired overlays are hard-deleted after this long.
	ROW_RETENTION_MS: 7 * 86_400_000,
	// Bounds for the events feed.
	EVENTS_PAGE_MAX: 50,
	// Displayed memo cap (Zcash memos are ≤512 bytes anyway; this is
	// a defensive bound for the overlay page).
	MEMO_MAX_LEN: 512,
	LABEL_MAX_LEN: 60,
	// Ziving campaign pages (JustGiving-style public slugs).
	SLUG_MIN_LEN: 3,
	SLUG_MAX_LEN: 48,
	STORY_MAX_LEN: 4000,
	FEATURED_LIST_MAX: 24
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS donation_overlays (
	id                    TEXT PRIMARY KEY,
	owner_token_hash      TEXT NOT NULL,
	chain                 TEXT NOT NULL CHECK(chain IN ('zcash')),
	address               TEXT NOT NULL,
	ufvk_ct               TEXT NOT NULL,
	birthday_height       INTEGER,
	label                 TEXT,
	min_zatoshi           TEXT,
	created_at_ms         INTEGER NOT NULL,
	expires_at_ms         INTEGER NOT NULL,

	-- prepaid credit meter (atomic USDC), same column names as
	-- private_watches so viewkey-watch's applyDayCharge() maths apply.
	credit_atomic         INTEGER DEFAULT 0,
	credit_topups_atomic  INTEGER DEFAULT 0,
	credit_billed_atomic  INTEGER DEFAULT 0,
	credit_last_billed_ms INTEGER,

	-- scan state
	last_scanned_height   INTEGER,
	last_polled_at_ms     INTEGER,
	scan_errors           INTEGER DEFAULT 0,
	cancelled             INTEGER DEFAULT 0,

	-- optional Ziving campaign page fields (public by design)
	slug                  TEXT UNIQUE,
	story                 TEXT,
	goal_zatoshi          TEXT,
	featured_until_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_overlay_active
	ON donation_overlays(cancelled, credit_atomic, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_overlay_slug
	ON donation_overlays(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_overlay_featured
	ON donation_overlays(featured_until_ms) WHERE featured_until_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS ziving_feature_quotes (
	quote_id       TEXT PRIMARY KEY,
	overlay_id     TEXT NOT NULL,
	days           INTEGER NOT NULL,
	usd_cents      INTEGER NOT NULL,
	settled        INTEGER DEFAULT 0,
	created_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_quote_overlay
	ON ziving_feature_quotes(overlay_id, settled, usd_cents);

CREATE TABLE IF NOT EXISTS donation_events (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	overlay_id     TEXT NOT NULL,
	tx_hash        TEXT,
	amount_atomic  TEXT NOT NULL,
	memo           TEXT,
	block_height   INTEGER,
	confirmations  INTEGER DEFAULT 0,
	status         TEXT NOT NULL CHECK(status IN ('seen','confirmed')),
	suppressed     INTEGER DEFAULT 0,
	first_seen_ms  INTEGER NOT NULL,
	UNIQUE(overlay_id, tx_hash, amount_atomic, block_height)
);
CREATE INDEX IF NOT EXISTS idx_event_feed
	ON donation_events(overlay_id, suppressed, id);
`;

/** Normalise a Ziving campaign slug (lowercase URL segment). */
export function normaliseCampaignSlug(value) {
	const raw = String(value ?? '').toLowerCase().trim();
	const s = raw
		.replace(/[^a-z0-9-]+/gu, '-')
		.replace(/-+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, OVERLAY_CONSTANTS.SLUG_MAX_LEN);
	if (s.length < OVERLAY_CONSTANTS.SLUG_MIN_LEN) {
		throw new TypeError(`slug must be ${OVERLAY_CONSTANTS.SLUG_MIN_LEN}–${OVERLAY_CONSTANTS.SLUG_MAX_LEN} characters (a-z, 0-9, hyphen)`);
	}
	return s;
}

/** Create the overlay tables + indexes. Idempotent; call on every open. */
export function ensureDonationOverlaySchema(db) {
	db.exec(SCHEMA);
	migrateDonationOverlaySchema(db);
}

/** Add campaign columns to existing deployments (no-op when present). */
function migrateDonationOverlaySchema(db) {
	const cols = new Set(db.prepare('PRAGMA table_info(donation_overlays)').all().map((r) => r.name));
	if (!cols.has('slug')) db.exec('ALTER TABLE donation_overlays ADD COLUMN slug TEXT');
	if (!cols.has('story')) db.exec('ALTER TABLE donation_overlays ADD COLUMN story TEXT');
	if (!cols.has('goal_zatoshi')) db.exec('ALTER TABLE donation_overlays ADD COLUMN goal_zatoshi TEXT');
	if (!cols.has('featured_until_ms')) db.exec('ALTER TABLE donation_overlays ADD COLUMN featured_until_ms INTEGER');
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_overlay_slug_unique ON donation_overlays(slug) WHERE slug IS NOT NULL');
	db.exec('CREATE INDEX IF NOT EXISTS idx_overlay_slug ON donation_overlays(slug) WHERE slug IS NOT NULL');
	db.exec('CREATE INDEX IF NOT EXISTS idx_overlay_featured ON donation_overlays(featured_until_ms) WHERE featured_until_ms IS NOT NULL');
	db.exec(`
		CREATE TABLE IF NOT EXISTS ziving_feature_quotes (
			quote_id       TEXT PRIMARY KEY,
			overlay_id     TEXT NOT NULL,
			days           INTEGER NOT NULL,
			usd_cents      INTEGER NOT NULL,
			settled        INTEGER DEFAULT 0,
			created_at_ms  INTEGER NOT NULL
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_feature_quote_overlay ON ziving_feature_quotes(overlay_id, settled, usd_cents)');
}

/** Unguessable public overlay id — this token IS the OBS URL capability. */
export function genOverlayId() {
	return `ov_${randomBytes(16).toString('base64url')}`;
}

/** Owner (management) bearer token — returned exactly once at creation. */
export function genOverlayOwnerToken() {
	return randomBytes(24).toString('base64url');
}

/**
 * Create an overlay. `ufvkCiphertext` is the already-encrypted UFVK.
 * Returns { id, ownerToken, expiresAt } — only the token HASH is stored.
 */
export function createOverlay(db, {
	address,
	ufvkCiphertext,
	birthdayHeight = null,
	label = null,
	minZatoshi = null,
	slug = null,
	story = null,
	goalZatoshi = null,
	creditAtomic = OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC,
	dayRateAtomic = OVERLAY_CONSTANTS.DAY_RATE_ATOMIC,
	nowMs = Date.now()
}) {
	if (typeof address !== 'string' || address.length === 0) {
		throw new TypeError('createOverlay: address required');
	}
	if (typeof ufvkCiphertext !== 'string' || ufvkCiphertext.length === 0) {
		throw new TypeError('createOverlay: ufvkCiphertext required');
	}
	if (!Number.isInteger(creditAtomic) || creditAtomic <= 0) {
		throw new TypeError('createOverlay: creditAtomic must be a positive integer');
	}
	const id = genOverlayId();
	const ownerToken = genOverlayOwnerToken();
	const expiresAt = Math.min(
		nowMs + Math.floor((creditAtomic * 86_400_000) / dayRateAtomic),
		nowMs + OVERLAY_CONSTANTS.MAX_LIFETIME_MS
	);
	db.prepare(`
		INSERT INTO donation_overlays
			(id, owner_token_hash, chain, address, ufvk_ct, birthday_height, label, min_zatoshi,
			 slug, story, goal_zatoshi,
			 created_at_ms, expires_at_ms, credit_atomic, credit_topups_atomic, credit_last_billed_ms)
		VALUES (@id, @hash, 'zcash', @address, @ufvkCt, @birthday, @label, @minZat,
		        @slug, @story, @goalZat,
		        @now, @expires, @credit, @credit, @now)
	`).run({
		id,
		hash: hashToken(ownerToken),
		address,
		ufvkCt: ufvkCiphertext,
		birthday: birthdayHeight ?? null,
		label: label ?? null,
		minZat: minZatoshi != null ? String(minZatoshi) : null,
		slug: slug ?? null,
		story: story ?? null,
		goalZat: goalZatoshi != null ? String(goalZatoshi) : null,
		now: nowMs,
		expires: expiresAt,
		credit: creditAtomic
	});
	return { id, ownerToken, expiresAt, createdAt: nowMs };
}

/** Fetch an overlay row by public id (no auth). Returns row or null. */
export function getOverlay(db, id) {
	return db.prepare('SELECT * FROM donation_overlays WHERE id = ?').get(id) ?? null;
}

/** Fetch an overlay by public campaign slug (no auth). Returns row or null. */
export function getOverlayBySlug(db, slug) {
	if (typeof slug !== 'string' || slug.length === 0) return null;
	return db.prepare('SELECT * FROM donation_overlays WHERE slug = ?').get(slug) ?? null;
}

/**
 * Sum confirmed, visible donations for a campaign page progress bar.
 * Returns { totalZatoshi: string, donationCount: number }.
 */
export function sumConfirmedDonations(db, overlayId) {
	const rows = db.prepare(`
		SELECT amount_atomic FROM donation_events
		WHERE overlay_id = ? AND suppressed = 0 AND status = 'confirmed'
	`).all(overlayId);
	let total = 0n;
	for (const row of rows) {
		try { total += BigInt(row.amount_atomic); } catch { /* skip malformed */ }
	}
	return { totalZatoshi: total.toString(), donationCount: rows.length };
}

/** USD cents for N days of homepage featuring. */
export function featureUsdCentsForDays(days) {
	const d = Math.floor(Number(days));
	if (!Number.isInteger(d) || d < OVERLAY_CONSTANTS.FEATURE_DAYS_MIN || d > OVERLAY_CONSTANTS.FEATURE_DAYS_MAX) {
		throw new TypeError(`feature days must be ${OVERLAY_CONSTANTS.FEATURE_DAYS_MIN}–${OVERLAY_CONSTANTS.FEATURE_DAYS_MAX}`);
	}
	return Math.round((d * OVERLAY_CONSTANTS.FEATURE_DAY_RATE_ATOMIC) / 10_000);
}

/** Record a pending homepage-feature purchase (settled by the receive-poller). */
export function createFeatureQuote(db, { quoteId, overlayId, days, usdCents, nowMs = Date.now() }) {
	if (typeof quoteId !== 'string' || !quoteId) throw new TypeError('createFeatureQuote: quoteId required');
	if (typeof overlayId !== 'string' || !overlayId) throw new TypeError('createFeatureQuote: overlayId required');
	const d = Math.floor(Number(days));
	if (!Number.isInteger(d) || d < OVERLAY_CONSTANTS.FEATURE_DAYS_MIN || d > OVERLAY_CONSTANTS.FEATURE_DAYS_MAX) {
		throw new TypeError(`feature days must be ${OVERLAY_CONSTANTS.FEATURE_DAYS_MIN}–${OVERLAY_CONSTANTS.FEATURE_DAYS_MAX}`);
	}
	if (!Number.isInteger(usdCents) || usdCents <= 0) throw new TypeError('createFeatureQuote: usdCents required');
	db.prepare(`
		INSERT INTO ziving_feature_quotes (quote_id, overlay_id, days, usd_cents, settled, created_at_ms)
		VALUES (?, ?, ?, ?, 0, ?)
	`).run(quoteId, overlayId, d, usdCents, nowMs);
	return { quoteId, overlayId, days: d, usdCents };
}

/**
 * Settle a homepage-feature purchase: extend featured_until_ms from now
 * (or from the current featured_until if still live).
 */
export function applyFeaturePurchase(db, overlayId, { days, usdCents, nowMs = Date.now() }) {
	const pending = db.prepare(`
		SELECT * FROM ziving_feature_quotes
		WHERE overlay_id = ? AND usd_cents = ? AND settled = 0
		ORDER BY created_at_ms DESC
		LIMIT 1
	`).get(overlayId, usdCents);
	if (!pending) return { ok: false, reason: 'no_pending_feature' };
	const row = getOverlay(db, overlayId);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.cancelled === 1) return { ok: false, reason: 'cancelled' };
	const base = Math.max(nowMs, Number(row.featured_until_ms ?? 0) || 0);
	const until = base + (pending.days * 86_400_000);
	db.prepare('UPDATE donation_overlays SET featured_until_ms = ? WHERE id = ?').run(until, overlayId);
	db.prepare('UPDATE ziving_feature_quotes SET settled = 1 WHERE quote_id = ?').run(pending.quote_id);
	return { ok: true, featuredUntilMs: until, days: pending.days, row: getOverlay(db, overlayId) };
}

/** Live homepage-featured campaigns (slug set, not cancelled, still featured). */
export function listFeaturedCampaigns(db, { nowMs = Date.now(), limit = OVERLAY_CONSTANTS.FEATURED_LIST_MAX } = {}) {
	const cap = Math.min(Math.max(1, Number(limit) || 1), OVERLAY_CONSTANTS.FEATURED_LIST_MAX);
	return db.prepare(`
		SELECT * FROM donation_overlays
		WHERE slug IS NOT NULL AND cancelled = 0
		  AND featured_until_ms IS NOT NULL AND featured_until_ms > ?
		ORDER BY featured_until_ms DESC
		LIMIT ?
	`).all(nowMs, cap);
}

/**
 * Fetch an overlay gated by the owner token (constant-time compare).
 * Returns the row, { error: 'not_found' }, or { error: 'forbidden' }.
 */
export function getOverlayAuthorised(db, id, ownerToken) {
	const row = getOverlay(db, id);
	if (!row) return { error: 'not_found' };
	if (typeof ownerToken !== 'string' || !safeEqualHex(hashToken(ownerToken), row.owner_token_hash)) {
		return { error: 'forbidden' };
	}
	return row;
}

/** Cancel an overlay (owner token). Returns { ok } | { ok:false, reason }. */
export function cancelOverlay(db, id, ownerToken) {
	const got = getOverlayAuthorised(db, id, ownerToken);
	if (got.error) return { ok: false, reason: got.error };
	db.prepare('UPDATE donation_overlays SET cancelled = 1 WHERE id = ?').run(id);
	return { ok: true };
}

/** Overlays the poller should scan: funded, not cancelled, not expired. */
export function listActiveOverlays(db, { nowMs = Date.now(), limit = 100 } = {}) {
	return db.prepare(`
		SELECT * FROM donation_overlays
		WHERE cancelled = 0 AND credit_atomic > 0 AND expires_at_ms > ?
		ORDER BY COALESCE(last_polled_at_ms, 0) ASC
		LIMIT ?
	`).all(nowMs, limit);
}

/** Patch poller/meter state. Only whitelisted columns are writable. */
export function updateOverlayState(db, id, patch) {
	const ALLOWED = new Set([
		'credit_atomic',
		'credit_billed_atomic',
		'credit_last_billed_ms',
		'expires_at_ms',
		'last_scanned_height',
		'last_polled_at_ms',
		'scan_errors'
	]);
	const cols = [];
	const vals = [];
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (!ALLOWED.has(k)) continue;
		cols.push(`${k} = ?`);
		vals.push(v);
	}
	if (cols.length === 0) return 0;
	vals.push(id);
	return db.prepare(`UPDATE donation_overlays SET ${cols.join(', ')} WHERE id = ?`).run(...vals).changes;
}

/**
 * Token-less credit application for the trusted receive-poller (the
 * ZEC funding payment confirmed on-chain). Mirrors viewkey-watch's
 * topupWatchById: add credit, recompute the credit-derived expiry.
 */
export function topupOverlayById(db, id, {
	creditAtomic,
	dayRateAtomic = OVERLAY_CONSTANTS.DAY_RATE_ATOMIC,
	maxLifetimeMs = OVERLAY_CONSTANTS.MAX_LIFETIME_MS,
	nowMs = Date.now()
}) {
	if (!Number.isInteger(creditAtomic) || creditAtomic <= 0) {
		throw new TypeError('topupOverlayById: creditAtomic must be a positive integer');
	}
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.cancelled === 1) return { ok: false, reason: 'cancelled' };
	const newCredit = Number(row.credit_atomic ?? 0) + creditAtomic;
	const newTopups = Number(row.credit_topups_atomic ?? 0) + creditAtomic;
	const expires = Math.min(
		nowMs + Math.floor((newCredit * 86_400_000) / dayRateAtomic),
		nowMs + maxLifetimeMs
	);
	db.prepare(`
		UPDATE donation_overlays
		SET credit_atomic = ?, credit_topups_atomic = ?, expires_at_ms = ?
		WHERE id = ?
	`).run(newCredit, newTopups, expires, id);
	return { ok: true, row: getOverlay(db, id) };
}

// ── Donation events ───────────────────────────────────────────────

/**
 * Record a donation sighting. Idempotent on (overlay, tx, amount,
 * height) — a re-scan of the same note is a no-op. Two identical-value
 * notes in ONE transaction at the same height collapse into one event
 * (known limitation; vanishingly rare for real donations).
 *
 * Returns { inserted: bool, row }.
 */
export function recordDonationEvent(db, {
	overlayId,
	txHash = null,
	amountAtomic,
	memo = null,
	blockHeight = null,
	confirmations = 0,
	confirmed = false,
	suppressed = false,
	nowMs = Date.now()
}) {
	if (typeof overlayId !== 'string' || overlayId.length === 0) {
		throw new TypeError('recordDonationEvent: overlayId required');
	}
	if (amountAtomic == null) throw new TypeError('recordDonationEvent: amountAtomic required');
	const info = db.prepare(`
		INSERT OR IGNORE INTO donation_events
			(overlay_id, tx_hash, amount_atomic, memo, block_height, confirmations, status, suppressed, first_seen_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		overlayId,
		txHash,
		String(amountAtomic),
		memo != null ? String(memo).slice(0, OVERLAY_CONSTANTS.MEMO_MAX_LEN) : null,
		blockHeight ?? null,
		confirmations,
		confirmed ? 'confirmed' : 'seen',
		suppressed ? 1 : 0,
		nowMs
	);
	const row = db.prepare(`
		SELECT * FROM donation_events
		WHERE overlay_id = ? AND tx_hash IS ? AND amount_atomic = ? AND block_height IS ?
	`).get(overlayId, txHash, String(amountAtomic), blockHeight ?? null);
	return { inserted: info.changes === 1, row };
}

/** Bump confirmations on a still-'seen' event; flip to 'confirmed' at the threshold. */
export function updateEventConfirmations(db, eventId, confirmations, required) {
	const status = confirmations >= required ? 'confirmed' : 'seen';
	return db.prepare(`
		UPDATE donation_events
		SET confirmations = ?, status = ?
		WHERE id = ? AND status = 'seen'
	`).run(confirmations, status, eventId).changes;
}

/**
 * Public event feed for the overlay page. Cursor-paginated by row id
 * (strictly ascending), suppressed baseline rows excluded.
 */
export function listEventsSince(db, overlayId, { sinceId = 0, limit = OVERLAY_CONSTANTS.EVENTS_PAGE_MAX } = {}) {
	const cap = Math.min(Math.max(1, Number(limit) || 1), OVERLAY_CONSTANTS.EVENTS_PAGE_MAX);
	return db.prepare(`
		SELECT id, tx_hash, amount_atomic, memo, block_height, confirmations, status, first_seen_ms
		FROM donation_events
		WHERE overlay_id = ? AND suppressed = 0 AND id > ?
		ORDER BY id ASC
		LIMIT ?
	`).all(overlayId, Number(sinceId) || 0, cap);
}

/** 'seen' events for an overlay that still need confirmation tracking. */
export function listUnconfirmedEvents(db, overlayId) {
	return db.prepare(`
		SELECT * FROM donation_events
		WHERE overlay_id = ? AND status = 'seen'
	`).all(overlayId);
}

/**
 * Housekeeping: drop old events, and hard-delete overlays (plus their
 * events) that have been cancelled/expired for ROW_RETENTION_MS.
 */
export function pruneOverlayData(db, { nowMs = Date.now() } = {}) {
	const prunedEvents = db.prepare('DELETE FROM donation_events WHERE first_seen_ms < ?')
		.run(nowMs - OVERLAY_CONSTANTS.EVENT_TTL_MS).changes;
	const dead = db.prepare(`
		SELECT id FROM donation_overlays
		WHERE (cancelled = 1 OR expires_at_ms < ?) AND expires_at_ms < ?
	`).all(nowMs, nowMs - OVERLAY_CONSTANTS.ROW_RETENTION_MS).map((r) => r.id);
	let prunedOverlays = 0;
	const dropEvents = db.prepare('DELETE FROM donation_events WHERE overlay_id = ?');
	const dropOverlay = db.prepare('DELETE FROM donation_overlays WHERE id = ?');
	const tx = db.transaction(() => {
		for (const id of dead) {
			dropEvents.run(id);
			prunedOverlays += dropOverlay.run(id).changes;
		}
	});
	tx();
	return { pruned_events: prunedEvents, pruned_overlays: prunedOverlays };
}

/** Aggregate counters for the stats/health surface (no PII). */
export function overlayStatsSnapshot(db, { nowMs = Date.now() } = {}) {
	const o = db.prepare(`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN cancelled = 0 AND credit_atomic > 0 AND expires_at_ms > ? THEN 1 ELSE 0 END) AS active
		FROM donation_overlays
	`).get(nowMs) ?? {};
	const e = db.prepare(`
		SELECT COUNT(*) AS total,
			SUM(CASE WHEN suppressed = 0 THEN 1 ELSE 0 END) AS visible
		FROM donation_events
	`).get() ?? {};
	return {
		overlays_total: o.total ?? 0,
		overlays_active: o.active ?? 0,
		events_total: e.total ?? 0,
		events_visible: e.visible ?? 0
	};
}
