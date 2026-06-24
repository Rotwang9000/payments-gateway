// Unit tests for the paid-unlock pure helpers and SQLite store: validation,
// seal/open round-trip, native quote building, claim accounting, idempotent
// payment marking, expiry and stats. No Fastify, no live RPC.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, test, expect, beforeEach } from '@jest/globals';
import Database from 'better-sqlite3';

import { parseMasterKey } from 'viewkey-watch/private-watch-crypto';

import {
	UNLOCK_CONSTANTS,
	validateListingRequest,
	sealSecret,
	openSecret,
	buildNativeQuote,
	usdCentsToUsdcAtomic,
	publicListing,
	publicOrder
} from '../src/paid-unlock.js';
import {
	openUnlockDb,
	createListing,
	getListing,
	isListingOpen,
	withdrawListing,
	listPublicListings,
	createOrder,
	getOrder,
	getOrderAuthorised,
	markOrderPaid,
	claimOrder,
	hasOpenOrderWithAmount,
	expireStaleOrders,
	statsSnapshot
} from '../src/paid-unlock-store.js';

const MASTER_KEY = parseMasterKey('a'.repeat(64));
const SECRET = JSON.stringify({ alg: 'A256GCM', key: 'k_9f2b', iv: 'iv_1a', url: 'https://cdn.example/f.enc', name: 'report.pdf' });

function baseListing(over = {}) {
	return { title: 'Secret report', description: 'A PDF', secret: SECRET, priceUsdCents: 500, ...over };
}

describe('validateListingRequest', () => {
	test('accepts a well-formed request and intersects pay chains', () => {
		const out = validateListingRequest(baseListing({ payChains: ['zcash', 'monero'] }), { enabledNativeChains: ['zcash'] });
		expect(out.title).toBe('Secret report');
		expect(out.priceUsdCents).toBe(500);
		expect(out.payChains).toEqual(['zcash']); // monero dropped — not enabled
		expect(out.claimMax).toBe(UNLOCK_CONSTANTS.CLAIM_MAX_PER_ORDER_DEFAULT);
	});

	test('defaults pay chains to the enabled set', () => {
		const out = validateListingRequest(baseListing(), { enabledNativeChains: ['zcash', 'monero'] });
		expect(out.payChains).toEqual(['zcash', 'monero']);
	});

	test('rejects bad input', () => {
		expect(() => validateListingRequest({}, {})).toThrow(/title/);
		expect(() => validateListingRequest(baseListing({ title: 'ab' }), {})).toThrow(/title/);
		expect(() => validateListingRequest(baseListing({ secret: undefined }), {})).toThrow(/secret/);
		expect(() => validateListingRequest(baseListing({ priceUsdCents: 1 }), {})).toThrow(/out of range/);
		expect(() => validateListingRequest(baseListing({ priceUsdCents: 9_999_999 }), {})).toThrow(/out of range/);
		expect(() => validateListingRequest(baseListing({ payChains: ['doge'] }), {})).toThrow(/payChains/);
	});

	test('rejects an oversized secret (it is a key, not the file)', () => {
		const big = 'x'.repeat(UNLOCK_CONSTANTS.SECRET_MAX_BYTES + 1);
		expect(() => validateListingRequest(baseListing({ secret: big }), {})).toThrow(/bytes/);
	});

	test('clamps claimMax to the cap and validates maxOrders', () => {
		expect(() => validateListingRequest(baseListing({ claimMax: 999 }), {})).toThrow(/claimMax/);
		const out = validateListingRequest(baseListing({ maxOrders: 10 }), {});
		expect(out.maxOrders).toBe(10);
	});
});

describe('seal/open', () => {
	test('round-trips the secret through the master key', () => {
		const ct = sealSecret(SECRET, MASTER_KEY);
		expect(ct).not.toContain('report.pdf'); // sealed, not plaintext
		expect(openSecret(ct, MASTER_KEY)).toBe(SECRET);
	});

	test('a wrong key cannot open it', () => {
		const ct = sealSecret(SECRET, MASTER_KEY);
		expect(() => openSecret(ct, parseMasterKey('b'.repeat(64)))).toThrow();
	});
});

describe('buildNativeQuote', () => {
	test('zcash gets a memo and a sane amount', () => {
		const q = buildNativeQuote({ chain: 'zcash', priceUsdCents: 500, usdPerCoin: 50, spreadBps: 400, memoPrefix: 'WB' });
		expect(q.coin).toBe('ZEC');
		expect(q.memo).toMatch(/^WB-[0-9a-f]{8}$/);
		expect(BigInt(q.expectedAtomic)).toBeGreaterThan(0n);
	});

	test('monero gets a unique amount-tag, retrying on collision', () => {
		const seen = new Set();
		const q1 = buildNativeQuote({ chain: 'monero', priceUsdCents: 500, usdPerCoin: 200, spreadBps: 400, isAmountTaken: (c, a) => seen.has(String(a)) });
		seen.add(String(q1.expectedAtomic));
		const q2 = buildNativeQuote({ chain: 'monero', priceUsdCents: 500, usdPerCoin: 200, spreadBps: 400, isAmountTaken: (c, a) => seen.has(String(a)) });
		expect(q1.memo).toBeNull();
		expect(String(q2.expectedAtomic)).not.toBe(String(q1.expectedAtomic));
	});

	test('rejects a non-native chain', () => {
		expect(() => buildNativeQuote({ chain: 'usdc', priceUsdCents: 500, usdPerCoin: 1 })).toThrow(/chain/);
	});
});

