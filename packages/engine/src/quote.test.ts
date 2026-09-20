import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClobBook, GammaEvent } from '@polyhedge/venue';
import { quote, replay } from './quote.js';

const mkt = (id: string, title: string, fee: number | null = 0.07) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2,
  tickSize: 0.01, feeRate: fee, endDate: '2026-12-31T16:00:00Z',
});

const event: GammaEvent = {
  id: 'e1', slug: 'btc', title: 'BTC on Dec 31', negRisk: true,
  negRiskMarketId: '0x1', endDate: '2026-12-31T16:00:00Z', tags: ['bitcoin'],
  // deliberately NOT in ascending bracket order
  markets: [mkt('mC', '>70,000'), mkt('mA', '<68,000'), mkt('mB', '68,000-70,000')],
};

const book = (assetId: string, priceMicros: number): ClobBook => ({
  market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
  asks: [{ priceMicros, size: 100_000 }],
});

const prices: Record<string, number> = {
  mA_yes: 200_000, mA_no: 800_000,
  mB_yes: 500_000, mB_no: 500_000,
  mC_yes: 300_000, mC_no: 700_000,
};

const deps = (ev: GammaEvent = event) => ({
  fetchEvent: async () => ev,
  fetchBooks: async (ids: string[]) => ids.map((id) => book(id, prices[id] ?? 500_000)),
  saveSnapshot: async () => 'snap1',
});

describe('quote', () => {
  it('THE v1 BUG: maps markets to brackets by identity, not arrival order', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    // only the <68,000 bracket is owed; it is market mA, which arrived SECOND
    const bought = rec.basket.legs.filter((l) => l.shares > 0);
    expect(bought).toHaveLength(1);
    expect(bought[0]!.marketId).toBe('mA');
  });

  it('offers both YES and NO legs to the solver', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    expect(rec.resolved.legs.some((l) => l.side === 'NO')).toBe(true);
  });

  it('refuses to quote when any fee rate is unknown', async () => {
    const noFee = { ...event, markets: event.markets.map((m) => ({ ...m, feeRate: null })) };
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps(noFee),
    )).rejects.toThrow(/fee/i);
  });

  it('refuses a non-neg-risk event', async () => {
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps({ ...event, negRisk: false }),
    )).rejects.toThrow(/neg-risk/i);
  });

  it('refuses an event with an unparseable bracket title', async () => {
    const bad = { ...event, markets: [mkt('m1', 'Yes'), mkt('m2', 'No')] };
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps(bad),
    )).rejects.toThrow(/unparseable/i);
  });
});

describe('replay', () => {
  it('reproduces the basket exactly from the record and its books', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'range_protect', payoutUsd: 2500, low: 68000, high: 70000 } },
      deps(),
    );
    const books = Object.keys(prices).map((id) => book(id, prices[id]!));
    const again = await replay(rec, books);
    expect(again.legs).toEqual(rec.basket.legs);
    expect(again.totalCostCents).toBe(rec.basket.totalCostCents);
    expect(again.phase2Hash).toBe(rec.basket.phase2Hash);
  });

  it('a record survives JSON serialization intact', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'tail_only', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    const roundTripped = JSON.parse(JSON.stringify(rec)) as typeof rec;
    const books = Object.keys(prices).map((id) => book(id, prices[id]!));
    expect((await replay(roundTripped, books)).legs).toEqual(rec.basket.legs);
  });
});
