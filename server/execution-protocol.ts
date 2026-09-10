import { randomUUID } from 'node:crypto';
import { ORDER_TYPE, quoteBinaryStakeOverBook, orderBookEventsAbi, SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { decodeEventLog, erc20Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { blockReason, type Forecast, type Market, type Side } from '../shared/domain';
import { assertFresh, contractCall, ExecutionError, freezeIntent, verifyIntent, type ExecutionIntent, type ExecutionProof, type IntentBody, type ExecutorFunding } from '../shared/execution';
import { chainClient, exchange } from './protocol';
import type { KeeperConfig } from './keeperhub';
import { checkTradeAmount, intentLimitStatus, assertLimits } from './execution-limits';
import { checkExecutorFunding, readExecutorFunding } from './executor-funding';

export interface ExecutionProtocol {
  prepare(market: Market, side: Side, stake: string, operator: Address, recommendation: Forecast | null): Promise<ExecutionIntent>;
  check(intent: ExecutionIntent, gasEstimate?: string): Promise<string[]>;
  funding(intent: ExecutionIntent, gasEstimate?: string): Promise<ExecutorFunding>;
  verify(intent: ExecutionIntent, hash: Hex): Promise<ExecutionProof>;
}
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
export function parseProof(intent: ExecutionIntent, receipt: TransactionReceipt, at: number): ExecutionProof {
  if (receipt.status !== 'success') throw new ExecutionError('CONTRACT_REVERT', 'The onchain transaction reverted.');
  if (!same(receipt.to, intent.payload.contractAddress) || !same(receipt.from, intent.walletAddress)) throw new ExecutionError('PROOF_MISMATCH', 'Receipt sender or contract does not match this intent.');
  const base = { transactionHash: receipt.transactionHash, chainId: 50312, blockNumber: receipt.blockNumber.toString(), confirmedAt: at, verified: true as const };
  if (intent.kind === 'APPROVAL') {
    const approved = receipt.logs.some(log => {
      if (!same(log.address, intent.collateralToken)) return false;
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        return event.eventName === 'Approval' && same(event.args.owner, intent.walletAddress) && same(event.args.spender, intent.poolAddress) && event.args.value === BigInt(intent.estimatedSpend);
      } catch { return false; }
    });
    if (!approved) throw new ExecutionError('PROOF_MISMATCH', 'Expected bounded collateral Approval event is missing.');
    return { ...base, orderId: null, orderStatus: 'APPROVED', filledQuantity: '0', collateralMoved: '0' };
  }
  const events = receipt.logs.filter(l => same(l.address, intent.poolAddress)).flatMap(log => {
    try { return [decodeEventLog({ abi: orderBookEventsAbi, data: log.data, topics: log.topics })]; } catch { return []; }
  });
  const placed = events.find(e => e.eventName === 'OrderPlaced' && same(e.args.placedOrder.owner, intent.walletAddress));
  if (!placed || placed.eventName !== 'OrderPlaced') throw new ExecutionError('PROOF_MISMATCH', 'No matching dreamDEX OrderPlaced event was found.');
  const p = placed.args.placedOrder;
  if (p.price !== BigInt(intent.yesPrice) || p.fullQuantity !== BigInt(intent.quantity) || p.expireTimestampNs !== BigInt(intent.expireTimestampNs) || p.isBid !== (intent.side === 'YES')) throw new ExecutionError('PROOF_MISMATCH', 'Order event parameters differ from the frozen intent.');
  const id = placed.args.orderId;
  const filled = events.reduce((sum, e) => e.eventName === 'OrderFilled' && e.args.takerOrderId === id ? sum + e.args.quantityFilled : sum, 0n);
  const rested = events.some(e => e.eventName === 'OrderRested' && e.args.orderId === id);
  const moved = receipt.logs.reduce((sum, log) => {
    if (!same(log.address, intent.collateralToken)) return sum;
    try { const e = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics }); return e.eventName === 'Transfer' && same(e.args.from, intent.walletAddress) ? sum + e.args.value : sum; } catch { return sum; }
  }, 0n);
  if (filled > BigInt(intent.quantity)) throw new ExecutionError('PROOF_MISMATCH', 'Receipt fill quantity exceeds the reviewed quantity.');
  return { ...base, orderId: id.toString(), filledQuantity: filled.toString(), collateralMoved: moved.toString(), orderStatus: filled === BigInt(intent.quantity) ? 'FILLED' : filled > 0n ? 'PARTIALLY_FILLED' : rested ? 'RESTING' : 'PLACED' };
}

