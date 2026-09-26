import { randomUUID } from 'node:crypto';
import { entitlement, integer, validatePayout } from './accounting.js';
import { transition } from './lifecycle.js';
import type { BalanceSnapshot, ConditionRecord, RedemptionReceipt, RedemptionRecord, SettlementDeps, SubmissionResult } from './types.js';

/** Allocate each token's proceeds separately, including holdings owned outside PolyHedge. */
export function allocateRedemption(record: RedemptionRecord, receipt: RedemptionReceipt): Pick<RedemptionRecord, 'allocations' | 'externalPayoutMicros'> {
  validatePayout(record.payout);
  integer(receipt.payoutMicros, 'receipt payout');
  const allocations = new Map<string, number>();
  let externalPayoutMicros = 0;
  let expectedTotal = 0;
  for (const balance of record.balances) {
    integer(balance.sharesMicros, 'wallet balance');
    const numerator = balance.outcome === 'YES' ? record.payout.yes : record.payout.no;
    const total = entitlement(balance.sharesMicros, numerator, record.payout.denominator);
    expectedTotal += total;
    const owners = new Map<string, number>();
    for (const p of record.positions.filter(p => p.tokenId === balance.tokenId)) {
      if (p.outcome !== balance.outcome) throw new Error('Token outcome mismatch');
      integer(p.sharesMicros, 'attributed shares');
      owners.set(p.basketId, integer((owners.get(p.basketId) ?? 0) + p.sharesMicros, 'owned shares'));
    }
    const owned = [...owners.values()].reduce((a, b) => a + b, 0);
    if (owned > balance.sharesMicros) throw new Error('Wallet balance is below attributed positions; reconcile transfers before redemption');
    const parts = [...owners.entries()].map(([basketId, shares]) => ({ basketId: basketId as string | null, shares }));
    parts.push({ basketId: null, shares: balance.sharesMicros - owned });
    const den = BigInt(record.payout.denominator);
    const rows = parts.map(p => {
      const raw = BigInt(p.shares) * BigInt(numerator);
      return { ...p, amount: Number(raw / den), remainder: raw % den };
    });
    let remaining = total - rows.reduce((a, b) => a + b.amount, 0);
    rows.sort((a, b) => a.remainder === b.remainder ? (a.basketId ?? '').localeCompare(b.basketId ?? '') : a.remainder > b.remainder ? -1 : 1);
    for (const row of rows) {
      if (remaining > 0) { row.amount += 1; remaining -= 1; }
      if (row.basketId === null) externalPayoutMicros += row.amount;
      else allocations.set(row.basketId, (allocations.get(row.basketId) ?? 0) + row.amount);
    }
  }
  if (record.positions.some(p => !record.balances.some(b => b.tokenId === p.tokenId))) throw new Error('Snapshot omits an attributed token');
  integer(expectedTotal, 'expected payout');
  if (receipt.payoutMicros !== expectedTotal) throw new Error(`Receipt payout ${receipt.payoutMicros} differs from snapshot entitlement ${expectedTotal}`);
  return { allocations: [...allocations].map(([basketId, payoutMicros]) => ({ basketId, payoutMicros })).sort((a, b) => a.basketId.localeCompare(b.basketId)), externalPayoutMicros };
}
function checkBalances(condition: ConditionRecord, balances: BalanceSnapshot[]): void {
  if (balances.length !== 2 || new Set(balances.map(b => b.tokenId)).size !== 2) throw new Error('Expected exactly one balance for each outcome');
  for (const b of balances) {
    const expectedId = b.outcome === 'YES' ? condition.yesTokenId : condition.noTokenId;
    if (b.tokenId !== expectedId) throw new Error('Balance token does not match condition');
    integer(b.sharesMicros, 'balance');
  }
}
export async function persistCondition(deps: SettlementDeps, record: ConditionRecord): Promise<ConditionRecord> {
  const updated = { ...record, revision: record.revision + 1 };
  await deps.store.saveCondition(updated, record.revision);
  return updated;
}
async function applyResult(deps: SettlementDeps, condition: ConditionRecord, redemption: RedemptionRecord, result: SubmissionResult): Promise<ConditionRecord> {
  let updated: RedemptionRecord;
  let next = condition;
  const at = deps.now?.() ?? new Date().toISOString();
  if (result.status === 'confirmed') {
    const receipt = result.receipt;
    if (!receipt.verified || !receipt.transactionHash || receipt.wallet.toLowerCase() !== condition.wallet.toLowerCase() || receipt.conditionId.toLowerCase() !== condition.conditionId.toLowerCase()) {
      throw new Error('Redemption receipt is not verified for this wallet and condition');
    }
    const allocation = allocateRedemption(redemption, receipt);
    updated = { ...redemption, status: 'confirmed', submissionId: result.submissionId, receipt, ...allocation };
    next = transition(condition, 'redeemed', at, 'Verified redemption receipt');
  } else if (result.status === 'pending') updated = { ...redemption, status: 'pending', submissionId: result.submissionId };
  else {
    updated = { ...redemption, status: result.status, error: result.reason };
    if (result.status === 'failed') next = transition(condition, 'redeemable', at, 'Submission definitively failed; explicit retry permitted');
  }
  return persistCondition(deps, { ...next, redemptions: condition.redemptions.map(r => r.id === redemption.id ? updated : r) });
}

