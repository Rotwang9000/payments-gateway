// Tests for the Zcash amount-privacy advisor + on-chain tx classifier.
//
// The classifier fixtures are REAL transactions observed on zebra mainnet
// (heights ~3,390,4xx), trimmed to the fields the classifier reads, so the
// sign/guard rules stay pinned to actual chain behaviour:
//   • shield   h3390461 0f831ef717 — orchard valueBalanceZat −2752728181, 22 vin
//   • deshield h3390462 ac809e65a4 — orchard valueBalanceZat +2752728181, vout 27.52713181
//   • fee-only h3390452 f753e1bdcb — orchard +10000, no vin/vout (excluded)

import { describe, test, expect } from '@jest/globals';

import {
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
	classifyBoundaryTx,
	txNetShieldedZat,
	transparentVoutZat,
	transparentVinCount,
	isCoinbaseTx,
	hasShieldedComponent,
	COMMON_AMOUNTS_ZEC
} from '../src/zcash-amount-privacy.js';

describe('zat/zec conversions', () => {
	test('round-trips without float drift', () => {
		expect(zecToZats(1)).toBe(100_000_000);
		expect(zecToZats(0.0001)).toBe(10_000);
		expect(zatsToZec(2_752_728_181)).toBeCloseTo(27.52728181, 8);
		expect(formatZec(2_752_713_181)).toBe('27.52713181');
		expect(formatZec(100_000_000)).toBe('1');
		expect(formatZec(0)).toBe('0');
	});
});

describe('blend-in set + suggestions', () => {
	test('isCommonAmount matches the bundled list', () => {
		expect(isCommonAmount(1)).toBe(true);
		expect(isCommonAmount(0.123456)).toBe(false);
	});

	test('suggestAmounts returns nearest first', () => {
		const { target, suggestions } = suggestAmounts(0.9, { count: 3 });
		expect(target.zec).toBe(0.9);
		expect(suggestions[0].zec).toBe(1); // nearest common to 0.9
		expect(suggestions[0].direction).toBe('up');
	});

	test('a live popular feed overrides the bundled list and carries counts', () => {
		const popular = [{ zec: 3, count: 50 }, { zec: 7, count: 9 }];
		const { suggestions } = suggestAmounts(3.2, { popular, count: 2 });
		expect(suggestions[0].zec).toBe(3);
		expect(suggestions[0].usageCount).toBe(50);
		expect(isCommonAmount(3, popular)).toBe(true);
		expect(isCommonAmount(1, popular)).toBe(false); // 1 not in the live feed
	});
});

describe('classifyAmount + risk', () => {
	test('flags an uncommon amount as a fingerprint', () => {
		const c = classifyAmount(0.123456);
		expect(c.isCommon).toBe(false);
		expect(c.fingerprint).toBe(true);
		expect(c.nearest).toBeTruthy();
	});

	test('deshielding the exact value of a held note is a WARN self-dox', () => {
		const r = assessRoundTripRisk({ amountZec: 1, noteAmountsZec: [1, 5], action: 'deshield' });
		expect(r.level).toBe('warn');
		expect(r.exactMatch).toBe(true);
	});

	test('a common amount with no note match is OK', () => {
		const r = assessRoundTripRisk({ amountZec: 1, noteAmountsZec: [], action: 'deshield' });
		expect(r.level).toBe('ok');
		expect(r.isCommon).toBe(true);
	});

	test('an uncommon amount is at least caution', () => {
		const r = assessRoundTripRisk({ amountZec: 0.123456, action: 'shield' });
		expect(r.level).toBe('caution');
		expect(r.isCommon).toBe(false);
	});
});

describe('note summary', () => {
	test('splits common vs fingerprint value', () => {
		const s = summariseNoteAmounts([1, 1, 0.123456]);
		expect(s.count).toBe(3);
		expect(s.common.count).toBe(2);
		expect(s.fingerprint.count).toBe(1);
		const a = assessNotePrivacy(s);
		expect(['partial', 'high']).toContain(a.level);
	});
	test('empty note set', () => {
		expect(assessNotePrivacy(summariseNoteAmounts([])).level).toBe('empty');
	});
});

describe('parseAmountList', () => {
	test('splits on commas/whitespace and drops junk', () => {
		expect(parseAmountList('1, 2\n0.5  x -3')).toEqual([1, 2, 0.5]);
		expect(parseAmountList(null)).toEqual([]);
	});
});

