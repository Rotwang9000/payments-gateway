// x402 payer relay — spend a prepaid balance at ANY x402 endpoint.
//
// ┌─ STATUS: DORMANT / EXPERIMENTAL — kept off, NOT the product direction ─┐
// │ This is the CUSTODIAL "spend anywhere" relay: we hold the user's       │
// │ prepaid balance AND transmit it to third parties on their instruction. │
// │ That shape is money-transmission-shaped, so it stays dormant (no       │
// │ L2_PRIVATE_KEY on the host ⇒ payX402.enabled=false ⇒ every call 503s). │
// │ The code is retained, tested and working, but Seneschal's ethos is v1: │
// │ sell our OWN x402 services + let the top-up meter buy THOSE.           │
// │                                                                        │
// │ The NON-CUSTODIAL successor lives in winbit32 (which already has        │
// │ Vultisig vaults, Maya/NEAR-Intents ZEC→USDC swaps and an MPC/cosign     │
// │ signer): the user's OWN vault swaps + signs the x402 payment, so there  │
// │ is no custody and no transmission-between-persons by us. Seneschal's    │
// │ role there is just a normal x402 MERCHANT + discovery surface. See      │
// │ /home/rotwang/wbdev/WINBIT32/docs/x402-vault-payer/PLAN.md.            │
// └────────────────────────────────────────────────────────────────────────┘
//
// The "spend anywhere" side of the gateway. A holder of a funded account
// (a private-watch credit meter, topped up in USDC via x402 or in XMR/ZEC
// via the view-key receive poller) can ask the gateway to pay an arbitrary
// x402 resource server on their behalf. The gateway fronts the USDC from its
// own hot float, debits the caller's prepaid balance for (amount + fee), and
// returns the upstream response.
//
// Design:
//   * Brand-neutral + dependency-injected. The actual on-chain payer (a
//     funded Base signer + an x402 client) is injected as `payX402`; this
//     module never touches a private key. The host (e.g. data-api) builds
//     the payer and wires it in. That keeps the signing concern out of the
//     reusable package and makes the whole flow unit-testable with a fake.
//   * Funding source is the existing private-watch credit meter
//     (`private_watches.credit_atomic`), authed by watchId + watchToken —
//     the same account the XMR/ZEC top-ups already credit.
//   * Custody-safe accounting: funds are RESERVED (guarded atomic debit)
//     before the network call and the unused remainder REFUNDED after, so a
//     concurrent call can never overspend a balance and a failed payment
//     costs the caller nothing.
//   * Every attempt writes a `relay_payments` receipt (pending → settled |
//     failed | rejected) carrying the on-chain tx, so spend is auditable and
//     a crash mid-flight is reconcilable against the chain.
//
// Pure helpers (fee maths, SSRF guard, request validation) are exported for
// unit testing without a DB or network.

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const USDC_DECIMALS = 6;
const USDC_ATOMIC_PER_USD = 1_000_000;
const MS_PER_DAY = 86_400_000;
const BPS_DIVISOR = 10_000;

// Conservative v1 defaults. Every one is overridable via the injected config
// (config.relay*), but the module stays safe if a key is missing.
export const RELAY_DEFAULTS = Object.freeze({
	// Most a single relayed call may pay the merchant (excl. our fee).
	maxPerCallAtomic: 1_000_000,        // $1.00
	// Per-account and global daily ceilings (incl. fee). The global one is the
	// float guard: it caps how much USDC the hot wallet can front per UTC day.
	maxPerDayPerWatchAtomic: 10_000_000, // $10.00
	maxPerDayGlobalAtomic: 25_000_000,   // $25.00
	// Fee = max(flat floor, percentage) — covers both tiny and large calls.
	feeFlatAtomic: 1_000,               // $0.001 floor
	feeBps: 500,                        // 5%
	// Settlement network + (optional) asset the merchant challenge must use.
	network: 'eip155:8453',             // Base mainnet
	usdcAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC ('' to skip the check)
	// Upstream response handling.
	responseMaxBytes: 256 * 1024,
	requestTimeoutMs: 20_000,
	// Allow plain http targets (dev only; never in production — tokens/SSRF).
	allowHttp: false
});

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RECEIPT_MAX_RECORDS_NOTE = 'see relay_payments table';

