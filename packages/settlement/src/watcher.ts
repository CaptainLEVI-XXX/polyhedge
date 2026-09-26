import { validatePayout } from './accounting.js';
import { transition } from './lifecycle.js';
import { persistCondition } from './redeem.js';
import type { ConditionRecord, SettlementDeps } from './types.js';

export async function pollCondition(key: string, deps: SettlementDeps): Promise<ConditionRecord> {
  return deps.store.withConditionLock(key, async () => {
    const condition = await deps.store.getCondition(key);
    if (!condition) throw new Error(`Unknown condition ${key}`);
    if (condition.phase === 'lost' || condition.phase === 'redeemed' || condition.phase === 'redeeming') return condition;
    const resolution = await deps.venue.resolution(condition);
    const now = deps.now?.() ?? new Date().toISOString();
    if (resolution.finalized) {
      if (!resolution.payout) throw new Error('Final resolution omitted payout vector');
      validatePayout(resolution.payout);
      if (condition.payout && JSON.stringify(condition.payout) !== JSON.stringify(resolution.payout)) throw new Error('Authoritative finalized payout changed');
      const hasPayout = condition.positions.some(p => p.sharesMicros > 0 &&
        (p.outcome === 'YES' ? resolution.payout!.yes : resolution.payout!.no) > 0);
      const phase = hasPayout ? 'redeemable' : 'lost';
      if (condition.phase === phase && condition.payout) return condition;
      return persistCondition(deps, { ...transition(condition, phase, now, 'Authoritative finalized payout'), payout: resolution.payout });
    }
    // A late proposal/closed/websocket message must never undo finality or regress to observing.
    if (condition.payout || resolution.stage === 'observing') return condition;
    const next = transition(condition, resolution.stage, now, 'Authoritative proposal/dispute status');
    return next === condition ? condition : persistCondition(deps, next);
  });
}

/** Websocket payloads are wake-ups only. Poll reads the same authoritative source after reconnect/restart. */
export async function onResolutionMessage(key: string, _untrustedPayload: unknown, deps: SettlementDeps): Promise<ConditionRecord> {
  return pollCondition(key, deps);
}
export async function pollPending(deps: SettlementDeps): Promise<Array<{ key: string; error?: string }>> {
  const result: Array<{ key: string; error?: string }> = [];
  for (const condition of await deps.store.listConditions()) {
    if (condition.phase === 'lost' || condition.phase === 'redeemed') continue;
    try { await pollCondition(condition.key, deps); result.push({ key: condition.key }); }
    catch (error) { result.push({ key: condition.key, error: String(error) }); }
  }
  return result;
}
