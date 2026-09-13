import 'dotenv/config';
import pg from 'pg';
import type { Address, Hex } from 'viem';
import { AAVE, EARN_ASSETS, EARN_CHAIN, earnCall, freezeEarn } from '../shared/earn';
import { canonicalJson } from '../shared/execution';
import { EarnService, initialEarn } from '../server/earn-service';
import { liveEarnProtocol } from '../server/earn-protocol';
import { postgresEarnStore } from '../server/earn-store';
import { KeeperClient, keeperConfig } from '../server/keeperhub';

// This one-off migration binds production storage to the already-broadcast STEP 1.
// It deliberately exposes no simulation or execution route and therefore cannot
// create a second approval or advance to supply/withdraw.
if (process.argv.length !== 3 || process.argv[2] !== '--reconcile-step1') {
  throw new Error('Use exactly --reconcile-step1. Transaction execution is unavailable.');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; refusing non-durable reconciliation.');

const original = {
  id: '3d22f010-7969-4d1e-af2a-b0b3190470ac',
  intentHash: '0x725a6aec7a61841b88660a0d4aebbdd3a7eee9fde25e04a0abaec6a01df782fd' as Hex,
  executionId: 'n6nukxlv993auch3ijex7',
  txHash: '0xb4e35d6908e95e6b0bd6efc7994e9a4c58180af9d28ccfbf623f6ca4c6085026' as Hex,
  executor: '0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0' as Address,
  operator: '0x2b270B135667f38bB58Fc9376F29c95173641D31' as Address,
  amount: '500000000000000000',
} as const;

const call = earnCall('APPROVAL', original.amount, original.executor, EARN_ASSETS.LINK.token);
const intent = freezeEarn({
  version: 'earn-v1',
  protocol: 'aave-v3',
  id: original.id,
  chainId: EARN_CHAIN,
  action: 'APPROVAL',
  amount: original.amount,
  decimals: EARN_ASSETS.LINK.decimals,
  token: EARN_ASSETS.LINK.token,
  pool: AAVE.pool,
  aToken: EARN_ASSETS.LINK.aToken,
  walletAddress: original.executor,
  operatorAddress: original.operator,
  authorizationDomain: 'dreamcurve.local',
  createdAt: 1789004391079,
  expiresAt: 1789004991079,
  rationale: 'Manual approval request. Live Aave reserve checked at 2026-09-10T01:39:51.079Z. No AI prediction or guaranteed yield is claimed.',
  ...call,
});
if (intent.intentHash !== original.intentHash) throw new Error('Frozen STEP 1 intent hash mismatch.');

class ReconciliationKeeper extends KeeperClient {
  override execute(): never {
    throw new Error('Broadcast is disabled in the production reconciliation tool.');
  }
  override request(path: string, body?: unknown, idempotencyKey?: string) {
    if (body !== undefined || idempotencyKey || path !== `/api/execute/${original.executionId}/status`) {
      throw new Error('Only the original KeeperHub execution status may be read.');
    }
    return super.request(path);
  }
}

const config = keeperConfig();
if (config.wallet?.toLowerCase() !== original.executor.toLowerCase()) throw new Error('Executor configuration mismatch.');
if (!config.operators.some(value => value.toLowerCase() === original.operator.toLowerCase())) throw new Error('Operator configuration mismatch.');

const { Pool } = pg;
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10_000,
  application_name: 'dreamcurve-step1-reconciliation',
});
try {
  const store = await postgresEarnStore(pool);
  let record = await store.get(original.id);
  if (!record) {
    record = initialEarn(intent);
    record.status = 'CONFIRMING';
    record.broadcastAttemptedAt = 1789004753064;
    record.keeperHubExecutionId = original.executionId;
    record.txHash = original.txHash;
    record.keeperHubStatus = 'completed';
    record.pollAfterMs = 0;
    record.lastPollAt = 0;
    record.timeline.push({ at: Date.now(), event: 'Production reconciliation', detail: 'Imported immutable binding to the existing STEP 1 execution; no transaction sent.' });
    await store.insert(record);
  }
  if (
    canonicalJson(record.intent) !== canonicalJson(intent)
    || record.intent.intentHash !== original.intentHash
    || record.keeperHubExecutionId !== original.executionId
    || record.txHash !== original.txHash
    || record.broadcastAttemptedAt === null
  ) throw new Error('Stored STEP 1 binding differs from the frozen execution.');

  const service = new EarnService(store, new ReconciliationKeeper(config), liveEarnProtocol());
  record = await service.refresh(original.id);
  const result = {
    step: 1,
    status: record.status,
    frozenIntentUnchanged: canonicalJson(record.intent) === canonicalJson(intent),
    keeperHubExecutionId: record.keeperHubExecutionId,
    txHash: record.txHash,
    proofMode: record.proof?.mode ?? null,
    proofVerified: record.proof?.verified ?? false,
    allowance: record.proof && 'allowance' in record.proof ? record.proof.allowance : null,
    failure: record.failure,
    transactionSubmitted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (record.status !== 'SUCCESS' || !record.proof?.verified || result.allowance !== original.amount) process.exitCode = 1;
} finally {
  await pool.end();
}
