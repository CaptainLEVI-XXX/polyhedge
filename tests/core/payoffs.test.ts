import { describe, expect, it } from 'vitest';
import { buildCategoricalStateSpace, buildStateSpace } from '../../packages/core/src/state-space.js';
import { type TradableItem } from '../../packages/core/src/types.js';
import { levelsOf, payoutAt, targetVector, type TargetShape } from '../../packages/core/src/shapes.js';
import { payoffMatrix, type Leg } from '../../packages/core/src/payoff-matrix.js';

const br = (lo: number | null, hi: number | null) => ({ lo, hi });
const ladder: TradableItem[] = [
  { key: 'mA', bracket: br(null, 68000) },
  { key: 'mB', bracket: br(68000, 70000) },
  { key: 'mC', bracket: br(70000, 72000) },
  { key: 'mD', bracket: br(72000, null) },
];

describe('buildStateSpace', () => {
  it('sorts tradable states ascending while preserving caller keys', () => {
    const shuffled = [ladder[2]!, ladder[0]!, ladder[3]!, ladder[1]!];
    expect(buildStateSpace(shuffled, []).tradable.map((t) => t.key))
      .toEqual(['mA', 'mB', 'mC', 'mD']);
  });

  it('produces one evaluation state per bracket when no levels are given', () => {
    const ss = buildStateSpace(ladder, []);
    expect(ss.evals).toHaveLength(4);
    expect(ss.evals.map((e) => e.tradableKey)).toEqual(['mA', 'mB', 'mC', 'mD']);
  });

  it('splits a bracket at a level falling strictly inside it', () => {
    const ss = buildStateSpace(ladder, [69000]);
    expect(ss.evals).toHaveLength(5);
    const inB = ss.evals.filter((e) => e.tradableKey === 'mB');
    expect(inB.map((e) => [e.lo, e.hi])).toEqual([[68000, 69000], [69000, 70000]]);
  });

  it('does not split at a level sitting exactly on a bracket boundary', () => {
    expect(buildStateSpace(ladder, [70000]).evals).toHaveLength(4);
  });

  it('splits at several levels inside one bracket, in ascending order', () => {
    const ss = buildStateSpace(ladder, [69500, 68500]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mB').map((e) => e.lo))
      .toEqual([68000, 68500, 69500]);
  });

  it('ignores duplicate levels', () => {
    expect(buildStateSpace(ladder, [69000, 69000]).evals).toHaveLength(5);
  });

  it('splits both unbounded tails when levels fall inside them', () => {
    // the ladder tiles the whole real line, so every finite level lands in
    // some bracket — there is no such thing as a level outside it
    const ss = buildStateSpace(ladder, [1, 999999]);
    expect(ss.evals.map((e) => [e.lo, e.hi])).toEqual([
      [null, 1], [1, 68000],
      [68000, 70000],
      [70000, 72000],
      [72000, 999999], [999999, null],
    ]);
  });

  it('splits an unbounded lower tail', () => {
    const ss = buildStateSpace(ladder, [60000]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mA').map((e) => [e.lo, e.hi]))
      .toEqual([[null, 60000], [60000, 68000]]);
  });

  it('splits an unbounded upper tail', () => {
    const ss = buildStateSpace(ladder, [80000]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mD').map((e) => [e.lo, e.hi]))
      .toEqual([[72000, 80000], [80000, null]]);
  });

  it('gives evaluation states stable ascending ids', () => {
    expect(buildStateSpace(ladder, [69000]).evals.map((e) => e.id))
      .toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('throws on a ladder with a gap', () => {
    expect(() => buildStateSpace(
      [{ key: 'a', bracket: br(null, 1) }, { key: 'b', bracket: br(2, null) }], [],
    )).toThrow(/gap/);
  });

  it('throws on a ladder with an overlap', () => {
    expect(() => buildStateSpace(
      [{ key: 'a', bracket: br(null, 3) }, { key: 'b', bracket: br(2, null) }], [],
    )).toThrow(/overlap/);
  });

  it('throws on duplicate keys, which would make the join ambiguous', () => {
    expect(() => buildStateSpace(
      [{ key: 'x', bracket: br(null, 1) }, { key: 'x', bracket: br(1, null) }], [],
    )).toThrow(/duplicate key/);
  });

  it('throws deterministically when two brackets are both unbounded below', () => {
    // exercises the sort comparator's symmetry: whichever order these land in,
    // the result must be the same thrown error, never a silent pass
    const items = [
      { key: 'a', bracket: br(null, 68000) },
      { key: 'b', bracket: br(null, 70000) },
      { key: 'c', bracket: br(70000, null) },
    ];
    expect(() => buildStateSpace(items, [])).toThrow();
    expect(() => buildStateSpace([items[1]!, items[0]!, items[2]!], [])).toThrow();
  });

  it('throws on an empty ladder', () => {
    expect(() => buildStateSpace([], [])).toThrow(/empty/);
  });
});

describe('buildCategoricalStateSpace', () => {
  it('maps each outcome to one tradable and one evaluation state', () => {
    const ss = buildCategoricalStateSpace([
      { key: 'mYes', label: 'yes' }, { key: 'mNo', label: 'no' },
    ]);
    expect(ss.tradable.map((t) => t.key)).toEqual(['mYes', 'mNo']);
    expect(ss.evals.map((e) => e.tradableKey)).toEqual(['mYes', 'mNo']);
    expect(ss.evals.map((e) => e.id)).toEqual(['e0', 'e1']);
  });
});

const shapeBr = (lo: number | null, hi: number | null) => ({ lo, hi });
const shapeLadder: TradableItem[] = [
  { key: 'mA', bracket: shapeBr(null, 68000) },
  { key: 'mB', bracket: shapeBr(68000, 70000) },
  { key: 'mC', bracket: shapeBr(70000, 72000) },
  { key: 'mD', bracket: shapeBr(72000, null) },
];
const spaceFor = (s: TargetShape) => buildStateSpace(shapeLadder, levelsOf(s));
const byLabel = (s: TargetShape) => {
  const ss = spaceFor(s);
  const { target } = targetVector(s, ss);
  return Object.fromEntries(ss.evals.map((e, i) => [e.label, target[i]]));
};

describe('payoutAt', () => {
  it('threshold_digital below pays strictly under the strike', () => {
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 70000 };
    expect(payoutAt(s, 69999)).toBe(1000);
    expect(payoutAt(s, 70000)).toBe(0);
  });
  it('threshold_digital above pays strictly over the strike', () => {
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'above', k: 70000 };
    expect(payoutAt(s, 70001)).toBe(1000);
    expect(payoutAt(s, 70000)).toBe(0);
  });
  it('range_protect pays outside the range only', () => {
    const s: TargetShape = { templateId: 'range_protect', payoutUsd: 500, low: 68000, high: 72000 };
    expect(payoutAt(s, 67000)).toBe(500);
    expect(payoutAt(s, 70000)).toBe(0);
    expect(payoutAt(s, 73000)).toBe(500);
  });
  it('linear_strip ramps and clamps at both ends', () => {
    const s: TargetShape = { templateId: 'linear_strip', payoutUsd: 1000, direction: 'below', k1: 68000, k2: 72000 };
    expect(payoutAt(s, 72000)).toBe(0);
    expect(payoutAt(s, 70000)).toBe(500);
    expect(payoutAt(s, 68000)).toBe(1000);
    expect(payoutAt(s, 60000)).toBe(1000);
    expect(payoutAt(s, 80000)).toBe(0);
  });
  it('throws when given a categorical shape', () => {
    const s: TargetShape = { templateId: 'binary_protect', payoutUsd: 1, badKey: 'x' };
    expect(() => payoutAt(s, 1)).toThrow(/categorical/);
  });
});

describe('levelsOf', () => {
  it('returns the split points each template needs', () => {
    expect(levelsOf({ templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 5 })).toEqual([5]);
    expect(levelsOf({ templateId: 'tail_only', payoutUsd: 1, direction: 'below', k: 5 })).toEqual([5]);
    expect(levelsOf({ templateId: 'range_protect', payoutUsd: 1, low: 2, high: 8 })).toEqual([2, 8]);
    expect(levelsOf({ templateId: 'linear_strip', payoutUsd: 1, direction: 'below', k1: 2, k2: 8 })).toEqual([2, 8]);
    expect(levelsOf({ templateId: 'binary_protect', payoutUsd: 1, badKey: 'x' })).toEqual([]);
  });
});

describe('targetVector', () => {
  it('is exact for a strike aligned to a bracket boundary', () => {
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 70000 };
    const { target, overhedgeCents } = targetVector(s, spaceFor(s));
    expect(target).toEqual([100_000, 100_000, 0, 0]);
    expect(overhedgeCents).toBe(0);
  });

  it('splits a bracket exactly when the strike falls inside it', () => {
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 10_000, direction: 'below', k: 69000 };
    const ss = spaceFor(s);
    const { target, overhedgeCents } = targetVector(s, ss);
    expect(ss.evals.map((e) => e.label))
      .toEqual(['<68000', '68000-69000', '69000-70000', '70000-72000', '>72000']);
    expect(target).toEqual([1_000_000, 1_000_000, 0, 0, 0]);
    expect(overhedgeCents).toBe(0);
  });

  it('covers both tails for range_protect', () => {
    const s: TargetShape = { templateId: 'range_protect', payoutUsd: 1000, low: 69000, high: 71000 };
    const m = byLabel(s);
    expect(m['<68000']).toBe(100_000);
    expect(m['68000-69000']).toBe(100_000);
    expect(m['69000-70000']).toBe(0);
    expect(m['70000-71000']).toBe(0);
    expect(m['>72000']).toBe(100_000);
  });

  it('never understates a linear strip, and reports the over-hedge', () => {
    const s: TargetShape = { templateId: 'linear_strip', payoutUsd: 1000, direction: 'below', k1: 68000, k2: 72000 };
    const m = byLabel(s);
    expect(m['<68000']).toBe(100_000);
    expect(m['68000-70000']).toBe(100_000);
    expect(m['70000-72000']).toBe(50_000);
    expect(m['>72000']).toBe(0);
    expect(targetVector(s, spaceFor(s)).overhedgeCents).toBe(50_000);
  });

  it('handles tail_only like a far digital', () => {
    const s: TargetShape = { templateId: 'tail_only', payoutUsd: 2000, direction: 'below', k: 68000 };
    const m = byLabel(s);
    expect(m['<68000']).toBe(200_000);
    expect(m['68000-70000']).toBe(0);
  });

  it('routes categorical templates without touching the price path', () => {
    const ss = buildCategoricalStateSpace([
      { key: 'mCut', label: 'cut' }, { key: 'mHold', label: 'hold' }, { key: 'mHike', label: 'hike' },
    ]);
    const s: TargetShape = { templateId: 'categorical_exclude', payoutUsd: 2000, badKeys: ['mHold', 'mHike'] };
    const { target, overhedgeCents } = targetVector(s, ss);
    expect(target).toEqual([0, 200_000, 200_000]);
    expect(overhedgeCents).toBe(0);
  });

  it('handles binary_protect as a one-outcome categorical', () => {
    const ss = buildCategoricalStateSpace([{ key: 'mNo', label: 'denied' }, { key: 'mYes', label: 'approved' }]);
    const s: TargetShape = { templateId: 'binary_protect', payoutUsd: 1200, badKey: 'mNo' };
    expect(targetVector(s, ss).target).toEqual([120_000, 0]);
  });

  it('throws when a categorical shape names a key absent from the state space', () => {
    const ss = buildCategoricalStateSpace([{ key: 'mYes', label: 'y' }]);
    const s: TargetShape = { templateId: 'binary_protect', payoutUsd: 1, badKey: 'nope' };
    expect(() => targetVector(s, ss)).toThrow(/nope/);
  });

  it('throws when a price shape is given a categorical state space', () => {
    const ss = buildCategoricalStateSpace([{ key: 'm', label: 'y' }]);
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 1 };
    expect(() => targetVector(s, ss)).toThrow(/price shape/);
  });

  it('produces a zero vector for a zero payout', () => {
    const s: TargetShape = { templateId: 'threshold_digital', payoutUsd: 0, direction: 'below', k: 70000 };
    expect(targetVector(s, spaceFor(s)).target).toEqual([0, 0, 0, 0]);
  });
});

