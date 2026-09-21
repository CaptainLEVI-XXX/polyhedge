import { describe, expect, it } from 'vitest';
import { type GammaEvent, type GammaMarket, type Ladder } from '../../packages/venue/src/index.js';
import { indexEvent, parseObservationAt, retrieve, type IndexedEvent } from '../../packages/intake/src/retrieve.js';

const NOON_ET_DESCRIPTION =
  'This market will resolve based on the final Close price of the Binance 1 minute candle ' +
  'for BTC/USDT 12:00 in the ET timezone (noon) on the resolution date.';

function market(extra: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'm1', question: 'Will BTC be less than $68,000?', groupItemTitle: '<68,000',
    description: NOON_ET_DESCRIPTION,
    slug: null, yesTokenId: 'tok_yes', noTokenId: 'tok_no', yesPrice: 0.5,
    tickSize: 0.001, feeRate: null, endDate: '2026-09-26T16:00:00Z',
    ...extra,
  };
}

// Three brackets that tile a numeric axis exactly once, so `parseLadder`
// accepts them and the `negRisk`/bracket-count/ladder conditions all pass by
// default; individual tests override `markets` to exercise one condition at
// a time.
function event(extra: Partial<GammaEvent> = {}): GammaEvent {
  return {
    id: '1', slug: 'bitcoin-price-on-september-26-2026', title: 'Bitcoin price on September 26?',
    negRisk: true, negRiskMarketId: '0xabc', endDate: '2026-09-26T16:00:00Z',
    tags: ['bitcoin', 'crypto'],
    seriesTickers: ['bitcoin-neg-risk-weekly'],
    markets: [
      market({ id: 'm1', groupItemTitle: '<60,000' }),
      market({ id: 'm2', groupItemTitle: '60,000-70,000' }),
      market({ id: 'm3', groupItemTitle: '>70,000' }),
    ],
    ...extra,
  };
}

const SIMPLE_LADDER: Ladder = {
  brackets: [
    { lo: null, hi: 60000, label: '<60,000' },
    { lo: 60000, hi: 70000, label: '60,000-70,000' },
    { lo: 70000, hi: null, label: '>70,000' },
  ],
  unit: '',
  span: { lo: 60000, hi: 70000 },
};

function indexed(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    eventId: '1', slug: 'bitcoin-price-on-september-26-2026', seriesTicker: 'bitcoin-neg-risk-weekly',
    title: 'Bitcoin price on September 26?',
    ladder: SIMPLE_LADDER,
    observationAt: '2026-09-26T16:00:00Z', observationSource: 'endDate',
    endDate: '2026-09-26T16:00:00Z',
    negRisk: true, bracketCount: 7,
    ...overrides,
  };
}

describe('parseObservationAt', () => {
  it('converts noon ET to 16:00Z for a September date (EDT) and 17:00Z for a December date (EST)', () => {
    expect(parseObservationAt(NOON_ET_DESCRIPTION, '2026-09-26T00:00:00Z')).toBe('2026-09-26T16:00:00Z');
    expect(parseObservationAt(NOON_ET_DESCRIPTION, '2026-12-24T00:00:00Z')).toBe('2026-12-24T17:00:00Z');
  });

  it('reads 12-hour notation as written rather than at face value', () => {
    const pm = 'Resolves to the Binance close at 4:00 PM ET on the resolution date.';
    expect(parseObservationAt(pm, '2026-09-26T00:00:00Z')).toBe('2026-09-26T20:00:00Z');

    const am = 'Resolves to the Binance close at 12:00 AM ET (midnight) on the resolution date.';
    expect(parseObservationAt(am, '2026-09-26T00:00:00Z')).toBe('2026-09-26T04:00:00Z');
  });

  it('returns null when the prose states two different times, rather than taking the first', () => {
    const ambiguous =
      'Prices are tracked from the 09:30 open. This market resolves to the close at 16:00 in the ET timezone.';
    expect(parseObservationAt(ambiguous, '2026-09-26T00:00:00Z')).toBeNull();
  });
});

