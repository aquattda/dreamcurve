import type { Address } from 'viem';
import type { BinaryMarket } from '@somnia-chain/markets-sdk';
import { loadPortfolio, loadTestUsdcBalance, sdkFor, reconcileJournal } from '../wallet';
import { derivePositions, fillActivity, units } from './model';
import { mergeActivity, readJournal } from './journal';
import type { Activity, PortfolioData, Order } from './types';

async function boundedMap<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  let next = 0;
  const result: PromiseSettledResult<R>[] = [];
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { result[index] = { status: 'fulfilled', value: await run(items[index]) }; }
      catch (reason) { result[index] = { status: 'rejected', reason }; }
    }
  }));
  return result;
}
// Bound reads without converting a timeout into an empty portfolio.
function read<T>(request: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Portfolio data request timed out.')), 20_000);
    request.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export async function fetchPortfolioData(account: Address): Promise<PortfolioData> {
  const { sdk } = sdkFor(account);
  const [baseResult, balanceResult, fillResult, actionResult, claimsResult] = await Promise.allSettled([
    read(loadPortfolio(account)), read(loadTestUsdcBalance(account)),
    read(sdk.client.getUserFills(account, { limit: 1000 })),
    read(sdk.client.getRouterActions(account, { limit: 1000 })), read(sdk.client.getClaimable(account)),
  ]);
  if (baseResult.status === 'rejected') throw new Error('Portfolio indexer unavailable. Retry to refresh your holdings.');
  const base = baseResult.value;
  if (base.account.toLowerCase() !== account.toLowerCase()) throw new Error('Portfolio response does not match the connected wallet. Reconnect and retry.');
  const warnings: string[] = [];
  if (base.openOrders.length >= 50) warnings.push('Open orders reached the 50-row read limit. More resting orders may exist.');
  const fills = fillResult.status === 'fulfilled' ? fillResult.value : [];
  const actions = actionResult.status === 'fulfilled' ? actionResult.value : [];
  let complete = fillResult.status === 'fulfilled' && actionResult.status === 'fulfilled' && fills.length < 1000 && actions.length < 1000 && base.positions.length < 200;
  if (!complete) warnings.push('History is incomplete or unavailable. Cost basis and total realized P&L are not asserted.');
  if (balanceResult.status === 'rejected') warnings.push('On-chain balance unavailable. Any previous balance is marked stale.');
  const heldIds = base.positions.map(p => p.market.id.toLowerCase());
  const historyIds = [...new Set([...fills.map(f => f.market.toLowerCase()), ...actions.flatMap(a => a.market ? [a.market.toLowerCase()] : [])])];
  // Current holdings take priority. Historical markets are bounded to keep refresh practical.
  const extraIds = historyIds.filter(id => !heldIds.includes(id));
  if (extraIds.length > 30) { complete = false; warnings.push('Showing the latest 30 historical markets plus current holdings. Lifetime totals unavailable.'); }
  const ids = [...new Set([...heldIds, ...base.openOrders.map(o => o.market.id.toLowerCase()), ...extraIds.slice(0, 30)])];
  const [marketResults, bookResult, orderResults] = await Promise.all([
    boundedMap(ids, id => read(sdk.client.getMarket(id))),
    Promise.allSettled([read(sdk.client.getBookTops(heldIds))]),
    boundedMap(base.openOrders, o => read(sdk.client.getOrder(o.market.poolAddress, o.orderId))),
    read(reconcileJournal(account)).catch(() => undefined),
  ]);
  const markets = new Map<string, BinaryMarket>();
  marketResults.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.marketType === 'BINARY') markets.set(ids[i], r.value);
    else { complete = false; }
  });
  if (markets.size < ids.length) warnings.push('Some market details are unavailable. Those holdings remain visible with unknown valuation.');
  const books = bookResult[0].status === 'fulfilled' ? bookResult[0].value : {};
  if (bookResult[0].status === 'rejected') warnings.push('Order-book marks unavailable; last indexed trade is used when a market is still open.');
  const positions = [...markets.values()].flatMap(m => {
    const owned = base.positions.filter(p => p.market.id.toLowerCase() === m.id.toLowerCase());
    const balanceFor = (idx: number) => owned.filter(p => p.outcomeIndex === idx).reduce((sum, p) => sum + BigInt(p.balance), 0n);
    return derivePositions(account, m, [balanceFor(0), balanceFor(1)], fills.filter(f => f.market.toLowerCase() === m.id.toLowerCase()), actions.filter(a => a.market?.toLowerCase() === m.id.toLowerCase()), books[m.id.toLowerCase()], complete, Date.now());
  });
  // Keep actual holdings visible even if enrichment fails. No cast to a fabricated market.
  const missingHoldings = base.positions.filter(p => !markets.has(p.market.id.toLowerCase()));
  if (missingHoldings.length) warnings.push(`${missingHoldings.length} holding(s) could not be enriched: ${missingHoldings.map(p => `${p.market.asset} ${p.outcomeIndex === 0 ? 'YES' : 'NO'} · ${units(p.balance, p.market.quoteDecimals).toFixed(2)} shares`).join('; ')}. Position count includes these holdings.`);
  const activity: Activity[] = fills.flatMap(f => {
    const market = markets.get(f.market.toLowerCase());
    return market ? [fillActivity(f, account, market)] : [];
  });
  // Portfolio's minimal fill records still work when the richer history read fails.
  for (const f of base.trades) if (!activity.some(a => a.id === f.id)) {
    const side = f.side?.endsWith('_NO') ? 'NO' : f.side?.endsWith('_YES') ? 'YES' : null;
    const rawPrice = side === null ? null : side === 'NO' ? 10n ** BigInt(f.market.quoteDecimals) - BigInt(f.fillPrice) : BigInt(f.fillPrice);
    const m = [...markets.values()].find(m => m.marketAddress.toLowerCase() === f.market.marketAddress.toLowerCase());
    activity.push({ id: f.id, kind: 'Trades', action: f.side?.replace('_', ' ') ?? 'Trade (side indexing)', side, marketId: m?.id,
      marketTitle: m?.question ?? `${f.market.asset} · market ${f.market.marketAddress}`, shares: units(f.quantity, f.market.quoteDecimals), price: rawPrice == null ? null : units(rawPrice, f.market.quoteDecimals), total: rawPrice == null || !m || m.collateral.toLowerCase() !== '0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e' ? null : units(BigInt(f.quantity) * rawPrice / 10n ** BigInt(f.market.quoteDecimals), f.market.quoteDecimals),
      fee: null, timestamp: Number(f.timestamp) * 1000, txHash: f.txHash, status: 'Confirmed', source: 'Indexer' });
  }
  for (const a of actions.filter(a => a.kind === 'Redeem')) {
    const m = a.market ? markets.get(a.market.toLowerCase()) : undefined;
    activity.push({ id: a.id, kind: 'Redeems', action: 'REDEEM', marketId: a.market ?? undefined, marketTitle: m?.question ?? 'Settled market',
      side: m?.winningOutcome === 0 ? 'YES' : m?.winningOutcome === 1 ? 'NO' : null, shares: m ? units(a.amount, m.quoteDecimals) : null,
      price: null, total: m && m.collateral.toLowerCase() === '0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e' && a.payout != null ? units(a.payout, m.quoteDecimals) : null, fee: null, timestamp: Number(a.timestamp) * 1000,
      txHash: a.txHash, status: 'Confirmed', source: 'Indexer' });
  }
  const orders: Order[] = base.openOrders.map((o, i) => {
    const result = orderResults[i];
    const detail = result.status === 'fulfilled' ? result.value : null;
    return { ...o, expiresAt: detail ? Number(BigInt(detail.expireTimestampNs) / 1_000_000n) : null, indexedStatus: detail?.status ?? 'Open' };
  });
  if (orders.some(o => o.expiresAt == null)) warnings.push('Some order expiry times are unavailable. Refresh before cancelling.');
  orders.forEach(o => activity.push({ id: `order:${o.id}`, kind: 'Orders', action: o.side?.replace('_', ' ') ?? 'Order', marketId: o.market.id, marketTitle: o.market.question,
    side: o.side == null ? null : o.side.endsWith('_NO') ? 'NO' : 'YES', shares: units(o.fullQuantity, o.market.quoteDecimals), price: o.side == null ? null : units(o.side.endsWith('_NO') ? 10n ** BigInt(o.market.quoteDecimals) - BigInt(o.price) : o.price, o.market.quoteDecimals), total: null, fee: null,
    timestamp: Number(o.placedAtTimestamp) * 1000, txHash: o.placedTxHash, orderId: o.orderId, status: 'Confirmed', source: 'Indexer', note: 'Order placement confirmed; this is not proof of a fill.' }));
  const collateral = '0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e';
  const sameCollateral = [...markets.values()].every(m => m.collateral.toLowerCase() === collateral);
  if (!sameCollateral) warnings.push('Non-tUSDC collateral detected. Combined tUSDC valuations unavailable.');
  const claims = claimsResult.status === 'fulfilled' ? claimsResult.value : null;
  if (!claims) warnings.push('Redeemable balances unavailable. Redemption is disabled until refreshed.');
  const claimValue = claims && claims.every(c => markets.has(c.marketId.toLowerCase())) && sameCollateral ? claims.reduce((sum, c) => sum + units(c.estPayout, markets.get(c.marketId.toLowerCase())!.quoteDecimals), 0) : null;
  const local = readJournal(account);
  if (local.some(r => r.kind === 'Trades' && r.status === 'Confirmed' && !activity.some(a => a.kind === 'Trades' && a.txHash?.toLowerCase() === r.txHash?.toLowerCase()))) {
    complete = false;
    warnings.push('A confirmed trade is still awaiting indexed fills/holdings. Activity shows the receipt; combined valuations wait for the indexer.');
  }
  return { account, positions, orders, activity: mergeActivity(activity, local),
    balance: balanceResult.status === 'fulfilled' ? Number(balanceResult.value.formatted) : null,
    realized: complete && sameCollateral && positions.every(p => p.realized != null) ? positions.reduce((sum, p) => sum + p.realized!, 0) : null,
    claimable: claims ? { count: claims.length, value: claimValue } : null,
    updatedAt: Date.now(), warnings, complete: complete && sameCollateral && !missingHoldings.length,
    holdingCount: base.positions.length, unavailableHoldings: missingHoldings,
  };
}
