import type { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { ExecutionError, type ExecutionRecord } from '../shared/execution';
import { attemptedExposure } from './execution-limits';

export interface ExecutionStore {
  insert(record: ExecutionRecord): Promise<void>;
  get(id: string): Promise<ExecutionRecord | null>;
  list(): Promise<ExecutionRecord[]>;
  exposure(wallet: string, excludeId?: string): Promise<bigint>;
  save(record: ExecutionRecord): Promise<ExecutionRecord>;
}
// The immutable intent lives in its own column and is never part of UPDATE.
const schema = `CREATE TABLE IF NOT EXISTS keeper_executions (
  id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL UNIQUE, intent TEXT NOT NULL,
  wallet TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS keeper_one_inflight_wallet ON keeper_executions(wallet)
  WHERE status IN ('EXECUTING','CONFIRMING');`;
type Row = { intent: string; metadata: string };
function unpack(r?: Row): ExecutionRecord | null { return r ? { ...JSON.parse(r.metadata), intent: JSON.parse(r.intent) } as ExecutionRecord : null; }
function metadata(r: ExecutionRecord) { const { intent: _intent, ...rest } = r; return JSON.stringify(rest); }
export function sqliteExecutionStore(db: DatabaseSync): ExecutionStore {
  db.exec(schema);
  return {
    async insert(r) { db.prepare('INSERT INTO keeper_executions VALUES (?,?,?,?,?,?,?)').run(r.intent.id, r.intent.intentHash, JSON.stringify(r.intent), r.intent.walletAddress.toLowerCase(), r.status, r.revision, metadata(r)); },
    async get(id) { return unpack(db.prepare('SELECT intent,metadata FROM keeper_executions WHERE id=?').get(id) as Row | undefined); },
    async list() { return (db.prepare('SELECT intent,metadata FROM keeper_executions ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => unpack(r)!); },
    async exposure(wallet, excludeId) {
      const rows = db.prepare('SELECT intent,metadata FROM keeper_executions WHERE wallet=?').all(wallet.toLowerCase()) as Row[];
      return attemptedExposure(rows.map(r => unpack(r)!), excludeId);
    },
    async save(r) {
      const next = { ...r, revision: r.revision + 1 };
      try {
        const changed = db.prepare('UPDATE keeper_executions SET status=?, revision=?, metadata=? WHERE id=? AND revision=? AND intent_hash=?').run(next.status, next.revision, metadata(next), r.intent.id, r.revision, r.intent.intentHash);
        if (changed.changes !== 1) throw new Error('conflict');
      } catch { throw new ExecutionError('BUSY', 'Execution changed or this KeeperHub wallet has an unresolved execution. Refresh its record.'); }
      return next;
    },
  };
}
export async function postgresExecutionStore(pool: Pool): Promise<ExecutionStore> {
  await pool.query(schema);
  return {
    async insert(r) { await pool.query('INSERT INTO keeper_executions VALUES ($1,$2,$3,$4,$5,$6,$7)', [r.intent.id, r.intent.intentHash, JSON.stringify(r.intent), r.intent.walletAddress.toLowerCase(), r.status, r.revision, metadata(r)]); },
    async get(id) { return unpack((await pool.query<Row>('SELECT intent,metadata FROM keeper_executions WHERE id=$1', [id])).rows[0]); },
    async list() { return (await pool.query<Row>(`SELECT intent,metadata FROM keeper_executions ORDER BY (intent::jsonb->>'createdAt')::bigint DESC LIMIT 100`)).rows.map(r => unpack(r)!); },
    async exposure(wallet, excludeId) {
      const rows = (await pool.query<Row>('SELECT intent,metadata FROM keeper_executions WHERE wallet=$1', [wallet.toLowerCase()])).rows;
      return attemptedExposure(rows.map(r => unpack(r)!), excludeId);
    },
    async save(r) {
      const next = { ...r, revision: r.revision + 1 };
      try {
        const result = await pool.query('UPDATE keeper_executions SET status=$1, revision=$2, metadata=$3 WHERE id=$4 AND revision=$5 AND intent_hash=$6', [next.status, next.revision, metadata(next), r.intent.id, r.revision, r.intent.intentHash]);
        if (result.rowCount !== 1) throw new Error('conflict');
      } catch { throw new ExecutionError('BUSY', 'Execution changed or this KeeperHub wallet has an unresolved execution. Refresh its record.'); }
      return next;
    },
  };
}
