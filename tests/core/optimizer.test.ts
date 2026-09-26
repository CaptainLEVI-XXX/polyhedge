import { describe, expect, it } from 'vitest';
import { cents, priceMicros } from '../../packages/core/src/money.js';
import { buildLpModel, type LpInput } from '../../packages/core/src/lp/model.js';
import { LpNotOptimalError, solveLexicographic, solveLp } from '../../packages/core/src/lp/solve.js';
import { BasketValidationError, buildBasket } from '../../packages/core/src/quote.js';
import { buildStateSpace } from '../../packages/core/src/state-space.js';
import { levelsOf, type TargetShape } from '../../packages/core/src/shapes.js';
import { type Leg } from '../../packages/core/src/payoff-matrix.js';

const oneState = (size: number, price = 400_000): LpInput => ({
  target: [cents(10_000)],
  matrix: [[1]],
  books: [[{ priceMicros: priceMicros(price), size }]],
  feeRates: [0],
  mu: 0.001,
  budgetCents: null,
});

describe('solveLp', () => {
  it('buys exactly the shares needed', async () => {
    const sol = await solveLp(buildLpModel(oneState(500), { kind: 'cost', maxShortfallDollars: 0 }));
    expect(sol.primal['x_0_0']).toBeCloseTo(100, 6);
  });

  it('throws rather than returning a basket when the model is infeasible', async () => {
    // demand zero shortfall from a book that cannot supply it
    const model = buildLpModel(oneState(10), { kind: 'cost', maxShortfallDollars: 0 });
    await expect(solveLp(model)).rejects.toThrow(LpNotOptimalError);
  });
});

describe('solveLexicographic', () => {
  it('covers fully when liquidity allows, at minimum cost', async () => {
    const r = await solveLexicographic(oneState(500), null);
    expect(r.maxShortfallDollars).toBeCloseTo(0, 6);
    expect(r.solution.primal['x_0_0']).toBeCloseTo(100, 6);
  });

  it('reports the liquidity-limited shortfall instead of failing', async () => {
    const r = await solveLexicographic(oneState(30), null);
    expect(r.maxShortfallDollars).toBeCloseTo(70, 6);
    expect(r.solution.primal['x_0_0']).toBeCloseTo(30, 6);
  });

  it('THE v1 DEFECT: covers a state the market prices as near-impossible', async () => {
    // two states; state 1 is priced at 0.0005 — under probability weighting
    // its shortfall would be discounted away and left uncovered
    const input: LpInput = {
      target: [cents(100_000), cents(100_000)],
      matrix: [[1, 0], [0, 1]],
      books: [
        [{ priceMicros: priceMicros(500_000), size: 10_000 }],
        [{ priceMicros: priceMicros(500), size: 10_000 }],
      ],
      feeRates: [0, 0],
      mu: 0.001,
      budgetCents: null,
    };
    const r = await solveLexicographic(input, null);
    expect(r.solution.primal['x_1_0']).toBeCloseTo(1000, 6);
  });

  it('spreads shortfall rather than abandoning one state when the budget binds', async () => {
    const input: LpInput = {
      target: [cents(10_000), cents(10_000)],
      matrix: [[1, 0], [0, 1]],
      books: [
        [{ priceMicros: priceMicros(500_000), size: 10_000 }],
        [{ priceMicros: priceMicros(500_000), size: 10_000 }],
      ],
      feeRates: [0, 0],
      mu: 0.001,
      budgetCents: cents(5_000), // $50 buys 100 shares total, target needs 200
    };
    const r = await solveLexicographic(input, cents(5_000));
    expect(r.solution.primal['x_0_0']).toBeCloseTo(50, 4);
    expect(r.solution.primal['x_1_0']).toBeCloseTo(50, 4);
  });
});

const br = (lo: number | null, hi: number | null) =>
  ({ lo, hi, loInclusive: false, hiInclusive: hi !== null });
const items = [
  { key: 'mA', bracket: br(null, 68000) },
  { key: 'mB', bracket: br(68000, 70000) },
  { key: 'mC', bracket: br(70000, null) },
];
const yesLegs: Leg[] = items.map((it, i) => ({
  id: `y${i}`, marketId: it.key, label: `bracket ${it.key}`, tokenId: `tok_${it.key}`, side: 'YES', tradableKey: it.key,
}));
const deep = (p: number) => [{ priceMicros: priceMicros(p), size: 100_000 }];

