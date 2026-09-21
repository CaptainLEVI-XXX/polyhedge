import { describe, expect, it } from 'vitest';
import { accountBasket } from '../../packages/settlement/src/accounting.js';
import type { ConditionRecord, SettlementBasket } from '../../packages/settlement/src/types.js';
import { basketFixture, descriptor, key } from './fixtures.js';
function resolved(basket: SettlementBasket, payoutMicros: number): ConditionRecord {
  return { key, revision: 1, wallet: basket.wallet, ...descriptor, positions: basket.positions, phase: 'redeemed', payout: { yes: 1, no: 0, denominator: 1 }, history: [],
    redemptions: [{ id: 'r', status: 'confirmed', preparedAt: 'now', payout: { yes: 1, no: 0, denominator: 1 }, positions: basket.positions, balances: [], allocations: [{ basketId: basket.id, payoutMicros }], externalPayoutMicros: 0 }] };
}
describe('realized settlement accounting', () => {
  it('evaluates linear payout at actual reference price and compares shortfall as a bound separately from profit', async () => {
    const basket = await basketFixture();
    basket.quote.request.shape = { templateId: 'linear_strip', payoutUsd: 10, direction: 'below', k1: 80, k2: 100 };
    basket.observation = { price: 90, observedAt: basket.expectedObservationAt, source: basket.expectedSource };
    basket.quote.basket.residual.worstStateShortfallCents = 200 as never;
    const state = resolved(basket, 4_000_000);
    expect(accountBasket(basket, [state])).toMatchObject({ targetMicros: 5_000_000, shortfallMicros: 1_000_000, boundAssessment: 'within', netMicros: 2_000_000 });
    state.redemptions[0]!.allocations[0]!.payoutMicros = 2_000_000;
    expect(accountBasket(basket, [state]).boundAssessment).toBe('exceeded');
    basket.quote.request.shape = {templateId:'threshold_digital',payoutUsd:10,direction:'below',k:0};
    basket.observation.price=-5;
    expect(accountBasket(basket,[state]).targetMicros).toBe(10_000_000);
  });

  it('returns unknown for absent/mismatched observations and unresolved conditions', async () => {
    const basket = await basketFixture(); const state = resolved(basket, 10_000_000);
    expect(accountBasket(basket, [state]).targetMicros).toBeNull();
    for (const observation of [
      { price: 90, source: basket.expectedSource, observedAt: '2026-10-02T16:00:00Z' },
      { price: 90, source: 'another source', observedAt: basket.expectedObservationAt },
    ]) {
      basket.observation = observation;
      expect(accountBasket(basket, [state]).boundAssessment).toBe('unknown');
    }
    basket.observation = { price: 90, source: basket.expectedSource, observedAt: basket.expectedObservationAt };
    state.phase = 'redeemable'; state.redemptions = [];
    expect(accountBasket(basket, [state])).toMatchObject({ complete: false, targetMicros: 10_000_000, shortfallMicros: null, boundAssessment: 'unknown' });
  });

  it('flags split resolutions and changed execution quantities as outside the quoted model', async () => {
    const basket = await basketFixture();
    basket.observation = { price: 90, observedAt: basket.expectedObservationAt, source: basket.expectedSource };
    const state = resolved(basket, 5_000_000); state.payout = { yes: 1, no: 1, denominator: 2 };
    expect(accountBasket(basket, [state])).toMatchObject({ payoutMicros: 5_000_000, shortfallMicros: 5_000_000, boundAssessment: 'outside_quote_model' });
    state.payout = { yes: 1, no: 0, denominator: 1 };
    basket.positions[0]!.sharesMicros -= 1;
    expect(accountBasket(basket, [state]).boundAssessment).toBe('outside_quote_model');
  });
});
