import { describe, expect, it, vi } from 'vitest';
import { createJevEngine } from './jev.js';
import { createMockEngine } from './mock.js';
import type { Question } from './types.js';

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

describe('createMockEngine', () => {
  it('throws on a question id it has no stubbed answer for', async () => {
    const engine = createMockEngine({ known: { kind: 'boolean', probability: 0.5 } });
    const questions: Record<string, Question> = {
      unknown: { kind: 'boolean', instructions: 'anything' },
    };

    await expect(engine.ask('state', questions)).rejects.toThrow(/unknown/);
  });
});
