// Jev call 2: which price template describes the loss the user just
// described in their own words.
//
// This is one `choice` question, not a classifier chain, because the four
// price templates are mutually exclusive descriptions of the SAME thing —
// the shape of the payoff the user wants — and a single distribution over
// them is the only form that lets us see the runner-up and the spread.
//
// The choice offers the four price templates plus `none_fit`, and nothing
// else. `binary_protect` and `categorical_exclude` are deliberately NOT
// offered: nothing downstream can compile a categorical template against a
// price bracket state space (see `targetVector` in @polyhedge/core, which
// throws when a price shape meets a categorical state space and vice
// versa). Offering a template that is guaranteed to fail late is strictly
// worse than declining early, so the model is never given the chance to
// pick one.
//
// `none_fit` exists for the same reason. A five-way choice where one option
// is "none of these" lets the model say so directly; without it, the
// probability mass for an unsupported exposure has nowhere to go but onto
// whichever supported template looks least wrong, and we would ship a hedge
// for a payoff the user never asked for.

import {
  calibrate,
  IDENTITY_CALIBRATION,
  route,
  type Answer,
  type CalibrationMap,
  type FieldPolicy,
  type Question,
  type QuestionEngine,
} from '@polyhedge/questions';
import type { TemplateId } from '@polyhedge/core';
import type { NamedLevel, TypedExposure } from './types.js';

export type PriceTemplateId = 'threshold_digital' | 'tail_only' | 'range_protect' | 'linear_strip';

/**
 * The templates a user can be asked to pick between. `tail_only` is
 * deliberately not one of them.
 *
 * It is representable — `compile` builds one and `alternatives` offers one
 * as `cheaper_tail` — but it is IDENTICAL to `threshold_digital` in core:
 * `levelsOf` and `payoutAt` treat the two the same, so the only thing that
 * differs is the strike the user names, which is already a level we read
 * from them. Offering both asks the model to guess a distinction that
 * nothing downstream can represent, and measurably costs confidence: on a
 * crash-protection exposure, jev-1.13.0 put 0.15 on `tail_only` and still
 * chose `threshold_digital`; removing the option raised confidence on that
 * same text from 0.68 to 0.77. Splitting mass between two options that
 * compile to the same basket only pushes borderline cases under the
 * decline threshold.
 *
 * `tail_only` stays an OUTPUT of the alternatives layer — "here is a
 * further-out strike, for less money and less cover" — which is a choice
 * the user makes against real prices rather than a reading of their words.
 */
export type SelectableTemplateId = Exclude<PriceTemplateId, 'tail_only'>;

// Compile-time proof that every id offered here is a real core template id.
// If `TemplateId` is ever renamed or narrowed, this stops building rather
// than producing a `TargetShape` the compiler cannot construct.
// The tuple wrap is load-bearing: a bare conditional would distribute over
// the union and a failing member would vanish into `never` inside a union
// that still resolves to `true`.
type _PriceTemplateIdsAreTemplateIds = [PriceTemplateId] extends [TemplateId] ? true : never;
const _priceTemplateIdsAreTemplateIds: _PriceTemplateIdsAreTemplateIds = true;
void _priceTemplateIdsAreTemplateIds;

export type ShapeSelection =
  | { kind: 'template'; templateId: SelectableTemplateId; confidence: number; modelVersion: string }
  | { kind: 'decline'; reason: string; modelVersion: string };

/** The one question id this call asks under. */
export const SHAPE_QUESTION_ID = 'priceTemplate';

/** The "none of the supported shapes" option. Not a template id. */
export const NONE_FIT_KEY = 'none_fit';

/**
 * Minimum calibrated confidence in the winning template before we act on
 * it. Not fitted — `IDENTITY_CALIBRATION` is unfitted, so this is a policy
 * choice about how much of the distribution must sit on one option, not a
 * calibrated probability of being right. Overridable by the caller.
 */
export const SHAPE_CONFIDENCE_THRESHOLD = 0.6;

// Payoff descriptions, in the user's terms. These are what the model reads,
// so they describe what the user would FEEL — when money arrives and how
// much — never our internal vocabulary ("digital", "strip", "tail"). A
// criterion written in our jargon asks the model to know our codebase.
const TEMPLATE_CRITERIA: Record<string, string> = {
  threshold_digital:
    'Pays a fixed amount whenever the price ends below (or above) one level, and nothing otherwise. ' +
    'One level, one all-or-nothing payment, the same size however far past the level the price ends.',
  range_protect:
    'Pays whenever the price ends outside a two-sided range — either below the lower level or above the ' +
    'upper one. The user is comfortable while the price stays between the two levels and loses on a move ' +
    'out of that band in either direction.',
  linear_strip:
    'The loss grows steadily between two levels rather than switching on at one. A small move past the ' +
    'first level costs a little, a move all the way to the second level costs the full amount, and ' +
    'amounts in between are proportional.',
  [NONE_FIT_KEY]:
    'None of the above describes this loss. The payoff the user wants is some other shape, or what they ' +
    'described is not a loss on the price of the asset at all.',
};

