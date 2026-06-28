// Zcash "Bus Station" — durable anti-sybil nullifier registry (P4c).
//
// The in-memory reference model lives in the `zecbus` package
// (src/nullifier-registry.js); this is the gateway's persistent twin, backed by
// the same SQLite file as the buses so the per-request MCP server instances and
// the REST routes all enforce against one set of used nullifiers (mirrors the
// shared bus DB). The `bus_nullifiers` table is created by zcash-bus-store.js.
//
// "One anonymous identity → one seat per bus": a seat claim reveals a per-bus
// nullifier = Poseidon(idSecret, busKey); a repeat on the same busKey is
// rejected. The PRIMARY KEY (bus_key, nullifier) makes that race-free.
//
// Verifying the zk membership proof is the trust anchor, but it is INJECTED
// (`verifyProof`) so this module — and the gateway — stay free of the heavy
// snarkjs / zkey machinery. Operators wire `makeProofVerifier(vkey)` from the
// `zecbus` package (built from a real trusted-setup ceremony) when they opt in.

const k = (v) => (typeof v === 'bigint' ? v.toString() : String(v));

export function hasNullifier(db, busKey, nullifier) {
	const row = db
		.prepare('SELECT 1 FROM bus_nullifiers WHERE bus_key = ? AND nullifier = ?')
		.get(k(busKey), k(nullifier));
	return !!row;
}

export function seatCount(db, busKey) {
	const row = db.prepare('SELECT COUNT(*) AS n FROM bus_nullifiers WHERE bus_key = ?').get(k(busKey));
	return Number(row?.n ?? 0);
}

/**
 * Record a nullifier for a bus. Returns { ok, reason }. A repeat is rejected,
 * never silently merged — that rejection is the whole point.
 */
export function claimNullifier(db, busKey, nullifier, { seatId = null, nowMs = Date.now() } = {}) {
	if (busKey == null || nullifier == null) return { ok: false, reason: 'bad_bundle' };
	try {
		const res = db
			.prepare('INSERT INTO bus_nullifiers (bus_key, nullifier, seat_id, created_ms) VALUES (?, ?, ?, ?)')
			.run(k(busKey), k(nullifier), seatId, nowMs);
		return { ok: res.changes === 1, reason: res.changes === 1 ? null : 'nullifier_used' };
	} catch (err) {
		// UNIQUE/PK violation === already used on this bus.
		if (/UNIQUE|PRIMARY/i.test(String(err?.message))) return { ok: false, reason: 'nullifier_used' };
		throw err;
	}
}

/** Free a seat's nullifier (rider left before departure) so the seat reopens. */
export function releaseNullifier(db, busKey, nullifier) {
	const res = db
		.prepare('DELETE FROM bus_nullifiers WHERE bus_key = ? AND nullifier = ?')
		.run(k(busKey), k(nullifier));
	return res.changes > 0;
}

/**
 * Full claim path: verify the proof, then dedupe — durably. `verifyProof(bundle)`
 * resolves truthy only for a valid membership proof whose public signals match
 * `{ merkleRoot, busKey, nullifier }`. `acceptRoot(root)` pins which identity-tree
 * roots are currently valid (default: accept any). `expectBusKey` binds the proof
 * to a specific bus (so a valid proof for bus A can't be replayed onto bus B).
 * @returns {Promise<{ ok: boolean, reason: string|null }>}
 */
export async function claimSeat(db, bundle, { verifyProof, acceptRoot, expectBusKey = null, seatId = null, nowMs = Date.now() } = {}) {
	if (!bundle || bundle.busKey == null || bundle.nullifier == null) {
		return { ok: false, reason: 'bad_bundle' };
	}
	if (expectBusKey != null && k(bundle.busKey) !== k(expectBusKey)) {
		return { ok: false, reason: 'bus_key_mismatch' };
	}
	if (typeof acceptRoot === 'function' && !acceptRoot(bundle.merkleRoot)) {
		return { ok: false, reason: 'unknown_root' };
	}
	if (typeof verifyProof === 'function') {
		let valid = false;
		try {
			valid = await verifyProof(bundle);
		} catch {
			valid = false;
		}
		if (!valid) return { ok: false, reason: 'invalid_proof' };
	}
	return claimNullifier(db, bundle.busKey, bundle.nullifier, { seatId, nowMs });
}

export default {
	hasNullifier,
	seatCount,
	claimNullifier,
	releaseNullifier,
	claimSeat
};