describe('indexEvent', () => {
  // There is no allow-list any more: an event is indexable because its
  // bracket labels tile a numeric axis, not because its ticker is on a
  // list. What now excludes an event is labels that do not parse as a
  // `Ladder` at all — a candidate-name list, or a set of labels that fails
  // the contiguity check (here, two open tops).
  it('excludes an event whose bracket labels do not parse as a ladder', () => {
    const candidateList = event({
      title: 'Who will win the 2028 Democratic primary?',
      markets: [
        market({ id: 'm1', groupItemTitle: 'Kamala Harris' }),
        market({ id: 'm2', groupItemTitle: 'Gavin Newsom' }),
        market({ id: 'm3', groupItemTitle: 'Pete Buttigieg' }),
      ],
    });
    expect(indexEvent(candidateList)).toBeNull();

    const twoOpenTops = event({
      markets: [
        market({ id: 'm1', groupItemTitle: '<60,000' }),
        market({ id: 'm2', groupItemTitle: '>65,000' }),
        market({ id: 'm3', groupItemTitle: '>70,000' }),
      ],
    });
    expect(indexEvent(twoOpenTops)).toBeNull();
  });

  // The allow-list is gone, but the fallback to `endDate` is a NEW, INTENDED
  // behaviour (see retrieve.ts's header): most families outside crypto state
  // no time at all, and that no longer excludes them. What still excludes an
  // event is a bracket that STATES a time we cannot read with certainty —
  // guessing there would overrule the venue's own words with a guess.
  it('defaults to endDate when nothing states a time, but excludes when a stated time cannot be read', () => {
    const noTimeStated = event({
      markets: [
        market({ id: 'm1', groupItemTitle: '<60,000', description: 'Resolves per the closing price.' }),
        market({ id: 'm2', groupItemTitle: '60,000-70,000', description: 'Resolves per the closing price.' }),
        market({ id: 'm3', groupItemTitle: '>70,000', description: 'Resolves per the closing price.' }),
      ],
    });
    const noTimeIndexed = indexEvent(noTimeStated);
    expect(noTimeIndexed?.observationAt).toBe(noTimeStated.endDate);
    expect(noTimeIndexed?.observationSource).toBe('endDate');

    const unreadableTime = event({
      markets: [
        market({ id: 'm1', groupItemTitle: '<60,000', description: 'Resolves at 25:99 in the ET timezone.' }),
        market({ id: 'm2', groupItemTitle: '60,000-70,000', description: 'Resolves at 25:99 in the ET timezone.' }),
        market({ id: 'm3', groupItemTitle: '>70,000', description: 'Resolves at 25:99 in the ET timezone.' }),
      ],
    });
    expect(indexEvent(unreadableTime)).toBeNull();
  });

  it('excludes an event whose brackets name different observation instants, but tolerates one unreadable bracket', () => {
    const disagreeing = event({
      markets: [
        market({ id: 'm1', groupItemTitle: '<60,000' }),
        market({ id: 'm2', groupItemTitle: '60,000-70,000', description: 'Resolves to the Binance close at 16:00 in the ET timezone.' }),
        market({ id: 'm3', groupItemTitle: '>70,000' }),
      ],
    });
    expect(indexEvent(disagreeing)).toBeNull();

    const oneUnreadable = event({
      markets: [
        market({ id: 'm1', groupItemTitle: '<60,000' }),
        market({ id: 'm2', groupItemTitle: '60,000-70,000' }),
        market({ id: 'm3', groupItemTitle: '>70,000', description: 'See the event rules.' }),
      ],
    });
    expect(indexEvent(oneUnreadable)?.observationAt).toBe('2026-09-26T16:00:00Z');
  });
});

describe('retrieve', () => {
  it('returns no_market_listed with furthestListed when the deadline is beyond every listed event', () => {
    const events = [
      indexed({ eventId: '1', observationAt: '2026-09-21T16:00:00Z' }),
      indexed({ eventId: '2', observationAt: '2026-09-26T16:00:00Z' }),
    ];
    const result = retrieve(events, '2026-12-31');
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
    const result = retrieve(events, '2026-09-23');
    expect(result.kind).toBe('candidates');
    if (result.kind === 'candidates') {
      expect(result.events.map((e) => e.eventId)).toEqual(['future']);
    }
  });

  it('returns an event observing on a later date than the deadline WITH observationNote, not dropped', () => {
    const events = [indexed({ eventId: 'later', observationAt: '2026-09-26T16:00:00Z' })];
    const result = retrieve(events, '2026-09-23');
    expect(result.kind).toBe('candidates');
    if (result.kind === 'candidates') {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.eventId).toBe('later');
      expect(result.events[0]?.observationNote).toBeDefined();
      expect(result.events[0]?.observationNote).toContain('2026-09-26');
    }
  });
});
