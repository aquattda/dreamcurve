import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { contractCall, freezeIntent, type ExecutionIntent, type ExecutorFunding } from '../shared/execution';

// Public deterministic test identity only. Never used by runtime or live tests.
export const operator = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const wallet = `0x${'22'.repeat(20)}` as Address;
export const pool = `0x${'33'.repeat(20)}` as Address;
export const token = `0x${'44'.repeat(20)}` as Address;
export const txHash = `0x${'aa'.repeat(32)}` as Hex;
export function fixtureIntent(overrides: Partial<ExecutionIntent> = {}) {
  const createdAt = Date.now();
  const fields = { version: 1 as const, id: 'test-intent', kind: 'TRADE' as const, parentIntentId: null, createdAt, expiresAt: createdAt + 120_000,
    chainId: 50312 as const, marketId: `0x${'55'.repeat(32)}` as Hex, marketTitle: 'BTC test fixture', marketSymbol: 'BTC', marketExpiry: createdAt + 600_000,
    poolAddress: pool, collateralToken: token, collateralDecimals: 6, walletAddress: wallet, operatorAddress: operator.address,
    authorizationDomain: 'test.local', side: 'YES' as const, yesPrice: '500000', limitPrice: '500000', quantity: '20000000', estimatedSpend: '10000000', stake: '10000000',
    tick: '1000', lot: '1000000', minQuantity: '1000000', orderType: 2, expireTimestampNs: (BigInt(createdAt + 120_000) * 1_000_000n).toString(),
    recommendation: null, recommendationSource: 'manual' as const, ...overrides };
  return freezeIntent({ ...fields, ...contractCall(fields) });
}
export function safeFixtureIntent(overrides: Partial<ExecutionIntent> = {}) {
  return fixtureIntent({ quantity: '2000000', estimatedSpend: '1000000', stake: '1000000', ...overrides });
}
export function fixtureFunding(i = safeFixtureIntent()): ExecutorFunding {
  return { chainId: 50312, executorAddress: i.walletAddress, marketId: i.marketId, checkedAt: Date.now(),
    gas: { symbol: 'STT', balance: '1', balanceRaw: '1000000000000000000', required: '0.004', requiredRaw: '4000000000000000', sufficient: true, estimateSource: 'conservative-budget' },
    collateral: { symbol: 'tUSDC', tokenAddress: i.collateralToken, decimals: 6, balance: '5', balanceRaw: '5000000', required: '1', requiredRaw: '1000000', sufficient: true }, readyToExecute: true, issues: [] };
}
