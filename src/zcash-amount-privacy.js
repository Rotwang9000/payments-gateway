// Zcash amount-privacy advisor — pure helpers (server side).
//
// Zcash shields *amounts* by encrypting them inside the pool, so the only thing
// an observer sees is the transparent boundary: how much enters when you
// **shield** (t→z) and how much leaves when you **deshield** (z→t). Two leaks
// follow:
//
//   1. Round-tripping a *unique* amount — shield 12.3456 ZEC, later deshield
//      exactly 12.3456 ZEC — links the two transparent legs through the pool
//      (zecstats' "Wall of Shame").
//   2. A one-way shield/deshield of an *unusual* amount is a fingerprint: few
//      others use it, so it stands out instead of blending in.
//
// This module mirrors the WINBIT32 frontend helper
// (src/components/toolbox/zcash-extensions/zcashAmountPrivacy.js) so the MCP
// tool + REST route give byte-identical advice to the in-app wizard. Keep the
// two in sync. It ALSO adds `classifyBoundaryTx` — the pure transaction
// classifier the shield-amount indexer (zcash-shield-index.js) feeds blocks
// into — whose sign/guard rules were verified against a live zebra node.
//
// All functions are pure and take inputs as parameters (no shared state).

export const ZATOSHIS_PER_ZEC = 100_000_000;

// Curated "blend-in" boundary amounts (ZEC), smallest first. Zcash has no
// protocol denominations, so these are the human round numbers people actually
// shield/deshield. A live popularity feed (the on-chain index) replaces this
// via the `popular` argument.
export const COMMON_AMOUNTS_ZEC = Object.freeze([
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
	1, 2, 2.5, 5, 10, 20, 25, 50, 100,
]);

// Boundary crossings smaller than this are dropped by the indexer: they are
// dominated by the ZIP-317 fee / dust on fully-shielded transfers, not real
// shield/deshield intent. 0.001 ZEC = 100_000 zatoshis.
export const MIN_BOUNDARY_ZAT_DEFAULT = 100_000;

/** ZEC (number) → integer zatoshis. Rounds to avoid float drift on equality. */
export const zecToZats = (zec) => Math.round((Number(zec) || 0) * ZATOSHIS_PER_ZEC);

/** Integer zatoshis → ZEC number. */
export const zatsToZec = (zats) => (Number(zats) || 0) / ZATOSHIS_PER_ZEC;

const COMMON_AMOUNTS_ZATS = Object.freeze(COMMON_AMOUNTS_ZEC.map(zecToZats));

/** Format a zatoshi amount as a trimmed ZEC string (up to 8 dp). */
export const formatZec = (zats) => {
	const zec = zatsToZec(zats);
	const s = zec.toFixed(8).replace(/\.?0+$/, '');
	return s === '' ? '0' : s;
};

/** Build a Set of zatoshi amounts from a `popular` feed, or null when absent. */
const popularToZatsSet = (popular) => {
	if (!Array.isArray(popular) || popular.length === 0) return null;
	const set = new Set();
	for (const p of popular) {
		const z = zecToZats(p?.zec ?? p?.amount ?? p);
		if (Number.isFinite(z) && z > 0) set.add(z);
	}
	return set.size ? set : null;
};

/** The active "blend-in" amount set (zatoshis): the live feed, else bundled. */
const blendSetZats = (popular) => popularToZatsSet(popular) || new Set(COMMON_AMOUNTS_ZATS);

/**
 * Is this amount one of the blend-in amounts? Exact match in zatoshis.
 * @param {number} zec
 * @param {Array|null} [popular] optional live popularity feed
 */
export const isCommonAmount = (zec, popular = null) => blendSetZats(popular).has(zecToZats(zec));

/**
 * Suggest nearby blend-in amounts for a target, nearest first.
 *
 * @param {number} targetZec
 * @param {object} [o]
 * @param {number} [o.count=6]
 * @param {Array|null} [o.popular] live feed of { zec, count } (else bundled list)
 */
