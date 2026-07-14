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
	listFeaturedCampaigns
} from '../src/donation-overlay-store.js';

const NOW = 1_700_000_000_000;

function openDb() {
	const db = new Database(':memory:');
	ensureDonationOverlaySchema(db);
	return db;
}

function makeOverlay(db, over = {}) {
	return createOverlay(db, {
		address: 'u1streameraddress',
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
});
