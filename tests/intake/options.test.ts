import { describe, expect, it } from 'vitest';
import { buildBasketOptions } from '../../packages/intake/src/options.js';
import type { QuoteDeps, QuoteRequest } from '../../packages/engine/src/quote.js';
import type { ClobBook, GammaEvent } from '../../packages/venue/src/index.js';

// The stops exist so three prices can be compared. That comparison is only
// honest if all three were taken at the same moment against the same book —
// which is the one thing worth a test here.

const mkt = (id: string, title: string) => ({
  id,
  question: `q ${id}`,
  groupItemTitle: title,
  description: 'Resolves off the Binance 1 minute candle close at 12:00 ET.',
  yesTokenId: `${id}_yes`,
  noTokenId: `${id}_no`,
  yesPrice: 0.2,
  tickSize: 0.01,
  feeRate: 0,
  endDate: '2026-12-31T17:00:00Z',
});

const EVENT: GammaEvent = {
  id: 'e1',
  slug: 'btc',
  title: 'BTC',
  negRisk: true,
  negRiskMarketId: '0x1',
  endDate: '2026-12-31T17:00:00Z',
  tags: ['bitcoin'],
  seriesTickers: ['bitcoin-neg-risk-weekly'],
  markets: [
    mkt('mA', '<60,000'),
    mkt('mB', '60,000-64,000'),
    mkt('mC', '64,000-68,000'),
    mkt('mD', '>68,000'),
  ],
};

const book = (assetId: string, priceMicros: number): ClobBook => ({
  market: 'x',
  assetId,
  timestamp: '1',
  hash: 'h',
  bids: [],
  asks: [{ priceMicros, size: 100_000 }],
});

describe('buildBasketOptions', () => {
  it('prices every stop from one book snapshot', async () => {
    // Each call returns a DIFFERENT book, so any stop that fetched its own
    // would price against a different market than its neighbours — exactly the
    // unfair comparison this guards.
    let fetches = 0;
    let saves = 0;

    const deps: QuoteDeps = {
      fetchEvent: async () => EVENT,
      fetchBooks: async (ids) => {
        fetches += 1;
        return ids.map((id) => book(id, 100_000 * fetches));
      },
      saveSnapshot: async () => {
        saves += 1;
        return `snap${saves}`;
      },
    };

    const request: QuoteRequest = {
      eventId: 'e1',
      shape: { templateId: 'threshold_digital', payoutUsd: 8_000, direction: 'below', k: 64_000 },
      budgetUsd: 400,
    };

    const options = await buildBasketOptions(request, deps);

    expect(options.length).toBeGreaterThan(1);
    expect(fetches).toBe(1);
    expect(saves).toBe(1);
    // Same snapshot on every record, so the three prices are the same moment.
    const ids = new Set(options.map((o) => o.record.resolved.snapshotId));
    expect(ids.size).toBe(1);
  });
});
