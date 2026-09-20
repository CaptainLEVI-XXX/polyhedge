// Jev call 3: does a retrieved market actually cover the loss the user
// described? Asked once, for every candidate at once.
//
// ONE `engine.ask` covers the whole shortlist. Three questions per
// candidate go into a single payload rather than one call per market. That
// is not only a latency or cost choice: a market is judged relative to the
// alternatives on the same shortlist, and splitting the shortlist across
// calls means each market is judged against an empty field.
//
// NO QUESTION IN THIS FILE MAY MENTION A DATE, A DEADLINE, AN EXPIRY,
// "BEFORE" OR "AFTER", OR ASK THE MODEL TO ORDER ANYTHING IN TIME.
// There used to be a `deadlineMatch` question here. It was a date
// comparison, and TypeSafe's own jev-1.13 limitations page states that
// dates are read as TEXT, not as ordered quantities — the model will
// cheerfully report that one date precedes another based on how the strings
// look. Every date decision this pipeline makes already happened in
// `retrieve.ts`, in code: eligibility against the deadline, nearest-first
// ordering, and the `observationNote` flag for a later observation date.
// Nothing here re-litigates that, and nothing here feeds the model a value
// it could try to order: no `observationAt`, no `endDate`, no `slug`, no
// `observationNote`. Re-adding a date question would replace a correct code
// comparison with an unreliable textual one.
//
// (The venue's own `resolutionText` is quoted verbatim into the
// `edgeCaseRisk` question and its flag, and venue prose does typically name
// a date. That is the market's published wording being shown as evidence,
// not a question asking the model to order times — and it must never be
// paraphrased or truncated, because the user reads the venue's words.)

import {
  calibrate,
  IDENTITY_CALIBRATION,
  type Answer,
  type CalibrationMap,
  type Question,
  type QuestionEngine,
} from '@polyhedge/questions';
import type { IndexedEvent } from './retrieve.js';
import type { PriceTemplateId } from './shape.js';
import type { NamedLevel, TypedExposure } from './types.js';

export interface FitCandidate {
  event: IndexedEvent;
  /** The market's own resolution prose, verbatim, as published by the venue. */
  resolutionText: string;
}

export interface MarketFit {
  eventId: string;
  /** Score answer's score. Coarse in/out signal ONLY — never a ranking key. */
  fitScore: number;
  inScope: boolean;
  /** P(true) that the market resolves off the same price source the user means. */
  sourceMatch: number;
  ruleFlags: string[];
}

export interface FitResult {
  fits: MarketFit[];
  modelVersion: string;
}

export interface FitThresholds {
  /** `fitScore` at or above this puts a market in scope. A coarse gate, nothing more. */
  minFitScore: number;
  /** Below this P(true), the market's price source is flagged as a possible mismatch. */
  minSourceMatch: number;
  /** At or above this P(true), the resolution prose is flagged as carrying an unaccounted-for condition. */
  maxEdgeCaseRisk: number;
}

/**
 * Unfitted policy numbers, not calibrated probabilities — `IDENTITY_CALIBRATION`
 * is `version: 'unfitted'`, so there is no fitted curve behind any of these.
 * Exported and overridable so a caller with labelled data can replace them
 * without editing this file.
 */
export const DEFAULT_FIT_THRESHOLDS: FitThresholds = {
  minFitScore: 3,
  minSourceMatch: 0.6,
  maxEdgeCaseRisk: 0.5,
};

/**
 * The `fit` score's levels, weakest first. Deliberately coarse and few.
 *
 * Jev indexes score levels from ZERO, verified live against jev-1.13.0: the
 * response echoes a `legend` keyed `"0".."4"` for five criteria, and
 * `score` is the probability-weighted mean over those indices (a market
 * covering the loss exactly scored 3.96; an unrelated one 0.18). So with
 * these five levels `minFitScore: 3` gates at "pays out in most of the
 * situations where the user loses money" — strict. If a level is ever added
 * or removed here, that threshold changes meaning and must be revisited.
 *
 * `score` is the weakest Jev primitive: its docs describe an ordinal
 * judgement with no guarantee that the gap between level 2 and level 3
 * means the same as the gap between level 3 and level 4, and the level
 * probabilities are not a calibrated quantity. So this is used as an in/out
 * gate at one threshold and NOTHING else. In particular, `fits` is never
 * re-sorted by `fitScore`: retrieval already ordered the shortlist
 * nearest-first in code, and re-ranking by an uncalibrated ordinal would
 * throw away a correct ordering in favour of a guess.
 */
