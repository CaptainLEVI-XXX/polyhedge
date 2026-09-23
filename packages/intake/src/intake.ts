// The whole of intake, in order: plain English in, a quote (or an honest
// refusal) out. Every other file in this package does one step; this one
// decides what happens between the steps, and it is the only place that
// knows the order.
//
// THE TRAP this file exists to avoid: a pipeline that fills in the gaps.
// Each step below can come back short — the asset is unsupported, the
// direction is unreadable, no market is listed that far out, no listed
// market covers the loss, a template needs a price the user never said. The
// tempting shape is a straight line with defaults at every joint: assume a
// hedge, assume the nearest market, assume a level, quote something. That
// produces a quote for a position the user never described, and it does it
// invisibly, because every assumption looks like a value by the time it
// reaches the record.
//
// So every gap here resolves to one of exactly four outcomes — `quoted`,
// `follow_up`, `no_market_listed`, `declined` — and the one value we DO
// default (`hedgeRatio = 1`) arrives with a written assumption naming what
// it means in the user's own words. `assumptions` is a return value, not a
// log line.
//
// Two orderings are load-bearing:
//
//   1. `parseUnderlying` runs before any model call. An unsupported asset is
//      knowable offline, and paying a round trip to learn it would be both
//      slow and a lie about where the decision came from.
//   2. The chosen market is the FIRST in-scope candidate, not the highest
//      `fitScore`. Retrieval already ordered the shortlist nearest-first
//      using real date arithmetic in code; `fitScore` is an uncalibrated
//      ordinal (see `fit.ts`), so re-ranking by it would throw away a
//      correct ordering in favour of a guess.
//
// On continuing a session: a follow-up answer is more of the user's words
// about the same exposure, so the next call re-extracts from the original
// text PLUS every answer given since, rather than patching the stored
// partial. The stored `confirmed` fields are a record of what was known when
// the question was asked; they are not replayed as fact, because a later
// answer is allowed to change an earlier reading ("no, the 60k is where I
// get out, the 8k is what I'd lose").

import {
  quote,
  quoteSession,
  type QuoteDeps,
  type QuoteOptions,
  type QuoteRecord,
  type QuoteRequest,
} from '@polyhedge/engine';
import {
  calibrate,
  IDENTITY_CALIBRATION,
  route,
  type CalibrationMap,
  type FieldPolicy,
  type QuestionEngine,
} from '@polyhedge/questions';
import { buildAlternatives, type Alternative } from './alternatives.js';
import { compile, MissingLevelError } from './compile.js';
import { extractExposure, needsPathCheck, type ExtractionResult } from './exposure.js';
import { assessFit, type FitCandidate } from './fit.js';
import { findNumbers, parseDeadline, parseUnderlying, type NumberCandidate } from './parse.js';
import { candidatesForText, retrieve, subjectWords, type IndexedEvent } from './retrieve.js';
import { selectShape, selectExtractedShape, readShapeAnswer } from './shape.js';
import {
  addAssumption,
  applyAnswer,
  ask,
  confirm,
  newSession,
  type IntakeSession,
} from './session.js';
import type { NamedLevel, Parsed, TypedExposure } from './types.js';

export type IntakeResult =
  | { kind: 'prepared'; request: QuoteRequest; exposure: TypedExposure; assumptions: string[]; options: QuoteOptions }
  | { kind: 'quoted'; record: QuoteRecord; alternatives: Alternative[]; assumptions: string[] }
  | { kind: 'follow_up'; session: IntakeSession; question: string }
  | { kind: 'no_market_listed'; furthestListed: string | null; perpAvailable: boolean }
  | { kind: 'declined'; reason: string };

