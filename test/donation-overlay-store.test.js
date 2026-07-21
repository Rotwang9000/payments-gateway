// Store tests for the donation overlay — :memory: SQLite, zero network.

import { describe, test, expect, beforeEach } from '@jest/globals';
import Database from 'better-sqlite3';

import {
	OVERLAY_CONSTANTS,
	ensureDonationOverlaySchema,
	createOverlay,
	getOverlay,
	getOverlayAuthorised,
	cancelOverlay,
	listActiveOverlays,
	updateOverlayState,
	topupOverlayById,
	recordDonationEvent,
	updateEventConfirmations,
	listEventsSince,
	listUnconfirmedEvents,
	pruneOverlayData,
	overlayStatsSnapshot,
	featureUsdCentsForDays,
	createFeatureQuote,
	applyFeaturePurchase,
	listFeaturedCampaigns,
	recoverOverlayOwnerByUfvk,
	normaliseRecoveryCode,
	setOverlayRecoveryCode,
	verifyOverlayRecoveryCode,
	createRecoveryQuoteRow,
	applyRecoveryUnlock,
	claimOverlayRecovery,
	findOverlaysByUfvk,
	createOverlaySession,
	ufvkFingerprint,
	genOverlayXLinkCode,
	setOverlayXLinkCode,
	setOverlayXLink,
	clearOverlayXLink
} from '../src/donation-overlay-store.js';

const NOW = 1_700_000_000_000;

function openDb() {
	const db = new Database(':memory:');
	ensureDonationOverlaySchema(db);
	return db;
}

let overlayAddrSeq = 0;

function makeOverlay(db, over = {}) {
	overlayAddrSeq += 1;
	return createOverlay(db, {
		address: `u1streameraddress${overlayAddrSeq}`,
		ufvkCiphertext: 'ct:sealed-ufvk',
		label: 'Test Streamer',
		nowMs: NOW,
		...over
	});
}

describe('overlay lifecycle', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('create returns id + owner token; only the hash is stored', () => {
		const created = makeOverlay(db);
		expect(created.id).toMatch(/^ov_/);
		expect(typeof created.ownerToken).toBe('string');
		const row = getOverlay(db, created.id);
		expect(row.owner_token_hash).not.toContain(created.ownerToken);
		expect(row.ufvk_ct).toBe('ct:sealed-ufvk');
		expect(row.credit_atomic).toBe(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC);
	});

	test('baseline_height persists when supplied and is null otherwise', () => {
		expect(getOverlay(db, makeOverlay(db, { baselineHeight: 3_100_000 }).id).baseline_height).toBe(3_100_000);
		expect(getOverlay(db, makeOverlay(db, { slug: 'no-baseline' }).id).baseline_height).toBeNull();
	});

	test('owner-token auth: wrong token forbidden, unknown id not_found', () => {
		const created = makeOverlay(db);
		expect(getOverlayAuthorised(db, created.id, created.ownerToken).id).toBe(created.id);
		expect(getOverlayAuthorised(db, created.id, 'nope').error).toBe('forbidden');
		expect(getOverlayAuthorised(db, 'ov_missing', 'x').error).toBe('not_found');
	});

	test('cancel requires the owner token and removes from the active list', () => {
		const created = makeOverlay(db);
		expect(listActiveOverlays(db, { nowMs: NOW })).toHaveLength(1);
		expect(cancelOverlay(db, created.id, 'bad').ok).toBe(false);
		expect(cancelOverlay(db, created.id, created.ownerToken).ok).toBe(true);
		expect(listActiveOverlays(db, { nowMs: NOW })).toHaveLength(0);
	});

	test('out-of-credit overlays are not active; top-up revives and extends expiry', () => {
		const created = makeOverlay(db);
		updateOverlayState(db, created.id, { credit_atomic: 0 });
		expect(listActiveOverlays(db, { nowMs: NOW })).toHaveLength(0);
		const out = topupOverlayById(db, created.id, { creditAtomic: 2_000_000, nowMs: NOW });
		expect(out.ok).toBe(true);
		expect(out.row.credit_atomic).toBe(2_000_000);
		expect(out.row.expires_at_ms).toBeGreaterThan(NOW + 15 * 86_400_000); // $2 / $0.10 = 20 days
		expect(listActiveOverlays(db, { nowMs: NOW })).toHaveLength(1);
	});

	test('topup rejects unknown / cancelled overlays', () => {
		expect(topupOverlayById(db, 'ov_missing', { creditAtomic: 1 }).reason).toBe('not_found');
		const created = makeOverlay(db);
		cancelOverlay(db, created.id, created.ownerToken);
		expect(topupOverlayById(db, created.id, { creditAtomic: 1 }).reason).toBe('cancelled');
	});

	test('UFVK recover rotates owner token and rejects wrong key', () => {
		const created = makeOverlay(db, { slug: 'alice', ufvkCiphertext: 'ct:alice-ufvk' });
		const decrypt = (ct) => {
			expect(ct).toBe('ct:alice-ufvk');
			return 'uview1alice-secret-key';
		};
		const bad = recoverOverlayOwnerByUfvk(db, created.id, 'uview1wrong', decrypt);
		expect(bad.ok).toBe(false);
		expect(bad.reason).toBe('forbidden');
		expect(getOverlayAuthorised(db, created.id, created.ownerToken).id).toBe(created.id);

		const good = recoverOverlayOwnerByUfvk(db, created.id, 'uview1alice-secret-key', decrypt);
		expect(good.ok).toBe(true);
		expect(good.ownerToken).not.toBe(created.ownerToken);
		expect(getOverlayAuthorised(db, created.id, created.ownerToken).error).toBe('forbidden');
		expect(getOverlayAuthorised(db, created.id, good.ownerToken).id).toBe(created.id);
	});
});

