// Unit tests for the paid-unlock native receive reconciler.
//
// Drives the full match → confirm → mark-paid state machine against an
// in-memory DB with a fake scan — zero network, zero NFPT — exactly like the
// top-up poller's tests it mirrors.

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
	openUnlockDb,
	createListing,
	createOrder,
	getOrder
} from '../src/paid-unlock-store.js';
import { runUnlockRecvReconcile, paymentCoversOrder } from '../src/paid-unlock-poller.js';

function seedListing(db, overrides = {}) {
	return createListing(db, {
		title: 'Test listing',
		priceUsdCents: 500,
		payChains: ['zcash', 'monero'],
		secretCt: 'sealed-secret-ciphertext',
		claimMax: 3,
		ttlSec: 3600,
		nowMs: Date.now(),
		...overrides
	});
}

function seedOrder(db, listingId, overrides = {}) {
	const res = createOrder(db, {
		listingId,
		chain: 'zcash',
		recvAddress: 'u1recv',
		memo: 'WB32-ULK-abc123',
		expectedAtomic: '100000000', // 1 ZEC in zatoshi
		claimsMax: 3,
		ttlSec: 1800,
		nowMs: Date.now(),
		...overrides
	});
	expect(res.ok).toBe(true);
	return res.id;
}

// scan(chain) contract: { chainHeight, incoming: [{amountAtomic, memo, txHash, blockHeight}] }
function makeScan(byChain) {
	return async (chain) => byChain[chain] ?? { chainHeight: 0, incoming: [] };
}

describe('paymentCoversOrder', () => {
	test('exact and over payments cover; under does not', () => {
		const order = { expected_atomic: '1000' };
		expect(paymentCoversOrder(order, { amountAtomic: '1000' })).toBe(true);
		expect(paymentCoversOrder(order, { amountAtomic: '1500' })).toBe(true);
		expect(paymentCoversOrder(order, { amountAtomic: '999' })).toBe(false);
	});

	test('missing/garbled amounts fail closed', () => {
		const order = { expected_atomic: '1000' };
		expect(paymentCoversOrder(order, {})).toBe(false);
		expect(paymentCoversOrder(order, { amountAtomic: 'not-a-number' })).toBe(false);
		expect(paymentCoversOrder({ expected_atomic: '0' }, { amountAtomic: '1000' })).toBe(false);
	});
});

describe('runUnlockRecvReconcile', () => {
	let db;
	let listingId;

	beforeEach(() => {
		db = openUnlockDb(':memory:');
		listingId = seedListing(db).id;
	});

	test('Zcash: memo + full amount + enough confirmations → paid', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-zzz', expectedAtomic: '100000000' });
		const scan = makeScan({
			zcash: { chainHeight: 100, incoming: [{ amountAtomic: '100000000', memo: 'WB32-ULK-zzz', txHash: 'ztx1', blockHeight: 91 }] }
		});
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		expect(summary.paid).toBe(1);
		expect(summary.matched).toBe(1);
		const row = getOrder(db, orderId);
		expect(row.status).toBe('paid');
		expect(row.paid_txid).toBe('ztx1');
		expect(row.seen_atomic).toBe('100000000');
	});

	test('Monero: exact amount + enough confirmations → paid', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'monero', memo: null, expectedAtomic: '1230000000001' });
		const scan = makeScan({
			monero: { chainHeight: 200, incoming: [{ amountAtomic: '1230000000001', memo: null, txHash: 'xtx1', blockHeight: 185 }] }
		});
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['monero'], scan, confirmations: { monero: 10 } });
		expect(summary.paid).toBe(1);
		expect(getOrder(db, orderId).status).toBe('paid');
	});

	test('matched but too few confirmations → stays pending, records the sighting', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-conf', expectedAtomic: '100000000' });
		const scan = makeScan({
			zcash: { chainHeight: 92, incoming: [{ amountAtomic: '100000000', memo: 'WB32-ULK-conf', txHash: 'zt', blockHeight: 91 }] }
		});
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		expect(summary.confirming).toBe(1);
		expect(summary.paid).toBe(0);
		const row = getOrder(db, orderId);
		expect(row.status).toBe('pending');
		expect(row.seen_atomic).toBe('100000000');
	});

	test('Zcash memo matches but underpaid → never unlocks', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-under', expectedAtomic: '100000000' });
		const scan = makeScan({
			zcash: { chainHeight: 100, incoming: [{ amountAtomic: '50000000', memo: 'WB32-ULK-under', txHash: 'zt', blockHeight: 80 }] }
		});
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		expect(summary.underpaid).toBe(1);
		expect(summary.paid).toBe(0);
		expect(getOrder(db, orderId).status).toBe('pending');
	});

	test('no matching payment → order untouched', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-none', expectedAtomic: '100000000' });
		const scan = makeScan({
			zcash: { chainHeight: 100, incoming: [{ amountAtomic: '100000000', memo: 'SOMEONE-ELSE', txHash: 'zt', blockHeight: 80 }] }
		});
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		expect(summary.matched).toBe(0);
		expect(getOrder(db, orderId).status).toBe('pending');
	});

	test('already-paid orders are not re-matched (listMatchable only returns pending)', async () => {
		const orderId = seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-dup', expectedAtomic: '100000000' });
		const scan = makeScan({
			zcash: { chainHeight: 100, incoming: [{ amountAtomic: '100000000', memo: 'WB32-ULK-dup', txHash: 'zt', blockHeight: 80 }] }
		});
		await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		const second = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan, confirmations: { zcash: 8 } });
		expect(second.matched).toBe(0);
		expect(getOrder(db, orderId).status).toBe('paid');
	});

	test('expires stale pending orders and reports the count', async () => {
		// An order already past its deadline.
		seedOrder(db, listingId, { chain: 'zcash', memo: 'WB32-ULK-old', expectedAtomic: '100000000', ttlSec: -1, nowMs: Date.now() - 1000 });
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash'], scan: makeScan({}), confirmations: { zcash: 8 } });
		expect(summary.expired).toBeGreaterThanOrEqual(1);
	});

	test('scan failure for a chain is contained (counts an error, others proceed)', async () => {
		const scan = async (chain) => {
			if (chain === 'zcash') throw new Error('nfpt down');
			return { chainHeight: 200, incoming: [] };
		};
		const summary = await runUnlockRecvReconcile({ unlockDb: db, chains: ['zcash', 'monero'], scan, confirmations: {} });
		expect(summary.errors).toBe(1);
		expect(summary.byChain.monero).toBeDefined();
	});
});
