import type { BasketState, ConditionPhase, ConditionRecord } from './types.js';

const allowed: Record<ConditionPhase, readonly ConditionPhase[]> = {
  observing: ['proposed', 'disputed', 'redeemable', 'lost'],
  proposed: ['disputed', 'redeemable', 'lost'],
  disputed: ['proposed', 'redeemable', 'lost'],
  redeemable: ['redeeming', 'lost'],
  redeeming: ['redeemable', 'redeemed'],
  redeemed: [], lost: [],
};
export function transition(record: ConditionRecord, next: ConditionPhase, at: string, reason: string): ConditionRecord {
  if (record.phase === next) return record;
  if (!allowed[record.phase].includes(next)) throw new Error(`Illegal settlement transition ${record.phase} -> ${next}`);
  return { ...record, phase: next, history: [...record.history, { at, from: record.phase, to: next, reason }] };
}
export function basketState(conditions: ConditionRecord[], executionComplete: boolean): BasketState {
  if (conditions.length === 0) return executionComplete ? 'filled' : 'partial';
  if (conditions.every(c => c.phase === 'lost')) return 'lost';
  if (conditions.every(c => c.phase === 'lost' || c.phase === 'redeemed')) return 'redeemed';
  for (const phase of ['redeeming', 'disputed', 'redeemable', 'proposed'] as const) {
    if (conditions.some(c => c.phase === phase)) return phase;
  }
  return executionComplete ? 'observing' : 'partial';
}
