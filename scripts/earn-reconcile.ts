import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { EARN_CHAIN, earnCall, type EarnRecord } from '../shared/earn';
import { canonicalJson } from '../shared/execution';
import { EarnService } from '../server/earn-service';
import { liveEarnProtocol } from '../server/earn-protocol';
import { sqliteEarnStore } from '../server/earn-store';
import { KeeperClient, keeperConfig } from '../server/keeperhub';

// Deliberately scoped to the already authorized demo. There is NO execute path.
const original = {
  id: '3d22f010-7969-4d1e-af2a-b0b3190470ac',
  intentHash: '0x725a6aec7a61841b88660a0d4aebbdd3a7eee9fde25e04a0abaec6a01df782fd',
  executionId: 'n6nukxlv993auch3ijex7',
  txHash: '0xb4e35d6908e95e6b0bd6efc7994e9a4c58180af9d28ccfbf623f6ca4c6085026',
  executor: '0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0',
  operator: '0x2b270B135667f38bB58Fc9376F29c95173641D31',
  token: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5',
} as const;
const simulateOnly = process.argv.includes('--simulate-step2');
if (process.argv.slice(2).some(a => !['--reconcile-step1','--simulate-step2'].includes(a)) || process.argv.length !== 3) throw new Error('Use exactly --reconcile-step1 or --simulate-step2. No transaction execution is available.');
const supply = earnCall('SUPPLY','500000000000000000',original.executor,original.token);
class ReadAndSimulateKeeper extends KeeperClient {
  override execute(): never { throw new Error('Broadcast is disabled in this reconciliation tool.'); }
  override request(path: string, body?: unknown, key?: string) {
    const allowedRead = body === undefined && ['/api/chains','/api/user/wallet','/api/user/safe',`/api/execute/${original.executionId}/status`].includes(path);
    const allowedSimulation = simulateOnly && path === '/api/execute/contract-call' && canonicalJson(body) === canonicalJson({ ...supply.payload, simulate: true });
    if (key || (!allowedRead && !allowedSimulation)) throw new Error('Only original execution reads and exact STEP 2 dry run are permitted.');
    return super.request(path,body);
  }
}
const path = process.env.DATABASE_PATH || 'data/dreamcurve.sqlite';
if (process.env.DATABASE_URL || !existsSync(path)) throw new Error('Existing local SQLite database required. No new database will be created.');
const config = keeperConfig();
if (config.wallet?.toLowerCase() !== original.executor.toLowerCase()) throw new Error('Executor configuration mismatch.');
const db = new DatabaseSync(path), store = sqliteEarnStore(db);
const service = new EarnService(store,new ReadAndSimulateKeeper(config),liveEarnProtocol());
try {
  const before = db.prepare('SELECT intent FROM earn_executions WHERE id=?').get(original.id) as { intent: string } | undefined;
  let r = await service.get(original.id);
  if (!before || r.intent.intentHash !== original.intentHash || r.txHash !== original.txHash || r.keeperHubExecutionId !== original.executionId || r.intent.action !== 'APPROVAL') throw new Error('Original frozen execution binding mismatch.');
  if (!simulateOnly) r = await service.refresh(original.id);
  if ((db.prepare('SELECT intent FROM earn_executions WHERE id=?').get(original.id) as { intent: string }).intent !== before.intent) throw new Error('Frozen intent changed.');
  console.log(JSON.stringify({ step: 1, status: r.status, frozenIntentUnchanged: true, keeperHubExecutionId: r.keeperHubExecutionId, txHash: r.txHash, proof: r.proof, failure: r.failure },null,2));
  if (r.status !== 'SUCCESS' || !r.proof?.verified || r.proof.mode !== 'keeperhub-sponsored-eip7702') { process.exitCode = 1; }
  else if (simulateOnly) {
    // Reuse an unsubmitted fresh review if this read/simulation tool is repeated.
    const existing = (await store.list(original.executor)).find(x => x.intent.action === 'SUPPLY' && x.intent.amount === '500000000000000000' && x.intent.token === original.token && x.intent.operatorAddress === original.operator && x.broadcastAttemptedAt === null && x.intent.expiresAt > Date.now() && canonicalJson(x.intent.payload) === canonicalJson(supply.payload));
    const prepared: EarnRecord = existing || await service.prepare('SUPPLY','0.5',original.operator,'LINK');
    const simulated = await service.simulate(prepared.intent.id);
    if (simulated.broadcastAttemptedAt !== null || simulated.keeperHubExecutionId || simulated.txHash) throw new Error('STEP 2 must remain unsubmitted.');
    console.log(JSON.stringify({ step: 2, simulationOnly: true, chainId: EARN_CHAIN, status: simulated.status, intent: simulated.intent, preflight: simulated.preflight, failure: simulated.failure, broadcastAttemptedAt: simulated.broadcastAttemptedAt, keeperHubExecutionId: simulated.keeperHubExecutionId, txHash: simulated.txHash, next: 'STOP. Wait for explicit user approval and manual MetaMask authorization; never execute from this tool.' },null,2));
    if (!simulated.preflight?.passed) process.exitCode = 1;
  }
} finally { db.close(); }
