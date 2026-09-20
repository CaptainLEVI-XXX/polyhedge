import { describe, expect, it } from 'vitest';
import { createMockEngine } from '@polyhedge/questions';
import { selectShape, SHAPE_QUESTION_ID } from './shape.js';
import type { TypedExposure } from './types.js';

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
            threshold_digital: 0.04,
            tail_only: 0.02,
            range_protect: 0.02,
            linear_strip: 0.01,
            none_fit: 0.91,
          },
          confidence: 0.91,
        },
      },
      'jev-1.13.0',
    );

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