export function liveExecutionProtocol(config: KeeperConfig): ExecutionProtocol {
  return {
    async prepare(m, side, stakeText, operator, recommendation) {
      if (!config.wallet) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Configure the KeeperHub executing wallet.');
      const blocked = blockReason(m);
      if (m.source !== 'live' || blocked) throw new ExecutionError('INVALID_INPUT', blocked || 'Illustrative markets cannot produce execution intents.');
      const onchain = await exchange.client.getMarketOnchain(m.id as Hex);
      if (onchain.status !== 1) throw new ExecutionError('MARKET_CLOSED', 'This market is no longer trading.');
      const [book, grid, decimals] = await Promise.all([
        exchange.client.getBinaryOrderBook(onchain.pool, { depth: 10, decimals: onchain.decimals }),
        exchange.client.getBinaryBookParams(onchain.pool),
        chainClient.readContract({ address: onchain.collateral, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      const collateral = SOMNIA_TESTNET_ADDRESSES.collateral ?? SOMNIA_TESTNET_ADDRESSES.testUsdc;
      if (!collateral || !same(onchain.collateral, collateral) || decimals !== onchain.decimals) throw new ExecutionError('INVALID_INPUT', 'Market collateral or decimals do not match the current Shannon SDK configuration.');
      const stake = checkTradeAmount(stakeText, decimals);
      const quote = quoteBinaryStakeOverBook(book, `BUY_${side}`, stake, 10n ** BigInt(decimals), { ...grid, slippageBps: 200n, slippageMinTicks: 2n });
      if (!quote) throw new ExecutionError('INVALID_INPUT', 'No fillable quote for this stake. Select another amount or active market.');
      const createdAt = Date.now(), marketExpiry = Number(onchain.expiry) * 1000;
      const expiresAt = Math.min(createdAt + 180_000, marketExpiry - 5000);
      if (expiresAt - createdAt < 15_000) throw new ExecutionError('MARKET_EXPIRED', 'Not enough market lifetime remains to review and simulate.');
      const fields = {
        version: 1 as const, id: randomUUID(), kind: 'TRADE' as const, parentIntentId: null,
        createdAt, expiresAt, chainId: 50312 as const, marketId: m.id as Hex, marketTitle: m.title,
        marketSymbol: m.asset, marketExpiry, poolAddress: onchain.pool, collateralToken: onchain.collateral,
        collateralDecimals: decimals, walletAddress: config.wallet, operatorAddress: operator,
        authorizationDomain: config.domain, side, yesPrice: quote.yesPrice.toString(), limitPrice: quote.limitPrice.toString(),
        quantity: quote.quantity.toString(), estimatedSpend: quote.escrow.toString(), stake: stake.toString(),
        tick: grid.tickSize.toString(), lot: grid.lotSize.toString(), minQuantity: grid.minQuantity.toString(),
        orderType: ORDER_TYPE.MARKET, expireTimestampNs: (BigInt(expiresAt) * 1_000_000n).toString(),
        recommendation, recommendationSource: recommendation ? 'quantitative-model' as const : 'manual' as const,
      };
      const intent = freezeIntent({ ...fields, ...contractCall(fields) });
      verifyIntent(intent);
      return intent;
    },
    async funding(i, gasEstimate) {
      if (!config.wallet) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Configure the KeeperHub executor wallet.');
      return readExecutorFunding(config.wallet, i.marketId, { intent: i, gasEstimate });
    },
    async check(i, gasEstimate) {
      verifyIntent(i); assertFresh(i);
      assertLimits(intentLimitStatus(i, 0n));
      if (!config.wallet || !same(config.wallet, i.walletAddress) || i.authorizationDomain !== config.domain || !config.operators.some(o => same(o, i.operatorAddress))) throw new ExecutionError('UNAUTHORIZED', 'Execution wallet, operator or authorization domain changed.');
      const [chainId, market, block] = await Promise.all([chainClient.getChainId(), exchange.client.getMarketOnchain(i.marketId), chainClient.getBlock()]);
      if (chainId !== 50312) throw new ExecutionError('NETWORK_UNSUPPORTED', 'RPC is not Somnia Shannon.');
      assertFresh(i, Math.max(Date.now(), Number(block.timestamp) * 1000));
      if (market.status !== 1) throw new ExecutionError('MARKET_CLOSED', 'Market is no longer Trading. No transaction was requested.');
      if (!same(market.pool, i.poolAddress) || !same(market.collateral, i.collateralToken) || Number(market.expiry) * 1000 !== i.marketExpiry || market.decimals !== i.collateralDecimals) throw new ExecutionError('INTENT_CHANGED', 'Live market/pool configuration changed. Create a new intent.');
      await checkExecutorFunding(config.wallet, i.marketId, { intent: i, gasEstimate });
      const [grid, allowance, decimals] = await Promise.all([
        exchange.client.getBinaryBookParams(i.poolAddress),
        chainClient.readContract({ address: i.collateralToken, abi: erc20Abi, functionName: 'allowance', args: [i.walletAddress, i.poolAddress] }),
        chainClient.readContract({ address: i.collateralToken, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      if (grid.tickSize.toString() !== i.tick || grid.lotSize.toString() !== i.lot || grid.minQuantity.toString() !== i.minQuantity || decimals !== i.collateralDecimals) throw new ExecutionError('INTENT_CHANGED', 'Order grid or token decimals changed. Create a new intent.');
      if (i.kind === 'TRADE' && allowance < BigInt(i.estimatedSpend)) throw new ExecutionError('ALLOWANCE_REQUIRED', 'Review and execute a bounded collateral approval through KeeperHub, then run this trade dry run again.');
      assertFresh(i);
      return ['Live market and pool verified', 'Shannon chain and time verified', 'Collateral decimals and balance verified', 'Price tick, quantity lot and minimum verified', 'Executing wallet gas verified', i.kind === 'TRADE' ? 'Pool allowance verified' : 'Bounded approval payload verified'];
    },
    async verify(intent, hash) {
      const [tx, receipt] = await Promise.all([chainClient.getTransaction({ hash }), chainClient.getTransactionReceipt({ hash })]);
      if (!same(tx.from, intent.walletAddress) || !same(tx.to, intent.payload.contractAddress) || tx.input !== intent.calldata || tx.value !== 0n || tx.chainId !== 50312) throw new ExecutionError('PROOF_MISMATCH', 'Onchain transaction differs from the frozen contract payload.');
      const block = await chainClient.getBlock({ blockNumber: receipt.blockNumber });
      return parseProof(intent, receipt, Number(block.timestamp) * 1000);
    },
  };
}
export function approvalFor(trade: ExecutionIntent): ExecutionIntent {
  const { intentHash: _hash, ...body } = trade;
  const fields: IntentBody = { ...body, id: randomUUID(), kind: 'APPROVAL', parentIntentId: trade.id, createdAt: Date.now() };
  return freezeIntent({ ...fields, ...contractCall(fields) });
}
