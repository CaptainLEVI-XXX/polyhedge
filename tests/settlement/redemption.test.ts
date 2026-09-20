import { describe, expect, it } from 'vitest';
import { allocateRedemption, redeemCondition } from '../../packages/settlement/src/redeem.js';
import { registerBasket, basketStatus, settlementFor } from '../../packages/settlement/src/service.js';
import { pollCondition } from '../../packages/settlement/src/watcher.js';
import type { RedemptionRecord, RedemptionReceipt } from '../../packages/settlement/src/types.js';
import { basketFixture, descriptor, harness, key } from './fixtures.js';

const receipt = (amount: number): RedemptionReceipt => ({ verified: true, transactionHash: 'tx', wallet: 'wallet', conditionId: 'cA', payoutMicros: amount });
function snapshot(yes = 1, no = 0, denominator = 1): RedemptionRecord {
  return { id: 'r', status: 'prepared', preparedAt: 'now', payout: { yes, no, denominator }, allocations: [], externalPayoutMicros: 0,
    balances: [{ tokenId: 'y', outcome: 'YES', sharesMicros: 100_000_000 }, { tokenId: 'n', outcome: 'NO', sharesMicros: 40_000_000 }],
    positions: [
      { basketId: 'yes-basket', wallet: 'wallet', conditionId: 'cA', tokenId: 'y', outcome: 'YES', sharesMicros: 60_000_000 },
      { basketId: 'no-basket', wallet: 'wallet', conditionId: 'cA', tokenId: 'n', outcome: 'NO', sharesMicros: 40_000_000 },
    ],
  };
}
describe('redemption attribution and recovery', () => {
  it('allocates by each outcome entitlement and keeps external holdings outside the baskets', () => {
    expect(allocateRedemption(snapshot(), receipt(100_000_000))).toEqual({
      allocations: [{ basketId: 'no-basket', payoutMicros: 0 }, { basketId: 'yes-basket', payoutMicros: 60_000_000 }], externalPayoutMicros: 40_000_000,
    });
    expect(allocateRedemption(snapshot(1, 1, 2), receipt(70_000_000))).toEqual({
      allocations: [{ basketId: 'no-basket', payoutMicros: 20_000_000 }, { basketId: 'yes-basket', payoutMicros: 30_000_000 }], externalPayoutMicros: 20_000_000,
    });
    expect(() => allocateRedemption(snapshot(), receipt(99_000_000))).toThrow('differs from snapshot');
    const missing = snapshot(); missing.balances[0]!.sharesMicros = 1;
    expect(() => allocateRedemption(missing, receipt(1))).toThrow('below attributed');
  });

  it('preserves micro-unit totals for split payouts and rejects invalid payout vectors', () => {
    const tiny = snapshot(1, 1, 2);
    tiny.balances[0]!.sharesMicros = 3;
    tiny.balances[1]!.sharesMicros = 0;
    tiny.positions = [1, 2].map(i => ({ basketId: `b${i}`, wallet: 'wallet', conditionId: 'cA', tokenId: 'y', outcome: 'YES', sharesMicros: 1 }));
    const allocations = allocateRedemption(tiny, receipt(1));
    expect(allocations.externalPayoutMicros + allocations.allocations.reduce((n, a) => n + a.payoutMicros, 0)).toBe(1);
    tiny.payout.denominator = 0;
    expect(() => allocateRedemption(tiny, receipt(1))).toThrow('payout vector');
  });

  it('persists the full snapshot before submission; concurrent calls reconcile a timeout without duplicate redemption', async () => {
    let calls = 0;
    const deps = harness();
    deps.venue.prepare = async () => ({ kind: 'signed-transaction', data: { nonce: 7, bytes: '0x1234' } });
    deps.venue.submit = async (_condition, redemption) => {
      calls++;
      const persisted = await deps.store.getCondition(key);
      expect(persisted!.redemptions[0]).toEqual(redemption);
      expect(persisted!.redemptions[0]!.transportEnvelope).toEqual({ kind: 'signed-transaction', data: { nonce: 7, bytes: '0x1234' } });
      expect(persisted!.phase).toBe('redeeming');
      throw new Error('connection lost after acceptance');
    };
    await registerBasket(await basketFixture(), [descriptor], deps);
    await pollCondition(key, deps);
    const [first, second] = await Promise.all([redeemCondition(key, deps), redeemCondition(key, deps)]);
    expect(first.redemptions[0]!.status).toBe('unknown');
    expect(second.phase).toBe('redeemed');
    expect(calls).toBe(1);
    expect((await redeemCondition(key, deps)).revision).toBe(second.revision);
  });

  it('retries only definite failure, with explicit authorization, and verifies external receipts', async () => {
    let calls = 0;
    const deps = harness({ submit: async () => { calls++; return { status: 'failed', reason: 'reverted' }; } });
    await registerBasket(await basketFixture(), [descriptor], deps);
    await pollCondition(key, deps);
    await redeemCondition(key, deps);
    await redeemCondition(key, deps);
    expect(calls).toBe(1);
    deps.venue.submit = async () => { calls++; return { status: 'pending', submissionId: 'second' }; };
    await redeemCondition(key, deps, { retryFailed: true });
    expect(calls).toBe(2);
    deps.venue.reconcile = async () => ({ status: 'unknown', reason: 'external transaction' });
    deps.venue.findExternalReceipt = async () => receipt(10_000_000);
    expect((await redeemCondition(key, deps)).phase).toBe('redeemed');
    expect(calls).toBe(2);
  });

  it('reserves a shared wallet nonce across conditions and across restart until reconciliation', async () => {
    let prepares = 0; let submissions = 0;
    const deps = harness();
    deps.venue.prepare = async () => ({ kind: 'signed', data: { nonce: ++prepares } });
    deps.venue.submit = async () => { submissions++; return { status: 'pending', submissionId: `s${submissions}` }; };
    deps.venue.balances = async c => [
      { tokenId: c.yesTokenId, outcome: 'YES', sharesMicros: 10_000_000 },
      { tokenId: c.noTokenId, outcome: 'NO', sharesMicros: 0 },
    ];
    await registerBasket(await basketFixture('first'), [descriptor], deps);
    const second = await basketFixture('second');
    second.positions[0] = { ...second.positions[0]!, conditionId: 'cB', tokenId: 'bYES' };
    const secondDescriptor = { ...descriptor, conditionId: 'cB', yesTokenId: 'bYES', noTokenId: 'bNO' };
    await registerBasket(second, [secondDescriptor], deps);
    const secondKey = 'wallet:cb';
    await pollCondition(key, deps); await pollCondition(secondKey, deps);
    const attempts = await Promise.allSettled([redeemCondition(key, deps), redeemCondition(secondKey, deps)]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(prepares).toBe(1); expect(submissions).toBe(1);
    // A fresh service/deps instance still sees the durable pending record.
    await expect(redeemCondition(secondKey, { ...deps })).rejects.toThrow('outstanding redemption');
    await redeemCondition(key, deps); // verified receipt releases the wallet nonce
    await redeemCondition(secondKey, deps);
    expect(prepares).toBe(2); expect(submissions).toBe(2);
  });

  it('never attributes an unverified or wrong-wallet receipt', async () => {
    const deps = harness({ submit: async () => ({ status: 'confirmed', submissionId: 'bad', receipt: { ...receipt(10_000_000), wallet: 'another-wallet' } }) });
    await registerBasket(await basketFixture(), [descriptor], deps);
    await pollCondition(key, deps);
    await expect(redeemCondition(key, deps)).rejects.toThrow('not verified');
    expect((await deps.store.getCondition(key))!.redemptions[0]!.allocations).toEqual([]);
    expect((await deps.store.getCondition(key))!.phase).toBe('redeeming');
  });

  it('shares one condition redemption across baskets and closes its losing basket before that redemption', async () => {
    const deps = harness();
    const winner = await basketFixture('winner');
    const loser = await basketFixture('loser');
    loser.positions[0] = { ...loser.positions[0]!, outcome: 'NO', tokenId: 'aNO' };
    await registerBasket(winner, [descriptor], deps);
    await registerBasket(loser, [descriptor], deps);
    await pollCondition(key, deps);
    expect((await basketStatus('loser', deps)).state).toBe('lost');
    expect((await settlementFor('loser', deps)).complete).toBe(true);
    deps.venue.balances = async () => [{ tokenId: 'aYES', outcome: 'YES', sharesMicros: 10_000_000 }, { tokenId: 'aNO', outcome: 'NO', sharesMicros: 10_000_000 }];
    await redeemCondition(key, deps);
    await redeemCondition(key, deps);
    expect((await settlementFor('winner', deps)).payoutMicros).toBe(10_000_000);
    expect((await settlementFor('loser', deps)).payoutMicros).toBe(0);
    expect((await deps.store.getCondition(key))!.redemptions).toHaveLength(1);
  });
});