describe('donation events', () => {
	let db;
	let overlay;
	beforeEach(() => {
		db = openDb();
		overlay = makeOverlay(db);
	});

	test('record is idempotent on (overlay, tx, amount, height)', () => {
		const args = { overlayId: overlay.id, txHash: 'tx1', amountAtomic: '50000000', blockHeight: 100, memo: 'gg', nowMs: NOW };
		expect(recordDonationEvent(db, args).inserted).toBe(true);
		expect(recordDonationEvent(db, args).inserted).toBe(false);
		expect(listEventsSince(db, overlay.id)).toHaveLength(1);
	});

	test('suppressed baseline events never surface in the feed', () => {
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'old', amountAtomic: '1', blockHeight: 1, suppressed: true, nowMs: NOW });
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'new', amountAtomic: '2', blockHeight: 2, nowMs: NOW });
		const feed = listEventsSince(db, overlay.id);
		expect(feed).toHaveLength(1);
		expect(feed[0].tx_hash).toBe('new');
	});

	test('cursor pagination is strictly ascending', () => {
		for (let i = 1; i <= 3; i += 1) {
			recordDonationEvent(db, { overlayId: overlay.id, txHash: `t${i}`, amountAtomic: String(i), blockHeight: i, nowMs: NOW });
		}
		const first = listEventsSince(db, overlay.id, { sinceId: 0, limit: 2 });
		expect(first.map((e) => e.tx_hash)).toEqual(['t1', 't2']);
		const rest = listEventsSince(db, overlay.id, { sinceId: first[1].id });
		expect(rest.map((e) => e.tx_hash)).toEqual(['t3']);
	});

	test('confirmation flip: seen → confirmed at the threshold only', () => {
		const { row } = recordDonationEvent(db, { overlayId: overlay.id, txHash: 'tx', amountAtomic: '9', blockHeight: 50, confirmations: 1, nowMs: NOW });
		expect(row.status).toBe('seen');
		updateEventConfirmations(db, row.id, 2, 3);
		expect(listUnconfirmedEvents(db, overlay.id)).toHaveLength(1);
		updateEventConfirmations(db, row.id, 3, 3);
		expect(listUnconfirmedEvents(db, overlay.id)).toHaveLength(0);
		expect(listEventsSince(db, overlay.id)[0].status).toBe('confirmed');
	});

	test('memo is capped at MEMO_MAX_LEN', () => {
		const { row } = recordDonationEvent(db, {
			overlayId: overlay.id, txHash: 'tx', amountAtomic: '9', blockHeight: 1,
			memo: 'x'.repeat(2 * OVERLAY_CONSTANTS.MEMO_MAX_LEN), nowMs: NOW
		});
		expect(row.memo).toHaveLength(OVERLAY_CONSTANTS.MEMO_MAX_LEN);
	});

	test('prune drops old events and long-dead overlays', () => {
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'a', amountAtomic: '1', blockHeight: 1, nowMs: NOW - OVERLAY_CONSTANTS.EVENT_TTL_MS - 1 });
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'b', amountAtomic: '2', blockHeight: 2, nowMs: NOW });
		const out = pruneOverlayData(db, { nowMs: NOW });
		expect(out.pruned_events).toBe(1);
		expect(listEventsSince(db, overlay.id)).toHaveLength(1);
		// A cancelled overlay past retention is hard-deleted with its events.
		cancelOverlay(db, overlay.id, overlay.ownerToken);
		updateOverlayState(db, overlay.id, {}); // no-op guard
		db.prepare('UPDATE donation_overlays SET expires_at_ms = ? WHERE id = ?')
			.run(NOW - OVERLAY_CONSTANTS.ROW_RETENTION_MS - 1, overlay.id);
		const out2 = pruneOverlayData(db, { nowMs: NOW });
		expect(out2.pruned_overlays).toBe(1);
		expect(getOverlay(db, overlay.id)).toBeNull();
	});

	test('stats snapshot counts overlays and visible events', () => {
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'a', amountAtomic: '1', blockHeight: 1, suppressed: true, nowMs: NOW });
		recordDonationEvent(db, { overlayId: overlay.id, txHash: 'b', amountAtomic: '2', blockHeight: 2, nowMs: NOW });
		const stats = overlayStatsSnapshot(db, { nowMs: NOW });
		expect(stats.overlays_total).toBe(1);
		expect(stats.overlays_active).toBe(1);
		expect(stats.events_total).toBe(2);
		expect(stats.events_visible).toBe(1);
	});
});

