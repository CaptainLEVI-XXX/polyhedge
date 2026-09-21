import { describe, expect, it } from 'vitest';
import { valueBasket, valuePosition } from '../../apps/web/lib/positions.js';
import type { ClobBook } from '../../packages/venue/src/index.js';

// The valuation group. A number here is one a user decides on, and the easy
// mistakes all err the same way: too optimistic.

const book = (bids: [number, number][]): ClobBook => ({
  market: 'm',
  assetId: 't',
  timestamp: '2026-09-21T00:00:00Z',
  hash: 'h',
  asks: [],
  bids: bids.map(([priceMicros, size]) => ({ priceMicros, size })),
});

describe('valuing a held position', () => {
  it('values against bids, not asks, because selling hits bids', () => {
    const v = valuePosition('t', 100, book([[500_000, 100]]));
    expect(v.valuableUsd).toBeCloseTo(50, 6);
    expect(v.unsellableShares).toBe(0);
  });

  it('walks down the depth instead of marking everything at top of book', () => {
    // 40 at 50c then 60 at 10c is $26, not $50. Marking the whole position at
    // the best bid is the error that makes a basket look sellable when it is not.
    const v = valuePosition('t', 100, book([[500_000, 40], [100_000, 60]]));
    expect(v.valuableUsd).toBeCloseTo(40 * 0.5 + 60 * 0.1, 6);
  });

  it('reports what the book cannot absorb rather than pricing it anyway', () => {
    const v = valuePosition('t', 1_000, book([[500_000, 40]]));
    expect(v.valuableUsd).toBeCloseTo(20, 6);
    expect(v.unsellableShares).toBe(960);
  });

  it('reports a resolved market as resolved, never as worthless', () => {
    // A resolved winner pays a dollar a share once redeemed. Calling that zero
    // because no book remains would be a different claim, and a false one.
    const v = valuePosition('t', 100, undefined, 'resolved');
    expect(v.status).toBe('resolved');
    expect(v.valuableUsd).toBe(0);
    expect(v.unsellableShares).toBe(100);
  });

  it('flags a basket as partly unvaluable when any leg has no bid', () => {
    const books = new Map([['a', { ...book([[500_000, 100]]), assetId: 'a' }]]);
    const basket = valueBasket([{ tokenId: 'a', shares: 100 }, { tokenId: 'b', shares: 50 }], books);
    expect(basket.partlyUnvaluable).toBe(true);
    expect(basket.valuableUsd).toBeCloseTo(50, 6);
  });
});
