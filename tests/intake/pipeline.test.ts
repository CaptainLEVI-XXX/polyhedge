import { describe, expect, it } from 'vitest';
import { createMockEngine, type Answer, type QuestionEngine } from '../../packages/questions/src/index.js';
import { parseLadder, type ClobBook, type GammaEvent, type Ladder } from '../../packages/venue/src/index.js';
import { intake, assembleExposure, type IntakeDeps } from '../../packages/intake/src/intake.js';
import { newSession, ask, addAssumption, applyAnswer, confirm } from '../../packages/intake/src/session.js';
import { parseDeadline } from '../../packages/intake/src/parse.js';
import { type IndexedEvent } from '../../packages/intake/src/retrieve.js';

const TODAY = new Date('2026-09-20T12:00:00Z');

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

const GAMMA_EVENT: GammaEvent = {
  id: 'e1',
  slug: 'bitcoin-price-on-december-31',
  title: 'BTC on Dec 31',
  negRisk: true,
  negRiskMarketId: '0x1',
  endDate: '2026-12-31T17:00:00Z',
  tags: ['bitcoin'],
  seriesTickers: ['bitcoin-neg-risk-weekly'],
  markets: [
    mkt('mA', '<60,000'),
    mkt('mB', '60,000-64,000'),
    mkt('mC', '64,000-68,000'),
    mkt('mD', '68,000-72,000'),
    mkt('mE', '>72,000'),
  ],
};

const PRICES: Record<string, number> = {
  mA_yes: 200_000,
  mA_no: 800_000,
  mB_yes: 200_000,
  mB_no: 800_000,
  mC_yes: 200_000,
  mC_no: 800_000,
  mD_yes: 200_000,
  mD_no: 800_000,
  mE_yes: 200_000,
  mE_no: 800_000,
};

const book = (assetId: string, priceMicros: number): ClobBook => ({
  market: 'x',
  assetId,
  timestamp: '1',
  hash: 'h',
  bids: [],
  asks: [{ priceMicros, size: 1_000_000 }],
});

const RESOLUTION_TEXT =
  'This market resolves Yes if the final Close price of the Binance 1 minute candle for BTC/USDT ' +
  'is less than 60,000.';

/** The same ladder the event fixture lists, so the in-code span check sees it. */
const BRACKET_LABELS = ['<60,000', '60,000-64,000', '64,000-68,000', '68,000-72,000', '>72,000'];

function requireLadder(labels: string[]): Ladder {
  const ladder = parseLadder(labels);
  if (ladder === null) throw new Error(`test fixture: [${labels.join(', ')}] must parse as a ladder`);
  return ladder;
}

const BRACKET_LADDER = requireLadder(BRACKET_LABELS);

function indexed(observationAt: string): IndexedEvent {
  return {
    eventId: 'e1',
    slug: 'bitcoin-price-on-december-31',
    seriesTicker: 'bitcoin-neg-risk-weekly',
    title: GAMMA_EVENT.title,
    ladder: BRACKET_LADDER,
    observationAt,
    observationSource: 'endDate',
    endDate: observationAt,
    negRisk: true,
    bracketCount: 5,
  };
}

/** A choice answer whose argmax is `key`, with the remainder parked elsewhere. */
function choice(key: string, confidence: number): Answer {
  const rest = key === 'unrelated' ? 'holding' : 'unrelated';
  return {
    kind: 'choice',
    choice: key,
    probabilities: { [key]: confidence, [rest]: 1 - confidence },
    confidence,
  };
}

function scored(level: number): Answer {
  return { kind: 'score', score: level, probabilities: { [String(level)]: 1 }, confidence: 1 };
}

/** The three fixed answers plus one round of fit answers for a single candidate. */
function commonAnswers(): Record<string, Answer> {
  return {
    lossDirection: choice('loses_below_level', 0.96),
    isHedge: { kind: 'boolean', probability: 0.97 },
    deadlineStated: { kind: 'boolean', probability: 0.95 },
    priceTemplate: choice('threshold_digital', 0.9),
    fit_0: scored(4),
    sourceMatch_0: { kind: 'boolean', probability: 0.95 },
    edgeCaseRisk_0: { kind: 'boolean', probability: 0.02 },
  };
}

