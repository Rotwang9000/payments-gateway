// Ziving — JustGiving-style Zcash fundraising pages.
//
// Built on the donation-overlay UFVK scanner: fundraisers register a
// read-only view key + receive address, pick a public slug, and donors pay
// them directly. We store as little as possible (encrypted UFVK, address,
// optional label/story/goal). Scanning is prepaid in ZEC via memo quotes.
//
// Surface:
//   GET  /v1/ziving                         metadata + pricing (scan + homepage feature)
//   GET  /v1/ziving/featured                homepage-promoted campaigns
//   GET  /v1/ziving/activity                latest confirmed gifts + newest pages (homepage feed)
//   POST /v1/ziving/page                    create campaign (rate-limited)
//   GET  /v1/ziving/page/:slug              public page data + totals
//   GET  /v1/ziving/page/:slug/events       donation feed (cursor-paginated)
//   POST /v1/ziving/page/:slug/feature      owner token → ZEC quote for homepage promo
//   POST /v1/ziving/page/:slug/recover      re-present UFVK → new ownerToken (wallet unlock)
//
// Management (top-up, cancel) reuses /v1/overlay/:id with the owner token.

import { randomUUID } from 'node:crypto';

import { atomicToUsdString } from 'viewkey-watch/private-watch';
import { createQuote } from 'viewkey-watch/crypto-topup-store';
import { formatCoinAmount } from 'viewkey-watch/crypto-price';

import { sanitiseText } from './notice-board.js';
import { allocateQuoteAmount, formatUsdCents } from './private-watch-crypto-topup.js';
import {
	OVERLAY_CONSTANTS,
	ensureDonationOverlaySchema,
	createOverlay,
	getOverlay,
	getOverlayBySlug,
	getOverlayAuthorised,
	listEventsSince,
	listRecentCampaignDonations,
	listRecentCampaigns,
	normaliseCampaignSlug,
	sumConfirmedDonations,
	listFeaturedCampaigns,
	createFeatureQuote,
	featureUsdCentsForDays,
	recoverOverlayOwnerByUfvk
} from './donation-overlay-store.js';
import {
	OVERLAY_CREATE_PER_IP_PER_MIN,
	publicOverlay,
	publicOverlayQuote,
	validateOverlayCreateRequest
} from './donation-overlay-routes.js';
import { OVERLAY_CONFIRMATIONS_DEFAULT } from './donation-overlay-poller.js';

const ZATOSHI_PER_ZEC = 100_000_000;
/** Recover is cheaper than create but still UFVK-sensitive — keep tight. */
const OVERLAY_RECOVER_PER_IP_PER_MIN = 10;

/**
 * Validate POST /v1/ziving/page. Extends overlay credentials with a
 * required slug and optional public story + goal.
 */
export function validateZivingPageRequest(body, policy) {
	const base = validateOverlayCreateRequest(body, policy);
	const slug = normaliseCampaignSlug(body.slug);
	let story = null;
	if (body.story !== undefined && body.story !== null && body.story !== '') {
		story = sanitiseText(body.story, OVERLAY_CONSTANTS.STORY_MAX_LEN);
		if (story.length === 0) story = null;
	}
	let goalZatoshi = null;
	if (body.goalZec !== undefined && body.goalZec !== null && body.goalZec !== '') {
		const z = Number(body.goalZec);
		if (!Number.isFinite(z) || z <= 0 || z > 1_000_000) {
			throw new TypeError('goalZec must be a positive number up to 1,000,000');
		}
		goalZatoshi = String(Math.round(z * ZATOSHI_PER_ZEC));
	}
	return Object.freeze({ ...base, slug, story, goalZatoshi });
}

