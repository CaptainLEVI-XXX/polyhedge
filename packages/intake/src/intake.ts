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
import { extractExposure, type ExtractionResult } from './exposure.js';
import { assessFit, type FitCandidate } from './fit.js';
import { parseDeadline, parseUnderlying, type NumberCandidate } from './parse.js';
import { retrieve, type IndexedEvent } from './retrieve.js';
import { selectShape } from './shape.js';
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
  | { kind: 'quoted'; record: QuoteRecord; alternatives: Alternative[]; assumptions: string[] }
  | { kind: 'follow_up'; session: IntakeSession; question: string }
  | { kind: 'no_market_listed'; furthestListed: string | null; perpAvailable: boolean }
  | { kind: 'declined'; reason: string };

export interface IntakeDeps extends QuoteDeps {
  engine: QuestionEngine;
  /** Already-indexed candidate markets. Fetching and indexing is the caller's job. */
  events: IndexedEvent[];
  /** Resolution prose per eventId, for `FitCandidate.resolutionText`. */
  resolutionTextFor(eventId: string): string;
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
      return 'Which asset are you exposed to? This hedges BTC and ETH.';
    case 'deadline':
      return 'By what date do you need this protection to run? The date is what picks the market — "by Dec 31", for example.';
    case 'deadlineStated':
      return deadline === null
        ? 'By what date do you need this protection to run?'
        : `I read your deadline as "${deadline.raw}", and I am not sure enough of that to quote on it. What date does the protection need to run to?`;
    case 'lossDirection':
      return 'Which way does the position lose money — if the price ends below a level, above a level, or outside a range? Naming the price helps.';
    case 'lossUsd':
      return 'How much money would you lose if that happened? The dollar amount is what the size of the hedge is built from, so I would rather ask than guess it from what you hold.';
    case 'threshold':
      return 'At what price does the loss start? One number is enough.';
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
  underlying: 'BTC' | 'ETH',
  followUpsAsked: number,
  calibration: CalibrationMap = IDENTITY_CALIBRATION,
): ExposureAssembly {
  const assumptions: string[] = [];

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
  const routed = route(calibratedFields, FIXED_FIELD_POLICIES, followUpsAsked);
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

    // Two numbers under one role is contradictory input. `compile` already
    // throws on two levels sharing a role, and silently overwriting
    // `lossUsd` would resize the hedge with no trace, so the first reading
    // stands and the second is named.
    const existing = placements.get(role);
    if (existing !== undefined) {
      if (existing.value !== candidate.value) conflictingRole = role;
      assumptions.push(
        `Used "${existing.raw}" as ${ROLE_WORDS[role]} and left "${candidate.raw}" ` +
          `("${candidate.context}") out: two numbers came back under the same role.`,
      );
      return;
    }

    placements.set(role, candidate);
  });

  if (conflictingRole !== undefined) {
    return { kind: 'declined', reason: `I found conflicting values for ${ROLE_WORDS[conflictingRole]}. Please restate the exposure with one value for that field.` };
  }

  const levels: NamedLevel[] = [];
  for (const role of LEVEL_ROLES) {
    const candidate = placements.get(role);
    if (candidate !== undefined) levels.push({ value: candidate.value, role });
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
  if (base.followUpsAsked >= 2) {
    return { kind: 'declined', reason: `Could not establish ${field} after two follow-ups.` };
  }
  let session: IntakeSession = { ...base, assumptions: [] };
  for (const note of assumptions) session = addAssumption(session, note);
  session = confirmAll(session, known);
  session = ask(session, field, question);
  return { kind: 'follow_up', session, question };
}

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

  // Offline, and first: an unsupported asset costs no model call to find.
  const underlying = parseUnderlying(sourceText);
  if (underlying === 'OTHER') {
    return {
      kind: 'declined',
      reason:
        'This only hedges BTC and ETH. The asset you named is listed elsewhere, and quoting it here would ' +
        'mean hedging one asset with another.',
    };
  }
  // Naming no asset is a different fact from naming an unsupported one.
  // `OTHER` means we understood the user and cannot help; `null` means we
  // did not understand them, which is a question. Declining here would
  // refuse a user who simply forgot to write "BTC".
  if (underlying === null) {
    return followUpResult(
      continued === undefined
        ? newSession(text, deps.newSessionId())
        : continued,
      [],
      { rawText: sourceText },
      'underlying',
      followUpQuestion('underlying', null),
    );
  }

  const deadline = parseDeadline(sourceText, deps.today);

  // Jev call 1.
  const extraction = await extractExposure(sourceText, deps.today, deps.engine);

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
  );

  if (assembled.kind === 'declined') {
    return { kind: 'declined', reason: assembled.reason };
  }
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

  // Dates are compared here, in code, and nowhere else.
  const retrieval = retrieve(deps.events, underlying, exposure.deadline.value);
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

  // Jev call 2.
  const selection = await selectShape(exposure, deps.engine, calibration);
  if (selection.kind === 'decline') {
    return { kind: 'declined', reason: selection.reason };
  }

  // Jev call 3 — the whole shortlist in one payload.
  const candidates: FitCandidate[] = retrieval.events.map((event) => ({
    event,
    resolutionText: deps.resolutionTextFor(event.eventId),
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
      reason:
        `None of the ${fitResult.fits.length} listed ${underlying} market(s) around ` +
        `${exposure.deadline.value} pays out closely enough to the loss you described to be worth quoting.`,
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

  const record = await quote(request, deps, options);
  const alternatives = await buildAlternatives(record, deps, options);

  return { kind: 'quoted', record, alternatives, assumptions };
}