interface Harness {
  deps: IntakeDeps;
  engineCalls: () => number;
  sessionIds: () => number;
}

function harness(answers: Record<string, Answer>, events: IndexedEvent[]): Harness {
  const inner = createMockEngine(answers, 'jev-1.13.0');
  let engineCalls = 0;
  let sessionIds = 0;
  let snapshots = 0;

  const engine: QuestionEngine = {
    async ask(state, questions) {
      engineCalls += 1;
      return inner.ask(state, questions);
    },
  };

  const deps: IntakeDeps = {
    engine,
    events,
    resolutionTextFor: () => RESOLUTION_TEXT,
    bracketLabelsFor: () => BRACKET_LABELS,
    today: TODAY,
    newSessionId: () => {
      sessionIds += 1;
      return `s${sessionIds}`;
    },
    fetchEvent: async () => GAMMA_EVENT,
    fetchBooks: async (ids: string[]) => ids.map((id) => book(id, PRICES[id] ?? 900_000)),
    saveSnapshot: async () => {
      snapshots += 1;
      return `snap${snapshots}`;
    },
  };

  return { deps, engineCalls: () => engineCalls, sessionIds: () => sessionIds };
}

describe('intake', () => {
  it('asks for missing levels before shape or fit calls and preserves a temperature clarification', async () => {
    const h = harness({ ...commonAnswers(), role_0: choice('loss', 0.95),
      role_1: choice('unrelated', 0.95), role_2: choice('threshold', 0.95) },
      [{ ...indexed('2026-12-31T17:00:00Z'), title: 'Highest temperature in Chicago on December 31?', seriesTicker: 'chicago-temperature',
        ladder: { ...BRACKET_LADDER, unit: '°F', span: { lo: 50, hi: 80 } } }]);
    const first = await intake('I run Chicago events and lose $8000 if it is cold on Dec 31.', h.deps);
    expect(first.kind).toBe('follow_up');
    expect(h.engineCalls()).toBe(1);
    if (first.kind !== 'follow_up') throw new Error('expected clarification');
    expect(first.session.pending?.field).toBe('threshold');
    // An explicit answer carries its unit into the deterministic assembly.
    const assembled = assembleExposure('below 60°F by Dec 31', {
      candidates: [], answers: commonAnswers(), modelVersion: 'test',
    }, parseDeadline('by Dec 31', TODAY), 'temperature', 1, undefined,
    [{ field: 'threshold', answer: '60°F' }, { field: 'lossUsd', answer: '8000' }]);
    expect(assembled.kind).toBe('exposure');
    if (assembled.kind === 'exposure') expect(assembled.exposure.levels).toEqual([{ value: 60, role: 'threshold', unit: '°F' }]);
  });
  it('clarifies conflicting loss amounts and uses the explicit numeric correction', async () => {
    const text = 'I hold BTC and could lose $5,000 or $15,000 below 60k by Dec 31. My budget is $300.';
    const h = harness({ ...commonAnswers(), role_0: choice('loss', 0.95),
      role_1: choice('loss', 0.95), role_2: choice('threshold', 0.95),
      role_3: choice('unrelated', 0.95), role_4: choice('budget', 0.95),
      role_5: choice('loss', 0.95) }, [indexed('2026-12-31T17:00:00Z')]);
    const first = await intake(text, h.deps);
    expect(first.kind).toBe('follow_up');
    if (first.kind !== 'follow_up') throw new Error('expected clarification');
    const second = await intake('8000', h.deps, first.session);
    expect(second.kind).toBe('quoted');
    if (second.kind !== 'quoted') throw new Error('expected quote');
    expect(second.record.request.shape).toMatchObject({ payoutUsd: 8000 });
    expect(second.record.request.budgetUsd).toBe(300);
  });

  it('declines path-triggered cover before asking for a date and respects negated touch language', () => {
    const extraction = { candidates: [], answers: { ...commonAnswers(),
      settlementBasis: choice('path', 0.99) }, modelVersion: 'test' };
    expect(assembleExposure('BTC must pay if it ever touches the barrier.', extraction,
      null, 'BTC', 0).kind).toBe('declined');
    const finalOnly = assembleExposure('A touch does not count; use only final BTC price by Dec 31.',
      { ...extraction, answers: { ...extraction.answers, settlementBasis: choice('final', 0.99) } },
      parseDeadline('by Dec 31', TODAY), 'BTC', 0);
    expect(finalOnly.kind).toBe('follow_up');
    if (finalOnly.kind !== 'follow_up') throw new Error('expected missing loss');
    expect(finalOnly.field).toBe('lossUsd');
  });

  it('batches interpretation into one call while retaining the separate market-fit check', async () => {
    const text = 'I hold BTC and lose $8,000 below 60k by Dec 31. My budget is $300.';
    const answers = { ...commonAnswers(), role_0: choice('loss', 0.95),
      role_1: choice('threshold', 0.95), role_2: choice('unrelated', 0.95), role_3: choice('budget', 0.95) };
    const baseline = harness(answers, [indexed('2026-12-31T17:00:00Z')]);
    const combined = harness(answers, [indexed('2026-12-31T17:00:00Z')]);
    combined.deps.combinedShape = true;
    const old = await intake(text, baseline.deps);
    const next = await intake(text, combined.deps);
    expect(old.kind).toBe('quoted');
    expect(next.kind).toBe('quoted');
    if (old.kind !== 'quoted' || next.kind !== 'quoted') throw new Error('expected quotes');
    expect(next.record.request).toEqual(old.record.request);
    expect(next.record.basket).toEqual(old.record.basket);
    expect(baseline.engineCalls()).toBe(3);
    expect(combined.engineCalls()).toBe(2);
  });

  it('falls back for uncertain or incompatible batched shapes and still asks for missing loss', async () => {
    const text = 'I hold BTC and lose $8,000 below 60k by Dec 31. My budget is $300.';
    const answers = { ...commonAnswers(), role_0: choice('loss', 0.95),
      role_1: choice('threshold', 0.95), role_2: choice('unrelated', 0.95), role_3: choice('budget', 0.95) };
    for (const shape of [choice('threshold_digital', 0.4), choice('range_protect', 0.99)]) {
      const run = harness(answers, [indexed('2026-12-31T17:00:00Z')]);
      run.deps.combinedShape = true;
      const ask = run.deps.engine.ask;
      run.deps.engine.ask = async (state, questions) => {
        const result = await ask(state, questions);
        return 'role_0' in questions ? { ...result, answers: { ...result.answers, priceTemplate: shape } } : result;
      };
      const result = await intake(text, run.deps);
      expect(result.kind).toBe('quoted');
      expect(run.engineCalls()).toBe(3);
    }
    const missing = harness({ ...answers, role_0: choice('unrelated', 0.95) }, [indexed('2026-12-31T17:00:00Z')]);
    missing.deps.combinedShape = true;
    const result = await intake(text, missing.deps);
    expect(result.kind).toBe('follow_up');
    expect(missing.engineCalls()).toBe(1);
  });
  it('routes fixed fields after calibration and caps missing-field follow-ups', async () => {
    const result = assembleExposure('BTC by Dec 31', {
      answers: commonAnswers(), candidates: [], modelVersion: 'jev-test',
    }, { value: '2026-12-31', raw: 'Dec 31', provenance: 'inferred' }, 'BTC', 0,
    { version: 'test', temperature: { choice: 1, score: 1, boolean: 100 } });
    expect(result.kind).toBe('declined');
    const { deps, engineCalls } = harness(commonAnswers(), []);
    const session = ask({ ...newSession('I need protection', 's'), followUpsAsked: 1 }, 'underlying', 'Which asset?');
    const capped = await intake('not sure', deps, session);
    expect(capped.kind).toBe('declined');
    expect(parseDeadline('by Dec 31. My deadline is by Jan 5 2027.', TODAY)?.value).toBe('2027-01-05');
    expect(engineCalls()).toBe(0);
  });

  it('quotes a complete exposure end to end, and says what it assumed', async () => {
    // Five numbers: 2, $8,000, 60k, 31, $300. The "2" is deliberately answered
    // weakly, so the run also covers a number that is not placed.
    const text = 'I hold 2 BTC and I lose $8,000 if it ends below 60k by Dec 31. I can spend $300 on cover.';
    const answers: Record<string, Answer> = {
      ...commonAnswers(),
      role_0: {
        kind: 'choice',
        choice: 'holding',
        probabilities: { holding: 0.3, loss: 0.25, unrelated: 0.25, budget: 0.2 },
        confidence: 0.3,
      },
      role_1: choice('loss', 0.95),
      role_2: choice('threshold', 0.93),
      role_3: choice('unrelated', 0.9),
      role_4: choice('budget', 0.9),
    };

    const { deps } = harness(answers, [indexed('2026-12-31T17:00:00Z')]);
    const result = await intake(text, deps);

    if (result.kind !== 'quoted') throw new Error(`expected a quote, got ${result.kind}`);

    expect(result.record.request.eventId).toBe('e1');
    expect(result.record.request.shape).toEqual({
      templateId: 'threshold_digital',
      payoutUsd: 8000,
      direction: 'below',
      k: 60000,
    });
    expect(result.record.request.budgetUsd).toBe(300);
    expect(result.record.basket.legs.length).toBeGreaterThan(0);

    // Provenance is the real thing on both fields, not `quote`'s 'unknown'
    // default and not a hardcoded version string.
    expect(result.record.meta.jevModelVersion).toBe('jev-1.13.0');
    expect(result.record.meta.calibrationMapVersion).toBe('unfitted');

    // The hedge ratio is always assumed, and always says so in the user's
    // own number.
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.assumptions.some((a) => a.includes('$8,000'))).toBe(true);
    // ...and the number it could not place is named rather than dropped.
    expect(result.assumptions.some((a) => a.includes('"2"'))).toBe(true);
    expect(result.assumptions.some((a) => a.includes('2026-12-31'))).toBe(true);
  });

  it('continues a session on the second call instead of starting over', async () => {
    // No loss amount anywhere in the first message, so `lossUsd` — the one
    // field that may never be defaulted — has to be asked for.
    const first = 'I hold 2 BTC and I lose money if it ends below 60k by Dec 31.';
    // The answer on its own names no asset, no level and no direction: if the
    // second call restarted from this text it could not reach a quote at all.
    const answer = '8000';

    const answers: Record<string, Answer> = {
      ...commonAnswers(),
      role_0: choice('unrelated', 0.9),
      role_1: choice('threshold', 0.93),
      role_2: choice('unrelated', 0.9),
      role_3: choice('loss', 0.95),
    };

    const { deps, sessionIds } = harness(answers, [indexed('2026-12-31T17:00:00Z')]);

    const asked = await intake(first, deps);
    if (asked.kind !== 'follow_up') throw new Error(`expected a follow-up, got ${asked.kind}`);
    expect(asked.session.pending?.field).toBe('lossUsd');
    expect(asked.question).toContain('lose');
    expect(asked.session.id).toBe('s1');
    expect(asked.session.followUpsAsked).toBe(0);
    // What was already read is carried, not re-asked.
    expect(asked.session.confirmed.direction).toBe('below');
    expect(asked.session.confirmed.levels).toEqual([{ value: 60000, role: 'threshold' }]);

    const originalAsk = deps.engine.ask;
    deps.engine.ask = async (state, questions) => {
      expect(String(state)).toContain('The amount I could lose: 8000');
      return originalAsk(state, questions);
    };
    const quoted = await intake(answer, deps, asked.session);
    if (quoted.kind !== 'quoted') throw new Error(`expected a quote, got ${quoted.kind}`);

    // Only one conversation was ever started.
    expect(sessionIds()).toBe(1);
    // And the level from the FIRST message is on the quote, which is only
    // possible if the second call continued rather than restarted.
    expect(quoted.record.request.shape).toEqual({
      templateId: 'threshold_digital',
      payoutUsd: 8000,
      direction: 'below',
      k: 60000,
    });
  });

  it('reports no market listed, with the furthest one there is, when the deadline runs past the board', async () => {
    const text = 'I hold 2 BTC and I lose $8,000 if it ends below 60k by Dec 31. I can spend $300 on cover.';
    const answers: Record<string, Answer> = {
      ...commonAnswers(),
      role_0: choice('unrelated', 0.9),
      role_1: choice('loss', 0.95),
      role_2: choice('threshold', 0.93),
      role_3: choice('unrelated', 0.9),
      role_4: choice('budget', 0.9),
    };

    // Everything listed observes in September; the user asked for December.
    const { deps } = harness(answers, [indexed('2026-09-26T16:00:00Z')]);
    const result = await intake(text, deps);

    if (result.kind !== 'no_market_listed') {
      throw new Error(`expected no_market_listed, got ${result.kind}`);
    }
    expect(result.furthestListed).toBe('2026-09-26T16:00:00Z');
    expect(result.perpAvailable).toBe(false);
  });

  it('asks rather than declines when nothing listed matches, and spends no model call', async () => {
    // The asset allow-list is gone; the offline check it was really providing is
    // not. Nothing indexed shares a word with this text, so there is nothing to
    // quote against — and that is knowable from already-indexed events, before
    // any model call.
    //
    // It asks instead of declining because the match is lexical: an empty result
    // means either the user named nothing or they named it differently from the
    // venue, and those are not distinguishable here.
    const { deps, engineCalls } = harness(commonAnswers(), [indexed('2026-12-31T17:00:00Z')]);

    const result = await intake(
      "I hold 200 SOL and I'm down $4,000 if it ends below 100 by Dec 31.",
      deps,
    );

    expect(result.kind).toBe('follow_up');
    expect(engineCalls()).toBe(0);
  });
});

