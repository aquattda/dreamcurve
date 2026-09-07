import type { Position, Order } from './types';

export function positionStatus(position: Position, now: number): string {
  const { market } = position;
  if (position.redeemed) return 'REDEEMED';
  if (market.voided) return position.heldShares > 0 ? 'REDEEMABLE' : 'VOIDED';
  if (market.winningOutcome != null) {
    if (market.winningOutcome === (position.side === 'YES' ? 0 : 1) && position.heldShares > 0) return 'REDEEMABLE';
    return `RESOLVED ${market.winningOutcome === 0 ? 'YES' : 'NO'}`;
  }
  if (position.closed) return 'CLOSED';
  if (['Settling', 'Resolved', 'Finalized'].includes(market.status)) return 'AWAITING RESOLUTION';
  if (now >= Number(market.expiry) * 1000 || market.status === 'Locked') return 'TRADING CLOSED';
  if (now < Number(market.tradingStart) * 1000) return 'NOT OPEN YET';
  return Number(market.expiry) * 1000 - now <= 60_000 ? 'CLOSING SOON' : 'OPEN';
}
export function countdown(expiry: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Number(expiry) * 1000 - now) / 1000));
  return seconds ? `Closes in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : 'Trading window ended';
}
export function orderStatus(order: Order, now: number): string {
  if (order.indexedStatus !== 'Open') return order.indexedStatus.toUpperCase();
  if (order.expiresAt != null && order.expiresAt <= now) return 'EXPIRED';
  if (Number(order.market.expiry) * 1000 <= now || ['Locked', 'Settling', 'Resolved', 'Finalized', 'Voided'].includes(order.market.status)) return 'TRADING CLOSED';
  return BigInt(order.quantityRemaining) === 0n ? 'FILLED' : BigInt(order.filledQuantity) > 0n ? 'PARTIALLY FILLED' : 'OPEN';
}
