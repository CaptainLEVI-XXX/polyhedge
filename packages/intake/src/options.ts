import type { ClobBook } from '@polyhedge/venue';
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

import { quote, replay, quoteSession, type QuoteDeps, type QuoteOptions, type QuoteRecord, type QuoteRequest } from '@polyhedge/engine';
import { BasketValidationError, LpNotOptimalError, type Residual } from '@polyhedge/core';

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

/**
 * Two options are the same to a user when they cost the same AND protect the
 * same. Collapsing on price alone would hide a genuinely different basket that
 * happens to cost a similar amount, which is the comparison the stops exist to
 * make.
 */
function distinct(a: QuoteRecord, b: QuoteRecord): boolean {
  const priceMoved = Math.abs(a.basket.totalCostCents - b.basket.totalCostCents) >= 100;
  const coverMoved = Math.abs(a.basket.residual.coverageRatio - b.basket.residual.coverageRatio) >= 0.005;
  const netMoved = a.basket.worstNetLossCents !== undefined && b.basket.worstNetLossCents !== undefined
    && Math.abs(a.basket.worstNetLossCents - b.basket.worstNetLossCents) >= 100;
  return priceMoved || coverMoved || netMoved;
}

function coverLine(record: QuoteRecord): string {
  const gap = record.basket.residual.worstStateShortfallCents / 100;
  return `Up to $${gap.toLocaleString('en-US')} of the requested payout remains uncovered before premium.`;
}

function netOption(name: string, record: QuoteRecord): BasketOption {
  const loss = (record.basket.worstNetLossCents ?? 0) / 100;
  return { name, record, residual: record.basket.residual,
    reason: `Worst remaining target loss, including premium and fees: $${loss.toLocaleString('en-US')}. Applies to the stated payout shape and settlement assumptions.` };
}

async function netOptions(request: QuoteRequest, pinned: QuoteDeps, options?: QuoteOptions,
  primary?: QuoteRecord): Promise<BasketOption[]> {
  if (request.protectionGoal?.kind === 'limit_net_loss') {
    return [netOption('Your loss limit', primary ?? await quote(request, pinned, options))];
  }
  const { budgetUsd, ...uncapped } = request;
  const full = budgetUsd === undefined && primary ? primary : await quote(uncapped, pinned, options);
  const capped = budgetUsd === undefined ? full : primary ?? await quote(request, pinned, options);
  const out = [netOption(budgetUsd === undefined ? 'Lowest remaining loss' : 'Your budget', capped)];
  if (distinct(full, capped)) out.push(netOption('Lowest loss without a budget cap', full));
  const unhedged = Math.max(...capped.basket.target);
  const best = capped.basket.worstNetLossCents!;
  // A point on the cost/risk frontier: cheapest basket achieving half the
  // attainable loss reduction, not an arbitrary fraction of the premium.
  if (unhedged - best >= 100) {
    const smaller = await quote({ ...request, mu: 0,
      protectionGoal: { kind: 'limit_net_loss', maxNetLossUsd: Math.ceil((unhedged + best) / 2) / 100 },
    }, pinned, options);
    if (out.every(o => distinct(smaller, o.record))) out.push(netOption('Lower premium', smaller));
  }
  return out.sort((a, b) => a.record.basket.totalCostCents - b.record.basket.totalCostCents);
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
  /** Optional previously solved primary from the SAME request-scoped deps. */
  primary?: QuoteRecord,
): Promise<BasketOption[]> {
  // Full cover: the same request with no budget cap at all. Note this drops
  // `budgetUsd` rather than setting it high — under `exactOptionalPropertyTypes`
  // an absent budget and a huge one are different things to the engine.
  const pinned = quoteSession(deps);
  if (primary && JSON.stringify(primary.request) !== JSON.stringify(request)) {
    throw new Error('option seed must have the same request');
  }
  if (request.protectionGoal) return netOptions(request, pinned, options, primary);
  const { budgetUsd, ...uncapped } = request;
  const full = await quote(uncapped, pinned, options);

  const out: BasketOption[] = [{
    // "Everything", not "Full cover": an uncapped solve is the most this
    // market's liquidity allows, which is not always all of the loss.
    name: full.basket.residual.coverageRatio >= 0.999 ? 'Everything' : 'As much as the book allows',
    reason: `Spends whatever it takes, up to what this market can absorb. ${coverLine(full)}`,
    record: full,
    residual: full.basket.residual,
  }];

  if (budgetUsd !== undefined) {
    const capped = await quote({ ...request, budgetUsd }, pinned, options);
    if (distinct(capped, full)) {
      out.push({
        name: 'Your budget',
        reason: `What the $${budgetUsd.toLocaleString('en-US')} you named buys. ${coverLine(capped)}`,
        record: capped,
        residual: capped.basket.residual,
      });
    }
  }

  const cheapUsd = Math.max(1, Math.round((full.basket.totalCostCents / 100) * CHEAP_SHARE));
  if (budgetUsd === undefined || cheapUsd < budgetUsd) {
    const cheap = await quote({ ...request, budgetUsd: cheapUsd }, pinned, options);
    if (out.every((o) => distinct(cheap, o.record))) {
      out.push({
        // Not a proven cheapest useful hedge — a stated policy fraction of the
        // uncapped cost. Naming it "cheapest" would claim an optimisation
        // nobody ran.
        name: 'Smaller',
        reason: `About a third of the uncapped cost, and materially less cover. ${coverLine(cheap)}`,
        record: cheap,
        residual: cheap.basket.residual,
      });
    }
  }

  // Cheapest first reads as a price ladder, which is how the cards are laid out.
  return out.sort((a, b) => a.record.basket.totalCostCents - b.record.basket.totalCostCents);
}

