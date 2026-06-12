#!/usr/bin/env node
// Standalone private-watch poller driver.
//
// Walks every active watch, asks NFPT for current balance state, fires
// signed webhooks on change, then exits. Drive it from a systemd .timer
// every 2-3 minutes (inside NFPT's 5-minute scanner-idle window).
//
// Must-have env:
//   PRIVATE_WATCH_ENCRYPTION_KEY  - 64-hex master key (decrypts view keys)
//   PRIVATE_WATCH_DB / GATEWAY_DB - path to the watch SQLite DB
// Optional: NFPT_BASE_URL, NFPT_API_KEY, PRIVATE_WATCH_WEBHOOK_TIMEOUT_MS,
//   GATEWAY_WEBHOOK_SIGNATURE_HEADER (header prefix for outbound webhooks).

import config from '../src/config.js';
import { openWatchDb } from 'viewkey-watch/private-watch-store';
import { parseMasterKey } from 'viewkey-watch/private-watch-crypto';
import { createNfptClient } from 'viewkey-watch/private-watch-nfpt';
import { runPollerTick } from 'viewkey-watch/private-watch-poller';

function logJson(level, obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...obj })}\n`);
}

function flatten(obj) {
	return obj && typeof obj === 'object' ? obj : {};
}

function headerPrefixFrom(signatureHeader) {
	return String(signatureHeader || 'X-Payment-Signature').replace(/-signature$/i, '').toLowerCase();
}

async function main() {
	if (!config.privateWatchEncryptionKey) {
		logJson('error', { event: 'private_watch_poller_skipped', reason: 'PRIVATE_WATCH_ENCRYPTION_KEY not set' });
		process.exit(0);
	}
	let masterKey;
	try { masterKey = parseMasterKey(config.privateWatchEncryptionKey); }
	catch (err) {
		logJson('error', { event: 'private_watch_poller_skipped', reason: `parseMasterKey: ${err?.message ?? err}` });
		process.exit(1);
	}
	const db = openWatchDb(config.privateWatchDbPath);
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
	try {
		const summary = await runPollerTick({
			db,
			masterKey,
			nfptClient,
			webhookTimeoutMs: config.privateWatchWebhookTimeoutMs,
			responseMaxBytes: config.privateWatchResponseMaxBytes,
			headerPrefix: headerPrefixFrom(config.webhookSignatureHeader),
			userAgent: `${String(config.serviceName || 'PaymentsGateway').replace(/\s+/g, '')}-PrivateWatch/1.0`,
			logger
		});
		logJson('info', { event: 'private_watch_tick', ...summary });
		process.exit(0);
	}
	catch (err) {
		logJson('error', { event: 'private_watch_tick_failed', message: err?.message ?? String(err), stack: err?.stack });
		process.exit(2);
	}
}

main().catch((err) => {
	logJson('error', { event: 'private_watch_poller_fatal', message: err?.message ?? String(err), stack: err?.stack });
	process.exit(3);
});
