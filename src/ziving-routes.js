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
//   POST /v1/ziving/wallet/login            wallet UFVK → page list + manage session token
//   POST /v1/ziving/page/:slug/recover      recovery code → small ZEC quote (opens claim window)
//   POST /v1/ziving/page/:slug/recover/claim paid + code → fresh ownerToken + recovery code
//   POST /v1/ziving/page/:slug/recovery-code owner/session token → rotate recovery code
//   POST /v1/ziving/page/:slug/x-link/start  owner/session token → get a code to post on X
//   POST /v1/ziving/page/:slug/x-link/verify owner/session token → verify the posted tweet
//   DELETE /v1/ziving/page/:slug/x-link      owner/session token → unlink X account
//
// Management (top-up, cancel) reuses /v1/overlay/:id with the owner token
// or a wallet-login session token.
//
// Auth model: the ownerToken ("magic key", shown once at create) or a
// wallet-login session unlocks management. The recovery code (also shown
// once at create) is the lost-key path: presenting it opens a small paid
// ZEC quote, and only code + confirmed payment rotates the token — a bare
// UFVK is deliberately NOT enough, view keys get shared for transparency.

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
	RESERVED_SLUGS,
	sumConfirmedDonations,
	listFeaturedCampaigns,
	createFeatureQuote,
	featureUsdCentsForDays,
	genOverlayRecoveryCode,
	normaliseRecoveryCode,
	verifyOverlayRecoveryCode,
	setOverlayRecoveryCode,
	createRecoveryQuoteRow,
	claimOverlayRecovery,
	findOverlaysByUfvk,
	createOverlaySession,
	ufvkFingerprint,
	setOverlayXLinkCode,
	setOverlayXLink,
	clearOverlayXLink
} from './donation-overlay-store.js';
import { verifyTweetHasCode } from './x-link-verify.js';
import { hashToken } from './notice-board.js';
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
/** Verify makes an outbound fetch per call — tighter than the other manage routes. */
const X_LINK_VERIFY_PER_IP_PER_MIN = 6;

/**
 * Validate POST /v1/ziving/page. Extends overlay credentials with a
 * required slug and optional public story + goal.
 */
