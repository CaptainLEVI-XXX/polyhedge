import { cents, type Cents } from './money.js';
import type { StateSpace } from './types.js';

export interface Residual {
  /** Dollar-weighted share of the target the basket pays, clamped per state. */
  coverageRatio: number;
  worstStateShortfallCents: Cents;
  worstStateLabel: string | null;
  /** Excess from conservative evaluation of a payoff that varies inside a bracket. */
  overhedgeCents: Cents;
  /**
   * Payout bought BEYOND what the exposure owes, summed over every state.
   *
   * Note the scope: this is `Σ max(0, achievable − target)` across all
   * states, so it counts both payout in a state that owes nothing AND
   * excess payout in a state that owes something. The second is easy to
   * overlook — an earlier version of this comment described only the
   * first, which understated the field by construction.
   *
   * Not waste: the neg-risk complement is often the cheapest — sometimes the
   * only — route to covering a state that IS owed, and this is the price of
   * that route. But it is money spent on payout the exposure does not need,
   * so the user sees it rather than discovering it at settlement.
   */
  crossStateOverhedgeCents: Cents;
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
  let crossStateOverhedge = 0;

  for (let t = 0; t < target.length; t += 1) {
    const f = target[t] ?? 0;
    const g = achievable[t] ?? 0;
    owed += f;
    // Clamp: paying double in one state cannot offset paying nothing in another.
    covered += Math.min(g, f);
    if (f - g > worstShortfall) { worstShortfall = f - g; worstIndex = t; }
    // Payout bought in states where nothing is owed.
    crossStateOverhedge += Math.max(0, g - f);
  }

  return {
    coverageRatio: owed === 0 ? 1 : covered / owed,
    worstStateShortfallCents: cents(Math.round(worstShortfall)),
    worstStateLabel: worstIndex >= 0 ? (stateSpace.evals[worstIndex]?.label ?? null) : null,
    overhedgeCents: input.overhedgeCents,
    crossStateOverhedgeCents: cents(Math.round(crossStateOverhedge)),
    ruleFlags: [...input.ruleFlags],
    correlationResidual: input.correlationResidual,
  };
}