export const suggestAmounts = (targetZec, { count = 6, popular = null } = {}) => {
	const target = zecToZats(targetZec);

	const pool = Array.isArray(popular) && popular.length
		? popular.map((p) => ({
			zats: zecToZats(p?.zec ?? p?.amount ?? p),
			usageCount: Number(p?.count ?? p?.usageCount ?? p?.uses) || null,
		}))
		: COMMON_AMOUNTS_ZATS.map((zats) => ({ zats, usageCount: null }));

	const byZats = new Map();
	for (const p of pool) {
		if (!Number.isFinite(p.zats) || p.zats <= 0) continue;
		const existing = byZats.get(p.zats);
		if (!existing || (p.usageCount || 0) > (existing.usageCount || 0)) byZats.set(p.zats, p);
	}

	const sorted = [...byZats.values()].sort((a, b) => {
		const byDistance = Math.abs(a.zats - target) - Math.abs(b.zats - target);
		if (byDistance !== 0) return byDistance;
		return (b.usageCount || 0) - (a.usageCount || 0);
	});

	const suggestions = sorted.slice(0, Math.max(1, count)).map((p) => {
		const deltaZats = p.zats - target;
		return {
			zats: p.zats,
			zec: zatsToZec(p.zats),
			label: `${formatZec(p.zats)} ZEC`,
			deltaZats,
			deltaZec: zatsToZec(deltaZats),
			deltaLabel: deltaZats === 0 ? 'exact' : `${deltaZats > 0 ? '+' : '\u2212'}${formatZec(Math.abs(deltaZats))}`,
			direction: deltaZats === 0 ? 'same' : deltaZats > 0 ? 'up' : 'down',
			usageCount: p.usageCount,
		};
	});

	return {
		target: { zec: zatsToZec(target), zats: target, isCommon: byZats.has(target) },
		suggestions,
	};
};

/**
 * Classify a single amount: is it a blend-in amount, and what's the nearest one?
 * @param {number} targetZec
 * @param {object} [o]
 * @param {Array|null} [o.popular]
 */
export const classifyAmount = (targetZec, { popular = null } = {}) => {
	const { target, suggestions } = suggestAmounts(targetZec, { count: 1, popular });
	const nearest = suggestions[0] || null;
	return {
		zec: target.zec,
		zats: target.zats,
		isCommon: target.isCommon,
		fingerprint: !target.isCommon,
		nearest,
		distanceZec: nearest ? Math.abs(nearest.deltaZec) : null,
	};
};

/**
 * Assess the linkability of shielding/deshielding a given amount.
 *
 * @param {object} o
 * @param {number} o.amountZec
 * @param {number[]} [o.noteAmountsZec]  the user's own shielded note values (ZEC)
 * @param {'shield'|'deshield'} [o.action='deshield']
 * @param {Array|null} [o.popular]
 */
export const assessRoundTripRisk = ({ amountZec, noteAmountsZec = [], action = 'deshield', popular = null } = {}) => {
	const zats = zecToZats(amountZec);
	const reasons = [];
	if (!Number.isFinite(zats) || zats <= 0) {
		return { level: 'ok', headline: 'Enter an amount to assess its linkability.', reasons, isCommon: false, exactMatch: false, nearest: null };
	}

	const cls = classifyAmount(amountZec, { popular });
	const noteZats = (noteAmountsZec || []).map(zecToZats);
	const exactMatch = noteZats.includes(zats);

	let level = 'ok';
	if (action === 'deshield' && exactMatch) {
		level = 'warn';
		reasons.push('This is the exact value of one of your shielded notes — deshielding it 1:1 links that note (and where it came from) to the transparent address you cash out to. This is the classic "Wall of Shame" self-dox.');
	}

	if (!cls.isCommon) {
		if (level !== 'warn') level = 'caution';
		reasons.push(`${formatZec(zats)} ZEC is an unusual amount; few others ${action} it, so it stands out on the transparent side like a fingerprint.`);
		if (cls.nearest) {
			reasons.push(`Nearest blend-in amount: ${cls.nearest.label} (${cls.nearest.deltaLabel}).`);
		}
	} else {
		reasons.push(`${formatZec(zats)} ZEC is a common amount — it blends with others doing the same on the transparent side.`);
	}

	let headline;
	if (level === 'warn') headline = 'High linkability — change the amount, split it, or exit via a swap.';
	else if (level === 'caution') headline = 'Uncommon amount — easy to fingerprint on the transparent side.';
	else headline = 'Reasonable — a common amount with no exact-note match.';

	return { level, headline, reasons, isCommon: cls.isCommon, exactMatch, nearest: cls.nearest };
};

