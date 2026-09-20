import { describe, expect, it } from 'vitest';
import { compile, MissingLevelError } from './compile.js';
import type { IndexedEvent } from './retrieve.js';
import type { TypedExposure } from './types.js';

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
  underlying: 'BTC',
  observationAt: '2026-09-26T16:00:00Z',
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
