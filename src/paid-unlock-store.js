// Paid unlock — SQLite persistence.
//
// Two tables in their own small writable DB:
//   • unlock_listings — a sealed secret behind a price (the seller side).
//   • unlock_orders    — a buyer's attempt to pay for a listing, carrying a
//     native-coin quote (or a USDC/x402 marker) and a claim budget.
//
// Privacy-respecting: we store an owner-token HASH (edit/withdraw) and a
// claim-token HASH (the buyer's bearer credential), never the raw tokens,
// IPs, or payer identities. The sealed secret ciphertext is opaque here —
// only the running process with the gateway master key can open it.

import Database from 'better-sqlite3';

import { genOwnerToken, hashToken, verifyOwner, safeEqualHex } from './notice-board.js';
import { genUnlockId, genClaimToken } from './paid-unlock.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS unlock_listings (
	id               TEXT PRIMARY KEY,
	owner_token_hash TEXT NOT NULL,
	title            TEXT NOT NULL,
	description      TEXT,
	price_usd_cents  INTEGER NOT NULL,
	pay_chains       TEXT,
	secret_ct        TEXT NOT NULL,
	claim_max        INTEGER NOT NULL DEFAULT 3,
	max_orders       INTEGER,
	orders_count     INTEGER NOT NULL DEFAULT 0,
	status           TEXT NOT NULL DEFAULT 'live',
	visibility       TEXT NOT NULL DEFAULT 'unlisted',
	created_ms       INTEGER NOT NULL,
	expires_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unlock_listings_status ON unlock_listings(status, expires_ms);

