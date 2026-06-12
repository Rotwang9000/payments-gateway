// Outbound co-signed ZEC payments ("make" side of the gateway).
//
// The gateway holds ONE Orchard FROST share from a WINBIT32 `.wult` export.
// A payment is prepared headlessly (scan the vault UFVK → select notes →
// build a PCZT server-side), then a WB32COSIGN pairing QR is issued. The
// HUMAN approval step IS the co-signature: nothing broadcasts until a person
// scans the QR with their cosigner (WINBIT32 cosign.exe / the standalone
// cosigner) and completes the two-round FROST ceremony with their own share.
//
// This module is pure orchestration + state: all crypto/chain I/O arrives
// via injected deps (see make-payment-deps.js for the production wiring to
// @winbit32/wallet-kit), so it tests without WASM, files, or a network.

import { randomUUID } from 'node:crypto';

/** Payment lifecycle states (single forward path). */
export const PAYMENT_STATUSES = Object.freeze([
	'preparing',          // scanning notes / building the PCZT
	'awaiting_cosigner',  // QR issued; ceremony open, human not done yet
	'proving',            // signatures collected; server proving/finalising
	'broadcasting',       // signed tx submitted to the network
	'completed',          // txid obtained
	'failed'              // any step errored (or the ceremony timed out)
]);

const ACTIVE_STATUSES = new Set(['preparing', 'awaiting_cosigner', 'proving', 'broadcasting']);
/** Keep at most this many finished payment records (oldest pruned first). */
const MAX_RECORDS = 100;
/** How long createPayment waits for the pairing QR before giving up. */
const QR_READY_TIMEOUT_MS = 30_000;
/** Zcash memo field limit (bytes). */
const MAX_MEMO_BYTES = 512;
const ZATOSHIS_PER_ZEC = 100_000_000;

const ZEC_UA_PREFIX = 'u1';

/** Map a kit progress phase string onto a coarse lifecycle status. */
export function progressToStatus(phase) {
	const p = String(phase || '').toLowerCase();
	if (p.includes('submitting signatures') || p.includes('proving')) return 'proving';
	if (p.includes('broadcasting')) return 'broadcasting';
	return null; // phases before/within the ceremony don't move the status
}

/**
 * Clickable cosigner deep link for a WB32COSIGN pairing payload. The
 * standalone cosigner page consumes the payload from its URL hash, so an
 * agent can hand the human a link instead of (or as well as) a QR code.
 * Returns null when either part is missing.
 */
export function buildCosignDeepLink(baseUrl, qrPayload) {
	if (!baseUrl || !qrPayload || typeof qrPayload !== 'string') return null;
	return `${String(baseUrl).replace(/#.*$/, '')}#${encodeURIComponent(qrPayload)}`;
}

/**
 * Build the make-payment service.
 *
 * @param {object} opts
 * @param {object} opts.config  Gateway config (make-payment keys + caps).
 * @param {object} opts.deps    Injected I/O:
 *   - prepareWallet(): Promise<{ bundle, wasm, cosignConfig, scanner, ufvk,
 *       unifiedAddress, minSigners, maxSigners }>  (loads share + WASM once)
 *   - runSend(params): Promise<{ txid, signedPczt }>  (the kit's
 *       runHeadlessCosignSend, or a fake in tests)
 *   - now(): epoch ms (optional; tests)
 */