const ROLE_WORDS: Record<NamedLevel['role'], string> = {
  threshold: 'a single level the position loses past',
  range_low: 'the lower bound of a range',
  range_high: 'the upper bound of a range',
};

/**
 * Describes the levels the user gave, with the role each was assigned.
 * Only levels that are actually present are listed — an absent second level
 * is a fact about what the user said, and inventing one would push the model
 * toward the two-level templates for free.
 */
function describeLevels(levels: NamedLevel[]): string {
  if (levels.length === 0) {
    return 'The user named no price levels.';
  }
  const parts = levels.map((level) => `${level.value} (${ROLE_WORDS[level.role]})`);
  return `The price levels the user gave, with the role each plays: ${parts.join('; ')}.`;
}

/**
 * Builds the single question this call asks. Exported separately from
 * `selectShape` so a test can inspect the exact payload rather than trusting
 * that what reached the model matched what we meant to send.
 *
 * The instructions quote `exposure.rawText` verbatim. Only the user's own
 * words go into the prompt — never a value they did not state — for the same
 * reason `Parsed.raw` exists: confirming a number back to the model that the
 * user never uttered scores high for the wrong reason.
 */
export function buildShapeQuestion(exposure: TypedExposure): Record<string, Question> {
  return {
    [SHAPE_QUESTION_ID]: {
      kind: 'choice',
      instructions:
        `The user described their position in their own words: "${exposure.rawText}". ` +
        `${describeLevels(exposure.levels)} ` +
        'Which description below matches the payoff that would make this user whole?',
      criteria: TEMPLATE_CRITERIA,
    },
  };
}

function isSelectableTemplateId(key: string): key is SelectableTemplateId {
  return key === 'threshold_digital' || key === 'range_protect' || key === 'linear_strip';
}

/**
 * Picks the price template for an exposure with exactly one `engine.ask`.
 *
 * Decision order matters and is fixed, so that the decline reason is
 * accurate rather than merely true:
 *
 *   1. Route first. A distribution too flat to act on is a DIFFERENT
 *      failure from a confident "none of these fit", and the user deserves
 *      to be told which one happened. Deciding `none_fit` first would
 *      report "no supported shape matches" for an answer that was really
 *      just an unreadable smear across all four options.
 *   2. Then `none_fit`, which at this point is known to be confident.
 *   3. Otherwise, a template.
 *
 * `modelVersion` is carried on BOTH branches. A decline is still a fact
 * produced by a specific model version, and calibration is version-specific
 * — a decline with no version attached cannot be re-examined later.
 */
export async function selectShape(
  exposure: TypedExposure,
  engine: QuestionEngine,
  calibration: CalibrationMap = IDENTITY_CALIBRATION,
  threshold: number = SHAPE_CONFIDENCE_THRESHOLD,
): Promise<ShapeSelection> {
  const questions = buildShapeQuestion(exposure);
  const { answers, modelVersion } = await engine.ask(exposure.rawText, questions);

  const raw: Answer | undefined = answers[SHAPE_QUESTION_ID];
  if (raw === undefined) {
    throw new Error(`selectShape: no answer for question "${SHAPE_QUESTION_ID}"`);
  }
  if (raw.kind !== 'choice') {
    throw new Error(
      `selectShape: "${SHAPE_QUESTION_ID}" came back as kind '${raw.kind}', expected 'choice'`,
    );
  }
  if (!isSelectableTemplateId(raw.choice) && raw.choice !== NONE_FIT_KEY) {
    throw new Error(
      `selectShape: "${SHAPE_QUESTION_ID}" chose "${raw.choice}", which is not one of the offered options ` +
        `(${Object.keys(TEMPLATE_CRITERIA).join(', ')})`,
    );
  }

  // Calibrate before anything is decided: both the routing threshold and
  // the reported confidence must read the same, post-calibration
  // distribution, or the number we return is not the number we gated on.
  const answer = calibrate(raw, calibration);
  if (answer.kind !== 'choice') {
    throw new Error(`selectShape: calibration returned kind '${answer.kind}' for a choice answer`);
  }

  // `required: 'any'` because a choice answer has no true/false direction —
  // `route` throws on anything else for a non-boolean answer.
  const policy: FieldPolicy = { required: 'any', onFail: 'decline', threshold };
  const routed = route({ [SHAPE_QUESTION_ID]: answer }, { [SHAPE_QUESTION_ID]: policy }, exposure.followUpsAsked);

  if (routed.kind === 'decline') {
    return { kind: 'decline', reason: routed.reason, modelVersion };
  }

  if (answer.choice === NONE_FIT_KEY) {
    return {
      kind: 'decline',
      reason:
        'none of the supported price shapes matches this exposure: the payoff the user described is not a ' +
        'fixed payment past one level, a range, or a loss growing steadily between two levels',
      modelVersion,
    };
  }

  if (!isSelectableTemplateId(answer.choice)) {
    throw new Error(`selectShape: unreachable — unvalidated choice "${answer.choice}"`);
  }

  return {
    kind: 'template',
    templateId: answer.choice,
    confidence: answer.confidence,
    modelVersion,
  };
}