export interface IntakeDeps extends QuoteDeps {
  /** Batch shape interpretation with extraction; uncertain results use the detailed fallback. */
  combinedShape?: boolean;
  /** Read back the interpreted exposure before fetching books or solving. */
  prepareOnly?: boolean;
  protectionGoal?: QuoteRequest['protectionGoal'];
  execution?: QuoteRequest['execution'];
  onTiming?: (name: string, milliseconds: number) => void;
  engine: QuestionEngine;
  /** Already-indexed candidate markets. Fetching and indexing is the caller's job. */
  events: IndexedEvent[];
  /** Resolution prose per eventId, for `FitCandidate.resolutionText`. */
  resolutionTextFor(eventId: string): string;
  /**
   * The event's bracket titles, verbatim. Fit needs the ladder's PRICES: without
   * them the model is asked to judge coverage knowing only the asset, and
   * scores every real market as a partial overlap.
   */
  bracketLabelsFor(eventId: string): string[];
  today: Date;
  newSessionId(): string;
}

/**
 * Policies for the three fixed questions `extractExposure` always asks.
 *
 * NONE OF THESE THRESHOLDS IS FITTED. `IDENTITY_CALIBRATION` is
 * `version: 'unfitted'`, so the numbers these gate are raw dispersion
 * statistics, not probabilities of being right. They are policy choices
 * about how much of a distribution must sit on one answer before we act,
 * and they are exported so a caller with labelled data can replace them
 * without editing this file.
 *
 * `isHedge` declines rather than asking again: this product covers a loss
 * the user already carries. A speculative position is not a misunderstanding
 * to be cleared up with one more question — it is a different product, and
 * re-asking would read as haggling toward a yes.
 */
export const FIXED_FIELD_POLICIES: Record<string, FieldPolicy> = {
  isHedge: { required: 'true', onFail: 'decline', threshold: 0.6 },
  deadlineStated: { required: 'true', onFail: 'follow_up', threshold: 0.6 },
  lossDirection: { required: 'any', onFail: 'follow_up', threshold: 0.6 },
};

/**
 * Minimum calibrated confidence in a number's role before that number is
 * placed on the exposure. Unfitted, for the same reason as the policies
 * above. A number placed on a weak answer becomes a strike price or a
 * payout size; leaving it out costs the user an assumption line they can
 * read and correct.
 */
export const ROLE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Intake hedges the whole stated loss. Nothing in the pipeline extracts a
 * ratio today, so this is a default — and a default that silently sizes the
 * user's position is an invented input, which is why every exposure built
 * here carries an assumption naming it in the user's own terms.
 */
const DEFAULT_HEDGE_RATIO = 1;

const DIRECTION_BY_CHOICE: Record<string, TypedExposure['direction']> = {
  loses_below_level: 'below',
  loses_above_level: 'above',
  loses_outside_range: 'outside',
};

const PLACED_ROLES = ['holding', 'loss', 'budget', 'threshold', 'range_low', 'range_high'] as const;
type PlacedRole = (typeof PLACED_ROLES)[number];

const ROLE_WORDS: Record<PlacedRole, string> = {
  holding: 'what you hold',
  loss: 'what you could lose',
  budget: 'what you can spend',
  threshold: 'the level the loss starts at',
  range_low: 'the bottom of your range',
  range_high: 'the top of your range',
};

const LEVEL_ROLES = ['threshold', 'range_low', 'range_high'] as const;

function isPlacedRole(key: string): key is PlacedRole {
  return (PLACED_ROLES as readonly string[]).includes(key);
}

/**
 * The most probable key of a calibrated distribution. Read off
 * `probabilities` rather than trusting the answer's own `choice` field,
 * because `confidence` after calibration is the mass on the winning option
 * — gating one option's confidence and then acting on a different option
 * would be gating nothing at all.
 */
function argmaxKey(probabilities: Record<string, number>): string | null {
  let best: string | null = null;
  let bestP = -Infinity;
  for (const [key, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      bestP = p;
      best = key;
    }
  }
  return best;
}

function usd(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}

/** An assumption line for a number the user said that did not make it into the hedge. */
function leftOut(candidate: NumberCandidate, why: string): string {
  return `Left the number "${candidate.raw}" ("${candidate.context}") out of the hedge because ${why}.`;
}

