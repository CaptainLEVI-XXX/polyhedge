import {
  buildBasket, buildStateSpace, dollarsToCents, levelsOf, payoffMatrix,
  targetVector, walkBook,
  type BookLevel, type Leg, type TargetShape, type TradableItem, type ProtectionGoal,
} from '../../packages/core/src/index.js';

export interface Scenario {
  id: string;
  items: TradableItem[];
  shape: TargetShape;
  budgetUsd: number;
  legs: Leg[];
  books: BookLevel[][];
  feeRates: number[];
}

export interface Policy {
  id: string;
  sides: 'none' | 'yes' | 'both';
  mu: number;
  /** Reduce visible depth BEFORE constructing the basket. */
  planningDepth: number;
  protectionGoal?: ProtectionGoal;
  execution?: { quantityStep: number; minShares: number; maxLegs?: number };
}

export const policies: Policy[] = [
  { id: 'unhedged', sides: 'none', mu: 0.001, planningDepth: 1 },
  { id: 'yes-only', sides: 'yes', mu: 0.001, planningDepth: 1 },
  { id: 'current', sides: 'both', mu: 0.001, planningDepth: 1 },
  { id: 'depth-buffer', sides: 'both', mu: 0.001, planningDepth: 0.5 },
  { id: 'higher-overhedge-penalty', sides: 'both', mu: 0.1, planningDepth: 1 },
  { id: 'premium-aware', sides: 'both', mu: 0, planningDepth: 1,
    protectionGoal: { kind: 'minimize_net_loss' } },
  { id: 'executable-three-legs', sides: 'both', mu: 0, planningDepth: 1,
    protectionGoal: { kind: 'minimize_net_loss' }, execution: { quantityStep: 0.01, minShares: 5, maxLegs: 3 } },
];

export interface Metrics {
  costUsd: number;
  worstUncoveredUsd: number;
  /** Target loss + premium including fees - payout; may be negative. */
  worstNetLossUsd: number;
  maxExcessPayoutUsd: number;
  activeLegs: number;
}

function metrics(target: number[], payout: number[], costUsd: number, shares: number[]): Metrics {
  const gaps = target.map((t, i) => t / 100 - payout[i]!);
  return {
    costUsd,
    worstUncoveredUsd: Math.max(0, ...gaps),
    worstNetLossUsd: Math.max(...gaps) + costUsd,
    maxExcessPayoutUsd: Math.max(0, ...gaps.map(g => -g)),
    activeLegs: shares.filter(s => s > 1e-6).length,
  };
}

/** Synthetic depth stress: independent per-leg FOK at original limit/cost cap, no unwind.
 * Successful legs remain held to settlement. This is not the live executor.
 */
export async function evaluate(scenario: Scenario, policy: Policy, executionDepth = 0.5) {
  for (const ratio of [policy.planningDepth, executionDepth]) {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('depth must be in [0, 1]');
  }
  if (!Number.isFinite(scenario.budgetUsd) || scenario.budgetUsd < 0) throw new Error('invalid budget');
  if (!Number.isFinite(policy.mu) || policy.mu < 0) throw new Error('invalid mu');
  if (scenario.legs.length !== scenario.books.length || scenario.legs.length !== scenario.feeRates.length) {
    throw new Error('each leg requires a book and fee');
  }
  scenario.books.forEach((book, j) => {
    if (!Number.isFinite(scenario.feeRates[j]) || scenario.feeRates[j]! < 0) throw new Error('invalid fee');
    book.forEach((level, k) => {
      if (!Number.isFinite(level.size) || level.size < 0 || !Number.isInteger(level.priceMicros)
        || level.priceMicros <= 0 || level.priceMicros >= 1_000_000
        || (k > 0 && level.priceMicros < book[k - 1]!.priceMicros)) throw new Error('invalid asks');
    });
  });
  const stateSpace = buildStateSpace(scenario.items, levelsOf(scenario.shape));
  const target = targetVector(scenario.shape, stateSpace).target;
  const indices = scenario.legs.flatMap((leg, j) =>
    policy.sides === 'none' || (policy.sides === 'yes' && leg.side !== 'YES') ? [] : [j]);
  const legs = indices.map(j => scenario.legs[j]!);
  const books = indices.map(j => scenario.books[j]!);
  const fees = indices.map(j => scenario.feeRates[j]!);
  const basket = legs.length ? await buildBasket({
    shape: scenario.shape, stateSpace, legs,
    books: books.map(book => book.map(l => ({ ...l, size: l.size * policy.planningDepth }))),
    feeRates: fees, budgetCents: dollarsToCents(scenario.budgetUsd), mu: policy.mu,
    ruleFlags: [], correlationResidual: false,
    ...(policy.protectionGoal ? { protectionGoal: policy.protectionGoal } : {}),
    ...(policy.execution ? { execution: { ...policy.execution, minShares: legs.map(() => policy.execution!.minShares) } } : {}),
  }) : null;
  const shares = basket?.legs.map(l => l.shares) ?? [];
  const matrix = payoffMatrix(legs, stateSpace);
  const payouts = (quantities: number[]) => stateSpace.evals.map((_, s) =>
    quantities.reduce((sum, q, j) => sum + q * matrix[j]![s]!, 0));
  let stressedCost = 0;
  const filled = shares.map((quantity, j) => {
    if (quantity <= 1e-6) return 0;
    // Freeze the quoted limit. Do not buy worse levels after liquidity disappears.
    let remaining = quantity;
    let limit = 0;
    for (const level of books[j]!) {
      limit = level.priceMicros;
      remaining -= level.size * policy.planningDepth;
      if (remaining <= 1e-6) break;
    }
    const walk = walkBook(books[j]!.filter(l => l.priceMicros <= limit)
      .map(l => ({ ...l, size: l.size * executionDepth })), quantity, fees[j]!);
    if (walk.filled + 1e-6 < quantity) return 0;
    const plannedCost = walkBook(books[j]!.map(l => ({ ...l, size: l.size * policy.planningDepth })),
      quantity, fees[j]!).costDollars;
    // A deeper fill can respect the limit price but exceed the quoted budget.
    // Apply a zero-slippage per-leg spend cap before crediting any payout.
    if (walk.costDollars > plannedCost + 1e-8) return 0;
    stressedCost += walk.costDollars;
    return quantity;
  });
  const complete = shares.every((q, j) => Math.abs(q - filled[j]!) <= 1e-6);
  return {
    scenario: scenario.id, policy: policy.id, budgetUsd: scenario.budgetUsd,
    quoted: metrics(target, payouts(shares), (basket?.totalCostCents ?? 0) / 100, shares),
    stressed: metrics(target, payouts(filled), dollarsToCents(stressedCost) / 100, filled),
    executionDepth, completion: shares.some(q => q > 1e-6) ? (complete ? 'complete' : 'incomplete') : 'no-orders',
    legs: legs.map((leg, j) => ({ id: leg.id, side: leg.side, shares: shares[j], stressFilled: filled[j] })),
  };
}