// ── unit conversions ────────────────────────────────────────────────

export function atomicToUsd(atomic) {
	return Math.round(Number(atomic ?? 0)) / USDC_ATOMIC_PER_USD;
}

export function usdToAtomic(usd) {
	return Math.round(Number(usd) * USDC_ATOMIC_PER_USD);
}

// ── fee maths (pure) ────────────────────────────────────────────────

/**
 * Relay fee for a settled amount: the GREATER of a flat floor and a
 * percentage (basis points). Always a non-negative integer atomic value.
 */
export function computeRelayFee(amountAtomic, { flatAtomic, bps } = {}) {
	const amount = Math.max(0, Math.round(Number(amountAtomic) || 0));
	const flat = Math.max(0, Math.round(Number(flatAtomic) || 0));
	const rate = Math.max(0, Math.round(Number(bps) || 0));
	const pct = Math.ceil((amount * rate) / BPS_DIVISOR);
	return Math.max(flat, pct);
}

// ── SSRF guard (pure-ish; DNS lookup is injectable) ─────────────────

/**
 * Is `ip` in a private / loopback / link-local / reserved range? Covers the
 * IPv4 and IPv6 ranges an SSRF would target (RFC1918, loopback, link-local,
 * unique-local, the cloud metadata address, etc.). Unknown / unparseable
 * inputs are treated as private (fail closed).
 */
export function isPrivateIp(ip) {
	const v = isIP(ip);
	if (v === 4) return isPrivateIpv4(ip);
	if (v === 6) return isPrivateIpv6(ip);
	return true; // not an IP → caller shouldn't have passed it; fail closed
}

function isPrivateIpv4(ip) {
	const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 10) return true;                         // 10.0.0.0/8
	if (a === 127) return true;                        // 127.0.0.0/8 loopback
	if (a === 0) return true;                          // 0.0.0.0/8
	if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local + metadata
	if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
	if (a === 192 && b === 168) return true;           // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224) return true;                         // 224+ multicast / reserved
	return false;
}

function isPrivateIpv6(ip) {
	const norm = ip.toLowerCase().split('%')[0]; // strip zone id
	if (norm === '::1' || norm === '::') return true;          // loopback / unspecified
	if (norm.startsWith('fe80')) return true;                  // link-local
	if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // unique-local fc00::/7
	if (norm.startsWith('ff')) return true;                    // multicast
	// IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded v4.
	const mapped = norm.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isPrivateIpv4(mapped[1]);
	return false;
}

/**
 * Validate that `urlStr` is a safe public x402 target. Rejects non-http(s),
 * plain http (unless allowHttp), credentials in the URL, and any host that is
 * (or resolves to) a private/reserved address. DNS lookup is injectable for
 * tests. Returns `{ url, hostname }`; throws TypeError with a clear message.
 */
export async function assertSafeTarget(urlStr, { allowHttp = false, lookup = dnsLookup, denyHosts = [] } = {}) {
	let u;
	try { u = new URL(String(urlStr)); }
	catch { throw new TypeError('url must be a valid absolute URL'); }
	if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
		throw new TypeError(allowHttp ? 'url must use http(s)://' : 'url must use https://');
	}
	if (u.username || u.password) throw new TypeError('url must not embed credentials');
	const host = u.hostname.toLowerCase();
	if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		throw new TypeError('url host is not a public address');
	}
	if (Array.isArray(denyHosts) && denyHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
		throw new TypeError('url host is not allowed');
	}
	// Literal IP in the host → check directly. Otherwise resolve and check
	// every returned address (defends against a name that points inside).
	if (isIP(host)) {
		if (isPrivateIp(host)) throw new TypeError('url resolves to a private address');
	} else {
		let addrs;
		try { addrs = await lookup(host, { all: true }); }
		catch { throw new TypeError(`could not resolve host ${host}`); }
		const list = Array.isArray(addrs) ? addrs : [addrs];
		if (list.length === 0) throw new TypeError(`could not resolve host ${host}`);
		for (const a of list) {
			if (isPrivateIp(a.address)) throw new TypeError('url resolves to a private address');
		}
	}
	return { url: u.toString(), hostname: host };
}