/**
 * Summarise a set of shielded note amounts by how "blend-in" they are.
 * @param {number[]} [noteAmountsZec]
 * @param {object} [o]
 * @param {Array|null} [o.popular]
 */
export const summariseNoteAmounts = (noteAmountsZec = [], { popular = null } = {}) => {
	const common = blendSetZats(popular);
	const list = (noteAmountsZec || []).map(zecToZats).filter((z) => Number.isFinite(z) && z > 0);

	const groups = new Map();
	let total = 0;
	let commonCount = 0;
	let commonTotal = 0;

	for (const z of list) {
		total += z;
		const isC = common.has(z);
		if (isC) { commonCount += 1; commonTotal += z; }
		const g = groups.get(z) || { zats: z, zec: zatsToZec(z), label: `${formatZec(z)} ZEC`, count: 0, total: 0, common: isC };
		g.count += 1;
		g.total += z;
		groups.set(z, g);
	}

	return {
		total,
		count: list.length,
		common: { count: commonCount, total: commonTotal },
		fingerprint: { count: list.length - commonCount, total: total - commonTotal },
		byAmount: [...groups.values()].sort((a, b) => b.zats - a.zats),
		commonPercent: total > 0 ? Math.round((commonTotal / total) * 100) : 0,
	};
};

/**
 * Qualitative, cautious assessment of a note set's "blend-in" state. NOT a
 * guarantee of anonymity.
 * @param {ReturnType<typeof summariseNoteAmounts>} summary
 */
export const assessNotePrivacy = (summary) => {
	if (!summary || summary.total <= 0) {
		return { level: 'empty', headline: 'No shielded note amounts to assess yet.' };
	}
	if (summary.common.count === 0) {
		return { level: 'none', headline: 'None of your notes are common amounts — deshielding any of them 1:1 is easy to fingerprint.' };
	}
	const pct = summary.commonPercent;
	if (pct >= 80) {
		return { level: 'high', headline: `${pct}% of your shielded value sits in common amounts that blend in on exit.` };
	}
	return { level: 'partial', headline: `${pct}% of your shielded value is in common amounts; the rest would fingerprint on a 1:1 exit.` };
};

/** Resolve a `popular` feed (or the bundled list) to a zats→usageCount map. */
const denomUsageMap = (popular) => {
	const usageByZats = new Map();
	const source = Array.isArray(popular) && popular.length
		? popular.map((p) => ({ zats: zecToZats(p?.zec ?? p?.amount ?? p), usageCount: Number(p?.count ?? p?.usageCount ?? p?.uses) || null }))
		: COMMON_AMOUNTS_ZATS.map((zats) => ({ zats, usageCount: null }));
	for (const p of source) {
		if (!Number.isFinite(p.zats) || p.zats <= 0) continue;
		const prev = usageByZats.get(p.zats);
		if (prev === undefined || (p.usageCount || 0) > (prev || 0)) usageByZats.set(p.zats, p.usageCount ?? null);
	}
	return usageByZats;
};

