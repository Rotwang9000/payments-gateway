// Poller tests for the donation overlay — full state machine against a
// :memory: DB with a stubbed wallet scanner. Zero network, zero NFPT.

import { describe, test, expect, beforeEach } from '@jest/globals';
import Database from 'better-sqlite3';

import {
	ensureDonationOverlaySchema,
	createOverlay,
	getOverlay,
	updateOverlayState,
	listEventsSince,
	OVERLAY_CONSTANTS
} from '../src/donation-overlay-store.js';
import {
	runOverlayTick,
	ingestScanResult,
	scanBoundsForOverlay,
	makeOverlayCreditApplier,
	OVERLAY_CONFIRMATIONS_DEFAULT
} from '../src/donation-overlay-poller.js';

const NOW = 1_700_000_000_000;
const silentLog = { info() {}, warn() {}, error() {} };

function openDb() {
	const db = new Database(':memory:');
	ensureDonationOverlaySchema(db);
	return db;
}

function makeOverlay(db, over = {}) {
	return createOverlay(db, {
		address: 'u1streamer',
		ufvkCiphertext: 'ct:ufvk',
		creditAtomic: 1_000_000, // $1 → 50 days, no out-of-credit surprises
		nowMs: NOW,
		...over
	});
}

function note(over = {}) {
	return { amountAtomic: '25000000', txHash: 'tx-a', blockHeight: 3_100_000, memo: 'great stream!', ...over };
}

describe('ingestScanResult', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('first-ever scan is a suppressed baseline', () => {
		const { id } = makeOverlay(db);
		const overlay = getOverlay(db, id);
		const out = ingestScanResult(db, overlay, {
			chainHeight: 3_100_010, scannedHeight: 3_100_010,
			incoming: [note(), note({ txHash: 'tx-b' })]
		}, { nowMs: NOW });
		expect(out.inserted).toBe(2);
		expect(out.suppressed).toBe(2);
		expect(listEventsSince(db, id)).toHaveLength(0); // nothing visible
		expect(getOverlay(db, id).last_scanned_height).toBe(3_100_010);
	});

	test('first scan keeps donations above the creation baseline, suppresses pre-existing notes', () => {
		const { id } = makeOverlay(db, { baselineHeight: 3_100_000 });
		const out = ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_010, scannedHeight: 3_100_010,
			incoming: [
				note({ txHash: 'at-tip', blockHeight: 3_100_000 }), // == baseline → pre-existing
				note({ txHash: 'older', blockHeight: 3_099_500 }),  // below baseline → pre-existing
				note({ txHash: 'gift', blockHeight: 3_100_005 })    // above baseline → donation
			]
		}, { nowMs: NOW });
		expect(out.inserted).toBe(3);
		expect(out.suppressed).toBe(2);
		const feed = listEventsSince(db, id);
		expect(feed).toHaveLength(1);
		expect(feed[0].tx_hash).toBe('gift');
	});

	test('first scan keeps an unmined donation (null height) even with a baseline', () => {
		const { id } = makeOverlay(db, { baselineHeight: 3_100_000 });
		const out = ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_000, scannedHeight: 3_100_000,
			incoming: [note({ txHash: 'mempool', blockHeight: null })]
		}, { nowMs: NOW });
		expect(out.suppressed).toBe(0);
		expect(listEventsSince(db, id)).toHaveLength(1);
	});

	test('with no baseline recorded, the first scan still suppresses every note (legacy rule)', () => {
		const { id } = makeOverlay(db); // no baselineHeight
		const out = ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_010, scannedHeight: 3_100_010,
			incoming: [note({ txHash: 'a' }), note({ txHash: 'b', blockHeight: 3_100_009 })]
		}, { nowMs: NOW });
		expect(out.suppressed).toBe(2);
		expect(listEventsSince(db, id)).toHaveLength(0);
	});

	test('subsequent scans surface new notes; re-scanned notes dedupe', () => {
		const { id } = makeOverlay(db);
		ingestScanResult(db, getOverlay(db, id), { chainHeight: 10, scannedHeight: 3_100_000, incoming: [note()] }, { nowMs: NOW });
		const out = ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_051, scannedHeight: 3_100_051,
			incoming: [note(), note({ txHash: 'tx-new', blockHeight: 3_100_050, memo: 'hi' })]
		}, { nowMs: NOW });
		expect(out.inserted).toBe(1);
		const feed = listEventsSince(db, id);
		expect(feed).toHaveLength(1);
		expect(feed[0].memo).toBe('hi');
		expect(feed[0].status).toBe('seen'); // 2 confs < default 3
	});

	test('notes below minZec are ignored after the baseline', () => {
		const { id } = makeOverlay(db, { minZatoshi: '10000000' }); // 0.1 ZEC
		ingestScanResult(db, getOverlay(db, id), { chainHeight: 1, scannedHeight: 3_100_000, incoming: [] }, { nowMs: NOW });
		const out = ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_100, scannedHeight: 3_100_100,
			incoming: [note({ amountAtomic: '9999999' }), note({ txHash: 'big', amountAtomic: '10000000' })]
		}, { nowMs: NOW });
		expect(out.inserted).toBe(1);
		expect(listEventsSince(db, id)[0].tx_hash).toBe('big');
	});

	test('confirmation tracking flips seen → confirmed at the display threshold', () => {
		const { id } = makeOverlay(db);
		ingestScanResult(db, getOverlay(db, id), { chainHeight: 1, scannedHeight: 3_099_999, incoming: [] }, { nowMs: NOW });
		ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_000, scannedHeight: 3_100_000,
			incoming: [note({ blockHeight: 3_100_000 })] // 1 conf
		}, { nowMs: NOW });
		expect(listEventsSince(db, id)[0].status).toBe('seen');
		ingestScanResult(db, getOverlay(db, id), {
			chainHeight: 3_100_000 + OVERLAY_CONFIRMATIONS_DEFAULT - 1, // = threshold confs
			scannedHeight: 3_100_002,
			incoming: []
		}, { nowMs: NOW });
		expect(listEventsSince(db, id)[0].status).toBe('confirmed');
	});
});

