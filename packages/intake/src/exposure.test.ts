import { describe, expect, it } from 'vitest';
import type { QuestionEngine } from '@polyhedge/questions';
import { buildExposureQuestions, extractExposure, UnsupportedUnderlyingError } from './exposure.js';
import { findNumbers, parseDeadline } from './parse.js';

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
  it('throws UnsupportedUnderlyingError for an OTHER underlying without calling the engine', async () => {
    const today = new Date('2026-09-20T00:00:00Z');
    const text = 'I hold $40k of SOL, could lose $8k below $60k by Dec 31';

    const engine: QuestionEngine = {
      ask: async () => {
        throw new Error('engine.ask must not be called for an unsupported underlying');
      },
    };

    await expect(extractExposure(text, today, engine)).rejects.toBeInstanceOf(UnsupportedUnderlyingError);
  });
});
