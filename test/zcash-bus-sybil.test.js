// Anti-sybil (P4c) gateway layer: the per-bus busKey contract, the durable
// nullifier registry, and the sybil-gated join/open routes.
//
// The zk PROOF itself is verified by an INJECTED verifier (snarkjs/zkey never
// enter the gateway), so here we inject a deterministic fake verifier and assert
// the gateway's binding + dedupe + release logic. The real Poseidon proof model
// is exercised in the `zecbus` package's own tests.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify from 'fastify';

import { busKeyForBus, busDescriptor, buildBusSummary } from '../src/zcash-bus.js';
import { openBusDb } from '../src/zcash-bus-store.js';
import {
	claimNullifier,
	hasNullifier,
	releaseNullifier,
	seatCount,
	claimSeat
} from '../src/zcash-bus-nullifiers.js';
import { registerZcashBusRoutes } from '../src/zcash-bus-routes.js';

// Pinned cross-repo contract: this MUST equal zecbus busKeyFor() for the same
// bus, or riders' proofs bind to a different key than the gateway dedupes on.
const VECTOR_BUS = { from_asset: 'ZEC.ZEC', to_asset: 'BTC.BTC', amount_zat: 100_000_000, id: 'bus_test' };
const VECTOR_BUSKEY = '9960434065771620257691917133158939830803970344291143990915686779283816674916';

describe('busKey contract (must match zecbus reputation.busKeyFor)', () => {
	test('canonical descriptor + key match the pinned vector', () => {
		expect(busDescriptor(VECTOR_BUS)).toBe('zecbus:v2:ZEC.ZEC|BTC.BTC|100000000|bus_test');
		expect(busKeyForBus(VECTOR_BUS)).toBe(VECTOR_BUSKEY);
	});
	test('busKey changes with every public field (per-bus, not per-cohort)', () => {
		const base = busKeyForBus(VECTOR_BUS);
		expect(busKeyForBus({ ...VECTOR_BUS, id: 'bus_other' })).not.toBe(base);
		expect(busKeyForBus({ ...VECTOR_BUS, amount_zat: 50_000_000 })).not.toBe(base);
		expect(busKeyForBus({ ...VECTOR_BUS, to_asset: 'ETH.ETH' })).not.toBe(base);
	});
	test('buildBusSummary publishes bus_key', () => {
		const s = buildBusSummary({ ...VECTOR_BUS, route: 'ZEC.ZEC>BTC.BTC', min_passengers: 5, status: 'boarding', created_ms: 1, expires_ms: 9 }, { boarded: 0 });
		expect(s.bus_key).toBe(VECTOR_BUSKEY);
	});
});

describe('durable nullifier registry', () => {
	let db;
	beforeEach(() => { db = openBusDb(':memory:'); });
	afterEach(() => { if (db) db.close(); });

	test('claim dedupes per bus; unlinkable across buses', () => {
		expect(claimNullifier(db, 'busA', 'nf1').ok).toBe(true);
		expect(hasNullifier(db, 'busA', 'nf1')).toBe(true);
		// same nullifier, same bus → rejected
		expect(claimNullifier(db, 'busA', 'nf1')).toEqual({ ok: false, reason: 'nullifier_used' });
		// same nullifier value, DIFFERENT bus → fine (different busKey)
		expect(claimNullifier(db, 'busB', 'nf1').ok).toBe(true);
		expect(seatCount(db, 'busA')).toBe(1);
		expect(seatCount(db, 'busB')).toBe(1);
	});

	test('release reopens the seat', () => {
		claimNullifier(db, 'busA', 'nf1');
		expect(releaseNullifier(db, 'busA', 'nf1')).toBe(true);
		expect(hasNullifier(db, 'busA', 'nf1')).toBe(false);
		expect(claimNullifier(db, 'busA', 'nf1').ok).toBe(true); // can re-claim
		expect(releaseNullifier(db, 'busA', 'absent')).toBe(false);
	});

	test('claimSeat verifies, binds busKey, and dedupes', async () => {
		const verifyProof = async (b) => b.proof === 'good';
		const bundle = { proof: 'good', publicSignals: ['r', 'bk', 'nf'], merkleRoot: 'r', busKey: 'bk', nullifier: 'nf' };
		// happy path
		expect(await claimSeat(db, bundle, { verifyProof, expectBusKey: 'bk' })).toEqual({ ok: true, reason: null });
		// repeat → used
		expect((await claimSeat(db, bundle, { verifyProof, expectBusKey: 'bk' })).reason).toBe('nullifier_used');
		// wrong proof
		expect((await claimSeat(db, { ...bundle, proof: 'bad', nullifier: 'nf2' }, { verifyProof, expectBusKey: 'bk' })).reason).toBe('invalid_proof');
		// busKey binding
		expect((await claimSeat(db, { ...bundle, nullifier: 'nf3' }, { verifyProof, expectBusKey: 'OTHER' })).reason).toBe('bus_key_mismatch');
		// unknown root
		expect((await claimSeat(db, { ...bundle, nullifier: 'nf4' }, { verifyProof, expectBusKey: 'bk', acceptRoot: () => false })).reason).toBe('unknown_root');
		// bad bundle
		expect((await claimSeat(db, { busKey: 'bk' }, { verifyProof })).reason).toBe('bad_bundle');
	});
});

