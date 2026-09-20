import { Database, postgres, PostgresExecutionJournal } from '../packages/execution/src/index.js';
import { PostgresSettlementStore } from '../packages/settlement/src/index.js';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) throw new Error('Set DATABASE_URL to the application PostgreSQL database');
const pool = postgres(connectionString);
try {
  const db = new Database(pool);
  await new PostgresExecutionJournal(db).migrate();
  await new PostgresSettlementStore(db).migrate();
  console.log('Execution and settlement schema ready. No orders or transactions submitted.');
} finally { await pool.end(); }
