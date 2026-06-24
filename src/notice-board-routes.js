// Paid notice board — Fastify routes.
//
// Surface:
//   GET    /v1/board                      list boards + counts + pricing (free)
//   GET    /v1/board/:board               ranked notices, paginated      (free)
//   GET    /v1/board/:board/:id           one notice (+ its thread)       (free)
//   POST   /v1/board/:board               post a notice (free, rate-limited)
//   POST   /v1/board/:board/:id/reply     reply in a thread (free, rate-limited)
//   POST   /v1/board/:board/:id/boost     pay any amount to rank higher  (x402)
//   PATCH  /v1/board/:board/:id           edit (owner token)
//   DELETE /v1/board/:board/:id           withdraw (owner) / remove (admin key)
//   POST   /v1/board/:board/:id/report    flag for review (free, rate-limited)
//
// Threads are one level deep: a root notice plus replies. Replies are free,
// never boosted, and ride under their root (the list shows roots with inlined
// replies; the single-notice GET returns the full thread).
//
// The boost route reuses the gateway's variable-amount x402 settle dance
// (encodeChallenge / verify / settle) from private-watch-custom.js, so a
// payer can attach any amount between the configured min and max. Anyone
// can boost any notice — "money is the upvote".

import {
	BOARD_CONSTANTS,
	normaliseBoards,
	validatePostRequest,
	validateReplyRequest,
	validateBoostAmount,
	sanitiseText,
	validateUrl,
	sortNotices,
	buildNoticeSummary,
	buildBoardRss,
	buildBoardJsonFeed,
	atomicToUsd,
	verifyOwner,
	safeEqualHex,
	hashToken
} from './notice-board.js';
import {
	createNotice,
	getNotice,
	listNotices,
	listReplies,
	countReplies,
	replyCountsForBoard,
	boostNotice,
	editNotice,
	withdrawNotice,
	removeNotice,
	reportNotice,
	statsSnapshot,
	topBoostedNotices,
	pruneOld
} from './notice-board-store.js';
import {
	buildCustomPaymentRequirements,
	encodeChallenge,
	decodePaymentHeader
} from './private-watch-custom.js';
import { createFacilitatorClient } from './x402.js';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

async function defaultFacilitatorFactory(x402Cfg) {
	return createFacilitatorClient(x402Cfg);
}