// ── routes: sybil-required mode with an injected verifier ──────────────
const SYBIL_CONFIG = Object.freeze({
	zecBusEnabled: false, zecBusDbPath: ':memory:',
	zecBusFillTtlMs: 86_400_000, zecBusDepartWindowMs: 1_200_000,
	zecBusSybilRequired: true
});

async function makeSybilApp(busDb, { verifyProof, acceptRoot } = {}) {
	const app = Fastify({ logger: false });
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
		return reply.code(500).send({ error: { code: 'internal_error', message: err.message } });
	});
	registerZcashBusRoutes(app, { config: SYBIL_CONFIG, busDb, verifyProof, acceptRoot });
	await app.ready();
	return app;
}
const postJson = async (app, url, payload) => {
	const r = await app.inject({ method: 'POST', url, payload });
	return { status: r.statusCode, body: JSON.parse(r.body) };
};

// Open a bus and craft a proof bundle bound to its published bus_key.
async function openAndBundle(app, { to = 'BTC.BTC', amount = 1, minPassengers = 3, nullifier = 'nf1', root = 'root1' } = {}) {
	const opened = await postJson(app, '/v1/zec/bus/open', { to, amount, minPassengers });
	const busId = opened.body.bus.id;
	const busKey = opened.body.bus_key;
	const bundle = { proof: 'good', publicSignals: [root, busKey, nullifier], merkleRoot: root, busKey, nullifier };
	return { busId, busKey, bundle, opened };
}

describe('bus routes — sybil required', () => {
	let app; let db;
	const goodVerifier = async (b) => b.proof === 'good';
	beforeEach(async () => { db = openBusDb(':memory:'); app = await makeSybilApp(db, { verifyProof: goodVerifier }); });
	afterEach(async () => { if (app) await app.close(); if (db) db.close(); });

	test('open returns a bus and its bus_key', async () => {
		const { opened, busKey } = await openAndBundle(app);
		expect(opened.status).toBe(200);
		expect(typeof busKey).toBe('string');
		expect(opened.body.bus.bus_key).toBe(busKey);
		expect(opened.body.bus.seats_filled).toBe(0);
	});

	test('a valid proof claims a seat; the same nullifier is then refused (409)', async () => {
		const { busId, bundle } = await openAndBundle(app);
		const first = await postJson(app, '/v1/zec/bus/join', { busId, proof: bundle });
		expect(first.status).toBe(201);
		expect(first.body.bus.seats_filled).toBe(1);

		const dupe = await postJson(app, '/v1/zec/bus/join', { busId, proof: bundle });
		expect(dupe.status).toBe(409);
		expect(dupe.body.error.code).toBe('seat_taken');
	});

	test('leaving frees the nullifier so the identity can re-board', async () => {
		const { busId, bundle } = await openAndBundle(app);
		const first = await postJson(app, '/v1/zec/bus/join', { busId, proof: bundle });
		const token = first.body.owner_token;
		const seatId = first.body.seat.id;
		const left = await postJson(app, `/v1/zec/bus/seat/${seatId}/leave`, { ownerToken: token });
		expect(left.body.seat.status).toBe('left');
		// same nullifier now accepted again
		const again = await postJson(app, '/v1/zec/bus/join', { busId, proof: bundle });
		expect(again.status).toBe(201);
	});

	test('join is rejected without busId, with a bad bundle, on busKey mismatch and on a bad proof', async () => {
		const { busId, bundle } = await openAndBundle(app);
		expect((await postJson(app, '/v1/zec/bus/join', { proof: bundle })).status).toBe(400); // no busId
		expect((await postJson(app, '/v1/zec/bus/join', { busId, proof: { proof: 'x' } })).status).toBe(400); // bad shape
		const mism = await postJson(app, '/v1/zec/bus/join', { busId, proof: { ...bundle, busKey: '123' } });
		expect(mism.body.error.code).toBe('bus_key_mismatch');
		const bad = await postJson(app, '/v1/zec/bus/join', { busId, proof: { ...bundle, proof: 'bad' } });
		expect(bad.body.error.code).toBe('invalid_proof');
	});

	test('acceptRoot pins which identity-tree roots are valid', async () => {
		await app.close();
		app = await makeSybilApp(db, { verifyProof: goodVerifier, acceptRoot: (r) => r === 'trusted' });
		const { busId, busKey } = await openAndBundle(app);
		const bundle = { proof: 'good', publicSignals: ['stale', busKey, 'nfX'], merkleRoot: 'stale', busKey, nullifier: 'nfX' };
		const res = await postJson(app, '/v1/zec/bus/join', { busId, proof: bundle });
		expect(res.body.error.code).toBe('unknown_root');
	});

	test('fails safe (503) when sybil is required but no verifier is wired', async () => {
		await app.close();
		app = await makeSybilApp(db, {}); // no verifyProof
		const res = await postJson(app, '/v1/zec/bus/join', { busId: 'x', proof: { proof: 'good', publicSignals: [], merkleRoot: 'r', busKey: 'k', nullifier: 'n' } });
		expect(res.status).toBe(503);
		expect(res.body.error.code).toBe('sybil_misconfigured');
	});
});
