import { SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { erc20Abi, formatUnits, type Address, type Hex } from 'viem';
import { ExecutionError, type ExecutionIntent, type ExecutorFunding } from '../shared/execution';
import { chainClient, exchange } from './protocol';
import { keeperLimits, tokenUnits } from './execution-limits';

export const configuredCollateral = () => {
  const token = SOMNIA_TESTNET_ADDRESSES.collateral ?? SOMNIA_TESTNET_ADDRESSES.testUsdc;
  if (!token) throw new ExecutionError('CONFIGURATION_REQUIRED', 'The SDK has no configured Shannon collateral.');
  return token;
};
type FundingMarket = { collateral: Address; decimals: number; status: number };
export interface FundingReader {
  chainId(): Promise<number>;
  market(id: Hex): Promise<FundingMarket>;
  nativeBalance(wallet: Address): Promise<bigint>;
  tokenBalance(token: Address, wallet: Address): Promise<bigint>;
  decimals(token: Address): Promise<number>;
  gasPrice(): Promise<bigint>;
}
const liveReader: FundingReader = {
  chainId: () => chainClient.getChainId(), market: id => exchange.client.getMarketOnchain(id),
  nativeBalance: address => chainClient.getBalance({ address }),
  tokenBalance: (address, wallet) => chainClient.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
  decimals: address => chainClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  gasPrice: () => chainClient.getGasPrice(),
};
export async function readExecutorFunding(wallet: Address, marketId: Hex, options: { intent?: ExecutionIntent; gasEstimate?: string } = {}, reader: FundingReader = liveReader): Promise<ExecutorFunding> {
  const limits = keeperLimits();
  // Verify chain before issuing any contract/balance request to this RPC.
  if (await reader.chainId() !== 50312) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Funding reads require Somnia Shannon chain 50312.');
  const market = await reader.market(marketId), token = configuredCollateral();
  if (market.collateral.toLowerCase() !== token.toLowerCase()) throw new ExecutionError('COLLATERAL_MISMATCH', 'Active market collateral differs from the authoritative Shannon SDK token.');
  const i = options.intent;
  if (i && (i.chainId !== 50312 || i.walletAddress.toLowerCase() !== wallet.toLowerCase() || i.collateralToken.toLowerCase() !== token.toLowerCase() || i.collateralDecimals !== market.decimals)) throw new ExecutionError('COLLATERAL_MISMATCH', 'Frozen intent executor, chain or collateral no longer matches funding configuration.');
  const [gas, balance, decimals, gasPrice] = await Promise.all([reader.nativeBalance(wallet), reader.tokenBalance(token, wallet), reader.decimals(token), reader.gasPrice()]);
  if (decimals !== market.decimals || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new ExecutionError('COLLATERAL_MISMATCH', 'Onchain collateral decimals differ from the market.');
  const required = i ? BigInt(i.estimatedSpend) : tokenUnits(limits.maxTrade, decimals);
  const gasUnits = options.gasEstimate ? BigInt(options.gasEstimate) : 2_000_000n;
  if (required <= 0n || gasUnits <= 0n || gasPrice <= 0n) throw new ExecutionError('SIMULATOR_UNAVAILABLE', 'A positive collateral budget and gas estimate/price are required.');
  const requiredGas = gasUnits * gasPrice * 2n;
  const issues: ExecutorFunding['issues'] = [];
  if (market.status !== 1) issues.push({ code: 'MARKET_CLOSED', message: 'The selected dreamDEX market is no longer trading.' });
  if (gas < requiredGas) issues.push({ code: 'INSUFFICIENT_EXECUTOR_GAS', message: `KeeperHub executor requires STT for gas: at least ${formatUnits(requiredGas, 18)} STT for this check.` });
  if (balance < required) issues.push({ code: 'INSUFFICIENT_EXECUTOR_COLLATERAL', message: `KeeperHub executor requires ${formatUnits(required, decimals)} dreamDEX tUSDC at ${token}. Fund this executor, not only the browser wallet.` });
  return { chainId: 50312, executorAddress: wallet, marketId, checkedAt: Date.now(),
    gas: { symbol: 'STT', balance: formatUnits(gas, 18), balanceRaw: gas.toString(), required: formatUnits(requiredGas, 18), requiredRaw: requiredGas.toString(), sufficient: gas >= requiredGas, estimateSource: options.gasEstimate ? 'simulation' : 'conservative-budget' },
    collateral: { symbol: 'tUSDC', tokenAddress: token, decimals, balance: formatUnits(balance, decimals), balanceRaw: balance.toString(), required: formatUnits(required, decimals), requiredRaw: required.toString(), sufficient: balance >= required },
    readyToExecute: issues.length === 0, issues };
}
export async function checkExecutorFunding(wallet: Address, marketId: Hex, options: { intent?: ExecutionIntent; gasEstimate?: string } = {}, reader: FundingReader = liveReader) {
  const funding = await readExecutorFunding(wallet, marketId, options, reader);
  const issue = funding.issues[0]; if (issue) throw new ExecutionError(issue.code, issue.message);
  return funding;
}
