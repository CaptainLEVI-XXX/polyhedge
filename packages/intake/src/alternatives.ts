// Alternatives to a quoted hedge, each scored against the hedge the user
// actually asked for rather than against itself.
//
// THE TRAP this file exists to avoid:
//
//   Every `QuoteRecord` carries a residual, and that residual is always
//   self-referential: it measures a basket against the target that basket
//   was solved for. That is exactly right for the primary quote and exactly
//   wrong for an alternative. A `cheaper_tail` re-solved at a further strike
//   solves ITS OWN, weaker, target perfectly, so
//   `record.basket.residual.coverageRatio` reads ~1.0 for strictly less
//   protection than the user asked for. Shown next to the primary, the worse
//   hedge reads as the better one — in the single field this product claims
//   to be honest about.
//
//   So every `Alternative` carries `residualVsPrimary`: that alternative's
//   own payout vector re-scored against the PRIMARY's target, by the same
//   `buildResidual` that scored the primary. It is the only coverage number
//   that may be shown for an alternative; `record.basket.residual` never is.
//   Nothing here hand-rolls a coverage calculation, precisely so that the two
//   numbers a user compares came out of identical code.
//
// What makes the two vectors comparable index-by-index:
//
//   1. Every alternative's request carries the primary's levels in
//      `extraLevels`, so the alternative's evaluation grid is split wherever
//      the primary's target steps and the primary's target is exact over it.
//   2. A `cheaper_tail`'s new strike is read off the event's own bracket
//      boundaries, never a percentage move. `buildStateSpace` subdivides only
//      at levels falling strictly INSIDE a bracket, so a boundary adds no
//      evaluation state and the alternative's grid stays identical to the
//      primary's.
//
//   Together those keep `coverageRatio` — a sum over evaluation states —
//   weighted the same way on both sides. A future alternative whose shape
//   introduced a level strictly inside a bracket would refine the grid, split
//   one bracket's contribution in two and silently re-weight the ratio
//   against the primary's. It would need its own re-weighting before its
//   coverage could be put beside the primary's.

import {
  buildResidual, buildStateSpace, dollarsToCents, levelsOf, targetVector,
  type Residual, type TargetShape,
} from '@polyhedge/core';
import {
  quote,
  type QuoteDeps, type QuoteOptions, type QuoteRecord, type QuoteRequest,
} from '@polyhedge/engine';

/**
 * Over-hedge penalty for the `shaped` re-solve, against `buildBasket`'s
 * default of 0.001. At 1 a dollar of payout bought in a state that owes
 * nothing costs the objective as much as a dollar of premium, which is what
 * pushes the solver off the blunt neg-risk complement and onto the exact,
 * dearer strip. Named here rather than written at the call site so the one
 * number that defines "shaped" is findable.
 */
const SHAPED_MU = 1;

/**
 * A hedge whose premium is at least this share of the payout it buys is
 * expensive enough that a further, cheaper strike is worth showing. Below it
 * the user is not paying enough for the trade-off to be interesting.
 */
const CHEAPER_TAIL_COST_SHARE = 0.25;

export interface Alternative {
  /**
   * `perp` is reserved for a future instrument integration with different
   * failure modes. This compiler never emits one. An empty entry would read
   * as "considered and rejected" when nothing considered it.
   */
  kind: 'shaped' | 'cheaper_tail' | 'perp';
  /** Plain English: what this trades away and what it buys. */
  reason: string;
  /** A complete, executable, replayable record for the user's selected alternative. */
  record: QuoteRecord;
  /**
   * This alternative's payout re-measured against the PRIMARY's target.
   * The only coverage number that may be shown for an alternative.
   */
  residualVsPrimary: Residual;
}

/**
 * The levels the primary's own state space was split at: its shape's levels
 * plus whatever else the request asked for. Every alternative carries these
 * as `extraLevels` so the primary's target is exact over the alternative's
 * grid.
 */
function primaryLevels(primary: QuoteRecord): number[] {
  return [...new Set([
    ...levelsOf(primary.request.shape),
    ...(primary.request.extraLevels ?? []),
  ])];
}

/**
 * The alternative's request. Same event, same budget, same observation note:
 * an alternative is a different hedge for the same user on the same market,
 * not a different question. Optional fields are spread in only when present
 * because `exactOptionalPropertyTypes` makes "absent" and "present and
 * undefined" different types, and the engine reads a present `budgetUsd` as
 * a real cap.
 */
function alternativeRequest(
  primary: QuoteRecord,
  shape: TargetShape,
  mu?: number,
): QuoteRequest {
  const { budgetUsd, observationNote } = primary.request;
  return {
    eventId: primary.request.eventId,
    shape,
    extraLevels: primaryLevels(primary),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(observationNote !== undefined ? { observationNote } : {}),
    ...(mu !== undefined ? { mu } : {}),
  };
}