/**
 * The question we put to the user for a field that came back short.
 *
 * Throws on an unknown field rather than improvising a question: a field
 * reaches here only from a policy in this file or a `MissingLevelError`
 * role, so an unrecognised one means a policy was added without a question
 * to go with it, and asking something vague would hide that.
 */
function followUpQuestion(field: string, deadline: Parsed<string> | null): string {
  switch (field) {
    case 'underlying':
      return 'I could not match that to any market that is listed. What are you exposed to — the thing whose price or level you would lose on?';
    case 'deadline':
      return 'When do you need this protection? Please include the day, month and year.';
    case 'deadlineStated':
      return deadline === null
        ? 'By what date do you need this protection to run?'
        : `I read your deadline as "${deadline.raw}", and I am not sure enough of that to quote on it. What date does the protection need to run to?`;
    case 'lossDirection':
      return 'Which way does the position lose money — if the price ends below a level, above a level, or outside a range? Naming the price helps.';
    case 'lossUsd':
      return 'How much money would you lose if that happened? The dollar amount is what the size of the hedge is built from, so I would rather ask than guess it from what you hold.';
    case 'threshold':
      return 'At what measured level does the loss start? Include the unit—for example, a price in dollars or a temperature in °F or °C. For weather, also say whether you mean the daily high, low, or temperature during your event.';
    case 'range_low':
      return 'What is the lower price of the range you are comfortable inside?';
    case 'range_high':
      return 'What is the upper price of the range you are comfortable inside?';
    default:
      throw new Error(`intake: no follow-up question is written for field "${field}"`);
  }
}

/**
 * Plain-English framing for a decline, in front of the router's own reason.
 * The router's reason is precise and unreadable ("isHedge" needs P(true) >=
 * 0.6, short by 0.1400); it is kept, because a decline has to be
 * re-examinable, but it is not what the user is shown first.
 */
const DECLINE_PREAMBLE: Record<string, string> = {
  isHedge:
    'This covers a loss you already carry. What you described reads as a new position taken on a view, ' +
    'which is not something this will quote.',
};

function declineReason(field: string, reason: string): string {
  const preamble = DECLINE_PREAMBLE[field];
  return preamble === undefined ? reason : `${preamble} (${reason})`;
}

export type ExposureAssembly =
  | { kind: 'exposure'; exposure: TypedExposure; assumptions: string[] }
  | {
      kind: 'follow_up';
      field: string;
      question: string;
      /** What was already read, recorded on the session the caller builds. */
      known: Partial<TypedExposure>;
      assumptions: string[];
    }
  | { kind: 'declined'; reason: string };

/**
 * Turns one round of model answers into a `TypedExposure`, or says what is
 * still missing. This is the step with no home in any other file: every
 * other step takes a `TypedExposure` and this is where one comes from.
 *
 * Roles are deliberately NOT routed as a group. `route` picks a single
 * weakest field and asks about it, which is right for the fixed questions
 * (they describe one exposure between them) and wrong for the numbers: the
 * user said five numbers and the model read four of them clearly. Routing
 * them together would turn one unreadable number into a follow-up about the
 * whole message, or worse, let a confident reading of "$8,000" ride on the
 * model's shrug at "2". So each number is gated on its own confidence and
 * simply not placed when it falls short, with an assumption naming the raw
 * text that was ignored.
 */