/**
 * Plan splitting a large shield/deshield into several blend-in pieces, so the
 * whole transfer hides among ordinary-sized transactions instead of standing
 * out as one fingerprinting amount. Greedy change-making over the blend-in
 * denominations, capped at `maxPieces`; identical pieces are grouped for
 * display ("3 × 1 ZEC"). Anything the denominations can't cover is returned as
 * a `remainder` (which may itself fingerprint) rather than silently dropped.
 *
 * This is advice about AMOUNTS ONLY. It cannot fix the address/timing side:
 * pieces sent from/to your own clustered addresses, or in one correlated burst,
 * are still linkable — see `cautions`. Splitting reduces linkability; it is not
 * anonymity.
 *
 * @param {number} targetZec
 * @param {object} [o]
 * @param {'shield'|'deshield'} [o.action='deshield']
 * @param {Array|null} [o.popular]    live feed of { zec, count } (else bundled)
 * @param {number} [o.maxPieces=8]    1..32
 * @param {number} [o.minPieceZat=MIN_BOUNDARY_ZAT_DEFAULT]  dust threshold
 */
export const planAmountSplit = (targetZec, {
	action = 'deshield',
	popular = null,
	maxPieces = 8,
	minPieceZat = MIN_BOUNDARY_ZAT_DEFAULT,
} = {}) => {
	const target = zecToZats(targetZec);
	const cap = Math.max(1, Math.min(32, Math.floor(maxPieces) || 8));
	const usageByZats = denomUsageMap(popular);
	const source = Array.isArray(popular) && popular.length ? 'live_index' : 'bundled_list';

	const meta = {
		target: { zec: zatsToZec(target), zats: target, label: `${formatZec(target)} ZEC`, isCommon: usageByZats.has(target) },
		action: action === 'shield' ? 'shield' : 'deshield',
		source,
		maxPieces: cap,
	};

	if (!Number.isFinite(target) || target <= 0) {
		return { ...meta, pieces: [], pieceCount: 0, coverage: { zats: 0, zec: 0, percent: 0 }, remainder: null, exact: false, effectiveness: { level: 'none', headline: 'Enter an amount to plan a split.' }, cautions: [] };
	}

	const denoms = [...usageByZats.keys()].filter((z) => z <= target).sort((a, b) => b - a);
	if (denoms.length === 0) {
		return {
			...meta,
			pieces: [], pieceCount: 0, coverage: { zats: 0, zec: 0, percent: 0 },
			remainder: { zats: target, zec: zatsToZec(target), label: `${formatZec(target)} ZEC`, isCommon: false, isDust: target < minPieceZat },
			exact: false,
			effectiveness: { level: 'low', headline: 'Amount is below the smallest blend-in denomination — too small to split usefully.' },
			cautions: [],
		};
	}

	// Greedy descending change-making, capped at `cap` pieces.
	const pieceZats = [];
	let remaining = target;
	for (const d of denoms) {
		while (remaining >= d && pieceZats.length < cap) { pieceZats.push(d); remaining -= d; }
		if (pieceZats.length >= cap) break;
	}

	const grouped = new Map();
	for (const z of pieceZats) {
		const g = grouped.get(z) || { zats: z, zec: zatsToZec(z), label: `${formatZec(z)} ZEC`, count: 0, usageCount: usageByZats.get(z) ?? null, common: true };
		g.count += 1;
		grouped.set(z, g);
	}
	const pieces = [...grouped.values()].sort((a, b) => b.zats - a.zats);
	const coverageZats = pieceZats.reduce((s, z) => s + z, 0);

	const remainder = remaining > 0
		? { zats: remaining, zec: zatsToZec(remaining), label: `${formatZec(remaining)} ZEC`, isCommon: usageByZats.has(remaining), isDust: remaining < minPieceZat }
		: null;
	const exact = remainder === null;

	let effectiveness;
	if (pieceZats.length <= 1 && exact) {
		effectiveness = { level: 'low', headline: `${formatZec(target)} ZEC is already a single blend-in amount — splitting it is optional.` };
	} else if (exact) {
		effectiveness = { level: 'good', headline: `Splits cleanly into ${pieceZats.length} blend-in amounts that each hide in the crowd.` };
	} else if (remainder.isDust) {
		effectiveness = { level: 'good', headline: `Splits into ${pieceZats.length} blend-in amounts; a tiny ${remainder.label} remainder is left over.` };
	} else {
		effectiveness = { level: 'partial', headline: `${pieceZats.length} blend-in amounts cover ${Math.round((coverageZats / target) * 100)}%; the ${remainder.label} remainder still fingerprints — round it, raise the piece limit, or exit it via a swap.` };
	}

	const cautions = [
		'Send each piece in a SEPARATE transaction — several pieces in one transaction (or back-to-back in one block) are trivially re-linked.',
		'Spread them over time; a burst of "ordinary" amounts within minutes is itself a pattern.',
	];
	if (meta.action === 'deshield') {
		cautions.push('Deshield each piece to a DIFFERENT, fresh transparent address — pieces landing on your own clustered addresses re-link instantly via own-address/common-input heuristics.');
		cautions.push('Stronger still: exit via swaps to fresh destinations instead of your own t-addresses at all.');
	} else {
		cautions.push('Fund each shield from DIFFERENT transparent inputs/UTXOs — pieces co-spent from one address are linked by the common-input heuristic before they ever reach the pool.');
	}
	cautions.push('Splitting hides the SIZE, not the source or destination. It reduces linkability; it is not anonymity.');

	return {
		...meta,
		pieces,
		pieceCount: pieceZats.length,
		coverage: { zats: coverageZats, zec: zatsToZec(coverageZats), percent: target > 0 ? Math.round((coverageZats / target) * 100) : 0 },
		remainder,
		exact,
		effectiveness,
		cautions,
	};
};

