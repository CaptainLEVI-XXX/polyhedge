import { describe, expect, it } from 'vitest';
import { parseBook, parseEvent } from './schemas.js';

const rawBook = (asks: { price: string; size: string }[]) =>
  ({ market: '0xabc', asset_id: '123', timestamp: '1', hash: 'h', bids: [], asks });

describe('parseBook', () => {
  it('converts prices to integer micros', () => {
    expect(parseBook(rawBook([{ price: '0.45', size: '2105.85' }])).asks[0])
      .toEqual({ priceMicros: 450_000, size: 2105.85 });
  });
  it('preserves a sub-cent tick', () => {
    expect(parseBook(rawBook([{ price: '0.0005', size: '10' }])).asks[0]!.priceMicros).toBe(500);
  });
  it('sorts asks ascending so a walk starts at the best price', () => {
    const b = parseBook(rawBook([{ price: '0.50', size: '1' }, { price: '0.45', size: '1' }]));
    expect(b.asks.map((a) => a.priceMicros)).toEqual([450_000, 500_000]);
  });
  it('rejects a malformed response loudly', () => {
    expect(() => parseBook({ nope: true })).toThrow();
  });
});

const rawMarket = (extra: Record<string, unknown> = {}) => ({
  id: '4498121',
  question: 'Will BTC be less than $68,000?',
  groupItemTitle: '<68,000',
  description: 'Resolves per the Binance 1 minute candle close.',
  clobTokenIds: '["tok_yes","tok_no"]',
  outcomePrices: '["0.0005","0.9995"]',
  outcomes: '["Yes","No"]',
  orderPriceMinTickSize: 0.001,
  endDate: '2026-12-31T16:00:00Z',
  ...extra,
});

const rawEvent = (markets: unknown[]) => ({
  id: '1011359', slug: 'btc-dec-31', title: 'Bitcoin price on December 31?',
  negRisk: true, negRiskMarketID: '0x2cf05', endDate: '2026-12-31T16:00:00Z',
  tags: [{ label: 'Bitcoin', slug: 'bitcoin' }], markets,
});

describe('parseEvent', () => {
  it('extracts both token ids, tick size and fee rate', () => {
    const ev = parseEvent(rawEvent([rawMarket({ feeSchedule: { rate: 0.07, takerOnly: true } })]));
    expect(ev.negRiskMarketId).toBe('0x2cf05');
    expect(ev.markets[0]!.yesTokenId).toBe('tok_yes');
    expect(ev.markets[0]!.noTokenId).toBe('tok_no');
    expect(ev.markets[0]!.tickSize).toBe(0.001);
    expect(ev.markets[0]!.feeRate).toBe(0.07);
  });

  it('reports an absent fee schedule as unknown, never as zero', () => {
    expect(parseEvent(rawEvent([rawMarket()])).markets[0]!.feeRate).toBeNull();
  });

  it('carries negRisk so the caller can check the event family', () => {
    expect(parseEvent(rawEvent([rawMarket()])).negRisk).toBe(true);
  });

  it('parses a normal ["Yes","No"] market', () => {
    const ev = parseEvent(rawEvent([rawMarket({ outcomes: '["Yes","No"]' })]));
    expect(ev.markets[0]!.yesTokenId).toBe('tok_yes');
    expect(ev.markets[0]!.noTokenId).toBe('tok_no');
  });

  it('throws rather than silently swapping when outcomes are ["No","Yes"]', () => {
    expect(() => parseEvent(rawEvent([rawMarket({ outcomes: '["No","Yes"]' })]))).toThrow(/outcomes/i);
  });
});