/**
 * Re-score an alternative's payout against the primary's target.
 *
 * The state space is rebuilt from the alternative's own resolved items and
 * its own request levels, which is exactly what `quote` did to produce
 * `record.basket.achievable` — so `achievable[i]` and `target[i]` describe
 * the same evaluation state. The provenance (`ruleFlags`,
 * `correlationResidual`) is the alternative's, because those describe the
 * market this basket was actually bought on.
 */
function remeasureAgainstPrimary(primary: QuoteRecord, alternative: QuoteRecord): Residual {
  const stateSpace = buildStateSpace(
    alternative.resolved.items,
    [...levelsOf(alternative.request.shape), ...(alternative.request.extraLevels ?? [])],
  );
  const { target, overhedgeCents } = targetVector(primary.request.shape, stateSpace);

  return buildResidual({
    stateSpace,
    target,
    achievable: alternative.basket.achievable,
    overhedgeCents,
    ruleFlags: alternative.meta.ruleFlags,
    correlationResidual: alternative.meta.correlationResidual,
  });
}

/**
 * The next strike the venue actually trades, strictly beyond `k` in the
 * direction of the loss. Read off the ladder's own bracket edges: a strike
 * the event does not split at is not tradable at any price, and a percentage
 * move off `k` would land there most of the time. `null` when the ladder
 * runs out, in which case there is no cheaper tail to offer.
 */
function nextTradableBoundaryBeyond(
  primary: QuoteRecord,
  direction: 'below' | 'above',
  k: number,
): number | null {
  const { tradable } = buildStateSpace(primary.resolved.items, primaryLevels(primary));

  const edges: number[] = [];
  for (const state of tradable) {
    if (state.bracket.lo !== null) edges.push(state.bracket.lo);
    if (state.bracket.hi !== null) edges.push(state.bracket.hi);
  }

  const beyond = edges.filter((e) => (direction === 'below' ? e < k : e > k));
  if (beyond.length === 0) return null;
  return direction === 'below' ? Math.max(...beyond) : Math.min(...beyond);
}