const FIT_LEVELS: string[] = [
  'The market pays out on something unrelated to the loss the user described.',
  'The market is about the same asset, but the outcome it pays on barely overlaps with the user\'s loss.',
  'The market is about the same asset and partly overlaps the user\'s loss, with a large gap left uncovered.',
  'The market pays out in most of the situations where the user loses money, with minor gaps.',
  'The market pays out in exactly the situations where the user loses money.',
];

const TEMPLATE_PAYOFFS: Record<PriceTemplateId, string> = {
  threshold_digital: 'a fixed amount paid whenever the price ends past one level',
  tail_only: 'a fixed amount paid only if the price ends far past one level, in the extreme case',
  range_protect: 'a fixed amount paid whenever the price ends outside a two-sided range',
  linear_strip: 'an amount that grows steadily as the price moves between two levels',
};

const ROLE_WORDS: Record<NamedLevel['role'], string> = {
  threshold: 'a single level the position loses past',
  range_low: 'the lower bound of a range',
  range_high: 'the upper bound of a range',
};

function describeLevels(levels: NamedLevel[]): string {
  if (levels.length === 0) return 'The user named no price levels.';
  const parts = levels.map((level) => `${level.value} (${ROLE_WORDS[level.role]})`);
  return `The price levels the user gave, with the role each plays: ${parts.join('; ')}.`;
}

/**
 * The shared description of what the user is exposed to. Built from the
 * user's own words, the roles already assigned to their levels, and the
 * chosen payoff shape — and from nothing time-related.
 */
function describeExposure(exposure: TypedExposure, templateId: PriceTemplateId): string {
  return (
    `The user described their position in their own words: "${exposure.rawText}". ` +
    `${describeLevels(exposure.levels)} ` +
    `The protection they want pays out like this: ${TEMPLATE_PAYOFFS[templateId]}.`
  );
}

/**
 * Describes one candidate market WITHOUT any of its time fields. The event
 * is identified to the model by what it pays on — its asset and how many
 * price brackets it splits into — because that is what the fit judgement
 * turns on, and because every time field on `IndexedEvent` is a value the
 * model would try to read as text.
 */
function describeCandidate(candidate: FitCandidate): string {
  const { event } = candidate;
  return (
    `This market settles on the price of ${event.underlying} and splits that price into ` +
    `${event.bracketCount} separate brackets, one of which pays out.`
  );
}

/**
 * Builds every question for the whole shortlist, as one payload. Exported
 * separately from `assessFit` so a test can inspect exactly what would
 * reach the model — in particular, that no date question is in it.
 *
 * Ids are `fit_${i}`, `sourceMatch_${i}`, `edgeCaseRisk_${i}`, indexed by
 * the candidate's position in the input array, which is also the order
 * `fits` comes back in.
 */
export function buildFitQuestions(
  exposure: TypedExposure,
  templateId: PriceTemplateId,
  candidates: FitCandidate[],
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  const exposureText = describeExposure(exposure, templateId);

  candidates.forEach((candidate, i) => {
    const candidateText = describeCandidate(candidate);

    questions[`fit_${i}`] = {
      kind: 'score',
      instructions:
        `${exposureText} ${candidateText} ` +
        'How well would holding this market cover the loss the user described?',
      criteria: FIT_LEVELS,
    };

    questions[`sourceMatch_${i}`] = {
      kind: 'boolean',
      instructions:
        `${exposureText} This market settles off the following published rule: ` +
        `"${candidate.resolutionText}" ` +
        `The market settles off the very same price the user is exposed to — the same asset, priced on an ` +
        `exchange the way the user means it — rather than a different asset, a basket or index, or an ` +
        `oracle reporting something else.`,
      criteria: {
        true: 'The price that settles this market is the price of the same asset the user holds, as traded on an exchange.',
        false:
          'The price that settles this market is something else: a different asset, an index or basket, ' +
          'or an oracle publishing a value other than the exchange price of the asset the user holds.',
      },
    };

    questions[`edgeCaseRisk_${i}`] = {
      kind: 'boolean',
      instructions:
        `${exposureText} This market's published resolution rule reads, in full: ` +
        `"${candidate.resolutionText}" ` +
        'Settlement of this market turns on some condition in that rule which the user\'s own description ' +
        'of their position does not account for, so the market could settle in a way that surprises them.',
      criteria: {
        true: 'The rule contains a condition the user\'s description does not account for.',
        false: 'Everything the rule turns on is already covered by the user\'s description of their position.',
      },
    };
  });

  return questions;
}