// ── request validation (pure) ───────────────────────────────────────

/**
 * Validate + normalise a relay request body. Auth fields (watchId/watchToken)
 * are validated by the caller against the store; this covers the payment
 * shape. Returns a frozen, normalised request. Throws TypeError on bad input.
 */
export function validateRelayRequest(body, { maxPerCallAtomic = RELAY_DEFAULTS.maxPerCallAtomic } = {}) {
	if (!body || typeof body !== 'object') throw new TypeError('request body must be a JSON object');
	if (typeof body.url !== 'string' || body.url.length === 0) throw new TypeError('url is required');
	if (body.url.length > 2048) throw new TypeError('url is too long');

	const method = String(body.method ?? 'GET').toUpperCase();
	if (!ALLOWED_METHODS.includes(method)) {
		throw new TypeError(`method must be one of ${ALLOWED_METHODS.join(', ')}`);
	}

	// Optional forwarded request body (for POST/PUT/PATCH). Accept an object
	// (sent as JSON) or a string (sent verbatim). Capped to keep us from
	// being used to push large payloads through the float.
	let forwardBody;
	if (body.body !== undefined && body.body !== null) {
		if (typeof body.body === 'string') forwardBody = body.body;
		else if (typeof body.body === 'object') forwardBody = JSON.stringify(body.body);
		else throw new TypeError('body must be a JSON object or string');
		if (forwardBody.length > 64 * 1024) throw new TypeError('body exceeds 64 KB');
	}

	// maxAmountUsd: the most the caller will let us pay the MERCHANT. Defaults
	// to (and is clamped down to) the per-call ceiling. The relay fee is on
	// top of this and checked against the balance separately.
	let maxAtomic = maxPerCallAtomic;
	if (body.maxAmountUsd !== undefined && body.maxAmountUsd !== null) {
		const usd = Number(body.maxAmountUsd);
		if (!Number.isFinite(usd) || usd <= 0) throw new TypeError('maxAmountUsd must be a positive number');
		maxAtomic = usdToAtomic(usd);
	}
	maxAtomic = Math.min(maxAtomic, maxPerCallAtomic);
	if (maxAtomic <= 0) throw new TypeError('maxAmountUsd resolves to zero');

	let idempotencyKey = null;
	if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
		idempotencyKey = String(body.idempotencyKey).slice(0, 80);
		if (idempotencyKey.length < 8) throw new TypeError('idempotencyKey must be at least 8 characters');
	}

	return Object.freeze({ url: body.url, method, forwardBody, maxAtomic, idempotencyKey });
}

