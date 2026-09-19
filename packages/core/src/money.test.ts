import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, cents, dollarsToCents, priceMicros, roundHalfEven } from './money.js';

describe('roundHalfEven', () => {
  it('sends ties to the nearest even integer', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(-1.5)).toBe(-2);
  });
  it('rounds non-ties normally', () => {
    expect(roundHalfEven(1.4)).toBe(1);
    expect(roundHalfEven(1.6)).toBe(2);
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
});

describe('priceMicros', () => {
  it('rejects out-of-range values', () => {
    expect(() => priceMicros(-1)).toThrow(/range/);
    expect(() => priceMicros(1_000_001)).toThrow(/range/);
  });
  it('accepts a sub-cent tick', () => expect(priceMicros(500)).toBe(500));
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
