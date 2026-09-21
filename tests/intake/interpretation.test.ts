import { describe, expect, it } from 'vitest';
import { findNumbers, parseDeadline, parseUnderlying } from '../../packages/intake/src/parse.js';
import { type QuestionEngine, createMockEngine } from '../../packages/questions/src/index.js';
import { buildExposureQuestions, extractExposure } from '../../packages/intake/src/exposure.js';
import { compile, MissingLevelError } from '../../packages/intake/src/compile.js';
import { type IndexedEvent } from '../../packages/intake/src/retrieve.js';
import { type TypedExposure } from '../../packages/intake/src/types.js';
import { selectShape, buildShapeQuestion, SHAPE_QUESTION_ID } from '../../packages/intake/src/shape.js';

describe('findNumbers', () => {
  it('preserves signed temperatures and units without turning range separators into signs', () => {
    expect(findNumbers('below -5°C or −10 degrees Fahrenheit').map(n => [n.value, n.unit]))
      .toEqual([[-5, '°C'], [-10, '°F']]);
    expect(findNumbers('60-70°F').map(n => n.value)).toEqual([60, 70]);
    expect(findNumbers('5% or 25 bps').map(n => [n.value, n.unit])).toEqual([[5, '%'], [25, 'bps']]);
  });
  it('extracts four numbers with distinguishable context', () => {
    const text = 'I hold $40k of BTC, could lose $8k below $60k, and can spend $300 on protection';
    const candidates = findNumbers(text);

    expect(candidates).toHaveLength(4);

    expect(candidates[0]?.value).toBe(40_000);
    expect(candidates[0]?.context).toContain('hold');

    expect(candidates[1]?.value).toBe(8_000);
    expect(candidates[1]?.context).toContain('lose');

    expect(candidates[2]?.value).toBe(60_000);
    expect(candidates[2]?.context).toContain('below');

    expect(candidates[3]?.value).toBe(300);
    expect(candidates[3]?.context).toContain('spend');
  });
});

describe('parseDeadline', () => {
  const today = new Date('2026-09-20T00:00:00Z');
  it('reads a named observation date and allows a later explicit correction', () => {
    expect(parseDeadline('cold on September 26', today)?.value).toBe('2026-09-26');
    expect(parseDeadline('on September 26. My deadline is by Sept 27.', today)?.value).toBe('2026-09-27');
    expect(parseDeadline('on February 30', today)).toBeNull();
  });

  it('infers the year for "by Dec 31" when it has not passed yet', () => {
    const result = parseDeadline('Hedge this by Dec 31 please', today);

    expect(result?.value).toBe('2026-12-31');
    expect(result?.provenance).toBe('inferred');
    expect(result?.raw).toBe('Dec 31');
  });

  it('marks the year stated when it is written in the text', () => {
    const result = parseDeadline('by December 31 2027', today);

    expect(result?.value).toBe('2027-12-31');
    expect(result?.provenance).toBe('stated');
    expect(result?.raw).toBe('December 31 2027');
  });

  it('rolls a past month/day forward to next year and keeps it inferred', () => {
    const result = parseDeadline('by Jan 5', today);

    expect(result?.value).toBe('2027-01-05');
    expect(result?.provenance).toBe('inferred');
  });

  it('rejects an impossible calendar date instead of normalising it', () => {
    const result = parseDeadline('by Feb 29', new Date('2026-06-01T00:00:00Z'));

    expect(result).toBeNull();
  });
});

describe('parseUnderlying', () => {
  it('declines unsupported assets as OTHER instead of null', () => {
    expect(parseUnderlying('I hold $40k of SOL alts')).toBe('OTHER');
  });
});

describe('buildExposureQuestions', () => {
  it('builds the deadline question from the stated words, not the ISO date', () => {
    const today = new Date('2026-09-20T00:00:00Z');
    const text = 'I hold $40k of BTC, could lose $8k below $60k by Dec 31';

    const candidates = findNumbers(text);
    const deadline = parseDeadline(text, today);
    expect(deadline?.value).toBe('2026-12-31');

    const questions = buildExposureQuestions(text, candidates, deadline);
    const deadlineQuestion = questions['deadlineStated'];

    expect(deadlineQuestion).toBeDefined();
    expect(deadlineQuestion?.instructions).toBe('The deadline the user names is Dec 31.');
    expect(deadlineQuestion?.instructions).toContain('Dec 31');
    expect(deadlineQuestion?.instructions).not.toContain('2026-12-31');
  });
});

describe('extractExposure', () => {
  it('no longer refuses a subject it does not recognise', async () => {
    // The old behaviour threw unless the text named BTC or ETH, which confined
    // the product to two assets while the engine can price any ladder the venue
    // publishes. Whether a market exists is now settled by retrieval and fit, on
    // evidence — not by an allow-list sitting in front of extraction.
    const today = new Date('2026-09-20T00:00:00Z');
    let asked = 0;
    const engine: QuestionEngine = {
      ask: async () => {
        asked += 1;
        return { answers: {}, modelVersion: 'test' };
      },
    };

    const result = await extractExposure(
      'I run outdoor events in Chicago and lose $12,000 if it ends below 62°F',
      today,
      engine,
    );
    expect(asked).toBe(1);
    expect(result.candidates.map((c) => c.value)).toContain(12000);
  });

});

