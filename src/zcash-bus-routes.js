// Zcash "Bus Station" — non-custodial mixing coordination REST surface.
//
// All free (privacy coordination is a public good). Writes inherit the app's
// global rate limit, exactly like the free notice-board post tier. OPT-IN: a
// writable DB is required, so every route answers 503 until the operator sets
// ZEC_BUS_ENABLED (there is no read-only fallback like the shield index).
//
//   GET  /v1/zec/bus                  list open buses (filter by ?to=CHAIN.TICKER)
//   GET  /v1/zec/bus/:id              one bus (optionally your seat via ?seatId=&ownerToken=)
//   POST /v1/zec/bus/join             reserve a seat -> returns a one-time owner token
//   POST /v1/zec/bus/seat/:id/board   confirm boarded (owner token)
//   POST /v1/zec/bus/seat/:id/leave   withdraw a seat (owner token)
//
// The gateway never holds funds/keys and never stores destinations or txids —
// the pure model + caveats live in zcash-bus.js, the store in zcash-bus-store.js.

import gatewayConfig from './config.js';
import {
	BUS_CONSTANTS,
	BUS_CAVEATS,
	BUS_KIND,
	validateRoute,
	validateBusRoute,
	validateAmount,
	validateMinPassengers,
	normaliseBusHandle,
	normaliseNote,
	buildBusSummary,
	buildSeatSummary,
	busKeyForBus,
	verifyOwner
} from './zcash-bus.js';
import {
	openSharedBusDb,
	listBusViews,
	getBusView,
	getSeatRow,
	findOrCreateBus,
	joinBus,
	setSeatStatus,
	statsSnapshot as busStatsSnapshot
} from './zcash-bus-store.js';

/** Shape-check a rider's anti-sybil proof bundle (the public half is opaque here). */
function isProofBundle(b) {
	return !!b && b.proof != null && Array.isArray(b.publicSignals)
		&& b.merkleRoot != null && b.busKey != null && b.nullifier != null;
}

function resolveBusDb(opts, config) {
	if (opts.busDb !== undefined) return opts.busDb; // injected (tests) — may be null
	if (!config.zecBusEnabled) return null;
	return openSharedBusDb(config.zecBusDbPath);
}

/**
 * Mount the bus-coordination routes on a Fastify app.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @param {object|null} [opts.busDb] inject an open bus DB (tests)
 * @param {(bundle:object)=>Promise<boolean>} [opts.verifyProof] anti-sybil proof
 *   verifier (e.g. zecbus `makeProofVerifier(verificationKey)`). Required when
 *   `config.zecBusSybilRequired` is on; kept injected so snarkjs/zkey never
 *   become a gateway dependency.
 * @param {(root:string)=>boolean} [opts.acceptRoot] pins which identity-tree
 *   roots are currently valid (default: accept any known-shaped root).
 */
