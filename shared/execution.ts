import { encodeFunctionData, erc20Abi, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { binaryPoolWriteAbi, ORDER_TYPE } from '@somnia-chain/markets-sdk';
import type { Forecast, Side } from './domain';

export const EXECUTION_CHAIN = 50312;
export type ExecutionStatus = 'REVIEW_REQUIRED' | 'SIMULATING' | 'SIMULATION_FAILED' | 'READY' | 'STALE' | 'BLOCKED' | 'EXECUTING' | 'CONFIRMING' | 'SUCCESS' | 'FAILED';
export type FailureCode = 'CONFIGURATION_REQUIRED' | 'NETWORK_UNSUPPORTED' | 'UNAUTHORIZED' | 'INVALID_INPUT' | 'INTENT_CHANGED' | 'MARKET_EXPIRED' | 'MARKET_CLOSED' | 'INSUFFICIENT_BALANCE' | 'INSUFFICIENT_GAS' | 'INSUFFICIENT_EXECUTOR_GAS' | 'INSUFFICIENT_EXECUTOR_COLLATERAL' | 'COLLATERAL_MISMATCH' | 'TRADE_LIMIT_EXCEEDED' | 'SESSION_LIMIT_EXCEEDED' | 'ALLOWANCE_REQUIRED' | 'CONTRACT_REVERT' | 'SIMULATOR_UNAVAILABLE' | 'KEEPERHUB_ERROR' | 'EXECUTION_UNCERTAIN' | 'PROOF_MISMATCH' | 'BUSY';
export type Failure = { code: FailureCode; message: string };
export type ExecutorFunding = {
  chainId: 50312; executorAddress: Address; marketId: Hex; checkedAt: number;
  gas: { symbol: 'STT'; balance: string; balanceRaw: string; required: string; requiredRaw: string; sufficient: boolean; estimateSource: 'conservative-budget' | 'simulation' };
  collateral: { symbol: 'tUSDC'; tokenAddress: Address; decimals: number; balance: string; balanceRaw: string; required: string; requiredRaw: string; sufficient: boolean };
  readyToExecute: boolean; issues: Failure[];
};
export type ExecutionLimits = {
  chainId: 50312; maxTrade: string; maxSession: string; requested: string;
  usedSession: string; remainingSession: string; allowed: boolean;
  scope: 'executor-durable-demo'; issues: Failure[];
};
export type ExecutionSafety = { funding: ExecutorFunding | null; limits: ExecutionLimits | null; issues: Failure[]; readyToExecute: boolean; checkedAt: number };
export type ContractExecutionPayload = {
  chainId: number; contractAddress: Address; functionName: string;
  functionArgs: string; abi: string; value: '0';
};
export type IntentBody = {
  version: 1; id: string; kind: 'TRADE' | 'APPROVAL'; parentIntentId: string | null;
  createdAt: number; expiresAt: number; chainId: 50312;
  marketId: Hex; marketTitle: string; marketSymbol: string; marketExpiry: number;
  poolAddress: Address; collateralToken: Address; collateralDecimals: number;
  walletAddress: Address; operatorAddress: Address; authorizationDomain: string;
  side: Side; yesPrice: string; limitPrice: string; quantity: string; estimatedSpend: string;
  stake: string; tick: string; lot: string; minQuantity: string;
  orderType: number; expireTimestampNs: string;
  recommendation: Forecast | null; recommendationSource: 'quantitative-model' | 'manual';
  payload: ContractExecutionPayload; calldata: Hex;
};
export type ExecutionIntent = IntentBody & { intentHash: Hex };
export type PreflightResult = {
  passed: boolean; at: number; checks: string[]; failure?: Failure;
  simulation?: { from: string; to: string; gasEstimate: string; wouldRevert: false };
};
export type ExecutionProof = {
  transactionHash: Hex; chainId: number; blockNumber: string; confirmedAt: number;
  orderId: string | null; orderStatus: 'APPROVED' | 'PLACED' | 'RESTING' | 'PARTIALLY_FILLED' | 'FILLED';
  filledQuantity: string; collateralMoved: string; verified: true;
};
export type ExecutionRecord = {
  intent: ExecutionIntent; revision: number; status: ExecutionStatus;
  preflight: PreflightResult | null; failure: Failure | null;
  keeperHubExecutionId: string | null; keeperHubStatus: string | null; txHash: Hex | null;
  broadcastAttemptedAt: number | null; approvalSignature: Hex | null;
  proof: ExecutionProof | null; pollAfterMs: number;
  timeline: { at: number; event: string; detail: string }[];
};

export class ExecutionError extends Error {
  constructor(public code: FailureCode, message: string) { super(message); this.name = 'ExecutionError'; }
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new ExecutionError('INVALID_INPUT', 'Intent must contain only canonical JSON values.');
}
export function hashIntent(body: IntentBody): Hex { return keccak256(toHex(canonicalJson(body))); }
export function freezeIntent(body: IntentBody): ExecutionIntent {
  const copy = JSON.parse(canonicalJson(body)) as IntentBody;
  return { ...copy, intentHash: hashIntent(copy) };
}
export function contractCall(body: Pick<IntentBody, 'kind' | 'chainId' | 'poolAddress' | 'collateralToken' | 'estimatedSpend' | 'side' | 'yesPrice' | 'quantity' | 'expireTimestampNs' | 'orderType'>) {
  const approval = body.kind === 'APPROVAL';
  const abi = approval ? erc20Abi.filter(x => x.type === 'function' && x.name === 'approve') : binaryPoolWriteAbi.filter(x => x.type === 'function' && x.name === 'placeBinaryOrder');
  const args = approval ? [body.poolAddress, body.estimatedSpend] : [body.side === 'YES' ? 0 : 2, body.yesPrice, body.quantity, body.expireTimestampNs, body.orderType, 0, zeroAddress, '0', '0'];
  const payload: ContractExecutionPayload = { chainId: body.chainId, contractAddress: approval ? body.collateralToken : body.poolAddress, functionName: approval ? 'approve' : 'placeBinaryOrder', functionArgs: canonicalJson(args), abi: canonicalJson(abi), value: '0' };
  const calldata = encodeFunctionData({ abi, functionName: payload.functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return { payload, calldata };
}
export function verifyIntent(intent: ExecutionIntent) {
  const { intentHash, ...body } = intent;
  if (hashIntent(body) !== intentHash) throw new ExecutionError('INTENT_CHANGED', 'The frozen intent hash no longer matches.');
  if (intent.version !== 1 || intent.chainId !== EXECUTION_CHAIN || !['TRADE', 'APPROVAL'].includes(intent.kind) || !['YES', 'NO'].includes(intent.side)) throw new ExecutionError('INVALID_INPUT', 'Unsupported execution intent.');
  for (const a of [intent.poolAddress, intent.collateralToken, intent.walletAddress, intent.operatorAddress]) if (!isAddress(a) || a === zeroAddress) throw new ExecutionError('INVALID_INPUT', 'Invalid execution address.');
  if (!Number.isInteger(intent.collateralDecimals) || intent.collateralDecimals < 0 || intent.collateralDecimals > 18) throw new ExecutionError('INVALID_INPUT', 'Invalid collateral decimals.');
  const one = 10n ** BigInt(intent.collateralDecimals);
  const price = BigInt(intent.yesPrice), qty = BigInt(intent.quantity), tick = BigInt(intent.tick), lot = BigInt(intent.lot);
  const sidePrice = intent.side === 'YES' ? price : one - price;
  if (price <= 0n || price >= one || tick <= 0n || price % tick !== 0n || lot <= 0n || qty <= 0n || qty % lot !== 0n || qty < BigInt(intent.minQuantity)) throw new ExecutionError('INVALID_INPUT', 'Invalid price/tick or quantity/lot/minimum.');
  if (BigInt(intent.limitPrice) !== sidePrice || BigInt(intent.estimatedSpend) !== (qty * sidePrice + one - 1n) / one || BigInt(intent.estimatedSpend) > BigInt(intent.stake)) throw new ExecutionError('INVALID_INPUT', 'Collateral escrow or maximum stake mismatch.');
  if (intent.orderType !== ORDER_TYPE.MARKET || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= intent.createdAt || intent.expiresAt >= intent.marketExpiry || BigInt(intent.expireTimestampNs) !== BigInt(intent.expiresAt) * 1_000_000n || BigInt(intent.expireTimestampNs) >= 2n ** 64n) throw new ExecutionError('INVALID_INPUT', 'Invalid frozen order expiry or type.');
  const expected = contractCall(body);
  if (expected.calldata !== intent.calldata || canonicalJson(expected.payload) !== canonicalJson(intent.payload)) throw new ExecutionError('INTENT_CHANGED', 'Contract payload differs from the reviewed order.');
}
export function authorizationMessage(i: ExecutionIntent): string {
  return [`DreamCurve KeeperHub execution authorization`, `Domain: ${i.authorizationDomain}`, `Intent: ${i.id}`, `Hash: ${i.intentHash}`, `Action: ${i.kind}`, `Chain: ${i.chainId}`, `Executing wallet: ${i.walletAddress}`, `Market: ${i.marketId}`, `Buy: ${i.side}`, `Quantity (raw): ${i.quantity}`, `Maximum collateral (raw): ${i.estimatedSpend}`, `Expires: ${new Date(i.expiresAt).toISOString()}`, 'I authorize KeeperHub to execute this exact frozen payload once.'].join('\n');
}
export const isPending = (r: ExecutionRecord) => r.status === 'EXECUTING' || r.status === 'CONFIRMING';
export function assertFresh(i: ExecutionIntent, now = Date.now()) {
  if (now >= i.expiresAt || now >= i.marketExpiry) throw new ExecutionError('MARKET_EXPIRED', 'Market or execution intent expired. Create a new intent; this payload will not be broadcast.');
}