export function assembleExposure(
  text: string,
  extraction: ExtractionResult,
  deadline: Parsed<string> | null,
  underlying: string,
  followUpsAsked: number,
  calibration: CalibrationMap = IDENTITY_CALIBRATION,
  clarifications: { field: string; answer: string }[] = [],
): ExposureAssembly {
  const assumptions: string[] = [];
  if (needsPathCheck(text)) {
    const raw = extraction.answers['settlementBasis'];
    const answer = raw && calibrate(raw, calibration);
    const basis = answer?.kind === 'choice' ? argmaxKey(answer.probabilities) ?? answer.choice : null;
    if (answer?.kind === 'choice' && answer.confidence >= ROLE_CONFIDENCE_THRESHOLD && basis === 'path') {
      return { kind: 'declined', reason: 'This payment depends on an intermediate touch or crossing. A basket settling only on the final outcome cannot reproduce it, even if the price later recovers.' };
    }
    if (answer?.kind !== 'choice' || answer.confidence < ROLE_CONFIDENCE_THRESHOLD || basis !== 'final') {
      return { kind: 'follow_up', field: 'settlementBasis',
        question: 'Should protection pay only from the final observed outcome, or as soon as a level is touched even if it later recovers?',
        known: { rawText: text, underlying }, assumptions };
    }
  }

  // No date in the text at all means `deadlineStated` was never asked, so
  // there is no answer for `route` to read. Routing it anyway would decline
  // for "no answer for required field", which is true and useless: the user
  // simply has not said when, and that is a question, not a refusal.
  if (deadline === null) {
    return {
      kind: 'follow_up',
      field: 'deadline',
      question: followUpQuestion('deadline', null),
      known: { rawText: text, underlying },
      assumptions,
    };
  }

  const calibratedFields = Object.fromEntries(
    Object.keys(FIXED_FIELD_POLICIES).flatMap((key) => {
      const answer = extraction.answers[key];
      return answer === undefined ? [] : [[key, calibrate(answer, calibration)]];
    }),
  );
  const routed = route(calibratedFields, FIXED_FIELD_POLICIES, followUpsAsked, 20);
  if (routed.kind === 'decline') {
    return { kind: 'declined', reason: declineReason(routed.field, routed.reason) };
  }
  if (routed.kind === 'follow_up') {
    return {
      kind: 'follow_up',
      field: routed.field,
      question: followUpQuestion(routed.field, deadline),
      known: { rawText: text, underlying, deadline },
      assumptions,
    };
  }

  const placements = new Map<PlacedRole, NumberCandidate>();
  const corrected = new Set<PlacedRole>();
  const latest = new Map(clarifications.map(a => [a.field, a.answer.trim()]));
  for (const [field, answer] of latest) {
    const role = field === 'lossUsd' ? 'loss' : field === 'budgetUsd' ? 'budget'
      : field === 'holdingUsd' ? 'holding' : field;
    if (!isPlacedRole(role)) continue;
    const numbers = findNumbers(answer);
    // Only a single, explicit numeric answer to our field-specific question
    // replaces earlier values. Free prose still goes through interpretation.
    if (numbers.length !== 1 || numbers[0]!.raw !== answer.replace(/\s*(°\s*[CF]|degrees?\s+(?:Fahrenheit|Celsius)|Fahrenheit|Celsius|%|bps)$/i, '').trim() || !Number.isFinite(numbers[0]!.value)) continue;
    placements.set(role, { ...numbers[0]!, context: `Explicit answer for ${field}: ${answer}` });
    corrected.add(role);
  }
  let conflictingRole: PlacedRole | undefined;

  extraction.candidates.forEach((candidate, i) => {
    const id = `role_${i}`;
    const raw = extraction.answers[id];
    if (raw === undefined || raw.kind !== 'choice') {
      assumptions.push(leftOut(candidate, 'no readable role came back for it'));
      return;
    }

    const answer = calibrate(raw, calibration);
    if (answer.kind !== 'choice') {
      throw new Error(`assembleExposure: calibration returned kind '${answer.kind}' for "${id}"`);
    }

    if (answer.confidence < ROLE_CONFIDENCE_THRESHOLD) {
      assumptions.push(
        leftOut(
          candidate,
          `it was not clear what it referred to (confidence ${answer.confidence.toFixed(2)}, ` +
            `below ${ROLE_CONFIDENCE_THRESHOLD})`,
        ),
      );
      return;
    }

    const role = argmaxKey(answer.probabilities) ?? answer.choice;
    if (role === 'unrelated') return;
    if (!isPlacedRole(role)) {
      assumptions.push(leftOut(candidate, `it came back under an unrecognised role "${role}"`));
      return;
    }
    if (corrected.has(role)) return;

    // Two numbers under one role is contradictory input. `compile` already
    // throws on two levels sharing a role, and silently overwriting
    // `lossUsd` would resize the hedge with no trace, so the first reading
    // stands and the second is named.
    const existing = placements.get(role);
    if (existing !== undefined) {
      if (existing.value !== candidate.value || (existing.unit && candidate.unit && existing.unit !== candidate.unit)) conflictingRole = role;
      if (existing.value === candidate.value && existing.unit === undefined && candidate.unit !== undefined) {
        placements.set(role, candidate);
      }
      assumptions.push(
        `Used "${existing.raw}" as ${ROLE_WORDS[role]} and left "${candidate.raw}" ` +
          `("${candidate.context}") out: two numbers came back under the same role.`,
      );
      return;
    }

    placements.set(role, candidate);
  });

  if (conflictingRole !== undefined) {
    const field = conflictingRole === 'loss' ? 'lossUsd' : conflictingRole === 'budget' ? 'budgetUsd'
      : conflictingRole === 'holding' ? 'holdingUsd' : conflictingRole;
    return { kind: 'follow_up', field,
      question: `I found different values for ${ROLE_WORDS[conflictingRole]}. Which single value should I use?`,
      known: { rawText: text, underlying, deadline }, assumptions: [] };
  }

  const levels: NamedLevel[] = [];
  for (const role of LEVEL_ROLES) {
    const candidate = placements.get(role);
    if (candidate !== undefined) levels.push({ value: candidate.value, role, ...(candidate.unit ? { unit: candidate.unit } : {}) });
  }

  const directionAnswerRaw = extraction.answers['lossDirection'];
  if (directionAnswerRaw === undefined || directionAnswerRaw.kind !== 'choice') {
    throw new Error("assembleExposure: \"lossDirection\" did not come back as a choice answer");
  }
  const directionAnswer = calibrate(directionAnswerRaw, calibration);
  if (directionAnswer.kind !== 'choice') {
    throw new Error('assembleExposure: calibration returned a non-choice for "lossDirection"');
  }
  const directionKey = argmaxKey(directionAnswer.probabilities) ?? directionAnswer.choice;
  const direction = DIRECTION_BY_CHOICE[directionKey];
  if (direction === undefined) {
    throw new Error(
      `assembleExposure: "lossDirection" chose "${directionKey}", which is not one of ` +
        `${Object.keys(DIRECTION_BY_CHOICE).join(', ')}`,
    );
  }

  const holding = placements.get('holding');
  const budget = placements.get('budget');
  const loss = placements.get('loss');

  // `lossUsd` is the one number with no defensible default. It sizes the
  // payout, and the obvious fallback — take the holding — is a different
  // quantity: someone holding $200,000 of BTC who can afford to lose
  // $8,000 of it would be sold a hedge twenty-five times the size they
  // asked for.
  if (loss === undefined) {
    return {
      kind: 'follow_up',
      field: 'lossUsd',
      question: followUpQuestion('lossUsd', deadline),
      known: {
        rawText: text,
        underlying,
        deadline,
        direction,
        levels,
        ...(holding !== undefined ? { holdingUsd: parsedFrom(holding) } : {}),
        ...(budget !== undefined ? { budgetUsd: parsedFrom(budget) } : {}),
      },
      assumptions,
    };
  }

  assumptions.push(
    `Assumed you want to cover the full ${usd(loss.value)} ("${loss.raw}") you said you could lose, ` +
      'not part of it.',
  );
  if (deadline.provenance === 'inferred') {
    assumptions.push(`Assuming "${deadline.raw}" means ${deadline.value}; the year was not stated.`);
  }

  const exposure: TypedExposure = {
    rawText: text,
    underlying,
    ...(holding !== undefined ? { holdingUsd: parsedFrom(holding) } : {}),
    lossUsd: parsedFrom(loss),
    ...(budget !== undefined ? { budgetUsd: parsedFrom(budget) } : {}),
    hedgeRatio: DEFAULT_HEDGE_RATIO,
    direction,
    levels,
    deadline,
    followUpsAsked,
  };

  return { kind: 'exposure', exposure, assumptions };
}

