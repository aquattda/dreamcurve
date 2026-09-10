import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Transaction, type TransactionReceipt, type Hex } from 'viem';
import express from 'express';
import { AAVE, EARN_ASSETS, EARN_CHAIN, earnAbi, earnAmount, earnAuthorization, freezeEarn, freshEarn, verifyEarn, type EarnAsset } from '../shared/earn';
import { checkEarnSnapshot, decodeReserveConfiguration, verifyEarnReceipt } from '../server/earn-protocol';
import { earnExposure, sqliteEarnStore } from '../server/earn-store';
import { EarnService, initialEarn } from '../server/earn-service';
import { KeeperClient } from '../server/keeperhub';
import { earnRoutes } from '../server/earn-routes';
import { earnFixture, earnHash, earnOperator, earnSnapshot, earnWallet } from './earn-fixtures';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });
function kit(free = true) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const store = sqliteEarnStore(db), snapshot = vi.fn(async () => earnSnapshot());
  const requests: { path: string; body: Record<string,unknown> }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = JSON.parse(String(init?.body || '{}')) as Record<string,unknown>; requests.push({ path,body });
    if (path.endsWith('/api/chains')) return Response.json([{ chainId: EARN_CHAIN, isEnabled: true, isTestnet: true, chainType: 'evm' }]);
    if (path.endsWith('/api/user/wallet')) return Response.json({ walletAddress: earnWallet });
    if (path.endsWith('/api/user/safe')) return Response.json({ safes: [] });
    if (path.endsWith('/status')) return Response.json({ executionId: 'earn-test-exec', status: 'completed', transactionHash: earnHash, receipts: [{ hash: earnHash, chainId: EARN_CHAIN, verified: true, receiptStatus: 'success' }] });
    if (body.simulate === true) return Response.json({ success: true, status: 'simulated', wouldRevert: false, from: earnWallet, to: body.contractAddress, value: '0', gasEstimate: '70000' });
    return Response.json({ executionId: 'earn-test-exec', status: 'pending', transactionHash: earnHash });
  });
  const keeper = new KeeperClient({ baseUrl: 'https://keeper.test', apiKey: 'test-fixture-not-a-key', wallet: earnWallet, operators: [earnOperator.address], domain: 'test.local', eoaConfirmed: true },fetcher as typeof fetch);
  const verify = vi.fn(async (i: ReturnType<typeof earnFixture>) => ({ transactionHash: earnHash, blockNumber: '10', chainId: EARN_CHAIN as typeof EARN_CHAIN, action: i.action, amount: i.amount, verified: true as const, confirmedAt: Date.now() }));
  const service = new EarnService(store,keeper,{ snapshot,verify },() => free);
  return { db,store,service,keeper,snapshot,verify,requests,fetcher, writes: () => requests.filter(r => r.path.endsWith('/contract-call') && r.body.simulate !== true) };
}
async function ready(k: ReturnType<typeof kit>, id = 'earn-test') {
  const i = earnFixture('SUPPLY',id); await k.store.insert(initialEarn(i)); await k.service.simulate(i.id);
  const signature = await earnOperator.signMessage({ message: earnAuthorization(i) }); return { i,signature };
}
describe('Earn intent and deployment boundary',() => {
  it.each(['0','-1','1.000001','1e0','0.0000001','2','NaN','Infinity'])('rejects unsafe amount %s',amount => expect(() => earnAmount(amount)).toThrow());
  it('uses exact decimal units',() => { expect(earnAmount('0.000001')).toBe(1n); expect(earnAmount('1.000000')).toBe(1_000_000n); });
  it('preserves all 18 LINK decimals without rounding or relaxing the one-token limit',() => {
    expect(earnAmount('0.000000000000000001',18)).toBe(1n);
    expect(earnAmount('0.123456789012345678',18)).toBe(123456789012345678n);
    expect(earnAmount('1',18)).toBe(10n ** 18n);
    for (const value of ['1.000000000000000001','0.0000000000000000001','1e-18']) expect(() => earnAmount(value,18)).toThrow();
  });
  it.each(['APPROVAL','SUPPLY','WITHDRAW'] as const)('binds LINK metadata and exact %s calldata',action => {
    const i = earnFixture(action,'link','LINK');
    expect(i.amount).toBe('500000000000000000'); expect(i.decimals).toBe(18);
    expect(() => verifyEarn(i)).not.toThrow();
    expect(() => verifyEarn({ ...i, token: AAVE.token })).toThrow();
    expect(() => verifyEarn(freezeEarn({ ...i, decimals: 6 }))).toThrow();
    expect(() => verifyEarn(freezeEarn({ ...i, aToken: AAVE.aToken }))).toThrow();
  });
  it.each(['APPROVAL','SUPPLY','WITHDRAW'] as const)('freezes and encodes %s',action => { const i = earnFixture(action); expect(() => verifyEarn(i)).not.toThrow(); const { intentHash,...body } = i; expect(freezeEarn(body).intentHash).toBe(intentHash); });
  it('detects mutated amounts and payloads',() => {
    const i = earnFixture(); expect(() => verifyEarn({ ...i, amount: '1' })).toThrow();
    expect(() => verifyEarn(freezeEarn({ ...i, payload: { ...i.payload, chainId: 1 } }))).toThrow();
    expect(() => verifyEarn(freezeEarn({ ...i, token: earnWallet }))).toThrow();
  });
  it('blocks expired intent without changing the payload',() => { const i = earnFixture(); i.expiresAt = Date.now() - 1; expect(() => freshEarn(i)).toThrow(/expired/); });
});
describe('Aave preflight safety',() => {
  it('checks LINK balances and cap in 18-decimal units and identifies the correct funding asset',() => {
    const i = earnFixture('SUPPLY','link','LINK'), s = earnSnapshot('LINK');
    expect(() => checkEarnSnapshot(i,{ ...s, supplyCap: '0' })).not.toThrow();
    expect(() => checkEarnSnapshot(i,{ ...s, supplyCap: '100' })).toThrow(/cap/);
    expect(() => checkEarnSnapshot(i,{ ...s, tokenBalance: '499999999999999999' })).toThrow(/test LINK/);
    expect(() => checkEarnSnapshot(i,earnSnapshot())).toThrow();
  });
  it('decodes Pool reserve flags and the complete 36-bit supply cap',() => {
    const cap = (1n << 36n) - 1n;
    expect(decodeReserveConfiguration((6n << 48n) | (1n << 56n) | (1n << 57n) | (1n << 60n) | (cap << 116n))).toEqual({ decimals: 6, active: true, frozen: true, paused: true, supplyCap: cap.toString() });
    expect(decodeReserveConfiguration(0n)).toEqual({ decimals: 0, active: false, frozen: false, paused: false, supplyCap: '0' });
  });
  it.each([
    ['gasBalance','0'],['gasPrice','0'],['tokenBalance','0'],['allowance','0'],['debtBase','1'],['active',false],['paused',true],['frozen',true],['decimals',18],['pool',earnWallet],['token',earnWallet],['aToken',earnWallet],['chainId',50312],
  ])('blocks invalid %s',(key,value) => expect(() => checkEarnSnapshot(earnFixture(),{ ...earnSnapshot(), [String(key)]: value })).toThrow());
  it('permits bounded approval without allowance',() => expect(() => checkEarnSnapshot(earnFixture('APPROVAL'),{ ...earnSnapshot(), allowance: '0' })).not.toThrow());
  it('blocks reserve cap exhaustion',() => expect(() => checkEarnSnapshot(earnFixture(),{ ...earnSnapshot(), supplyCap: '100', supplied: '100000000' })).toThrow(/cap/));
  it('checks position and liquidity for withdrawal',() => {
    expect(() => checkEarnSnapshot(earnFixture('WITHDRAW'),{ ...earnSnapshot(), aTokenBalance: '0' })).toThrow();
    expect(() => checkEarnSnapshot(earnFixture('WITHDRAW'),{ ...earnSnapshot(), availableLiquidity: '0' })).toThrow();
    expect(() => checkEarnSnapshot(earnFixture('WITHDRAW'),{ ...earnSnapshot(), frozen: true, tokenBalance: '0', allowance: '0' })).not.toThrow();
  });
});
describe('Earn durable execution',() => {
  it('defaults new intents to LINK and keeps legacy USDC records unchanged',async () => {
    const k = kit(), legacy = earnFixture(); await k.store.insert(initialEarn(legacy));
    k.snapshot.mockResolvedValue(earnSnapshot('LINK'));
    const r = await k.service.prepare('SUPPLY','0.5',earnOperator.address);
    expect(r.intent.token).toBe(EARN_ASSETS.LINK.token); expect(r.intent.amount).toBe('500000000000000000');
    expect(k.snapshot).toHaveBeenCalledWith(earnWallet,EARN_ASSETS.LINK.token);
    expect((await k.store.get(legacy.id))?.intent).toEqual(legacy);
    expect(k.writes()).toHaveLength(0);
  });
  it('combines legacy USDC and LINK exposure without resetting the durable budget',async () => {
    const k = kit();
    for (let n = 0; n < 10; n++) {
      const r = initialEarn(earnFixture('SUPPLY',`mixed-${n}`,n % 2 ? 'LINK' : 'USDC'));
      r.status = 'CONFIRMING'; r.broadcastAttemptedAt = Date.now();
      // Historical completed attempts still count, without claiming a second in-flight lock.
      r.status = 'FAILED'; await k.store.insert(r);
    }
    expect(earnExposure(await k.store.list(earnWallet),'SUPPLY')).toBe(5n * 10n ** 18n);
    k.snapshot.mockResolvedValue(earnSnapshot('LINK'));
    await expect(k.service.prepare('SUPPLY','0.000000000000000001',earnOperator.address)).rejects.toThrow(/durable/);
    expect(k.writes()).toHaveLength(0);
  });
  it('prepares only server-owned protocol calls',async () => {
    const k = kit(); const r = await k.service.prepare('SUPPLY','0.5',earnOperator.address,'USDC');
    expect(r.intent.pool).toBe(AAVE.pool); expect(k.writes()).toHaveLength(0);
  });
  it('rejects mainnet configuration',async () => { vi.stubEnv('EARN_CHAIN_ID','1'); await expect(kit().service.prepare('SUPPLY','0.5',earnOperator.address,'USDC')).rejects.toThrow(/Sepolia/); });
  it('requires billing confirmation before broadcasts',async () => { const k = kit(false), { i,signature } = await ready(k); await expect(k.service.execute(i.id,signature)).rejects.toThrow(/free/); expect(k.writes()).toHaveLength(0); });
  it('requires a genuine signature',async () => { const k = kit(), { i } = await ready(k); await expect(k.service.execute(i.id,`0x${'00'.repeat(65)}`)).rejects.toThrow(); expect(k.writes()).toHaveLength(0); });
  it('requires dry run before authorization',async () => { const k = kit(), i = earnFixture(); await k.store.insert(initialEarn(i)); await expect(k.service.execute(i.id,await earnOperator.signMessage({ message: earnAuthorization(i) }))).rejects.toThrow(/dry run/); });
  it('executes exactly once across concurrent requests and replay',async () => {
    const k = kit(), { i,signature } = await ready(k);
    await Promise.allSettled([k.service.execute(i.id,signature),k.service.execute(i.id,signature)]);
    await k.service.execute(i.id,signature);
    expect(k.writes()).toHaveLength(1); expect(k.writes()[0].body).toEqual(i.payload);
    expect((await k.store.get(i.id))?.status).toBe('SUCCESS'); expect(k.verify).toHaveBeenCalled();
  });
  it('rechecks balances after review',async () => { const k = kit(), { i,signature } = await ready(k); k.snapshot.mockResolvedValue({ ...earnSnapshot(), tokenBalance: '0' }); expect((await k.service.execute(i.id,signature)).status).toBe('BLOCKED'); expect(k.writes()).toHaveLength(0); });
  it('rejects a mismatching simulation sender',async () => {
    const k = kit(); vi.spyOn(k.keeper,'simulate').mockResolvedValue({ body: { success: true, status: 'simulated', wouldRevert: false, from: AAVE.pool, to: AAVE.pool, value: '0', gasEstimate: '70000' }, pollAfterMs: 5000 });
    await k.store.insert(initialEarn(earnFixture())); expect((await k.service.simulate('earn-test')).failure?.code).toBe('PROOF_MISMATCH');
  });
  it('never resends a timed-out attempted broadcast',async () => {
    const k = kit(), { i,signature } = await ready(k); const execute = vi.spyOn(k.keeper,'execute').mockRejectedValue(new Error('timeout'));
    expect((await k.service.execute(i.id,signature)).status).toBe('CONFIRMING');
    await k.service.execute(i.id,signature); expect(execute).toHaveBeenCalledTimes(1);
    const next = earnFixture('SUPPLY','next'); await k.store.insert(initialEarn(next)); await k.service.simulate(next.id);
    await expect(k.service.execute(next.id,await earnOperator.signMessage({ message: earnAuthorization(next) }))).rejects.toThrow(/unresolved/);
  });
  it('does not mark success for a receipt from another chain',async () => {
    const k = kit(), { i,signature } = await ready(k); await k.service.execute(i.id,signature);
    vi.spyOn(k.keeper,'status').mockResolvedValue({ body: { executionId: 'earn-test-exec', status: 'completed', transactionHash: earnHash, receipts: [{ hash: earnHash, chainId: 1, verified: true, receiptStatus: 'success' }] }, pollAfterMs: 5000 });
    expect((await k.service.refresh(i.id)).status).toBe('CONFIRMING'); expect(k.verify).not.toHaveBeenCalled();
  });
  it('checks full history, not only the latest 100 records',async () => {
    const k = kit();
    for (let n = 0;n < 110;n++) { const r = initialEarn(earnFixture(n < 10 ? 'SUPPLY' : 'APPROVAL',`old-${n}`)); r.status = 'FAILED'; r.broadcastAttemptedAt = Date.now(); await k.store.insert(r); }
    expect(await k.store.list()).toHaveLength(100); expect(await k.store.list(earnWallet)).toHaveLength(110);
    await expect(k.service.prepare('SUPPLY','0.5',earnOperator.address,'USDC')).rejects.toThrow(/durable/);
    expect(earnExposure(await k.store.list(earnWallet),'WITHDRAW')).toBe(0n);
  });
  it('reserves the last budget atomically across competing intents',async () => {
    const k = kit();
    for (let n = 0;n < 9;n++) { const r = initialEarn(earnFixture('SUPPLY',`old-${n}`)); r.status = 'FAILED'; r.broadcastAttemptedAt = Date.now(); await k.store.insert(r); }
    const a = await ready(k,'a'), b = await ready(k,'b');
    await Promise.allSettled([k.service.execute(a.i.id,a.signature),k.service.execute(b.i.id,b.signature)]);
    expect(k.writes()).toHaveLength(1); expect(earnExposure(await k.store.list(earnWallet),'SUPPLY')).toBe(5n * 10n ** 18n);
  });
  it('preserves immutable intents and CAS revisions',async () => {
    const k = kit(), i = earnFixture(); await k.store.insert(initialEarn(i));
    const r = (await k.store.get(i.id))!; await k.store.save(r); await expect(k.store.save(r)).rejects.toThrow();
    await expect(k.store.save({ ...r, revision: 1, intent: freezeEarn({ ...i, rationale: 'Changed' }) })).rejects.toThrow();
  });
  it('persists attempted exposure across SQLite reopen',async () => {
    const directory = mkdtempSync(join(tmpdir(),'dreamcurve-earn-test-')), path = join(directory,'audit.sqlite');
    let db = new DatabaseSync(path);
    try { const r = initialEarn(earnFixture()); r.status = 'CONFIRMING'; r.broadcastAttemptedAt = Date.now(); await sqliteEarnStore(db).insert(r); db.close(); db = new DatabaseSync(path); expect(earnExposure(await sqliteEarnStore(db).list(earnWallet),'SUPPLY')).toBe(5n * 10n ** 17n); }
    finally { db.close(); rmSync(directory,{ recursive: true, force: true }); }
  });
});
function proofFixture(action: 'SUPPLY' | 'WITHDRAW' | 'APPROVAL', asset: EarnAsset = 'USDC') {
  const i = earnFixture(action,'proof',asset), amount = BigInt(i.amount);
  const transfer = { address: i.token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: action === 'SUPPLY' ? earnWallet : i.aToken, to: action === 'SUPPLY' ? i.aToken : earnWallet } }), data: encodeAbiParameters([{ type: 'uint256' }],[amount]) };
  const specific = action === 'APPROVAL' ? { address: i.token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: earnWallet, spender: AAVE.pool } }), data: encodeAbiParameters([{ type: 'uint256' }],[amount]) }
    : action === 'SUPPLY' ? { address: AAVE.pool, topics: encodeEventTopics({ abi: earnAbi, eventName: 'Supply', args: { reserve: i.token, onBehalfOf: earnWallet, referralCode: 0 } }), data: encodeAbiParameters([{ type: 'address' },{ type: 'uint256' }],[earnWallet,amount]) }
      : { address: AAVE.pool, topics: encodeEventTopics({ abi: earnAbi, eventName: 'Withdraw', args: { reserve: i.token, user: earnWallet, to: earnWallet } }), data: encodeAbiParameters([{ type: 'uint256' }],[amount]) };
  const tx = { hash: earnHash, from: earnWallet, to: i.payload.contractAddress, input: i.calldata, value: 0n, chainId: EARN_CHAIN } as Transaction;
  const receipt = { status: 'success', transactionHash: earnHash, from: earnWallet, to: i.payload.contractAddress, blockNumber: 10n, logs: action === 'APPROVAL' ? [specific] : [specific,transfer] } as unknown as TransactionReceipt;
  return { i,tx,receipt };
}
describe('Independent Aave proof',() => {
  it('reports sponsored envelope mismatches without accepting a matching Approval event',() => {
    const { i,tx,receipt } = proofFixture('APPROVAL','LINK');
    const frozenBefore = JSON.stringify(i);
    const wrapped = { ...tx, type: 'eip7702' as const, from: AAVE.pool, to: AAVE.provider, input: '0x9aefaff8' as Hex } as Transaction;
    const outerReceipt = { ...receipt, from: AAVE.pool, to: AAVE.provider };
    expect(() => verifyEarnReceipt(i,earnHash,wrapped,outerReceipt)).toThrow('Mismatched fields: transaction.from, transaction.to, transaction.input, receipt.from, receipt.to. EIP-7702 envelope detected');
    expect(JSON.stringify(i)).toBe(frozenBefore);
  });
  it.each(['SUPPLY','WITHDRAW','APPROVAL'] as const)('verifies exact LINK %s and rejects same-symbol token substitution',action => {
    const { i,tx,receipt } = proofFixture(action,'LINK');
    expect(verifyEarnReceipt(i,earnHash,tx,receipt).verified).toBe(true);
    const logs = receipt.logs.map(log => log.address === i.token ? { ...log, address: AAVE.token } : log);
    expect(() => verifyEarnReceipt(i,earnHash,tx,{ ...receipt, logs })).toThrow();
  });
  it.each(['SUPPLY','WITHDRAW','APPROVAL'] as const)('verifies exact %s proof',action => { const { i,tx,receipt } = proofFixture(action); expect(verifyEarnReceipt(i,earnHash,tx,receipt).verified).toBe(true); });
  it('requires underlying token movement, not just a Supply event',() => { const { i,tx,receipt } = proofFixture('SUPPLY'); expect(() => verifyEarnReceipt(i,earnHash,tx,{ ...receipt, logs: receipt.logs.slice(0,1) })).toThrow(/movement/); });
  it('rejects wrong sender, calldata and reverted receipt',() => {
    const { i,tx,receipt } = proofFixture('SUPPLY');
    expect(() => verifyEarnReceipt(i,earnHash,{ ...tx, from: AAVE.pool },receipt)).toThrow();
    expect(() => verifyEarnReceipt(i,earnHash,{ ...tx, input: '0x00' as Hex },receipt)).toThrow();
    expect(() => verifyEarnReceipt(i,earnHash,tx,{ ...receipt, status: 'reverted' })).toThrow();
  });
});
describe('Earn HTTP boundary',() => {
  it('rejects caller-selected targets, mainnet and unsigned execution',async () => {
    const k = kit(), app = express(); app.use(express.json()); app.use('/api/earn',earnRoutes(k.service));
    const server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server.once('listening',resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const url = `http://127.0.0.1:${address.port}/api/earn`;
    try {
      const base = { chainId: EARN_CHAIN, action: 'SUPPLY', amount: '0.5', operatorAddress: earnOperator.address };
      for (const body of [{ ...base, chainId: 1 },{ ...base, pool: AAVE.pool },{ ...base, amount: '2' }]) expect((await fetch(`${url}/intents`,{ method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
      expect((await fetch(`${url}/intents/unknown/execute`,{ method: 'POST', headers: { 'Content-Type':'application/json' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`${url}/intents`,{ method: 'POST', headers: { 'Content-Type':'application/json', 'sec-fetch-site':'cross-site' }, body: JSON.stringify(base) })).status).toBe(403);
      expect(k.writes()).toHaveLength(0);
    } finally { await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