export function createMakePaymentService({ config, deps }) {
	if (!deps?.prepareWallet || !deps?.runSend) {
		throw new Error('make-payment service needs prepareWallet + runSend deps');
	}
	const now = deps.now ?? (() => Date.now());
	const payments = new Map(); // paymentId -> record
	let walletPromise = null;   // lazy, shared across payments

	const enabled = () => Boolean(config.makePaymentWultPath);

	const ensureWallet = () => {
		if (!walletPromise) {
			walletPromise = deps.prepareWallet().catch((err) => {
				walletPromise = null; // allow retry after a transient failure
				throw err;
			});
		}
		return walletPromise;
	};

	const activeCount = () => {
		let n = 0;
		for (const p of payments.values()) if (ACTIVE_STATUSES.has(p.status)) n++;
		return n;
	};

	const prune = () => {
		if (payments.size <= MAX_RECORDS) return;
		const finished = [...payments.values()]
			.filter((p) => !ACTIVE_STATUSES.has(p.status))
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const p of finished) {
			if (payments.size <= MAX_RECORDS) break;
			payments.delete(p.id);
		}
	};

	const validateRequest = ({ toAddress, amountZec, memo }) => {
		if (typeof toAddress !== 'string' || !toAddress.startsWith(ZEC_UA_PREFIX)) {
			throw new Error('toAddress must be a Zcash unified address (u1…).');
		}
		const amount = Number(amountZec);
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error('amountZec must be a positive number.');
		}
		const maxZec = Number(config.makePaymentMaxZec) || 0;
		if (maxZec > 0 && amount > maxZec) {
			throw new Error(`amountZec exceeds this gateway's per-payment cap of ${maxZec} ZEC.`);
		}
		if (memo !== undefined && memo !== null) {
			if (typeof memo !== 'string') throw new Error('memo must be a string.');
			if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
				throw new Error(`memo exceeds ${MAX_MEMO_BYTES} bytes.`);
			}
		}
		return { toAddress, amountZat: Math.round(amount * ZATOSHIS_PER_ZEC), memo: memo || undefined };
	};

	/** Public, JSON-safe view of a payment record. */
	const view = (p) => ({
		paymentId: p.id,
		status: p.status,
		chain: 'zcash',
		toAddress: p.toAddress,
		amountZec: p.amountZat / ZATOSHIS_PER_ZEC,
		memo: p.memo ?? null,
		qrPayload: p.qrPayload ?? null,
		cosignUrl: buildCosignDeepLink(config.cosignAppUrl, p.qrPayload),
		progress: p.progress ?? null,
		txid: p.txid ?? null,
		error: p.error ?? null,
		createdAt: new Date(p.createdAt).toISOString(),
		updatedAt: new Date(p.updatedAt).toISOString()
	});

	const touch = (p, patch) => {
		Object.assign(p, patch, { updatedAt: now() });
	};

	/** Drive one payment to completion in the background. */
	const runPayment = async (p, wallet) => {
		try {
			const result = await deps.runSend({
				config: wallet.cosignConfig,
				wasm: wallet.wasm,
				bundle: wallet.bundle,
				ufvk: wallet.ufvk,
				unifiedAddress: wallet.unifiedAddress,
				scanner: wallet.scanner,
				scannerApiKey: config.nfptApiKey || undefined,
				toAddress: p.toAddress,
				amountZat: p.amountZat,
				memoText: p.memo,
				...(config.makePaymentBirthdayHeight > 0
					? { birthdayHeight: config.makePaymentBirthdayHeight }
					: {}),
				onQrReady: (qrPayload) => {
					touch(p, { qrPayload, status: 'awaiting_cosigner' });
					p.resolveQrReady?.(qrPayload);
				},
				callbacks: {
					onProgress: (phase) => {
						const next = progressToStatus(phase);
						touch(p, { progress: phase, ...(next ? { status: next } : {}) });
					}
				}
			});
			touch(p, { status: 'completed', txid: result.txid });
		} catch (err) {
			touch(p, { status: 'failed', error: err?.message ?? String(err) });
			p.rejectQrReady?.(err);
		}
	};

	return {
		enabled,

		/** Free metadata for agents: where money can be sent from/to, caps, relay. */
		async info() {
			if (!enabled()) {
				return {
					enabled: false,
					reason: 'MAKE_PAYMENT_WULT_PATH not configured on this server.'
				};
			}
			const base = {
				enabled: true,
				chain: 'zcash',
				network: config.makePaymentNetwork,
				relayUrl: config.makePaymentRelayUrl,
				cosignAppUrl: config.cosignAppUrl || null,
				maxAmountZec: Number(config.makePaymentMaxZec) || null,
				maxPending: config.makePaymentMaxPending,
				approval: 'Every payment must be co-signed by a human: send them the cosignUrl link (or show the WB32COSIGN QR) and they approve in their WINBIT32 cosigner. The gateway share alone cannot spend.'
			};
			try {
				const wallet = await ensureWallet();
				return {
					...base,
					vaultAddress: wallet.unifiedAddress,
					threshold: `${wallet.minSigners}-of-${wallet.maxSigners}`
				};
			} catch (err) {
				return { ...base, walletError: err?.message ?? String(err) };
			}
		},

		/**
		 * Start a payment. Resolves once the pairing QR exists (or the
		 * pipeline failed first), so the agent can show the QR immediately.
		 */
		async createPayment(request) {
			if (!enabled()) {
				throw new Error('make_payment is not configured on this server (MAKE_PAYMENT_WULT_PATH).');
			}
			const { toAddress, amountZat, memo } = validateRequest(request);
			if (activeCount() >= config.makePaymentMaxPending) {
				throw new Error(`Too many pending payments (max ${config.makePaymentMaxPending}); wait for one to finish.`);
			}

			const wallet = await ensureWallet();

			const p = {
				id: randomUUID(),
				status: 'preparing',
				toAddress,
				amountZat,
				memo,
				createdAt: now(),
				updatedAt: now()
			};
			const qrReady = new Promise((resolve, reject) => {
				p.resolveQrReady = resolve;
				p.rejectQrReady = reject;
			});
			payments.set(p.id, p);
			prune();

			const running = runPayment(p, wallet);
			// Surface unexpected runner crashes in logs; state already moved
			// to failed inside runPayment.
			running.catch((err) => console.error('[make-payment] runner crashed:', err));

			const timeout = new Promise((resolve) => {
				const t = setTimeout(() => resolve(null), QR_READY_TIMEOUT_MS);
				if (typeof t.unref === 'function') t.unref();
			});
			try {
				await Promise.race([qrReady, timeout]);
			} catch {
				// fall through — record carries the failure
			}
			return view(p);
		},

		/** Poll a payment by id. */
		getPayment(paymentId) {
			const p = payments.get(String(paymentId || ''));
			return p ? view(p) : null;
		}
	};
}

export default createMakePaymentService;
