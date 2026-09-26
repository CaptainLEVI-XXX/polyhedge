import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export interface SqlResult { rows: Record<string, unknown>[] }
export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  /** Destroy a connection whose session lock ownership is uncertain. */
  release(destroy?: boolean): void;
}
export interface SqlPool { connect(): Promise<SqlConnection> }
export function postgres(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 8 });
}

/** Session advisory locks serialize workers; writes stay autocommitted before network calls. */
export class Database {
  private readonly session = new AsyncLocalStorage<SqlConnection>();
  private readonly held = new Set<string>();
  private readonly poisoned = new WeakSet<SqlConnection>();
  constructor(private readonly pool: SqlPool) {}
  async query(sql: string, values: unknown[] = []): Promise<SqlResult> {
    const existing = this.session.getStore();
    if (existing) return existing.query(sql, values);
    const connection = await this.pool.connect();
    try { return await connection.query(sql, values); } finally { connection.release(); }
  }
  async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) throw new Error('Another worker is handling this wallet or condition');
    this.held.add(key);
    const parent = this.session.getStore();
    // Nested wallet/condition locks share a session. Acquiring a second pool
    // connection here can deadlock when every worker already holds its first.
    const connection = parent ?? await this.pool.connect().catch((error: unknown) => { this.held.delete(key); throw error; });
    let locked = false;
    let destroy = false;
    try {
      const result = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key])
        .catch((error: unknown) => { destroy = true; throw error; });
      locked = result.rows[0]?.['locked'] === true;
      if (!locked) throw new Error('Another worker is handling this wallet or condition');
      return await this.session.run(connection, action);
    } finally {
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch((error: unknown) => { destroy = true; throw error; });
      } finally {
        if (destroy) this.poisoned.add(connection);
        if (!parent) {
          connection.release(this.poisoned.has(connection));
          this.poisoned.delete(connection);
        }
        this.held.delete(key);
      }
    }
  }
}