function clampInt(value, lo, hi, fallback) {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Mount the notice-board routes on `app`.
 *
 * deps:
 *   - boardDb           open notice-board SQLite (null → routes answer 503)
 *   - x402Cfg           paywall config (boost needs enabled:true)
 *   - boards            host board list (array) or a normalised Map
 *   - adminKey          operator removal key (empty → admin remove disabled)
 *   - facilitatorFactory(x402Cfg) → client  (test override)
 *   - freePostRateMax / freePostRateWindow  free-post throttle
 *   - reportRateMax     report throttle
 *   - log / now         injectables
 *
 * Returns { boardDb, boards, buildNoticeBoardStats }.
 */
export function registerNoticeBoardRoutes(app, deps = {}) {
	const {
		boardDb = null,
		x402Cfg = null,
		adminKey = '',
		facilitatorFactory = defaultFacilitatorFactory,
		freePostRateMax = 6,
		freePostRateWindow = '1 hour',
		reportRateMax = 30,
		// Human-facing board site (for feed item links). Null → feed links
		// point at the API single-notice resource instead.
		webBoardBaseUrl = null,
		log = NOOP_LOG,
		now = () => Date.now()
	} = deps;

	const boards = deps.boards instanceof Map ? deps.boards : normaliseBoards(deps.boards);

	function boardUnavailable(reply) {
		reply.code(503).send({
			error: { code: 'notice_board_unavailable', message: 'The notice board has no writable database on this server.' }
		});
		return reply;
	}

	function knownBoard(reply, boardId) {
		if (boards.has(boardId)) return true;
		reply.code(404).send({ error: { code: 'unknown_board', message: `no board "${boardId}"; see GET /v1/board` } });
		return false;
	}

	let facilitatorP = null;
	function getFacilitator() {
		if (!x402Cfg?.enabled) throw new Error('x402 paywall disabled; cannot dispatch to facilitator');
		if (!facilitatorP) facilitatorP = Promise.resolve(facilitatorFactory(x402Cfg));
		return facilitatorP;
	}

	const boostRange = {
		min_usd: atomicToUsd(BOARD_CONSTANTS.BOOST_MIN_ATOMIC),
		max_usd: atomicToUsd(BOARD_CONSTANTS.BOOST_MAX_ATOMIC),
		min_atomic: String(BOARD_CONSTANTS.BOOST_MIN_ATOMIC),
		max_atomic: String(BOARD_CONSTANTS.BOOST_MAX_ATOMIC)
	};

	// ── GET /v1/board — board catalogue ──────────────────────────
	app.get('/v1/board', async () => {
		const snap = boardDb ? statsSnapshot(boardDb) : { boards: {}, total_live: 0, total_paid: 0 };
		return {
			boards: [...boards.values()].map((b) => ({
				id: b.id,
				title: b.title,
				description: b.description,
				live: snap.boards?.[b.id]?.live ?? 0,
				paid: snap.boards?.[b.id]?.paid ?? 0,
				replies: snap.boards?.[b.id]?.replies ?? 0,
				read: `GET /v1/board/${b.id}`,
				post: `POST /v1/board/${b.id}`,
				feed_rss: `GET /v1/board/${b.id}/feed.xml`,
				feed_json: `GET /v1/board/${b.id}/feed.json`
			})),
			totals: { live: snap.total_live ?? 0, replies: snap.total_replies ?? 0, paid: snap.total_paid ?? 0 },
			leaderboard: 'GET /v1/board/leaderboard',
			posting: {
				free: true,
				free_rate_limit: `${freePostRateMax} per ${freePostRateWindow} per IP`,
				reply_endpoint: 'POST /v1/board/{board}/{id}/reply',
				boost_endpoint: 'POST /v1/board/{board}/{id}/boost',
				boost: boostRange,
				model: 'Free to post (lands at the bottom). Reply to any notice to start a thread (free, one level deep). Attach USDC via x402 to rank a thread higher — anyone can boost any root notice, and boosts decay gently over time so the board stays fresh.'
			}
		};
	});

	// ── GET /v1/board/leaderboard — top-boosted across all boards ─
	// Static segment "leaderboard" out-prioritises the :board param in
	// Fastify's router, so this never collides with a real board slug.
	app.get('/v1/board/leaderboard', async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const nowMs = now();
		const limit = clampInt((req.query ?? {}).limit, 1, 100, 20);
		const rows = topBoostedNotices(boardDb, { limit });
		const snap = statsSnapshot(boardDb);
		return {
			as_of_ms: nowMs,
			totals: {
				live: snap.total_live ?? 0,
				paid: snap.total_paid ?? 0,
				weight_atomic: snap.total_weight_atomic ?? '0',
				weight_usd: atomicToUsd(snap.total_weight_atomic ?? 0)
			},
			top: rows.map((r) => buildNoticeSummary(r, { nowMs }))
		};
	});

	// Project a root row to its public summary plus its thread: an inline
	// (capped) slice of replies and the true reply_count. `inlineCap` keeps
	// the list payload bounded; the single-notice GET passes the full cap.
	function summariseThread(row, { nowMs, replyCount = null, inlineCap = BOARD_CONSTANTS.REPLIES_INLINE_CAP }) {
		const summary = buildNoticeSummary(row, { nowMs });
		const total = replyCount == null ? countReplies(boardDb, row.id) : replyCount;
		summary.reply_count = total;
		summary.replies = total > 0
			? listReplies(boardDb, row.id, { limit: inlineCap }).map((r) => buildNoticeSummary(r, { nowMs }))
			: [];
		return summary;
	}

	// ── GET /v1/board/:board — ranked list ───────────────────────
	app.get('/v1/board/:board', async (req, reply) => {
		const boardId = String(req.params.board).toLowerCase();
		if (!knownBoard(reply, boardId)) return reply;
		if (!boardDb) return boardUnavailable(reply);
		const q = req.query ?? {};
		const limit = clampInt(q.limit, 1, BOARD_CONSTANTS.LIST_MAX_LIMIT, BOARD_CONSTANTS.LIST_DEFAULT_LIMIT);
		const offset = clampInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
		const nowMs = now();
		const all = listNotices(boardDb, { board: boardId, status: 'live' });
		const page = sortNotices(all, { nowMs }).slice(offset, offset + limit);
		const replyCounts = replyCountsForBoard(boardDb, boardId);
		return {
			board: { ...boards.get(boardId) },
			count: all.length,
			limit,
			offset,
			notices: page.map((r) => summariseThread(r, { nowMs, replyCount: replyCounts.get(r.id) ?? 0 }))
		};
	});

	// ── GET /v1/board/:board/feed.{xml,json} — subscribe ─────────
	// Static last-segment ("feed.xml"/"feed.json") out-prioritises the
	// :id param route below, so a notice can never be named "feed.xml".
	function feedPage(boardId, req) {
		const nowMs = now();
		const all = listNotices(boardDb, { board: boardId, status: 'live' });
		const notices = sortNotices(all, { nowMs })
			.slice(0, BOARD_CONSTANTS.LIST_DEFAULT_LIMIT)
			.map((r) => buildNoticeSummary(r, { nowMs }));
		const apiBase = `${req.protocol}://${req.hostname}`;
		return { board: { ...boards.get(boardId) }, notices, apiBase, nowMs };
	}

	app.get('/v1/board/:board/feed.xml', async (req, reply) => {
		const boardId = String(req.params.board).toLowerCase();
		if (!knownBoard(reply, boardId)) return reply;
		if (!boardDb) return boardUnavailable(reply);
		const { board, notices, apiBase, nowMs } = feedPage(boardId, req);
		const xml = buildBoardRss({
			board, notices, apiBase, nowMs,
			siteUrl: webBoardBaseUrl,
			feedUrl: `${apiBase}/v1/board/${boardId}/feed.xml`
		});
		return reply.type('application/rss+xml; charset=utf-8').send(xml);
	});

	app.get('/v1/board/:board/feed.json', async (req, reply) => {
		const boardId = String(req.params.board).toLowerCase();
		if (!knownBoard(reply, boardId)) return reply;
		if (!boardDb) return boardUnavailable(reply);
		const { board, notices, apiBase } = feedPage(boardId, req);
		return reply.type('application/feed+json; charset=utf-8').send(buildBoardJsonFeed({
			board, notices, apiBase,
			siteUrl: webBoardBaseUrl,
			feedUrl: `${apiBase}/v1/board/${boardId}/feed.json`
		}));
	});

	// ── GET /v1/board/:board/:id — single notice (+ thread) ──────
	app.get('/v1/board/:board/:id', async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const boardId = String(req.params.board).toLowerCase();
		const row = getNotice(boardDb, req.params.id);
		if (!row || row.board !== boardId || row.status === 'removed') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		}
		const nowMs = now();
		// A reply is returned in the context of its whole thread (resolve to
		// the root and include every sibling), so a deep-link to any reply
		// still shows the conversation.
		if (row.parent_id) {
			const root = getNotice(boardDb, row.parent_id);
			if (root && root.status !== 'removed') {
				return summariseThread(root, { nowMs, inlineCap: BOARD_CONSTANTS.REPLIES_MAX });
			}
			return buildNoticeSummary(row, { nowMs });
		}
		return summariseThread(row, { nowMs, inlineCap: BOARD_CONSTANTS.REPLIES_MAX });
	});

	// ── POST /v1/board/:board — free post (rate-limited) ─────────
	app.post('/v1/board/:board', {
		config: { rateLimit: { max: freePostRateMax, timeWindow: freePostRateWindow } }
	}, async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		let input;
		try {
			input = validatePostRequest({ ...(req.body ?? {}), board: String(req.params.board).toLowerCase() }, { boards });
		} catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const nowMs = now();
		try { pruneOld(boardDb, { nowMs }); }
		catch (err) { log.warn?.({ err: err?.message ?? String(err) }, 'notice-board: prune failed'); }
		const created = createNotice(boardDb, { ...input, nowMs });
		log.info?.({ board: input.board, id: created.id }, 'notice-board: posted');
		return reply.code(201).send({
			id: created.id,
			ownerToken: created.token,
			board: input.board,
			title: input.title,
			status: 'live',
			weight_atomic: '0',
			boostEndpoint: `/v1/board/${input.board}/${created.id}/boost`,
			manageWith: 'PATCH or DELETE /v1/board/{board}/{id} with header x-notice-token: <ownerToken>',
			note: 'Live at the bottom of the board. Boost it (POST .../boost with an x402 payment, any amount) to rank higher — anyone can boost, so a good notice can rise on others\u2019 support. Keep the ownerToken to edit or withdraw.'
		});
	});

	// ── POST /v1/board/:board/:id/reply — thread reply (free) ────
	app.post('/v1/board/:board/:id/reply', {
		config: { rateLimit: { max: freePostRateMax, timeWindow: freePostRateWindow } }
	}, async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const boardId = String(req.params.board).toLowerCase();
		if (!knownBoard(reply, boardId)) return reply;
		const target = getNotice(boardDb, req.params.id);
		if (!target || target.board !== boardId || target.status === 'removed') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		}
		// Collapse to one level: a reply always attaches to the thread root.
		const rootId = target.parent_id ?? target.id;
		const root = target.parent_id ? getNotice(boardDb, rootId) : target;
		if (!root || root.status !== 'live') {
			return reply.code(409).send({ error: { code: 'thread_unavailable', message: 'the thread is not open for replies' } });
		}
		let input;
		try {
			input = validateReplyRequest(req.body ?? {}, { parent: root });
		} catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const nowMs = now();
		try { pruneOld(boardDb, { nowMs }); }
		catch (err) { log.warn?.({ err: err?.message ?? String(err) }, 'notice-board: prune failed'); }
		const created = createNotice(boardDb, { ...input, parentId: rootId, nowMs });
		log.info?.({ board: input.board, id: created.id, parent: rootId }, 'notice-board: replied');
		return reply.code(201).send({
			id: created.id,
			ownerToken: created.token,
			board: input.board,
			parent_id: rootId,
			title: input.title,
			status: 'live',
			manageWith: 'PATCH or DELETE /v1/board/{board}/{id} with header x-notice-token: <ownerToken>',
			note: 'Reply is live under its thread. Keep the ownerToken to edit or withdraw it. Replies are free and are not boosted — boost the thread root to rank the whole conversation higher.'
		});
	});

	// ── POST /v1/board/:board/:id/boost — variable-price x402 ────
	app.post('/v1/board/:board/:id/boost', async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		if (!x402Cfg?.enabled) {
			return reply.code(503).send({ error: { code: 'paywall_not_configured', message: 'Boosting requires the operator to enable x402 (set X402_RECIPIENT_ADDRESS).' } });
		}
		const boardId = String(req.params.board).toLowerCase();
		const row = getNotice(boardDb, req.params.id);
		if (!row || row.board !== boardId || row.status === 'removed') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		}
		if (row.parent_id) {
			return reply.code(409).send({ error: { code: 'cannot_boost_reply', message: 'Replies are not boosted — boost the thread root instead.' } });
		}
		if (row.status !== 'live') {
			return reply.code(409).send({ error: { code: 'not_live', message: `notice is ${row.status}; cannot boost` } });
		}
		let amountAtomic;
		try { amountAtomic = validateBoostAmount((req.body ?? {}).amountAtomic); }
		catch (err) { return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } }); }

		const requirements = buildCustomPaymentRequirements({ x402Cfg, amountAtomic });
		const description = `Boost notice ${row.id} on board "${boardId}" by $${atomicToUsd(amountAtomic)} (${amountAtomic} atomic USDC). Higher cumulative boost ranks higher. Body: { amountAtomic }. Range ${BOARD_CONSTANTS.BOOST_MIN_ATOMIC}-${BOARD_CONSTANTS.BOOST_MAX_ATOMIC} atomic.`;
		const resourceUrl = `${req.protocol}://${req.hostname}/v1/board/${boardId}/${row.id}/boost`;
		const challenge = encodeChallenge({ resourceUrl, description, accepts: requirements });

		const xPayment = req.headers['x-payment'];
		if (!xPayment) {
			return reply.code(402).header('payment-required', challenge).send({});
		}
		const payload = decodePaymentHeader(xPayment);
		if (!payload) {
			return reply.code(400).send({ error: { code: 'invalid_payment_header', message: 'x-payment is not valid base64 JSON' } });
		}
		const sentValue = String(payload?.payload?.authorization?.value ?? '');
		if (sentValue !== String(amountAtomic)) {
			return reply.code(400).send({ error: { code: 'amount_mismatch', message: `x-payment value (${sentValue}) does not match amountAtomic (${amountAtomic})` } });
		}

		let facilitator;
		try { facilitator = await getFacilitator(); }
		catch (err) {
			log.error?.({ err: err?.message ?? String(err) }, 'notice-board boost: facilitator init failed');
			return reply.code(503).send({ error: { code: 'facilitator_unavailable', message: 'payment facilitator could not be initialised' } });
		}
		let verifyResult;
		try { verifyResult = await facilitator.verify(payload, requirements); }
		catch (err) {
			log.warn?.({ err: err?.message ?? String(err) }, 'notice-board boost: verify threw');
			return reply.code(502).send({ error: { code: 'verify_failed', message: err?.message ?? 'facilitator verify threw' } });
		}
		if (!verifyResult?.isValid) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_verification_failed', message: verifyResult?.invalidReason ?? 'facilitator rejected signature' } });
		}
		let settleResult;
		try { settleResult = await facilitator.settle(payload, requirements); }
		catch (err) {
			log.warn?.({ err: err?.message ?? String(err) }, 'notice-board boost: settle threw');
			return reply.code(502).send({ error: { code: 'settle_failed', message: err?.message ?? 'facilitator settle threw' } });
		}
		if (!settleResult?.success) {
			return reply.code(402).header('payment-required', challenge)
				.send({ error: { code: 'payment_settle_failed', message: settleResult?.errorReason ?? 'facilitator settle did not succeed' } });
		}
		reply.header('x-payment-response', Buffer.from(JSON.stringify(settleResult)).toString('base64'));

		const out = boostNotice(boardDb, row.id, { addWeightAtomic: amountAtomic, nowMs: now() });
		if (!out.ok) {
			log.error?.({ id: row.id, reason: out.reason, settlement: settleResult }, 'notice-board boost: payment captured but boost failed');
			return reply.code(409).send({
				error: {
					code: `${out.reason}_after_payment`,
					message: 'payment captured but the boost could not be applied — contact the operator with the settlement payload',
					captured: { amountAtomic: String(amountAtomic), settlement: settleResult }
				}
			});
		}
		log.info?.({ id: row.id, amountAtomic: String(amountAtomic), newWeightAtomic: out.row.weight_atomic }, 'notice-board: boosted');
		return buildNoticeSummary(out.row, { nowMs: now() });
	});

	// ── PATCH /v1/board/:board/:id — owner edit ──────────────────
	app.patch('/v1/board/:board/:id', async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const row = getNotice(boardDb, req.params.id);
		if (!row || row.status === 'removed') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		}
		const token = req.headers['x-notice-token'] ?? (req.body ?? {}).ownerToken;
		if (!verifyOwner(row, token)) {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch' } });
		}
		const body = req.body ?? {};
		const title = body.title != null ? sanitiseText(body.title, BOARD_CONSTANTS.TITLE_MAX) : row.title;
		if (title.length < BOARD_CONSTANTS.TITLE_MIN) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: `title must be ${BOARD_CONSTANTS.TITLE_MIN}+ characters` } });
		}
		const text = body.body != null ? sanitiseText(body.body, BOARD_CONSTANTS.BODY_MAX) : row.body;
		if (text.length < BOARD_CONSTANTS.BODY_MIN) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: 'body is required' } });
		}
		let url = row.url;
		if (body.url !== undefined) {
			try { url = validateUrl(body.url); }
			catch (err) { return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } }); }
		}
		const contact = body.contact !== undefined
			? (sanitiseText(body.contact, BOARD_CONSTANTS.CONTACT_MAX) || null)
			: row.contact;
		const res = editNotice(boardDb, row.id, token, { title, body: text, url, contact });
		if (!res.ok) {
			const code = res.reason === 'forbidden' ? 403 : res.reason === 'not_found' ? 404 : 409;
			return reply.code(code).send({ error: { code: res.reason } });
		}
		return buildNoticeSummary(res.row, { nowMs: now() });
	});

	// ── DELETE /v1/board/:board/:id — withdraw / admin remove ────
	app.delete('/v1/board/:board/:id', async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const row = getNotice(boardDb, req.params.id);
		if (!row || row.status === 'removed') {
			return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		}
		const suppliedAdmin = req.headers['x-admin-key'];
		if (adminKey && typeof suppliedAdmin === 'string' && safeEqualHex(hashToken(suppliedAdmin), hashToken(adminKey))) {
			removeNotice(boardDb, row.id, { reason: (req.query ?? {}).reason ?? 'operator' });
			log.info?.({ id: row.id }, 'notice-board: operator removed');
			return { removed: true, by: 'operator' };
		}
		const token = req.headers['x-notice-token'] ?? (req.body ?? {}).ownerToken;
		const res = withdrawNotice(boardDb, row.id, token);
		if (!res.ok) {
			const code = res.reason === 'forbidden' ? 403 : 404;
			return reply.code(code).send({ error: { code: res.reason } });
		}
		return { removed: true, by: 'owner' };
	});

	// ── POST /v1/board/:board/:id/report — flag for review ───────
	app.post('/v1/board/:board/:id/report', {
		config: { rateLimit: { max: reportRateMax, timeWindow: '1 hour' } }
	}, async (req, reply) => {
		if (!boardDb) return boardUnavailable(reply);
		const row = getNotice(boardDb, req.params.id);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'notice not found' } });
		const res = reportNotice(boardDb, row.id);
		return { reported: true, status: res.status ?? row.status };
	});

	function buildNoticeBoardStats({ topLimit = 8 } = {}) {
		if (!boardDb) return { enabled: false, reason: 'notice board DB not opened' };
		const nowMs = now();
		const snap = statsSnapshot(boardDb);
		return {
			enabled: true,
			boards: [...boards.values()].map((b) => ({
				id: b.id,
				title: b.title,
				description: b.description,
				live: snap.boards?.[b.id]?.live ?? 0,
				replies: snap.boards?.[b.id]?.replies ?? 0,
				paid: snap.boards?.[b.id]?.paid ?? 0,
				weight_usd: atomicToUsd(snap.boards?.[b.id]?.weight_atomic ?? 0)
			})),
			totals: {
				live: snap.total_live,
				replies: snap.total_replies,
				paid: snap.total_paid,
				weight_atomic: snap.total_weight_atomic,
				weight_usd: atomicToUsd(snap.total_weight_atomic ?? 0)
			},
			// Cross-board "what people are paying to surface" — drives the
			// stats-page leaderboard panel without a second request.
			top: topBoostedNotices(boardDb, { limit: topLimit }).map((r) => buildNoticeSummary(r, { nowMs })),
			boost: boostRange
		};
	}

	return { boardDb, boards, buildNoticeBoardStats };
}

export default registerNoticeBoardRoutes;
