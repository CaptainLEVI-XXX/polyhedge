import { describe, expect, it } from 'vitest';
import { parseBracketTitle, validateLadder, type Bracket } from '../../packages/venue/src/bracket-parser.js';
import { parseBook, parseEvent } from '../../packages/venue/src/schemas.js';

describe('parseBracketTitle', () => {
  it('parses a lower-unbounded bracket', () => {
    expect(parseBracketTitle('<68,000'))
      .toEqual({ lo: null, hi: 68000, literalOp: '<' });
  });

  it('records <= distinctly from < while normalizing to the same interval', () => {
    expect(parseBracketTitle('≤68,000')).toEqual({ lo: null, hi: 68000, literalOp: '<=' });
    expect(parseBracketTitle('<=68,000')).toEqual({ lo: null, hi: 68000, literalOp: '<=' });
    expect(parseBracketTitle('<68,000')!.literalOp).toBe('<');
  });

  it('parses an upper-unbounded bracket', () => {
    expect(parseBracketTitle('>86,000'))
      .toEqual({ lo: 86000, hi: null, literalOp: '>' });
  });

  it('records >= distinctly from >', () => {
    expect(parseBracketTitle('≥86,000')!.literalOp).toBe('>=');
    expect(parseBracketTitle('>=86,000')!.literalOp).toBe('>=');
  });

  it('parses a closed range as half-open [lo, hi)', () => {
    expect(parseBracketTitle('68,000-70,000'))
      .toEqual({ lo: 68000, hi: 70000, literalOp: 'range' });
  });

  it('tolerates whitespace, dollar signs and unicode dashes', () => {
    expect(parseBracketTitle(' $68,000 – $70,000 '))
      .toEqual({ lo: 68000, hi: 70000, literalOp: 'range' });
  });

  it('parses decimals', () => {
    expect(parseBracketTitle('0.45-0.50')).toEqual({ lo: 0.45, hi: 0.5, literalOp: 'range' });
  });

  it('returns null for text it does not understand', () => {
    expect(parseBracketTitle('Yes')).toBeNull();
    expect(parseBracketTitle('Around 70k')).toBeNull();
    expect(parseBracketTitle('')).toBeNull();
    expect(parseBracketTitle('   ')).toBeNull();
  });

  it('returns null for an inverted range rather than silently swapping', () => {
    expect(parseBracketTitle('70,000-68,000')).toBeNull();
  });

  it('returns null for a degenerate range', () => {
    expect(parseBracketTitle('68,000-68,000')).toBeNull();
  });
});

describe('validateLadder', () => {
  const b = (lo: number | null, hi: number | null): Bracket =>
    ({ lo, hi, literalOp: lo === null ? '<' : hi === null ? '>' : 'range' });

  it('accepts a contiguous exhaustive partition', () => {
    expect(validateLadder([b(null, 68000), b(68000, 70000), b(70000, null)]))
      .toEqual({ ok: true });
  });

  it('accepts brackets supplied out of order', () => {
    expect(validateLadder([b(70000, null), b(null, 68000), b(68000, 70000)]))
      .toEqual({ ok: true });
  });

  it('rejects a gap', () => {
    expect(validateLadder([b(null, 68000), b(69000, null)]))
      .toEqual({ ok: false, reason: 'gap between 68000 and 69000' });
  });

  it('rejects an overlap', () => {
    expect(validateLadder([b(null, 70000), b(68000, null)]))
      .toEqual({ ok: false, reason: 'overlap between 70000 and 68000' });
  });

  it('rejects a ladder not unbounded at both ends', () => {
    expect(validateLadder([b(68000, 70000)]))
      .toEqual({ ok: false, reason: 'ladder is not unbounded at both ends' });
  });

  it('rejects an empty ladder', () => {
    expect(validateLadder([])).toEqual({ ok: false, reason: 'ladder is empty' });
  });

  it('rejects a second unbounded bracket in the middle', () => {
    expect(validateLadder([b(null, 68000), b(null, 70000), b(70000, null)]).ok).toBe(false);
  });
});

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
  clobTokenIds: '["123","456"]',
  outcomePrices: '["0.0005","0.9995"]',
  outcomes: '["Yes","No"]',
  orderPriceMinTickSize: 0.001,
  endDate: '2026-12-31T16:00:00Z',
  ...extra,
});

const rawEvent = (markets: unknown[], extra: Record<string, unknown> = {}) => ({
  id: '1011359', slug: 'btc-dec-31', title: 'Bitcoin price on December 31?',
  negRisk: true, negRiskMarketID: '0x2cf05', endDate: '2026-12-31T16:00:00Z',
  tags: [{ label: 'Bitcoin', slug: 'bitcoin' }], markets,
  ...extra,
});

describe('parseEvent', () => {
  it('extracts both token ids, tick size and fee rate', () => {
    const ev = parseEvent(rawEvent([rawMarket({ feeSchedule: { rate: 0.07, takerOnly: true } })]));
    expect(ev.negRiskMarketId).toBe('0x2cf05');
    expect(ev.markets[0]!.yesTokenId).toBe('123');
    expect(ev.markets[0]!.noTokenId).toBe('456');
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
    expect(ev.markets[0]!.yesTokenId).toBe('123');
    expect(ev.markets[0]!.noTokenId).toBe('456');
  });

  it('throws rather than silently swapping when outcomes are ["No","Yes"]', () => {
    expect(() => parseEvent(rawEvent([rawMarket({ outcomes: '["No","Yes"]' })]))).toThrow(/outcomes/i);
  });

  it('extracts series tickers, distinct from tags', () => {
    const ev = parseEvent(rawEvent([rawMarket()], { series: [{ ticker: 'bitcoin-neg-risk-weekly' }] }));
    expect(ev.seriesTickers).toEqual(['bitcoin-neg-risk-weekly']);
  });

  it('reports no series as an empty list, never a guess', () => {
    expect(parseEvent(rawEvent([rawMarket()])).seriesTickers).toEqual([]);
  });
});
