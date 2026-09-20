// A test double for QuestionEngine, exported as part of the public surface
// (not just a local test helper) so other packages can drive extraction
// logic without hitting the network. It throws on any question id it has no
// stubbed answer for, so a caller can never silently pass on a missing stub.

import type { Answer, QuestionEngine } from './types.js';

export function createMockEngine(answers: Record<string, Answer>, modelVersion = 'mock'): QuestionEngine {
  return {
    async ask(_state, questions) {
      const out: Record<string, Answer> = {};
      for (const id of Object.keys(questions)) {
        const answer = answers[id];
        if (answer === undefined) {
          throw new Error(`mock engine: no stubbed answer for question "${id}"`);
        }
        out[id] = answer;
      }
      return { answers: out, modelVersion };
    },
  };
}
