// Hardened entropy for server-side key generation.
//
// The browser half of this lives in WINBIT32
// (src/services/secureEntropy.ts); this is the same construction for
// Node, so a phrase generated through the MCP tools is protected the
// same way as one generated in the wallet UI.
//
// Prompted by the Coldcard Mk3 advisory
// (blog.coinkite.com/coldcard-mk3-seed-generation-warning/): a device
// with one RNG that silently degraded, and nothing in the seed path
// that ever checked. Two rules follow.
//
//   1. Never degrade silently. If the CSPRNG is missing or visibly
//      broken we throw. There is no fallback to anything weaker.
//
//   2. Never trust a single source. Output is HKDF over two independent
//      CSPRNG draws plus optional caller-supplied material. Because a
//      CSPRNG draw is always in the input keying material and HKDF is a
//      PRF, this is provably no worse than the raw generator — but if
//      the generator is what failed, the extra material still stands
//      between an attacker and the key.
//
// Honest limit: the health checks below catch catastrophic failure
// (stuck source, constant output, short period). They cannot detect a
// well-formed but predictable generator. That is what the mixing is for.

import { randomBytes, hkdfSync, createHash } from 'node:crypto';

const HKDF_INFO = 'winbit32/seed-entropy/v1';

/** Thrown when the CSPRNG is unusable. Never caught internally. */
export class EntropyUnavailableError extends Error {
	constructor(message) {
		super(message);
		this.name = 'EntropyUnavailableError';
	}
}

const isConstant = (buf, value) => buf.every((b) => b === value);

/**
 * Raw CSPRNG draw with a stuck-output guard.
 *
 * The all-zero/all-ones rejection has a false-positive probability of
 * 2^-(8n-1) — beyond negligible for n >= 8 — and exists because
 * "returns a buffer of zeros" is how a broken RNG actually fails.
 */
export function secureRandomBytes(length) {
	if (!Number.isInteger(length) || length <= 0) {
		throw new TypeError(`secureRandomBytes: invalid length ${length}`);
	}
	let out;
	try {
		out = randomBytes(length);
	} catch (err) {
		throw new EntropyUnavailableError(
			`The system CSPRNG failed: ${err?.message ?? err}. Key generation refused.`
		);
	}
	if (length >= 8 && (isConstant(out, 0x00) || isConstant(out, 0xff))) {
		throw new EntropyUnavailableError(
			'The system CSPRNG returned a constant value. Key generation refused.'
		);
	}
	return out;
}

let cachedHealth = null;

/**
 * Probe the CSPRNG for catastrophic failure.
 *
 * A uniform source covers ~251 of 256 possible byte values in a
 * 1024-byte draw; we fail below 200, which a healthy generator will
 * never hit and a short-period one hits immediately.
 *
 * Cached after the first success — a process-start smoke test, not a
 * per-call gate (per-call guards live in secureRandomBytes).
 */
export function checkRngHealth(force = false) {
	if (cachedHealth && !force) return cachedHealth;

	let a;
	let b;
	try {
		a = secureRandomBytes(1024);
		b = secureRandomBytes(1024);
	} catch (err) {
		cachedHealth = {
			ok: false, distinctByteValues: 0, drawsDiffer: false,
			failure: err?.message ?? String(err)
		};
		return cachedHealth;
	}

	const drawsDiffer = !a.equals(b);
	if (!drawsDiffer) {
		cachedHealth = {
			ok: false, distinctByteValues: 0, drawsDiffer: false,
			failure: 'Two independent random draws were identical — the generator is stuck.'
		};
		return cachedHealth;
	}

	const distinctByteValues = new Set(a).size;
	if (distinctByteValues < 200) {
		cachedHealth = {
			ok: false, distinctByteValues, drawsDiffer,
			failure: `Random output covered only ${distinctByteValues} of 256 possible byte values — far below the ~251 expected.`
		};
		return cachedHealth;
	}

	cachedHealth = { ok: true, distinctByteValues, drawsDiffer };
	return cachedHealth;
}

function assertRngHealthy() {
	const health = checkRngHealth();
	if (!health.ok) {
		throw new EntropyUnavailableError(
			`RNG self-test failed: ${health.failure} Key generation refused — do not use any key material this process has produced.`
		);
	}
}

/**
 * Liveness check applied to the two draws a generation actually uses.
 *
 * `checkRngHealth` is cached after the first success, so a generator
 * that passed at process start and became stuck later would otherwise
 * slip through. The two draws are needed for the mixing anyway, so
 * comparing them costs nothing — and for a working generator the
 * false-positive probability is 2^-512.
 *
 * Exported so it can be tested directly: mocking node:crypto to fake a
 * stuck generator is not worth what it does to the test runner.
 */
export function assertIndependentDraws(a, b) {
	if (a.equals(b)) {
		throw new EntropyUnavailableError(
			'Two independent random draws taken moments apart were identical — the CSPRNG is stuck. Key generation refused.'
		);
	}
}

/** High-resolution timing snapshot: weak, but genuinely independent. */
function timingJitter() {
	const h = createHash('sha256');
	h.update(String(process.hrtime.bigint()));
	h.update(String(Date.now()));
	h.update(String(process.pid));
	return h.digest();
}

/**
 * Produce `byteLength` bytes of key material.
 *
 *   IKM  = csprng(64) ‖ extra ‖ csprng(64) ‖ jitter
 *   salt = csprng(32)
 *   out  = HKDF-SHA512(IKM, salt, "winbit32/seed-entropy/v1", byteLength)
 *
 * The two CSPRNG draws bracket the caller's material so that hostile
 * `extra` cannot fix the output.
 *
 * @param {number} byteLength
 * @param {string|Buffer} [extra] caller-supplied entropy, e.g. dice rolls
 */
export function generateEntropyBytes(byteLength, extra) {
	assertRngHealthy();

	const primary = secureRandomBytes(64);
	const secondary = secureRandomBytes(64);

	assertIndependentDraws(primary, secondary);

	const salt = secureRandomBytes(32);
	const extraBuf = extra
		? createHash('sha512').update(Buffer.from(extra)).digest()
		: Buffer.alloc(0);

	const ikm = Buffer.concat([primary, extraBuf, secondary, timingJitter()]);
	const out = Buffer.from(hkdfSync('sha512', ikm, salt, HKDF_INFO, byteLength));

	ikm.fill(0);
	primary.fill(0);
	secondary.fill(0);
	return out;
}

/** Whether extra entropy was supplied, and the live self-test result. */
export function describeEntropySources() {
	return {
		csprng: 'node:crypto randomBytes (OpenSSL CSPRNG)',
		construction: 'HKDF-SHA512 over two independent CSPRNG draws, optional caller entropy, and timing jitter',
		health: checkRngHealth()
	};
}