/** A number the user wrote, kept with the words they wrote it in. */
function parsedFrom(candidate: NumberCandidate): Parsed<number> {
  return { value: candidate.value, provenance: 'stated', raw: candidate.raw };
}

function confirmAll(session: IntakeSession, known: Partial<TypedExposure>): IntakeSession {
  let out = session;
  for (const key of Object.keys(known) as (keyof TypedExposure)[]) {
    const value = known[key];
    if (value === undefined) continue;
    out = confirm(out, key, value);
  }
  return out;
}

/**
 * The session a follow-up hands back. Assumptions are REPLACED rather than
 * appended to, because every round re-derives them from the full text: a
 * second round that appends would show the user the same line twice, and
 * one that kept a stale line would show them an assumption their answer has
 * since overturned.
 */
function followUpResult(
  base: IntakeSession,
  assumptions: string[],
  known: Partial<TypedExposure>,
  field: string,
  question: string,
): IntakeResult {
  if (base.followUpsAsked >= 20) {
    return { kind: 'declined', reason: `We still need more detail to build this protection. Please start a new description with the exposure, date and potential loss.` };
  }
  let session: IntakeSession = { ...base, assumptions: [] };
  for (const note of assumptions) session = addAssumption(session, note);
  session = confirmAll(session, known);
  session = ask(session, field, question);
  return { kind: 'follow_up', session, question: reAsk(base, field, question) };
}

