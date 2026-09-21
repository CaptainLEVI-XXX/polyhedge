import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { quote } from '../packages/engine/src/index.js';
import type { GammaEvent, ClobBook } from '../packages/venue/src/index.js';
import { Database, PostgresExecutionJournal, bindQuote, execute, type ExecutionVenue, type OrderIntent } from '../packages/execution/src/index.js';
import { PostgresSettlementStore, basketFromExecution, registerBasket, conditionKey, pollCondition,
  redeemCondition, recordObservation, settlementFor, basketStatus, type SettlementDeps } from '../packages/settlement/src/index.js';

/** Entirely offline. Real compiler and SQL journal; deliberately simulated venue fills/resolution. */
export async function runSimulation(winner = true) {
  const sql = new PGlite();
  const db = new Database({ connect: async () => ({
    async query(statement, values) {
      if (values === undefined || values.length === 0) {
        const results = await sql.exec(statement);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      }
      return sql.query<Record<string, unknown>>(statement, values);
    }, release() {},
  }) });
  const journal = new PostgresExecutionJournal(db);
  const store = new PostgresSettlementStore(db);
  const now = new Date('2026-09-20T12:00:00Z');
  const conditionId = `0x${'1'.repeat(64)}`;
  const event: GammaEvent = {
    id: 'demo', slug: 'demo', title: 'Simulated BTC ladder', negRisk: true, negRiskMarketId: `0x${'2'.repeat(64)}`,
    endDate: '2026-10-01T16:00:00Z', tags: [], seriesTickers: [],
    markets: ['low', 'high'].map((id, i) => ({ id, question: id, groupItemTitle: i ? '>=68000' : '<68000',
      description: 'Simulation only', slug: null, yesTokenId: `${id}YES`, noTokenId: `${id}NO`, yesPrice: i ? 0.8 : 0.2,
      tickSize: 0.01, feeRate: 0, endDate: '2026-10-01T16:00:00Z' })),
  };
  let pinned: ClobBook[] = [];
  try {
    await journal.migrate(); await store.migrate();
    const record = await quote({ eventId: 'demo', shape: { templateId: 'threshold_digital', direction: 'below', k: 68000, payoutUsd: 10 } }, {
      fetchEvent: async () => event,
      fetchBooks: async ids => ids.map(assetId => ({ assetId, market: conditionId, timestamp: now.toISOString(), hash: 'simulation', bids: [],
        asks: [{ priceMicros: assetId === 'lowYES' ? 200_000 : 990_000, size: 100 }] })),
      saveSnapshot: async books => {
        pinned = books;
        return createHash('sha256').update(JSON.stringify([...books].sort((a,b) => a.assetId.localeCompare(b.assetId)))).digest('hex');
      }, now: () => now,
    });
    const accepted = bindQuote(record, pinned, ['Simulation: no real money or reference feed']);
    const venue: ExecutionVenue = {
      state: async () => ({ mode: 'open', availableCashMicros: 100_000_000, signerCanTrade: true, approvalsReady: true }),
      book: async tokenId => ({ tokenId, observedAt: now.toISOString(), tickMicros: 10_000, shareStepMicros: 10_000,
        minSharesMicros: 1_000_000, feeBps: 0, asks: [{ priceMicros: 200_000, sharesMicros: 100_000_000 }], bids: [] }),
      prepare: async (_wallet, intent) => ({ orderId: 'simulation-order', payload: intent }),
      post: async (_wallet, envelope) => {
        const intent = envelope.payload as OrderIntent;
        return { kind: 'confirmed', fills: [{ id: 'simulation-fill', orderId: envelope.orderId, ...intent,
          cashMicros: intent.maxCashMicros, feeMicros: 0, transactionHash: 'simulation-transaction' }] };
      },
      reconcile: async () => ({ kind: 'unknown', reason: 'Demo has no external venue' }),
    };
    const execution = await execute(accepted.selected, { id: 'demo-basket', wallet: 'demo-wallet', quoteHash: accepted.selected.hash,
      maxSpendMicros: 3_000_000, maxUnwindLossMicros: 500_000, slippageBps: 0,
      expiresAt: '2026-09-20T13:00:00Z', maxUnwindAttempts: 1 }, { journal, venue, now: () => now });
    const basket = basketFromExecution(accepted, execution.record, { observedAt: event.endDate, source: 'demo-reference' });
    let redemptions = 0;
    const deps: SettlementDeps = { store, newId: () => 'simulation-redemption', venue: {
      resolution: async () => ({ finalized: true, stage: 'proposed', payout: { yes: winner ? 1 : 0, no: winner ? 0 : 1, denominator: 1 } }),
      balances: async () => [{ tokenId: 'lowYES', outcome: 'YES', sharesMicros: 10_000_000 }, { tokenId: 'lowNO', outcome: 'NO', sharesMicros: 0 }],
      submit: async () => {
        redemptions++;
        return { status: 'confirmed', submissionId: 'simulation-redemption', receipt: { verified: true,
          transactionHash: 'simulation-redemption-tx', wallet: basket.wallet, conditionId, payoutMicros: 10_000_000 } };
      }, reconcile: async () => ({ status: 'unknown', reason: 'Demo has no external venue' }),
    } };
    await registerBasket(basket, [{ conditionId, negRisk: true, yesTokenId: 'lowYES', noTokenId: 'lowNO' }], deps);
    const key = conditionKey(basket.wallet, conditionId);
    await pollCondition(key, deps);
    await redeemCondition(key, deps);
    await recordObservation(basket.id, { price: winner ? 65000 : 70000, observedAt: event.endDate, source: 'demo-reference' }, deps);
    return { simulation: true, accepted, execution, state: (await basketStatus(basket.id, deps)).state,
      accounting: await settlementFor(basket.id, deps), redemptions };
  } finally { await sql.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const winner of [true, false]) {
    const result = await runSimulation(winner);
    console.log(JSON.stringify({ simulation: true, outcome: winner ? 'winning' : 'losing',
      execution: result.execution.kind, state: result.state, accounting: result.accounting, redemptionTransactions: result.redemptions }, null, 2));
  }
}
