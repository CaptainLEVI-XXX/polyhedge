import { describe, expect, it } from 'vitest';
import { cents, priceMicros } from '../money.js';
import { buildLpModel, type LpInput } from './model.js';
import { LpNotOptimalError, solveLexicographic, solveLp } from './solve.js';

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

  it('returns identical primals on repeated runs', async () => {
    const a = await solveLexicographic(oneState(500), null);
    const b = await solveLexicographic(oneState(500), null);
    expect(b.solution.primal).toEqual(a.solution.primal);
    expect(b.phase2Hash).toBe(a.phase2Hash);
  });
});