/**
 * Asking the same thing twice, without pretending nothing was said.
 *
 * Repeating a question verbatim after the user has answered it is the single
 * most broken-looking thing an intake can do — it reads as the product having
 * ignored them, when in fact their answer simply did not parse. It also gives
 * them nothing to go on, so the natural response is to retype the same words
 * and get the same result.
 *
 * So a second ask names what was not readable and shows a form that works.
 */
function reAsk(base: IntakeSession, field: string, question: string): string {
  const previous = base.answers.filter((a) => a.field === field).at(-1);
  if (previous === undefined) return question;
  return `I could not read ${DESCRIPTIONS[field] ?? 'that'} in “${previous.answer}”. ${question}`;
}

const DESCRIPTIONS: Record<string, string> = {
  deadline: 'a date',
  deadlineStated: 'a date',
  underlying: 'anything this venue lists',
  lossUsd: 'an amount',
  budgetUsd: 'an amount',
  threshold: 'a price',
  range_low: 'a price',
  range_high: 'a price',
  lossDirection: 'which way the position loses',
};

/**
 * The model version recorded on the quote.
 *
 * All three calls go to the same engine and normally answer with the same
 * version. If they do not, the engine changed mid-pipeline, and recording
 * one of them would attribute the whole quote to a model that produced part
 * of it — so a disagreement is written out in full. `QuoteOptions` defaults
 * this field to `'unknown'`, which is the same lie told more quietly.
 */
function resolveModelVersion(versions: string[]): string {
  const distinct = [...new Set(versions)];
  return distinct.length === 1 ? distinct[0]! : distinct.join('+');
}