/** Parse a free-text list of ZEC amounts (commas/space/newlines) into numbers. */
export const parseAmountList = (text) => {
	if (typeof text !== 'string') return [];
	return text
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean)
		.map(Number)
		.filter((n) => Number.isFinite(n) && n > 0);
};

/**
 * One-shot advisor payload for the MCP tool / REST route: suggestions + risk in
 * a single object so an agent gets everything it needs from one call.
 *
 * @param {object} o
 * @param {number} o.amountZec
 * @param {'shield'|'deshield'} [o.action='deshield']
 * @param {number[]} [o.noteAmountsZec]
 * @param {Array|null} [o.popular]
 * @param {number} [o.count=6]
 */
export const buildAmountAdvice = ({ amountZec, action = 'deshield', noteAmountsZec = [], popular = null, count = 6 } = {}) => {
	const { target, suggestions } = suggestAmounts(amountZec, { count, popular });
	const risk = assessRoundTripRisk({ amountZec, noteAmountsZec, action, popular });
	const noteSummary = (noteAmountsZec && noteAmountsZec.length)
		? summariseNoteAmounts(noteAmountsZec, { popular })
		: null;
	// Offer a split plan whenever it could help (uncommon, or large enough to
	// break into >1 blend-in piece) — the agent gets it without a second call.
	const split = planAmountSplit(amountZec, { action, popular });
	return {
		amount_zec: target.zec,
		amount_zats: target.zats,
		action,
		is_common: target.isCommon,
		blend_in_source: Array.isArray(popular) && popular.length ? 'live_index' : 'bundled_list',
		risk,
		suggestions,
		split_plan: (split.pieceCount > 1 || !target.isCommon) ? split : null,
		note_summary: noteSummary ? { ...noteSummary, assessment: assessNotePrivacy(noteSummary) } : null,
		caveat: 'Blending by amount REDUCES linkability; it does not guarantee anonymity. The strongest exit is not your own transparent address — deshield via a swap to a fresh destination, or coordinate with others.',
	};
};

// ── On-chain transaction classifier (feeds the shield-amount index) ──────────
//
// Sign convention verified against a live zebra mainnet node:
//   net = saplingValueBalanceZat + orchardValueBalanceZat (+ legacy sprout)
//   net > 0  → value LEFT the shielded pool to transparent  → deshield
//   net < 0  → value ENTERED the shielded pool              → shield
// Fully-shielded transfers show a tiny positive net (the fee) with no
// transparent inputs or outputs — excluded by the vin/vout guards below.

