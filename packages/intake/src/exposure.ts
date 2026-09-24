// Turns deterministic candidates from parse.ts into a single round of Jev
// questions, and turns the answers into a role-assigned extraction result.
// Parsing happens first and is entirely offline; exactly one `ask` call is
// made per extraction, covering every candidate plus the fixed questions.

import type { Answer, Question, QuestionEngine } from '@polyhedge/questions';
import { findNumbers, parseDeadline, type NumberCandidate } from './parse.js';
import type { Parsed } from './types.js';
import { buildRawShapeQuestion } from './shape.js';

export class UnsupportedUnderlyingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedUnderlyingError';
  }
}

export interface ExtractionResult {
  candidates: NumberCandidate[];
  answers: Record<string, Answer>;
  modelVersion: string;
}

const ROLE_CRITERIA: Record<string, string> = {
  holding: 'The amount of the underlying the user currently holds.',
  loss: 'The TOTAL dollar loss or maximum loss the user states. A slope such as $10 per $1 price drop is NOT a total loss; classify both slope numbers as unrelated. A separately stated cover target is not another loss.',
  budget: 'The amount the user is willing to spend on the hedge or protection itself.',
  threshold: 'A single numeric level the position loses below or above.',
  range_low: 'The numerically LOWER numeric endpoint of either a comfortable range OR a gradual loss ramp. For a falling-value loss ramp this is where the loss reaches its maximum, not where it starts. A numeric endpoint is not a dollar loss amount.',
  range_high: 'The numerically HIGHER numeric endpoint of either a comfortable range OR a gradual loss ramp. For a falling-value loss ramp this is where the loss starts at zero. A numeric endpoint is not a dollar loss amount.',
  unrelated: 'A per-unit loss slope or its unit move (for example $10 and $1 in $10 per $1 drop), a date, a separately labelled cover target, or another number that is not a holding quantity, total loss, budget or price endpoint.',
};

const LOSS_DIRECTION_CRITERIA: Record<string, string> = {
  loses_below_level: 'The position loses value when the underlying falls below a single level.',
  loses_above_level: 'The position loses value when the underlying rises above a single level.',
  loses_outside_range: 'The position loses value when the underlying moves outside a two-sided range.',
};

/** Only identifies prose needing a semantic check; it never decides the answer. */
export function needsPathCheck(text: string): boolean {
  return /\b(touch(?:es|ed)?|ever|recovers?|at any (?:time|point)|barrier|knock[ -]?(?:in|out)|path[ -]dependent)\b/i.test(text);
}

function roleQuestion(text: string, candidate: NumberCandidate): Question {
  return {
    kind: 'choice',
    instructions:
      `Full text: "${text}". The number "${candidate.raw}" appears in this context: ` +
      `"${candidate.context}". What role does this number play in the user's hedge?`,
    criteria: ROLE_CRITERIA,
  };
}

/** Builds the single round of questions asked for one extraction. */
export function buildExposureQuestions(
  text: string,
  candidates: NumberCandidate[],
  deadline: Parsed<string> | null,
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  if (needsPathCheck(text)) {
    questions['settlementBasis'] = {
      kind: 'choice',
      instructions: `Read the whole request, including negations: "${text}". Does the requested payment depend on an intermediate crossing independently of the final observed outcome? Do not classify a final temperature maximum or other explicitly named settlement statistic as a crossing contract.`,
      criteria: {
        final: 'Only the final observed outcome/statistic determines the payment; intermediate observed value moves do not trigger a separate payment.',
        path: 'An intermediate touch or crossing triggers or cancels the payment even if the price later recovers; final price alone cannot determine it.',
        unclear: 'The user has not made this distinction clear.',
      },
    };
  }

  candidates.forEach((candidate, i) => {
    questions[`role_${i}`] = roleQuestion(text, candidate);
  });

  questions['lossDirection'] = {
    kind: 'choice',
    instructions: `Full text: "${text}". Does the user's position lose value below a level, above a level, or outside a range?`,
    criteria: LOSS_DIRECTION_CRITERIA,
  };

  questions['isHedge'] = {
    kind: 'boolean',
    instructions: 'The user wants to reduce a risk they already carry, rather than open a new speculative position.',
  };

  // Built from deadline.raw, NEVER the ISO value: verified live, confirming
  // an ISO date the user never stated scores ~0.19; the user's own words
  // score ~0.98. This is the reason Parsed.raw exists.
  if (deadline !== null) {
    questions['deadlineStated'] = {
      kind: 'boolean',
      instructions: `The deadline the user names is ${deadline.raw}.`,
    };
  }

  return questions;
}

/**
 * Extraction no longer refuses a subject.
 *
 * It used to throw unless the text named BTC or ETH, which confined the product
 * to two assets while the engine could price any ladder the venue publishes.
 * What the user is exposed to is now settled downstream, by evidence rather than
 * an allow-list: retrieval narrows to markets sharing the user's own words, and
 * `fit.ts` asks the model whether a candidate settles on the same thing. A
 * subject with no listed market fails there, honestly, instead of here.
 */
export async function extractExposure(text: string, today: Date, engine: QuestionEngine, combinedShape = false): Promise<ExtractionResult> {
  const candidates = findNumbers(text);
  const deadline = parseDeadline(text, today);

  const questions = { ...buildExposureQuestions(text, candidates, deadline),
    ...(combinedShape ? buildRawShapeQuestion(text) : {}) };
  const { answers, modelVersion } = await engine.ask(text, questions);

  return { candidates, answers, modelVersion };
}