describe('scanBoundsForOverlay', () => {
	test('fresh overlay starts at birthday (or NU6 fallback)', () => {
		expect(scanBoundsForOverlay({ birthday_height: 3_200_000, last_scanned_height: null }))
			.toEqual({ birthdayHeight: 3_200_000 });
		expect(scanBoundsForOverlay({ birthday_height: null, last_scanned_height: null }))
			.toEqual({ birthdayHeight: 3_042_000 });
	});

	test('long-lived overlay scans from last height minus the reorg margin, floored at birthday', () => {
		expect(scanBoundsForOverlay({ birthday_height: 3_200_000, last_scanned_height: 3_300_000 }))
			.toEqual({ birthdayHeight: 3_298_800 });
		expect(scanBoundsForOverlay({ birthday_height: 3_299_500, last_scanned_height: 3_300_000 }))
			.toEqual({ birthdayHeight: 3_299_500 });
	});

	test('baseline_height lifts a stale wallet birthday to just below the creation tip', () => {
		expect(scanBoundsForOverlay({ birthday_height: 3_042_000, last_scanned_height: null, baseline_height: 3_412_300 }))
			.toEqual({ birthdayHeight: 3_411_100 });
		// Explicit birthday above the baseline still wins.
		expect(scanBoundsForOverlay({ birthday_height: 3_413_000, last_scanned_height: null, baseline_height: 3_412_300 }))
			.toEqual({ birthdayHeight: 3_413_000 });
		// Pre-migration rows (no baseline) keep the old behaviour.
		expect(scanBoundsForOverlay({ birthday_height: 3_200_000, last_scanned_height: null, baseline_height: null }))
			.toEqual({ birthdayHeight: 3_200_000 });
		// Resumed overlays still advance from last_scanned_height.
		expect(scanBoundsForOverlay({ birthday_height: 3_042_000, last_scanned_height: 3_413_500, baseline_height: 3_412_300 }))
			.toEqual({ birthdayHeight: 3_412_300 });
	});
});

describe('runOverlayTick', () => {
	let db;
	beforeEach(() => { db = openDb(); });

	test('decrypts, scans, ingests and reports a summary', async () => {
		const { id } = makeOverlay(db);
		const seenKeys = [];
		const summary = await runOverlayTick({
			db,
			decryptViewKey: (ct) => { seenKeys.push(ct); return 'uview1plain'; },
			scanWallet: async ({ viewKey }) => {
				expect(viewKey).toBe('uview1plain');
				return { chainHeight: 3_100_005, scannedHeight: 3_100_005, incoming: [note()] };
			},
			now: () => NOW,
			logger: silentLog
		});
		expect(seenKeys).toEqual(['ct:ufvk']);
		expect(summary.overlays_scanned).toBe(1);
		expect(summary.events_inserted).toBe(1);
		expect(summary.events_suppressed).toBe(1); // baseline tick
		expect(getOverlay(db, id).last_polled_at_ms).toBe(NOW);
	});

	test('day billing runs and an out-of-credit overlay is skipped, not scanned', async () => {
		const { id } = makeOverlay(db);
		// Meter last billed 3 days ago on a tiny balance → drains to zero.
		updateOverlayState(db, id, { credit_atomic: 10_000, credit_last_billed_ms: NOW - 3 * 86_400_000 });
		let scanned = 0;
		const summary = await runOverlayTick({
			db,
			decryptViewKey: () => 'uview1plain',
			scanWallet: async () => { scanned += 1; return { chainHeight: 1, scannedHeight: 1, incoming: [] }; },
			now: () => NOW,
			logger: silentLog
		});
		expect(scanned).toBe(0);
		expect(summary.overlays_out_of_credit).toBe(1);
		expect(summary.credit_billed_atomic).toBe(300_000); // 3 days at $0.10/day accrued
		expect(getOverlay(db, id).credit_atomic).toBe(0); // balance floored at zero
	});

	test('a failing scan is recorded and does not break the tick', async () => {
		makeOverlay(db);
		const summary = await runOverlayTick({
			db,
			decryptViewKey: () => 'uview1plain',
			scanWallet: async () => { throw new Error('NFPT down'); },
			now: () => NOW,
			logger: silentLog
		});
		expect(summary.scan_errors).toBe(1);
		expect(summary.overlays_scanned).toBe(0);
	});
});

describe('makeOverlayCreditApplier', () => {
	test('credits an overlay by id (US cents → atomic USDC)', () => {
		const db = openDb();
		const { id } = makeOverlay(db);
		const apply = makeOverlayCreditApplier(db);
		const out = apply({ watchId: id, usdCents: 200 });
		expect(out.ok).toBe(true);
		expect(getOverlay(db, id).credit_atomic).toBe(1_000_000 + 2_000_000);
		expect(apply({ watchId: 'ov_missing', usdCents: 200 }).reason).toBe('not_found');
		expect(apply({ watchId: id, usdCents: 0 }).reason).toBe('invalid_amount');
	});
});