function exposure(overrides: Partial<TypedExposure> = {}): TypedExposure {
  return {
    rawText: 'I hold 2 BTC and I lose money if it ends below 60k.',
    underlying: 'BTC',
    lossUsd: { value: 8000, provenance: 'stated', raw: '$8k' },
    hedgeRatio: 1,
    direction: 'below',
    levels: [{ value: 60000, role: 'threshold' }],
    deadline: { value: '2026-09-26', provenance: 'stated', raw: 'this week' },
    followUpsAsked: 0,
    ...overrides,
  };
}

const EVENT: IndexedEvent = {
  eventId: 'evt-1',
  slug: 'bitcoin-price-on-september-26-2026',
  seriesTicker: 'bitcoin-neg-risk-weekly',
  title: 'Bitcoin price on September 26?',
  ladder: {
    brackets: [
      { lo: null, hi: 60000, label: '<60,000' },
      { lo: 60000, hi: 70000, label: '60,000-70,000' },
      { lo: 70000, hi: null, label: '>70,000' },
    ],
    unit: '',
    span: { lo: 60000, hi: 70000 },
  },
  observationAt: '2026-09-26T16:00:00Z',
  observationSource: 'endDate',
  endDate: '2026-09-26T16:00:00Z',
  negRisk: true,
  bracketCount: 7,
};

describe('compile', () => {
  it('takes k from the threshold role and scales the payout by the hedge ratio', () => {
    const request = compile(exposure({ hedgeRatio: 0.5 }), 'threshold_digital', EVENT);

    expect(request.eventId).toBe('evt-1');
    expect(request.shape).toEqual({
      templateId: 'threshold_digital',
      payoutUsd: 4000,
      direction: 'below',
      k: 60000,
    });
  });

  it('orders a range by role, not by the order the user stated the numbers in', () => {
    // The user says the high number first. Position must mean nothing here.
    const stated = exposure({
      rawText: "I'm fine as long as it stays between 80k and 60k.",
      direction: 'outside',
      levels: [
        { value: 80000, role: 'range_high' },
        { value: 60000, role: 'range_low' },
      ],
    });

    const request = compile(stated, 'range_protect', EVENT);

    expect(request.shape).toEqual({
      templateId: 'range_protect',
      payoutUsd: 8000,
      low: 60000,
      high: 80000,
    });
  });

  it('throws MissingLevelError naming the field rather than inventing a price', () => {
    const noHigh = exposure({
      direction: 'outside',
      levels: [{ value: 60000, role: 'range_low' }],
    });

    expect(() => compile(noHigh, 'range_protect', EVENT)).toThrow(MissingLevelError);
    try {
      compile(noHigh, 'range_protect', EVENT);
      throw new Error('expected compile to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingLevelError);
      expect((err as MissingLevelError).field).toBe('range_high');
      expect((err as MissingLevelError).message).toContain('range_high');
    }
  });

  it('carries a stated budget through and omits the key entirely when there is none', () => {
    const withBudget = compile(
      exposure({ budgetUsd: { value: 400, provenance: 'stated', raw: '$400' } }),
      'threshold_digital',
      EVENT,
    );
    expect(withBudget.budgetUsd).toBe(400);

    const withoutBudget = compile(exposure(), 'threshold_digital', EVENT);
    // Absent, not present-and-undefined: the engine reads a present
    // budgetUsd as a real cap.
    expect('budgetUsd' in withoutBudget).toBe(false);
  });
});

const EXPOSURE: TypedExposure = {
  rawText: 'I hold 2 BTC and I only really care if it ends up somewhere weird and lumpy.',
  underlying: 'BTC',
  lossUsd: { value: 8000, provenance: 'stated', raw: '$8k' },
  hedgeRatio: 1,
  direction: 'below',
  levels: [{ value: 60000, role: 'threshold' }],
  deadline: { value: '2026-12-31', provenance: 'stated', raw: 'Dec 31' },
  followUpsAsked: 0,
};

describe('selectShape', () => {
  it('declines on a confident none_fit rather than falling back to a template', async () => {
    const engine = createMockEngine(
      {
        [SHAPE_QUESTION_ID]: {
          kind: 'choice',
          choice: 'none_fit',
          probabilities: {
            threshold_digital: 0.06,
            range_protect: 0.02,
            linear_strip: 0.01,
            none_fit: 0.91,
          },
          confidence: 0.91,
        },
      },
      'jev-1.13.0',
    );

    expect(Object.keys(buildShapeQuestion(EXPOSURE)[SHAPE_QUESTION_ID]!.criteria!)).toEqual(['threshold_digital', 'range_protect', 'linear_strip', 'none_fit']);
    const selection = await selectShape(EXPOSURE, engine);

    expect(selection.kind).toBe('decline');
    // The point of the test: a confident "none of these" must not be
    // rounded off to the runner-up template.
    expect(selection).not.toHaveProperty('templateId');
    if (selection.kind !== 'decline') throw new Error('expected a decline');
    expect(selection.reason).toContain('none of the supported price shapes');
    expect(selection.modelVersion).toBe('jev-1.13.0');
  });
});