const run = (shape: TargetShape, opts: Partial<Parameters<typeof buildBasket>[0]> = {}) =>
  buildBasket({
    shape,
    stateSpace: buildStateSpace(items, levelsOf(shape)),
    legs: yesLegs,
    books: [deep(200_000), deep(500_000), deep(300_000)],
    feeRates: [0, 0, 0],
    budgetCents: null,
    ruleFlags: [],
    correlationResidual: false,
    ...opts,
  });

describe('buildBasket', () => {
  it('covers a boundary-aligned digital exactly', async () => {
    const b = await run({ templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 });
    expect(b.residual.coverageRatio).toBeCloseTo(1, 9);
    expect(b.totalCostCents).toBe(20_000); // 1000 shares at $0.20
  });

  it('a strike inside a bracket exposes the extra payout required for full cover', async () => {
    // mB (68000-70000) splits at 69000; only the lower half is owed, but the
    // bracket cannot be split, so buying it over-covers and not buying it
    // under-covers. Either way the numbers must be honest.
    const b = await run({ templateId: 'threshold_digital', payoutUsd: 10_000, direction: 'below', k: 69000 });
    expect(b.target).toEqual([1_000_000, 1_000_000, 0, 0]);
    expect(b.achievable).toEqual([1_000_000, 1_000_000, 1_000_000, 0]);
    expect(b.residual.coverageRatio).toBeCloseTo(1, 9);
    expect(b.residual.crossStateOverhedgeCents).toBe(1_000_000);
  });

  it('reports a shortfall and names the state when the book is thin', async () => {
    const b = await run(
      { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
      { books: [[{ priceMicros: priceMicros(200_000), size: 100 }], deep(500_000), deep(300_000)] },
    );
    expect(b.residual.worstStateShortfallCents).toBe(90_000);
    expect(b.residual.worstStateLabel).toBe('<68000');
    expect(b.residual.coverageRatio).toBeLessThan(1);
  });

  it('makes leg costs sum exactly to the total', async () => {
    const b = await run(
      { templateId: 'range_protect', payoutUsd: 1000, low: 68000, high: 70000 },
      { feeRates: [0.07, 0.07, 0.07] },
    );
    expect(b.legs.reduce((a, l) => a + l.costCents, 0)).toBe(b.totalCostCents);
  });

  it('recomputes multi-level cost from fractional rounded quantities', async () => {
    const b = await run(
      { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
      {
        books: [[{ priceMicros: priceMicros(200_000), size: 0.25 },
                 { priceMicros: priceMicros(400_000), size: 1000 }], deep(500_000), deep(300_000)],
        forceSharesForTest: [1.23456789, 0, 0],
      },
    );
    expect(b.legs[0]!.shares).toBe(1.234568);
    // 0.25 * $0.20 + 0.984568 * $0.40 = $0.4438272, rounded once to 44 cents.
    expect(b.legs[0]!.costCents).toBe(44);
    expect(b.totalCostCents).toBe(44);
  });

  it('never exceeds a binding budget after rounding', async () => {
    const b = await run(
      { templateId: 'threshold_digital', payoutUsd: 100_000, direction: 'below', k: 68000 },
      { budgetCents: 5_000 as never },
    );
    expect(b.totalCostCents).toBeLessThanOrEqual(5_000);
  });

  it('throws rather than quoting when a leg would exceed available depth', async () => {
    await expect(buildBasket({
      shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
      stateSpace: buildStateSpace(items, [68000]),
      legs: yesLegs,
      books: [deep(200_000), deep(500_000), deep(300_000)],
      feeRates: [0, 0, 0],
      budgetCents: null,
      ruleFlags: [],
      correlationResidual: false,
      // force the validator to see an impossible fill
      forceSharesForTest: [1e9, 0, 0],
    } as never)).rejects.toThrow(BasketValidationError);
  });

  it('clamps coverage per state so over-hedging cannot mask a shortfall', async () => {
    const b = await run(
      { templateId: 'range_protect', payoutUsd: 1000, low: 68000, high: 70000 },
      { books: [deep(200_000), deep(500_000), [{ priceMicros: priceMicros(300_000), size: 0 }]] },
    );
    expect(b.residual.coverageRatio).toBeLessThan(1);
  });

  it('is identical across repeated runs', async () => {
    const shape: TargetShape = { templateId: 'linear_strip', payoutUsd: 5000, direction: 'below', k1: 68000, k2: 70000 };
    const a = await run(shape);
    const b = await run(shape);
    expect(b.legs).toEqual(a.legs);
    expect(b.totalCostCents).toBe(a.totalCostCents);
    expect(b.phase2Hash).toBe(a.phase2Hash);
  });
});
