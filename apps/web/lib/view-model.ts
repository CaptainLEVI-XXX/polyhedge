import type { QuoteRecord } from '@polyhedge/engine';
import type { IndexedEvent } from '@polyhedge/intake';
import { buildStateSpace, levelsOf, targetVector, type Basket } from '@polyhedge/core';
import { costLabel, coverageLabel, levelLabel, payoutLabel, shortfallLabel } from './money.js';

/**
 * The browser never receives a raw `QuoteRecord`.
 *
 * It receives this, which separates the two registers — plain by default,
 * precise on request — and formats the plain one once, here, under the rounding
 * rules in `money.ts`.
 *
 * Three properties of the engine drive the shape, and getting any of them wrong
 * draws the wrong protection:
 *
 * 1. **A basket is not necessarily all-YES.** The solver buys the neg-risk
 *    complement when the book prices it better, so a position is a bracket AND
 *    a side. Several NO positions can pay at once, which an all-YES basket can
 *    never do.
 * 2. **Payout is per evaluation state, not per bracket.** When the threshold
 *    falls inside a bracket the compiler subdivides it, so states outnumber
 *    brackets and a bracket-indexed payout would be wrong exactly where the
 *    user most needs it to be right.
 * 3. **The ladder belongs to an option, not to the quote.** Each option buys
 *    different positions; one shared ladder would show the wrong thing the
 *    moment the user switches.
 */

export interface PositionRowView {
  bracketLabel: string;
  /** The venue's own question, unedited. Empty when it published none. */
  question: string;
  side: 'YES' | 'NO';
  shares: number;
  priceLabel: string;
  costLabel: string;
  /** Share of this option's premium, 0–1. */
  premiumShare: number;
  tokenId: string;
}

export interface PayoutRowView {
  lo: number | null;
  hi: number | null;
  label: string;
  owedUsd: number;
  paidUsd: number;
  /** True where the basket pays and nothing is owed. */
  beyondOwed: boolean;
}

export interface LadderView {
  positions: PositionRowView[];
  /**
   * How many of these can pay at once — DERIVED, never fixed copy.
   *
   * For an all-YES basket over a partition exactly one can pay, and saying so
   * explains why a small premium buys a large payout. But the solver also buys
   * the neg-risk complement, and a NO position pays whenever its range is NOT
   * the outcome, so several can pay together. Hardcoding the YES-only sentence
   * would be a false promise on a basket the engine legitimately produces.
   */
  exclusivity: 'exactly_one' | 'several';
  payout: PayoutRowView[];
  thresholds: number[];
  unit: string;
  heldCount: number;
  consideredCount: number;
}

export interface CoverOptionView {
  id: string;
  name: string;
  reason: string;
  costLabel: string;
  coverageLabel: string;
  coverageRatio: number;
  paysLabel: string;
  shortfallLabel: string;
  shortfallWhere: string | null;
  beyondOwedLabel: string;
  /** Conservatism INSIDE a bracket. Non-zero for payoffs that vary within one. */
  withinBracketLabel: string;
  ladder: LadderView;
  detail: {
    eventId: string;
    snapshotId: string;
    quotedAt: string;
    mu: number;
    phase1Hash: string;
    phase2Hash: string;
  };
}

export interface EventView {
  title: string;
  settlesLabel: string;
  /** Whether the settlement instant was published or inferred from `endDate`. */
  observationSource: 'description' | 'endDate';
  outcomeCount: number;
}

export interface QuotedView {
  statement: string;
  event: EventView;
  options: CoverOptionView[];
  assumptions: string[];
  provenance: {
    model: string;
    calibration: string;
    /** A boolean so no component decides for itself what 'unfitted' means. */
    calibrationIsFitted: boolean;
  };
}

function heldPositions(
  basket: Basket,
  questionFor: (marketId: string) => string,
): PositionRowView[] {
  // The solver returns a row for every leg it considered, most at zero shares.
  // Those are not positions, and listing them buries the ones that are.
  const held = basket.legs.filter((leg) => leg.shares > 0);
  const total = held.reduce((sum, leg) => sum + leg.costCents, 0);

  return held.map((leg) => ({
    bracketLabel: leg.label,
    question: questionFor(leg.marketId),
    side: leg.side,
    shares: leg.shares,
    priceLabel: `${(leg.avgPriceMicros / 10_000).toFixed(1)}¢`,
    costLabel: costLabel(leg.costCents),
    premiumShare: total === 0 ? 0 : leg.costCents / total,
    tokenId: leg.tokenId,
  }));
}

