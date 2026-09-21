import { expect, it } from 'vitest';
import { evaluate, policies, type Scenario } from '../examples/hedge-benchmark/evaluate.js';
import { priceMicros } from '../packages/core/src/index.js';

const fixture: Scenario = {
  id: 'known-payout', budgetUsd: 30,
  items: [{ key: 'bad', bracket: { lo: null, hi: 80 } }, { key: 'good', bracket: { lo: 80, hi: null } }],
  shape: { templateId: 'threshold_digital', direction: 'below', k: 80, payoutUsd: 100 },
  legs: [{ id: 'bad-YES', marketId: 'bad', tokenId: 'bad-YES', label: 'bad', side: 'YES', tradableKey: 'bad' }],
  books: [[{ priceMicros: priceMicros(200_000), size: 100 }]], feeRates: [0.1],
};
const current = policies.find(p => p.id === 'current')!;

it('accounts for fees and premium in known outcomes and uses the same budget for baselines', async () => {
  const before = JSON.stringify(fixture);
  const result = await evaluate(fixture, current, 1);
  expect(result.quoted.costUsd).toBe(21.6);
  expect(result.quoted.worstUncoveredUsd).toBe(0);
  expect(result.quoted.worstNetLossUsd).toBe(21.6);
  expect(result.stressed).toEqual(result.quoted);
  const unhedged = await evaluate(fixture, policies[0]!);
  expect(unhedged.quoted.worstNetLossUsd).toBe(100);
  expect(unhedged.completion).toBe('no-orders');
  const limited = { ...fixture, budgetUsd: 10 };
  for (const policy of policies) {
    const row = await evaluate(limited, policy, 1);
    expect(row.quoted.costUsd).toBeLessThanOrEqual(limited.budgetUsd);
    expect(row.quoted.worstUncoveredUsd).toBeGreaterThan(53);
  }
  expect(JSON.stringify(fixture)).toBe(before);
});

it('does not reoptimize using future depth or credit a failed FOK with a payout', async () => {
  const unchanged = await evaluate(fixture, current, 1);
  const shocked = await evaluate(fixture, current, 0.5);
  expect(shocked.quoted).toEqual(unchanged.quoted);
  expect(shocked.completion).toBe('incomplete');
  expect(shocked.stressed.costUsd).toBe(0);
  expect(shocked.stressed.worstUncoveredUsd).toBe(100);
  const buffered = await evaluate(fixture, policies.find(p => p.id === 'depth-buffer')!, 0.5);
  expect(buffered.completion).toBe('complete');
  expect(buffered.stressed.worstUncoveredUsd).toBe(50);
  expect(buffered.stressed.costUsd).toBe(10.8);
  const repriced = await evaluate({ ...fixture, books: [[
    { priceMicros: priceMicros(100_000), size: 60 },
    { priceMicros: priceMicros(200_000), size: 200 },
  ]] }, current, 0.5);
  // Enough shares remain below the limit, but their total cost would exceed
  // the original quote. A price limit alone is not a budget guarantee.
  expect(repriced.quoted.worstUncoveredUsd).toBe(0);
  expect(repriced.completion).toBe('incomplete');
  expect(repriced.stressed.costUsd).toBe(0);
});

it('rejects malformed books instead of producing credible-looking results', async () => {
  await expect(evaluate({ ...fixture, feeRates: [] }, current)).rejects.toThrow('each leg');
  await expect(evaluate(fixture, current, 1.1)).rejects.toThrow('depth');
  await expect(evaluate({ ...fixture, books: [[
    { priceMicros: priceMicros(300_000), size: 10 },
    { priceMicros: priceMicros(200_000), size: 10 },
  ]] }, current)).rejects.toThrow('invalid asks');
});
