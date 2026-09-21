import { describe, expect, it } from 'vitest';
import { buildBasketOptions } from '../../packages/intake/src/options.js';
import type { QuoteDeps, QuoteRequest } from '../../packages/engine/src/quote.js';
import { quote } from '../../packages/engine/src/quote.js';
import { quoteSession } from '../../packages/engine/src/quote-session.js';
import { buildAlternatives } from '../../packages/intake/src/alternatives.js';
import type { ClobBook, GammaEvent } from '../../packages/venue/src/index.js';

// The stops exist so three prices can be compared. That comparison is only
// honest if all three were taken at the same moment against the same book —
// which is the one thing worth a test here.

const mkt = (id: string, title: string) => ({
  id,
  question: `q ${id}`,
  groupItemTitle: title,
  description: 'Resolves off the Binance 1 minute candle close at 12:00 ET.',
  slug: null, yesTokenId: `${id}_yes`,
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

    const session = quoteSession(deps);
    const primary = await quote(request, session);
    const alternatives = await buildAlternatives(primary, session);
    const options = await buildBasketOptions(request, session);

    expect(options.length).toBeGreaterThan(1);
    expect(fetches).toBe(1);
    expect(saves).toBe(1);
    // Same snapshot on every record, so the three prices are the same moment.
    const ids = new Set([primary, ...alternatives.map(a => a.record), ...options.map(o => o.record)]
      .map(r => r.resolved.snapshotId));
    expect(ids.size).toBe(1);
    // A separate operation must refresh, even for identical token ids.
    await quote(request, quoteSession(deps));
    expect(fetches).toBe(2);
    expect(saves).toBe(2);
  });

  it('builds the lower-premium choice against the same target and preserves risk flags', async () => {
    const session = quoteSession({ fetchEvent: async () => EVENT,
      fetchBooks: async (ids: string[]) => ids.map(id => book(id,
        id === 'mA_yes' ? 200_000 : id.endsWith('_yes') ? 400_000 : 900_000)),
      saveSnapshot: async () => 'one-snapshot' });
    const request: QuoteRequest = { eventId: 'e1', budgetUsd: 30,
      shape: { templateId: 'threshold_digital', payoutUsd: 100, direction: 'below', k: 60_000 },
      protectionGoal: { kind: 'minimize_net_loss' } };
    const flags = { ruleFlags: ['observation time differs'] };
    const primary = await quote(request, session, flags);
    const options = await buildBasketOptions(request, session, flags, primary);
    const smaller = options.find(o => o.name === 'Lower premium')!;
    expect(smaller.record.basket.totalCostCents).toBe(1000);
    expect(smaller.record.basket.worstNetLossCents).toBe(6000);
    for (const option of options) {
      expect(option.record.request.shape).toEqual(request.shape);
      expect(option.record.meta.ruleFlags).toEqual(flags.ruleFlags);
      expect(option.record.resolved.snapshotId).toBe(primary.resolved.snapshotId);
    }
  });
});