describe('homepage feature quotes', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('feature quotes settle via applyFeaturePurchase and listFeaturedCampaigns', () => {
		const created = makeOverlay(db, { slug: 'promo-run', label: 'Promo' });
		const days = 2;
		const usdCents = featureUsdCentsForDays(days);
		expect(usdCents).toBe(1000);
		createFeatureQuote(db, { quoteId: 'q-feat-1', overlayId: created.id, days, usdCents, nowMs: NOW });
		const out = applyFeaturePurchase(db, created.id, { days, usdCents, nowMs: NOW });
		expect(out.ok).toBe(true);
		expect(out.featuredUntilMs).toBe(NOW + 2 * 86_400_000);
		const list = listFeaturedCampaigns(db, { nowMs: NOW + 1000 });
		expect(list).toHaveLength(1);
		expect(list[0].slug).toBe('promo-run');
		expect(listFeaturedCampaigns(db, { nowMs: NOW + 3 * 86_400_000 })).toHaveLength(0);
	});

	test('quoteId dispatch settles exactly the paid quote — a same-priced scan top-up is not stolen', () => {
		const created = makeOverlay(db, { slug: 'exact-quote', label: 'Exact' });
		// One-day feature = $5 = the same 500¢ as a $5 scan top-up.
		createFeatureQuote(db, { quoteId: 'q-feat', overlayId: created.id, days: 1, usdCents: 500, nowMs: NOW });
		// The paid quote is the SCAN top-up (id 'q-scan'), not the feature.
		const miss = applyFeaturePurchase(db, created.id, { quoteId: 'q-scan', usdCents: 500, nowMs: NOW });
		expect(miss.ok).toBe(false);
		expect(miss.reason).toBe('no_pending_feature'); // falls through to scan credit
		// Paying the feature quote itself still settles it.
		const hit = applyFeaturePurchase(db, created.id, { quoteId: 'q-feat', usdCents: 500, nowMs: NOW });
		expect(hit.ok).toBe(true);
		expect(hit.days).toBe(1);
	});
});

