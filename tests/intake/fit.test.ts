import { describe, expect, it } from 'vitest';
import { createMockEngine, type Answer, type Question, type QuestionEngine } from '../../packages/questions/src/index.js';
import { parseLadder, type Ladder } from '../../packages/venue/src/index.js';
import { assessFit, type FitCandidate } from '../../packages/intake/src/fit.js';
import { type IndexedEvent } from '../../packages/intake/src/retrieve.js';
import { type TypedExposure } from '../../packages/intake/src/types.js';

// Deliberately free of date vocabulary: the exposure text and the venue
// prose are both quoted verbatim into the payload, so a fixture that named
// a month would be testing the fixture rather than the builder.
const EXPOSURE: TypedExposure = {
  rawText: 'I hold 2 BTC and I lose money if it ends below 60k.',
  underlying: 'BTC',
  lossUsd: { value: 8000, provenance: 'stated', raw: '$8k' },
  hedgeRatio: 1,
  direction: 'below',
  levels: [{ value: 60000, role: 'threshold' }],
  deadline: { value: '2026-09-26', provenance: 'stated', raw: 'this week' },
  followUpsAsked: 0,
};

const PLAIN_RESOLUTION =
  'This market resolves Yes if the final Close price of the Binance 1 minute candle for BTC/USDT ' +
  'is less than 68,000.';

// Spans the fixture exposure's 60,000 level, so `ladderCovers` passes in code
// and these tests exercise the model-driven half of `assessFit`.
const LADDER_LABELS = ['<56,000', '56,000-58,000', '58,000-60,000', '60,000-62,000', '62,000-64,000', '>64,000'];

function requireLadder(labels: string[]): Ladder {
  const ladder = parseLadder(labels);
  if (ladder === null) throw new Error(`test fixture: [${labels.join(', ')}] must parse as a ladder`);
  return ladder;
}

const LADDER = requireLadder(LADDER_LABELS);

function indexed(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    eventId: '1',
    slug: 'bitcoin-price-on-september-26-2026',
    seriesTicker: 'bitcoin-neg-risk-weekly',
    title: 'Bitcoin price on September 26?',
    ladder: LADDER,
    observationAt: '2026-09-26T16:00:00Z',
    observationSource: 'endDate',
    endDate: '2026-09-26T16:00:00Z',
    negRisk: true,
    bracketCount: 7,
    ...overrides,
  };
}

function candidate(i: number, resolutionText = PLAIN_RESOLUTION): FitCandidate {
  return { event: indexed({ eventId: `e${i}` }), resolutionText, bracketLabels: LADDER_LABELS };
}

function scoreAnswer(level: number): Answer {
  // Score probability keys must be numeric-level strings — calibration
  // parses them as numbers.
  return { kind: 'score', score: level, probabilities: { [String(level)]: 1 }, confidence: 1 };
}

function answersFor(count: number, edgeCaseRisk = 0.02): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (let i = 0; i < count; i += 1) {
    answers[`fit_${i}`] = scoreAnswer(4);
    answers[`sourceMatch_${i}`] = { kind: 'boolean', probability: 0.95 };
    answers[`edgeCaseRisk_${i}`] = { kind: 'boolean', probability: edgeCaseRisk };
  }
  return answers;
}

describe('assessFit', () => {
  it('rejects missing or incompatible temperature units even when the model approves', async () => {
    const c = candidate(0);
    c.event = indexed({ ladder: { ...LADDER, unit: '°F', span: { lo: -10, hi: 100 } } });
    for (const unit of [undefined, '°C', '°F']) {
      const exposure: TypedExposure = { ...EXPOSURE,
        levels: [{ value: 60, role: 'threshold', ...(unit ? { unit } : {}) }] };
      const result = await assessFit(exposure, 'threshold_digital', [c], createMockEngine(answersFor(1)));
      expect(result.fits[0]?.inScope).toBe(unit === '°F');
    }
  });
  it('sends every candidate in a single engine.ask', async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];

    let calls = 0;
    let payload: Record<string, Question> = {};
    const inner = createMockEngine(answersFor(3));
    const counting: QuestionEngine = {
      async ask(state, questions) {
        calls += 1;
        payload = questions;
        return inner.ask(state, questions);
      },
    };

    const result = await assessFit(EXPOSURE, 'threshold_digital', candidates, counting);

    expect(calls).toBe(1);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'edgeCaseRisk_0', 'edgeCaseRisk_1', 'edgeCaseRisk_2',
        'fit_0', 'fit_1', 'fit_2',
        'sourceMatch_0', 'sourceMatch_1', 'sourceMatch_2',
      ],
    );
    expect(result.fits.map((f) => f.eventId)).toEqual(['e0', 'e1', 'e2']);
  });

  it('attaches the market\'s own resolution text, verbatim, when edge-case risk is high', async () => {
    const resolutionText =
      'If the Binance BTC/USDT pair is delisted or trading is halted, resolution falls back to the ' +
      'Coinbase BTC/USD pair, and if neither is available the market resolves 50/50.';
    const candidates = [candidate(0, resolutionText)];

    const engine = createMockEngine(answersFor(1, 0.87));
    const result = await assessFit(EXPOSURE, 'threshold_digital', candidates, engine);

    const flags = result.fits[0]?.ruleFlags ?? [];
    const edgeFlag = flags.find((f) => f.includes('edge-case risk'));
    expect(edgeFlag).toBeDefined();
    // Verbatim and whole — not a paraphrase, not truncated.
    expect(edgeFlag).toContain(resolutionText);
  });
});