describe('planAmountSplit (assisted split planner)', () => {
	test('splits a large amount into exact blend-in pieces', () => {
		const p = planAmountSplit(17.3, { action: 'deshield' });
		expect(p.exact).toBe(true);
		expect(p.remainder).toBeNull();
		expect(p.coverage.percent).toBe(100);
		// 17.3 = 10 + 5 + 2 + 0.25 + 0.05
		expect(p.pieceCount).toBe(5);
		expect(p.pieces.every((g) => g.common)).toBe(true);
		expect(p.pieces.map((g) => g.zec)).toEqual([10, 5, 2, 0.25, 0.05]);
		expect(p.effectiveness.level).toBe('good');
	});

	test('groups identical pieces as N × amount', () => {
		const p = planAmountSplit(0.002); // only 0.001 fits → 2 × 0.001
		expect(p.pieceCount).toBe(2);
		expect(p.pieces).toHaveLength(1);
		expect(p.pieces[0].count).toBe(2);
		expect(p.pieces[0].zec).toBe(0.001);
	});

	test('leftover below the smallest denomination is dust, not a fingerprint', () => {
		const p = planAmountSplit(3.14159, { maxPieces: 8 });
		expect(p.exact).toBe(false);
		expect(p.remainder.isDust).toBe(true);
		expect(p.effectiveness.level).toBe('good');
	});

	test('a piece cap leaves a fingerprinting remainder → partial', () => {
		const p = planAmountSplit(88, { maxPieces: 2 });
		expect(p.pieceCount).toBe(2);
		expect(p.exact).toBe(false);
		expect(p.remainder.isDust).toBe(false);
		expect(p.remainder.zec).toBe(13); // 88 − (50 + 25)
		expect(p.effectiveness.level).toBe('partial');
	});

	test('a single common amount needs no split', () => {
		const p = planAmountSplit(1);
		expect(p.pieceCount).toBe(1);
		expect(p.effectiveness.level).toBe('low');
	});

	test('an amount below the smallest denomination cannot be split', () => {
		const p = planAmountSplit(0.0005);
		expect(p.pieceCount).toBe(0);
		expect(p.remainder.zats).toBe(50_000);
		expect(p.effectiveness.level).toBe('low');
	});

	test('a live popular feed drives the denominations + counts', () => {
		const popular = [{ zec: 2, count: 10 }, { zec: 0.5, count: 4 }];
		const p = planAmountSplit(4.5, { popular });
		expect(p.source).toBe('live_index');
		expect(p.pieces[0].zec).toBe(2);
		expect(p.pieces[0].count).toBe(2); // 2 + 2 + 0.5
		expect(p.pieces[0].usageCount).toBe(10);
		expect(p.exact).toBe(true);
	});

	test('cautions are action-specific (address vs input side)', () => {
		const deshield = planAmountSplit(17.3, { action: 'deshield' });
		const shield = planAmountSplit(17.3, { action: 'shield' });
		expect(deshield.cautions.join(' ')).toMatch(/fresh transparent address/i);
		expect(shield.cautions.join(' ')).toMatch(/different transparent inputs/i);
		expect(deshield.cautions.join(' ')).toMatch(/it is not anonymity/i);
	});

	test('zero/invalid amount yields an empty plan', () => {
		const p = planAmountSplit(0);
		expect(p.pieceCount).toBe(0);
		expect(p.effectiveness.level).toBe('none');
	});
});

describe('buildAmountAdvice (one-shot payload)', () => {
	test('bundles suggestions, risk, and source flag', () => {
		const a = buildAmountAdvice({ amountZec: 1, action: 'deshield', noteAmountsZec: [1] });
		expect(a.amount_zats).toBe(100_000_000);
		expect(a.blend_in_source).toBe('bundled_list');
		expect(a.risk.level).toBe('warn');
		expect(a.suggestions.length).toBeGreaterThan(0);
		expect(a.note_summary).toBeTruthy();
		expect(a.caveat).toMatch(/does not guarantee anonymity/i);
	});
	test('reports live source when a popular feed is supplied', () => {
		const a = buildAmountAdvice({ amountZec: 3, popular: [{ zec: 3, count: 12 }] });
		expect(a.blend_in_source).toBe('live_index');
	});
	test('includes a split plan for an amount worth splitting, omits it for a single common amount', () => {
		expect(buildAmountAdvice({ amountZec: 1 }).split_plan).toBeNull();
		const a = buildAmountAdvice({ amountZec: 7.3 });
		expect(a.split_plan).toBeTruthy();
		expect(a.split_plan.pieceCount).toBeGreaterThan(1);
	});
});

// ── on-chain classifier (real-shaped fixtures) ───────────────────