describe('recovery codes, UFVK fingerprint lookup, wallet sessions', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('recovery code round-trip is paste-tolerant and rotatable', () => {
		const { id } = makeOverlay(db);
		expect(verifyOverlayRecoveryCode(getOverlay(db, id), 'zrk-anything')).toBe(false); // no code yet
		const { recoveryCode } = setOverlayRecoveryCode(db, id);
		const row = getOverlay(db, id);
		expect(verifyOverlayRecoveryCode(row, recoveryCode)).toBe(true);
		expect(verifyOverlayRecoveryCode(row, recoveryCode.toUpperCase().replaceAll('-', ' '))).toBe(true);
		expect(verifyOverlayRecoveryCode(row, 'zrk-wrong-wrong-wrng')).toBe(false);
		expect(normaliseRecoveryCode(' ZRK-a B-c ')).toBe('zrkabc');
		const second = setOverlayRecoveryCode(db, id);
		expect(verifyOverlayRecoveryCode(getOverlay(db, id), recoveryCode)).toBe(false); // retired
		expect(verifyOverlayRecoveryCode(getOverlay(db, id), second.recoveryCode)).toBe(true);
	});

	test('paid unlock opens a claim window; claim rotates token + code once', () => {
		const { id, ownerToken } = makeOverlay(db);
		setOverlayRecoveryCode(db, id);
		expect(claimOverlayRecovery(db, id, { nowMs: NOW }).reason).toBe('not_unlocked');
		createRecoveryQuoteRow(db, { quoteId: 'q1', overlayId: id, usdCents: 50, nowMs: NOW });
		expect(applyRecoveryUnlock(db, id, { usdCents: 49, nowMs: NOW }).reason).toBe('no_pending_recovery');
		const unlocked = applyRecoveryUnlock(db, id, { usdCents: 50, nowMs: NOW });
		expect(unlocked.ok).toBe(true);
		expect(unlocked.unlockUntilMs).toBe(NOW + OVERLAY_CONSTANTS.RECOVERY_UNLOCK_WINDOW_MS);
		// Window respected: too late → refused.
		expect(claimOverlayRecovery(db, id, { nowMs: unlocked.unlockUntilMs + 1 }).reason).toBe('not_unlocked');
		const claimed = claimOverlayRecovery(db, id, { nowMs: NOW + 1000 });
		expect(claimed.ok).toBe(true);
		expect(claimed.ownerToken).not.toBe(ownerToken);
		expect(getOverlayAuthorised(db, id, ownerToken).error).toBe('forbidden');
		expect(getOverlayAuthorised(db, id, claimed.ownerToken).id).toBe(id);
		// Window is single-use.
		expect(claimOverlayRecovery(db, id, { nowMs: NOW + 2000 }).reason).toBe('not_unlocked');
	});

	test('findOverlaysByUfvk matches by fingerprint and backfills legacy rows', () => {
		const ufvk = 'uview1alice-secret-key';
		const withFp = makeOverlay(db, { slug: 'new-page', ufvkFingerprintHex: ufvkFingerprint(ufvk) });
		// Cancel so a second live row with the same UFVK is allowed only as
		// a legacy NULL-fingerprint row for backfill testing — one live page
		// per wallet is otherwise enforced.
		expect(cancelOverlay(db, withFp.id, withFp.ownerToken).ok).toBe(true);
		const legacy = makeOverlay(db, { slug: 'old-page', ufvkCiphertext: `sealed:${ufvk}` });
		const decrypt = (ct) => String(ct).replace(/^sealed:/u, '');
		const found = findOverlaysByUfvk(db, ufvk, decrypt);
		expect(found.map((r) => r.id).sort()).toEqual([withFp.id, legacy.id].sort());
		// Backfilled: next lookup hits the index even without decrypt.
		expect(getOverlay(db, legacy.id).ufvk_fingerprint).toBe(ufvkFingerprint(ufvk));
		expect(findOverlaysByUfvk(db, ufvk, null).map((r) => r.id).sort())
			.toEqual([withFp.id, legacy.id].sort());
		expect(findOverlaysByUfvk(db, 'uview1someone-else', decrypt)).toHaveLength(0);
		expect(findOverlaysByUfvk(db, 'not-a-ufvk', decrypt)).toHaveLength(0);
	});

	test('one live page per UFVK fingerprint; cancelled pages free the wallet', () => {
		const ufvk = 'uview1one-wallet-rule';
		const fp = ufvkFingerprint(ufvk);
		const first = makeOverlay(db, { slug: 'page-one', ufvkFingerprintHex: fp });
		expect(() => makeOverlay(db, { slug: 'page-two', ufvkFingerprintHex: fp }))
			.toThrow(/already has an active/);
		expect(cancelOverlay(db, first.id, first.ownerToken).ok).toBe(true);
		const second = makeOverlay(db, { slug: 'page-two', ufvkFingerprintHex: fp });
		expect(second.id).not.toBe(first.id);
	});

	test('one live page per receive address', () => {
		const addr = 'u1shared-receive-address';
		makeOverlay(db, { slug: 'addr-a', address: addr });
		expect(() => makeOverlay(db, { slug: 'addr-b', address: addr }))
			.toThrow(/already has an active/);
	});

	test('wallet sessions authorise like the owner token until they expire', () => {
		const a = makeOverlay(db, { slug: 'page-a' });
		const b = makeOverlay(db, { slug: 'page-b' });
		const other = makeOverlay(db, { slug: 'page-c' });
		const session = createOverlaySession(db, [a.id, b.id], { nowMs: NOW });
		expect(session.token).toMatch(/^zses_/u);
		expect(getOverlayAuthorised(db, a.id, session.token, { nowMs: NOW }).id).toBe(a.id);
		expect(getOverlayAuthorised(db, b.id, session.token, { nowMs: NOW }).id).toBe(b.id);
		expect(getOverlayAuthorised(db, other.id, session.token, { nowMs: NOW }).error).toBe('forbidden');
		expect(getOverlayAuthorised(db, a.id, session.token, { nowMs: session.expiresAtMs + 1 }).error).toBe('forbidden');
		// Owner tokens are untouched by sessions.
		expect(getOverlayAuthorised(db, a.id, a.ownerToken).id).toBe(a.id);
	});
});

