import { describe, expect, it } from 'vitest';
import { composeView } from '../../apps/web/lib/compose.js';
import type { QuoteRecord } from '../../packages/engine/src/index.js';
import type { Alternative, BasketOption, IndexedEvent } from '../../packages/intake/src/index.js';

// The composition group. One bug lived here for real: re-pricing rebuilt a
// single hardcoded option and dropped the rest, so comparing baskets — the
// whole decision — quietly stopped working the moment the book moved.

const record = (costCents: number, coverageRatio: number): QuoteRecord =>
  ({
    version: 1,
    request: {
      eventId: 'e1',
      shape: { templateId: 'tail_only', payoutUsd: 8_000, direction: 'below', k: 77_000 },
    },
    resolved: {
      items: [
        { key: 'm1', bracket: { lo: null, hi: 77_000 } },
        { key: 'm2', bracket: { lo: 77_000, hi: null } },
      ],
      legs: [],
      feeRates: [0, 0],
      snapshotId: 'snap',
    },
    basket: {
      legs: [
        {
          legId: 'l1', marketId: 'm1', label: '<77,000', tokenId: 't1', side: 'YES',
          shares: 100, costCents: costCents, avgPriceMicros: 400_000,
        },
      ],
      totalCostCents: costCents,
      target: [],
      achievable: [],
      residual: {
        coverageRatio,
        worstStateShortfallCents: 0,
        worstStateLabel: null,
        overhedgeCents: 0,
        crossStateOverhedgeCents: 0,
      },
      maxShortfallDollars: 0,
      mu: 1,
      phase1Hash: 'p1',
      phase2Hash: 'p2',
    },
    meta: {
      quotedAt: '2026-09-21T00:00:00Z',
      jevModelVersion: 'jev-1.13.0',
      calibrationMapVersion: 'unfitted',
    },
  }) as unknown as QuoteRecord;

const event = {
  eventId: 'e1',
  title: 'Bitcoin price on September 23?',
  observationAt: '2026-09-23T16:00:00Z',
  observationSource: 'description',
  bracketCount: 11,
  ladder: { unit: '$' },
} as unknown as IndexedEvent;

const stop = (name: string, costCents: number, coverage: number): BasketOption => ({
  name,
  reason: `${name} reason`,
  record: record(costCents, coverage),
  residual: record(costCents, coverage).basket.residual,
});

describe('assembling what a user compares', () => {
  it('keeps every basket, because the comparison is the decision', () => {
    const { view, stopCount } = composeView({
      primary: record(60_000, 0.26),
      event,
      stops: [
        stop('Smaller', 21_000, 0.09),
        stop('Your budget', 60_000, 0.26),
        stop('Everything', 230_000, 1),
      ],
      alternatives: [],
      assumptions: [],
      questionFor: () => 'Will it?',
      linkFor: () => null,
    });

    expect(stopCount).toBe(3);
    expect(view.options.map((o) => o.name)).toEqual(['Smaller', 'Your budget', 'Everything']);
    // The specific regression: one option where three were solved.
    expect(view.options).toHaveLength(3);
  });

  it('never shows an alternative its own flattering coverage', () => {
    // An alternative solves a WEAKER target and so reports near-perfect cover
    // for strictly less protection. Only the re-measurement against the
    // primary's target may be shown.
    const alternative = {
      kind: 'cheaper_tail',
      reason: 'A further strike.',
      record: record(12_000, 0.98),
      residualVsPrimary: {
        coverageRatio: 0.31,
        worstStateShortfallCents: 0,
        worstStateLabel: null,
        overhedgeCents: 0,
        crossStateOverhedgeCents: 0,
      },
    } as unknown as Alternative;
    alternative.record.request.shape = {
      templateId: 'tail_only', payoutUsd: 8_000, direction: 'below', k: 76_000,
    };
    alternative.record.basket.achievable = [800_000, 0, 0] as never;

    const { view } = composeView({
      primary: record(60_000, 0.26),
      event,
      stops: [stop('Your budget', 60_000, 0.26)],
      alternatives: [alternative],
      assumptions: [],
      questionFor: () => '',
      linkFor: () => null,
    });

    const shown = view.options[1];
    expect(shown?.coverageRatio).toBeCloseTo(0.31, 6);
    expect(shown?.coverageLabel).toBe('31%');
    expect(shown?.netLossLabel).toBe('$8,120.00');
    expect(shown?.ladder.payout[1]?.owedUsd).toBe(8_000);
    // And the stop beside it keeps its own, which needed no correction.
    expect(view.options[0]?.coverageLabel).toBe('26%');
  });
});