describe('applyAnswer', () => {
  it('clears pending, increments followUpsAsked, and appends to answers with the right field name', () => {
    const s = ask(newSession('I hold 2 BTC', 'session-1'), 'deadline', 'When do you need this hedge by?');

    const next = applyAnswer(s, '2027');

    expect(next.pending).toBeUndefined();
    expect(next.followUpsAsked).toBe(1);
    expect(next.answers).toEqual([{ field: 'deadline', answer: '2027' }]);
  });

  it('throws rather than silently dropping the answer when there is no pending question', () => {
    const s = newSession('I hold 2 BTC', 'session-2');

    expect(() => applyAnswer(s, '2027')).toThrow();
  });
});

describe('confirm', () => {
  it('accumulates across calls and never mutates the input session', () => {
    const s0 = newSession('I hold 2 BTC', 'session-3');

    const s1 = confirm(s0, 'underlying', 'BTC');
    const s2 = confirm(s1, 'hedgeRatio', 0.5);

    expect(s2.confirmed).toEqual({ underlying: 'BTC', hedgeRatio: 0.5 });
    expect(s1.confirmed).toEqual({ underlying: 'BTC' });
    expect(s0.confirmed).toEqual({});
  });
});

describe('newSession jevModelVersion', () => {

  it('records the version supplied by the caller', () => {
    const s = newSession('I hold 2 BTC', 'session-6', 'jev-1.13.0');

    expect(s.jevModelVersion).toBe('jev-1.13.0');
  });
});

describe('round trip', () => {
  it('preserves originalText and prior assumptions through ask -> applyAnswer -> confirm', () => {
    const withAssumption = addAssumption(newSession('I hold 2 BTC', 'session-4'), 'assumed no existing hedge');
    const asked = ask(withAssumption, 'deadline', 'When do you need this hedge by?');
    const answered = applyAnswer(asked, '2027');
    const confirmed = confirm(answered, 'deadline', {
      value: '2027-12-31',
      provenance: 'stated',
      raw: '2027',
    });

    expect(confirmed.originalText).toBe('I hold 2 BTC');
    expect(confirmed.assumptions).toEqual(['assumed no existing hedge']);
  });
});
