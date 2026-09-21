// Several whole baskets for one exposure, priced at different budgets.
//
// A single "here is your hedge" hides the actual decision. What a user wants to
// know is what full cover costs, what their stated budget buys, and whether a
// much cheaper basket is worth considering — three complete baskets they can
// compare, not one number with alternatives bolted underneath.
//
// WHY THESE ARE HONESTLY COMPARABLE, when `alternatives.ts` needs a whole
// re-measurement machine to be:
//
// Every option here solves the SAME `TargetShape`. Same shape means the same
// target vector over the same evaluation grid, so each record's own
// `basket.residual.coverageRatio` is already measured against the full loss the
// user described. Nothing needs re-measuring and the numbers can be read side
// by side directly.
//
// `alternatives.ts` is different precisely because it CHANGES the shape — a
// further strike solves a weaker target perfectly and reports 100%. Anything
// added here that alters the shape must come back through
// `residualVsPrimary`, never its own residual.

import { quote, type QuoteDeps, type QuoteOptions, type QuoteRecord, type QuoteRequest } from '@polyhedge/engine';
import type { Residual } from '@polyhedge/core';

export interface BasketOption {
  /** Short label for the card: "Full cover", "Your budget", "Cheapest". */
  name: string;
  /** What this option trades away, in the user's terms. */
  reason: string;
  record: QuoteRecord;
  /**
   * Coverage of the loss the user actually described. Safe to compare across
   * options ONLY because every option here solves the same shape.
   */
  residual: Residual;
}

/**
 * The cheap option's share of full-cover cost.
 *
 * Not tuned against anything — there is no labelled data on what counts as
 * "worth considering", so this is a stated policy, not a fitted number.
 */
const CHEAP_SHARE = 0.35;

/** Two costs that round to the same dollar are the same basket to a user. */
function distinct(a: QuoteRecord, b: QuoteRecord): boolean {
  return Math.abs(a.basket.totalCostCents - b.basket.totalCostCents) >= 100;
}

function coverLine(record: QuoteRecord, payoutUsd: number): string {
  const covered = Math.round(payoutUsd * record.basket.residual.coverageRatio);
  return `Pays about $${covered.toLocaleString('en-US')} of the $${payoutUsd.toLocaleString('en-US')} you said you could lose.`;
}

/**
 * Builds the option set for one exposure on one market.
 *
 * The unconstrained solve runs first because its cost is the only honest
 * anchor for "how much would covering this actually take" — every other option
 * is described relative to it. A budget the user never stated is never
 * invented; when they gave none, they get full cover and one cheaper option.
 */
export async function buildBasketOptions(
  request: QuoteRequest,
  deps: QuoteDeps,
  options?: QuoteOptions,
): Promise<BasketOption[]> {
  const payoutUsd = 'payoutUsd' in request.shape ? request.shape.payoutUsd : 0;

  // Full cover: the same request with no budget cap at all. Note this drops
  // `budgetUsd` rather than setting it high — under `exactOptionalPropertyTypes`
  // an absent budget and a huge one are different things to the engine.
  const { budgetUsd, ...uncapped } = request;
  const full = await quote(uncapped, deps, options);

  const out: BasketOption[] = [{
    name: 'Full cover',
    reason: `The most this market can cover. ${coverLine(full, payoutUsd)}`,
    record: full,
    residual: full.basket.residual,
  }];

  if (budgetUsd !== undefined) {
    const capped = await quote({ ...request, budgetUsd }, deps, options);
    if (distinct(capped, full)) {
      out.push({
        name: 'Your budget',
        reason: `What the $${budgetUsd.toLocaleString('en-US')} you named buys. ${coverLine(capped, payoutUsd)}`,
        record: capped,
        residual: capped.basket.residual,
      });
    }
  }

  const cheapUsd = Math.max(1, Math.round((full.basket.totalCostCents / 100) * CHEAP_SHARE));
  if (budgetUsd === undefined || cheapUsd < budgetUsd) {
    const cheap = await quote({ ...request, budgetUsd: cheapUsd }, deps, options);
    if (out.every((o) => distinct(cheap, o.record))) {
      out.push({
        name: 'Cheapest',
        reason: `Roughly a third of the cost, and materially less cover. ${coverLine(cheap, payoutUsd)}`,
        record: cheap,
        residual: cheap.basket.residual,
      });
    }
  }

  // Cheapest first reads as a price ladder, which is how the cards are laid out.
  return out.sort((a, b) => a.record.basket.totalCostCents - b.record.basket.totalCostCents);
}