export async function intake(
  text: string,
  deps: IntakeDeps,
  session?: IntakeSession,
  calibration: CalibrationMap = IDENTITY_CALIBRATION,
): Promise<IntakeResult> {
  // Continuing: `text` is the answer to the pending question, not a new
  // exposure. `applyAnswer` records it and counts the round, which is what
  // `route` caps follow-ups against.
  const continued = session === undefined ? undefined : applyAnswer(session, text);

  const sourceText =
    continued === undefined
      ? text
      : [continued.originalText, ...continued.answers.map((a) => {
          const fields: Record<string, string> = {
            lossUsd: 'The amount I could lose', budgetUsd: 'My maximum protection budget',
            threshold: 'The price threshold', range_low: 'The lower price bound',
            range_high: 'The upper price bound', underlying: 'The asset I hold',
            lossDirection: 'The direction in which I lose',
          };
          if (a.field === 'deadline' || a.field === 'deadlineStated') {
            const previous = parseDeadline(continued.originalText, deps.today);
            const answer = /^\d{4}$/.test(a.answer.trim()) && previous
              ? `${previous.raw.replace(/\s+\d{4}$/, '')} ${a.answer.trim()}` : a.answer;
            return `My deadline is by ${answer.replace(/^by\s+/i, '')}.`;
          }
          return `${fields[a.field] ?? a.field}: ${a.answer}.`;
        })].join(' ');

  // Offline, and first. There is no allow-list any more — the engine prices any
  // ladder the venue publishes — so the question is no longer "is this BTC or
  // ETH" but "do we list anything that could be about this at all". That is a
  // word match against already-indexed events, so it still costs no model call,
  // which is the property the old asset gate was really protecting.
  //
  // It asks rather than declines. Matching is lexical, so an empty result means
  // either the user named nothing or they named it differently from the venue —
  // and those are not distinguishable here, so the honest move is a question.
  const listed = candidatesForText(sourceText, deps.events);
  if (listed.length === 0) {
    return followUpResult(
      continued === undefined ? newSession(text, deps.newSessionId()) : continued,
      [],
      { rawText: sourceText },
      'underlying',
      followUpQuestion('underlying', null),
    );
  }
  const underlying = subjectWords(sourceText).slice(0, 3).join(' ');

  const deadline = parseDeadline(sourceText, deps.today);

  if (deadline === null && !needsPathCheck(sourceText)) {
    return followUpResult(continued ?? newSession(text, deps.newSessionId()), [],
      { rawText: sourceText, underlying }, 'deadline', followUpQuestion('deadline', null));
  }

  // Jev call 1.
  const extraction = await extractExposure(sourceText, deps.today, deps.engine, deps.combinedShape);

  // A continued session keeps its id and its original words; only a fresh
  // one draws an id, so `newSessionId` is a reliable count of conversations
  // rather than of rounds.
  const base: IntakeSession =
    continued === undefined
      ? newSession(text, deps.newSessionId(), extraction.modelVersion)
      : { ...continued, jevModelVersion: extraction.modelVersion };

  const assembled = assembleExposure(
    sourceText,
    extraction,
    deadline,
    underlying,
    base.followUpsAsked,
    calibration,
    continued?.answers,
  );

  if (assembled.kind === 'declined') return { kind: 'declined', reason: assembled.reason };
  if (assembled.kind === 'follow_up') {
    return followUpResult(
      base,
      assembled.assumptions,
      assembled.known,
      assembled.field,
      assembled.question,
    );
  }

  const { exposure, assumptions } = assembled;

  // Two filters, in order, both in code. `candidatesForText` narrows hundreds of
  // ladders to the ones plausibly about this subject; `retrieve` then does every
  // date comparison. Neither asks the model anything.
  const retrieval = retrieve(listed, exposure.deadline.value);
  if (retrieval.kind === 'no_market_listed') {
    return {
      kind: 'no_market_listed',
      // Straight through, `null` included: "nothing is listed at all" is a
      // real state, and naming some other date instead would be a lie.
      furthestListed: retrieval.furthestListed,
      // Perps are outside these three stages. A perpetual-funding hedge is a different
      // instrument with a different failure mode, and stubbing a lookup
      // that does not exist would read as "considered and unavailable".
      perpAvailable: false,
    };
  }

  if (exposure.levels.length === 0) {
    if (deps.combinedShape && extraction.answers.priceTemplate?.kind === 'choice') {
      const shape = readShapeAnswer(exposure, extraction.answers, extraction.modelVersion, calibration);
      if (shape.kind === 'decline' && !shape.clarify) return { kind: 'declined', reason: shape.reason };
    }
    return followUpResult(base, assumptions, exposure, 'threshold', followUpQuestion('threshold', deadline));
  }

  if (/\b(temperature|fahrenheit|celsius|degrees?|cold|hot|daily high|daily low)\b|°[CF]/i.test(sourceText)
    && exposure.levels.some(level => level.unit !== '°F' && level.unit !== '°C')) {
    return followUpResult(base, assumptions, exposure, 'threshold',
      'What temperature triggers the loss, in °F or °C? Also specify the daily high, daily low, or temperature during your event.');
  }

  // Jev call 2.
  const selection = deps.combinedShape
    ? await selectExtractedShape(exposure, extraction, deps.engine, calibration)
    : await selectShape(exposure, deps.engine, calibration);
  if (selection.kind === 'decline') {
    if (selection.clarify) return followUpResult(base, assumptions, exposure, 'payoutShape', selection.reason);
    return { kind: 'declined', reason: selection.reason };
  }

  // Validate required levels before paying for market-fit interpretation.
  try { compile(exposure, selection.templateId, { eventId: 'validation' }); }
  catch (error) {
    if (error instanceof MissingLevelError) {
      return followUpResult(base, assumptions, exposure, error.field, followUpQuestion(error.field, deadline));
    }
    throw error;
  }

  // Jev call 3 — the whole shortlist in one payload.
  const candidates: FitCandidate[] = retrieval.events.map((event) => ({
    event,
    resolutionText: deps.resolutionTextFor(event.eventId),
    bracketLabels: deps.bracketLabelsFor(event.eventId),
  }));
  const fitResult = await assessFit(
    exposure,
    selection.templateId,
    candidates,
    deps.engine,
    calibration,
  );

  // First in scope, not best fit. `fits` preserves retrieval's nearest-first
  // order, and `fitScore` is an uncalibrated ordinal used only as a gate.
  const chosenIndex = fitResult.fits.findIndex((fit) => fit.inScope);
  if (chosenIndex === -1) {
    return {
      kind: 'declined',
      reason: 'I could not find a suitable numeric market in the current index for this loss. The candidates did not match the measured outcome, units, or required levels.',
    };
  }
  const chosenFit = fitResult.fits[chosenIndex]!;
  const chosenEvent = candidates[chosenIndex]!.event;
  if (chosenFit.eventId !== chosenEvent.eventId) {
    throw new Error(
      `intake: fit ${chosenIndex} reports event "${chosenFit.eventId}" but candidate ${chosenIndex} is ` +
        `"${chosenEvent.eventId}" — the fit results are not in the order they were asked in`,
    );
  }

  const options: QuoteOptions = {
    ruleFlags: chosenFit.ruleFlags,
    calibrationMapVersion: calibration.version,
    jevModelVersion: resolveModelVersion([
      extraction.modelVersion,
      selection.modelVersion,
      fitResult.modelVersion,
    ]),
  };

  let request: QuoteRequest;
  if ((selection.templateId === 'range_protect') !== (exposure.direction === 'outside')) {
    return { kind: 'declined', reason: 'The requested payout shape and loss direction disagree. Please clarify when the protection should pay.' };
  }
  try {
    request = compile(exposure, selection.templateId, chosenEvent);
    if (deps.protectionGoal) request = { ...request, protectionGoal: deps.protectionGoal };
    if (deps.execution) request = { ...request, execution: deps.execution };
  } catch (err) {
    // A template that needs a price the user never said is one question,
    // not a crash and not a default.
    if (err instanceof MissingLevelError) {
      return followUpResult(
        base,
        assumptions,
        exposure,
        err.field,
        followUpQuestion(err.field, deadline),
      );
    }
    throw err;
  }

  if (deps.prepareOnly) return { kind: 'prepared', request, exposure, assumptions, options };

  const pinned = quoteSession(deps);
  const quoteStarted = performance.now();
  const record = await quote(request, pinned, options);
  deps.onTiming?.('primaryQuote', performance.now() - quoteStarted);
  // Loss-based options keep the original target. Weakening it would change
  // the objective and cannot be ranked as an improvement in remaining loss.
  const alternatives = request.protectionGoal ? [] : await buildAlternatives(record, pinned, options);

  return { kind: 'quoted', record, alternatives, assumptions };
}
