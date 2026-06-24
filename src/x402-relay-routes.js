// REST surface for the x402 payer relay.
//
//   GET  /v1/pay                 free: relay metadata (fee, caps, payer addr)
//   POST /v1/pay                 spend prepaid credit at an x402 endpoint
//   GET  /v1/pay/:id             fetch a receipt (auth: x-watch-token)
//
// Auth is the same watchId + watchToken pair that funds the account; the call
// itself is free (the cost is the relayed payment + fee debited from the
// prepaid balance). Heavily rate-limited per IP because each POST does an
// outbound network call and an on-chain settlement.

import { validateRelayRequest } from './x402-relay.js';

/**
 * Mount the relay routes onto `app`.
 *
 * deps:
 *   - service   createX402RelayService instance (REQUIRED)
 *   - rateMax   per-IP POST budget per minute (default 30)
 *   - log       optional logger
 */
export function registerX402RelayRoutes(app, deps = {}) {
	const { service, rateMax = 30, log = { info() {}, warn() {}, error() {} } } = deps;
	if (!service || typeof service.relay !== 'function') {
		throw new Error('registerX402RelayRoutes: service is required');
	}

	app.get('/v1/pay', async () => service.info());

	app.post('/v1/pay', { config: { rateLimit: { max: rateMax, timeWindow: '1 minute' } } }, async (req, reply) => {
		if (!service.enabled()) {
			return reply.code(503).send({
				error: { code: 'relay_not_configured', message: 'x402 relay is not enabled on this server.' }
			});
		}
		const body = req.body ?? {};
		const watchId = body.watchId ?? req.headers['x-watch-id'];
		const watchToken = body.watchToken ?? req.headers['x-watch-token'];
		if (typeof watchId !== 'string' || typeof watchToken !== 'string' || !watchId || !watchToken) {
			return reply.code(400).send({
				error: { code: 'invalid_request', message: 'watchId and watchToken are required (body or x-watch-id/x-watch-token headers)' }
			});
		}

		let validated;
		try { validated = validateRelayRequest(body, { maxPerCallAtomic: service.limits.maxPerCallAtomic }); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		const result = await service.relay({ ...validated, watchId, watchToken });
		if (!result.ok) {
			const status = result.error?.httpStatus ?? 502;
			return reply.code(status).send({
				error: { code: result.error?.code ?? 'relay_failed', message: result.error?.message ?? 'relay failed' },
				receipt: result.receipt ?? null
			});
		}
		return reply.code(200).send({
			ok: true,
			replayed: result.replayed ?? false,
			receipt: result.receipt,
			balance_usd: result.balance_usd ?? null,
			response: result.response ?? null
		});
	});

	app.get('/v1/pay/:id', async (req, reply) => {
		const watchId = req.query?.watchId ?? req.headers['x-watch-id'];
		const watchToken = req.headers['x-watch-token'] ?? req.query?.watchToken;
		if (typeof watchId !== 'string' || typeof watchToken !== 'string' || !watchId || !watchToken) {
			return reply.code(400).send({
				error: { code: 'invalid_request', message: 'pass watchId (query) and watchToken (x-watch-token header)' }
			});
		}
		const out = service.getReceipt({ watchId, watchToken, id: req.params.id });
		if (out.error) {
			return reply.code(out.error.httpStatus ?? 404).send({ error: { code: out.error.code, message: out.error.message } });
		}
		return out.receipt;
	});

	return { mounted: true };
}

export default registerX402RelayRoutes;
