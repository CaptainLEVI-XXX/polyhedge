import { allocate, cents, dollarsToCents, type Cents } from './money.js';
import { walkBook, type BookLevel } from './book.js';
import { payoffMatrix, type Leg } from './payoff-matrix.js';
import { buildResidual, type Residual } from './residual.js';
import { targetVector, type TargetShape } from './shapes.js';
import { solveLexicographic } from './lp/solve.js';
import type { StateSpace } from './types.js';
import type { ProtectionGoal, ExecutionConstraints } from './lp/model.js';

export class BasketValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'BasketValidationError'; }
}

export interface QuotedLeg {
  legId: string;
  /** Venue market id. */
  marketId: string;
  /** Human-readable bracket label, e.g. "<68,000". Display only. */
  label: string;
  tokenId: string; side: 'YES' | 'NO';
  shares: number; costCents: Cents; avgPriceMicros: number;
}

export interface Basket {
  legs: QuotedLeg[];
  totalCostCents: Cents;
  target: Cents[];
  achievable: Cents[];
  residual: Residual;
  maxShortfallDollars: number;
  /** The over-hedge penalty this basket was solved under; a replay must reuse it. */
  mu: number;
  phase1Hash: string;
  phase2Hash: string;
  /** Max(target + premium - payout), floored at zero; not a probability. */
  worstNetLossCents?: Cents;
}

export interface BuildBasketArgs {
  shape: TargetShape;
  stateSpace: StateSpace;
  legs: Leg[];
  books: BookLevel[][];
  feeRates: number[];
  budgetCents: Cents | null;
  ruleFlags: string[];
  correlationResidual: boolean;
  mu?: number;
  protectionGoal?: ProtectionGoal;
  execution?: ExecutionConstraints;
  /** Market-expected payout per share of each leg; see `LpInput.expectedPayouts`. */
  expectedPayouts?: number[];
  /** Test-only override, used to exercise the validator. */
  forceSharesForTest?: number[];
}

/** Fix precision once so the basket, the cost and any re-solve agree. */
function roundShares(x: number): number { return Math.round(x * 1e6) / 1e6; }

export async function buildBasket(args: BuildBasketArgs): Promise<Basket> {
  const { shape, stateSpace, legs, books, feeRates, budgetCents } = args;
  const mu = args.mu ?? (args.protectionGoal ? 0 : 0.001);
  const execution = args.execution;
  if (execution) {
    if (!Number.isFinite(execution.quantityStep) || execution.quantityStep < 1e-6
      || Math.abs(execution.quantityStep * 1e6 - Math.round(execution.quantityStep * 1e6)) > 1e-8
      || execution.minShares.length !== legs.length
      || execution.minShares.some(n => !Number.isFinite(n) || n < 0)
      || (execution.maxLegs !== undefined && (!Number.isInteger(execution.maxLegs) || execution.maxLegs < 1))) {
      throw new BasketValidationError('invalid execution constraints');
    }
  }
  if (!Number.isFinite(mu) || mu < 0) throw new BasketValidationError('invalid excess-payout penalty');
  if (args.protectionGoal?.kind === 'limit_net_loss' && mu !== 0) {
    throw new BasketValidationError('minimum-cost loss-limit mode requires mu = 0');
  }

  const { target, overhedgeCents } = targetVector(shape, stateSpace);
  const matrix = payoffMatrix(legs, stateSpace);

  // RULING D: solveLexicographic takes (input, budgetCents); mu lives in input.
  const lex = await solveLexicographic(
    { target, matrix, books, feeRates, mu, budgetCents,
      ...(args.protectionGoal ? { protectionGoal: args.protectionGoal } : {}),
      ...(args.expectedPayouts ? { expectedPayouts: args.expectedPayouts } : {}),
      ...(execution ? { execution } : {}) }, budgetCents,
  );

  const requested = legs.map(() => 0);
  for (const name of Object.keys(lex.solution.primal)) {
    const m = /^x_(\d+)_(\d+)$/.exec(name);
    if (!m) continue;
    const j = Number(m[1]);
    requested[j] = (requested[j] ?? 0) + (lex.solution.primal[name] ?? 0);
  }

  const shares = (args.forceSharesForTest ?? requested).map(n => roundShares(
    execution && !args.forceSharesForTest ? Math.round(n / execution.quantityStep) * execution.quantityStep : n));
  if (execution) {
    if (shares.some((n, j) => n < -1e-6 || (n > 1e-6 && n + 1e-6 < execution.minShares[j]!)
      || Math.abs(n / execution.quantityStep - Math.round(n / execution.quantityStep)) > 1e-5)
      || (execution.maxLegs !== undefined && shares.filter(n => n > 1e-6).length > execution.maxLegs)) {
      throw new BasketValidationError('basket violates order size or leg-count constraints');
    }
  }

  // Recompute everything from the rounded shares. Nothing from the solver
  // is trusted past this point.
  const walks = legs.map((_, j) => walkBook(books[j] ?? [], shares[j] ?? 0, feeRates[j] ?? 0));

  for (let j = 0; j < legs.length; j += 1) {
    const want = shares[j] ?? 0;
    const got = walks[j]!.filled;
    if (got + 1e-6 < want) {
      throw new BasketValidationError(
        `leg ${legs[j]!.id} needs ${want} shares but the book supplies ${got}`,
      );
    }
  }

  const totalCostDollars = walks.reduce((a, w) => a + w.costDollars, 0);
  const totalCostCents = dollarsToCents(totalCostDollars);

  if (budgetCents !== null && totalCostCents > budgetCents) {
    throw new BasketValidationError(
      `recomputed cost ${totalCostCents}c exceeds budget ${budgetCents}c`,
    );
  }

  const legCosts = allocate(totalCostCents, walks.map((w) => w.costDollars));

  const quotedLegs: QuotedLeg[] = legs.map((leg, j) => ({
    legId: leg.id, marketId: leg.marketId, label: leg.label, tokenId: leg.tokenId, side: leg.side,
    shares: shares[j] ?? 0,
    costCents: legCosts[j]!,
    avgPriceMicros: walks[j]!.avgPriceMicros,
  }));

  const achievable = stateSpace.evals.map((_, t) =>
    dollarsToCents(legs.reduce((a, _l, j) => a + (matrix[j]![t] ?? 0) * walks[j]!.filled, 0)),
  );

  const worstNetLossCents = cents(Math.max(0, ...target.map((t, i) => t + totalCostCents - achievable[i]!)));
  if (args.protectionGoal?.kind === 'limit_net_loss'
    && worstNetLossCents > dollarsToCents(args.protectionGoal.maxNetLossUsd)) {
    throw new BasketValidationError('rounded basket exceeds the requested net loss limit');
  }

  return {
    legs: quotedLegs,
    totalCostCents,
    target,
    achievable,
    residual: buildResidual({
      stateSpace, target, achievable, overhedgeCents,
      ruleFlags: args.ruleFlags, correlationResidual: args.correlationResidual,
    }),
    maxShortfallDollars: args.protectionGoal
      ? Math.max(0, ...target.map((t, i) => (t - achievable[i]!) / 100))
      : lex.maxShortfallDollars,
    worstNetLossCents,
    mu,
    phase1Hash: lex.phase1Hash,
    phase2Hash: lex.phase2Hash,
  };
}