/** Public campaign view — no UFVK, no owner token. */
export function publicCampaign(row, totals, { nowMs = Date.now(), urls = {} } = {}) {
	const overlay = publicOverlay(row, { nowMs });
	const totalZat = BigInt(totals?.totalZatoshi ?? '0');
	const goalZat = row.goal_zatoshi != null ? BigInt(row.goal_zatoshi) : null;
	const featuredUntil = row.featured_until_ms != null ? Number(row.featured_until_ms) : null;
	const featured = featuredUntil != null && featuredUntil > nowMs;
	return {
		slug: row.slug ?? null,
		overlayId: row.id,
		label: row.label ?? null,
		story: row.story ?? null,
		address: row.address,
		chain: row.chain,
		minZec: overlay.minZec,
		goalZec: goalZat != null ? Number(goalZat) / ZATOSHI_PER_ZEC : null,
		raised: {
			zec: Number(totalZat) / ZATOSHI_PER_ZEC,
			zatoshi: totalZat.toString(),
			donationCount: totals?.donationCount ?? 0,
			percentOfGoal: goalZat != null && goalZat > 0n
				? Math.min(100, Number((totalZat * 10000n) / goalZat) / 100)
				: null
		},
		featured,
		featured_until: featured ? new Date(featuredUntil).toISOString() : null,
		state: overlay.state,
		active: overlay.active,
		credit: overlay.credit,
		created_at: overlay.created_at,
		expires_at: overlay.expires_at,
		urls
	};
}

function publicEvent(row) {
	return {
		id: row.id,
		amountZec: Number(row.amount_atomic) / ZATOSHI_PER_ZEC,
		amountZatoshi: String(row.amount_atomic),
		memo: row.memo ?? null,
		status: row.status,
		confirmations: row.confirmations ?? 0,
		txHash: row.tx_hash ?? null,
		firstSeenAt: new Date(row.first_seen_ms).toISOString()
	};
}

/**
 * Mount Ziving routes on `app`. Shares the overlay deps bundle.
 * Returns { buildZivingStats }.
 */