/** UTC midnight for the day containing `nowMs` — the rolling cap window. */
export function relayDayStartMs(nowMs) {
	return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

// ── receipts + balance store (operates on the shared watch DB) ──────

const RELAY_DDL = `
CREATE TABLE IF NOT EXISTS relay_payments (
	id              TEXT PRIMARY KEY,
	watch_id        TEXT NOT NULL,
	idempotency_key TEXT,
	target_host     TEXT NOT NULL,
	target_url      TEXT NOT NULL,
	method          TEXT NOT NULL,
	network         TEXT,
	asset           TEXT,
	quoted_atomic   INTEGER,
	paid_atomic     INTEGER NOT NULL DEFAULT 0,
	fee_atomic      INTEGER NOT NULL DEFAULT 0,
	reserved_atomic INTEGER NOT NULL DEFAULT 0,
	status          TEXT NOT NULL,           -- pending | settled | failed | rejected
	tx_hash         TEXT,
	response_status INTEGER,
	reason          TEXT,
	created_ms      INTEGER NOT NULL,
	settled_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_relay_watch_created ON relay_payments(watch_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_relay_status_created ON relay_payments(status, created_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_idem ON relay_payments(watch_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export function ensureRelaySchema(db) {
	db.exec(RELAY_DDL);
	return db;
}

/**
 * Atomic guarded debit: subtract `atomic` from a watch's credit only if the
 * balance covers it. Returns true if the reservation succeeded. The WHERE
 * guard makes concurrent reservations safe (no read-modify-write race).
 */
export function reserveCredit(db, watchId, atomic) {
	const amt = Math.round(Number(atomic) || 0);
	if (amt <= 0) return true;
	const info = db.prepare(
		'UPDATE private_watches SET credit_atomic = credit_atomic - ? WHERE id = ? AND credit_atomic >= ?'
	).run(amt, watchId, amt);
	return info.changes === 1;
}

/** Return reserved-but-unused (or fully refunded) credit to a watch. */
export function refundCredit(db, watchId, atomic) {
	const amt = Math.round(Number(atomic) || 0);
	if (amt <= 0) return;
	db.prepare('UPDATE private_watches SET credit_atomic = credit_atomic + ? WHERE id = ?').run(amt, watchId);
}

/**
 * Atomic spend over the day window across all non-failed receipts. `pending`
 * is included so concurrent in-flight calls count toward the cap (no burst
 * past the ceiling); `failed`/`rejected` are excluded (they were refunded).
 */
export function daySpentAtomic(db, { watchId = null, sinceMs }) {
	const where = watchId
		? 'watch_id = ? AND created_ms >= ? AND status IN (\'settled\',\'pending\')'
		: 'created_ms >= ? AND status IN (\'settled\',\'pending\')';
	const args = watchId ? [watchId, sinceMs] : [sinceMs];
	const row = db.prepare(
		`SELECT COALESCE(SUM(paid_atomic + fee_atomic), 0) AS spent, COALESCE(SUM(reserved_atomic), 0) AS reserved
		 FROM relay_payments WHERE ${where}`
	).get(...args);
	// A pending row has paid+fee = 0 but a non-zero reservation; count the
	// larger of (settled spend) and (reservations) so pending holds count.
	return Math.max(Number(row.spent ?? 0), Number(row.reserved ?? 0));
}

function insertPendingReceipt(db, r) {
	db.prepare(`
		INSERT INTO relay_payments
			(id, watch_id, idempotency_key, target_host, target_url, method,
			 network, asset, reserved_atomic, status, created_ms)
		VALUES (@id, @watchId, @idempotencyKey, @targetHost, @targetUrl, @method,
			 @network, @asset, @reservedAtomic, 'pending', @createdMs)
	`).run(r);
}

function finaliseReceipt(db, id, patch) {
	db.prepare(`
		UPDATE relay_payments
		SET status = @status, quoted_atomic = @quotedAtomic, paid_atomic = @paidAtomic,
		    fee_atomic = @feeAtomic, tx_hash = @txHash, response_status = @responseStatus,
		    reason = @reason, settled_ms = @settledMs
		WHERE id = @id
	`).run({ id, ...patch });
}

export function getRelayReceipt(db, id) {
	return db.prepare('SELECT * FROM relay_payments WHERE id = ?').get(id) ?? null;
}

function getReceiptByIdem(db, watchId, key) {
	return db.prepare('SELECT * FROM relay_payments WHERE watch_id = ? AND idempotency_key = ?').get(watchId, key) ?? null;
}

/** Public, safe-to-return projection of a receipt row. */
export function buildReceiptView(row) {
	if (!row) return null;
	return {
		id: row.id,
		status: row.status,
		target_host: row.target_host,
		method: row.method,
		network: row.network ?? null,
		quoted_usd: row.quoted_atomic != null ? atomicToUsd(row.quoted_atomic) : null,
		paid_usd: atomicToUsd(row.paid_atomic),
		fee_usd: atomicToUsd(row.fee_atomic),
		total_usd: atomicToUsd(Number(row.paid_atomic) + Number(row.fee_atomic)),
		tx_hash: row.tx_hash ?? null,
		response_status: row.response_status ?? null,
		reason: row.reason ?? null,
		created_at: new Date(Number(row.created_ms)).toISOString(),
		settled_at: row.settled_ms ? new Date(Number(row.settled_ms)).toISOString() : null
	};
}

// ── service ─────────────────────────────────────────────────────────

/**
 * Build the relay service.
 *
 * @param {object} o
 * @param {object} o.watchDb   open better-sqlite3 handle holding private_watches (+ relay_payments)
 * @param {object} o.payX402   injected payer: { enabled, address, network,
 *                             pay({url,method,body,maxAtomic,network}) -> {ok,...} }
 * @param {function} o.getWatch  (db,id,token) -> null | {error} | row  (viewkey-watch store)
 * @param {object} [o.config]   gateway config (relay* overrides)
 * @param {function} [o.lookup] DNS lookup (tests)
 * @param {function} [o.now]    clock (tests)
 * @param {object} [o.log]      logger
 */
export function createX402RelayService({ watchDb, payX402, getWatch, config = {}, lookup, now, log } = {}) {
	if (typeof getWatch !== 'function') throw new Error('createX402RelayService: getWatch is required');
	const clock = now ?? (() => Date.now());
	const logger = log ?? { info() {}, warn() {}, error() {} };

	const limits = Object.freeze({
		maxPerCallAtomic: config.relayMaxPerCallAtomic ?? RELAY_DEFAULTS.maxPerCallAtomic,
		maxPerDayPerWatchAtomic: config.relayMaxPerDayPerWatchAtomic ?? RELAY_DEFAULTS.maxPerDayPerWatchAtomic,
		maxPerDayGlobalAtomic: config.relayMaxPerDayGlobalAtomic ?? RELAY_DEFAULTS.maxPerDayGlobalAtomic
	});
	const fee = Object.freeze({
		flatAtomic: config.relayFeeFlatAtomic ?? RELAY_DEFAULTS.feeFlatAtomic,
		bps: config.relayFeeBps ?? RELAY_DEFAULTS.feeBps
	});
	const network = config.relayNetwork ?? payX402?.network ?? RELAY_DEFAULTS.network;
	const usdcAsset = (config.relayUsdcAsset ?? RELAY_DEFAULTS.usdcAsset) || '';
	const allowHttp = config.relayAllowHttp ?? RELAY_DEFAULTS.allowHttp;
	const denyHosts = Array.isArray(config.relayDenyHosts) ? config.relayDenyHosts : [];

	if (watchDb) {
		try { ensureRelaySchema(watchDb); }
		catch (err) { logger.error({ err: err?.message ?? String(err) }, 'x402-relay: failed to ensure relay schema'); }
	}

	const enabled = () => Boolean(watchDb && payX402?.enabled);

	function info() {
		return {
			enabled: enabled(),
			network,
			asset: usdcAsset || null,
			payer_address: payX402?.address ?? null,
			fee: {
				flat_usd: atomicToUsd(fee.flatAtomic),
				percent: fee.bps / 100,
				model: 'greater of flat floor or percentage'
			},
			limits: {
				per_call_usd: atomicToUsd(limits.maxPerCallAtomic),
				per_account_per_day_usd: atomicToUsd(limits.maxPerDayPerWatchAtomic),
				global_per_day_usd: atomicToUsd(limits.maxPerDayGlobalAtomic)
			},
			how: 'POST /v1/pay { watchId, watchToken, url, method?, body?, maxAmountUsd?, idempotencyKey? }. We pay the x402 endpoint from our float and debit your prepaid balance for (amount + fee). Fund the balance via /v1/private/topup* (USDC) or /v1/private/topup-crypto (XMR/ZEC).',
			receipts: RECEIPT_MAX_RECORDS_NOTE
		};
	}

	/**
	 * Resolve + authorise a watch for spending. Returns { row } or { error }
	 * where error is a {code,message,httpStatus} the route maps to a response.
	 */
	function authWatch(watchId, watchToken) {
		const got = getWatch(watchDb, watchId, watchToken);
		if (!got) return { error: { code: 'not_found', message: 'account (watch) not found', httpStatus: 404 } };
		if (got.error === 'forbidden') return { error: { code: 'forbidden', message: 'watch token mismatch', httpStatus: 403 } };
		if (got.cancelled === 1) return { error: { code: 'account_cancelled', message: 'account is cancelled', httpStatus: 409 } };
		if (got.dead === 1) return { error: { code: 'account_dead', message: 'account is dead (out of credit); top up first', httpStatus: 409 } };
		if (Number(got.expires_at_ms) <= clock()) return { error: { code: 'account_expired', message: 'account has expired; top up to extend', httpStatus: 409 } };
		return { row: got };
	}

	/**
	 * Relay a single x402 payment. `req` is the validated request from
	 * validateRelayRequest plus { watchId, watchToken }. Returns a structured
	 * result the route renders; never throws for expected failures.
	 */
	async function relay(req) {
		if (!enabled()) {
			return { ok: false, error: { code: 'relay_not_configured', message: 'x402 relay is not enabled on this server (no funded payer wired).', httpStatus: 503 } };
		}
		const { watchId, watchToken, url, method, forwardBody, maxAtomic, idempotencyKey } = req;

		const auth = authWatch(watchId, watchToken);
		if (auth.error) return { ok: false, error: { ...auth.error } };

		// Idempotency replay: a prior receipt with this key short-circuits.
		if (idempotencyKey) {
			const prev = getReceiptByIdem(watchDb, watchId, idempotencyKey);
			if (prev) {
				return { ok: prev.status === 'settled', replayed: true, receipt: buildReceiptView(prev) };
			}
		}

		// SSRF + URL safety.
		let target;
		try { target = await assertSafeTarget(url, { allowHttp, lookup, denyHosts }); }
		catch (err) { return { ok: false, error: { code: 'unsafe_target', message: err?.message ?? String(err), httpStatus: 400 } }; }

		// Reserve = merchant cap + the worst-case fee on that cap, so the
		// refund after settlement is always non-negative.
		const merchantCap = Math.min(maxAtomic, limits.maxPerCallAtomic);
		const feeOnCap = computeRelayFee(merchantCap, fee);
		const reserve = merchantCap + feeOnCap;

		// Daily caps (per-account + global float guard). Checked before the
		// reservation so we reject cleanly without touching the balance.
		const dayStart = relayDayStartMs(clock());
		const spentWatch = daySpentAtomic(watchDb, { watchId, sinceMs: dayStart });
		if (spentWatch + reserve > limits.maxPerDayPerWatchAtomic) {
			return { ok: false, error: { code: 'daily_account_cap', message: `daily per-account cap reached (${atomicToUsd(limits.maxPerDayPerWatchAtomic)} USD)`, httpStatus: 429 } };
		}
		const spentGlobal = daySpentAtomic(watchDb, { sinceMs: dayStart });
		if (spentGlobal + reserve > limits.maxPerDayGlobalAtomic) {
			return { ok: false, error: { code: 'daily_global_cap', message: 'daily global relay cap reached; try again later', httpStatus: 503 } };
		}

		// Reserve the funds (atomic guarded debit).
		if (!reserveCredit(watchDb, watchId, reserve)) {
			return { ok: false, error: { code: 'insufficient_credit', message: `insufficient prepaid credit; need ${atomicToUsd(reserve)} USD (incl. fee). Top up via /v1/private/topup*`, httpStatus: 402 } };
		}

		// Open a pending receipt (also our idempotency record). If the unique
		// idem index trips, a concurrent call already booked it: refund + replay.
		const receiptId = randomUUID();
		const createdMs = clock();
		try {
			insertPendingReceipt(watchDb, {
				id: receiptId, watchId, idempotencyKey: idempotencyKey ?? null,
				targetHost: target.hostname, targetUrl: target.url, method,
				network, asset: usdcAsset || null, reservedAtomic: reserve, createdMs
			});
		} catch (err) {
			refundCredit(watchDb, watchId, reserve);
			if (idempotencyKey) {
				const prev = getReceiptByIdem(watchDb, watchId, idempotencyKey);
				if (prev) return { ok: prev.status === 'settled', replayed: true, receipt: buildReceiptView(prev) };
			}
			logger.error({ err: err?.message ?? String(err) }, 'x402-relay: failed to open receipt');
			return { ok: false, error: { code: 'relay_error', message: 'could not record the payment; nothing was charged', httpStatus: 500 } };
		}

		// Pay the merchant from the float.
		let res;
		try {
			res = await payX402.pay({ url: target.url, method, body: forwardBody, maxAtomic: merchantCap, network });
		} catch (err) {
			refundCredit(watchDb, watchId, reserve);
			finaliseReceipt(watchDb, receiptId, {
				status: 'failed', quotedAtomic: null, paidAtomic: 0, feeAtomic: 0,
				txHash: null, responseStatus: null, reason: (err?.message ?? String(err)).slice(0, 200), settledMs: clock()
			});
			logger.warn({ err: err?.message ?? String(err), host: target.hostname }, 'x402-relay: payer threw');
			return { ok: false, error: { code: 'payment_error', message: 'payment failed; you were not charged', httpStatus: 502 }, receipt: buildReceiptView(getRelayReceipt(watchDb, receiptId)) };
		}

		if (!res || res.ok !== true) {
			refundCredit(watchDb, watchId, reserve);
			const rejected = res?.reason === 'price_exceeds_max' || res?.reason === 'not_x402' || res?.reason === 'no_accept_for_network' || res?.reason === 'asset_not_accepted';
			finaliseReceipt(watchDb, receiptId, {
				status: rejected ? 'rejected' : 'failed',
				quotedAtomic: res?.quotedAtomic ?? null, paidAtomic: 0, feeAtomic: 0,
				txHash: null, responseStatus: res?.response?.status ?? null,
				reason: (res?.reason ?? 'payment_failed').slice(0, 200), settledMs: clock()
			});
			return {
				ok: false,
				error: {
					code: res?.reason ?? 'payment_failed',
					message: relayFailureMessage(res?.reason, { quotedAtomic: res?.quotedAtomic, merchantCap }),
					httpStatus: rejected ? 422 : 502
				},
				receipt: buildReceiptView(getRelayReceipt(watchDb, receiptId))
			};
		}

		// Settled. Charge actual + fee; refund the remainder of the reservation.
		const paid = Math.max(0, Math.round(Number(res.paidAtomic) || 0));
		const feeAtomic = computeRelayFee(paid, fee);
		const total = paid + feeAtomic;
		const refund = Math.max(0, reserve - total);
		if (refund > 0) refundCredit(watchDb, watchId, refund);
		finaliseReceipt(watchDb, receiptId, {
			status: 'settled', quotedAtomic: res.quotedAtomic ?? paid, paidAtomic: paid,
			feeAtomic, txHash: res.txHash ?? null, responseStatus: res.response?.status ?? null,
			reason: null, settledMs: clock()
		});
		const balanceRow = getWatch(watchDb, watchId, watchToken);
		logger.info({ host: target.hostname, paidAtomic: paid, feeAtomic, tx: res.txHash ?? null }, 'x402-relay: settled');
		return {
			ok: true,
			receipt: buildReceiptView(getRelayReceipt(watchDb, receiptId)),
			balance_usd: balanceRow && !balanceRow.error ? atomicToUsd(balanceRow.credit_atomic) : null,
			response: res.response ?? null
		};
	}

	/**
	 * Fetch a receipt, authorised: the caller must present the owning watch's
	 * token. Returns { receipt } or { error } (route maps to a response).
	 */
	function getReceipt({ watchId, watchToken, id }) {
		const auth = authWatch(watchId, watchToken);
		if (auth.error) return { error: { ...auth.error } };
		const row = getRelayReceipt(watchDb, id);
		if (!row || row.watch_id !== watchId) {
			return { error: { code: 'not_found', message: 'receipt not found', httpStatus: 404 } };
		}
		return { receipt: buildReceiptView(row) };
	}

	return { enabled, info, relay, getReceipt, limits, fee, network };
}

function relayFailureMessage(reason, { quotedAtomic, merchantCap }) {
	switch (reason) {
		case 'not_x402':
			return 'the target did not present an x402 payment challenge (we only relay paid x402 calls)';
		case 'no_accept_for_network':
			return `the target does not accept payment on ${RELAY_DEFAULTS.network}`;
		case 'asset_not_accepted':
			return 'the target does not accept the expected USDC asset';
		case 'price_exceeds_max':
			return `the target's price${quotedAtomic != null ? ` (${atomicToUsd(quotedAtomic)} USD)` : ''} exceeds your maxAmountUsd (${atomicToUsd(merchantCap)} USD)`;
		case 'settlement_failed':
			return 'on-chain settlement did not succeed; you were not charged';
		default:
			return 'payment failed; you were not charged';
	}
}

export default createX402RelayService;
