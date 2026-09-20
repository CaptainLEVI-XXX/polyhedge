import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { Database, type SqlPool } from '../packages/execution/src/database.js';
import { PostgresExecutionJournal } from '../packages/execution/src/journal.js';
import type { ExecutionRecord } from '../packages/execution/src/types.js';
import { PostgresSettlementStore } from '../packages/settlement/src/store.js';
import type { ConditionRecord, SettlementBasket } from '../packages/settlement/src/types.js';
import { quote } from '../packages/engine/src/quote.js';

const now = '2026-09-20T00:00:00.000Z';
function database(engine: PGlite): Database {
  const pool: SqlPool = { connect: async () => ({
    query: async (sql, values = []) => {
      // pg accepts multi-statement migrations; PGlite exposes those through exec.
      if (values.length === 0 && sql.includes('CREATE TABLE')) {
        await engine.exec(sql);
        return { rows: [] };
      }
      return engine.query<Record<string, unknown>>(sql, values);
    },
    release: () => {},
  }) };
  return new Database(pool);
}
function execution(): ExecutionRecord {
  const leg = { id: 'leg', tokenId: 'yes', conditionId: 'condition', outcome: 'YES' as const,
    sharesMicros: 1_000_000, referencePriceMicros: 200_000 };
  return { id: 'execution', revision: 0, authorization: {
    id: 'auth', wallet: '0xABC', quoteHash: 'digest', maxSpendMicros: 250_000,
    maxUnwindLossMicros: 50_000, slippageBps: 100, expiresAt: '2026-09-21T00:00:00Z', maxUnwindAttempts: 1,
  }, quote: { hash: 'digest', legs: [leg] }, status: 'buying', createdAt: now, updatedAt: now,
  legs: [{ leg, unwinds: [], buy: {
    intent: { tokenId: 'yes', conditionId: 'condition', outcome: 'YES', side: 'BUY',
      sharesMicros: 1_000_000, limitPriceMicros: 200_000, maxCashMicros: 200_000 },
    envelope: { orderId: 'signed-order-hash', payload: { signature: '0xsigned', salt: '90071992547409930' } },
    state: 'unknown', fills: [], reason: 'Connection lost after posting',
  } }], };
}
async function basket(): Promise<SettlementBasket> {
  const record = await quote({ eventId: 'event', mu: 0.5,
    shape: { templateId: 'threshold_digital', direction: 'below', k: 68000, payoutUsd: 1 },
  }, {
    fetchEvent: async () => ({ id: 'event', slug: 'btc', title: 'BTC', negRisk: true,
      negRiskMarketId: '0x1', endDate: now, tags: [], seriesTickers: [],
      markets: ['<68000', '>=68000'].map((title, i) => ({ id: `m${i}`, question: title,
        groupItemTitle: title, description: '', yesTokenId: `y${i}`, noTokenId: `n${i}`,
        yesPrice: 0.5, tickSize: 0.01, feeRate: 0, endDate: now })),
    }),
    fetchBooks: async ids => ids.map(assetId => ({ assetId, market: 'condition', timestamp: '1', hash: 'book',
      bids: [], asks: [{ priceMicros: 500_000, size: 10 }] })),
    saveSnapshot: async () => 'snapshot', now: () => new Date(now),
  }, { calibrationMapVersion: 'cal-v1', jevModelVersion: 'jev-1.13.0',
    ruleFlags: ['reference source differs'], correlationResidual: true });
  return { id: 'basket', revision: 0, wallet: '0xabc', quote: record, positions: [], costMicros: 500_000,
    expectedObservationAt: now, expectedSource: 'BTC reference', executionComplete: true };
}
function condition(): ConditionRecord {
  return { key: '0xabc:condition', revision: 0, wallet: '0xabc', conditionId: 'condition', negRisk: true,
    yesTokenId: 'yes', noTokenId: 'no', positions: [], phase: 'observing', history: [], redemptions: [] };
}

