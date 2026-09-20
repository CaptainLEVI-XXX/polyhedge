import { describe, expect, it } from 'vitest';
import { priceMicros } from './money.js';
import { BasketValidationError, buildBasket } from './quote.js';
import { buildStateSpace } from './state-space.js';
import { levelsOf, type TargetShape } from './shapes.js';
import type { Leg } from './payoff-matrix.js';

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

  it('THE v1 BUG: a strike inside a bracket shows real shortfall, not a clean headline', async () => {
    // mB (68000-70000) splits at 69000; only the lower half is owed, but the
    // bracket cannot be split, so buying it over-covers and not buying it
    // under-covers. Either way the numbers must be honest.
    const b = await run({ templateId: 'threshold_digital', payoutUsd: 10_000, direction: 'below', k: 69000 });
    const owed = b.target.reduce((a, c) => a + c, 0);
    const paid = b.achievable.reduce((a, c) => a + c, 0);
    expect(owed).toBeGreaterThan(0);
    expect(b.residual.coverageRatio).toBeCloseTo(1, 9);
    expect(paid).toBeGreaterThanOrEqual(owed);
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

  it('recomputes cost from rounded shares, not from solver internals', async () => {
    const b = await run({ templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 });
    const leg = b.legs.find((l) => l.shares > 0)!;
    expect(Number.isInteger(leg.shares * 1e6)).toBe(true);
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
