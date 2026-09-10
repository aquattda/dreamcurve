import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { ArenaState } from '../shared/domain';
import { authorizationMessage } from '../shared/execution';
import { checkExecutorFunding, configuredCollateral, readExecutorFunding, type FundingReader } from '../server/executor-funding';
import { checkTradeAmount, keeperLimits, limitStatus, tokenUnits } from '../server/execution-limits';
import { sqliteExecutionStore } from '../server/execution-store';
import { ExecutionService, initialRecord } from '../server/execution-service';
import { executionRoutes } from '../server/execution-routes';
import { KeeperClient } from '../server/keeperhub';
import type { ExecutionProtocol } from '../server/execution-protocol';
import { fixtureIntent, fixtureFunding, safeFixtureIntent, operator, wallet, token, txHash } from './execution-fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function reader(): FundingReader {
  return { chainId: vi.fn(async () => 50312), market: vi.fn(async () => ({ collateral: configuredCollateral(), decimals: 6, status: 1 })),
    nativeBalance: vi.fn(async () => 10n ** 18n), tokenBalance: vi.fn(async () => 5_000_000n), decimals: vi.fn(async () => 6), gasPrice: vi.fn(async () => 1_000_000_000n) };
}
describe('executor funding on the authoritative Shannon collateral', () => {
  it('accepts sufficient native gas and exact-token collateral for the executor', async () => {
    const rpc = reader(), funding = await checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc);
    expect(funding.readyToExecute).toBe(true);
    expect(funding.gas).toMatchObject({ balance: '1', sufficient: true, required: '0.004' });
    expect(funding.collateral).toMatchObject({ balance: '5', sufficient: true, tokenAddress: configuredCollateral(), decimals: 6 });
    expect(rpc.nativeBalance).toHaveBeenCalledWith(wallet);
    expect(rpc.tokenBalance).toHaveBeenCalledWith(configuredCollateral(), wallet);
  });
  it.each([0n, 3_999_999_999_999_999n])('blocks zero/insufficient STT (%s wei)', async balance => {
    const rpc = reader(); vi.mocked(rpc.nativeBalance).mockResolvedValue(balance);
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'INSUFFICIENT_EXECUTOR_GAS' });
  });
  it('does not count a funded operator wallet as executor collateral', async () => {
    const rpc = reader(); vi.mocked(rpc.tokenBalance).mockImplementation(async (_token, account) => account === operator.address ? 9_000_000n : 0n);
    const status = await readExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc);
    expect(status.collateral.balance).toBe('0'); expect(status.readyToExecute).toBe(false);
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'INSUFFICIENT_EXECUTOR_COLLATERAL' });
  });
  it('accepts the exact collateral boundary and rejects one raw unit below it', async () => {
    const rpc = reader(); vi.mocked(rpc.tokenBalance).mockResolvedValue(1_000_000n);
    expect((await checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).collateral.sufficient).toBe(true);
    vi.mocked(rpc.tokenBalance).mockResolvedValue(999_999n);
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'INSUFFICIENT_EXECUTOR_COLLATERAL' });
  });
  it('rejects a different market collateral before reading its balances', async () => {
    const rpc = reader(); vi.mocked(rpc.market).mockResolvedValue({ collateral: token, decimals: 6, status: 1 });
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'COLLATERAL_MISMATCH' });
    expect(rpc.tokenBalance).not.toHaveBeenCalled();
  });
  it('rejects a frozen intent with a mismatched token or changed decimals', async () => {
    const rpc = reader(), i = safeFixtureIntent();
    await expect(checkExecutorFunding(wallet, i.marketId, { intent: i }, rpc)).rejects.toMatchObject({ code: 'COLLATERAL_MISMATCH' });
    vi.mocked(rpc.decimals).mockResolvedValue(18);
    await expect(checkExecutorFunding(wallet, i.marketId, {}, rpc)).rejects.toMatchObject({ code: 'COLLATERAL_MISMATCH' });
  });
  it.each([1, 5031, 8453, 11155111])('rejects RPC chain %s before market or balance queries', async chain => {
    const rpc = reader(); vi.mocked(rpc.chainId).mockResolvedValue(chain);
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'NETWORK_UNSUPPORTED' });
    expect(rpc.market).not.toHaveBeenCalled(); expect(rpc.nativeBalance).not.toHaveBeenCalled();
  });
  it('checks the real gas estimate after simulation and handles non-trading markets', async () => {
    const rpc = reader(); vi.mocked(rpc.nativeBalance).mockResolvedValue(4_000_000_000_000_000n);
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, { gasEstimate: '3000000' }, rpc)).rejects.toMatchObject({ code: 'INSUFFICIENT_EXECUTOR_GAS' });
    vi.mocked(rpc.market).mockResolvedValue({ collateral: configuredCollateral(), decimals: 6, status: 2 });
    await expect(checkExecutorFunding(wallet, safeFixtureIntent().marketId, {}, rpc)).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
  });
});

