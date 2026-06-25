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
	validateRoute,
	validateAmount,
	validateMinPassengers,
	normaliseBusHandle,
	normaliseNote,
	buildBusSummary,
	buildSeatSummary,
	verifyOwner
} from './zcash-bus.js';
import {
	openSharedBusDb,
	listBusViews,
	getBusView,
	getSeatRow,
	joinBus,
	setSeatStatus,
	statsSnapshot as busStatsSnapshot
} from './zcash-bus-store.js';

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
 */
export function registerZcashBusRoutes(app, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const busDb = resolveBusDb(opts, config);
	const fillTtlMs = config.zecBusFillTtlMs ?? BUS_CONSTANTS.FILL_TTL_MS;
	const departWindowMs = config.zecBusDepartWindowMs ?? BUS_CONSTANTS.DEPART_WINDOW_MS;

	const disabled = (reply) => {
		reply.code(503);
		return { error: { code: 'bus_not_enabled', message: 'Bus coordination is not enabled on this server.' } };
	};

	app.get('/v1/zec/bus', async (req, reply) => {
		if (!busDb) return disabled(reply);
		const q = req.query ?? {};
		let route = null;
		if (q.to) {
			try { route = validateRoute({ to: q.to }).route; }
			catch (err) { reply.code(400); return { error: { code: 'bad_route', message: err.message } }; }
		}
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

	app.post('/v1/zec/bus/join', async (req, reply) => {
		if (!busDb) return disabled(reply);
		const body = req.body ?? {};
		let route; let amountZat; let minPassengers;
		try {
			route = validateRoute({ to: body.to });
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