function usd(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function priceLevel(x: number): string {
  return `$${x.toLocaleString('en-US')}`;
}

/**
 * Reasons are written from `residualVsPrimary`, never from the alternative's
 * own residual — same rule as the number itself, for the same reason.
 */
function shapedReason(
  primary: QuoteRecord,
  record: QuoteRecord,
  residualVsPrimary: Residual,
): string {
  const saved = primary.basket.totalCostCents - record.basket.totalCostCents;
  // "Costs $600 instead of $600" is what the naive phrasing produced, and it
  // reads as a bug because it is one. When the budget binds, both solves land
  // on the cap and only the shape differs.
  const cost = Math.abs(saved) < MATERIAL_CENTS
    ? 'Costs the same'
    : `Costs ${usd(record.basket.totalCostCents)} instead of ${usd(primary.basket.totalCostCents)}`;

  const avoided = primary.basket.residual.crossStateOverhedgeCents
    - residualVsPrimary.crossStateOverhedgeCents;

  // "beyond what your exposure owes", not "in states that owe nothing":
  // `crossStateOverhedgeCents` sums the excess over EVERY state, including
  // states that do owe something. The narrower phrasing understates it.
  return `${cost}, and buys ${usd(avoided)} less payout beyond what your exposure owes.`;
}

/**
 * Below this, two baskets are the same basket.
 *
 * A stated policy, not a fitted number: a dollar is the smallest difference
 * worth putting on screen as a distinct choice.
 */
const MATERIAL_CENTS = 100;

/**
 * Whether an alternative is worth offering at all.
 *
 * An alternative is a trade-off someone can act on. One that costs the same AND
 * buys no less unwanted payout is not a trade-off, it is the primary basket
 * again under another name — and shown as a card beside it, with identical
 * numbers, it actively misleads: it implies a choice exists where none does.
 *
 * This was live. A budget-capped BTC hedge offered a fourth basket reading
 * "Costs $600 instead of $600, and does not reduce the $8,059.40 of payout
 * bought beyond what your exposure owes" — an option whose own description
 * said it did nothing.
 */
function improvesOnPrimary(
  primary: QuoteRecord,
  record: QuoteRecord,
  residualVsPrimary: Residual,
): boolean {
  const cheaper = primary.basket.totalCostCents - record.basket.totalCostCents;
  // Measured against the PRIMARY's target, never the alternative's own — an
  // alternative solves a weaker target and its own residual flatters it.
  const lessOverhedge = primary.basket.residual.crossStateOverhedgeCents
    - residualVsPrimary.crossStateOverhedgeCents;
  return cheaper >= MATERIAL_CENTS || lessOverhedge >= MATERIAL_CENTS;
}

function cheaperTailReason(
  primary: QuoteRecord,
  record: QuoteRecord,
  direction: 'below' | 'above',
  oldK: number,
  newK: number,
): string {
  const oldCost = primary.basket.totalCostCents;
  const newCost = record.basket.totalCostCents;
  const share = oldCost > 0 ? ` — about ${Math.round((100 * newCost) / oldCost)}% of the cost` : '';
  const [low, high] = oldK <= newK ? [oldK, newK] : [newK, oldK];

  return `Pays only if the market settles ${direction} ${priceLevel(newK)} instead of `
    + `${direction} ${priceLevel(oldK)}${share} (${usd(newCost)} instead of ${usd(oldCost)}), `
    + `and nothing between ${priceLevel(low)} and ${priceLevel(high)}.`;
}

/**
 * Options for the alternatives' own solves.
 *
 * Anything the caller does not override comes from the primary's `meta`.
 * The alternatives are quoted on the same event at the same moment, so a
 * rule flag or a correlation caveat that applied to the primary applies to
 * them; letting it drop because the caller passed no options would hide a
 * caveat on the very records this file exists to present honestly.
 */
function inheritedOptions(primary: QuoteRecord, options?: QuoteOptions): QuoteOptions {
  return {
    ruleFlags: options?.ruleFlags ?? primary.meta.ruleFlags,
    correlationResidual: options?.correlationResidual ?? primary.meta.correlationResidual,
    calibrationMapVersion: options?.calibrationMapVersion ?? primary.meta.calibrationMapVersion,
    jevModelVersion: options?.jevModelVersion ?? primary.meta.jevModelVersion,
  };
}

/**
 * What else the user's money could buy, given the hedge they were quoted.
 *
 * Every trigger is computed against the primary. Nothing fires, nothing is
 * emitted: an empty array is the honest answer when the quote is already the
 * shape of the exposure, and a padded list would make the primary look like
 * one option among several when it is the one that was asked for.
 *
 * Each alternative goes through `quote()` and so gets its own books and its
 * own snapshot. Reusing the primary's snapshot would make a record that
 * cannot be replayed as what was actually offered.
 */
export async function buildAlternatives(
  primary: QuoteRecord,
  deps: QuoteDeps,
  options?: QuoteOptions,
): Promise<Alternative[]> {
  const resolvedOptions = inheritedOptions(primary, options);
  const shape = primary.request.shape;
  const payoutCents = dollarsToCents(shape.payoutUsd);
  const alternatives: Alternative[] = [];

  // The basket buys more payout in states that owe nothing than the whole
  // exposure is worth. Re-solve the same shape under a penalty that makes
  // that payout expensive, and let the user see what precision costs.
  if (primary.basket.residual.crossStateOverhedgeCents > payoutCents) {
    const record = await quote(
      alternativeRequest(primary, shape, SHAPED_MU),
      deps,
      resolvedOptions,
    );
    const residualVsPrimary = remeasureAgainstPrimary(primary, record);
    // Offered only if it actually trades something away for something. When the
    // budget binds, this solve lands on the same cap and changes nothing, and a
    // duplicate card implies a choice that does not exist.
    if (improvesOnPrimary(primary, record, residualVsPrimary)) {
      alternatives.push({
        kind: 'shaped',
        reason: shapedReason(primary, record, residualVsPrimary),
        record,
        residualVsPrimary,
      });
    }
  }

  // The premium is a large share of what it protects. Offer the same payout
  // at the next strike the venue trades further out, which is less
  // protection and says so.
  const costIsHeavy = primary.basket.totalCostCents > payoutCents * CHEAPER_TAIL_COST_SHARE;
  const hasSingleStrike = shape.templateId === 'threshold_digital' || shape.templateId === 'tail_only';

  if (costIsHeavy && hasSingleStrike) {
    const newK = nextTradableBoundaryBeyond(primary, shape.direction, shape.k);
    if (newK !== null) {
      const tailShape: TargetShape = {
        templateId: 'tail_only',
        payoutUsd: shape.payoutUsd,
        direction: shape.direction,
        k: newK,
      };
      const record = await quote(alternativeRequest(primary, tailShape), deps, resolvedOptions);
      alternatives.push({
        kind: 'cheaper_tail',
        reason: cheaperTailReason(primary, record, shape.direction, shape.k, newK),
        record,
        residualVsPrimary: remeasureAgainstPrimary(primary, record),
      });
    }
  }

  return alternatives;
}
