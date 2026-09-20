import { describe, expect, it, vi } from 'vitest';
import { createJevEngine } from '../../packages/questions/src/jev.js';
import { type Question, type Answer } from '../../packages/questions/src/types.js';
import { calibrate, IDENTITY_CALIBRATION, type CalibrationMap } from '../../packages/questions/src/calibration.js';
import { route, type FieldPolicy } from '../../packages/questions/src/router.js';

function fakeResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('createJevEngine', () => {
  it('serializes a boolean question as type "noul" and parses a noul answer back to boolean', async () => {
    let sentBody: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return fakeResponse({
        model: 'jev-1.13.0',
        answers: { q1: { type: 'noul', noul: 0.98 } },
        usage: {},
      });
    });

    const engine = createJevEngine({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const questions: Record<string, Question> = {
      q1: { kind: 'boolean', instructions: 'Is this true?' },
    };

    const result = await engine.ask('some state', questions);

    expect((sentBody as { questions: { q1: { type: string } } }).questions.q1.type).toBe('noul');
    expect(result.answers['q1']).toEqual({ kind: 'boolean', probability: 0.98 });
  });

  it('reads modelVersion from the response model field, not the request', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        model: 'jev-1.14.2',
        answers: {},
        usage: {},
      }),
    );

    const engine = createJevEngine({
      apiKey: 'test-key',
      model: 'jev-1.13.0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await engine.ask('state', {});

    expect(result.modelVersion).toBe('jev-1.14.2');
  });

  it('throws with the status included when the response is not ok', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('rate limited', { ok: false, status: 429 }));
    const engine = createJevEngine({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(engine.ask('state', {})).rejects.toThrow(/429/);
  });
});

describe('calibrate', () => {
  it('T = 1 leaves a choice answer exactly unchanged', () => {
    const answer: Answer = {
      kind: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 },
      confidence: 0.7,
    };

    const result = calibrate(answer, IDENTITY_CALIBRATION);

    expect(result).toBe(answer); // exact identity, not merely an equal copy
    expect(result).toEqual(answer);
  });

  it('T > 1 flattens a choice distribution: max probability and confidence both drop, probabilities still sum to ~1', () => {
    const answer: Answer = {
      kind: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.9, no: 0.06, maybe: 0.04 },
      confidence: 0.9,
    };
    const map: CalibrationMap = { version: 'test', temperature: { choice: 3, score: 1, boolean: 1 } };

    const result = calibrate(answer, map);

    if (result.kind !== 'choice') throw new Error('expected a choice answer');
    const sum = Object.values(result.probabilities).reduce((a, b) => a + b, 0);

    expect(sum).toBeCloseTo(1, 9);
    expect(result.confidence).toBeLessThan(answer.confidence);
    expect(Math.max(...Object.values(result.probabilities))).toBeCloseTo(result.confidence, 9);
    // choice selection is untouched — temperature scaling preserves argmax.
    expect(result.choice).toBe('yes');
  });

  it('T > 1 on a boolean moves its probability toward 0.5 without crossing it', () => {
    const answer: Answer = { kind: 'boolean', probability: 0.95 };
    const map: CalibrationMap = { version: 'test', temperature: { choice: 1, score: 1, boolean: 4 } };

    const result = calibrate(answer, map);

    if (result.kind !== 'boolean') throw new Error('expected a boolean answer');
    expect(result.probability).toBeLessThan(answer.probability);
    expect(result.probability).toBeGreaterThan(0.5);
  });

  it('rejects an invalid temperature instead of silently corrupting the answer (T=0 -> NaN, T<0 -> inverted distribution)', () => {
    const answer: Answer = { kind: 'boolean', probability: 0.7 };
    const zero: CalibrationMap = { version: 'test', temperature: { choice: 1, score: 1, boolean: 0 } };
    const negative: CalibrationMap = { version: 'test', temperature: { choice: 1, score: 1, boolean: -1 } };

    expect(() => calibrate(answer, zero)).toThrow(/boolean temperature.*got 0/);
    expect(() => calibrate(answer, negative)).toThrow(/boolean temperature.*got -1/);
  });

  it('T > 1 on a score answer flattens probabilities AND recomputes score as their weighted mean', () => {
    const answer: Answer = {
      kind: 'score',
      score: 2.6,
      probabilities: { '1': 0.1, '2': 0.2, '3': 0.7 },
      confidence: 0.7,
    };
    const map: CalibrationMap = { version: 'test', temperature: { choice: 1, score: 2, boolean: 1 } };

    const result = calibrate(answer, map);

    if (result.kind !== 'score') throw new Error('expected a score answer');
    const sum = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
    const expectedScore = Object.entries(result.probabilities).reduce(
      (total, [level, p]) => total + Number(level) * p,
      0,
    );

    expect(sum).toBeCloseTo(1, 9);
    expect(Math.max(...Object.values(result.probabilities))).toBeLessThan(
      Math.max(...Object.values(answer.probabilities)),
    );
    expect(result.score).toBeCloseTo(expectedScore, 9);
    expect(result.score).not.toBeCloseTo(answer.score, 2); // stale score would be wrong here
  });
});

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
