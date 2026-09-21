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
// paraphrased or truncated, because the user reads the venue's words.
//
// The event's `title` is now quoted the same way, for the same reason and
// under the same rule. Once retrieval stopped being confined to two assets
// there is no asset name to hand the model: what a market is about is its
// own title ("Highest temperature in NYC on September 30?"), and titles
// routinely name a date. Quoting one is evidence, not a date question —
// every date decision was already made in `retrieve.ts`, in code, and no
// question here asks the model to compare the title's date with anything.)

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
  /**
   * The event's bracket titles, verbatim (`"<66,000"`, `"66,000-68,000"`, …).
   *
   * These are PRICES, not dates. Withholding them was a mistake: the model was
   * asked how well a market covers a loss while being told only the asset and
   * how many brackets there were, which is not enough to answer, so it
   * correctly scored every real market as a partial overlap and the gate
   * declined all of them.
   *
   * Optional, and only as an override for a caller holding the venue's raw
   * titles: the indexed ladder carries the same labels verbatim
   * (`Ladder.brackets[].label`), so the default needs no second source and
   * cannot drift out of step with the span the coverage check uses.
   */
  bracketLabels?: string[];
}

/** The labels shown to the model: the caller's, or the ladder's own. */
function labelsOf(candidate: FitCandidate): string[] {
  return candidate.bracketLabels ?? candidate.event.ladder.brackets.map((b) => b.label);
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
  // Low on purpose. Since `ladderCovers` decides in code whether the user's
  // levels are expressible, this Score is left one job: catching a market that
  // is the wrong THING. Measured live on jev-1.13.0, a wrong-asset candidate
  // scored 0.02 while every genuine BTC ladder scored 1.9-2.6, so the separation
  // this gate needs is wide and sits well under 1. It was 3, which nothing real
  // ever reached — every live quote was declined.
  minFitScore: 1,
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
  'No combination of this market\'s brackets relates to the loss the user described.',
  'This market is about the same subject, but its brackets cannot be combined to track the user\'s loss.',
  'A combination of brackets would partly track the loss, leaving a large gap uncovered.',
  'A combination of brackets would pay in most of the situations where the user loses money, with minor gaps.',
  'A combination of brackets would pay in exactly the situations where the user loses money.',
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
 * Describes one candidate market WITHOUT any of its time fields. The event is
 * identified to the model by the venue's own title and by the ladder it splits
 * into, because that is what the fit judgement turns on.
 *
 * The title replaced a hardcoded asset name. It had to: retrieval now indexes
 * every numeric ladder family, so there is no `underlying` to name, and "this
 * market settles on the final price of X" was a sentence only two families
 * could ever be described by. What a market is about is what the venue says it
 * is about.
 *
 * Still withheld, unchanged: `observationAt`, `endDate`, `slug` and
 * `observationNote` — every field the model would try to read as an ordered
 * quantity.
 */
function describeCandidate(candidate: FitCandidate): string {
  const { event } = candidate;
  const labels = labelsOf(candidate);
  const ladder = labels.length > 0
    ? ` The brackets are: ${labels.join('; ')}. Any combination of them can be bought together.`
    : '';
  const unit = event.ladder.unit === '' ? '' : ` Its brackets are measured in ${event.ladder.unit}.`;
  return (
    `This market is published by the venue under the title "${event.title}". It splits the outcome it ` +
    `settles on into ${event.bracketCount} separate brackets, exactly one of which pays out.${unit}${ladder}`
  );
}

/**
 * Whether this ladder can express the user's levels at all — decided in CODE.
 *
 * This is a numeric comparison, and the same rule that moved date ordering out
 * of the model applies to it: jev-1.13 reads quantities as text, so asking it
 * whether 78,000 falls inside a ladder running 66,000–84,000 swaps an exact
 * answer for a guess. Measured live, the model separated a usable ladder (2.57)
 * from an unusable one (1.91) by barely half a level, while separating the
 * WRONG ASSET decisively (0.02). So code decides the arithmetic and the model
 * is left the judgement it is actually good at.
 *
 * A level outside the traded span means no combination of these brackets pays
 * at the price the user named. That is a fact about the venue's ladder, not an
 * opinion about fit.
 *
 * The span comes straight off the parsed `Ladder` rather than from re-reading
 * the labels here. `parseLadder` already established that these brackets tile
 * an axis exactly once and what that axis runs between; a second, looser
 * reading of the same strings could disagree with the one the event was
 * indexed on, and the coverage check would then be answering about a ladder
 * nobody is quoting.
 */
function ladderCovers(levels: NamedLevel[], span: { lo: number; hi: number }): { ok: boolean; reason?: string } {
  for (const level of levels) {
    if (level.value < span.lo || level.value > span.hi) {
      return {
        ok: false,
        reason:
          `this market's brackets only split the price between ${span.lo.toLocaleString('en-US')} and ` +
          `${span.hi.toLocaleString('en-US')}, so nothing it lists pays at ${level.value.toLocaleString('en-US')}`,
      };
    }
  }
  return { ok: true };
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
        "How well could a basket built from this market's brackets cover the loss the user described?",
      criteria: FIT_LEVELS,
    };

    questions[`sourceMatch_${i}`] = {
      kind: 'boolean',
      instructions:
        `${exposureText} This market settles off the following published rule: ` +
        `"${candidate.resolutionText}" ` +
        `The market settles off the very same quantity the user is exposed to, measured the way they mean ` +
        `it — rather than something else: a different asset, a different place or instrument, a basket or ` +
        `index, or an oracle reporting another value entirely.`,
      criteria: {
        true: 'The quantity that settles this market is the one the user is exposed to, measured the way they mean it.',
        false:
          'The quantity that settles this market is something else: a different asset, a different ' +
          'place or instrument, an index or basket, or an oracle publishing another value.',
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
        `source mismatch: P(this market settles off the same quantity the user is exposed to) = ` +
          `${sourceAnswer.probability.toFixed(2)}, below ${thresholds.minSourceMatch} — it may settle off a ` +
          `different asset, a different place or instrument, an index, or an oracle. The venue lists it as ` +
          `"${candidate.event.title}"`,
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

    // Code first: a ladder that cannot express the user's levels is out
    // regardless of what the model thought of it.
    const covers = ladderCovers(exposure.levels, candidate.event.ladder.span);
    if (!covers.ok && covers.reason !== undefined) ruleFlags.push(covers.reason);

    return {
      eventId: candidate.event.eventId,
      fitScore: fitAnswer.score,
      inScope: covers.ok && fitAnswer.score >= thresholds.minFitScore,
      sourceMatch: sourceAnswer.probability,
      ruleFlags,
    };
  });

  return { fits, modelVersion };
}