describe('exact server trade and demo limits', () => {
  it.each(['0.000001', '0.5', '1', '1.000000'])('accepts %s tUSDC at six decimals', amount => {
    expect(checkTradeAmount(amount, 6)).toBeGreaterThan(0n);
  });
  it.each(['1.000001', '5', '9007199254740993'])('rejects %s tUSDC without float rounding', amount => {
    expect(() => checkTradeAmount(amount, 6)).toThrow(expect.objectContaining({ code: 'TRADE_LIMIT_EXCEEDED' }));
  });
  it('uses exact integer conversion and rejects excess precision/exponents/zero', () => {
    expect(tokenUnits('9007199254740993.000001', 6)).toBe(9007199254740993000001n);
    for (const amount of ['1.0000001', '1e-6', '-1', 'NaN', '0']) expect(() => checkTradeAmount(amount, 6)).toThrow();
  });
  it('accepts cumulative exposure at 5 and rejects above 5', () => {
    expect(limitStatus('1', 4n * 10n ** 18n)).toMatchObject({ allowed: true, remainingSession: '1' });
    expect(limitStatus('1', 4n * 10n ** 18n + 1n).issues[0].code).toBe('SESSION_LIMIT_EXCEEDED');
  });
  it.each(['1', '5031', '8453', '50312x'])('rejects configured chain %s', chain => {
    expect(() => keeperLimits({ KEEPERHUB_CHAIN_ID: chain })).toThrow(expect.objectContaining({ code: 'NETWORK_UNSUPPORTED' }));
  });
  it('allows lower settings but refuses settings above the fixed demo ceilings', () => {
    vi.stubEnv('KEEPERHUB_MAX_TRADE_TUSDC', '0.5');
    expect(() => checkTradeAmount('0.500001', 6)).toThrow(expect.objectContaining({ code: 'TRADE_LIMIT_EXCEEDED' }));
    expect(() => keeperLimits({ KEEPERHUB_MAX_TRADE_TUSDC: '2' })).toThrow();
    expect(() => keeperLimits({ KEEPERHUB_MAX_SESSION_TUSDC: '6' })).toThrow();
  });
  it('persists all attempted exposure across reopen, beyond the 100-item history window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dreamcurve-budget-'));
    let db: DatabaseSync | null = new DatabaseSync(join(dir, 'audit.sqlite'));
    try {
      let store = sqliteExecutionStore(db);
      for (let n = 0; n < 5; n++) {
        const r = initialRecord(safeFixtureIntent({ id: `attempt-${n}` })); r.status = 'FAILED'; r.broadcastAttemptedAt = Date.now(); await store.insert(r);
      }
      for (let n = 0; n < 101; n++) await store.insert(initialRecord(safeFixtureIntent({ id: `review-${n}` })));
      const approval = initialRecord(safeFixtureIntent({ id: 'approval', kind: 'APPROVAL', parentIntentId: 'review-0' }));
      approval.broadcastAttemptedAt = Date.now(); approval.status = 'SUCCESS'; await store.insert(approval);
      expect((await store.list()).length).toBe(100);
      expect(await store.exposure(wallet)).toBe(5n * 10n ** 18n);
      db.close(); db = new DatabaseSync(join(dir, 'audit.sqlite')); store = sqliteExecutionStore(db);
      expect(await store.exposure(wallet.toUpperCase())).toBe(5n * 10n ** 18n);
      expect(limitStatus('0.5', await store.exposure(wallet)).allowed).toBe(false);
    } finally { db?.close(); rmSync(dir, { recursive: true }); }
  });
  it('atomically permits only one of two concurrent trades with 1 tUSDC remaining', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = sqliteExecutionStore(db);
      for (let n = 0; n < 4; n++) {
        const r = initialRecord(safeFixtureIntent({ id: `prior-${n}` })); r.broadcastAttemptedAt = Date.now(); r.status = 'SUCCESS'; await store.insert(r);
      }
      const keeper = new KeeperClient({ baseUrl: 'https://keeper.example', apiKey: 'kh_test', wallet, operators: [operator.address], domain: 'test.local', eoaConfirmed: true });
      vi.spyOn(keeper, 'assertChain').mockResolvedValue();
      vi.spyOn(keeper, 'simulate').mockResolvedValue({ body: { success: true, status: 'simulated', from: wallet, to: safeFixtureIntent().poolAddress, value: '0', wouldRevert: false, gasEstimate: '800000' }, pollAfterMs: 5000 });
      vi.spyOn(keeper, 'execute').mockResolvedValue({ body: { executionId: 'test', status: 'unconfirmed', transactionHash: txHash }, pollAfterMs: 5000 });
      vi.spyOn(keeper, 'status').mockResolvedValue({ body: { executionId: 'test', status: 'unconfirmed', transactionHash: txHash, receipts: [] }, pollAfterMs: 5000 });
      const protocol: ExecutionProtocol = { prepare: vi.fn(), check: vi.fn(async () => ['Funded']), funding: vi.fn(async () => fixtureFunding()), verify: vi.fn() };
      const service = new ExecutionService(store, keeper, protocol);
      const intents = [safeFixtureIntent({ id: 'a' }), safeFixtureIntent({ id: 'b' })];
      for (const i of intents) { await store.insert(initialRecord(i)); await service.simulate(i.id); }
      await Promise.allSettled(intents.map(async i => service.execute(i.id, await operator.signMessage({ message: authorizationMessage(i) }))));
      expect(keeper.execute).toHaveBeenCalledTimes(1); expect(await store.exposure(wallet)).toBe(5n * 10n ** 18n);
      expect((await service.safety(intents.find(i => i.id !== (vi.mocked(keeper.execute).mock.calls[0][1] === intents[0].intentHash ? 'a' : 'b'))!.id)).limits?.allowed).toBe(false);
    } finally { db.close(); }
  });
});

