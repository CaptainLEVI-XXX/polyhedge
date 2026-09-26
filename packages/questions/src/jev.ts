// Adapter over TypeSafe's Jev System One API (https://api.typesafe.ai/v1/systemone).
// Wire contract verified against the live API:
//
//   POST /v1/systemone
//   { model, state, questions: { <id>: {...} } }
//   -> { model, answers: { <id>: {...} }, usage: {...} }
//
// Ours `choice`/`score` map straight onto Jev's `choice`/`score`. Ours
// `boolean` maps onto Jev's `noul`, which has no `confidence` field: a
// noul's probability describes its distribution completely.

import type { Answer, Question, QuestionEngine } from './types.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// Pinned, not `jev-latest`: TypeSafe recommends pinning once thresholds are
// tuned and publishes no changelog or deprecation policy for the alias, so a
// moving version would silently invalidate a fitted calibration.
const DEFAULT_MODEL = 'jev-1.13.0';

export interface JevEngineOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

type WireQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

function toWireQuestion(q: Question): WireQuestion {
  switch (q.kind) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.criteria };
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.criteria };
    case 'boolean':
      return {
        type: 'noul',
        instructions: q.instructions,
        ...(q.criteria !== undefined ? { criteria: q.criteria } : {}),
      };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function fromWireAnswer(id: string, raw: unknown): Answer {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    throw new Error(`jev: malformed answer for question "${id}"`);
  }

  const type = raw['type'];
  if (type === 'choice') {
    const choice = raw['choice'];
    const probabilities = raw['probabilities'];
    const confidence = raw['confidence'];
    if (typeof choice !== 'string' || !isRecord(probabilities) || typeof confidence !== 'number') {
      throw new Error(`jev: malformed choice answer for question "${id}"`);
    }
    return { kind: 'choice', choice, probabilities: probabilities as Record<string, number>, confidence };
  }

  if (type === 'score') {
    const score = raw['score'];
    const probabilities = raw['probabilities'];
    const confidence = raw['confidence'];
    if (typeof score !== 'number' || !isRecord(probabilities) || typeof confidence !== 'number') {
      throw new Error(`jev: malformed score answer for question "${id}"`);
    }
    return { kind: 'score', score, probabilities: probabilities as Record<string, number>, confidence };
  }

  if (type === 'noul') {
    const noul = raw['noul'];
    if (typeof noul !== 'number') {
      throw new Error(`jev: malformed noul answer for question "${id}"`);
    }
    return { kind: 'boolean', probability: noul };
  }

  throw new Error(`jev: unknown answer type "${type}" for question "${id}"`);
}

export function createJevEngine(options: JevEngineOptions): QuestionEngine {
  const { apiKey } = options;
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async ask(state, questions) {
      const wireQuestions: Record<string, WireQuestion> = {};
      for (const [id, q] of Object.entries(questions)) {
        wireQuestions[id] = toWireQuestion(q);
      }

      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, state, questions: wireQuestions }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`jev: POST /v1/systemone -> ${res.status} ${body}`);
      }

      const json = (await res.json()) as unknown;
      if (!isRecord(json) || typeof json['model'] !== 'string' || !isRecord(json['answers'])) {
        throw new Error('jev: malformed response body');
      }

      const answers: Record<string, Answer> = {};
      for (const [id, raw] of Object.entries(json['answers'])) {
        answers[id] = fromWireAnswer(id, raw);
      }

      return { answers, modelVersion: json['model'] };
    },
  };
}
