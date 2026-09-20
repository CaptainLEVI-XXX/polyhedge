import { quote } from '../../packages/engine/src/index.js';
import type { GammaEvent } from '../../packages/venue/src/index.js';
import type { ConditionRecord, SettlementBasket, SettlementDeps, SettlementStore, SettlementVenue } from '../../packages/settlement/src/types.js';
import { conditionKey } from '../../packages/settlement/src/service.js';

export class MemorySettlementStore implements SettlementStore {
  baskets = new Map<string, SettlementBasket>();
  conditions = new Map<string, ConditionRecord>();
  private locks = new Map<string, Promise<unknown>>();
  async getBasket(id: string) { return structuredClone(this.baskets.get(id) ?? null); }
  async listBaskets() { return structuredClone([...this.baskets.values()]); }
  async saveBasket(record: SettlementBasket, expected: number | null) {
    if ((this.baskets.get(record.id)?.revision ?? null) !== expected) throw new Error('CAS conflict');
    this.baskets.set(record.id, structuredClone(record));
  }
  async getCondition(key: string) { return structuredClone(this.conditions.get(key) ?? null); }
  async listConditions() { return structuredClone([...this.conditions.values()]); }
  async saveCondition(record: ConditionRecord, expected: number | null) {
    if ((this.conditions.get(record.key)?.revision ?? null) !== expected) throw new Error('CAS conflict');
    this.conditions.set(record.key, structuredClone(record));
  }
  withWalletLock<T>(wallet: string, action: () => Promise<T>): Promise<T> {
    return this.withConditionLock(`wallet-redemption:${wallet.toLowerCase()}`, action);
  }
  async withConditionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(key, promise);
    return promise;
  }
}
export const descriptor = { conditionId: 'cA', negRisk: true, yesTokenId: 'aYES', noTokenId: 'aNO' };
export const key = conditionKey('wallet', 'cA');
export async function basketFixture(id = 'basket'): Promise<SettlementBasket> {
  const event: GammaEvent = {
    id: 'event', slug: 'event', title: 'BTC', negRisk: true, negRiskMarketId: '0x1',
    endDate: '2026-10-01T16:00:00Z', tags: [], seriesTickers: [],
    markets: ['a', 'b'].map((id, i) => ({ id, question: id, groupItemTitle: i ? '>100' : '<100', description: 'rules',
      yesTokenId: `${id}YES`, noTokenId: `${id}NO`, yesPrice: i ? 0.8 : 0.2,
      tickSize: 0.01, feeRate: 0, endDate: '2026-10-01T16:00:00Z' })),
  };
  const record = await quote({ eventId: 'event', shape: { templateId: 'threshold_digital', direction: 'below', k: 100, payoutUsd: 10 } }, {
    fetchEvent: async () => event,
    fetchBooks: async ids => ids.map(assetId => ({ market: 'event', assetId, timestamp: '1', hash: 'h', bids: [], asks: [{ priceMicros: assetId === 'aYES' ? 200_000 : 990_000, size: 1000 }] })),
    saveSnapshot: async () => 'snapshot',
  });
  return {
    id, revision: 0, wallet: 'wallet', quote: record, costMicros: record.basket.totalCostCents * 10_000,
    positions: [{ basketId: id, wallet: 'wallet', conditionId: 'cA', tokenId: 'aYES', outcome: 'YES', sharesMicros: 10_000_000 }],
    expectedObservationAt: event.endDate, expectedSource: 'reference', executionComplete: true,
  };
}
export function harness(overrides: Partial<SettlementVenue> = {}): SettlementDeps & { store: MemorySettlementStore } {
  const store = new MemorySettlementStore();
  let nextId = 0;
  return { store, now: () => '2026-10-02T00:00:00Z', newId: () => `redemption-${++nextId}`, venue: {
    resolution: async () => ({ finalized: true, stage: 'proposed', payout: { yes: 1, no: 0, denominator: 1 } }),
    balances: async () => [{ tokenId: 'aYES', outcome: 'YES', sharesMicros: 10_000_000 }, { tokenId: 'aNO', outcome: 'NO', sharesMicros: 0 }],
    submit: async () => ({ status: 'pending', submissionId: 'submission' }),
    reconcile: async () => ({ status: 'confirmed', submissionId: 'submission', receipt: { verified: true, transactionHash: 'tx', wallet: 'wallet', conditionId: 'cA', payoutMicros: 10_000_000 } }),
    ...overrides,
  } };
}
