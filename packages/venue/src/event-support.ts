import { createHash } from 'node:crypto';
import { parseLadder, parseLadderLabel } from './ladder.js';
import type { GammaEvent, GammaMarket } from './schemas.js';

export type EventKind = 'numeric' | 'binary' | 'categorical';
export interface EventSelection { kind: EventKind; marketId?: string }
export interface Outcome { id: string; label: string; marketId: string; conditionId: string; side: 'YES' | 'NO'; yesTokenId: string; noTokenId: string; negRisk: boolean }
export interface EventSupport {
  kind: EventKind; eligible: boolean; reason: string | null; ruleHash: string;
  rules: {marketId:string;description:string}[]; outcomes: Outcome[]; marketIds: string[]; title: string; observationAt: string; unit: string;
}
export function ruleHash(event: GammaEvent, selection: EventSelection): string {
  const markets = (selection.kind === 'binary' ? event.markets.filter(m => m.id === selection.marketId) : event.markets)
    .slice().sort((a,b) => a.id.localeCompare(b.id)).map(m => ({ id:m.id, conditionId:m.conditionId,
      question:m.question, description:m.description, label:m.groupItemTitle, endDate:m.endDate,
      yes:m.yesTokenId, no:m.noTokenId, labels:m.outcomeLabels, yesIndex:m.yesOutcomeIndex,
      negRisk:m.negRisk, other:m.negRiskOther, group:m.negRiskMarketId, fee:m.feeRate, tick:m.tickSize }));
  return createHash('sha256').update(JSON.stringify({ id:event.id, selection:{kind:selection.kind,marketId:selection.marketId}, description:event.description,
    augmented:event.negRiskAugmented, group:event.negRiskMarketId, markets })).digest('hex');
}
function unavailable(m: GammaMarket): string | null {
  if (!m.conditionId || !/^0x[0-9a-fA-F]{64}$/.test(m.conditionId)) return 'Condition identity is unavailable.';
  if (m.yesOutcomeIndex !== 0) return 'This outcome ordering has not been verified for execution.';
  if (m.active !== true || m.closed !== false || m.acceptingOrders !== true || m.enableOrderBook !== true) return 'This market is not accepting new orders.';
  if (m.negRisk === undefined || m.feeRate === null || !Number.isFinite(m.feeRate) || m.feeRate < 0) return 'Exchange or fee information is unavailable.';
  if (!Number.isFinite(Date.parse(m.endDate)) || !m.description.trim()) return 'Settlement rules or date are unavailable.';
  return null;
}
/** A single named condition needs no assumption about the other winners. */
function binaryUnavailable(event:GammaEvent,m:GammaMarket):string|null {
  if(m.outcomeLabels?.[0]?.toLowerCase()!=='yes'||m.outcomeLabels?.[1]?.toLowerCase()!=='no')return 'This condition does not have verified Yes/No outcomes.';
  const label=m.groupItemTitle.trim();
  const placeholder=/^(?:other(?:s| .*)?|(?:person|candidate|team|outcome|placeholder|slot)\s*(?:[a-z]|\d+)|tbd|to be (?:determined|announced)|unnamed.*)$/i;
  if(m.negRiskOther===true||placeholder.test(label))return 'Other and placeholder outcomes cannot be used for cover.';
  if(event.negRisk||m.negRisk){
    if(!event.negRisk||m.negRisk!==true||!event.negRiskMarketId||m.negRiskMarketId!==event.negRiskMarketId)return 'The named condition’s exchange group has not been verified.';
    if(event.negRiskAugmented!==false){
      // The venue must explicitly identify this as a non-Other condition. A
      // named label must also be grounded in the selected question, not a slot.
      if(m.negRiskOther!==false||!label||!m.question.toLowerCase().includes(label.toLowerCase()))return 'This outcome has not been verified as a named condition.';
    }
  }
  return null;
}
/** Initial proven categorical adapter: exhaustive FOMC change buckets, not a category allowlist. */
function fixedPartition(event: GammaEvent): boolean {
  if (!event.negRisk || event.negRiskAugmented !== false || !event.negRiskMarketId) return false;
  const expected = ['50+ bps decrease', '25 bps decrease', 'No change', '25 bps increase', '50+ bps increase'];
  const labels = new Set(event.markets.map(m => m.groupItemTitle));
  return labels.size === 5 && event.markets.length === 5 && expected.every(s => labels.has(s))
    && /Federal Open Market Committee/.test(event.description ?? '')
    && /rounded up to the nearest 25/.test(event.description ?? '')
    && /will resolve to the amount of basis points the upper bound/.test(event.description ?? '')
    && /will resolve to the "No change" bracket/.test(event.description ?? '')
    && /https:\/\/www\.federalreserve\.gov\/monetarypolicy\//.test(event.description ?? '')
    && new Set(event.markets.map(m => m.endDate)).size === 1
    && event.markets.every(m => m.negRisk === true && m.negRiskMarketId === event.negRiskMarketId
      && m.description === event.description && m.outcomeLabels?.[0] === 'Yes' && m.outcomeLabels[1] === 'No');
}
export function eventSupport(event: GammaEvent, selection: EventSelection): EventSupport {
  const markets = (selection.kind === 'binary' ? event.markets.filter(m => m.id === selection.marketId) : event.markets)
    .slice().sort((a,b) => a.id.localeCompare(b.id));
  let reason: string | null = markets.length ? null : 'Select a listed market.';
  if (selection.kind !== 'binary' && event.negRiskAugmented !== false) reason = 'Changing or unverified outcome sets are not supported.';
  if (selection.kind === 'binary' && markets.length !== 1) reason = 'Select one binary condition.';
  if (selection.kind === 'binary' && markets.length === 1) reason ??= binaryUnavailable(event,markets[0]!);
  if (selection.kind === 'categorical' && !fixedPartition(event)) reason = 'This categorical outcome partition has not been verified.';
  const ladder = selection.kind === 'numeric' ? parseLadder(markets.slice().sort((a,b) => (parseLadderLabel(a.groupItemTitle)?.lo ?? -Infinity) - (parseLadderLabel(b.groupItemTitle)?.lo ?? -Infinity)).map(m => m.groupItemTitle)) : null;
  if (selection.kind === 'numeric' && (!event.negRisk || !ladder || markets.length < 3 || markets.some(m => !m.negRisk || m.negRiskMarketId !== event.negRiskMarketId))) reason = 'This event is not a numeric partition.';
  // FOMC labels describe rounded decisions, not a continuous price partition.
  // Their published round-up rule differs from midpoint numeric brackets.
  if(selection.kind==='numeric' && markets.some(m=>/bps?\s+(decrease|increase|cut|hike)/i.test(m.groupItemTitle))) reason='Use the confirmed decision outcomes for this rounded-rate event.';
  if (new Set(markets.map(m => m.conditionId)).size !== markets.length
    || new Set(markets.flatMap(m => [m.yesTokenId,m.noTokenId])).size !== markets.length * 2) reason = 'Duplicate condition or token identity.';
  if (markets.length > 32) reason = 'This event exceeds the supported 32-outcome limit.';
  for (const m of markets) reason ??= unavailable(m);
  const outcomes: Outcome[] = markets.flatMap(m => selection.kind === 'binary'
    ? (['YES','NO'] as const).map((side,i) => ({ id:`${m.conditionId}:${side}`, label:m.outcomeLabels?.[i] ?? side, marketId:m.id, conditionId:m.conditionId ?? '', side, yesTokenId:m.yesTokenId, noTokenId:m.noTokenId, negRisk:m.negRisk === true }))
    : [{ id:m.id, label:m.groupItemTitle, marketId:m.id, conditionId:m.conditionId ?? '', side:'YES' as const, yesTokenId:m.yesTokenId, noTokenId:m.noTokenId, negRisk:m.negRisk === true }]);
  return { kind:selection.kind, eligible:reason === null, reason, ruleHash:ruleHash(event,selection), outcomes,
    rules:markets.map(m=>({marketId:m.id,description:m.description})), marketIds:markets.map(m => m.id), title:selection.kind === 'binary' ? markets[0]?.question ?? event.title : event.title,
    observationAt:markets[0]?.endDate ?? event.endDate, unit:ladder?.unit ?? '' };
}
