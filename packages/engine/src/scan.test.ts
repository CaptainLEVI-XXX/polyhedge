import { describe, expect, it } from 'vitest';
import { scanEvent } from './scan.js';
import type { ClobBook, GammaEvent } from '@polyhedge/venue';

const market = (id: string, title: string, tok: string, feeRate: number | null = 0.07) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  yesTokenId: tok, noTokenId: `${tok}_no`, yesPrice: 0.1,
  tickSize: 0.01, feeRate, endDate: '2026-12-31T16:00:00Z',
});

const event: GammaEvent = {
  id: 'e1', slug: 'btc-dec-31', title: 'Bitcoin price on December 31?',
  negRisk: true, negRiskMarketId: '0xabc', endDate: '2026-12-31T16:00:00Z', tags: ['bitcoin'],
  markets: [market('m0', '<68,000', 't0'), market('m1', '68,000-70,000', 't1'), market('m2', '>70,000', 't2')],
};

const book = (levels: [number, number][]): ClobBook => ({
  market: 'x', assetId: 'y', timestamp: '1', hash: 'h', bids: [],
  asks: levels.map(([priceMicros, size]) => ({ priceMicros, size })),
});

describe('scanEvent', () => {
  it('measures payout as total purchasable shares, not premium', () => {
    const books = new Map<string, ClobBook>([
      ['t0', book([[100_000, 600], [120_000, 400]])],
      ['t1', book([[200_000, 5000]])],
      ['t2', book([[300_000, 5000]])],
    ]);
    const s = scanEvent(event, books);
    expect(s.brackets[0]!.maxPayoutUsd).toBe(1000);           // 600 + 400 shares
    expect(s.brackets[0]!.costToFillUsd).toBeCloseTo(108, 6); // 600*0.10 + 400*0.12
  });

  it('reports the minimum across brackets as the binding capacity', () => {
    const books = new Map<string, ClobBook>([
      ['t0', book([[100_000, 250]])],
      ['t1', book([[200_000, 5000]])],
      ['t2', book([[300_000, 9000]])],
    ]);
    expect(scanEvent(event, books).minPayoutUsd).toBe(250);
  });

  it('treats a missing book as zero capacity rather than throwing', () => {
    expect(scanEvent(event, new Map()).minPayoutUsd).toBe(0);
  });

  it('flags an event whose titles do not parse', () => {
    const bad = { ...event, markets: [market('m0', 'Yes', 't0'), market('m1', 'No', 't1')] };
    const s = scanEvent(bad, new Map());
    expect(s.parsed).toBe(false);
    expect(s.reason).toMatch(/unparseable/);
  });

  it('flags a ladder with a gap and names it', () => {
    const gapped = { ...event, markets: [market('m0', '<68,000', 't0'), market('m1', '>70,000', 't1')] };
    const s = scanEvent(gapped, new Map());
    expect(s.parsed).toBe(true);
    expect(s.validLadder).toBe(false);
    expect(s.reason).toMatch(/gap between 68000 and 70000/);
  });

  it('reports unknown fees so the gate does not count an unquotable event', () => {
    const noFee = { ...event, markets: event.markets.map((m) => ({ ...m, feeRate: null })) };
    expect(scanEvent(noFee, new Map()).feeKnown).toBe(false);
  });

  it('reports cost to fill as unknown when the fee rate is unknown', () => {
    const noFee = { ...event, markets: event.markets.map((m) => ({ ...m, feeRate: null })) };
    const books = new Map<string, ClobBook>([['t0', book([[100_000, 100]])]]);
    expect(scanEvent(noFee, books).brackets[0]!.costToFillUsd).toBeNull();
  });
});
