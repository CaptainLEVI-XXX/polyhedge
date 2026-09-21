// The last step of intake: an exposure, a chosen template and a chosen
// market become the `QuoteRequest` the engine solves. Pure — no model, no
// network, no clock. Every question has already been asked by the time
// anything reaches here, so this file's only job is to refuse to guess.
//
// Three traps it exists to avoid:
//
//   1. Reading levels by position. `TypedExposure.levels` is an array, and
//      the order in it is the order the user happened to SAY the numbers
//      in — "I'm fine between 80k and 60k" states the high number first.
//      Roles were assigned deliberately, one Jev call ago, precisely so
//      that position never has to mean anything; taking `levels[0]` as the
//      low bound would silently invert a range and hedge the wrong band.
//      Every level here is fetched by role, and the two-level templates
//      sort their pair into ascending order afterwards.
//
//   2. Reconciling a direction/template contradiction. `range_protect`
//      only makes sense for a loss that is `outside` a band; the other
//      three only for a loss past one level. If shape selection and
//      extraction disagree, two separate model calls have come back with
//      incompatible readings of the user's own position, and neither is
//      privileged. Picking one and proceeding would hedge a position the
//      user never described, and would do it invisibly. It throws instead.
//
//   3. Inventing a missing price. A template that needs a level the user
//      never gave is a follow-up question, not a default. `MissingLevelError`
//      names the field so the caller can ask for exactly that number, and
//      nothing here derives one level from another or falls back to a
//      round number.

import type { TargetShape } from '@polyhedge/core';
import type { QuoteRequest } from '@polyhedge/engine';
import type { IndexedEvent } from './retrieve.js';
import type { PriceTemplateId } from './shape.js';
import type { LevelRole, TypedExposure } from './types.js';

/**
 * A template needs a price level the user never stated. `field` is the
 * role that is missing, so the caller can raise one specific follow-up
 * rather than re-asking for everything.
 */
export class MissingLevelError extends Error {
  readonly field: LevelRole;

  constructor(field: LevelRole, message: string) {
    super(message);
    this.name = 'MissingLevelError';
    this.field = field;
  }
}

/**
 * The one level carrying `role`, or `undefined` if the user never gave it.
 *
 * Two levels under one role is contradictory input, not a tie to break:
 * the user gave two different numbers for the same bound, and any choice
 * between them would be arbitrary. It throws naming the role.
 */
function levelFor(exposure: TypedExposure, role: LevelRole): number | undefined {
  const matches = exposure.levels.filter((level) => level.role === role);
  if (matches.length > 1) {
    throw new Error(
      `compile: the exposure gives ${matches.length} levels for role "${role}" ` +
        `(${matches.map((m) => m.value).join(', ')}); exactly one is required`,
    );
  }
  return matches[0]?.value;
}

function requireLevel(exposure: TypedExposure, role: LevelRole, templateId: PriceTemplateId): number {
  const value = levelFor(exposure, role);
  if (value === undefined) {
    throw new MissingLevelError(
      role,
      `compile: template "${templateId}" needs a "${role}" level and the exposure has none`,
    );
  }
  return value;
}

/**
 * Narrows the exposure's loss direction for the single-sided templates.
 * `outside` here means shape selection read a two-sided loss where
 * extraction read a one-sided one; the message names both readings so the
 * disagreement is legible without re-running either call.
 */
function oneSidedDirection(exposure: TypedExposure, templateId: PriceTemplateId): 'below' | 'above' {
  if (exposure.direction === 'outside') {
    throw new Error(
      `compile: template "${templateId}" pays past a single level, but the exposure's loss direction is ` +
        `"outside" (a two-sided range); shape selection and extraction disagree about the user's position`,
    );
  }
  return exposure.direction;
}

/** The two bounds of a range, by role, sorted ascending whatever order they were stated in. */
function ascendingBounds(exposure: TypedExposure, templateId: PriceTemplateId): [number, number] {
  const low = requireLevel(exposure, 'range_low', templateId);
  const high = requireLevel(exposure, 'range_high', templateId);
  return low <= high ? [low, high] : [high, low];
}

function buildShape(
  exposure: TypedExposure,
  templateId: PriceTemplateId,
  payoutUsd: number,
): TargetShape {
  switch (templateId) {
    case 'threshold_digital':
    case 'tail_only':
      return {
        templateId,
        payoutUsd,
        direction: oneSidedDirection(exposure, templateId),
        k: requireLevel(exposure, 'threshold', templateId),
      };

    case 'linear_strip': {
      const direction = oneSidedDirection(exposure, templateId);
      const [k1, k2] = ascendingBounds(exposure, templateId);
      return { templateId, payoutUsd, direction, k1, k2 };
    }

    case 'range_protect': {
      if (exposure.direction !== 'outside') {
        throw new Error(
          `compile: template "range_protect" pays outside a two-sided range, but the exposure's loss ` +
            `direction is "${exposure.direction}" (one level, one side); shape selection and extraction ` +
            `disagree about the user's position`,
        );
      }
      const [low, high] = ascendingBounds(exposure, templateId);
      return { templateId, payoutUsd, low, high };
    }
  }
}

/**
 * Assembles the quote request. `payoutUsd` is the loss scaled by the hedge
 * ratio — a partial hedge is a smaller payout on the same shape, never a
 * different shape.
 *
 * `budgetUsd` and `observationNote` are spread in only when they exist:
 * under `exactOptionalPropertyTypes`, "absent" and "present and undefined"
 * are different types, and the engine reads a present `budgetUsd` as a real
 * cap (`dollarsToCents`) while an absent one means unconstrained.
 */
export function compile(
  exposure: TypedExposure,
  templateId: PriceTemplateId,
  candidate: Pick<IndexedEvent, 'eventId' | 'observationNote'>,
): QuoteRequest {
  const payoutUsd = exposure.lossUsd.value * exposure.hedgeRatio;

  return {
    eventId: candidate.eventId,
    shape: buildShape(exposure, templateId, payoutUsd),
    ...(exposure.budgetUsd !== undefined ? { budgetUsd: exposure.budgetUsd.value } : {}),
    ...(candidate.observationNote !== undefined
      ? { observationNote: candidate.observationNote }
      : {}),
  };
}
