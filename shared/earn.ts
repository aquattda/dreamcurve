import { encodeFunctionData, isAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { canonicalJson, ExecutionError, type ContractExecutionPayload, type ExecutionStatus, type Failure, type PreflightResult } from './execution';

// Official Aave DAO address book, AaveV3Sepolia.sol. Revalidated onchain at runtime.
export const EARN_CHAIN = 11155111;
export const EARN_ASSETS = {
  USDC: { symbol: 'USDC', token: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', aToken: '0x16dA4541aD1807f4443d92D26044C1147406EB80', decimals: 6 },
  LINK: { symbol: 'LINK', token: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5', aToken: '0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24', decimals: 18 },
} as const;
export type EarnAsset = keyof typeof EARN_ASSETS;
export function earnAssetFor(token: string) {
  const asset = Object.values(EARN_ASSETS).find(a => a.token.toLowerCase() === token.toLowerCase());
  if (!asset) throw new ExecutionError('INVALID_INPUT','Only allowlisted Aave Sepolia test assets are permitted.');
  return asset;
}
export const AAVE = {
  provider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  dataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
  token: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
  aToken: '0x16dA4541aD1807f4443d92D26044C1147406EB80',
  faucet: '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D',
} as const;
// Normalize aggregate budgets to 18 decimals across both TEST assets; this is
// a token-count demo cap, not a claim that LINK and USDC have equal USD value.
export const EARN_TOTAL = 5n * 10n ** 18n;
export const earnAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
]);
export type EarnAction = 'APPROVAL' | 'SUPPLY' | 'WITHDRAW';
export type EarnBody = {
  version: 'earn-v1'; protocol: 'aave-v3'; id: string; chainId: typeof EARN_CHAIN;
  action: EarnAction; amount: string; decimals: number; token: Address; pool: Address; aToken: Address;
  walletAddress: Address; operatorAddress: Address; authorizationDomain: string;
  createdAt: number; expiresAt: number; rationale: string;
  payload: ContractExecutionPayload; calldata: Hex;
};
export type EarnIntent = EarnBody & { intentHash: Hex };
export type EarnProof = { transactionHash: Hex; blockNumber: string; chainId: typeof EARN_CHAIN; action: EarnAction; amount: string; verified: true; confirmedAt: number };
export type EarnRecord = {
  intent: EarnIntent; revision: number; status: ExecutionStatus; preflight: PreflightResult | null;
  failure: Failure | null; broadcastAttemptedAt: number | null; keeperHubExecutionId: string | null;
  txHash: Hex | null; keeperHubStatus: string | null; proof: EarnProof | null;
  pollAfterMs: number; lastPollAt: number; timeline: { at: number; event: string; detail: string }[];
};
export type EarnSnapshot = {
  checkedAt: number; chainId: typeof EARN_CHAIN; walletAddress: Address;
  pool: Address; token: Address; aToken: Address; decimals: number;
  gasBalance: string; gasPrice: string; tokenBalance: string; aTokenBalance: string;
  allowance: string; availableLiquidity: string; debtBase: string;
  active: boolean; frozen: boolean; paused: boolean; supplyCap: string; supplied: string;
};
export type EarnOverview = {
  snapshot: EarnSnapshot | null; issues: Failure[]; chainSupported: boolean; authenticated: boolean;
  freeTierConfirmed: boolean; usedSupply: string; usedWithdraw: string;
  walletAddress: Address | null; operators: Address[]; checkedAt: number;
};
export function earnAmount(text: string, decimals = 6): bigint {
  if (![6,18].includes(decimals) || !/^\d{1,2}(\.\d{1,18})?$/.test(text) || (text.split('.')[1]?.length || 0) > decimals) throw new ExecutionError('INVALID_INPUT', `Use a positive decimal amount with at most ${decimals} decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (amount <= 0n || amount > 10n ** BigInt(decimals)) throw new ExecutionError('TRADE_LIMIT_EXCEEDED', 'Earn demo limit: at most 1 test token per action.');
  return amount;
}
export function earnCall(action: EarnAction, amount: string, wallet: Address, token: Address = AAVE.token) {
  earnAssetFor(token);
  const functionName = action === 'APPROVAL' ? 'approve' : action === 'SUPPLY' ? 'supply' : 'withdraw';
  const abi = earnAbi.filter(x => x.type === 'function' && x.name === functionName);
  const args = action === 'APPROVAL' ? [AAVE.pool, amount] : action === 'SUPPLY' ? [token, amount, wallet, 0] : [token, amount, wallet];
  const payload: ContractExecutionPayload = { chainId: EARN_CHAIN, contractAddress: action === 'APPROVAL' ? token : AAVE.pool, functionName, functionArgs: canonicalJson(args), abi: canonicalJson(abi), value: '0' };
  const calldata = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return { payload, calldata };
}
export function freezeEarn(body: EarnBody): EarnIntent {
  const copy = JSON.parse(canonicalJson(body)) as EarnBody;
  return { ...copy, intentHash: keccak256(toHex(canonicalJson(copy))) };
}
export function verifyEarn(i: EarnIntent) {
  const { intentHash, ...body } = i;
  if (keccak256(toHex(canonicalJson(body))) !== intentHash) throw new ExecutionError('INTENT_CHANGED', 'Earn intent hash changed.');
  const asset = earnAssetFor(i.token);
  if (i.version !== 'earn-v1' || i.protocol !== 'aave-v3' || i.chainId !== EARN_CHAIN || i.decimals !== asset.decimals || !['APPROVAL','SUPPLY','WITHDRAW'].includes(i.action)) throw new ExecutionError('INVALID_INPUT', 'Only the Aave V3 Sepolia demo is permitted.');
  for (const a of [i.walletAddress, i.operatorAddress]) if (!isAddress(a) || a.toLowerCase() === zeroAddress) throw new ExecutionError('INVALID_INPUT', 'Invalid Earn wallet.');
  if (i.pool !== AAVE.pool || i.token !== asset.token || i.aToken !== asset.aToken || !/^\d{1,19}$/.test(i.amount) || BigInt(i.amount) <= 0n || BigInt(i.amount) > 10n ** BigInt(asset.decimals)) throw new ExecutionError('INVALID_INPUT', 'Earn deployment or amount is outside the testnet allowlist.');
  if (!Number.isSafeInteger(i.createdAt) || !Number.isSafeInteger(i.expiresAt) || i.expiresAt <= i.createdAt || i.expiresAt - i.createdAt > 600_000) throw new ExecutionError('INVALID_INPUT', 'Invalid Earn intent lifetime.');
  if (canonicalJson(earnCall(i.action, i.amount, i.walletAddress,i.token)) !== canonicalJson({ payload: i.payload, calldata: i.calldata })) throw new ExecutionError('INTENT_CHANGED', 'Earn payload differs from the reviewed action.');
}
export function freshEarn(i: EarnIntent) {
  if (Date.now() >= i.expiresAt) throw new ExecutionError('MARKET_EXPIRED', 'Earn intent expired. Create and review a new intent.');
}
export function earnAuthorization(i: EarnIntent) {
  return ['DreamCurve Earn KeeperHub authorization', `Domain: ${i.authorizationDomain}`, `Intent: ${i.id}`, `Hash: ${i.intentHash}`, `Protocol: ${i.protocol}`, `Chain: ${i.chainId}`, `Action: ${i.action}`, `Token: ${i.token}`, `Amount (raw, ${i.decimals} decimals): ${i.amount}`, `Pool: ${i.pool}`, `Executing wallet and beneficiary: ${i.walletAddress}`, `Expires: ${new Date(i.expiresAt).toISOString()}`, 'I authorize KeeperHub to execute this exact frozen testnet payload once.'].join('\n');
}
