import { cents, dollarsToCents, type Cents } from './money.js';
import type { EvalState, StateSpace } from './types.js';

export type TemplateId =
  | 'binary_protect' | 'categorical_exclude'
  | 'threshold_digital' | 'linear_strip' | 'range_protect' | 'tail_only';

export type TargetShape =
  | { templateId: 'binary_protect'; payoutUsd: number; badKey: string }
  | { templateId: 'categorical_exclude'; payoutUsd: number; badKeys: string[] }
  | { templateId: 'threshold_digital'; payoutUsd: number; direction: 'below' | 'above'; k: number }
  | { templateId: 'tail_only'; payoutUsd: number; direction: 'below' | 'above'; k: number }
  | { templateId: 'range_protect'; payoutUsd: number; low: number; high: number }
  | { templateId: 'linear_strip'; payoutUsd: number; direction: 'below' | 'above'; k1: number; k2: number };

export function isCategorical(
  shape: TargetShape,
): shape is Extract<TargetShape, { templateId: 'binary_protect' | 'categorical_exclude' }> {
  return shape.templateId === 'binary_protect' || shape.templateId === 'categorical_exclude';
}

/** Levels the state space must split on so the target is exact. */
export function levelsOf(shape: TargetShape): number[] {
  switch (shape.templateId) {
    case 'threshold_digital':
    case 'tail_only': return [shape.k];
    case 'range_protect': return [shape.low, shape.high];
    case 'linear_strip': return [shape.k1, shape.k2];
    default: return [];
  }
}

/** Payout in dollars at underlying price `x`. Piecewise linear throughout. */
export function payoutAt(shape: TargetShape, x: number): number {
  switch (shape.templateId) {
    case 'threshold_digital':
    case 'tail_only':
      return shape.direction === 'below'
        ? (x < shape.k ? shape.payoutUsd : 0)
        : (x > shape.k ? shape.payoutUsd : 0);
    case 'range_protect':
      return x < shape.low || x > shape.high ? shape.payoutUsd : 0;
    case 'linear_strip': {
      const span = shape.k2 - shape.k1;
      if (span === 0) return 0;
      const raw = shape.direction === 'below'
        ? (shape.k2 - x) / span
        : (x - shape.k1) / span;
      return shape.payoutUsd * Math.min(1, Math.max(0, raw));
    }
    default:
      throw new Error(`payoutAt: ${shape.templateId} is categorical`);
  }
}

/**
 * Points that bound the payoff's range over one evaluation state.
 *
 * States are half-open `[lo, hi)`, so `lo` is sampled and `hi` never is —
 * sampling `hi` would evaluate a price belonging to the next state and
 * invent a discontinuity. Parameter levels are clamped into the state.
 * Every template is piecewise linear, so these points bound it exactly.
 */
function samplePoints(state: EvalState, shape: TargetShape): number[] {
  const hasLo = state.lo !== null;
  const hasHi = state.hi !== null;
  const width = hasLo && hasHi ? state.hi! - state.lo! : 1;
  const nudge = Math.max(Math.abs(width) * 1e-9, Number.EPSILON);
  const step = Math.max(Math.abs(width), 1) * 1e6;

  const lo = hasLo ? state.lo! : (hasHi ? state.hi! - step : -step);
  const hi = hasHi ? state.hi! - nudge : (hasLo ? state.lo! + step : step);

  const pts = [lo, hi];
  for (const lv of levelsOf(shape)) {
    for (const p of [lv - nudge, lv, lv + nudge]) {
      if (p >= lo && p <= hi) pts.push(p);
    }
  }
  return pts;
}

export interface TargetVectorResult {
  target: Cents[];
  /** The cost of conservatism: max minus min owed within a state. Zero for
   *  every digital template once states are split at its levels. */
  overhedgeCents: Cents;
  worstEvalId: string | null;
}

export function targetVector(shape: TargetShape, stateSpace: StateSpace): TargetVectorResult {
  if (isCategorical(shape)) {
    const bad = new Set(
      shape.templateId === 'binary_protect' ? [shape.badKey] : shape.badKeys,
    );
    for (const key of bad) {
      if (!stateSpace.tradable.some((t) => t.key === key)) {
        throw new Error(`targetVector: shape names key ${key} absent from the state space`);
      }
    }
    const payout = 'payoutUsd' in shape ? shape.payoutUsd : 0;
    return {
      target: stateSpace.evals.map((e) =>
        bad.has(e.tradableKey) ? dollarsToCents(payout) : cents(0)),
      overhedgeCents: cents(0),
      worstEvalId: null,
    };
  }

  if (stateSpace.evals.some((e) => e.lo === null && e.hi === null)) {
    throw new Error('targetVector: price shape given a categorical state space');
  }

  const target: Cents[] = [];
  let worstSpread = 0;
  let worstEvalId: string | null = null;

  for (const state of stateSpace.evals) {
    const values = samplePoints(state, shape).map((x) => payoutAt(shape, x));
    const max = Math.max(...values);
    const min = Math.min(...values);
    // Conservative: never understate what might be owed inside this state.
    target.push(dollarsToCents(max));
    if (max - min > worstSpread) {
      worstSpread = max - min;
      worstEvalId = state.id;
    }
  }

  return {
    target,
    overhedgeCents: dollarsToCents(worstSpread),
    worstEvalId: worstSpread > 0 ? worstEvalId : null,
  };
}