function payoutRows(record: QuoteRecord, unit: string): PayoutRowView[] {
  // Rebuilt rather than carried: the state space is a pure function of the
  // items and the shape's levels, so recomputing it here cannot disagree with
  // what was solved, and shipping it through the record would be a second
  // source of truth for the same thing.
  const stateSpace = buildStateSpace(record.resolved.items, [
    ...levelsOf(record.request.shape),
    ...(record.request.extraLevels ?? []),
  ]);
  const { target } = targetVector(record.request.shape, stateSpace);
  const achievable = record.basket.achievable;

  return stateSpace.evals.map((evalState, i) => {
    const owedUsd = Number(target[i] ?? 0) / 100;
    const paidUsd = Number(achievable[i] ?? 0) / 100;
    return {
      lo: evalState.lo,
      hi: evalState.hi,
      label: evalState.label,
      owedUsd,
      paidUsd,
      beyondOwed: paidUsd > owedUsd + 1e-9,
    };
  });
}

export function toOptionView(
  id: string,
  name: string,
  reason: string,
  record: QuoteRecord,
  unit: string,
  questionFor: (marketId: string) => string = () => '',
): CoverOptionView {
  const basket = record.basket;
  const residual = basket.residual;
  const payoutUsd = 'payoutUsd' in record.request.shape ? record.request.shape.payoutUsd : 0;
  const positions = heldPositions(basket, questionFor);

  return {
    id,
    name,
    reason,
    costLabel: costLabel(basket.totalCostCents),
    coverageLabel: coverageLabel(residual.coverageRatio),
    coverageRatio: residual.coverageRatio,
    paysLabel: payoutLabel(payoutUsd * residual.coverageRatio),
    shortfallLabel: shortfallLabel(Number(residual.worstStateShortfallCents)),
    shortfallWhere: residual.worstStateLabel,
    // Never "in states that owe nothing": this sums the excess over EVERY
    // state, including ones that do owe. The narrower phrasing understated it.
    beyondOwedLabel: costLabel(Number(residual.crossStateOverhedgeCents)),
    withinBracketLabel: costLabel(Number(residual.overhedgeCents)),
    ladder: {
      positions,
      exclusivity: positions.every((p) => p.side === 'YES') ? 'exactly_one' : 'several',
      payout: payoutRows(record, unit),
      thresholds: levelsOf(record.request.shape),
      unit,
      heldCount: positions.length,
      consideredCount: basket.legs.length,
    },
    detail: {
      eventId: record.request.eventId,
      snapshotId: record.resolved.snapshotId,
      quotedAt: record.meta.quotedAt,
      mu: basket.mu,
      phase1Hash: basket.phase1Hash,
      phase2Hash: basket.phase2Hash,
    },
  };
}

export function describeShape(record: QuoteRecord, unit: string): string {
  const shape = record.request.shape;
  const pays = 'payoutUsd' in shape ? payoutLabel(shape.payoutUsd) : '';
  switch (shape.templateId) {
    case 'threshold_digital':
    case 'tail_only':
      return `pays ${pays} if it ends ${shape.direction} ${levelLabel(shape.k, unit)}`;
    case 'range_protect':
      return `pays ${pays} if it ends outside ${levelLabel(shape.low, unit)}–${levelLabel(shape.high, unit)}`;
    case 'linear_strip':
      return `pays up to ${pays}, growing ${shape.direction} ${levelLabel(shape.k1, unit)} to ${levelLabel(shape.k2, unit)}`;
    default:
      return 'pays on an outcome of this market';
  }
}

export function toQuotedView(
  record: QuoteRecord,
  event: IndexedEvent,
  options: CoverOptionView[],
  assumptions: string[],
): QuotedView {
  return {
    statement: `${event.title} — ${describeShape(record, event.ladder.unit)}`,
    event: {
      title: event.title,
      settlesLabel: event.observationAt,
      observationSource: event.observationSource,
      outcomeCount: event.bracketCount,
    },
    options,
    assumptions,
    provenance: {
      model: record.meta.jevModelVersion,
      calibration: record.meta.calibrationMapVersion,
      calibrationIsFitted: record.meta.calibrationMapVersion !== 'unfitted',
    },
  };
}