CREATE TABLE IF NOT EXISTS unlock_orders (
	id               TEXT PRIMARY KEY,
	listing_id       TEXT NOT NULL,
	claim_token_hash TEXT NOT NULL,
	chain            TEXT NOT NULL,
	recv_address     TEXT,
	memo             TEXT,
	expected_atomic  TEXT,
	status           TEXT NOT NULL DEFAULT 'pending',
	seen_atomic      TEXT,
	paid_txid        TEXT,
	claims_used      INTEGER NOT NULL DEFAULT 0,
	claims_max       INTEGER NOT NULL DEFAULT 3,
	created_ms       INTEGER NOT NULL,
	expires_ms       INTEGER NOT NULL,
	paid_ms          INTEGER,
	claimed_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_unlock_orders_listing ON unlock_orders(listing_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_unlock_orders_match ON unlock_orders(status, chain, expected_atomic);
`;

export function openUnlockDb(path = ':memory:') {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 3000');
	db.exec(SCHEMA);
	migrate(db);
	return db;
}

/** Forward-compatible column adds for DBs created by an earlier version.
 * CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so add
 * the column explicitly and idempotently BEFORE creating any index that
 * references it (a fresh DB already has the column from SCHEMA; an old one
 * doesn't, so the visibility index must be created here, post-ALTER). */
function migrate(db) {
	const cols = new Set(db.prepare('PRAGMA table_info(unlock_listings)').all().map((c) => c.name));
	if (!cols.has('visibility')) {
		db.exec("ALTER TABLE unlock_listings ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted'");
	}
	db.exec('CREATE INDEX IF NOT EXISTS idx_unlock_listings_public ON unlock_listings(visibility, status, created_ms)');
}

/**
 * Create a listing. Generates the owner token (returned once, only the hash
 * is stored). `secretCt` is the already-sealed secret ciphertext.
 */
export function createListing(db, {
	title,
	description = null,
	priceUsdCents,
	payChains = [],
	secretCt,
	claimMax = 3,
	maxOrders = null,
	ttlSec,
	visibility = 'unlisted',
	nowMs = Date.now()
}) {
	const id = genUnlockId('ul');
	const token = genOwnerToken();
	db.prepare(`
		INSERT INTO unlock_listings
			(id, owner_token_hash, title, description, price_usd_cents, pay_chains, secret_ct, claim_max, max_orders, orders_count, status, visibility, created_ms, expires_ms)
		VALUES
			(@id, @hash, @title, @description, @price, @payChains, @secretCt, @claimMax, @maxOrders, 0, 'live', @visibility, @now, @expires)
	`).run({
		id,
		hash: hashToken(token),
		title,
		description: description ?? null,
		price: priceUsdCents,
		payChains: Array.isArray(payChains) && payChains.length ? payChains.join(',') : null,
		secretCt,
		claimMax,
		maxOrders: maxOrders ?? null,
		visibility: visibility === 'public' ? 'public' : 'unlisted',
		now: nowMs,
		expires: nowMs + ttlSec * 1000
	});
	return { id, ownerToken: token };
}

/**
 * Public shop feed: live, non-expired, opt-in-public listings, newest first.
 * Never returns the secret. Sold-out and capped listings still show (the
 * projection flags sold_out) so a shop page can render them greyed out.
 */
export function listPublicListings(db, { limit = 24, offset = 0, nowMs = Date.now() } = {}) {
	return db.prepare(`
		SELECT * FROM unlock_listings
		WHERE visibility = 'public' AND status = 'live' AND expires_ms > ?
		ORDER BY created_ms DESC
		LIMIT ? OFFSET ?
	`).all(nowMs, limit, offset);
}

export function getListing(db, id) {
	return db.prepare('SELECT * FROM unlock_listings WHERE id = ?').get(id) ?? null;
}

/** Is the listing live (not withdrawn, not expired)? */
export function isListingOpen(row, nowMs = Date.now()) {
	return Boolean(row) && row.status === 'live' && row.expires_ms > nowMs;
}

export function withdrawListing(db, id, token) {
	const row = getListing(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (!verifyOwner(row, token)) return { ok: false, reason: 'forbidden' };
	db.prepare("UPDATE unlock_listings SET status = 'withdrawn' WHERE id = ?").run(id);
	return { ok: true };
}

/** True if some open (pending) order already claims this exact coin amount —
 * used to keep Monero amount-tags unique. */
export function hasOpenOrderWithAmount(db, chain, atomic) {
	const row = db.prepare(
		"SELECT 1 FROM unlock_orders WHERE status = 'pending' AND chain = ? AND expected_atomic = ? LIMIT 1"
	).get(chain, String(atomic));
	return Boolean(row);
}

/**
 * Create an order against a listing. Enforces the optional limited-edition
 * cap and bumps orders_count in one transaction. Generates the buyer's claim
 * token (returned once). `chain` is a native chain or 'usdc' for x402 buys.
 */
export function createOrder(db, {
	listingId,
	chain,
	recvAddress = null,
	memo = null,
	expectedAtomic = null,
	claimsMax,
	ttlSec,
	nowMs = Date.now()
}) {
	const id = genUnlockId('uo');
	const token = genClaimToken();
	const tx = db.transaction(() => {
		const listing = getListing(db, listingId);
		if (!isListingOpen(listing, nowMs)) return { ok: false, reason: 'listing_unavailable' };
		if (listing.max_orders != null && listing.orders_count >= listing.max_orders) {
			return { ok: false, reason: 'sold_out' };
		}
		db.prepare(`
			INSERT INTO unlock_orders
				(id, listing_id, claim_token_hash, chain, recv_address, memo, expected_atomic, status, claims_used, claims_max, created_ms, expires_ms)
			VALUES
				(@id, @listingId, @hash, @chain, @recv, @memo, @atomic, 'pending', 0, @claimsMax, @now, @expires)
		`).run({
			id,
			listingId,
			hash: hashToken(token),
			chain,
			recv: recvAddress ?? null,
			memo: memo ?? null,
			atomic: expectedAtomic != null ? String(expectedAtomic) : null,
			claimsMax,
			now: nowMs,
			expires: nowMs + ttlSec * 1000
		});
		db.prepare('UPDATE unlock_listings SET orders_count = orders_count + 1 WHERE id = ?').run(listingId);
		return { ok: true };
	});
	const res = tx();
	if (!res.ok) return res;
	return { ok: true, id, claimToken: token, row: getOrder(db, id) };
}

export function getOrder(db, id) {
	return db.prepare('SELECT * FROM unlock_orders WHERE id = ?').get(id) ?? null;
}

/** Order lookup gated by the buyer's claim token (constant-time compared). */
export function getOrderAuthorised(db, id, claimToken) {
	const row = getOrder(db, id);
	if (!row) return { error: 'not_found' };
	if (typeof claimToken !== 'string' || !safeEqualHex(hashToken(claimToken), row.claim_token_hash)) {
		return { error: 'forbidden' };
	}
	return row;
}

/**
 * Record that an inbound payment has been SEEN for a pending order but is not
 * yet buried under enough confirmations. Purely informational (so the status
 * endpoint can say "payment detected, confirming") — it never changes status,
 * so a not-yet-confirmed sighting can't unlock the secret. Idempotent.
 */
export function markOrderSeen(db, id, { seenAtomic = null, txid = null, nowMs = Date.now() } = {}) {
	const info = db.prepare(`
		UPDATE unlock_orders
		SET seen_atomic = ?, paid_txid = COALESCE(paid_txid, ?)
		WHERE id = ? AND status = 'pending'
	`).run(seenAtomic != null ? String(seenAtomic) : null, txid ?? null, id);
	return { ok: info.changes === 1 };
}

/**
 * Flip a pending order to paid (idempotent — a repeat is a no-op success).
 * Called by the receive-poller on a view-key match, or by the x402 buy route
 * after settlement.
 */
export function markOrderPaid(db, id, { txid = null, seenAtomic = null, nowMs = Date.now() } = {}) {
	const row = getOrder(db, id);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.status === 'paid' || row.status === 'claimed') return { ok: true, row, already: true };
	if (row.status === 'expired') return { ok: false, reason: 'expired' };
	db.prepare(`
		UPDATE unlock_orders
		SET status = 'paid', paid_txid = ?, seen_atomic = ?, paid_ms = ?
		WHERE id = ? AND status = 'pending'
	`).run(txid ?? null, seenAtomic != null ? String(seenAtomic) : null, nowMs, id);
	return { ok: true, row: getOrder(db, id) };
}

/**
 * Consume one claim from a paid order. Returns the row on success so the
 * caller can open + return the secret. Atomic: the conditional UPDATE only
 * fires while budget remains, so concurrent claims can't over-deliver.
 */
export function claimOrder(db, id, { nowMs = Date.now() } = {}) {
	const tx = db.transaction(() => {
		const row = getOrder(db, id);
		if (!row) return { ok: false, reason: 'not_found' };
		if (row.status === 'pending') return { ok: false, reason: 'unpaid' };
		if (row.status === 'expired') return { ok: false, reason: 'expired' };
		if (row.claims_used >= row.claims_max) return { ok: false, reason: 'claim_limit_reached' };
		const upd = db.prepare(`
			UPDATE unlock_orders
			SET claims_used = claims_used + 1, status = 'claimed', claimed_ms = ?
			WHERE id = ? AND claims_used < claims_max AND status IN ('paid', 'claimed')
		`).run(nowMs, id);
		if (upd.changes !== 1) return { ok: false, reason: 'claim_limit_reached' };
		return { ok: true, row: getOrder(db, id) };
	});
	return tx();
}

/** Expire pending orders past their deadline. Returns the number expired. */
export function expireStaleOrders(db, nowMs = Date.now()) {
	return db.prepare("UPDATE unlock_orders SET status = 'expired' WHERE status = 'pending' AND expires_ms < ?")
		.run(nowMs).changes;
}

/** Open pending orders the receive-poller should try to match (per chain). */
export function listMatchableOrders(db, { chain, limit = 500 } = {}) {
	return db.prepare(`
		SELECT id, listing_id, chain, recv_address, memo, expected_atomic, expires_ms
		FROM unlock_orders
		WHERE status = 'pending' AND chain = ? AND expected_atomic IS NOT NULL
		ORDER BY created_ms ASC
		LIMIT ?
	`).all(chain, limit);
}

/** Aggregate counters for the dashboard / stats block. */
export function statsSnapshot(db) {
	const listings = db.prepare(`
		SELECT
			SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live,
			COUNT(*) AS total
		FROM unlock_listings
	`).get() ?? {};
	const orders = db.prepare(`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
			SUM(CASE WHEN status IN ('paid', 'claimed') THEN 1 ELSE 0 END) AS paid,
			SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed
		FROM unlock_orders
	`).get() ?? {};
	// Gross sales (US cents) = price of each listing × its paid/claimed orders.
	const gross = db.prepare(`
		SELECT COALESCE(SUM(l.price_usd_cents), 0) AS cents
		FROM unlock_orders o JOIN unlock_listings l ON l.id = o.listing_id
		WHERE o.status IN ('paid', 'claimed')
	`).get()?.cents ?? 0;
	return {
		listings_live: listings.live ?? 0,
		listings_total: listings.total ?? 0,
		orders_total: orders.total ?? 0,
		orders_pending: orders.pending ?? 0,
		orders_paid: orders.paid ?? 0,
		orders_claimed: orders.claimed ?? 0,
		gross_usd_cents: gross,
		gross_usd: `$${(gross / 100).toFixed(2)}`
	};
}

/**
 * Opportunistic housekeeping: drop long-withdrawn/expired listings (and
 * their orders) plus old expired orders so the tables stay bounded.
 */
export function pruneOld(db, { nowMs = Date.now(), withdrawnTtlMs = 7 * 86_400_000, expiredOrderTtlMs = 2 * 86_400_000 } = {}) {
	const deadListings = db.prepare(`
		SELECT id FROM unlock_listings
		WHERE (status = 'withdrawn' AND expires_ms < ?) OR (expires_ms < ?)
	`).all(nowMs - withdrawnTtlMs, nowMs - withdrawnTtlMs).map((r) => r.id);
	let prunedOrders = 0;
	const dropOrdersFor = db.prepare('DELETE FROM unlock_orders WHERE listing_id = ?');
	const dropListing = db.prepare('DELETE FROM unlock_listings WHERE id = ?');
	const tx = db.transaction(() => {
		for (const id of deadListings) {
			prunedOrders += dropOrdersFor.run(id).changes;
			dropListing.run(id);
		}
	});
	tx();
	const oldExpired = db.prepare("DELETE FROM unlock_orders WHERE status = 'expired' AND expires_ms < ?")
		.run(nowMs - expiredOrderTtlMs).changes;
	return { pruned_listings: deadListings.length, pruned_orders: prunedOrders + oldExpired };
}
