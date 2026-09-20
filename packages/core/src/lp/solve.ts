import loadHighs from 'highs';
import type { Cents } from '../money.js';
import { buildLpModel, type LpInput, type LpModel } from './model.js';

/**
 * Pinned on every solve. `"choose"` lets HiGHS pick a different code path
 * by problem size or hardware; `presolve: "off"` removes the
 * presolve/postsolve round trip; `simplex` returns a vertex rather than a
 * tolerance-dependent interior point.
 */
export const SOLVER_OPTIONS = {
  output_flag: false,
  presolve: 'off',
  solver: 'simplex',
  simplex_strategy: 1,
  parallel: 'off',
  threads: 1,
  random_seed: 0,
} as const;

/**
 * Slack on phase 2's shortfall cap, so float error in the `M` phase 1
 * reports cannot make phase 2 infeasible.
 *
 * Deliberately far smaller than it needs to be for that job. Any slack here
 * is budget the solver can legitimately spend on shortfall to reduce cost,
 * so it must stay below the precision anything downstream can observe:
 * share counts are rounded to 6 decimals later, which erases 1e-9 entirely.
 */
const SHORTFALL_TOLERANCE = 1e-9;

export class LpNotOptimalError extends Error {
  constructor(public readonly status: string, public readonly phase: string) {
    super(`LP phase ${phase} returned status "${status}"; refusing to quote`);
    this.name = 'LpNotOptimalError';
  }
}

export interface LpSolution {
  objective: number;
  primal: Record<string, number>;
}

let highsPromise: Promise<Awaited<ReturnType<typeof loadHighs>>> | null = null;
function highs() { highsPromise ??= loadHighs(); return highsPromise; }

export async function solveLp(model: LpModel, phaseName = 'unknown'): Promise<LpSolution> {
  const h = await highs();
  const result = h.solve(model.text, { ...SOLVER_OPTIONS });

  const status = String(result.Status);
  if (status !== 'Optimal') throw new LpNotOptimalError(status, phaseName);

  const primal: Record<string, number> = {};
  for (const [name, col] of Object.entries(result.Columns as Record<string, { Primal: number }>)) {
    primal[name] = col.Primal;
  }
  return { objective: Number(result.ObjectiveValue), primal };
}

export interface LexicographicResult {
  solution: LpSolution;
  maxShortfallDollars: number;
  phase1Hash: string;
  phase2Hash: string;
}

/**
 * The coverage policy: minimize the worst-case dollar shortfall, then
 * minimize cost among solutions achieving it. Only phase 1's optimal VALUE
 * carries forward, never its basket, so phase 1 degeneracy cannot affect
 * the quote.
 */
export async function solveLexicographic(
  input: LpInput,
  budgetCents: Cents | null,
): Promise<LexicographicResult> {
  // RULING D: `mu` lives in LpInput only. The plan passed it both ways,
  // which invites the two copies to drift apart.
  const withBudget = { ...input, budgetCents };

  const phase1 = buildLpModel(withBudget, { kind: 'minimax' });
  const r1 = await solveLp(phase1, 'minimax');
  const maxShortfallDollars = Math.max(0, r1.primal['M'] ?? 0);

  const phase2 = buildLpModel(withBudget, {
    kind: 'cost',
    maxShortfallDollars: maxShortfallDollars + SHORTFALL_TOLERANCE,
  });
  const r2 = await solveLp(phase2, 'cost');

  return {
    solution: r2,
    maxShortfallDollars,
    phase1Hash: phase1.hash,
    phase2Hash: phase2.hash,
  };
}
