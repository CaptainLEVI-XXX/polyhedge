import { cents, type Cents } from './money.js';
import type { StateSpace } from './types.js';

export interface Residual {
  /** Dollar-weighted share of the target the basket pays, clamped per state. */
  coverageRatio: number;
  worstStateShortfallCents: Cents;
  worstStateLabel: string | null;
  /** Excess from conservative evaluation of a payoff that varies inside a bracket. */
  overhedgeCents: Cents;
  ruleFlags: string[];
  correlationResidual: boolean;
}

export interface ResidualInput {
  stateSpace: StateSpace;
  target: Cents[];
  achievable: Cents[];
  overhedgeCents: Cents;
  ruleFlags: string[];
  correlationResidual: boolean;
}

export function buildResidual(input: ResidualInput): Residual {
  const { stateSpace, target, achievable } = input;

  let owed = 0;
  let covered = 0;
  let worstShortfall = 0;
  let worstIndex = -1;

  for (let t = 0; t < target.length; t += 1) {
    const f = target[t] ?? 0;
    const g = achievable[t] ?? 0;
    owed += f;
    // Clamp: paying double in one state cannot offset paying nothing in another.
    covered += Math.min(g, f);
    if (f - g > worstShortfall) { worstShortfall = f - g; worstIndex = t; }
  }

  return {
    coverageRatio: owed === 0 ? 1 : covered / owed,
    worstStateShortfallCents: cents(Math.round(worstShortfall)),
    worstStateLabel: worstIndex >= 0 ? (stateSpace.evals[worstIndex]?.label ?? null) : null,
    overhedgeCents: input.overhedgeCents,
    ruleFlags: [...input.ruleFlags],
    correlationResidual: input.correlationResidual,
  };
}
