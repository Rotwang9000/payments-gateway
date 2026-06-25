#!/usr/bin/env node
// Zcash shield-amount index poller.
//
// Walks a slice of the Zcash chain (via the operator's zebra node) into the
// shield-amount histogram so the amount-privacy advisor can surface popular
// blend-in amounts and "N others used this" counts from real on-chain data.
//
// Incremental + resumable: it records a cursor and advances at most
// ZEC_SHIELD_INDEX_MAX_BLOCKS_PER_TICK blocks per run, so a systemd .timer
// (every ~1–2 min) steadily catches up to the tip and then tracks it. Reads
// ONLY public transparent value balances — no view keys, no identities.
//
// Enabled by ZEC_SHIELD_INDEX_ENABLED=1. Start height:
//   • ZEC_SHIELD_INDEX_FROM_HEIGHT>0 → index from there forward.
//   • else (and no cursor yet) → seed at tip − ZEC_SHIELD_INDEX_WINDOW_BLOCKS,
//     a rolling recent window (recent behaviour is the most useful crowd).

import config from '../src/config.js';
import {
	openShieldIndexDb,
	getCursor,
	fetchTipHeight,
	scanShieldAmounts,
	statsSnapshot
} from '../src/zcash-shield-index.js';

// getblock verbosity 2 returns a whole block of verbose txs — larger than an
// atomic /v1/q fact, so give it more headroom than CHAIN_RPC_TIMEOUT_MS.
const SCAN_RPC_TIMEOUT_MS = 30_000;

function logJson(level, obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...obj })}\n`);
}

async function main() {
	if (!config.zecShieldIndexEnabled) {
		logJson('info', { event: 'zec_shield_index_skipped', reason: 'ZEC_SHIELD_INDEX_ENABLED not set' });
		process.exit(0);
	}
	const rpcUrl = config.zcashRpcUrl;
	if (!rpcUrl) {
		logJson('warn', { event: 'zec_shield_index_skipped', reason: 'ZCASH_RPC_URL not configured' });
		process.exit(0);
	}

	const db = openShieldIndexDb(config.zecShieldIndexDbPath);
	const deps = { fetchImpl: globalThis.fetch, timeoutMs: SCAN_RPC_TIMEOUT_MS };

	try {
		const cursor = getCursor(db);
		let fromHeight = config.zecShieldIndexFromHeight;
		// Seed a rolling window the first time when no explicit start is set.
		if ((!fromHeight || fromHeight <= 0) && cursor.indexedThrough == null) {
			const tip = await fetchTipHeight(rpcUrl, { deps });
			fromHeight = Math.max(0, tip - config.zecShieldIndexWindowBlocks);
			logJson('info', { event: 'zec_shield_index_seed', tip, window: config.zecShieldIndexWindowBlocks, from: fromHeight });
		}

		const summary = await scanShieldAmounts({
			rpcUrl,
			db,
			fromHeight: fromHeight > 0 ? fromHeight : 0,
			maxBlocks: config.zecShieldIndexMaxBlocksPerTick,
			minBoundaryZat: config.zecShieldIndexMinBoundaryZat,
			deps
		});

		logJson('info', { event: 'zec_shield_index_tick', ...summary, stats: statsSnapshot(db) });
		process.exit(0);
	} catch (err) {
		logJson('error', { event: 'zec_shield_index_failed', message: err?.message ?? String(err), stack: err?.stack });
		process.exit(2);
	} finally {
		try { db.close(); } catch { /* ignore */ }
	}
}

main().catch((err) => {
	logJson('error', { event: 'zec_shield_index_fatal', message: err?.message ?? String(err), stack: err?.stack });
	process.exit(3);
});
