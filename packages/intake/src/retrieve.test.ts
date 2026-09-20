import { describe, expect, it } from 'vitest';
import type { GammaEvent, GammaMarket } from '@polyhedge/venue';
import { indexEvent, parseObservationAt, retrieve, SUPPORTED_SERIES, type IndexedEvent } from './retrieve.js';

const NOON_ET_DESCRIPTION =
  'This market will resolve based on the final Close price of the Binance 1 minute candle ' +
  'for BTC/USDT 12:00 in the ET timezone (noon) on the resolution date.';

function market(extra: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'm1', question: 'Will BTC be less than $68,000?', groupItemTitle: '<68,000',
    description: NOON_ET_DESCRIPTION,
    yesTokenId: 'tok_yes', noTokenId: 'tok_no', yesPrice: 0.5,
    tickSize: 0.001, feeRate: null, endDate: '2026-09-26T16:00:00Z',
    ...extra,
  };
}

function event(extra: Partial<GammaEvent> = {}): GammaEvent {
  return {
    id: '1', slug: 'bitcoin-price-on-september-26-2026', title: 'Bitcoin price on September 26?',
    negRisk: true, negRiskMarketId: '0xabc', endDate: '2026-09-26T16:00:00Z',
    tags: ['bitcoin', 'crypto'],
    seriesTickers: [SUPPORTED_SERIES.BTC],
    markets: [market()],
    ...extra,
  };
}

function indexed(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    eventId: '1', slug: 'bitcoin-price-on-september-26-2026', seriesTicker: SUPPORTED_SERIES.BTC,
    underlying: 'BTC', observationAt: '2026-09-26T16:00:00Z', endDate: '2026-09-26T16:00:00Z',
    negRisk: true, bracketCount: 7,
    ...overrides,
  };
}

describe('parseObservationAt', () => {
  it('converts noon ET to 16:00Z for a September date (EDT) and 17:00Z for a December date (EST)', () => {
    expect(parseObservationAt(NOON_ET_DESCRIPTION, '2026-09-26T00:00:00Z')).toBe('2026-09-26T16:00:00Z');
    expect(parseObservationAt(NOON_ET_DESCRIPTION, '2026-12-24T00:00:00Z')).toBe('2026-12-24T17:00:00Z');
  });
});

describe('indexEvent', () => {
  it('excludes an event whose series is not a supported bracket series, even with a matching-looking title', () => {
    const upDown = event({
      title: 'Bitcoin Up or Down - September 26, 4PM ET',
      seriesTickers: ['btc-updown-4h'],
    });
    expect(indexEvent(upDown, 'BTC')).toBeNull();

    const hitPrice = event({
      title: 'Bitcoin price on September 26?',
      seriesTickers: ['bitcoin-hit-price-weekly'],
    });
    expect(indexEvent(hitPrice, 'BTC')).toBeNull();
  });

  it('excludes an event whose description states no readable time, rather than defaulting', () => {
    const noTime = event({ markets: [market({ description: 'Resolves per the closing price.' })] });
    expect(indexEvent(noTime, 'BTC')).toBeNull();
  });
});

describe('retrieve', () => {
  it('returns no_market_listed with furthestListed when the deadline is beyond every listed event', () => {
    const events = [
      indexed({ eventId: '1', observationAt: '2026-09-21T16:00:00Z' }),
      indexed({ eventId: '2', observationAt: '2026-09-26T16:00:00Z' }),
    ];
    const result = retrieve(events, 'BTC', '2026-12-31');
    expect(result.kind).toBe('no_market_listed');
    if (result.kind === 'no_market_listed') {
      expect(result.furthestListed).toBe('2026-09-26T16:00:00Z');
      expect(result.reason).toContain('2026-09-26T16:00:00Z');
    }
  });

  it('excludes an event observing before the deadline', () => {
    const events = [
      indexed({ eventId: 'past', observationAt: '2026-09-20T16:00:00Z' }),
      indexed({ eventId: 'future', observationAt: '2026-09-26T16:00:00Z' }),
    ];
    const result = retrieve(events, 'BTC', '2026-09-23');
    expect(result.kind).toBe('candidates');
    if (result.kind === 'candidates') {
      expect(result.events.map((e) => e.eventId)).toEqual(['future']);
    }
  });

  it('returns an event observing on a later date than the deadline WITH observationNote, not dropped', () => {
    const events = [indexed({ eventId: 'later', observationAt: '2026-09-26T16:00:00Z' })];
    const result = retrieve(events, 'BTC', '2026-09-23');
    expect(result.kind).toBe('candidates');
    if (result.kind === 'candidates') {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.eventId).toBe('later');
      expect(result.events[0]?.observationNote).toBeDefined();
      expect(result.events[0]?.observationNote).toContain('2026-09-26');
    }
  });
});
