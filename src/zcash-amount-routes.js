// Zcash amount-privacy advisor — free REST surface.
//
// Two GET routes, both free (privacy guidance is a public good — charging
// people to be private is the wrong incentive):
//
//   GET /v1/zec/amount-advice    suggestions + round-trip risk for an amount
//   GET /v1/zec/popular-amounts  the live popular-amount histogram (or bundled)
//
// Both reuse the pure advisor (zcash-amount-privacy.js) and, when the operator
// has enabled + populated the shield-amount index (zcash-shield-index.js), the
// live on-chain popularity feed. With no index they degrade to the bundled
// COMMON_AMOUNTS_ZEC list and say so via `blend_in_source`.

import gatewayConfig from './config.js';
import {
	buildAmountAdvice,
	parseAmountList,
	COMMON_AMOUNTS_ZEC
} from './zcash-amount-privacy.js';
import {
	openSharedShieldIndexDb,
	buildPopularFeed,
	exactCount,
	statsSnapshot,
	SHIELD_SIDES,
	DEFAULT_POPULAR_LIMIT
} from './zcash-shield-index.js';

const MAX_LIMIT = 64;
const MAX_NOTES = 200;

function resolveIndexDb(opts, config) {
	if (opts.indexDb !== undefined) return opts.indexDb; // injected (tests) — may be null
	if (!config.zecShieldIndexEnabled) return null;
	return openSharedShieldIndexDb(config.zecShieldIndexDbPath);
}

/** Pull the live popularity feed for a side near a target, or null. */
function liveFeed(db, { side, nearZat = null, limit = DEFAULT_POPULAR_LIMIT }) {
	if (!db) return null;
	try {
		const feed = buildPopularFeed(db, { side, nearZat, limit });
		return feed.length ? feed : null;
	} catch {
		return null;
	}
}

/**
 * Mount the advisor routes on a Fastify app.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @param {object|null} [opts.indexDb]  inject an open index DB (tests)
 */
export function registerZcashAmountRoutes(app, opts = {}) {
	const config = opts.config ?? gatewayConfig;
	const indexDb = resolveIndexDb(opts, config);

	app.get('/v1/zec/amount-advice', async (req, reply) => {
		const q = req.query ?? {};
		const amountZec = Number(q.amount);
		if (!Number.isFinite(amountZec) || amountZec <= 0) {
			reply.code(400);
			return { error: { code: 'invalid_request', message: 'amount must be a positive number of ZEC' } };
		}
		const action = q.action === 'shield' ? 'shield' : 'deshield';
		const count = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(q.count, 10) || 6));
		const noteAmountsZec = q.notes ? parseAmountList(String(q.notes)).slice(0, MAX_NOTES) : [];
		// Live feed near the target so the suggestions are genuinely nearby.
		const indexSide = action === 'shield' ? 'shield' : 'deshield';
		const popular = liveFeed(indexDb, { side: indexSide, nearZat: Math.round(amountZec * 1e8) });

		const advice = buildAmountAdvice({ amountZec, action, noteAmountsZec, popular, count });
		// When the index is live, annotate the exact "N others did this" count.
		if (indexDb) {
			try { advice.others_used_exact = exactCount(indexDb, { side: indexSide, amountZat: advice.amount_zats }); }
			catch { /* degrade silently */ }
		}
		return advice;
	});

	app.get('/v1/zec/popular-amounts', async (req, reply) => {
		const q = req.query ?? {};
		const side = SHIELD_SIDES.includes(q.side) ? q.side : 'deshield';
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(q.limit, 10) || DEFAULT_POPULAR_LIMIT));
		const nearZat = q.near != null && q.near !== '' && Number.isFinite(Number(q.near))
			? Math.round(Number(q.near) * 1e8)
			: null;
		const feed = liveFeed(indexDb, { side, nearZat, limit });
		if (feed) {
			return {
				side,
				source: 'live_index',
				amounts: feed,
				stats: statsSnapshot(indexDb)
			};
		}
		reply.header('cache-control', 'public, max-age=300');
		return {
			side,
			source: 'bundled_list',
			amounts: COMMON_AMOUNTS_ZEC.map((zec) => ({ zec, zats: Math.round(zec * 1e8), count: null })),
			note: config.zecShieldIndexEnabled
				? 'On-chain index not populated yet; returning the curated blend-in list.'
				: 'On-chain index disabled on this server; returning the curated blend-in list.'
		};
	});

	return { indexDb };
}

export default registerZcashAmountRoutes;
