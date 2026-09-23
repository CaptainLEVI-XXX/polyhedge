import { describe, expect, it } from 'vitest';
import { buildBasketOptions, costProtectionCurve } from '../../packages/intake/src/options.js';
import { curvePoints } from '../../apps/web/lib/view-model.js';
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

describe('costProtectionCurve', () => {
  it('runs from no hedge to the most protection, each step buying strictly more for more', async () => {
    const prices: Record<string, number> = { mA_yes: 80_000, mB_yes: 150_000, mC_yes: 300_000, mD_yes: 500_000,
      mA_no: 930_000, mB_no: 860_000, mC_no: 710_000, mD_no: 510_000 };
    const deps: QuoteDeps = {
      fetchEvent: async () => EVENT,
      fetchBooks: async ids => ids.map(id => book(id, prices[id]!)),
      saveSnapshot: async () => 'snap',
    };
    const request: QuoteRequest = { eventId: 'e1', budgetUsd: 300, protectionGoal: { kind: 'minimize_net_loss' },
      shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 64_000 } };

    const records = await costProtectionCurve(request, deps);
    // A ladder's displayed prices are normalised: four brackets at 20% become 25% each.
    expect(Object.values(records[0]!.resolved.probabilities!)).toEqual([0.25, 0.25, 0.25, 0.25]);
    // Every point ignores the budget, so the whole trade-off is visible.
    expect(records.every(r => r.request.budgetUsd === undefined)).toBe(true);

    const points = curvePoints(records);
    expect(points[0]).toEqual({ costUsd: 0, worstLossUsd: 1000, trueCostUsd: 0 });
    expect(points.length).toBeGreaterThan(3);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.costUsd).toBeGreaterThan(points[i - 1]!.costUsd);
      expect(points[i]!.worstLossUsd).toBeLessThan(points[i - 1]!.worstLossUsd);
    }
    const { budgetUsd: _budget, ...uncapped } = request;
    const best = await quote(uncapped, deps);
    expect(points.at(-1)!.worstLossUsd).toBeCloseTo(best.basket.worstNetLossCents! / 100, 2);
  });
});

it('builds a stored curve from pinned books, fees and probabilities without fetching current metadata',async()=>{
  let calls=0;const books=EVENT.markets.flatMap(m=>[book(m.yesTokenId,200000),book(m.noTokenId,800000)]);
  const deps:QuoteDeps={fetchEvent:async()=>{calls++;return structuredClone(EVENT);},fetchBooks:async()=>books,saveSnapshot:async()=> 'pinned'};
  const record=await quote({eventId:EVENT.id,shape:{templateId:'threshold_digital',payoutUsd:100,direction:'below',k:60000},budgetUsd:20,protectionGoal:{kind:'minimize_net_loss'}},deps);
  const {pinnedCostProtectionCurve}=await import('../../packages/intake/src/options.js');
  const points=await pinnedCostProtectionCurve(record,books);
  expect(calls).toBe(1);
  expect(points.length).toBeGreaterThan(1);
  for(const point of points){expect(point.resolved).toEqual(record.resolved);expect(point.request.selectionPolicy).toBe('premium');}
  await expect(pinnedCostProtectionCurve(record,books.slice(1))).rejects.toThrow('Incomplete pinned books');
});
