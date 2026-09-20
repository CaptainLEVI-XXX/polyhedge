import { describe, expect, it } from 'vitest';
import { route } from './router.js';
import type { FieldPolicy } from './router.js';
import type { Answer } from './types.js';

describe('route', () => {
  it('routes on the required answer, not on distance from 0.5: isHedge=0.01 declines, edgeCaseRisk=0.01 proceeds', () => {
    const isHedge: Answer = { kind: 'boolean', probability: 0.01 };
    const edgeCaseRisk: Answer = { kind: 'boolean', probability: 0.01 };

    const hedgeDecline = route(
      { isHedge },
      { isHedge: { required: 'true', onFail: 'decline', threshold: 0.5 } },
      0,
    );
    expect(hedgeDecline).toEqual({ kind: 'decline', field: 'isHedge', reason: expect.any(String) });

    const riskProceed = route(
      { edgeCaseRisk },
      { edgeCaseRisk: { required: 'false', onFail: 'decline', threshold: 0.5 } },
      0,
    );
    expect(riskProceed).toEqual({ kind: 'proceed', flags: [] });
  });

  it('returns a follow-up for the single weaker of two middling fields', () => {
    // Both are below their 0.9 threshold; fieldB is further below (weaker).
    const fieldA: Answer = { kind: 'boolean', probability: 0.8 };
    const fieldB: Answer = { kind: 'boolean', probability: 0.65 };
    const policies: Record<string, FieldPolicy> = {
      fieldA: { required: 'true', onFail: 'follow_up', threshold: 0.9 },
      fieldB: { required: 'true', onFail: 'follow_up', threshold: 0.9 },
    };

    const result = route({ fieldA, fieldB }, policies, 0);

    expect(result).toEqual({ kind: 'follow_up', field: 'fieldB' });
  });

  it('declines instead of looping once followUpsAsked has hit the cap', () => {
    const field: Answer = { kind: 'boolean', probability: 0.6 };
    const policies: Record<string, FieldPolicy> = {
      field: { required: 'true', onFail: 'follow_up', threshold: 0.9 },
    };

    const underCap = route({ field }, policies, 1, 2);
    expect(underCap).toEqual({ kind: 'follow_up', field: 'field' });

    const atCap = route({ field }, policies, 2, 2);
    expect(atCap).toEqual({ kind: 'decline', field: 'field', reason: expect.any(String) });
  });

  it('throws when a policy requires true/false against a choice/score answer, naming the field', () => {
    const marketFit: Answer = {
      kind: 'choice',
      choice: 'strong',
      probabilities: { strong: 0.6, weak: 0.4 },
      confidence: 0.6,
    };
    const policies: Record<string, FieldPolicy> = {
      marketFit: { required: 'true', onFail: 'decline', threshold: 0.5 },
    };

    expect(() => route({ marketFit }, policies, 0)).toThrow(/marketFit/);
  });
});
