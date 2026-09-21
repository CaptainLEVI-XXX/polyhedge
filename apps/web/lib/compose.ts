import type { Alternative, BasketOption, IndexedEvent } from '@polyhedge/intake';
import type { QuoteRecord } from '@polyhedge/engine';
import { buildStateSpace, levelsOf, targetVector } from '@polyhedge/core';
import { toOptionView, toQuotedView, type QuotedView } from './view-model.js';
import { costLabel, shortfallLabel } from './money.js';

/**
 * The one place a `QuotedView` is assembled.
 *
 * It exists because there were two, and the second one was wrong: re-pricing
 * rebuilt a single hardcoded `stop-0` and threw the rest away, so a three-basket
 * quote silently became a one-basket quote the moment the book moved. Nobody saw
 * it because the option strip only renders above one option — the baskets did
 * not visibly vanish, they just stopped existing.
 *
 * So composition is not duplicated any more. Anything that produces a view for
 * a user comes through here, including the re-measurement below, which is the
 * kind of correction that is easy to remember once and forget forever after.
 */

export interface Composed {
  view: QuotedView;
  optionRecords: Record<string, QuoteRecord>;
  /** How many leading options are stops; the rest are alternatives. */
  stopCount: number;
}

export function composeView(args: {
  /** The basket that was actually asked for; alternatives are measured against it. */
  primary: QuoteRecord;
  event: IndexedEvent;
  stops: BasketOption[];
  alternatives: Alternative[];
  assumptions: string[];
  questionFor: (marketId: string) => string;
  /** The venue's page for a bracket, so a position can be checked at source. */
  linkFor: (marketId: string) => string | null;
}): Composed {
  const { primary, event, stops, alternatives, assumptions, questionFor, linkFor } = args;
  const unit = event.ladder.unit;

  const view = toQuotedView(
    primary,
    event,
    [
      // Same shape at different budgets, so each record's own coverage is
      // already measured against the real loss and needs no correction.
      ...stops.map((stop, i) =>
        toOptionView(stop.record.request.protectionGoal
          ? (stop.name === 'Lower premium' ? 'lower-premium' : stop.name === 'Your budget' ? 'budget'
            : stop.name === 'Your loss limit' ? 'loss-limit' : 'lowest-loss')
          : `stop-${i}`, stop.name, stop.reason, stop.record, unit, questionFor, linkFor),
      ),
      ...alternatives.map((alt) =>
        toOptionView(alt.kind, alt.kind.replace(/_/g, ' '), alt.reason, alt.record, unit, questionFor, linkFor),
      ),
    ],
    assumptions,
  );

  // An alternative CHANGES the shape, so it solves a different target and its
  // own residual flatters it — a further strike reports perfect coverage for
  // strictly less protection. Overwritten at the boundary rather than in every
  // renderer downstream, because the safest place to close a trap is the one
  // place everything passes through.
  alternatives.forEach((alt, i) => {
    const option = view.options[stops.length + i];
    if (option === undefined) return;
    const ratio = Math.max(0, Math.min(1, alt.residualVsPrimary.coverageRatio));
    option.coverageRatio = ratio;
    option.coverageLabel = `${Math.floor(ratio * 100)}%`;
    option.shortfallLabel = shortfallLabel(alt.residualVsPrimary.worstStateShortfallCents);
    option.shortfallWhere = alt.residualVsPrimary.worstStateLabel;
    const grid = buildStateSpace(alt.record.resolved.items,
      [...levelsOf(alt.record.request.shape), ...(alt.record.request.extraLevels ?? [])]);
    const target = targetVector(primary.request.shape, grid).target;
    option.ladder.payout.forEach((row, j) => {
      row.owedUsd = target[j]! / 100;
      row.beyondOwed = row.paidUsd > row.owedUsd + 1e-9;
    });
    option.netLossLabel = costLabel(Math.max(0, ...option.ladder.payout.map(row =>
      (row.owedUsd - row.paidUsd) * 100 + alt.record.basket.totalCostCents)));
  });

  const records = [...stops.map(s => s.record), ...alternatives.map(a => a.record)];
  const optionRecords = Object.fromEntries(view.options.map((option, i) => [option.id, records[i]!]));
  return { view, optionRecords, stopCount: stops.length };
}