/** Creates a durable attribution snapshot before submitting. Repeated calls reconcile; they never blindly resubmit. */
export async function redeemCondition(key: string, deps: SettlementDeps, options: { retryFailed?: boolean } = {}): Promise<ConditionRecord> {
  const registered = await deps.store.getCondition(key);
  if (!registered) throw new Error(`Unknown condition ${key}`);
  return deps.store.withWalletLock(registered.wallet, () => deps.store.withConditionLock(key, async () => {
    let condition = await deps.store.getCondition(key);
    if (!condition) throw new Error(`Unknown condition ${key}`);
    if (condition.phase === 'lost' || condition.phase === 'redeemed') return condition;
    if (!condition.payout || !['redeemable', 'redeeming'].includes(condition.phase)) throw new Error('Condition is not authoritatively redeemable');
    validatePayout(condition.payout);
    const prior = condition.redemptions.at(-1);
    if (prior && prior.status !== 'failed') {
      let result: SubmissionResult;
      try { result = await deps.venue.reconcile(condition, prior); }
      catch (error) { result = { status: 'unknown', reason: String(error) }; }
      if (result.status !== 'confirmed' && deps.venue.findExternalReceipt) {
        const receipt = await deps.venue.findExternalReceipt(condition, prior);
        if (receipt) result = { status: 'confirmed', submissionId: prior.submissionId ?? prior.id, receipt };
      }
      return applyResult(deps, condition, prior, result);
    }
    if (prior && !options.retryFailed) return condition;
    // A database lock ends after submission, but a wallet nonce remains reserved while
    // the submitted transaction is unresolved. Preserve that exclusion across restarts.
    const outstanding = (await deps.store.listConditions()).find(other =>
      other.key !== key && other.wallet.toLowerCase() === condition!.wallet.toLowerCase() &&
      (other.phase === 'redeeming' || other.redemptions.some(r => ['prepared', 'pending', 'unknown'].includes(r.status))));
    if (outstanding) throw new Error(`Wallet has an outstanding redemption for ${outstanding.conditionId}; reconcile it before preparing another condition`);
    const balances = await deps.venue.balances(condition);
    checkBalances(condition, balances);
    let redemption: RedemptionRecord = {
      id: deps.newId?.() ?? randomUUID(), status: 'prepared', preparedAt: deps.now?.() ?? new Date().toISOString(),
      payout: { ...condition.payout }, balances: structuredClone(balances), positions: structuredClone(condition.positions),
      allocations: [], externalPayoutMicros: 0,
    };
    // Validate attribution against actual holdings before signing anything.
    const expectedPayout = balances.reduce((sum, b) => sum + entitlement(b.sharesMicros, b.outcome === 'YES' ? condition!.payout!.yes : condition!.payout!.no, condition!.payout!.denominator), 0);
    allocateRedemption(redemption, { transactionHash: 'validation', wallet: condition.wallet, conditionId: condition.conditionId, payoutMicros: expectedPayout, verified: false });
    condition = await persistCondition(deps, {
      ...transition(condition, 'redeeming', redemption.preparedAt, 'Persisted pre-submission attribution snapshot'),
      redemptions: [...condition.redemptions, redemption],
    });
    if (deps.venue.prepare) {
      const transportEnvelope = await deps.venue.prepare(condition, redemption);
      redemption = { ...redemption, transportEnvelope };
      condition = await persistCondition(deps, { ...condition, redemptions: condition.redemptions.map(r => r.id === redemption.id ? redemption : r) });
    }
    let result: SubmissionResult;
    try { result = await deps.venue.submit(condition, redemption); }
    catch (error) { result = { status: 'unknown', reason: String(error) }; }
    return applyResult(deps, condition, redemption, result);
  }));
}
