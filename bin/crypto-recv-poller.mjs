#!/usr/bin/env node
// Standalone privacy-coin receive-poller driver.
//
// On each run it scans OUR receiving wallet(s) through NFPT, matches
// incoming Monero/Zcash payments to open top-up quotes, counts
// confirmations, and credits the matching watch at the quote's locked
// rate. Drive it from a systemd .timer every ~60s.
//
// We hold ONLY the receiving wallet's view key — never the spend key —
// so this process can see payments but can never move funds. That's the
// same no-custody posture the product sells.
//
// A chain is only polled when BOTH its receive address and view key are
// set:  XMR_RECV_ADDRESS + XMR_RECV_VIEW_KEY,
//       ZEC_RECV_ADDRESS + ZEC_RECV_UFVK.
// (Legacy SENESCHAL_* names are still accepted via config.js fallbacks.)

import config from '../src/config.js';
import { openWatchDb } from 'viewkey-watch/private-watch-store';
import { ensureCryptoTopupSchema } from 'viewkey-watch/crypto-topup-store';
import { createNfptClient, scanReceiving } from 'viewkey-watch/private-watch-nfpt';
import { runCryptoRecvTick, makeWatchCreditApplier } from 'viewkey-watch/crypto-recv-poller';
import { parseMasterKey, decryptViewKey } from 'viewkey-watch/private-watch-crypto';
import { openUnlockDb } from '../src/paid-unlock-store.js';
import { runUnlockRecvReconcile } from '../src/paid-unlock-poller.js';
import { ensureDonationOverlaySchema } from '../src/donation-overlay-store.js';
import {
	runOverlayTick,
	makeOverlayScanner,
	makeOverlayCreditApplier
} from '../src/donation-overlay-poller.js';

// NU6 activation height — a safe default Zcash birthday so an unconfigured
// birthday never triggers a multi-hour autoDetect walk.
const ZEC_NU6_BIRTHDAY = 3_042_000;

// Poll NFPT scan-job status every 4 s rather than the library's 1.5 s default:
// this poller runs every ~60 s, so sub-second granularity buys nothing, and
// the slower cadence keeps two chains comfortably under NFPT's per-IP budget.
const NFPT_POLL_INTERVAL_MS = 4_000;