describe('PostgreSQL persistence', () => {
  it('survives a database restart with ambiguous signed orders and the complete accepted quote intact', async () => {
    const path = await mkdtemp(join(tmpdir(), 'polyhedge-storage-'));
    let engine = new PGlite(path);
    try {
      let db = database(engine);
      const journal = new PostgresExecutionJournal(db);
      const store = new PostgresSettlementStore(db);
      await journal.migrate(); await store.migrate();
      const signed = execution(); const accepted = await basket(); const tracked = condition();
      await journal.withWalletLock(signed.authorization.wallet, async () => { await journal.create(signed); });
      await store.saveBasket(accepted, null); await store.saveCondition(tracked, null);
      await engine.close();
      engine = new PGlite(path); db = database(engine);
      const restarted = new PostgresSettlementStore(db);
      expect(await new PostgresExecutionJournal(db).load(signed.id)).toEqual(signed);
      expect(await restarted.getBasket(accepted.id)).toEqual(accepted);
      expect((await restarted.getBasket(accepted.id))?.quote.basket.mu).toBe(0.5);
      expect(await restarted.listConditions()).toEqual([tracked]);
    } finally { await engine.close(); await rm(path, { recursive: true, force: true }); }
  }, 30_000);

  it('rejects stale writers and rolls back the current record when appending history fails', async () => {
    const engine = new PGlite();
    try {
      const db = database(engine); const journal = new PostgresExecutionJournal(db);
      const store = new PostgresSettlementStore(db);
      await journal.migrate(); await store.migrate();
      const initial = execution(); await journal.create(initial);
      const next = { ...initial, revision: 1, reason: 'reconciled' };
      await journal.save(next, 0);
      await expect(journal.save({ ...next, reason: 'stale writer' }, 0)).rejects.toThrow(/concurrently/);
      expect(await journal.load(initial.id)).toEqual(next);
      expect((await db.query('SELECT revision FROM polyhedge_execution_history ORDER BY revision')).rows)
        .toEqual([{ revision: 0 }, { revision: 1 }]);
      await db.query(`INSERT INTO polyhedge_execution_history(execution_id,revision,record) VALUES($1,2,$2::jsonb)`,
        [initial.id, JSON.stringify(next)]);
      await expect(journal.save({ ...next, revision: 2 }, 1)).rejects.toThrow();
      expect(await journal.load(initial.id)).toEqual(next);

      const tracked = condition(); await store.saveCondition(tracked, null);
      const final = { ...tracked, revision: 1, phase: 'redeemable' as const, payout: { yes: 1, no: 0, denominator: 1 } };
      await store.saveCondition(final, 0);
      await expect(store.saveCondition({ ...final, phase: 'lost' }, 0)).rejects.toThrow(/concurrently/);
      await expect(store.saveCondition(tracked, null)).rejects.toThrow(/concurrently/);
      expect(await store.getCondition(tracked.key)).toEqual(final);
      expect((await db.query('SELECT revision FROM polyhedge_settlement_history ORDER BY revision')).rows)
        .toEqual([{ revision: 0 }, { revision: 1 }]);
      await db.query(`INSERT INTO polyhedge_settlement_history(kind,id,revision,record) VALUES('condition',$1,2,$2::jsonb)`,
        [tracked.key, JSON.stringify(final)]);
      await expect(store.saveCondition({ ...final, revision: 2 }, 1)).rejects.toThrow();
      expect(await store.getCondition(tracked.key)).toEqual(final);
    } finally { await engine.close(); }
  }, 30_000);

  it('excludes overlapping wallet work, releases after failure, and preserves pre-network journal writes', async () => {
    const engine = new PGlite();
    try {
      const journal = new PostgresExecutionJournal(database(engine)); await journal.migrate();
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
      const active = journal.withWalletLock('0xABC', async () => { entered(); await gate; });
      await started;
      await expect(journal.withWalletLock('0xabc', async () => {})).rejects.toThrow(/Another worker/);
      finish(); await active;
      await expect(journal.withWalletLock('0xabc', async () => {
        await journal.create(execution()); throw new Error('process failed after saving intent');
      })).rejects.toThrow(/process failed/);
      expect(await journal.withWalletLock('0xabc', () => journal.load('execution'))).toEqual(execution());
      // PGlite has one SQL session: this covers local exclusion and real lock SQL,
      // not distributed exclusion between separate PostgreSQL connections.
    } finally { await engine.close(); }
  }, 30_000);

  it('discards a connection when advisory-lock ownership becomes uncertain', async () => {
    for (const failAt of ['acquire', 'release']) {
      const released: Array<boolean | undefined> = [];
      const db = new Database({ connect: async () => ({
        query: async sql => {
          if ((failAt === 'acquire' && sql.includes('pg_try')) || (failAt === 'release' && sql.includes('pg_advisory_unlock'))) {
            throw new Error('connection interrupted');
          }
          return { rows: [{ locked: true }] };
        }, release: destroy => { released.push(destroy); },
      }) });
      await expect(db.lock('wallet', async () => {})).rejects.toThrow(/interrupted/);
      expect(released).toEqual([true]);
    }
  });

  it('shares one connection for nested wallet and condition locks, even with a one-connection pool', async () => {
    let connections = 0;
    let releases = 0;
    const db = new Database({ connect: async () => {
      if (++connections > 1) throw new Error('Pool exhausted');
      return { query: async () => ({ rows: [{ locked: true }] }), release: () => { releases++; } };
    } });
    await db.lock('wallet', () => db.lock('condition', async () => {
      await db.query('SELECT 1');
      expect(releases).toBe(0);
    }));
    expect(connections).toBe(1);
    expect(releases).toBe(1);
  });
});
