import { describe, expect, it } from 'vitest';
import { priceMicros } from './money.js';
import { unitCostDollars, walkBook } from './book.js';

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