describe('X (Twitter) self-attestation link', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('code, verify and unlink round-trip', () => {
		const { id } = makeOverlay(db);
		expect(getOverlay(db, id).x_link_code).toBeNull();
		const { code } = setOverlayXLinkCode(db, id);
		expect(code).toMatch(/^ziving-[a-z0-9]{8}$/u);
		expect(getOverlay(db, id).x_link_code).toBe(code);

		const linked = setOverlayXLink(db, id, { handle: 'alice', proofUrl: 'https://x.com/alice/status/1', nowMs: NOW });
		expect(linked.ok).toBe(true);
		const row = getOverlay(db, id);
		expect(row.x_handle).toBe('alice');
		expect(row.x_proof_url).toBe('https://x.com/alice/status/1');
		expect(row.x_verified_at_ms).toBe(NOW);
		// Verifying spends the nonce so an old code can't be replayed elsewhere.
		expect(row.x_link_code).toBeNull();

		expect(clearOverlayXLink(db, id).ok).toBe(true);
		const cleared = getOverlay(db, id);
		expect(cleared.x_handle).toBeNull();
		expect(cleared.x_proof_url).toBeNull();
		expect(cleared.x_verified_at_ms).toBeNull();
	});

	test('reissuing a code does not clear an already-verified link', () => {
		const { id } = makeOverlay(db);
		setOverlayXLinkCode(db, id);
		setOverlayXLink(db, id, { handle: 'alice', proofUrl: 'https://x.com/alice/status/1', nowMs: NOW });
		const { code: second } = setOverlayXLinkCode(db, id);
		const row = getOverlay(db, id);
		expect(row.x_handle).toBe('alice'); // still linked
		expect(row.x_link_code).toBe(second); // but a fresh nonce is pending (e.g. to relink)
	});

	test('codes are unique enough not to collide across many calls', () => {
		const codes = new Set(Array.from({ length: 200 }, () => genOverlayXLinkCode()));
		expect(codes.size).toBe(200);
	});
});
