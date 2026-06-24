// Paid unlock — native receive reconciler.
//
// The pay-to-unlock sibling of the credit top-up poller. On each tick it
// takes the SAME view-key wallet scan the top-up poller already runs and
// matches inbound Monero/Zcash payments to open unlock ORDERS, flipping a
// pending order to `paid` once its payment is buried under enough
// confirmations. The buyer then claims the sealed secret.
//
// We reuse the top-up poller's pure matchers (matchIncoming /
// computeConfirmations) verbatim so native detection behaves identically to
// the rest of the gateway: Monero matches on the unique exact amount, Zcash on
// the memo token. The one extra rule here is fixed-price: an unlock is a
// purchase, not a balance top-up, so a memo-matched Zcash payment must also
// cover the full quoted amount before it unlocks (no pro-rata).
//
// Dependency-injected (`scan(chain)`), so the state machine is unit-tested
// against a :memory: DB with zero network and zero NFPT — see
// test/paid-unlock-poller.test.js.

import { matchIncoming, computeConfirmations } from 'viewkey-watch/crypto-recv-poller';

import {
	listMatchableOrders,
	markOrderPaid,
	markOrderSeen,
	expireStaleOrders
} from './paid-unlock-store.js';

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

function safeBig(v) {
	try { return BigInt(v); }
	catch { return null; }
}

/**
 * Does a matched payment cover the order's full quoted amount? Monero is
 * already exact (matchIncoming requires amount equality); Zcash matches on the
 * memo alone, so we enforce "received ≥ expected" here. Missing/garbled
 * amounts fail closed (never unlock on a number we can't trust).
 */
export function paymentCoversOrder(order, payment) {
	const expected = safeBig(order.expected_atomic);
	const received = safeBig(payment?.amountAtomic);
	if (expected === null || expected <= 0n) return false;
	if (received === null) return false;
	return received >= expected;
}

/**
 * One reconcile pass over open unlock orders.
 *
 * deps:
 *   - unlockDb        the paid-unlock SQLite handle
 *   - chains          e.g. ['monero','zcash'] — only configured chains
 *   - scan(chain)     async -> { chainHeight, incoming: [{amountAtomic, memo, txHash, blockHeight}] }
 *                     (share the top-up poller's memoised scan to avoid a 2nd NFPT walk)
 *   - confirmations   { monero: 10, zcash: 8 } — burial required before unlock
 *   - now()           clock (testable)
 *   - logger          pino-like (info/warn/error)
 *
 * Returns a summary suitable for structured logging/metrics.
 */
export async function runUnlockRecvReconcile({
	unlockDb,
	chains,
	scan,
	confirmations = {},
	now = () => Date.now(),
	logger = NOOP_LOGGER
}) {
	if (!unlockDb) throw new TypeError('runUnlockRecvReconcile: unlockDb is required');
	if (typeof scan !== 'function') throw new TypeError('runUnlockRecvReconcile: scan(chain) must be a function');

	const chainList = Array.isArray(chains) ? chains : [];
	const summary = { matched: 0, paid: 0, confirming: 0, underpaid: 0, expired: 0, errors: 0, byChain: {} };

	for (const chain of chainList) {
		const cs = { scanned: 0, matched: 0, paid: 0, confirming: 0, underpaid: 0, errors: 0 };
		let scanResult;
		try {
			scanResult = await scan(chain);
		}
		catch (err) {
			cs.errors += 1; summary.errors += 1;
			logger.warn({ chain, err: err?.message ?? String(err) }, 'paid-unlock: scan failed');
			summary.byChain[chain] = cs;
			continue;
		}
		const incoming = Array.isArray(scanResult?.incoming) ? scanResult.incoming : [];
		const chainHeight = scanResult?.chainHeight ?? 0;
		const required = Number(confirmations?.[chain] ?? 0);
		cs.scanned = incoming.length;

		for (const order of listMatchableOrders(unlockDb, { chain })) {
			const payment = matchIncoming(chain, order, incoming);
			if (!payment) continue;
			cs.matched += 1; summary.matched += 1;

			if (!paymentCoversOrder(order, payment)) {
				// Memo matched but underpaid: surface the sighting, never unlock.
				markOrderSeen(unlockDb, order.id, { seenAtomic: payment.amountAtomic, txid: payment.txHash, nowMs: now() });
				cs.underpaid += 1; summary.underpaid += 1;
				logger.warn({ orderId: order.id, chain, seen: payment.amountAtomic, want: order.expected_atomic }, 'paid-unlock: underpaid — awaiting top-up');
				continue;
			}

			const confs = computeConfirmations(chainHeight, payment.blockHeight);
			if (confs < required) {
				markOrderSeen(unlockDb, order.id, { seenAtomic: payment.amountAtomic, txid: payment.txHash, nowMs: now() });
				cs.confirming += 1; summary.confirming += 1;
				continue;
			}

			let res;
			try { res = markOrderPaid(unlockDb, order.id, { txid: payment.txHash, seenAtomic: payment.amountAtomic, nowMs: now() }); }
			catch (err) { res = { ok: false, reason: err?.message ?? String(err) }; }

			if (res?.ok) {
				cs.paid += 1; summary.paid += 1;
				logger.info({ orderId: order.id, listingId: order.listing_id, chain, txHash: payment.txHash }, 'paid-unlock: order paid');
			}
			else {
				cs.errors += 1; summary.errors += 1;
				logger.error({ orderId: order.id, reason: res?.reason, txHash: payment.txHash }, 'paid-unlock: confirmed payment but mark-paid failed — reconcile manually');
			}
		}
		summary.byChain[chain] = cs;
	}

	try { summary.expired = expireStaleOrders(unlockDb, now()); }
	catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'paid-unlock: expire sweep failed'); }

	return summary;
}
