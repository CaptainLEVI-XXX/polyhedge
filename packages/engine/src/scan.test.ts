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
  it('measures cheap depth separately from raw ask size', () => {
    const books = new Map<string, ClobBook>([
      ['t0', book([[1_000, 28_381], [990_000, 125_008]])],
      ['t1', book([[200_000, 5000]])],
      ['t2', book([[300_000, 5000]])],
    ]);
    const s = scanEvent(event, books, 500);
    expect(s.brackets[0]!.rawAskSizeUsd).toBe(153_389);
    expect(s.brackets[0]!.payoutAtOrBelowCapUsd).toBe(28_381);
  });

  it('costs a target payout by walking the real book with fees', () => {
    const books = new Map<string, ClobBook>([
      ['t0', book([[100_000, 600], [120_000, 400]])],
      ['t1', book([[200_000, 5000]])],
      ['t2', book([[300_000, 5000]])],
    ]);
    // 500 shares all from the 0.10 level: 500 * (0.10 + 0.07*0.10*0.90)
    expect(scanEvent(event, books, 500).brackets[0]!.costToBuyTargetUsd).toBeCloseTo(53.15, 6);
    // 1000 shares spans both levels: 600*0.1063 + 400*0.127392
    expect(scanEvent(event, books, 1000).brackets[0]!.costToBuyTargetUsd).toBeCloseTo(114.7368, 6);
  });

  it('returns null cost and counts the bracket short when depth runs out', () => {
    const books = new Map<string, ClobBook>([['t0', book([[100_000, 600]])]]);
    const s = scanEvent(event, books, 1000);
    expect(s.brackets[0]!.costToBuyTargetUsd).toBeNull();
    expect(s.bracketsShortOfTarget).toBe(3); // t1 and t2 have no book at all
  });

  it('reports the minimum cheap depth as the binding capacity', () => {
    const books = new Map<string, ClobBook>([
      ['t0', book([[100_000, 250]])],
      ['t1', book([[200_000, 5000]])],
      ['t2', book([[300_000, 9000]])],
    ]);
    expect(scanEvent(event, books, 100).minPayoutAtOrBelowCapUsd).toBe(250);
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

  it('reports cost to buy target as unknown when the fee rate is unknown', () => {
    const noFee = { ...event, markets: event.markets.map((m) => ({ ...m, feeRate: null })) };
    const books = new Map<string, ClobBook>([['t0', book([[100_000, 100]])]]);
    expect(scanEvent(noFee, books, 50).brackets[0]!.costToBuyTargetUsd).toBeNull();
  });
});
