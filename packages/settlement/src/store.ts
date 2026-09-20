import { Database } from '@polyhedge/execution';
import type { SettlementStore, SettlementBasket, ConditionRecord } from './types.js';

export const SETTLEMENT_MIGRATION = `
CREATE TABLE IF NOT EXISTS polyhedge_settlement (
 kind text NOT NULL CHECK (kind IN ('basket','condition')),
 id text NOT NULL, revision integer NOT NULL CHECK (revision >= 0), record jsonb NOT NULL,
 PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS polyhedge_settlement_history (
 kind text NOT NULL, id text NOT NULL, revision integer NOT NULL, record jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,id,revision)
);`;

export class PostgresSettlementStore implements SettlementStore {
 constructor(private readonly db: Database) {}
 async migrate(): Promise<void> { await this.db.query(SETTLEMENT_MIGRATION); }
 private async get<T>(kind: string, id: string): Promise<T | null> {
   const r=await this.db.query('SELECT record FROM polyhedge_settlement WHERE kind=$1 AND id=$2',[kind,id]);
   return (r.rows[0]?.['record'] as T | undefined) ?? null;
 }
 private async list<T>(kind: string): Promise<T[]> {
   const r=await this.db.query('SELECT record FROM polyhedge_settlement WHERE kind=$1 ORDER BY id',[kind]);
   return r.rows.map(row=>row['record'] as T);
 }
 private async save(kind: string, id: string, record: { revision: number }, expected: number | null): Promise<void> {
   if (record.revision !== (expected === null ? 0 : expected+1)) throw new Error('Invalid settlement revision');
   const params: unknown[]=[kind,id,record.revision,JSON.stringify(record)];
   const mutation=expected===null
     ? `INSERT INTO polyhedge_settlement(kind,id,revision,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING *`
     : `UPDATE polyhedge_settlement SET revision=$3,record=$4::jsonb WHERE kind=$1 AND id=$2 AND revision=$5 RETURNING *`;
   if(expected!==null) params.push(expected);
   const r=await this.db.query(`WITH changed AS (${mutation})
    INSERT INTO polyhedge_settlement_history(kind,id,revision,record)
    SELECT kind,id,revision,record FROM changed RETURNING id`,params);
   if(r.rows.length!==1) throw new Error('Settlement changed concurrently or is missing');
 }
 getBasket(id: string) { return this.get<SettlementBasket>('basket',id); }
 saveBasket(record: SettlementBasket, expected: number|null) { return this.save('basket',record.id,record,expected); }
 listBaskets() { return this.list<SettlementBasket>('basket'); }
 getCondition(key: string) { return this.get<ConditionRecord>('condition',key); }
 saveCondition(record: ConditionRecord, expected: number|null) { return this.save('condition',record.key,record,expected); }
 listConditions() { return this.list<ConditionRecord>('condition'); }
 withWalletLock<T>(wallet: string, action: ()=>Promise<T>) { return this.db.lock(`wallet-redemption:${wallet.toLowerCase()}`, action); }
 withConditionLock<T>(key: string, action: ()=>Promise<T>) { return this.db.lock(`condition:${key.toLowerCase()}`, action); }
}
