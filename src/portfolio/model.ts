import { computePositionPnL, pnlEventsFor, type BinaryMarket, type FillRow, type RouterActionRecord, type BookTop } from '@somnia-chain/markets-sdk';
import { formatUnits } from 'viem';
import type { Activity, Position } from './types';

export const units = (raw: bigint | string, decimals: number) => Number(formatUnits(BigInt(raw), decimals));
export function sideFor(fill: FillRow, account: string) {
  return fill.maker?.toLowerCase() === account.toLowerCase() ? fill.makerSide : fill.takerOrder?.side ?? fill.takerSide;
}
export function fillActivity(fill: FillRow, account: string, market: BinaryMarket): Activity {
  const action = sideFor(fill, account);
  const side = action?.endsWith('_NO') ? 'NO' : action?.endsWith('_YES') ? 'YES' : null;
  const one = 10n ** BigInt(market.quoteDecimals);
  const price = side == null ? null : side === 'NO' ? one - BigInt(fill.fillPrice) : BigInt(fill.fillPrice);
  return { id: fill.id, kind: 'Trades', action: action?.replace('_', ' ') ?? 'Trade (side indexing)', side,
    marketId: market.id, marketTitle: market.question, shares: units(fill.quantity, market.quoteDecimals),
    price: price == null ? null : units(price, market.quoteDecimals),
    total: price == null || market.collateral.toLowerCase() !== '0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e' ? null : units(BigInt(fill.quantity) * price / one, market.quoteDecimals), fee: null,
    timestamp: Number(fill.timestamp) * 1000, txHash: fill.txHash,
    orderId: (fill.maker?.toLowerCase() === account.toLowerCase() ? fill.makerOrderId : fill.takerOrderId) ?? undefined,
    status: 'Confirmed', source: 'Indexer', note: 'Executed fill, not a quote. Trade value excludes separately charged fees and gas.' };
}
export function derivePositions(account: string, market: BinaryMarket, balances: [bigint, bigint], fills: FillRow[], actions: RouterActionRecord[], top: BookTop | undefined, complete: boolean, now: number): Position[] {
  const orderedFills = [...fills].sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.id.split('_').at(-1)) - Number(b.id.split('_').at(-1)));
  const events = pnlEventsFor(account, orderedFills, actions);
  const expected: [bigint, bigint] = [0n, 0n];
  let reliable = complete && fills.every(f => sideFor(f, account) != null);
  // SDK merges fills/actions at second precision; ambiguous same-second mint/merge ordering cannot establish an exact basis.
  if (actions.some(a => a.kind !== 'Redeem' && fills.some(f => f.timestamp === a.timestamp))) reliable = false;
  for (const event of events) {
    const indexes = event.kind === 'mint' || event.kind === 'merge' ? [0, 1] as const : [event.outcomeIndex];
    for (const idx of indexes) {
      expected[idx] += (event.kind === 'buy' || event.kind === 'mint' ? 1n : -1n) * event.quantity;
      if (expected[idx] < 0n) reliable = false;
    }
  }
  const redemptions = actions.filter(a => a.kind === 'Redeem');
  const redeemedQuantity = redemptions.reduce((sum, a) => sum + BigInt(a.amount), 0n);
  if (market.voided && redemptions.length) reliable = false; // Router rows do not identify the voided outcome leg.
  const winner = market.winningOutcome;
  for (const idx of [0, 1] as const) {
    if (expected[idx] - (winner === idx ? redeemedQuantity : 0n) !== balances[idx]) reliable = false;
  }
  const pnl = computePositionPnL(events, { balanceYes: expected[0], balanceNo: expected[1] }, market, 10n ** BigInt(market.quoteDecimals), {
    bookTop: top ? { bestBid: top.bestBid == null ? undefined : BigInt(top.bestBid), bestAsk: top.bestAsk == null ? undefined : BigInt(top.bestAsk) } : undefined,
  });
  return ([0, 1] as const).flatMap(idx => {
    const used = events.some(e => e.kind === 'mint' || e.kind === 'merge' || e.outcomeIndex === idx);
    if (!used && balances[idx] === 0n) return [];
    const leg = idx === 0 ? pnl.outcomes.yes : pnl.outcomes.no;
    const settled = market.voided || winner != null;
    const closed = settled || balances[idx] === 0n;
    const historical = balances[idx] === 0n && expected[idx] > 0n;
    const qty = historical ? expected[idx] : balances[idx];
    const one = 10n ** BigInt(market.quoteDecimals);
    const costRaw = reliable ? qty * leg.avgCost / one : null;
    // Never mark an expired, unresolved contract with a stale last trade.
    const priceRaw = !settled && (Number(market.expiry) * 1000 <= now || ['Locked', 'Settling'].includes(market.status)) ? null : leg.markPrice;
    const valueRaw = balances[idx] === 0n ? 0n : priceRaw == null ? null : balances[idx] * priceRaw / one;
    const redeemed = winner === idx && redeemedQuantity > 0n && balances[idx] === 0n;
    const payoutRaw = winner != null && winner !== idx ? 0n : redeemed && redemptions.every(a => a.payout != null) ? redemptions.reduce((sum, a) => sum + BigInt(a.payout!), 0n) : null;
    // Until redemption, winning settlement is a receivable, not realized profit.
    const realizedRaw = !reliable ? null : redeemed && payoutRaw != null ? leg.realizedPnl + payoutRaw - leg.costBasis : winner != null && winner !== idx ? leg.realizedPnl - leg.costBasis : redemptions.length ? null : leg.realizedPnl;
    return [{ id: `${market.id}:${idx}`, market, side: idx === 0 ? 'YES' as const : 'NO' as const,
      shares: units(qty, market.quoteDecimals), heldShares: units(balances[idx], market.quoteDecimals), avgEntry: reliable && qty > 0n ? units(leg.avgCost, market.quoteDecimals) : null,
      price: priceRaw == null ? null : units(priceRaw, market.quoteDecimals), cost: costRaw == null ? null : units(costRaw, market.quoteDecimals),
      value: valueRaw == null ? null : units(valueRaw, market.quoteDecimals),
      unrealized: valueRaw != null && reliable && !redeemed ? units(valueRaw - balances[idx] * leg.avgCost / one, market.quoteDecimals) : null,
      realized: realizedRaw == null ? null : units(realizedRaw, market.quoteDecimals),
      payout: payoutRaw == null ? null : units(payoutRaw, market.quoteDecimals), redeemed, closed,
      txHash: redeemed ? redemptions[0]?.txHash : undefined,
      unavailable: !reliable ? 'Cost basis unavailable: incomplete history, an unindexed fill, or outcome tokens transferred outside the order book.' : priceRaw == null ? 'No reliable current mark while awaiting price data or resolution.' : undefined,
    }];
  });
}
