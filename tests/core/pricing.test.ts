import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, cents, dollarsToCents, priceMicros, roundHalfEven } from '../../packages/core/src/money.js';
import { unitCostDollars, walkBook } from '../../packages/core/src/book.js';

describe('roundHalfEven', () => {
  it('sends ties to the nearest even integer', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(-1.5)).toBe(-2);
  });
});

describe('cents', () => {
  it('rejects non-integers', () => expect(() => cents(1.5)).toThrow(/integer/));
});

describe('dollarsToCents', () => {
  it('uses half-even at the sub-cent boundary', () => {
    expect(dollarsToCents(12.345)).toBe(1234);
    expect(dollarsToCents(12.355)).toBe(1236);
  });
  it('keeps sub-cent fee amounts from vanishing before they are summed', () => {
    // one share of fee is fractions of a cent; 100000 of them are not
    expect(dollarsToCents(0.0000168 * 100_000)).toBe(168);
  });
  it('rounds a true half-cent tie to even despite float representation error', () => {
    // 5.015 dollars is exactly 501.5 cents; 501 is odd, so banker's gives 502
    expect(dollarsToCents(5.015)).toBe(502);
    // 35.855 dollars is exactly 3585.5 cents; 3585 is odd, so banker's gives 3586
    expect(dollarsToCents(35.855)).toBe(3586);
  });

  it('is unaffected at large magnitudes', () => {
    expect(dollarsToCents(1_000_000.005)).toBe(100_000_000);
    expect(dollarsToCents(1_000_000.015)).toBe(100_000_002);
  });
});

describe('priceMicros', () => {
  it('rejects out-of-range values', () => {
    expect(() => priceMicros(-1)).toThrow(/range/);
    expect(() => priceMicros(1_000_001)).toThrow(/range/);
  });
});

describe('allocate', () => {
  it('gives the remainder to the largest fractional parts', () => {
    expect(allocate(cents(100), [1, 1, 1])).toEqual([34, 33, 33]);
  });
  it('handles all-zero weights without dividing by zero', () => {
    expect(allocate(cents(100), [0, 0])).toEqual([100, 0]);
  });
  it('always sums to the total', () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 1, maxLength: 20 }),
      (total, weights) => {
        const parts = allocate(cents(total), weights);
        return parts.reduce((a, b) => a + b, 0) === total && parts.length === weights.length;
      },
    ));
  });
});

const levels = [
  { priceMicros: priceMicros(400_000), size: 100 },
  { priceMicros: priceMicros(450_000), size: 200 },
  { priceMicros: priceMicros(500_000), size: 50 },
];

describe('unitCostDollars', () => {
  it('adds the taker fee on top of the price', () => {
    expect(unitCostDollars(priceMicros(400_000), 0.07)).toBeCloseTo(0.4168, 12);
  });
  it('charges no fee at the extremes', () => {
    expect(unitCostDollars(priceMicros(0), 0.07)).toBe(0);
    expect(unitCostDollars(priceMicros(1_000_000), 0.07)).toBeCloseTo(1, 12);
  });
  it('drags hardest on cheap hedges as a share of premium', () => {
    expect(unitCostDollars(priceMicros(100_000), 0.07) / 0.1 - 1).toBeCloseTo(0.063, 6);
    expect(unitCostDollars(priceMicros(900_000), 0.07) / 0.9 - 1).toBeCloseTo(0.007, 6);
  });
  it('is zero-fee when the rate is zero', () => {
    expect(unitCostDollars(priceMicros(400_000), 0)).toBeCloseTo(0.4, 12);
  });
});

describe('walkBook', () => {
  it('fills from the best level when it is deep enough', () => {
    const r = walkBook(levels, 50, 0);
    expect(r.filled).toBe(50);
    expect(r.costDollars).toBeCloseTo(20, 12);
    expect(r.avgPriceMicros).toBeCloseTo(400_000, 6);
  });
  it('walks deeper levels and averages up', () => {
    const r = walkBook(levels, 300, 0);
    expect(r.filled).toBe(300);
    expect(r.costDollars).toBeCloseTo(130, 12);
    expect(r.avgPriceMicros).toBeCloseTo(433_333.333, 2);
  });
  it('reports a partial fill when the book is too thin', () => {
    const r = walkBook(levels, 1000, 0);
    expect(r.filled).toBe(350);
    expect(r.costDollars).toBeCloseTo(155, 12);
  });
  it('keeps sub-cent fee precision through the sum', () => {
    const r = walkBook([{ priceMicros: priceMicros(10_000), size: 100_000 }], 100_000, 0.07);
    expect(r.costDollars).toBeCloseTo(1069.3, 9);
  });
  it('returns zero for a zero-share walk', () => {
    const r = walkBook(levels, 0, 0.07);
    expect(r.costDollars).toBe(0);
    expect(r.filled).toBe(0);
    expect(r.avgPriceMicros).toBe(0);
  });
  it('returns zero for an empty book', () => {
    const r = walkBook([], 100, 0.07);
    expect(r.filled).toBe(0);
    expect(r.costDollars).toBe(0);
  });
});
