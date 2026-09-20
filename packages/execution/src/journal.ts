import { Database } from './database.js';
import type { ExecutionJournal, ExecutionRecord } from './types.js';

export const EXECUTION_MIGRATION = `
CREATE TABLE IF NOT EXISTS polyhedge_executions (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS polyhedge_execution_wallet ON polyhedge_executions(wallet);
CREATE TABLE IF NOT EXISTS polyhedge_execution_history (
  execution_id text NOT NULL REFERENCES polyhedge_executions(id),
  revision integer NOT NULL,
  record jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(execution_id, revision)
);`;

export class PostgresExecutionJournal implements ExecutionJournal {
  constructor(private readonly db: Database) {}
  async migrate(): Promise<void> { await this.db.query(EXECUTION_MIGRATION); }
  withWalletLock<T>(wallet: string, callback: () => Promise<T>): Promise<T> {
    return this.db.lock(`wallet:${wallet.toLowerCase()}`, callback);
  }
  async load(id: string): Promise<ExecutionRecord | null> {
    const result = await this.db.query('SELECT record FROM polyhedge_executions WHERE id = $1', [id]);
    return (result.rows[0]?.['record'] as ExecutionRecord | undefined) ?? null;
  }
  /** Startup recovery reuses each saved authorization and signed order through execute(). */
  async listRecoverable(): Promise<ExecutionRecord[]> {
    const result = await this.db.query("SELECT record FROM polyhedge_executions WHERE record->>'status' IN ('buying','unwinding') ORDER BY id");
    return result.rows.map(row => row['record'] as ExecutionRecord);
  }
  async create(record: ExecutionRecord): Promise<void> {
    if (record.revision !== 0) throw new Error('Initial execution revision must be zero');
    await this.db.query(`WITH inserted AS (
      INSERT INTO polyhedge_executions(id,wallet,revision,record) VALUES($1,$2,0,$3::jsonb) RETURNING id,revision,record
    ) INSERT INTO polyhedge_execution_history(execution_id,revision,record) SELECT id,revision,record FROM inserted`,
    [record.id, record.authorization.wallet.toLowerCase(), JSON.stringify(record)]);
  }
  async save(record: ExecutionRecord, expectedRevision: number): Promise<void> {
    if (record.revision !== expectedRevision + 1) throw new Error('Execution revision must increase by one');
    const saved = await this.db.query(`WITH changed AS (
      UPDATE polyhedge_executions SET revision=$3,record=$4::jsonb
      WHERE id=$1 AND revision=$2 AND wallet=$5 RETURNING id,revision,record
    ) INSERT INTO polyhedge_execution_history(execution_id,revision,record)
      SELECT id,revision,record FROM changed RETURNING execution_id`,
    [record.id, expectedRevision, record.revision, JSON.stringify(record), record.authorization.wallet.toLowerCase()]);
    if (saved.rows.length !== 1) throw new Error('Execution changed concurrently or is missing');
  }
}
