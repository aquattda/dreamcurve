import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, type Hex } from 'viem';
import { binaryPoolWriteAbi } from '@somnia-chain/markets-sdk';
import { assertFresh, authorizationMessage, canonicalJson, ExecutionError, freezeIntent, verifyIntent } from '../shared/execution';
import { sqliteExecutionStore } from '../server/execution-store';
import { ExecutionService, initialRecord } from '../server/execution-service';
import { KeeperClient, KeeperRejection, normalizeKeeperError } from '../server/keeperhub';
import type { ExecutionProtocol } from '../server/execution-protocol';
import { fixtureIntent, safeFixtureIntent, fixtureFunding, operator, wallet, txHash } from './execution-fixtures';

afterEach(() => vi.restoreAllMocks());
describe('deterministic dreamDEX intents', () => {
  it('canonicalizes object key order and rejects unsupported JSON values', () => {
    expect(canonicalJson({ b: 1, a: { z: true, y: null } })).toBe(canonicalJson({ a: { y: null, z: true }, b: 1 }));
    for (const value of [undefined, 1n, NaN, { a: undefined }, new Date()]) expect(() => canonicalJson(value)).toThrow();
  });
  it('detects mutation of the reviewed payload and any hash-bound metadata', () => {
    const i = fixtureIntent(); expect(() => verifyIntent(i)).not.toThrow();
    for (const change of [{ quantity: '21000000' }, { walletAddress: operator.address }, { expiresAt: i.expiresAt + 1 }, { calldata: '0x1234' as Hex }]) expect(() => verifyIntent({ ...i, ...change })).toThrow(/hash/);
    const { intentHash, ...body } = i;
    expect(freezeIntent(body).intentHash).toBe(intentHash);
    expect(freezeIntent({ ...body, marketTitle: 'Changed' }).intentHash).not.toBe(intentHash);
  });
  it('encodes BUY_NO kind 2 using YES-denominated contract price and bounded escrow', () => {
    const i = fixtureIntent({ side: 'NO', yesPrice: '600000', limitPrice: '400000', estimatedSpend: '8000000' });
    verifyIntent(i);
    const d = decodeFunctionData({ abi: binaryPoolWriteAbi, data: i.calldata });
    expect(d.functionName).toBe('placeBinaryOrder'); expect(d.args?.slice(0,3)).toEqual([2,600000n,20000000n]);
  });
  it('rejects off-grid orders and invalid escrow even if rehashed', () => {
    for (const change of [{ quantity: '20000001' }, { yesPrice: '500001' }, { estimatedSpend: '9999999' }, { orderType: 0 }, { collateralDecimals: 19 }]) expect(() => verifyIntent(fixtureIntent(change))).toThrow();
  });
  it('blocks exactly at expiry without changing any payload', () => {
    const i = fixtureIntent(); const before = canonicalJson(i);
    expect(() => assertFresh(i, i.expiresAt - 1)).not.toThrow(); expect(() => assertFresh(i, i.expiresAt)).toThrow(/expired/);
    expect(canonicalJson(i)).toBe(before);
  });
});

