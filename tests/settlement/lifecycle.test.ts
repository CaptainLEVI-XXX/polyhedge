import { describe, expect, it } from 'vitest';
import { registerBasket, basketStatus, resumeSettlement, recordObservation, settlementFor } from '../../packages/settlement/src/service.js';
import { onResolutionMessage, pollCondition } from '../../packages/settlement/src/watcher.js';
import { redeemCondition } from '../../packages/settlement/src/redeem.js';
import { transition } from '../../packages/settlement/src/lifecycle.js';
import { basketFixture, descriptor, harness, key } from './fixtures.js';

describe('settlement lifecycle', () => {
  it('treats WS/closed events only as wake-ups, tracks disputes and finality idempotently', async () => {
    const deps = harness({ resolution: async () => ({ finalized: false, stage: 'proposed' }) });
    await registerBasket(await basketFixture(), [descriptor], deps);
    let state = await onResolutionMessage(key, { closed: true, winner: 'YES' }, deps);
    expect(state.phase).toBe('proposed');
    await expect(redeemCondition(key, deps)).rejects.toThrow('not authoritatively redeemable');
    deps.venue.resolution = async () => ({ finalized: false, stage: 'disputed' });
    expect((await pollCondition(key, deps)).phase).toBe('disputed');
    deps.venue.resolution = async () => ({ finalized: false, stage: 'proposed' });
    expect((await pollCondition(key, deps)).phase).toBe('proposed');
    deps.venue.resolution = async () => ({ finalized: true, stage: 'proposed', payout: { yes: 1, no: 0, denominator: 1 } });
    state = await pollCondition(key, deps);
    expect(state.phase).toBe('redeemable');
    expect(await pollCondition(key, deps)).toEqual(state);
    deps.venue.resolution = async () => ({ finalized: false, stage: 'observing' });
    expect(await pollCondition(key, deps)).toEqual(state);
    expect(() => transition(state, 'observing', 'now', 'bad')).toThrow('redeemable -> observing');
  });

  it('polls missed resolution on restart and closes a loser without submitting', async () => {
    let submissions = 0;
    const deps = harness({ resolution: async () => ({ finalized: true, stage: 'proposed', payout: { yes: 0, no: 1, denominator: 1 } }),
      submit: async () => { submissions++; throw new Error('must not submit'); } });
    await registerBasket(await basketFixture(), [descriptor], deps);
    await resumeSettlement(deps);
    expect((await basketStatus('basket', deps)).state).toBe('lost');
    await redeemCondition(key, deps);
    expect(submissions).toBe(0);
    expect((await settlementFor('basket', deps)).complete).toBe(true);
    expect((await settlementFor('basket', deps)).payoutMicros).toBe(0);
  });

  it('reserves basket identity before positions and resumes a crash without ghost attribution', async () => {
    const deps = harness(); const basket = await basketFixture();
    const save = deps.store.saveCondition.bind(deps.store);
    deps.store.saveCondition = async () => { throw new Error('database interrupted'); };
    await expect(registerBasket(basket, [descriptor], deps)).rejects.toThrow('database interrupted');
    expect(await deps.store.getBasket(basket.id)).not.toBeNull();
    await expect(basketStatus(basket.id, deps)).rejects.toThrow('Missing condition');
    const conflicting = structuredClone(basket);
    conflicting.positions[0]!.sharesMicros += 1;
    await expect(registerBasket(conflicting, [descriptor], deps)).rejects.toThrow('different data');
    expect(await deps.store.listConditions()).toEqual([]);
    deps.store.saveCondition = save;
    await registerBasket(basket, [descriptor], deps);
    expect((await deps.store.getCondition(key))!.positions).toEqual(basket.positions);
    const another = await basketFixture('concurrent');
    const changed = structuredClone(another); changed.positions[0]!.sharesMicros += 10;
    const result = await Promise.allSettled([registerBasket(another, [descriptor], deps), registerBasket(changed, [descriptor], deps)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await deps.store.getCondition(key))!.positions.filter(p => p.basketId === 'concurrent')).toEqual(another.positions);
    await pollCondition(key, deps);
    const late = await basketFixture('late');
    await expect(registerBasket(late, [descriptor], deps)).rejects.toThrow('settlement started');
    // A reserved identity whose positions were never added is not a losing basket.
    await expect(settlementFor(late.id, deps)).rejects.toThrow('registration is incomplete');
  });

  it('runs real quote through fill registration, observation, confirmed redemption and accounting', async () => {
    const deps = harness();
    const basket = await basketFixture();
    await registerBasket(basket, [descriptor], deps);
    await registerBasket(basket, [descriptor], deps); // duplicate fill registration is harmless
    await recordObservation(basket.id, { price: 90, observedAt: basket.expectedObservationAt, source: basket.expectedSource }, deps);
    await pollCondition(key, deps);
    expect((await redeemCondition(key, deps)).phase).toBe('redeeming');
    expect((await basketStatus(basket.id, deps)).state).toBe('redeeming');
    await resumeSettlement(deps);
    const final = await settlementFor(basket.id, deps);
    expect((await basketStatus(basket.id, deps)).state).toBe('redeemed');
    expect(final).toMatchObject({ complete: true, payoutMicros: 10_000_000, targetMicros: 10_000_000, shortfallMicros: 0, boundAssessment: 'within', netMicros: 8_000_000 });
    expect((await deps.store.getCondition(key))!.history.map(h => h.to)).toEqual(['redeemable', 'redeeming', 'redeemed']);
  });
});
