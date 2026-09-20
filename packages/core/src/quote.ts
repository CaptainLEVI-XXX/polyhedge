import { allocate, cents, dollarsToCents, type Cents } from './money.js';
import { walkBook, type BookLevel } from './book.js';
import { payoffMatrix, type Leg } from './payoff-matrix.js';
import { buildResidual, type Residual } from './residual.js';
import { targetVector, type TargetShape } from './shapes.js';
import { solveLexicographic } from './lp/solve.js';
import type { StateSpace } from './types.js';

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
  /** Test-only override, used to exercise the validator. */
  forceSharesForTest?: number[];
}

/** Fix precision once so the basket, the cost and any re-solve agree. */
function roundShares(x: number): number { return Math.round(x * 1e6) / 1e6; }

export async function buildBasket(args: BuildBasketArgs): Promise<Basket> {
  const { shape, stateSpace, legs, books, feeRates, budgetCents, mu = 0.001 } = args;

  const { target, overhedgeCents } = targetVector(shape, stateSpace);
  const matrix = payoffMatrix(legs, stateSpace);

  // RULING D: solveLexicographic takes (input, budgetCents); mu lives in input.
  const lex = await solveLexicographic(
    { target, matrix, books, feeRates, mu, budgetCents }, budgetCents,
  );

  const requested = legs.map(() => 0);
  for (const name of Object.keys(lex.solution.primal)) {
    const m = /^x_(\d+)_(\d+)$/.exec(name);
    if (!m) continue;
    const j = Number(m[1]);
    requested[j] = (requested[j] ?? 0) + (lex.solution.primal[name] ?? 0);
  }

  const shares = (args.forceSharesForTest ?? requested).map(roundShares);

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

  return {
    legs: quotedLegs,
    totalCostCents,
    target,
    achievable,
    residual: buildResidual({
      stateSpace, target, achievable, overhedgeCents,
      ruleFlags: args.ruleFlags, correlationResidual: args.correlationResidual,
    }),
    maxShortfallDollars: lex.maxShortfallDollars,
    mu,
    phase1Hash: lex.phase1Hash,
    phase2Hash: lex.phase2Hash,
  };
}
