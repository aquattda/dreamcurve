import type { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { canonicalJson, ExecutionError } from '../shared/execution';
import { verifyEarn, type EarnRecord } from '../shared/earn';

export interface EarnStore {
  insert(r: EarnRecord): Promise<void>;
  get(id: string): Promise<EarnRecord | null>;
  list(wallet?: string): Promise<EarnRecord[]>;
  save(r: EarnRecord): Promise<EarnRecord>;
}
const schema = `CREATE TABLE IF NOT EXISTS earn_executions (
 id TEXT PRIMARY KEY, intent_hash TEXT UNIQUE NOT NULL, intent TEXT NOT NULL,
 wallet TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS earn_one_inflight_wallet ON earn_executions(wallet)
 WHERE status IN ('EXECUTING','CONFIRMING');`;
type Row = { intent: string; metadata: string };
const unpack = (r?: Row): EarnRecord | null => r ? { ...JSON.parse(r.metadata), intent: JSON.parse(r.intent) } : null;
function metadata(r: EarnRecord) { const { intent: _, ...rest } = r; return JSON.stringify(rest); }
export function earnExposure(records: EarnRecord[], action: 'SUPPLY' | 'WITHDRAW', exclude?: string) {
  return records.reduce((total, r) => {
    verifyEarn(r.intent);
    return total + (r.intent.id !== exclude && r.intent.action === action && (r.broadcastAttemptedAt !== null || ['EXECUTING','CONFIRMING'].includes(r.status)) ? BigInt(r.intent.amount) * 10n ** BigInt(18-r.intent.decimals) : 0n);
  },0n);
}
// Use the same durable database as DreamCurve, but do not reinterpret legacy intents.
export function sqliteEarnStore(db: DatabaseSync): EarnStore {
  db.exec(schema);
  return {
    async insert(r) { verifyEarn(r.intent); db.prepare('INSERT INTO earn_executions VALUES (?,?,?,?,?,?,?)').run(r.intent.id,r.intent.intentHash,canonicalJson(r.intent),r.intent.walletAddress.toLowerCase(),r.status,r.revision,metadata(r)); },
    async get(id) { return unpack(db.prepare('SELECT intent,metadata FROM earn_executions WHERE id=?').get(id) as Row | undefined); },
    async list(wallet) { return (wallet ? db.prepare('SELECT intent,metadata FROM earn_executions WHERE wallet=? ORDER BY rowid DESC').all(wallet.toLowerCase()) : db.prepare('SELECT intent,metadata FROM earn_executions ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => unpack(r as Row)!); },
    async save(r) {
      verifyEarn(r.intent); const next = { ...r, revision: r.revision + 1 };
      try { if (db.prepare('UPDATE earn_executions SET status=?,revision=?,metadata=? WHERE id=? AND revision=? AND intent=?').run(next.status,next.revision,metadata(next),r.intent.id,r.revision,canonicalJson(r.intent)).changes !== 1) throw new Error('conflict'); }
      catch { throw new ExecutionError('BUSY', 'Earn record changed or this executor has an unresolved Sepolia action. Refresh before continuing.'); }
      return next;
    },
  };
}
export async function postgresEarnStore(pool: Pool): Promise<EarnStore> {
  await pool.query(schema);
  return {
    async insert(r) { verifyEarn(r.intent); await pool.query('INSERT INTO earn_executions VALUES ($1,$2,$3,$4,$5,$6,$7)',[r.intent.id,r.intent.intentHash,canonicalJson(r.intent),r.intent.walletAddress.toLowerCase(),r.status,r.revision,metadata(r)]); },
    async get(id) { return unpack((await pool.query<Row>('SELECT intent,metadata FROM earn_executions WHERE id=$1',[id])).rows[0]); },
    async list(wallet) { return (await pool.query<Row>(wallet ? 'SELECT intent,metadata FROM earn_executions WHERE wallet=$1 ORDER BY (intent::jsonb->>\'createdAt\')::bigint DESC' : 'SELECT intent,metadata FROM earn_executions ORDER BY (intent::jsonb->>\'createdAt\')::bigint DESC LIMIT 100',wallet ? [wallet.toLowerCase()] : [])).rows.map(r => unpack(r)!); },
    async save(r) {
      verifyEarn(r.intent); const next = { ...r, revision: r.revision + 1 };
      try { if ((await pool.query('UPDATE earn_executions SET status=$1,revision=$2,metadata=$3 WHERE id=$4 AND revision=$5 AND intent=$6',[next.status,next.revision,metadata(next),r.intent.id,r.revision,canonicalJson(r.intent)])).rowCount !== 1) throw new Error('conflict'); }
      catch { throw new ExecutionError('BUSY', 'Earn record changed or this executor has an unresolved Sepolia action.'); }
      return next;
    },
  };
}
