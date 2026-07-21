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

import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { hashToken, safeEqualHex } from './notice-board.js';

/** Constant-time string compare via SHA-256 digests (length-independent). */
export function safeEqualUtf8(a, b) {
	const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
	const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
	return timingSafeEqual(ha, hb);
}

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
	// Reads accept the historical minimum (3) so old links keep resolving;
	// new pages must clear SLUG_CREATE_MIN_LEN.
	SLUG_MIN_LEN: 3,
	SLUG_CREATE_MIN_LEN: 5,
	SLUG_MAX_LEN: 48,
	STORY_MAX_LEN: 4000,
	FEATURED_LIST_MAX: 24,
	// Lost-key recovery: the owner pays this much in ZEC (memo quote) to
	// open a claim window; the recovery code alone never rotates the token.
	RECOVERY_UNLOCK_USD_CENTS: 50,
	RECOVERY_UNLOCK_WINDOW_MS: 48 * 3_600_000,
	// Wallet-login sessions (UFVK match → temporary manage access).
	SESSION_TTL_MS: 24 * 3_600_000
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

	-- chain tip at page creation; notes at/below this height are the
	-- wallet's pre-existing balance (suppressed on first scan), notes
	-- above it are genuine donations. NULL on pre-migration rows.
	baseline_height       INTEGER,

	-- optional Ziving campaign page fields (public by design)
	slug                  TEXT UNIQUE,
	story                 TEXT,
	goal_zatoshi          TEXT,
	featured_until_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_overlay_active
	ON donation_overlays(cancelled, credit_atomic, expires_at_ms);
-- slug / featured indexes are created in migrateDonationOverlaySchema
-- after ALTER TABLE adds those columns on existing DBs.

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

/**
 * Slugs that must never become campaign pages: site routes, obvious
 * service impersonation, and generic words that would read as official.
 */
