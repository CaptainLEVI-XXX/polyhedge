import { expect, it } from 'vitest';
import { buildBasket, buildStateSpace, cents, holdingProtectionShape, payoutAt, priceMicros,
  type BuildBasketArgs } from '../../packages/core/src/index.js';

const items = [{ key: 'bad', bracket: { lo: null, hi: 80 } }, { key: 'good', bracket: { lo: 80, hi: null } }];
const args: BuildBasketArgs = {
  shape: { templateId: 'threshold_digital', direction: 'below', k: 80, payoutUsd: 100 },
  stateSpace: buildStateSpace(items, [80]),
  legs: [{ id: 'bad-yes', marketId: 'bad', tokenId: 'bad-yes', label: 'bad', tradableKey: 'bad', side: 'YES' }],
  books: [[{ priceMicros: priceMicros(200_000), size: 1000 }]], feeRates: [0],
  budgetCents: null, ruleFlags: [], correlationResidual: false,
};

it('optimizes in tradeable increments and rejects orders below the venue minimum', async () => {
  const input: BuildBasketArgs = { ...args, budgetCents: cents(100),
    books: [[{ priceMicros: priceMicros(333_333), size: 1000 }]],
    protectionGoal: { kind: 'minimize_net_loss' }, execution: { quantityStep: 0.01, minShares: [1] } };
  const quoted = await buildBasket(input);
  expect(quoted.legs[0]!.shares).toBe(3);
  expect(quoted.totalCostCents).toBe(100);
  const tooSmall = await buildBasket({ ...input, execution: { quantityStep: 0.01, minShares: [5] } });
  expect(tooSmall.totalCostCents).toBe(0);
  expect(tooSmall.legs[0]!.shares).toBe(0);
  await expect(buildBasket({ ...input, forceSharesForTest: [3.001] })).rejects.toThrow(/order size/);
});

it('honours a position-count cap without pretending unchanged protection', async () => {
  const three = [{ key: 'bad', bracket: { lo: null, hi: 80 } },
    { key: 'other-bad', bracket: { lo: 80, hi: 100 } }, { key: 'good', bracket: { lo: 100, hi: null } }];
  const input: BuildBasketArgs = { ...args,
    shape: { templateId: 'threshold_digital', payoutUsd: 100, direction: 'below', k: 100 },
    stateSpace: buildStateSpace(three, [100]),
    legs: ['bad', 'other-bad'].map(key => ({ ...args.legs[0]!, id: key, tokenId: key, tradableKey: key })),
    books: [args.books[0]!, args.books[0]!], feeRates: [0, 0],
    protectionGoal: { kind: 'minimize_net_loss' } };
  const two = await buildBasket({ ...input, execution: { quantityStep: 0.01, minShares: [5, 5], maxLegs: 2 } });
  const one = await buildBasket({ ...input, execution: { quantityStep: 0.01, minShares: [5, 5], maxLegs: 1 } });
  expect(two.worstNetLossCents).toBe(4000);
  expect(one.legs.filter(l => l.shares > 0).length).toBeLessThanOrEqual(1);
  expect(one.worstNetLossCents).toBe(10_000);
});

it('derives long and short capped loss layers from explicit units and deductibles', () => {
  const holding = { quantity: 1, referencePriceUsd: 100_000, position: 'long' as const,
    deductibleUsd: 10_000, payoutCapUsd: 20_000, protectionFraction: 1 };
  const shape = holdingProtectionShape(holding);
  expect([100_000, 90_000, 80_000, 70_000, 60_000].map(p => payoutAt(shape, p)))
    .toEqual([0, 0, 10_000, 20_000, 20_000]);
  const short = holdingProtectionShape({ ...holding, position: 'short', protectionFraction: 0.5 });
  expect([100_000, 110_000, 130_000, 150_000].map(p => payoutAt(short, p))).toEqual([0, 0, 10_000, 20_000]);
  expect(() => holdingProtectionShape({ ...holding, quantity: 0 })).toThrow();
});

it('minimizes premium-inclusive loss and finds the least cost for a requested limit', async () => {
  const best = await buildBasket({ ...args, protectionGoal: { kind: 'minimize_net_loss' } });
  expect(best.totalCostCents).toBe(2000);
  expect(best.worstNetLossCents).toBe(2000);
  const limited = await buildBasket({ ...args, protectionGoal: { kind: 'limit_net_loss', maxNetLossUsd: 40 } });
  expect(limited.legs[0]!.shares).toBeCloseTo(75, 5);
  expect(limited.totalCostCents).toBe(1500);
  expect(limited.worstNetLossCents).toBe(4000);
  await expect(buildBasket({ ...args, budgetCents: cents(1000),
    protectionGoal: { kind: 'limit_net_loss', maxNetLossUsd: 40 } })).rejects.toThrow(/Infeasible/);
});

it('chooses no hedge when buying gross cover would increase worst net loss', async () => {
  const three = [...items.slice(0, 1), { key: 'other-bad', bracket: { lo: 80, hi: 100 } },
    { key: 'good', bracket: { lo: 100, hi: null } }];
  const expensive: BuildBasketArgs = { ...args,
    shape: { templateId: 'threshold_digital', direction: 'below', k: 100, payoutUsd: 100 },
    stateSpace: buildStateSpace(three, [100]),
    legs: ['bad', 'other-bad'].map(key => ({ ...args.legs[0]!, id: key, tokenId: key, tradableKey: key })),
    books: [0, 1].map(() => [{ priceMicros: priceMicros(900_000), size: 100 }]), feeRates: [0, 0],
  };
  const original = await buildBasket(expensive);
  expect(original.totalCostCents).toBe(18_000);
  const net = await buildBasket({ ...expensive, protectionGoal: { kind: 'minimize_net_loss' } });
  expect(net.totalCostCents).toBe(0);
  expect(net.worstNetLossCents).toBe(10_000);
});
