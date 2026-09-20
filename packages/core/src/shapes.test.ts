import { describe, expect, it } from 'vitest';
import { levelsOf, payoutAt, targetVector, type TargetShape } from './shapes.js';
import { buildCategoricalStateSpace, buildStateSpace } from './state-space.js';
import type { TradableItem } from './types.js';

const br = (lo: number | null, hi: number | null) => ({ lo, hi });
const ladder: TradableItem[] = [
  { key: 'mA', bracket: br(null, 68000) },
  { key: 'mB', bracket: br(68000, 70000) },
  { key: 'mC', bracket: br(70000, 72000) },
  { key: 'mD', bracket: br(72000, null) },
];
const spaceFor = (s: TargetShape) => buildStateSpace(ladder, levelsOf(s));
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
