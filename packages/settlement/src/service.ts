import { accountBasket, integer } from './accounting.js';
import { basketState } from './lifecycle.js';
import { redeemCondition, persistCondition } from './redeem.js';
import { pollCondition } from './watcher.js';
import type { ConditionRecord, ReferenceObservation, SettlementBasket, SettlementDeps } from './types.js';

export interface ConditionDescriptor {
  conditionId: string; negRisk: boolean; yesTokenId: string; noTokenId: string;
}
export function conditionKey(wallet: string, conditionId: string): string {
  return `${wallet.toLowerCase()}:${conditionId.toLowerCase()}`;
}
export async function registerBasket(basket: SettlementBasket, descriptors: ConditionDescriptor[], deps: SettlementDeps): Promise<void> {
  if (!basket.id || !basket.wallet || !Number.isFinite(Date.parse(basket.expectedObservationAt)) || !basket.expectedSource) throw new Error('Basket requires identity and accepted reference observation');
  if (!Number.isSafeInteger(basket.costMicros)) throw new Error('Cost must be a safe integer');
  for (const p of basket.positions) {
    integer(p.sharesMicros, 'shares');
    if (p.basketId !== basket.id || p.wallet.toLowerCase() !== basket.wallet.toLowerCase()) throw new Error('Position does not belong to basket/wallet');
    const descriptor = descriptors.find(c => c.conditionId.toLowerCase() === p.conditionId.toLowerCase());
    if (!descriptor || p.tokenId !== (p.outcome === 'YES' ? descriptor.yesTokenId : descriptor.noTokenId)) throw new Error('Position lacks matching condition metadata');
  }
  const required = new Set(basket.quote.resolved.domain?.outcomes.map(o => o.conditionId.toLowerCase()) ?? []);
  for (const o of basket.quote.resolved.domain?.outcomes ?? []) {
    const d=descriptors.find(d=>d.conditionId.toLowerCase()===o.conditionId.toLowerCase());
    if(!d || d.yesTokenId!==o.yesTokenId || d.noTokenId!==o.noTokenId || d.negRisk!==o.negRisk) throw new Error('Missing accepted outcome observation metadata');
  }
  const existingBasket = await deps.store.getBasket(basket.id);
  const identity = (b: SettlementBasket) => { const { revision: _revision, observation: _observation, ...fixed } = b; return JSON.stringify(fixed); };
  if (existingBasket && identity(existingBasket) !== identity(basket)) throw new Error('Basket identity already registered with different data');
  // Reserve the immutable identity before any condition mutation. A conflicting concurrent
  // registration must lose this CAS before it can leave ghost attributed positions.
  if (!existingBasket) await deps.store.saveBasket({ ...basket, revision: 0 }, null);
  // A retry of the same identity resumes missing condition registrations after a crash.
  for (const descriptor of descriptors) {
    const positions = basket.positions.filter(p => p.conditionId.toLowerCase() === descriptor.conditionId.toLowerCase());
    if (!positions.length && !required.has(descriptor.conditionId.toLowerCase())) continue;
    const key = conditionKey(basket.wallet, descriptor.conditionId);
    await deps.store.withConditionLock(key, async () => {
      const current = await deps.store.getCondition(key);
      if (!current) {
        await deps.store.saveCondition({ key, revision: 0, wallet: basket.wallet, ...descriptor, positions, phase: 'observing', history: [], redemptions: [] }, null);
        return;
      }
      if (current.yesTokenId !== descriptor.yesTokenId || current.noTokenId !== descriptor.noTokenId || current.negRisk !== descriptor.negRisk) throw new Error('Condition metadata changed');
      const registered = current.positions.filter(p => p.basketId === basket.id);
      if (registered.length) {
        if (JSON.stringify(registered) !== JSON.stringify(positions)) throw new Error('Registered position quantities changed');
        return;
      }
      if (!positions.length) return;
      if (current.payout || current.redemptions.length) throw new Error('Cannot add holdings after settlement started');
      await persistCondition(deps, { ...current, positions: [...current.positions, ...positions] });
    });
  }
}
async function loadBasket(id: string, deps: SettlementDeps) {
  const basket = await deps.store.getBasket(id);
  if (!basket) throw new Error(`Unknown basket ${id}`);
  const keys = [...new Set([...basket.positions.map(p => conditionKey(p.wallet, p.conditionId)), ...(basket.quote.resolved.domain?.outcomes.map(o => conditionKey(basket.wallet,o.conditionId)) ?? [])])];
  const conditions: ConditionRecord[] = [];
  for (const key of keys) {
    const c = await deps.store.getCondition(key);
    if (!c) throw new Error(`Missing condition ${key}`);
    const expected = basket.positions.filter(p => conditionKey(p.wallet, p.conditionId) === key);
    const registered = c.positions.filter(p => p.basketId === basket.id);
    if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`Basket registration is incomplete for condition ${key}`);
    conditions.push(c);
  }
  return { basket, conditions };
}
export async function basketStatus(id: string, deps: SettlementDeps) {
  const { basket, conditions } = await loadBasket(id, deps);
  // A losing basket closes even when another basket owns the winning side of the same condition.
  const own = conditions.map(c => c.payout && c.positions.filter(p => p.basketId === id).every(p =>
    p.sharesMicros === 0 || (p.outcome === 'YES' ? c.payout!.yes : c.payout!.no) === 0)
    ? { ...c, phase: 'lost' as const } : c);
  return { basketId: id, state: basketState(own, basket.executionComplete), conditions };
}
export async function redemptionFor(id: string, deps: SettlementDeps) {
  const { conditions } = await loadBasket(id, deps);
  return conditions.flatMap(c => c.redemptions.filter(r => r.positions.some(p => p.basketId === id)).map(r => ({ conditionId: c.conditionId, ...r })));
}
export async function settlementFor(id: string, deps: SettlementDeps) {
  const { basket, conditions } = await loadBasket(id, deps);
  return accountBasket(basket, conditions);
}
export async function recordObservation(id: string, observation: ReferenceObservation, deps: SettlementDeps): Promise<void> {
  const { basket } = await loadBasket(id, deps);
  await deps.store.saveBasket({ ...basket, observation, revision: basket.revision + 1 }, basket.revision);
}
/** Reconcile only already-authorized redemptions on startup; new submissions require redeemCondition. */
export async function resumeSettlement(deps: SettlementDeps): Promise<Array<{ key: string; error?: string }>> {
  const results: Array<{ key: string; error?: string }> = [];
  for (const condition of await deps.store.listConditions()) {
    if (condition.phase === 'lost' || condition.phase === 'redeemed') continue;
    try {
      if (condition.phase === 'redeeming') await redeemCondition(condition.key, deps);
      else await pollCondition(condition.key, deps);
      results.push({ key: condition.key });
    } catch (error) { results.push({ key: condition.key, error: String(error) }); }
  }
  return results;
}