function logJson(level, obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...obj })}\n`);
}

function flatten(obj) {
	return obj && typeof obj === 'object' ? obj : {};
}

function configuredChains() {
	const chains = [];
	if (config.xmrRecvAddress && config.xmrRecvViewKey) chains.push('monero');
	if (config.zecRecvAddress && config.zecRecvUfvk) chains.push('zcash');
	return chains;
}

// Memoise the wallet scan for the lifetime of ONE tick so the top-up poller
// and the paid-unlock reconciler share a single NFPT walk per chain rather
// than hitting the scanner twice. Caches the in-flight promise by chain.
function memoiseScan(scan) {
	const cache = new Map();
	return (chain) => {
		if (!cache.has(chain)) cache.set(chain, scan(chain));
		return cache.get(chain);
	};
}

function makeScan(nfptClient) {
	return async (chain) => {
		if (chain === 'monero') {
			return scanReceiving(nfptClient, {
				chain: 'monero',
				address: config.xmrRecvAddress,
				viewKey: config.xmrRecvViewKey,
				fromHeight: config.xmrRecvFromHeight > 0 ? config.xmrRecvFromHeight : undefined,
				pollIntervalMs: NFPT_POLL_INTERVAL_MS
			});
		}
		return scanReceiving(nfptClient, {
			chain: 'zcash',
			address: config.zecRecvAddress,
			viewKey: config.zecRecvUfvk,
			birthdayHeight: config.zecRecvBirthdayHeight > 0 ? config.zecRecvBirthdayHeight : ZEC_NU6_BIRTHDAY,
			pollIntervalMs: NFPT_POLL_INTERVAL_MS
		});
	};
}

async function main() {
	const chains = configuredChains();
	if (chains.length === 0) {
		logJson('info', { event: 'crypto_recv_poller_skipped', reason: 'no XMR/ZEC receiving wallet configured' });
		process.exit(0);
	}
	const db = openWatchDb(config.privateWatchDbPath);
	ensureCryptoTopupSchema(db);
	ensureDonationOverlaySchema(db);
	const nfptClient = createNfptClient({
		baseUrl: config.nfptBaseUrl,
		apiKey: config.nfptApiKey,
		timeoutMs: config.nfptTimeoutMs,
		fetchImpl: globalThis.fetch
	});
	const logger = {
		info: (obj, msg) => logJson('info', { msg, ...flatten(obj) }),
		warn: (obj, msg) => logJson('warn', { msg, ...flatten(obj) }),
		error: (obj, msg) => logJson('error', { msg, ...flatten(obj) })
	};
	// One scan per chain, shared by the top-up poller and the unlock reconciler.
	const scan = memoiseScan(makeScan(nfptClient));
	const confirmations = {
		monero: config.cryptoTopupXmrConfirmations,
		zcash: config.cryptoTopupZecConfirmations
	};
	// Credit applier: watches first, then donation overlays (their
	// funding quotes share crypto_topup_quotes with the overlay id in
	// the watch_id column).
	const watchApplier = makeWatchCreditApplier(db);
	const overlayApplier = makeOverlayCreditApplier(db);
	const applyCredit = (args) => {
		const res = watchApplier(args);
		if (res.ok || res.reason !== 'not_found') return res;
		return overlayApplier(args);
	};
	try {
		const summary = await runCryptoRecvTick({
			db,
			chains,
			scan,
			applyCredit,
			confirmations,
			logger
		});
		logJson('info', { event: 'crypto_recv_tick', chains, ...summary });

		// Paid-unlock native orders share the same receiving wallet + scan.
		// Only run when the product is enabled (else the DB might not exist).
		if (config.paidUnlockEnabled) {
			let unlockDb = null;
			try { unlockDb = openUnlockDb(config.paidUnlockDbPath); }
			catch (err) {
				logJson('warn', { event: 'paid_unlock_reconcile_skipped', reason: 'open_db_failed', message: err?.message ?? String(err) });
			}
			if (unlockDb) {
				try {
					const unlockSummary = await runUnlockRecvReconcile({ unlockDb, chains, scan, confirmations, logger });
					logJson('info', { event: 'paid_unlock_reconcile', chains, ...unlockSummary });
				}
				catch (err) {
					logJson('error', { event: 'paid_unlock_reconcile_failed', message: err?.message ?? String(err), stack: err?.stack });
				}
				finally { try { unlockDb.close(); } catch { /* ignore */ } }
			}
		}
		// Donation overlays: scan streamer wallets for new incoming notes.
		// Needs the master key to decrypt stored UFVKs.
		if (config.privateWatchEncryptionKey) {
			try {
				const masterKey = parseMasterKey(config.privateWatchEncryptionKey);
				const overlaySummary = await runOverlayTick({
					db,
					decryptViewKey: (ct) => decryptViewKey(ct, masterKey),
					scanWallet: makeOverlayScanner(nfptClient, { pollIntervalMs: NFPT_POLL_INTERVAL_MS }),
					maxOverlaysPerTick: config.overlayMaxPerTick,
					logger
				});
				logJson('info', { event: 'overlay_tick', ...overlaySummary });
			}
			catch (err) {
				logJson('error', { event: 'overlay_tick_failed', message: err?.message ?? String(err), stack: err?.stack });
			}
		}
		else {
			logJson('info', { event: 'overlay_tick_skipped', reason: 'PRIVATE_WATCH_ENCRYPTION_KEY not set' });
		}
		process.exit(0);
	}
	catch (err) {
		logJson('error', { event: 'crypto_recv_tick_failed', message: err?.message ?? String(err), stack: err?.stack });
		process.exit(2);
	}
}

main().catch((err) => {
	logJson('error', { event: 'crypto_recv_poller_fatal', message: err?.message ?? String(err), stack: err?.stack });
	process.exit(3);
});