export const RESERVED_SLUGS = Object.freeze(new Set([
	'admin', 'about', 'account', 'accounts', 'api', 'assets', 'blog', 'contact',
	'create', 'docs', 'donate', 'events', 'faq', 'featured', 'gateway', 'help',
	'home', 'index', 'legal', 'login', 'manage', 'official', 'overlay', 'pages',
	'press', 'privacy', 'search', 'settings', 'signup', 'static', 'status',
	'support', 'terms', 'wallet', 'winbit32', 'zcash', 'ziving'
]));

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
	if (!cols.has('baseline_height')) db.exec('ALTER TABLE donation_overlays ADD COLUMN baseline_height INTEGER');
	if (!cols.has('recovery_code_hash')) db.exec('ALTER TABLE donation_overlays ADD COLUMN recovery_code_hash TEXT');
	if (!cols.has('ufvk_fingerprint')) db.exec('ALTER TABLE donation_overlays ADD COLUMN ufvk_fingerprint TEXT');
	if (!cols.has('recovery_unlock_ms')) db.exec('ALTER TABLE donation_overlays ADD COLUMN recovery_unlock_ms INTEGER');
	// Optional self-attested X (Twitter) link — the fundraiser proves they
	// control a public X account by posting x_link_code, then we verify via
	// X's public oEmbed lookup. Not vetting: it just makes the fundraiser
	// findable and gives them a reputation to stake if the campaign is bad.
	if (!cols.has('x_link_code')) db.exec('ALTER TABLE donation_overlays ADD COLUMN x_link_code TEXT');
	if (!cols.has('x_handle')) db.exec('ALTER TABLE donation_overlays ADD COLUMN x_handle TEXT');
	if (!cols.has('x_proof_url')) db.exec('ALTER TABLE donation_overlays ADD COLUMN x_proof_url TEXT');
	if (!cols.has('x_verified_at_ms')) db.exec('ALTER TABLE donation_overlays ADD COLUMN x_verified_at_ms INTEGER');
	db.exec('CREATE INDEX IF NOT EXISTS idx_overlay_ufvk_fp ON donation_overlays(ufvk_fingerprint) WHERE ufvk_fingerprint IS NOT NULL');
	db.exec(`
		CREATE TABLE IF NOT EXISTS overlay_sessions (
			token_hash     TEXT NOT NULL,
			overlay_id     TEXT NOT NULL,
			created_at_ms  INTEGER NOT NULL,
			expires_at_ms  INTEGER NOT NULL,
			PRIMARY KEY (token_hash, overlay_id)
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_session_expiry ON overlay_sessions(expires_at_ms)');
	db.exec(`
		CREATE TABLE IF NOT EXISTS ziving_recovery_quotes (
			quote_id       TEXT PRIMARY KEY,
			overlay_id     TEXT NOT NULL,
			usd_cents      INTEGER NOT NULL,
			settled        INTEGER DEFAULT 0,
			created_at_ms  INTEGER NOT NULL
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_quote_overlay ON ziving_recovery_quotes(overlay_id, settled, usd_cents)');
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_overlay_slug_unique ON donation_overlays(slug) WHERE slug IS NOT NULL');
	db.exec('CREATE INDEX IF NOT EXISTS idx_overlay_slug ON donation_overlays(slug) WHERE slug IS NOT NULL');
	db.exec('CREATE INDEX IF NOT EXISTS idx_overlay_featured ON donation_overlays(featured_until_ms) WHERE featured_until_ms IS NOT NULL');
	// One live campaign/overlay per wallet: the UFVK scanner returns every
	// note for that view key, so two non-cancelled rows would double-count
	// (and mis-attribute) the same gifts. Cancelled pages may reuse the key.
	try {
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_overlay_one_live_ufvk
				ON donation_overlays(ufvk_fingerprint)
				WHERE cancelled = 0 AND ufvk_fingerprint IS NOT NULL
		`);
	} catch {
		/* Existing duplicate live fingerprints block the index; app-level check still enforces. */
	}
	try {
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_overlay_one_live_address
				ON donation_overlays(address)
				WHERE cancelled = 0
		`);
	} catch {
		/* Same: duplicates may exist from before this rule. */
	}
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

/** Wallet-login session bearer token (short-lived, hash stored). */
export function genOverlaySessionToken() {
	return `zses_${randomBytes(24).toString('base64url')}`;
}

// Human-typable alphabet: lowercase Crockford-ish, no 0/1/i/l/o/u.
const RECOVERY_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

/** Lost-key recovery code, e.g. "zrk-h7f2-p9wm-3kdt" (~59 bits). */
export function genOverlayRecoveryCode() {
	const bytes = randomBytes(12);
	let out = 'zrk';
	for (let i = 0; i < 12; i += 1) {
		if (i % 4 === 0) out += '-';
		out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
	}
	return out;
}

/** Canonical form for recovery-code comparison (paste-tolerant). */
export function normaliseRecoveryCode(code) {
	return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/** Public nonce a fundraiser posts on X to prove they control the account. Not a secret. */
export function genOverlayXLinkCode() {
	const bytes = randomBytes(8);
	let out = 'ziving-';
	for (let i = 0; i < bytes.length; i += 1) out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
	return out;
}

/** Deterministic UFVK lookup key — sha256 hex of the trimmed key text. */
export function ufvkFingerprint(ufvk) {
	return createHash('sha256').update(String(ufvk ?? '').trim(), 'utf8').digest('hex');
}

/**
 * Non-cancelled overlay already using this UFVK fingerprint, if any.
 * Scanner notes are per-UFVK, so only one live page may own a given key.
 */
export function findLiveOverlayByUfvkFingerprint(db, fingerprintHex) {
	if (typeof fingerprintHex !== 'string' || fingerprintHex.length === 0) return null;
	return db.prepare(`
		SELECT * FROM donation_overlays
		WHERE ufvk_fingerprint = ? AND cancelled = 0
		ORDER BY created_at_ms DESC
		LIMIT 1
	`).get(fingerprintHex) ?? null;
}

/** Non-cancelled overlay already registered on this receive address. */
export function findLiveOverlayByAddress(db, address) {
	if (typeof address !== 'string' || address.length === 0) return null;
	return db.prepare(`
		SELECT * FROM donation_overlays
		WHERE address = ? AND cancelled = 0
		ORDER BY created_at_ms DESC
		LIMIT 1
	`).get(address) ?? null;
}

/**
 * Throw if this wallet/address already has a live page.
 * Attaches `.code = 'wallet_already_has_page'` and existing slug/id for API 409s.
 */
export function assertWalletAvailableForOverlay(db, { address, ufvkFingerprintHex = null } = {}) {
	const byFp = ufvkFingerprintHex
		? findLiveOverlayByUfvkFingerprint(db, ufvkFingerprintHex)
		: null;
	const byAddr = findLiveOverlayByAddress(db, address);
	const existing = byFp ?? byAddr;
	if (!existing) return;
	const err = new Error(
		existing.slug
			? `This wallet already has an active page ("${existing.slug}"). Cancel it on Manage before creating another.`
			: 'This wallet already has an active overlay. Cancel it before creating another.'
	);
	err.code = 'wallet_already_has_page';
	err.existingSlug = existing.slug ?? null;
	err.existingOverlayId = existing.id;
	throw err;
}

/**
 * Create an overlay. `ufvkCiphertext` is the already-encrypted UFVK.
 * Returns { id, ownerToken, expiresAt } — only the token HASH is stored.
 *
 * At most one non-cancelled overlay may share a UFVK fingerprint or receive
 * address (donations cannot be attributed across multiple pages otherwise).
 */
export function createOverlay(db, {
	address,
	ufvkCiphertext,
	birthdayHeight = null,
	baselineHeight = null,
	label = null,
	minZatoshi = null,
	slug = null,
	story = null,
	goalZatoshi = null,
	recoveryCodeHash = null,
	ufvkFingerprintHex = null,
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
	assertWalletAvailableForOverlay(db, { address, ufvkFingerprintHex });
	const id = genOverlayId();
	const ownerToken = genOverlayOwnerToken();
	const expiresAt = Math.min(
		nowMs + Math.floor((creditAtomic * 86_400_000) / dayRateAtomic),
		nowMs + OVERLAY_CONSTANTS.MAX_LIFETIME_MS
	);
	db.prepare(`
		INSERT INTO donation_overlays
			(id, owner_token_hash, chain, address, ufvk_ct, birthday_height, baseline_height, label, min_zatoshi,
			 slug, story, goal_zatoshi, recovery_code_hash, ufvk_fingerprint,
			 created_at_ms, expires_at_ms, credit_atomic, credit_topups_atomic, credit_last_billed_ms)
		VALUES (@id, @hash, 'zcash', @address, @ufvkCt, @birthday, @baseline, @label, @minZat,
		        @slug, @story, @goalZat, @recoveryHash, @ufvkFp,
		        @now, @expires, @credit, @credit, @now)
	`).run({
		id,
		hash: hashToken(ownerToken),
		address,
		ufvkCt: ufvkCiphertext,
		birthday: birthdayHeight ?? null,
		baseline: Number.isInteger(baselineHeight) ? baselineHeight : null,
		label: label ?? null,
		minZat: minZatoshi != null ? String(minZatoshi) : null,
		slug: slug ?? null,
		story: story ?? null,
		goalZat: goalZatoshi != null ? String(goalZatoshi) : null,
		recoveryHash: recoveryCodeHash ?? null,
		ufvkFp: ufvkFingerprintHex ?? null,
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
export function applyFeaturePurchase(db, overlayId, { quoteId = null, days, usdCents, nowMs = Date.now() }) {
	// With a quoteId we settle exactly the quote that was paid; the
	// cents-match path is only a fallback for callers that predate quote
	// ids (it can mis-dispatch when two products share a price, e.g. a
	// $5 scan top-up vs a $5 one-day feature).
	const pending = quoteId != null
		? db.prepare(`
			SELECT * FROM ziving_feature_quotes
			WHERE quote_id = ? AND overlay_id = ? AND settled = 0
		`).get(quoteId, overlayId)
		: db.prepare(`
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

/** Newest campaign pages (public slugs, non-cancelled, still on credit). */
export function listRecentCampaigns(db, { limit = 6 } = {}) {
	const cap = Math.min(Math.max(1, Number(limit) || 1), OVERLAY_CONSTANTS.FEATURED_LIST_MAX);
	return db.prepare(`
		SELECT * FROM donation_overlays
		WHERE slug IS NOT NULL AND cancelled = 0 AND credit_atomic > 0
		ORDER BY created_at_ms DESC
		LIMIT ?
	`).all(cap);
}

/** Latest confirmed donations across campaign pages, newest first. */
export function listRecentCampaignDonations(db, { limit = 12 } = {}) {
	const cap = Math.min(Math.max(1, Number(limit) || 1), OVERLAY_CONSTANTS.EVENTS_PAGE_MAX);
	return db.prepare(`
		SELECT e.id, e.amount_atomic, e.memo, e.first_seen_ms, o.slug, o.label
		FROM donation_events e
		JOIN donation_overlays o ON o.id = e.overlay_id
		WHERE o.slug IS NOT NULL AND o.cancelled = 0
		  AND e.suppressed = 0 AND e.status = 'confirmed'
		ORDER BY e.id DESC
		LIMIT ?
	`).all(cap);
}

/**
 * Fetch an overlay gated by the owner token (constant-time compare) or a
 * live wallet-login session token for the same overlay.
 * Returns the row, { error: 'not_found' }, or { error: 'forbidden' }.
 */
export function getOverlayAuthorised(db, id, ownerToken, { nowMs = Date.now() } = {}) {
	const row = getOverlay(db, id);
	if (!row) return { error: 'not_found' };
	if (typeof ownerToken !== 'string' || ownerToken.length === 0) return { error: 'forbidden' };
	if (safeEqualHex(hashToken(ownerToken), row.owner_token_hash)) return row;
	const session = db.prepare(`
		SELECT 1 FROM overlay_sessions
		WHERE token_hash = ? AND overlay_id = ? AND expires_at_ms > ?
	`).get(hashToken(ownerToken), id, nowMs);
	return session ? row : { error: 'forbidden' };
}

/**
 * Issue a wallet-login session covering `overlayIds`. Returns the plaintext
 * token (shown once); only the hash is stored. Expired sessions are pruned
 * opportunistically here.
 */
export function createOverlaySession(db, overlayIds, {
	nowMs = Date.now(),
	ttlMs = OVERLAY_CONSTANTS.SESSION_TTL_MS
} = {}) {
	const ids = (overlayIds ?? []).filter((v) => typeof v === 'string' && v.length > 0);
	if (ids.length === 0) throw new TypeError('createOverlaySession: at least one overlay id required');
	db.prepare('DELETE FROM overlay_sessions WHERE expires_at_ms <= ?').run(nowMs);
	const token = genOverlaySessionToken();
	const expiresAtMs = nowMs + ttlMs;
	const insert = db.prepare(`
		INSERT INTO overlay_sessions (token_hash, overlay_id, created_at_ms, expires_at_ms)
		VALUES (?, ?, ?, ?)
	`);
	const hash = hashToken(token);
	for (const id of ids) insert.run(hash, id, nowMs, expiresAtMs);
	return { token, expiresAtMs, overlayIds: ids };
}

/**
 * All overlays owned by a UFVK. Fast path is the stored fingerprint;
 * pre-migration rows (NULL fingerprint) fall back to decrypt-and-compare
 * and are backfilled on match so the next login is indexed.
 */
export function findOverlaysByUfvk(db, presentedUfvk, decryptViewKey) {
	const ufvk = typeof presentedUfvk === 'string' ? presentedUfvk.trim() : '';
	if (!ufvk.startsWith('uview')) return [];
	const fp = ufvkFingerprint(ufvk);
	const matched = db.prepare('SELECT * FROM donation_overlays WHERE ufvk_fingerprint = ?').all(fp);
	if (typeof decryptViewKey === 'function') {
		const legacy = db.prepare('SELECT * FROM donation_overlays WHERE ufvk_fingerprint IS NULL AND cancelled = 0').all();
		const liveOwner = findLiveOverlayByUfvkFingerprint(db, fp);
		for (const row of legacy) {
			let stored;
			try { stored = decryptViewKey(row.ufvk_ct); } catch { continue; }
			if (!safeEqualUtf8(stored, ufvk)) continue;
			// Do not stamp the fingerprint onto a second live row — unique
			// index / one-page-per-wallet rule. Still return it for login.
			if (liveOwner && liveOwner.id !== row.id) {
				matched.push(row);
				continue;
			}
			db.prepare('UPDATE donation_overlays SET ufvk_fingerprint = ? WHERE id = ?').run(fp, row.id);
			matched.push({ ...row, ufvk_fingerprint: fp });
		}
	}
	return matched;
}

/** Store a (new) recovery-code hash. Overwrites any previous code. */
export function setOverlayRecoveryCode(db, id, { code = genOverlayRecoveryCode() } = {}) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	db.prepare('UPDATE donation_overlays SET recovery_code_hash = ? WHERE id = ?')
		.run(hashToken(normaliseRecoveryCode(code)), id);
	return { ok: true, recoveryCode: code };
}

/** Constant-time recovery-code check against the stored hash. */
export function verifyOverlayRecoveryCode(row, code) {
	if (!row?.recovery_code_hash) return false;
	const normalised = normaliseRecoveryCode(code);
	if (normalised.length === 0) return false;
	return safeEqualHex(hashToken(normalised), row.recovery_code_hash);
}

/** Issue (or reissue) the X-link nonce. Reissuing does not clear an already-verified link. */
export function setOverlayXLinkCode(db, id, { code = genOverlayXLinkCode() } = {}) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	db.prepare('UPDATE donation_overlays SET x_link_code = ? WHERE id = ?').run(code, id);
	return { ok: true, code };
}

/** Record a verified X link (handle + the tweet used as proof). Clears the spent nonce. */
export function setOverlayXLink(db, id, { handle, proofUrl, nowMs = Date.now() }) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	db.prepare('UPDATE donation_overlays SET x_handle = ?, x_proof_url = ?, x_verified_at_ms = ?, x_link_code = NULL WHERE id = ?')
		.run(handle, proofUrl, nowMs, id);
	return { ok: true, handle, proofUrl, verifiedAtMs: nowMs };
}

/** Remove a linked X account (owner's choice, or re-linking a different one). */
export function clearOverlayXLink(db, id) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	db.prepare('UPDATE donation_overlays SET x_handle = NULL, x_proof_url = NULL, x_verified_at_ms = NULL, x_link_code = NULL WHERE id = ?').run(id);
	return { ok: true };
}

/** Record a pending lost-key unlock purchase (settled by the receive-poller). */
export function createRecoveryQuoteRow(db, { quoteId, overlayId, usdCents, nowMs = Date.now() }) {
	if (typeof quoteId !== 'string' || !quoteId) throw new TypeError('createRecoveryQuoteRow: quoteId required');
	if (typeof overlayId !== 'string' || !overlayId) throw new TypeError('createRecoveryQuoteRow: overlayId required');
	if (!Number.isInteger(usdCents) || usdCents <= 0) throw new TypeError('createRecoveryQuoteRow: usdCents required');
	db.prepare(`
		INSERT INTO ziving_recovery_quotes (quote_id, overlay_id, usd_cents, settled, created_at_ms)
		VALUES (?, ?, ?, 0, ?)
	`).run(quoteId, overlayId, usdCents, nowMs);
	return { quoteId, overlayId, usdCents };
}

/**
 * Settle a lost-key unlock payment: open the claim window on the overlay.
 * Mirrors applyFeaturePurchase's pending-row-by-cents dispatch.
 */
export function applyRecoveryUnlock(db, overlayId, {
	quoteId = null,
	usdCents,
	windowMs = OVERLAY_CONSTANTS.RECOVERY_UNLOCK_WINDOW_MS,
	nowMs = Date.now()
}) {
	// Same exact-quote dispatch as applyFeaturePurchase.
	const pending = quoteId != null
		? db.prepare(`
			SELECT * FROM ziving_recovery_quotes
			WHERE quote_id = ? AND overlay_id = ? AND settled = 0
		`).get(quoteId, overlayId)
		: db.prepare(`
			SELECT * FROM ziving_recovery_quotes
			WHERE overlay_id = ? AND usd_cents = ? AND settled = 0
			ORDER BY created_at_ms DESC
			LIMIT 1
		`).get(overlayId, usdCents);
	if (!pending) return { ok: false, reason: 'no_pending_recovery' };
	const row = getOverlay(db, overlayId);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.cancelled === 1) return { ok: false, reason: 'cancelled' };
	const unlockUntilMs = nowMs + windowMs;
	db.prepare('UPDATE donation_overlays SET recovery_unlock_ms = ? WHERE id = ?').run(unlockUntilMs, overlayId);
	db.prepare('UPDATE ziving_recovery_quotes SET settled = 1 WHERE quote_id = ?').run(pending.quote_id);
	return { ok: true, unlockUntilMs };
}

/**
 * Claim a paid lost-key recovery: inside the unlock window, rotate the
 * owner token AND the recovery code (both returned once), close the window.
 */
export function claimOverlayRecovery(db, id, { nowMs = Date.now() } = {}) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.cancelled === 1) return { ok: false, reason: 'cancelled' };
	if (!(Number(row.recovery_unlock_ms) > nowMs)) return { ok: false, reason: 'not_unlocked' };
	const rotated = rotateOverlayOwnerToken(db, id);
	if (!rotated.ok) return rotated;
	const recoveryCode = genOverlayRecoveryCode();
	db.prepare('UPDATE donation_overlays SET recovery_code_hash = ?, recovery_unlock_ms = NULL WHERE id = ?')
		.run(hashToken(normaliseRecoveryCode(recoveryCode)), id);
	return { ok: true, ownerToken: rotated.ownerToken, recoveryCode, id: row.id, slug: row.slug ?? null };
}

/**
 * Rotate the owner bearer token. Returns the new plaintext token (shown once).
 * Caller must already have proven ownership (token or UFVK match).
 */
export function rotateOverlayOwnerToken(db, id) {
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	const ownerToken = genOverlayOwnerToken();
	db.prepare('UPDATE donation_overlays SET owner_token_hash = ? WHERE id = ?')
		.run(hashToken(ownerToken), id);
	return { ok: true, ownerToken, id };
}

/**
 * Prove ownership by re-presenting the UFVK used at create time.
 * `decryptViewKey(ciphertext)` must return the plaintext UFVK.
 * On match, rotates the owner token and returns it once.
 */
export function recoverOverlayOwnerByUfvk(db, id, presentedUfvk, decryptViewKey) {
	if (typeof decryptViewKey !== 'function') {
		throw new TypeError('recoverOverlayOwnerByUfvk: decryptViewKey required');
	}
	const row = getOverlay(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.cancelled === 1) return { ok: false, reason: 'cancelled' };
	const ufvk = typeof presentedUfvk === 'string' ? presentedUfvk.trim() : '';
	if (!ufvk.startsWith('uview')) return { ok: false, reason: 'invalid_ufvk' };
	let stored;
	try { stored = decryptViewKey(row.ufvk_ct); }
	catch {
		return { ok: false, reason: 'decrypt_failed' };
	}
	if (!safeEqualUtf8(stored, ufvk)) return { ok: false, reason: 'forbidden' };
	const rotated = rotateOverlayOwnerToken(db, id);
	if (!rotated.ok) return rotated;
	return { ok: true, ownerToken: rotated.ownerToken, id: row.id, slug: row.slug ?? null };
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