/** True when the tx is a coinbase (mints; never a shield/deshield). */
export const isCoinbaseTx = (tx) => {
	const vin = Array.isArray(tx?.vin) ? tx.vin : [];
	return vin.length > 0 && vin[0] && vin[0].coinbase !== undefined;
};

/** True when the tx touches any shielded pool (Orchard/Sapling/Sprout). */
export const hasShieldedComponent = (tx) => {
	const orchActions = (tx?.orchard?.actions || []).length;
	const sapling = (tx?.vShieldedSpend || []).length + (tx?.vShieldedOutput || []).length;
	const sprout = (tx?.vjoinsplit || []).length;
	return orchActions > 0 || sapling > 0 || sprout > 0;
};

/** Net zatoshis the tx moves OUT of the shielded pool (positive = deshield). */
export const txNetShieldedZat = (tx) => {
	const sapling = Number(tx?.valueBalanceZat ?? zecToZats(tx?.valueBalance ?? 0)) || 0;
	const orchard = Number(tx?.orchard?.valueBalanceZat ?? zecToZats(tx?.orchard?.valueBalance ?? 0)) || 0;
	let sprout = 0;
	for (const j of (Array.isArray(tx?.vjoinsplit) ? tx.vjoinsplit : [])) {
		// vpub_new leaves the pool to transparent (+); vpub_old enters it (−).
		sprout += zecToZats(j?.vpub_new ?? 0) - zecToZats(j?.vpub_old ?? 0);
	}
	return sapling + orchard + sprout;
};

/** Total transparent output value (zatoshis) of the tx. */
export const transparentVoutZat = (tx) => {
	let sum = 0;
	for (const o of (Array.isArray(tx?.vout) ? tx.vout : [])) {
		sum += Number(o?.valueZat ?? zecToZats(o?.value ?? 0)) || 0;
	}
	return sum;
};

/** Count of non-coinbase transparent inputs. */
export const transparentVinCount = (tx) => (Array.isArray(tx?.vin) ? tx.vin : [])
	.filter((v) => v && v.coinbase === undefined).length;

/**
 * Classify a verbose Zcash tx (getblock verbosity 2 / getrawtransaction 1) as a
 * shield, deshield, or neither. Returns the transparent-boundary amount:
 *   - shield:   |net| (value that entered the pool)
 *   - deshield: total transparent vout (value that arrived on the transparent
 *               side — what an observer actually sees and would round-match)
 *
 * @param {object} tx verbose transaction
 * @param {object} [o]
 * @param {number} [o.minBoundaryZat=MIN_BOUNDARY_ZAT_DEFAULT]
 * @returns {{ side:'shield'|'deshield', amountZat:number, netZat:number }|null}
 */
export const classifyBoundaryTx = (tx, { minBoundaryZat = MIN_BOUNDARY_ZAT_DEFAULT } = {}) => {
	if (!tx || isCoinbaseTx(tx) || !hasShieldedComponent(tx)) return null;
	const netZat = txNetShieldedZat(tx);
	const vinCount = transparentVinCount(tx);
	const voutZat = transparentVoutZat(tx);

	let side = null;
	let amountZat = 0;
	if (netZat < 0 && vinCount > 0) {
		side = 'shield';
		amountZat = -netZat;
	} else if (netZat > 0 && voutZat > 0) {
		side = 'deshield';
		amountZat = voutZat;
	} else {
		return null;
	}
	if (amountZat < minBoundaryZat) return null;
	return { side, amountZat, netZat };
};

export default {
	ZATOSHIS_PER_ZEC,
	COMMON_AMOUNTS_ZEC,
	MIN_BOUNDARY_ZAT_DEFAULT,
	zecToZats,
	zatsToZec,
	formatZec,
	isCommonAmount,
	suggestAmounts,
	classifyAmount,
	assessRoundTripRisk,
	summariseNoteAmounts,
	assessNotePrivacy,
	planAmountSplit,
	parseAmountList,
	buildAmountAdvice,
	isCoinbaseTx,
	hasShieldedComponent,
	txNetShieldedZat,
	transparentVoutZat,
	transparentVinCount,
	classifyBoundaryTx,
};
