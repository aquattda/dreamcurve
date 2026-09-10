import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AAVE, EARN_ASSETS, EARN_CHAIN, earnCall, freezeEarn, type EarnAction, type EarnAsset, type EarnSnapshot } from '../shared/earn';

// Public, deterministic TEST-ONLY identity. Never loaded by the app or doctor.
export const earnOperator = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const earnWallet = `0x${'22'.repeat(20)}` as Address;
export const earnHash = `0x${'aa'.repeat(32)}` as Hex;
export function earnFixture(action: EarnAction = 'SUPPLY', id = 'earn-test', assetId: EarnAsset = 'USDC') {
  const createdAt = Date.now();
  const asset = EARN_ASSETS[assetId], amount = (10n ** BigInt(asset.decimals) / 2n).toString();
  return freezeEarn({ version: 'earn-v1', protocol: 'aave-v3', id, chainId: EARN_CHAIN, action, amount, decimals: asset.decimals, token: asset.token, pool: AAVE.pool, aToken: asset.aToken, walletAddress: earnWallet, operatorAddress: earnOperator.address, authorizationDomain: 'test.local', createdAt, expiresAt: createdAt + 600_000, rationale: 'Explicit test fixture, not a live recommendation.', ...earnCall(action,amount,earnWallet,asset.token) });
}
export function earnSnapshot(assetId: EarnAsset = 'USDC'): EarnSnapshot {
  const asset = EARN_ASSETS[assetId], unit = 10n ** BigInt(asset.decimals);
  return { checkedAt: Date.now(), chainId: EARN_CHAIN, walletAddress: earnWallet, pool: AAVE.pool, token: asset.token, aToken: asset.aToken, decimals: asset.decimals, gasBalance: '100000000000000000', gasPrice: '1000000000', tokenBalance: (5n * unit).toString(), aTokenBalance: (5n * unit).toString(), allowance: unit.toString(), availableLiquidity: (100n * unit).toString(), debtBase: '0', active: true, frozen: false, paused: false, supplyCap: '1000', supplied: (100n * unit).toString() };
}