describe('usdCentsToUsdcAtomic', () => {
	test('1 cent = 10_000 atomic; $5.00 = 5_000_000', () => {
		expect(usdCentsToUsdcAtomic(1)).toBe(10_000n);
		expect(usdCentsToUsdcAtomic(500)).toBe(5_000_000n);
	});
});

describe('store: listings + orders + claims', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	function makeListing(over = {}) {
		return createListing(db, {
			title: 'T', description: 'D', priceUsdCents: 500, payChains: ['zcash'],
			secretCt: sealSecret(SECRET, MASTER_KEY), claimMax: 3, ttlSec: 3600, nowMs: 1_000, ...over
		});
	}

	test('createListing returns an owner token; getListing reads it back', () => {
		const { id, ownerToken } = makeListing();
		const row = getListing(db, id);
		expect(row.status).toBe('live');
		expect(row.orders_count).toBe(0);
		expect(isListingOpen(row, 2_000)).toBe(true);
		expect(isListingOpen(row, 10_000_000)).toBe(false); // past expiry
		expect(typeof ownerToken).toBe('string');
		// public projection never leaks the ciphertext
		const pub = publicListing(row, { nativeChains: ['zcash'], x402Enabled: true });
		expect(JSON.stringify(pub)).not.toContain(row.secret_ct);
		expect(pub.pay.native_chains).toEqual(['zcash']);
		expect(pub.pay.usdc_x402).toBe(true);
	});

	test('createOrder bumps orders_count and enforces sold-out', () => {
		const { id } = makeListing({ maxOrders: 1 });
		const o1 = createOrder(db, { listingId: id, chain: 'zcash', recvAddress: 'u1', expectedAtomic: 111n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		expect(o1.ok).toBe(true);
		expect(getListing(db, id).orders_count).toBe(1);
		const o2 = createOrder(db, { listingId: id, chain: 'zcash', recvAddress: 'u1', expectedAtomic: 222n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		expect(o2).toEqual({ ok: false, reason: 'sold_out' });
	});

	test('claim requires payment, then delivers up to the claim limit', () => {
		const { id } = makeListing();
		const o = createOrder(db, { listingId: id, chain: 'zcash', recvAddress: 'u1', expectedAtomic: 111n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		expect(claimOrder(db, o.id, { nowMs: 1_100 })).toEqual({ ok: false, reason: 'unpaid' });

		const paid = markOrderPaid(db, o.id, { txid: 'zectx', seenAtomic: 111n, nowMs: 1_200 });
		expect(paid.ok).toBe(true);
		// idempotent
		expect(markOrderPaid(db, o.id, { nowMs: 1_201 }).already).toBe(true);

		for (let i = 1; i <= 3; i += 1) {
			const c = claimOrder(db, o.id, { nowMs: 1_300 + i });
			expect(c.ok).toBe(true);
			expect(c.row.claims_used).toBe(i);
		}
		expect(claimOrder(db, o.id, { nowMs: 2_000 })).toEqual({ ok: false, reason: 'claim_limit_reached' });
	});

	test('getOrderAuthorised gates on the claim token', () => {
		const { id } = makeListing();
		const o = createOrder(db, { listingId: id, chain: 'zcash', recvAddress: 'u1', expectedAtomic: 111n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		expect(getOrderAuthorised(db, o.id, o.claimToken).id).toBe(o.id);
		expect(getOrderAuthorised(db, o.id, 'wrong')).toEqual({ error: 'forbidden' });
		expect(getOrderAuthorised(db, 'nope', o.claimToken)).toEqual({ error: 'not_found' });
	});

	test('hasOpenOrderWithAmount + expireStaleOrders', () => {
		const { id } = makeListing();
		const o = createOrder(db, { listingId: id, chain: 'monero', recvAddress: '4', expectedAtomic: 26_000_001n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		expect(hasOpenOrderWithAmount(db, 'monero', 26_000_001n)).toBe(true);
		expect(hasOpenOrderWithAmount(db, 'monero', 999n)).toBe(false);
		const expired = expireStaleOrders(db, 1_000 + 600 * 1000 + 1);
		expect(expired).toBe(1);
		expect(getOrder(db, o.id).status).toBe('expired');
		// a matched amount on an expired order no longer blocks reuse
		expect(hasOpenOrderWithAmount(db, 'monero', 26_000_001n)).toBe(false);
	});

	test('withdrawListing checks the owner token', () => {
		const { id, ownerToken } = makeListing();
		expect(withdrawListing(db, id, 'nope')).toEqual({ ok: false, reason: 'forbidden' });
		expect(withdrawListing(db, id, ownerToken)).toEqual({ ok: true });
		expect(getListing(db, id).status).toBe('withdrawn');
	});

	test('statsSnapshot rolls up gross sales', () => {
		const { id } = makeListing(); // $5.00
		const o = createOrder(db, { listingId: id, chain: 'zcash', recvAddress: 'u1', expectedAtomic: 111n, claimsMax: 3, ttlSec: 600, nowMs: 1_000 });
		markOrderPaid(db, o.id, { nowMs: 1_200 });
		const snap = statsSnapshot(db);
		expect(snap.listings_live).toBe(1);
		expect(snap.orders_paid).toBe(1);
		expect(snap.gross_usd_cents).toBe(500);
		expect(snap.gross_usd).toBe('$5.00');
	});
});

describe('discovery (public shop feed) + visibility', () => {
	let db;
	beforeEach(() => { db = openUnlockDb(':memory:'); });

	function makeListing(over = {}) {
		return createListing(db, {
			title: 'T', priceUsdCents: 500, payChains: ['zcash'],
			secretCt: sealSecret(SECRET, MASTER_KEY), claimMax: 3, ttlSec: 3600, nowMs: Date.now(), ...over
		});
	}

	test('listings default to unlisted and are excluded; public ones are returned newest-first', () => {
		makeListing({ title: 'hidden', nowMs: 1_000 });
		const a = makeListing({ title: 'pub-a', visibility: 'public', nowMs: 2_000 });
		const b = makeListing({ title: 'pub-b', visibility: 'public', nowMs: 3_000 });
		const rows = listPublicListings(db, { limit: 50, nowMs: 4_000 });
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(a.id);
		expect(ids).toContain(b.id);
		expect(rows.every((r) => r.title !== 'hidden')).toBe(true);
		// newest first (b created after a)
		expect(ids[0]).toBe(b.id);
		// default visibility persisted as 'unlisted'
		expect(getListing(db, makeListing({ nowMs: 5_000 }).id).visibility).toBe('unlisted');
	});

	test('withdrawn and expired public listings drop out of the feed', () => {
		const owned = makeListing({ title: 'gone', visibility: 'public' });
		withdrawListing(db, owned.id, owned.ownerToken);
		const expired = makeListing({ title: 'old', visibility: 'public', ttlSec: 1, nowMs: Date.now() - 10_000 });
		const ids = listPublicListings(db, { limit: 50 }).map((r) => r.id);
		expect(ids).not.toContain(owned.id);
		expect(ids).not.toContain(expired.id);
	});

	test('limit + offset paginate', () => {
		for (let i = 0; i < 5; i += 1) makeListing({ title: `p${i}`, visibility: 'public' });
		expect(listPublicListings(db, { limit: 2, offset: 0 }).length).toBe(2);
		expect(listPublicListings(db, { limit: 2, offset: 4 }).length).toBe(1);
	});
});

describe('store migration: adds visibility to a pre-existing DB', () => {
	test('openUnlockDb ALTERs an old listings table missing the visibility column', () => {
		const dir = mkdtempSync(join(tmpdir(), 'unlock-mig-'));
		const path = join(dir, 'old.db');
		// Simulate a DB created before the visibility column existed.
		const raw = new Database(path);
		raw.exec(`CREATE TABLE unlock_listings (
			id TEXT PRIMARY KEY, owner_token_hash TEXT NOT NULL, title TEXT NOT NULL,
			description TEXT, price_usd_cents INTEGER NOT NULL, pay_chains TEXT,
			secret_ct TEXT NOT NULL, claim_max INTEGER NOT NULL DEFAULT 3, max_orders INTEGER,
			orders_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'live',
			created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL)`);
		raw.close();

		const db = openUnlockDb(path); // should ALTER TABLE ADD COLUMN visibility
		const cols = new Set(db.prepare('PRAGMA table_info(unlock_listings)').all().map((c) => c.name));
		expect(cols.has('visibility')).toBe(true);
		// and it's usable: a public listing shows up in the feed
		const { id } = createListing(db, {
			title: 'after-migrate', priceUsdCents: 500, payChains: ['zcash'],
			secretCt: sealSecret(SECRET, MASTER_KEY), claimMax: 3, ttlSec: 3600, visibility: 'public', nowMs: Date.now()
		});
		expect(listPublicListings(db, { limit: 10 }).map((r) => r.id)).toContain(id);
		db.close();
	});
});

describe('publicOrder', () => {
	test('only includes the secret when explicitly provided', () => {
		const row = {
			id: 'uo_1', listing_id: 'ul_1', status: 'paid', chain: 'zcash', recv_address: 'u1',
			memo: 'WB-abcd1234', expected_atomic: '111', claims_used: 0, claims_max: 3,
			created_ms: 1_000, expires_ms: 9_000
		};
		expect(publicOrder(row, { confirmationsRequired: 8 }).secret).toBeUndefined();
		expect(publicOrder(row, { secret: 'S3CR3T' }).secret).toBe('S3CR3T');
	});
});