export function registerZivingRoutes(app, deps) {
	const {
		watchDb,
		priceOracle,
		recvAddresses = {},
		policy,
		memoPrefix = 'PG',
		encryptViewKey,
		decryptViewKey,
		nfptHealth,
		zivingPageUrlBase = '',
		overlayPageUrlBase = '',
		privateWatchReady,
		privateNotConfigured,
		now = () => Date.now(),
		log = { info() {}, warn() {}, error() {} }
	} = deps;

	if (!privateWatchReady || !privateNotConfigured) {
		throw new Error('registerZivingRoutes: missing gate helpers');
	}
	if (!policy || typeof policy !== 'object') {
		throw new Error('registerZivingRoutes: policy is required');
	}

	if (watchDb) ensureDonationOverlaySchema(watchDb);

	const zecEnabled = () => typeof recvAddresses.zcash === 'string' && recvAddresses.zcash.length > 0;
	const ready = () => Boolean(privateWatchReady() && watchDb && priceOracle && typeof encryptViewKey === 'function');
	const recoverReady = () => Boolean(privateWatchReady() && watchDb && typeof decryptViewKey === 'function');
	const confirmationsRequired = policy.confirmations?.zcash ?? 8;

	function urlsFor(row) {
		const slug = row.slug;
		const base = zivingPageUrlBase ? zivingPageUrlBase.replace(/\/$/u, '') : '';
		const overlayBase = overlayPageUrlBase ? overlayPageUrlBase.replace(/\/$/u, '') : '';
		return {
			page: base && slug ? `${base}/p/${encodeURIComponent(slug)}` : null,
			events: slug ? `/v1/ziving/page/${encodeURIComponent(slug)}/events` : null,
			obsPage: overlayBase ? `${overlayBase}?overlay=${row.id}` : null,
			overlayEvents: `/v1/overlay/${row.id}/events`
		};
	}

	app.get('/v1/ziving', async () => {
		const info = {
			service: 'ziving',
			tagline: 'Private Zcash fundraising — like giving, with a z.',
			spec: 'JustGiving-style campaign pages on shielded ZEC. No accounts, no custody: donors pay your wallet directly; your UFVK (read-only) is encrypted at rest for donation monitoring.',
			how_it_works: [
				'1. Create a donation-only shielded wallet in Winbit32 (vault or receive wizard) and export the UFVK + unified address.',
				'2. POST /v1/ziving/page { slug, label, story?, goalZec?, ufvk, address, amountUsdCents? } — returns your public page URL, ownerToken (once) and a ZEC funding quote.',
				'3. Share the page; donations appear live on the page and in the OBS overlay feed.',
				'4. Top up scanning with POST /v1/overlay/:id/topup; promote on the homepage with POST /v1/ziving/page/:slug/feature (header x-overlay-token). Lost token? POST /v1/ziving/page/:slug/recover with the same UFVK.'
			],
			mcp: {
				note: 'AI agents: use the winbit32_*_ziving_* MCP tools (info, create_page, get_page, featured, feature, topup, cancel, recover) on mcp.winbit32.com.',
				base: 'https://mcp.winbit32.com/mcp'
			},
			winbit32: {
				createVault: 'https://winbit32.com/#winbit32.exe/createvault.exe',
				receiveWizard: 'https://winbit32.com/#winbit32.exe/zcashrecv.exe',
				purse: 'https://winbit32.com/#winbit32.exe/purse.exe'
			},
			pricing: {
				model: 'prepaid credit meter + optional homepage feature, both funded in ZEC (memo-token quote)',
				scan_rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.DAY_RATE_ATOMIC),
				grace_credit_usd: atomicToUsdString(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC),
				feature_rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.FEATURE_DAY_RATE_ATOMIC),
				feature_days: { min: OVERLAY_CONSTANTS.FEATURE_DAYS_MIN, max: OVERLAY_CONSTANTS.FEATURE_DAYS_MAX },
				min_usd: policy.minUsdCents / 100,
				max_usd: policy.maxUsdCents / 100,
				suggested_scan_usd: [5, 10, 25]
			},
			privacy: 'we store: your UFVK (AES-256-GCM encrypted), your public receive address, optional label/story/goal, optional featured-until. Donation events (amount + memo) prune after 30 days. No accounts, email or IPs.',
			zec_funding_enabled: zecEnabled()
		};
		return info;
	});

	app.get('/v1/ziving/featured', async () => {
		if (!watchDb) return { campaigns: [], count: 0 };
		const nowMs = now();
		const rows = listFeaturedCampaigns(watchDb, { nowMs });
		const campaigns = rows.map((row) => {
			const totals = sumConfirmedDonations(watchDb, row.id);
			return publicCampaign(row, totals, { nowMs, urls: urlsFor(row) });
		});
		return {
			campaigns,
			count: campaigns.length,
			pricing: {
				feature_rate_per_day_usd: atomicToUsdString(OVERLAY_CONSTANTS.FEATURE_DAY_RATE_ATOMIC)
			}
		};
	});

	// Public homepage activity feed: latest confirmed gifts across all pages
	// plus the newest live pages. Everything here is already public on the
	// individual campaign pages — this is just the aggregated view.
	app.get('/v1/ziving/activity', async () => {
		if (!watchDb) return { donations: [], pages: [], pollSeconds: 30 };
		const nowMs = now();
		const base = zivingPageUrlBase ? zivingPageUrlBase.replace(/\/$/u, '') : '';
		const donations = listRecentCampaignDonations(watchDb, { limit: 12 }).map((r) => ({
			slug: r.slug,
			label: r.label ?? null,
			amountZec: Number(r.amount_atomic) / ZATOSHI_PER_ZEC,
			memo: r.memo ?? null,
			at: new Date(r.first_seen_ms).toISOString(),
			pageUrl: base ? `${base}/p/${encodeURIComponent(r.slug)}` : null
		}));
		const pages = listRecentCampaigns(watchDb, { limit: 6 }).map((row) => {
			const totals = sumConfirmedDonations(watchDb, row.id);
			return publicCampaign(row, totals, { nowMs, urls: urlsFor(row) });
		});
		return { donations, pages, pollSeconds: 30 };
	});

	const createRouteOpts = { config: { rateLimit: { max: OVERLAY_CREATE_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/page', createRouteOpts, async (req, reply) => {
		if (!ready()) return privateNotConfigured(reply);
		if (!zecEnabled()) {
			return reply.code(503).send({
				error: { code: 'zec_funding_not_configured', message: 'ZEC funding is not enabled on this server (ZEC_RECV_ADDRESS unset).' }
			});
		}

		let input;
		try { input = validateZivingPageRequest(req.body ?? {}, policy); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		if (getOverlayBySlug(watchDb, input.slug)) {
			return reply.code(409).send({ error: { code: 'slug_taken', message: `slug "${input.slug}" is already in use` } });
		}

		const health = await nfptHealth();
		if (!health?.ok) {
			return reply.code(502).send({
				error: { code: 'nfpt_upstream_unavailable', message: 'Upstream scanner is not reachable; refusing to create page.', nfpt: health }
			});
		}

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ziving: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		let created;
		try {
			created = createOverlay(watchDb, {
				address: input.address,
				ufvkCiphertext: encryptViewKey(input.ufvk),
				birthdayHeight: input.birthdayHeight,
				label: input.label,
				minZatoshi: input.minZatoshi,
				slug: input.slug,
				story: input.story,
				goalZatoshi: input.goalZatoshi,
				nowMs: now()
			});
		} catch (err) {
			if (String(err?.message ?? '').includes('UNIQUE constraint failed')) {
				return reply.code(409).send({ error: { code: 'slug_taken', message: `slug "${input.slug}" is already in use` } });
			}
			throw err;
		}

		const { expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
			chain: 'zcash',
			amountUsdCents: input.amountUsdCents,
			priceUsd: price.usd,
			spreadBps: policy.spreadBps,
			memoPrefix
		});
		const nowMs = now();
		const quoteRow = createQuote(watchDb, {
			id: randomUUID(),
			watchId: created.id,
			watchToken: created.ownerToken,
			chain: 'zcash',
			recvAddress: recvAddresses.zcash,
			memo,
			quotedUsdCents: input.amountUsdCents,
			expectedAtomic,
			usdPriceMilli: Math.round(price.usd * 1000),
			spreadBps: policy.spreadBps,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + policy.quoteTtlSec * 1000
		});

		const row = getOverlay(watchDb, created.id);
		const totals = sumConfirmedDonations(watchDb, created.id);
		log.info({ slug: input.slug, overlayId: created.id, usdCents: input.amountUsdCents }, 'ziving: page created awaiting ZEC funding');

		return reply.code(201).send({
			slug: input.slug,
			overlayId: created.id,
			ownerToken: created.ownerToken,
			status: 'active_awaiting_payment',
			graceNote: `The page is live NOW on $${atomicToUsdString(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC)} of grace credit (~1.5 days). Pay the quote below and ${formatUsdCents(input.amountUsdCents)} of credit lands automatically after ${confirmationsRequired} confirmations.`,
			urls: urlsFor(row),
			payment: publicOverlayQuote(quoteRow, { confirmationsRequired }),
			page: publicCampaign(row, totals, { nowMs, urls: urlsFor(row) }),
			note: 'Keep the ownerToken safe — shown exactly ONCE. Use it with /v1/overlay/:id/topup and DELETE /v1/overlay/:id. Recommend a donation-only wallet; a UFVK reveals all incoming amounts and memos.'
		});
	});

	app.get('/v1/ziving/page/:slug', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const nowMs = now();
		const totals = sumConfirmedDonations(watchDb, row.id);
		return publicCampaign(row, totals, { nowMs, urls: urlsFor(row) });
	});

	// Prove ownership with the same UFVK used at create → issue a fresh ownerToken.
	const recoverOpts = { config: { rateLimit: { max: OVERLAY_RECOVER_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/page/:slug/recover', recoverOpts, async (req, reply) => {
		if (!recoverReady()) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		// Same response for missing vs wrong UFVK to avoid slug enumeration via timing of decrypt.
		if (!row) {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'UFVK does not match this page (or the page was not found)' } });
		}
		const ufvk = typeof req.body?.ufvk === 'string' ? req.body.ufvk.trim() : '';
		const out = recoverOverlayOwnerByUfvk(watchDb, row.id, ufvk, decryptViewKey);
		if (!out.ok) {
			const code = out.reason === 'cancelled' ? 409 : 403;
			const message = out.reason === 'cancelled'
				? 'page is cancelled'
				: 'UFVK does not match this page (or the page was not found)';
			return reply.code(code).send({ error: { code: out.reason === 'cancelled' ? 'cancelled' : 'forbidden', message } });
		}
		log.info({ slug, overlayId: out.id }, 'ziving: owner token recovered via UFVK');
		return {
			slug,
			overlayId: out.id,
			ownerToken: out.ownerToken,
			note: 'New ownerToken issued — previous token is revoked. Save this; manage with x-overlay-token.'
		};
	});

	app.get('/v1/ziving/page/:slug/events', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const sinceId = Number(req.query?.sinceId ?? 0) || 0;
		const events = listEventsSince(watchDb, row.id, { sinceId });
		return {
			slug: row.slug,
			overlayId: row.id,
			label: row.label ?? null,
			active: row.cancelled !== 1 && Number(row.credit_atomic ?? 0) > 0,
			cursor: events.length > 0 ? events[events.length - 1].id : sinceId,
			pollSeconds: 10,
			displayConfirmations: OVERLAY_CONFIRMATIONS_DEFAULT,
			events: events.map(publicEvent)
		};
	});

	app.post('/v1/ziving/page/:slug/feature', async (req, reply) => {
		if (!ready()) return privateNotConfigured(reply);
		if (!zecEnabled()) {
			return reply.code(503).send({ error: { code: 'zec_funding_not_configured', message: 'ZEC funding is not enabled on this server.' } });
		}
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const token = req.headers['x-overlay-token'] ?? req.body?.ownerToken;
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '');
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		if (got.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });

		let days;
		try {
			days = Math.floor(Number(req.body?.days ?? 3));
			featureUsdCentsForDays(days); // validates bounds
		} catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const usdCents = featureUsdCentsForDays(days);

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ziving-feature: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		const { expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
			chain: 'zcash',
			amountUsdCents: usdCents,
			priceUsd: price.usd,
			spreadBps: policy.spreadBps,
			memoPrefix: `${memoPrefix}F`
		});
		const nowMs = now();
		const quoteId = randomUUID();
		const quoteRow = createQuote(watchDb, {
			id: quoteId,
			watchId: got.id,
			watchToken: String(token),
			chain: 'zcash',
			recvAddress: recvAddresses.zcash,
			memo,
			quotedUsdCents: usdCents,
			expectedAtomic,
			usdPriceMilli: Math.round(price.usd * 1000),
			spreadBps: policy.spreadBps,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + policy.quoteTtlSec * 1000
		});
		createFeatureQuote(watchDb, { quoteId, overlayId: got.id, days, usdCents, nowMs });
		log.info({ slug, overlayId: got.id, days, usdCents, quoteId }, 'ziving: homepage feature quote created');
		return reply.code(201).send({
			slug,
			days,
			product: 'homepage_feature',
			payment: publicOverlayQuote(quoteRow, { confirmationsRequired }),
			note: `After ${confirmationsRequired} confirmations your page appears on the ziving.org homepage for ${days} day${days === 1 ? '' : 's'} ($${atomicToUsdString(OVERLAY_CONSTANTS.FEATURE_DAY_RATE_ATOMIC)}/day).`
		});
	});

	function buildZivingStats() {
		if (!watchDb) return { enabled: false, reason: 'watch DB not opened' };
		const pages = watchDb.prepare('SELECT COUNT(*) AS n FROM donation_overlays WHERE slug IS NOT NULL').get()?.n ?? 0;
		const featured = watchDb.prepare('SELECT COUNT(*) AS n FROM donation_overlays WHERE featured_until_ms > ?').get(now())?.n ?? 0;
		return { enabled: ready() && zecEnabled(), campaign_pages: pages, featured_pages: featured };
	}

	return { buildZivingStats };
}