const shieldTx = {
	vin: Array.from({ length: 22 }, (_, i) => ({ txid: `prev${i}`, vout: 0 })),
	vout: [],
	valueBalanceZat: 0,
	orchard: { actions: [{}, {}], valueBalanceZat: -2_752_728_181 },
	vShieldedSpend: [],
	vShieldedOutput: [],
	vjoinsplit: []
};

const deshieldTx = {
	vin: [],
	vout: [{ valueZat: 2_752_713_181, n: 0 }],
	valueBalanceZat: 0,
	orchard: { actions: [{}, {}], valueBalanceZat: 2_752_728_181 },
	vjoinsplit: []
};

const feeOnlyShieldedTx = {
	vin: [],
	vout: [],
	valueBalanceZat: 0,
	orchard: { actions: [{}, {}], valueBalanceZat: 10_000 }
};

const coinbaseTx = {
	vin: [{ coinbase: '03abcd', sequence: 0 }],
	vout: [{ valueZat: 125_000_000, n: 0 }],
	orchard: { actions: [], valueBalanceZat: 0 }
};

const saplingShieldTx = {
	vin: [{ txid: 'p', vout: 0 }],
	vout: [],
	valueBalanceZat: -100_000_000,
	orchard: { actions: [], valueBalanceZat: 0 },
	vShieldedOutput: [{}]
};

describe('classifyBoundaryTx', () => {
	test('orchard shield → side shield, amount |net|', () => {
		const c = classifyBoundaryTx(shieldTx);
		expect(c).toEqual({ side: 'shield', amountZat: 2_752_728_181, netZat: -2_752_728_181 });
	});

	test('orchard deshield → side deshield, amount = transparent vout', () => {
		const c = classifyBoundaryTx(deshieldTx);
		expect(c.side).toBe('deshield');
		expect(c.amountZat).toBe(2_752_713_181); // the value that arrived transparent
		expect(c.netZat).toBe(2_752_728_181);
	});

	test('fully-shielded fee-only tx is excluded (no transparent leg)', () => {
		expect(classifyBoundaryTx(feeOnlyShieldedTx)).toBeNull();
	});

	test('coinbase is excluded', () => {
		expect(isCoinbaseTx(coinbaseTx)).toBe(true);
		expect(classifyBoundaryTx(coinbaseTx)).toBeNull();
	});

	test('sapling shield works too', () => {
		const c = classifyBoundaryTx(saplingShieldTx);
		expect(c).toEqual({ side: 'shield', amountZat: 100_000_000, netZat: -100_000_000 });
	});

	test('a pure transparent tx (no shielded component) is excluded', () => {
		const t = { vin: [{ txid: 'a', vout: 0 }], vout: [{ valueZat: 5_000_000, n: 0 }], orchard: { actions: [] } };
		expect(hasShieldedComponent(t)).toBe(false);
		expect(classifyBoundaryTx(t)).toBeNull();
	});

	test('a crossing below minBoundaryZat is dropped', () => {
		const tiny = { vin: [{ txid: 'a', vout: 0 }], vout: [], orchard: { actions: [{}], valueBalanceZat: -50_000 } };
		expect(classifyBoundaryTx(tiny, { minBoundaryZat: 100_000 })).toBeNull();
		expect(classifyBoundaryTx(tiny, { minBoundaryZat: 10_000 })).toEqual({ side: 'shield', amountZat: 50_000, netZat: -50_000 });
	});

	test('helpers expose the raw components', () => {
		expect(txNetShieldedZat(deshieldTx)).toBe(2_752_728_181);
		expect(transparentVoutZat(deshieldTx)).toBe(2_752_713_181);
		expect(transparentVinCount(shieldTx)).toBe(22);
		expect(transparentVinCount(coinbaseTx)).toBe(0); // coinbase input doesn't count
	});

	test('legacy sprout vjoinsplit contributes to net', () => {
		const sproutDeshield = {
			vin: [],
			vout: [{ valueZat: 200_000_000, n: 0 }],
			vjoinsplit: [{ vpub_old: 0, vpub_new: 2 }] // 2 ZEC out of the sprout pool
		};
		expect(txNetShieldedZat(sproutDeshield)).toBe(200_000_000);
		expect(classifyBoundaryTx(sproutDeshield).side).toBe('deshield');
	});
});

describe('bundled list sanity', () => {
	test('is sorted ascending and unique', () => {
		const z = COMMON_AMOUNTS_ZEC.map(zecToZats);
		for (let i = 1; i < z.length; i += 1) expect(z[i]).toBeGreaterThan(z[i - 1]);
	});
});