describe('KeeperHub transport', () => {
  const config = { baseUrl: 'https://keeper.example', apiKey: 'kh_test_only', wallet, operators: [operator.address], domain: 'test.local', eoaConfirmed: true };
  it('sends the same payload for simulation and execution with stable idempotency', async () => {
    const requests: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { requests.push(init!); return Response.json({ executionId: 'test' }); });
    const client = new KeeperClient(config, fetcher as typeof fetch), i = fixtureIntent();
    await client.simulate(i.payload); await client.execute(i.payload, i.intentHash); await client.execute(i.payload, i.intentHash);
    const { simulate, ...body } = JSON.parse(requests[0].body as string);
    expect(simulate).toBe(true); expect(body).toEqual(JSON.parse(requests[1].body as string));
    expect(requests[1].body).toBe(requests[2].body);
    expect(requests[1].headers).toMatchObject({ 'Idempotency-Key': `dreamcurve:${i.intentHash}` });
    expect(requests[0].headers).not.toHaveProperty('Idempotency-Key');
  });
  it('rejects missing/disabled/mainnet Shannon chain entries', async () => {
    for (const response of [[], [{ chainId: 50312, isEnabled: false, isTestnet: true, chainType: 'evm' }], [{ chainId: 50312, isEnabled: true, isTestnet: false, chainType: 'evm' }]]) {
      const client = new KeeperClient(config, vi.fn(async () => Response.json(response)) as typeof fetch);
      await expect(client.assertChain()).rejects.toMatchObject({ code: 'NETWORK_UNSUPPORTED' });
    }
  });
  it('classifies structured errors without treating every HTTP 400 as a revert', () => {
    expect(normalizeKeeperError({ code: 'insufficient_balance', failureKind: 'validation' },400).code).toBe('INSUFFICIENT_BALANCE');
    expect(normalizeKeeperError({ failureKind: 'validation' },400).code).toBe('INVALID_INPUT');
    expect(normalizeKeeperError({ failureKind: 'unavailable', wouldRevert: false },503).code).toBe('SIMULATOR_UNAVAILABLE');
    expect(normalizeKeeperError({ failureKind: 'revert', wouldRevert: true },400).code).toBe('CONTRACT_REVERT');
    expect(normalizeKeeperError({ error: 'Bearer kh_secretvalue' }).message).not.toContain('kh_secret');
  });
  it('labels interrupted writes as uncertain and never retries fetch automatically', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network'); });
    const client = new KeeperClient(config, fetcher as typeof fetch);
    await expect(client.execute(fixtureIntent().payload, 'test')).rejects.toMatchObject({ code: 'EXECUTION_UNCERTAIN' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('execution lifecycle with durable SQLite claims', () => {
  const dbs: DatabaseSync[] = [];
  afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
  async function setup() {
    const db = new DatabaseSync(':memory:'); dbs.push(db);
    const store = sqliteExecutionStore(db), intent = safeFixtureIntent();
    await store.insert(initialRecord(intent));
    const keeper = new KeeperClient({ baseUrl: 'https://keeper.example', apiKey: 'kh_test', wallet, operators: [operator.address], domain: 'test.local', eoaConfirmed: true });
    vi.spyOn(keeper,'assertChain').mockResolvedValue();
    vi.spyOn(keeper,'simulate').mockResolvedValue({ body: { success: true, status: 'simulated', from: wallet, to: intent.poolAddress, value: '0', wouldRevert: false, gasEstimate: '800000' }, pollAfterMs: 5000 });
    vi.spyOn(keeper,'execute').mockResolvedValue({ body: { executionId: 'test-id', status: 'unconfirmed', transactionHash: txHash }, pollAfterMs: 5000 });
    vi.spyOn(keeper,'status').mockResolvedValue({ body: { executionId: 'test-id', status: 'unconfirmed', transactionHash: txHash, receipts: [] }, pollAfterMs: 5000 });
    const protocol: ExecutionProtocol = { prepare: vi.fn(), check: vi.fn(async () => ['Market verified']), funding: vi.fn(async () => fixtureFunding(intent)), verify: vi.fn() };
    const service = new ExecutionService(store,keeper,protocol);
    const signature = await operator.signMessage({ message: authorizationMessage(intent) });
    return { db,store,intent,keeper,protocol,service,signature };
  }
  it('blocks execution before dry run and with a wrong authorization signature', async () => {
    const s = await setup(); await expect(s.service.execute(s.intent.id,s.signature)).rejects.toThrow(/dry run/);
    await s.service.simulate(s.intent.id);
    const wrong = await operator.signMessage({ message: 'something else' });
    await expect(s.service.execute(s.intent.id,wrong)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(s.keeper.execute).not.toHaveBeenCalled();
  });
  it('simulates and executes the same frozen payload without another quote', async () => {
    const s = await setup(); await s.service.simulate(s.intent.id); await s.service.execute(s.intent.id,s.signature);
    expect(s.protocol.prepare).not.toHaveBeenCalled();
    for (const call of vi.mocked(s.keeper.simulate).mock.calls) expect(call[0]).toEqual(s.intent.payload);
    expect(s.keeper.execute).toHaveBeenCalledWith(s.intent.payload,s.intent.intentHash);
    expect((await s.store.get(s.intent.id))?.intent).toEqual(s.intent);
  });
  it('allows only one concurrent execute request and persists no-rebroadcast behavior', async () => {
    const s = await setup(); await s.service.simulate(s.intent.id);
    await Promise.allSettled([s.service.execute(s.intent.id,s.signature),s.service.execute(s.intent.id,s.signature)]);
    expect(s.keeper.execute).toHaveBeenCalledOnce();
    const restarted = new ExecutionService(s.store,s.keeper,s.protocol);
    await restarted.execute(s.intent.id,s.signature);
    expect(s.keeper.execute).toHaveBeenCalledOnce();
  });
  it('locks unresolved broadcasts even after timeout and permits no new wallet execution', async () => {
    const s = await setup(); vi.mocked(s.keeper.execute).mockRejectedValueOnce(new ExecutionError('EXECUTION_UNCERTAIN','Timeout'));
    await s.service.simulate(s.intent.id); const r = await s.service.execute(s.intent.id,s.signature);
    expect(r.status).toBe('CONFIRMING'); expect(r.broadcastAttemptedAt).toBeTruthy();
    await s.service.execute(s.intent.id,s.signature); expect(s.keeper.execute).toHaveBeenCalledOnce();
    const other = fixtureIntent({ id: 'other' }); await s.store.insert(initialRecord(other));
    const record = (await s.store.get(other.id))!; record.status = 'EXECUTING';
    await expect(s.store.save(record)).rejects.toMatchObject({ code: 'BUSY' });
  });
  it.each(['MARKET_EXPIRED','MARKET_CLOSED','INSUFFICIENT_GAS','INSUFFICIENT_BALANCE','INSUFFICIENT_EXECUTOR_GAS','INSUFFICIENT_EXECUTOR_COLLATERAL','COLLATERAL_MISMATCH','ALLOWANCE_REQUIRED','CONTRACT_REVERT','SIMULATOR_UNAVAILABLE'] as const)('blocks %s before broadcast', async code => {
    const s = await setup(); vi.mocked(s.protocol.check).mockRejectedValue(new ExecutionError(code,'Safety check failed'));
    const r = await s.service.simulate(s.intent.id); expect(r.preflight?.passed).toBe(false); expect(r.failure?.code).toBe(code);
    await expect(s.service.execute(s.intent.id,s.signature)).rejects.toThrow(); expect(s.keeper.execute).not.toHaveBeenCalled();
  });
  it('requires the simulated sender to match the reviewed executing wallet', async () => {
    const s = await setup(); vi.mocked(s.keeper.simulate).mockResolvedValue({ body: { success: true, status: 'simulated', wouldRevert: false, from: operator.address, to: s.intent.poolAddress, value: '0', gasEstimate: '800000' }, pollAfterMs: 5000 });
    const r = await s.service.simulate(s.intent.id); expect(r.failure?.code).toBe('PROOF_MISMATCH'); expect(r.status).not.toBe('READY');
  });
  it('blocks a stale intent between simulation and execution without rewriting expiry', async () => {
    const s = await setup(); await s.service.simulate(s.intent.id);
    vi.spyOn(Date,'now').mockReturnValue(s.intent.expiresAt);
    const r = await s.service.execute(s.intent.id,s.signature); expect(r.status).toBe('STALE'); expect(r.intent).toEqual(s.intent); expect(s.keeper.execute).not.toHaveBeenCalled();
  });
  it('requires an independently verified receipt, not only KeeperHub completed', async () => {
    const s = await setup(); vi.mocked(s.keeper.status).mockResolvedValue({ body: { executionId: 'test-id', status: 'completed', transactionHash: txHash, receipts: [] }, pollAfterMs: 5000 });
    await s.service.simulate(s.intent.id); const r = await s.service.execute(s.intent.id,s.signature);
    expect(r.status).toBe('CONFIRMING'); expect(r.failure?.code).toBe('EXECUTION_UNCERTAIN'); expect(s.protocol.verify).not.toHaveBeenCalled();
  });
  it('does not release an uncertain broadcast based on another chain receipt', async () => {
    const s = await setup();
    vi.mocked(s.keeper.status).mockResolvedValue({ body: { executionId: 'test-id', status: 'failed', transactionHash: txHash, receipts: [{ hash: txHash, chainId: 1, verified: true, receiptStatus: 'reverted' }] }, pollAfterMs: 5000 });
    await s.service.simulate(s.intent.id);
    const r = await s.service.execute(s.intent.id, s.signature);
    expect(r.status).toBe('CONFIRMING');
    expect(r.failure?.code).toBe('EXECUTION_UNCERTAIN');
    const other = initialRecord(fixtureIntent({ id: 'other' }));
    await s.store.insert(other); other.status = 'EXECUTING';
    await expect(s.store.save(other)).rejects.toThrow();
    expect(s.keeper.execute).toHaveBeenCalledTimes(1);
  });
  it('releases the wallet after an explicit pre-broadcast rejection but never resends that intent', async () => {
    const s = await setup(); vi.mocked(s.keeper.execute).mockRejectedValue(new KeeperRejection('UNAUTHORIZED','Write scope required'));
    await s.service.simulate(s.intent.id); const r = await s.service.execute(s.intent.id,s.signature);
    expect(r.status).toBe('FAILED'); expect(r.txHash).toBeNull();
    await s.service.execute(s.intent.id,s.signature); expect(s.keeper.execute).toHaveBeenCalledOnce();
    const other = initialRecord(fixtureIntent({id:'other'})); await s.store.insert(other); other.status='EXECUTING';
    await expect(s.store.save(other)).resolves.toMatchObject({status:'EXECUTING'});
  });
  it('reports success only after both KeeperHub receipt and independent protocol verification', async () => {
    const s = await setup();
    vi.mocked(s.keeper.status).mockResolvedValue({body:{executionId:'test-id',status:'completed',transactionHash:txHash,receipts:[{hash:txHash,chainId:50312,verified:true,receiptStatus:'success'}]},pollAfterMs:5000});
    vi.mocked(s.protocol.verify).mockResolvedValue({transactionHash:txHash,chainId:50312,blockNumber:'123',confirmedAt:Date.now(),orderId:'7',orderStatus:'PARTIALLY_FILLED',filledQuantity:'10000000',collateralMoved:'5000000',verified:true});
    await s.service.simulate(s.intent.id); const r = await s.service.execute(s.intent.id,s.signature);
    expect(r.status).toBe('SUCCESS'); expect(r.proof?.orderStatus).toBe('PARTIALLY_FILLED'); expect(s.protocol.verify).toHaveBeenCalledWith(s.intent,txHash);
  });
  it('preserves an uncertain record when independent verification fails', async () => {
    const s = await setup(); vi.mocked(s.keeper.status).mockResolvedValue({ body: { executionId: 'test-id', status: 'completed', transactionHash: txHash, receipts: [{hash:txHash,chainId:50312,verified:true,receiptStatus:'success'}] }, pollAfterMs:5000 });
    vi.mocked(s.protocol.verify).mockRejectedValue(new ExecutionError('PROOF_MISMATCH','Wrong calldata'));
    await s.service.simulate(s.intent.id); const r = await s.service.execute(s.intent.id,s.signature);
    expect(r.status).toBe('CONFIRMING'); expect(r.failure?.code).toBe('PROOF_MISMATCH');
  });
  it('creates only one bounded approval child without mutating the trade', async () => {
    const s = await setup(); const children = await Promise.all([s.service.approval(s.intent.id),s.service.approval(s.intent.id)]);
    expect(children[0].intent.intentHash).toBe(children[1].intent.intentHash);
    expect(children[0].intent.payload.functionName).toBe('approve');
    expect(JSON.parse(children[0].intent.payload.functionArgs)).toEqual([s.intent.poolAddress,s.intent.estimatedSpend]);
    expect((await s.store.get(s.intent.id))?.intent).toEqual(s.intent);
  });
  it('expires an interrupted preflight safely, but never clears an attempted broadcast', async () => {
    const s = await setup(); let r = (await s.store.get(s.intent.id))!; r.status='EXECUTING'; await s.store.save(r);
    vi.spyOn(Date,'now').mockReturnValue(s.intent.expiresAt);
    r=await s.service.refresh(s.intent.id); expect(r.status).toBe('STALE'); expect(s.keeper.execute).not.toHaveBeenCalled();
    r.status='CONFIRMING'; r.broadcastAttemptedAt=s.intent.createdAt; await s.store.save(r);
    expect((await s.service.refresh(s.intent.id)).status).toBe('CONFIRMING');
  });
  it('retains immutable intent and broadcast claim across database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(),'dreamcurve-execution-'));
    let db: DatabaseSync | null = new DatabaseSync(join(dir,'audit.sqlite'));
    try {
      let store = sqliteExecutionStore(db); const r = initialRecord(fixtureIntent()); await store.insert(r);
      r.status = 'CONFIRMING'; r.broadcastAttemptedAt = Date.now(); await store.save(r);
      db.close(); db = new DatabaseSync(join(dir,'audit.sqlite')); store = sqliteExecutionStore(db);
      expect((await store.get(r.intent.id))?.broadcastAttemptedAt).toBe(r.broadcastAttemptedAt);
      expect((await store.get(r.intent.id))?.intent).toEqual(r.intent);
    } finally { db?.close(); rmSync(dir,{recursive:true}); }
  });
});