/** Shares of the attainable worst-loss reduction sampled between "no hedge" and "most protection". */
const CURVE_STEPS = [0.25, 0.5, 0.75];

/**
 * The cost-versus-protection curve: the cheapest basket at several levels of
 * worst-case net loss, from nothing hedged to the most the books allow.
 *
 * Every point solves the same target with no budget cap, so the points sit on
 * one frontier and the user's own options can be placed on it. Works for any
 * target shape, because it only needs each basket's target and worst net loss.
 * A matching uncapped premium-policy seed may supply the endpoint. Other
 * displayed options remain separate markers; they need not be cost-minimal.
 */
export async function costProtectionCurve(
  request: QuoteRequest,
  deps: QuoteDeps,
  options?: QuoteOptions,
  seeds: QuoteRecord[] = [],
): Promise<QuoteRecord[]> {
  const pinned = quoteSession(deps);
  return buildCurve(request,r=>quote(r,pinned,options),seeds);
}

/** Re-solve curve points using only the original quote's rules, odds, fees and books. */
export async function pinnedCostProtectionCurve(record:QuoteRecord,books:ClobBook[]):Promise<QuoteRecord[]> {
  const expected=record.resolved.legs.map(l=>l.tokenId);
  if(books.length!==expected.length||new Set(books.map(b=>b.assetId)).size!==expected.length||expected.some(t=>!books.some(b=>b.assetId===t)))throw Error('Incomplete pinned books');
  return buildCurve(record.request,async request=>{
    const seed={...record,request,basket:{...record.basket,mu:0}};
    return {...seed,basket:await replay(seed,books)};
  },[record]);
}
async function buildCurve(request:QuoteRequest,solve:(r:QuoteRequest)=>Promise<QuoteRecord>,seeds:QuoteRecord[]):Promise<QuoteRecord[]> {
  const { budgetUsd: _budget, mu: _mu, ...rest } = request;
  // The cost/protection curve minimizes premium, regardless of the selection
  // policy used for cards. Experimental selections need not lie on its frontier.
  const uncapped={...rest,selectionPolicy:'premium' as const,mu:0};
  const best=seeds.find(r=>r.request.eventId===request.eventId&&JSON.stringify(r.request.shape)===JSON.stringify(request.shape)&&r.request.ruleHash===request.ruleHash&&JSON.stringify(r.request.execution)===JSON.stringify(request.execution)&&JSON.stringify(r.request.extraLevels)===JSON.stringify(request.extraLevels)&&r.basket.mu===0&&r.request.planningDepth===request.planningDepth&&r.request.budgetUsd===undefined&&r.request.selectionPolicy==='premium'&&r.request.protectionGoal?.kind==='minimize_net_loss')
    ?? await solve({...uncapped,protectionGoal:{kind:'minimize_net_loss'}});
  const unhedged=Math.max(...best.basket.target),floor=best.basket.worstNetLossCents??unhedged;
  if(unhedged-floor<100)return [best];
  const points:QuoteRecord[]=[];
  for(const share of CURVE_STEPS){
    const maxNetLossUsd=Math.ceil(unhedged-share*(unhedged-floor))/100;
    try{points.push(await solve({...uncapped,protectionGoal:{kind:'limit_net_loss',maxNetLossUsd}}));}
    catch(error){if(!(error instanceof LpNotOptimalError||error instanceof BasketValidationError))throw error;}
  }
  return [...points,best].sort((a,b)=>a.basket.totalCostCents-b.basket.totalCostCents);
}