const matrixBr = (lo: number | null, hi: number | null) => ({ lo, hi });
const matrixLadder = [
  { key: 'mA', bracket: matrixBr(null, 68000) },
  { key: 'mB', bracket: matrixBr(68000, 70000) },
  { key: 'mC', bracket: matrixBr(70000, null) },
];
const leg = (id: string, key: string, side: 'YES' | 'NO'): Leg =>
  ({ id, marketId: key, label: `bracket ${key}`, tokenId: `tok_${id}`, side, tradableKey: key });

describe('payoffMatrix', () => {
  it('gives a YES leg a one in its own state only', () => {
    expect(payoffMatrix([leg('a', 'mB', 'YES')], buildStateSpace(matrixLadder, []))).toEqual([[0, 1, 0]]);
  });

  it('gives a NO leg a one in every state but its own', () => {
    expect(payoffMatrix([leg('a', 'mB', 'NO')], buildStateSpace(matrixLadder, []))).toEqual([[1, 0, 1]]);
  });

  it('pays across EVERY evaluation state of a split bracket', () => {
    const ss = buildStateSpace(matrixLadder, [69000]); // mB splits in two
    expect(payoffMatrix([leg('a', 'mB', 'YES')], ss)).toEqual([[0, 1, 1, 0]]);
  });

  it('gives a NO leg zeros across every evaluation state of its own bracket', () => {
    const ss = buildStateSpace(matrixLadder, [69000]);
    expect(payoffMatrix([leg('a', 'mB', 'NO')], ss)).toEqual([[1, 0, 0, 1]]);
  });

  it('makes YES and NO exact complements across split states', () => {
    const ss = buildStateSpace(matrixLadder, [69000]);
    const [yes, no] = payoffMatrix([leg('a', 'mB', 'YES'), leg('b', 'mB', 'NO')], ss);
    yes!.forEach((v, i) => expect(v + no![i]!).toBe(1));
  });

  it('keeps row order aligned with leg order', () => {
    const ss = buildStateSpace(matrixLadder, []);
    expect(payoffMatrix([leg('a', 'mA', 'YES'), leg('b', 'mC', 'YES')], ss))
      .toEqual([[1, 0, 0], [0, 0, 1]]);
  });

  it('is unaffected by the order markets arrived in', () => {
    const a = payoffMatrix([leg('x', 'mB', 'YES')], buildStateSpace(matrixLadder, []));
    const b = payoffMatrix([leg('x', 'mB', 'YES')], buildStateSpace([matrixLadder[2]!, matrixLadder[0]!, matrixLadder[1]!], []));
    expect(a).toEqual(b);
  });

  it('throws when a leg names a tradable key that does not exist', () => {
    expect(() => payoffMatrix([leg('a', 'mZ', 'YES')], buildStateSpace(matrixLadder, []))).toThrow(/mZ/);
  });
});