describe('HTTP clients cannot override backend safety policy', () => {
  it('rejects oversized requests, foreign chains and a previously frozen oversized signed intent', async () => {
    vi.stubEnv('KEEPERHUB_API_KEY', 'kh_test_only'); vi.stubEnv('KEEPERHUB_WALLET_ADDRESS', wallet);
    vi.stubEnv('KEEPERHUB_OPERATOR_ADDRESSES', operator.address); vi.stubEnv('KEEPERHUB_SIGNER_MODE', 'eoa'); vi.stubEnv('KEEPERHUB_AUTHORIZATION_DOMAIN', 'test.local');
    const db = new DatabaseSync(':memory:'), store = sqliteExecutionStore(db);
    const oversized = fixtureIntent(), record = initialRecord(oversized);
    record.status = 'READY'; record.preflight = { passed: true, at: Date.now(), checks: [] }; await store.insert(record);
    const app = express(); app.use(express.json());
    app.use('/api/executions', executionRoutes(store, () => ({ mode: 'live', status: 'healthy', markets: [{ id: oversized.marketId }], forecasts: [] }) as unknown as ArenaState));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/executions`;
    const post = (path: string, body: unknown) => fetch(`${root}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const response = await post('/prepare', { marketId: oversized.marketId, side: 'YES', stake: '2', operatorAddress: operator.address, maxTrade: '100', sessionSpent: '0' });
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'TRADE_LIMIT_EXCEEDED' });
      const foreign = await post('/prepare', { chainId: 1 }); expect(await foreign.json()).toMatchObject({ code: 'NETWORK_UNSUPPORTED' });
      const simulation = await post(`/${oversized.id}/simulate`, {}); expect(await simulation.json()).toMatchObject({ status: 'BLOCKED', failure: { code: 'TRADE_LIMIT_EXCEEDED' } });
      const ready = (await store.get(oversized.id))!; ready.status = 'READY'; ready.preflight = { passed: true, at: Date.now(), checks: [] }; await store.save(ready);
      const execution = await post(`/${oversized.id}/execute`, { signature: await operator.signMessage({ message: authorizationMessage(oversized) }), maxTrade: '100' });
      expect(await execution.json()).toMatchObject({ status: 'BLOCKED', failure: { code: 'TRADE_LIMIT_EXCEEDED' }, broadcastAttemptedAt: null });
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); db.close(); }
  });
});
