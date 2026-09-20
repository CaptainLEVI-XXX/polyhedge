import { isCategorical, payoutAt } from '@polyhedge/core';
import type { ConditionRecord, Micros, PayoutVector, SettlementBasket } from './types.js';

export function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}
export function validatePayout(payout: PayoutVector): void {
  integer(payout.yes, 'YES numerator'); integer(payout.no, 'NO numerator'); integer(payout.denominator, 'denominator');
  if (payout.denominator === 0 || BigInt(payout.yes) + BigInt(payout.no) !== BigInt(payout.denominator)) {
    throw new Error('Invalid finalized binary payout vector');
  }
}
export function entitlement(shares: Micros, numerator: number, denominator: number): Micros {
  integer(shares, 'shares'); integer(numerator, 'numerator'); integer(denominator, 'denominator');
  if (denominator === 0) throw new Error('Payout is not finalized');
  const result = Number(BigInt(shares) * BigInt(numerator) / BigInt(denominator));
  return integer(result, 'payout');
}
export interface SettlementAccounting {
  complete: boolean; payoutMicros: Micros; costMicros: Micros; netMicros: number;
  targetMicros: Micros | null; shortfallMicros: Micros | null;
  boundAssessment: 'within' | 'exceeded' | 'unknown' | 'outside_quote_model';
  reason: string | null;
}
export function accountBasket(basket: SettlementBasket, conditions: ConditionRecord[]): SettlementAccounting {
  const wanted = new Set(basket.positions.map(p => `${p.wallet.toLowerCase()}:${p.conditionId.toLowerCase()}`));
  const relevant = conditions.filter(c => wanted.has(c.key));
  const complete = wanted.size === relevant.length && relevant.every(c => c.phase === 'redeemed' || c.phase === 'lost' ||
    (c.payout && c.positions.filter(p => p.basketId === basket.id).every(p => p.sharesMicros === 0 || (p.outcome === 'YES' ? c.payout!.yes : c.payout!.no) === 0)));
  const payoutMicros = relevant.reduce((sum, c) => sum + c.redemptions.reduce((n, r) => n +
    (r.status === 'confirmed' ? r.allocations.filter(a => a.basketId === basket.id).reduce((a, b) => a + b.payoutMicros, 0) : 0), 0), 0);
  integer(payoutMicros, 'basket payout'); if (!Number.isSafeInteger(basket.costMicros)) throw new Error('Basket cost must be a safe integer');
  const netMicros = payoutMicros - basket.costMicros;
  if (!Number.isSafeInteger(netMicros)) throw new Error('Net result exceeds safe integer precision');
  const base = { complete, payoutMicros, costMicros: basket.costMicros, netMicros };
  const obs = basket.observation;
  let targetMicros: number | null = null;
  let reason: string | null = null;
  if (!obs) reason = 'Reference observation unavailable';
  else if (!Number.isFinite(obs.price) || obs.price < 0 || !Number.isFinite(Date.parse(obs.observedAt)) ||
    Date.parse(obs.observedAt) !== Date.parse(basket.expectedObservationAt) || obs.source !== basket.expectedSource) {
    reason = 'Reference observation does not match the accepted time and source';
  } else if (isCategorical(basket.quote.request.shape)) reason = 'Categorical target requires a verified realized outcome';
  else targetMicros = integer(Math.round(payoutAt(basket.quote.request.shape, obs.price) * 1_000_000), 'target');
  const shortfallMicros = complete && targetMicros !== null ? Math.max(0, targetMicros - payoutMicros) : null;
  const split = relevant.some(c => c.payout && c.payout.yes > 0 && c.payout.no > 0);
  if (split) return { ...base, targetMicros, shortfallMicros, boundAssessment: 'outside_quote_model', reason: 'Split/void resolution is outside the quoted ordinary partition model' };
  const actual = new Map<string, number>();
  for (const p of basket.positions) actual.set(p.tokenId, (actual.get(p.tokenId) ?? 0) + p.sharesMicros);
  const matchesQuote = basket.quote.basket.legs.every(l => (actual.get(l.tokenId) ?? 0) === Math.round(l.shares * 1_000_000)) &&
    [...actual.keys()].every(token => basket.quote.basket.legs.some(l => l.tokenId === token));
  if (!basket.executionComplete || !matchesQuote) return { ...base, targetMicros, shortfallMicros, boundAssessment: 'outside_quote_model', reason: 'Executed positions differ from the complete quoted basket' };
  if (!complete || shortfallMicros === null) return { ...base, targetMicros, shortfallMicros, boundAssessment: 'unknown', reason: reason ?? 'Conditions have not all settled' };
  const bound = basket.quote.basket.residual.worstStateShortfallCents * 10_000;
  return { ...base, targetMicros, shortfallMicros, boundAssessment: shortfallMicros <= bound ? 'within' : 'exceeded', reason: null };
}