function requireAnswer(answers: Record<string, Answer>, id: string, kind: Answer['kind']): Answer {
  const answer = answers[id];
  if (answer === undefined) {
    throw new Error(`assessFit: no answer for question "${id}"`);
  }
  if (answer.kind !== kind) {
    throw new Error(`assessFit: "${id}" came back as kind '${answer.kind}', expected '${kind}'`);
  }
  return answer;
}

/**
 * Scores the whole shortlist in one call.
 *
 * `fits` preserves the INPUT ORDER. `retrieve` already ordered the
 * shortlist nearest-first using real date arithmetic in code; `fitScore` is
 * an uncalibrated ordinal used only as an in/out gate, so sorting by it
 * would discard a correct ordering for an unreliable one.
 */
export async function assessFit(
  exposure: TypedExposure,
  templateId: PriceTemplateId,
  candidates: FitCandidate[],
  engine: QuestionEngine,
  calibration: CalibrationMap = IDENTITY_CALIBRATION,
  thresholds: FitThresholds = DEFAULT_FIT_THRESHOLDS,
): Promise<FitResult> {
  const questions = buildFitQuestions(exposure, templateId, candidates);
  const { answers, modelVersion } = await engine.ask(exposure.rawText, questions);

  const fits: MarketFit[] = candidates.map((candidate, i) => {
    // Calibrate every answer before any threshold reads it — the raw
    // probabilities and the calibrated ones disagree by construction once a
    // temperature is fitted, and thresholds are stated against calibrated
    // values.
    const fitAnswer = calibrate(requireAnswer(answers, `fit_${i}`, 'score'), calibration);
    const sourceAnswer = calibrate(requireAnswer(answers, `sourceMatch_${i}`, 'boolean'), calibration);
    const edgeAnswer = calibrate(requireAnswer(answers, `edgeCaseRisk_${i}`, 'boolean'), calibration);

    if (fitAnswer.kind !== 'score' || sourceAnswer.kind !== 'boolean' || edgeAnswer.kind !== 'boolean') {
      throw new Error(`assessFit: calibration changed the answer kind for candidate ${i}`);
    }

    const ruleFlags: string[] = [];

    if (sourceAnswer.probability < thresholds.minSourceMatch) {
      ruleFlags.push(
        `source mismatch: P(this market settles off the same ${exposure.underlying} exchange price the user ` +
          `is exposed to) = ${sourceAnswer.probability.toFixed(2)}, below ${thresholds.minSourceMatch} — it may ` +
          'settle off a different asset, an index, or an oracle',
      );
    }

    if (edgeAnswer.probability >= thresholds.maxEdgeCaseRisk) {
      // The venue's own words, verbatim and whole. Not a paraphrase and not
      // truncated: the user is being asked to accept a resolution rule, so
      // they read the rule, not our summary of it.
      ruleFlags.push(
        `edge-case risk: P(resolution turns on a condition the exposure does not account for) = ` +
          `${edgeAnswer.probability.toFixed(2)}, at or above ${thresholds.maxEdgeCaseRisk}. ` +
          `The venue's published resolution rule reads: "${candidate.resolutionText}"`,
      );
    }

    return {
      eventId: candidate.event.eventId,
      fitScore: fitAnswer.score,
      inScope: fitAnswer.score >= thresholds.minFitScore,
      sourceMatch: sourceAnswer.probability,
      ruleFlags,
    };
  });

  return { fits, modelVersion };
}