export function validateZivingPageRequest(body, policy) {
	const base = validateOverlayCreateRequest(body, policy);
	const slug = normaliseCampaignSlug(body.slug);
	// Creation is stricter than resolution: existing shorter slugs keep
	// working, but new pages need a slug that can't be mistaken for a
	// site route or a wildcard grab.
	if (slug.length < OVERLAY_CONSTANTS.SLUG_CREATE_MIN_LEN) {
		throw new TypeError(`slug must be at least ${OVERLAY_CONSTANTS.SLUG_CREATE_MIN_LEN} characters (a-z, 0-9, hyphen)`);
	}
	if (RESERVED_SLUGS.has(slug)) {
		throw new TypeError(`slug "${slug}" is reserved — pick something more specific`);
	}
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
		xLink: row.x_handle ? {
			handle: row.x_handle,
			url: `https://x.com/${encodeURIComponent(row.x_handle)}`,
			proofUrl: row.x_proof_url ?? null,
			verifiedAt: row.x_verified_at_ms != null ? new Date(Number(row.x_verified_at_ms)).toISOString() : null
		} : null,
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
		xLinkFetchImpl = globalThis.fetch,
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
				'2. POST /v1/ziving/page { slug, label, story?, goalZec?, ufvk, address, amountUsdCents? } — returns your public page URL, ownerToken + recoveryCode (each shown once) and a ZEC funding quote.',
				'3. Share the page; donations appear live on the page and in the OBS overlay feed.',
				'4. Top up scanning with POST /v1/overlay/:id/topup; promote on the homepage with POST /v1/ziving/page/:slug/feature (header x-overlay-token). Wallet holders can POST /v1/ziving/wallet/login { ufvk } for a page list + manage session.',
				'5. Lost the ownerToken? POST /v1/ziving/page/:slug/recover { recoveryCode } → pay the small ZEC quote → POST .../recover/claim { recoveryCode } for a fresh ownerToken.'
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
		// Chain tip at creation: notes at/below this are the wallet's
		// pre-existing balance; anything above is a real donation. Lets the
		// scanner's first pass keep a donation that lands before it runs,
		// instead of blanket-suppressing every note it finds.
		const baselineHeight = Number.isInteger(health.lightwallet?.blockHeight)
			? health.lightwallet.blockHeight
			: null;

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ziving: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}

		const recoveryCode = genOverlayRecoveryCode();
		let created;
		try {
			created = createOverlay(watchDb, {
				address: input.address,
				ufvkCiphertext: encryptViewKey(input.ufvk),
				birthdayHeight: input.birthdayHeight,
				baselineHeight,
				label: input.label,
				minZatoshi: input.minZatoshi,
				slug: input.slug,
				story: input.story,
				goalZatoshi: input.goalZatoshi,
				recoveryCodeHash: hashToken(normaliseRecoveryCode(recoveryCode)),
				ufvkFingerprintHex: ufvkFingerprint(input.ufvk),
				nowMs: now()
			});
		} catch (err) {
			if (err?.code === 'wallet_already_has_page') {
				return reply.code(409).send({
					error: {
						code: 'wallet_already_has_page',
						message: err.message,
						existingSlug: err.existingSlug ?? null,
						existingOverlayId: err.existingOverlayId ?? null
					}
				});
			}
			const msg = String(err?.message ?? '');
			if (msg.includes('UNIQUE constraint failed')) {
				if (/ufvk_fingerprint|one_live_ufvk|one_live_address|\.address/i.test(msg)) {
					return reply.code(409).send({
						error: {
							code: 'wallet_already_has_page',
							message: 'This wallet already has an active page. Cancel it on Manage before creating another.'
						}
					});
				}
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
			recoveryCode,
			status: 'active_awaiting_payment',
			graceNote: `The page is live NOW on $${atomicToUsdString(OVERLAY_CONSTANTS.GRACE_CREDIT_ATOMIC)} of grace credit (~1.5 days). Pay the quote below and ${formatUsdCents(input.amountUsdCents)} of credit lands automatically after ${confirmationsRequired} confirmations.`,
			urls: urlsFor(row),
			payment: publicOverlayQuote(quoteRow, { confirmationsRequired }),
			page: publicCampaign(row, totals, { nowMs, urls: urlsFor(row) }),
			note: 'Keep the ownerToken (manage key) AND recoveryCode safe — both shown exactly ONCE. The ownerToken manages the page (/v1/overlay/:id/topup, DELETE /v1/overlay/:id, feature). If you lose it, the recoveryCode + a small ZEC payment issues a new one. Recommend a donation-only wallet; a UFVK reveals all incoming amounts and memos.'
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

	// ── Wallet login: UFVK (presented by the wallet connect dialog, not
	// typed) → list of this wallet's pages + a short-lived session token
	// accepted wherever x-overlay-token is. Read/manage convenience only —
	// it never rotates the ownerToken, so other devices stay valid.
	const loginOpts = { config: { rateLimit: { max: OVERLAY_RECOVER_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/wallet/login', loginOpts, async (req, reply) => {
		if (!recoverReady()) return privateNotConfigured(reply);
		const ufvk = typeof req.body?.ufvk === 'string' ? req.body.ufvk.trim() : '';
		if (!ufvk.startsWith('uview')) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: 'ufvk (uview1…) is required' } });
		}
		const rows = findOverlaysByUfvk(watchDb, ufvk, decryptViewKey);
		if (rows.length === 0) {
			return reply.code(404).send({ error: { code: 'no_pages', message: 'no pages found for this wallet' } });
		}
		const nowMs = now();
		const session = createOverlaySession(watchDb, rows.map((r) => r.id), { nowMs });
		log.info({ pages: rows.length }, 'ziving: wallet login');
		return {
			sessionToken: session.token,
			expires_at: new Date(session.expiresAtMs).toISOString(),
			pages: rows.map((row) => {
				const totals = sumConfirmedDonations(watchDb, row.id);
				return {
					...publicCampaign(row, totals, { nowMs, urls: urlsFor(row) }),
					cancelled: row.cancelled === 1,
					has_recovery_code: Boolean(row.recovery_code_hash)
				};
			}),
			note: 'Use sessionToken as x-overlay-token on manage endpoints. It expires; the ownerToken (magic key) is unchanged.'
		};
	});

	// ── Lost-key recovery, step 1: present the recovery code → get a small
	// ZEC quote. Paying it opens a 48h claim window. The code alone never
	// rotates anything; a bare UFVK never unlocks anything (view keys get
	// shared for transparency — possession is not ownership).
	const recoverOpts = { config: { rateLimit: { max: OVERLAY_RECOVER_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/page/:slug/recover', recoverOpts, async (req, reply) => {
		if (!recoverReady() || !priceOracle) return privateNotConfigured(reply);
		if (!zecEnabled()) {
			return reply.code(503).send({ error: { code: 'zec_funding_not_configured', message: 'ZEC funding is not enabled on this server.' } });
		}
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		// Uniform response for missing page vs wrong code — no slug/code oracle.
		const denied = () => reply.code(403).send({
			error: { code: 'forbidden', message: 'recovery code does not match this page (or the page was not found)' }
		});
		if (!row) return denied();
		if (row.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });
		if (!verifyOverlayRecoveryCode(row, req.body?.recoveryCode)) return denied();

		let price;
		try { price = await priceOracle.getUsdPrice('zcash'); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'ziving-recover: price oracle unavailable');
			return reply.code(503).send({ error: { code: 'price_unavailable', message: 'could not fetch a live exchange rate; please retry shortly' } });
		}
		const usdCents = OVERLAY_CONSTANTS.RECOVERY_UNLOCK_USD_CENTS;
		const { expectedAtomic, memo } = allocateQuoteAmount(watchDb, {
			chain: 'zcash',
			amountUsdCents: usdCents,
			priceUsd: price.usd,
			spreadBps: policy.spreadBps,
			memoPrefix: `${memoPrefix}R`
		});
		const nowMs = now();
		const quoteId = randomUUID();
		const quoteRow = createQuote(watchDb, {
			id: quoteId,
			watchId: row.id,
			watchToken: randomUUID(), // recovery quotes are claimed via the code, not a bearer token
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
		createRecoveryQuoteRow(watchDb, { quoteId, overlayId: row.id, usdCents, nowMs });
		log.info({ slug, overlayId: row.id, quoteId }, 'ziving: lost-key recovery quote created');
		return reply.code(201).send({
			slug,
			product: 'lost_key_unlock',
			payment: publicOverlayQuote(quoteRow, { confirmationsRequired }),
			claim: `/v1/ziving/page/${encodeURIComponent(slug)}/recover/claim`,
			note: `After ${confirmationsRequired} confirmations a 48-hour claim window opens: POST the same recoveryCode to the claim URL to receive a fresh ownerToken (and a NEW recovery code — the old one is retired).`
		});
	});

	// ── Lost-key recovery, step 2: code + confirmed payment → fresh
	// ownerToken and a fresh recovery code, both shown once.
	app.post('/v1/ziving/page/:slug/recover/claim', recoverOpts, async (req, reply) => {
		if (!recoverReady()) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		const denied = () => reply.code(403).send({
			error: { code: 'forbidden', message: 'recovery code does not match this page (or the page was not found)' }
		});
		if (!row) return denied();
		if (!verifyOverlayRecoveryCode(row, req.body?.recoveryCode)) return denied();
		const out = claimOverlayRecovery(watchDb, row.id, { nowMs: now() });
		if (!out.ok) {
			if (out.reason === 'cancelled') return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });
			return reply.code(402).send({
				error: { code: 'payment_required', message: 'the unlock payment has not confirmed yet — pay the recovery quote first, then claim within 48 hours' }
			});
		}
		log.info({ slug, overlayId: out.id }, 'ziving: owner token recovered via paid lost-key claim');
		return {
			slug,
			overlayId: out.id,
			ownerToken: out.ownerToken,
			recoveryCode: out.recoveryCode,
			note: 'New ownerToken + recovery code issued — previous ones are revoked. Save BOTH; shown exactly once.'
		};
	});

	// ── Rotate the recovery code (owner token or wallet session). Lets
	// pages created before recovery codes existed adopt one.
	app.post('/v1/ziving/page/:slug/recovery-code', recoverOpts, async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const token = req.headers['x-overlay-token'] ?? req.body?.ownerToken;
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '', { nowMs: now() });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		if (got.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });
		const out = setOverlayRecoveryCode(watchDb, row.id);
		log.info({ slug, overlayId: row.id }, 'ziving: recovery code rotated');
		return {
			slug,
			recoveryCode: out.recoveryCode,
			note: 'New recovery code — the previous one (if any) is retired. Shown exactly once; store it offline.'
		};
	});

	// ── X (Twitter) self-attestation, step 1: issue a public nonce to post.
	// Not a secret — anyone can see it on the page; it just ties a specific
	// tweet to this specific campaign so proofs can't be copy-pasted between
	// pages. Reissuing does not clear an already-verified link.
	const xLinkStartOpts = { config: { rateLimit: { max: OVERLAY_RECOVER_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/page/:slug/x-link/start', xLinkStartOpts, async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const token = req.headers['x-overlay-token'] ?? req.body?.ownerToken;
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '', { nowMs: now() });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		if (got.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });
		const out = setOverlayXLinkCode(watchDb, row.id);
		return {
			slug,
			code: out.code,
			instructions: `Post a public tweet containing exactly "${out.code}" from the X account you want linked, then POST { tweetUrl } to /v1/ziving/page/${encodeURIComponent(slug)}/x-link/verify. This proves you control that account — it is not an identity check, and Ziving does not vouch for you.`
		};
	});

	// ── X self-attestation, step 2: fetch the tweet via X's public oEmbed
	// endpoint (no API key needed) and check it contains our nonce.
	const xLinkVerifyOpts = { config: { rateLimit: { max: X_LINK_VERIFY_PER_IP_PER_MIN, timeWindow: '1 minute' } } };
	app.post('/v1/ziving/page/:slug/x-link/verify', xLinkVerifyOpts, async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const token = req.headers['x-overlay-token'] ?? req.body?.ownerToken;
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '', { nowMs: now() });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		if (got.cancelled === 1) return reply.code(409).send({ error: { code: 'cancelled', message: 'page is cancelled' } });
		if (!got.x_link_code) {
			return reply.code(409).send({ error: { code: 'no_pending_code', message: 'call x-link/start first to get a code to post' } });
		}
		const tweetUrl = typeof req.body?.tweetUrl === 'string' ? req.body.tweetUrl.trim() : '';
		const result = await verifyTweetHasCode(tweetUrl, got.x_link_code, { fetchImpl: xLinkFetchImpl });
		if (!result.ok) {
			return reply.code(422).send({ error: { code: result.reason ?? 'verify_failed', message: 'could not verify that tweet contains your code — check the URL and that the tweet is public' } });
		}
		const out = setOverlayXLink(watchDb, row.id, { handle: result.handle, proofUrl: tweetUrl, nowMs: now() });
		log.info({ slug, overlayId: row.id, handle: result.handle }, 'ziving: x-link verified');
		return {
			slug,
			xLink: { handle: out.handle, url: `https://x.com/${encodeURIComponent(out.handle)}`, proofUrl: out.proofUrl, verifiedAt: new Date(out.verifiedAtMs).toISOString() }
		};
	});

	// ── Unlink (owner's choice, or to relink a different account). ────
	app.delete('/v1/ziving/page/:slug/x-link', async (req, reply) => {
		if (!watchDb) return privateNotConfigured(reply);
		let slug;
		try { slug = normaliseCampaignSlug(req.params.slug); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const row = getOverlayBySlug(watchDb, slug);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'campaign page not found' } });
		const token = req.headers['x-overlay-token'] ?? '';
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '', { nowMs: now() });
		if (got.error === 'forbidden') return reply.code(403).send({ error: { code: 'forbidden', message: 'owner token mismatch (pass it via the x-overlay-token header)' } });
		clearOverlayXLink(watchDb, row.id);
		return { slug, unlinked: true };
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

	// Token-gated, but each call mints quote rows — keep the same per-IP
	// throttle as the other quote-minting routes.
	app.post('/v1/ziving/page/:slug/feature', recoverOpts, async (req, reply) => {
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
		const got = getOverlayAuthorised(watchDb, row.id, typeof token === 'string' ? token : '', { nowMs: now() });
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
