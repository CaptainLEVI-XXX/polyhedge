import { quoteStateSpace, type QuoteRecord } from '@polyhedge/engine';
import { targetVector, type Basket } from '@polyhedge/core';
import { costLabel, levelLabel, payoutLabel } from './money.js';

/**
 * The browser never receives a raw `QuoteRecord`. It receives this: only what
 * the pages render, formatted once here under the rounding rules in `money.ts`.
 *
 * Three properties of the engine drive the shape, and getting any of them wrong
 * draws the wrong protection:
 *
 * 1. **A basket is not necessarily all-YES.** The solver buys the neg-risk
 *    complement when the book prices it better, so a position is a bracket AND
 *    a side.
 * 2. **Payout is per evaluation state, not per bracket.** When the threshold
 *    falls inside a bracket the compiler subdivides it, so states outnumber
 *    brackets and a bracket-indexed payout would be wrong exactly where the
 *    user most needs it to be right.
 * 3. **The ladder belongs to an option, not to the quote.** Each option buys
 *    different positions; one shared ladder would show the wrong thing the
 *    moment the user switches.
 */

export interface PositionRowView {
  /** The venue's own page for this bracket. Null when it published no slug. */
  href: string | null;
  bracketLabel: string;
  /** The venue's own question, unedited. Empty when it published none. */
  question: string;
  side: 'YES' | 'NO';
  shares: number;
  priceLabel: string;
  costLabel: string;
  tokenId: string;
}

export interface PayoutRowView {
  lo: number | null;
  hi: number | null;
  label: string;
  owedUsd: number;
  paidUsd: number;
}

export interface CoverOptionView {
  id: string;
  name: string;
  reason: string;
  costLabel: string;
  /** The premium as a number, for drawing. Labels are for reading, not maths. */
  costUsd: number;
  /** Premium minus the payout the market expects; null without market prices. */
  trueCostUsd: number | null;
  /** True when a range shows its maximum target loss rather than an exact one. */
  conservativeWithinRange: boolean;
  ladder: {
    kind: 'numeric' | 'binary' | 'categorical';
    positions: PositionRowView[];
    payout: PayoutRowView[];
    unit: string;
    heldCount: number;
  };
}

/** One basket on the cost-versus-protection curve. */
export interface CurvePoint {
  costUsd: number;
  /** Most you could still lose with this basket, premium included. */
  worstLossUsd: number;
  trueCostUsd: number | null;
}

export interface QuotedView {
  parsed: {
    subject: string;
    /** What is being protected, e.g. "pays $8,000 if it ends below $77,000". */
    exposureLabel: string;
    /** Null when the user named no budget — never an invented one. */
    budgetLabel: string | null;
    budgetUsd?: number;
  };
  event: { title: string; settlesLabel: string };
  options: CoverOptionView[];
  assumptions: string[];
}

function heldPositions(
  basket: Basket,
  questionFor: (marketId: string) => string,
  linkFor: (marketId: string) => string | null,
): PositionRowView[] {
  // The solver returns a row for every leg it considered, most at zero shares.
  // Those are not positions, and listing them buries the ones that are.
  return basket.legs.filter((leg) => leg.shares > 0).map((leg) => ({
    href: linkFor(leg.marketId),
    bracketLabel: leg.label,
    question: questionFor(leg.marketId),
    side: leg.side,
    shares: leg.shares,
    priceLabel: `${(leg.avgPriceMicros / 10_000).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}¢`,
    costLabel: costLabel(leg.costCents),
    tokenId: leg.tokenId,
  }));
}

function payoutRows(record: QuoteRecord): PayoutRowView[] {
  // Rebuilt rather than carried: the state space is a pure function of the
  // items and the shape's levels, so recomputing it here cannot disagree with
  // what was solved.
  const stateSpace = quoteStateSpace(record);
  const { target } = targetVector(record.request.shape, stateSpace);
  return stateSpace.evals.map((evalState, i) => ({
    lo: evalState.lo,
    hi: evalState.hi,
    label: evalState.label,
    owedUsd: Number(target[i] ?? 0) / 100,
    paidUsd: Number(record.basket.achievable[i] ?? 0) / 100,
  }));
}

export function toOptionView(
  id: string,
  name: string,
  reason: string,
  record: QuoteRecord,
  unit: string,
  questionFor: (marketId: string) => string,
  linkFor: (marketId: string) => string | null,
): CoverOptionView {
  const basket = record.basket;
  const positions = heldPositions(basket, questionFor, linkFor);
  return {
    id,
    name,
    reason,
    costLabel: costLabel(basket.totalCostCents),
    costUsd: Number(basket.totalCostCents) / 100,
    trueCostUsd: trueCostUsd(record),
    conservativeWithinRange: record.request.shape.templateId === 'linear_strip',
    ladder: {
      kind: record.resolved.domain?.kind ?? 'numeric',
      positions,
      payout: payoutRows(record),
      unit,
      heldCount: positions.length,
    },
  };
}

/**
 * What a basket costs once expected payouts are counted: premium minus the
 * payout in each outcome weighted by the market's own odds. An estimate conditional on those probabilities. Negative only when the book offers cover below its displayed odds.
 *
 * A YES or NO position pays the same across every evaluation state of one
 * tradable state, so the first evaluation state stands for all of them.
 */
export function trueCostUsd(record: QuoteRecord): number | null {
  const odds = record.resolved.probabilities;
  if (!odds) return null;
  const { tradable, evals } = quoteStateSpace(record);
  let expectedCents = 0;
  for (const state of tradable) {
    const chance = odds[state.key];
    if (chance === undefined) return null;
    expectedCents += chance * Number(record.basket.achievable[evals.findIndex(e => e.tradableKey === state.key)] ?? 0);
  }
  return (record.basket.totalCostCents - expectedCents) / 100;
}

/**
 * The curve from "no hedge" to the most protection the books allow, keeping
 * only baskets that buy strictly more protection for more money.
 */
export function curvePoints(records: QuoteRecord[]): CurvePoint[] {
  if (!records.length) return [];
  const points: CurvePoint[] = [{ costUsd: 0, worstLossUsd: Math.max(0, ...records[0]!.basket.target) / 100, trueCostUsd: 0 }];
  const byCost = [...records].sort((a, b) => a.basket.totalCostCents - b.basket.totalCostCents
    || (a.basket.worstNetLossCents ?? 0) - (b.basket.worstNetLossCents ?? 0));
  for (const record of byCost) {
    const point = { costUsd: record.basket.totalCostCents / 100,
      worstLossUsd: (record.basket.worstNetLossCents ?? 0) / 100, trueCostUsd: trueCostUsd(record) };
    if (point.worstLossUsd < points.at(-1)!.worstLossUsd - 0.005) points.push(point);
  }
  return points;
}

function describeShape(record: QuoteRecord, unit: string): string {
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

export function toEventQuotedView(record: QuoteRecord, options: CoverOptionView[], assumptions: string[]): QuotedView {
  const d = record.resolved.domain;
  if (!d) throw new Error('Missing event evidence');
  const budgetUsd = record.request.budgetUsd;
  return {
    parsed: {
      subject: d.title,
      exposureLabel: d.kind === 'numeric' ? describeShape(record, d.unit) : 'Your confirmed loss by outcome',
      // Absent, not zero. A budget the user never stated is never invented.
      budgetLabel: budgetUsd === undefined ? null : `$${budgetUsd}`,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    },
    event: { title: d.title, settlesLabel: d.observationAt },
    options,
    assumptions,
  };
}