export function registerZcashBusRoutes(app, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const busDb = resolveBusDb(opts, config);
	const fillTtlMs = config.zecBusFillTtlMs ?? BUS_CONSTANTS.FILL_TTL_MS;
	const departWindowMs = config.zecBusDepartWindowMs ?? BUS_CONSTANTS.DEPART_WINDOW_MS;
	const sybilRequired = !!config.zecBusSybilRequired;
	const verifyProof = opts.verifyProof ?? null;
	const acceptRoot = opts.acceptRoot ?? null;

	const disabled = (reply) => {
		reply.code(503);
		return { error: { code: 'bus_not_enabled', message: 'Bus coordination is not enabled on this server.' } };
	};
	// Fail SAFE: if the operator demands sybil proofs but wired no verifier, refuse
	// seats rather than silently accepting unproven riders.
	const sybilMisconfigured = (reply) => {
		reply.code(503);
		return { error: { code: 'sybil_misconfigured', message: 'Sybil proofs are required but no verifier is configured on this server.' } };
	};

	app.get('/v1/zec/bus', async (req, reply) => {
		if (!busDb) return disabled(reply);
		const q = req.query ?? {};
		let route = null;
		// Filter by kind (shield/unshield) or by swap destination (?to=).
		try {
			if (q.kind === BUS_KIND.SHIELD || q.kind === BUS_KIND.UNSHIELD || q.kind === 'deshield') {
				route = validateBusRoute({ kind: q.kind }).route;
			} else if (q.to) {
				route = validateRoute({ to: q.to }).route;
			}
		} catch (err) { reply.code(400); return { error: { code: 'bad_route', message: err.message } }; }
		const includeClosed = q.includeClosed === '1' || q.includeClosed === 'true';
		const limit = Math.min(BUS_CONSTANTS.LIST_MAX_LIMIT, Math.max(1, Number.parseInt(q.limit, 10) || BUS_CONSTANTS.LIST_DEFAULT_LIMIT));
		const views = listBusViews(busDb, { route, includeClosed, departWindowMs, limit });
		return {
			buses: views.map((v) => buildBusSummary(v.bus, { boarded: v.boarded, departed: v.departed })),
			stats: busStatsSnapshot(busDb),
			caveats: BUS_CAVEATS
		};
	});

	app.get('/v1/zec/bus/:id', async (req, reply) => {
		if (!busDb) return disabled(reply);
		const view = getBusView(busDb, req.params.id, { departWindowMs });
		if (!view) { reply.code(404); return { error: { code: 'not_found', message: `no bus "${req.params.id}"` } }; }
		const out = { bus: buildBusSummary(view.bus, { boarded: view.boarded, departed: view.departed }), caveats: BUS_CAVEATS };
		const q = req.query ?? {};
		if (q.seatId && q.ownerToken) {
			const seat = getSeatRow(busDb, q.seatId);
			if (seat && seat.bus_id === req.params.id && verifyOwner(seat, q.ownerToken)) out.seat = buildSeatSummary(seat);
			else out.seat_error = 'seat not found or owner token did not match';
		}
		return out;
	});

	// Sybil "open" step: find-or-create the cohort's bus WITHOUT seating, so a
	// rider can read its public `bus_key` and build a proof bound to it before
	// claiming a seat. Only meaningful when sybil proofs are required.
	app.post('/v1/zec/bus/open', async (req, reply) => {
		if (!busDb) return disabled(reply);
		if (!sybilRequired) { reply.code(400); return { error: { code: 'not_sybil_mode', message: 'open is only used when sybil proofs are required; POST /join directly.' } }; }
		const body = req.body ?? {};
		let route; let amountZat; let minPassengers;
		try {
			route = validateBusRoute({ kind: body.kind, to: body.to });
			amountZat = validateAmount(Number(body.amount ?? body.amountZec), { popular: null });
			minPassengers = validateMinPassengers(body.minPassengers);
		} catch (err) { reply.code(400); return { error: { code: 'invalid_request', message: err.message } }; }
		const res = findOrCreateBus(busDb, {
			route: route.route, fromAsset: route.from, toAsset: route.to,
			amountZat, minPassengers, fillTtlMs, departWindowMs
		});
		const bus = buildBusSummary(res.bus, { boarded: res.boarded, departed: res.departed });
		return {
			bus,
			reused: res.reused,
			bus_key: bus.bus_key,
			prove_note: 'Build a membership proof whose public busKey equals bus_key, then POST /v1/zec/bus/join with { busId, proof }.',
			caveats: BUS_CAVEATS
		};
	});

	app.post('/v1/zec/bus/join', async (req, reply) => {
		if (!busDb) return disabled(reply);
		const body = req.body ?? {};

		// ── anti-sybil path: ride a SPECIFIC bus with a verified membership proof ──
		if (sybilRequired) {
			if (!verifyProof) return sybilMisconfigured(reply);
			const busId = body.busId ?? body.bus_id;
			const bundle = body.proof ?? body.bundle;
			if (!busId) { reply.code(400); return { error: { code: 'invalid_request', message: 'busId is required (open a bus first to learn its bus_key).' } }; }
			if (!isProofBundle(bundle)) { reply.code(400); return { error: { code: 'invalid_request', message: 'a membership proof bundle { proof, publicSignals, merkleRoot, busKey, nullifier } is required.' } }; }
			const view = getBusView(busDb, busId, { departWindowMs });
			if (!view) { reply.code(404); return { error: { code: 'not_found', message: `no bus "${busId}"` } }; }
			const expectBusKey = busKeyForBus(view.bus);
			if (String(bundle.busKey) !== expectBusKey) { reply.code(400); return { error: { code: 'bus_key_mismatch', message: 'proof busKey does not match this bus.' } }; }
			if (typeof acceptRoot === 'function' && !acceptRoot(bundle.merkleRoot)) { reply.code(400); return { error: { code: 'unknown_root', message: 'identity-tree root is not currently accepted.' } }; }
			let valid = false;
			try { valid = await verifyProof(bundle); } catch { valid = false; }
			if (!valid) { reply.code(400); return { error: { code: 'invalid_proof', message: 'membership proof did not verify.' } }; }
			let res;
			try {
				res = joinBus(busDb, {
					busId,
					nullifier: bundle.nullifier,
					handle: normaliseBusHandle(body.handle),
					note: normaliseNote(body.note),
					fillTtlMs,
					departWindowMs
				});
			} catch (err) {
				// Lost the dedupe race or the bus closed between verify and claim.
				const used = /nullifier_used/u.test(err.message);
				reply.code(used ? 409 : 400);
				return { error: { code: used ? 'seat_taken' : 'seat_refused', message: err.message } };
			}
			reply.code(201);
			return {
				joined: true,
				owner_token: res.ownerToken,
				owner_token_note: 'Save this token. It authorises board/leave on your seat and is shown only once.',
				seat: buildSeatSummary(res.seat),
				bus: buildBusSummary(res.bus, { boarded: res.boarded, departed: res.departed }),
				caveats: BUS_CAVEATS
			};
		}

		// ── default anonymous path (public good): find-or-create + seat ──
		let route; let amountZat; let minPassengers;
		try {
			route = validateBusRoute({ kind: body.kind, to: body.to });
			amountZat = validateAmount(Number(body.amount ?? body.amountZec), { popular: null });
			minPassengers = validateMinPassengers(body.minPassengers);
		} catch (err) { reply.code(400); return { error: { code: 'invalid_request', message: err.message } }; }
		const res = joinBus(busDb, {
			route: route.route,
			fromAsset: route.from,
			toAsset: route.to,
			amountZat,
			minPassengers,
			handle: normaliseBusHandle(body.handle),
			note: normaliseNote(body.note),
			fillTtlMs,
			departWindowMs
		});
		reply.code(201);
		return {
			joined: true,
			owner_token: res.ownerToken,
			owner_token_note: 'Save this token. It authorises board/leave on your seat and is shown only once.',
			seat: buildSeatSummary(res.seat),
			bus: buildBusSummary(res.bus, { boarded: res.boarded, departed: res.departed }),
			caveats: BUS_CAVEATS
		};
	});

	const seatAction = (status) => async (req, reply) => {
		if (!busDb) return disabled(reply);
		const body = req.body ?? {};
		const token = body.ownerToken ?? req.headers['x-bus-token'];
		const res = setSeatStatus(busDb, { seatId: req.params.id, token, status, departWindowMs });
		if (!res.ok) {
			reply.code(/authoris/u.test(res.reason ?? '') ? 403 : 400);
			return { ok: false, error: { code: 'seat_action_failed', message: res.reason } };
		}
		return {
			ok: true,
			seat: buildSeatSummary(res.seat),
			bus: res.bus ? buildBusSummary(res.bus, { boarded: res.boarded, departed: res.departed }) : null
		};
	};
	app.post('/v1/zec/bus/seat/:id/board', seatAction('boarded'));
	app.post('/v1/zec/bus/seat/:id/leave', seatAction('left'));

	return { busDb };
}

export default registerZcashBusRoutes;
