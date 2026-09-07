import type { Position } from './types';

export function portfolioTotals(data: { complete: boolean; balance: number | null; positions: Position[] } | null, now: number, balanceStale = false) {
  const unavailable = { value: null, unrealized: null, cost: null };
  if (!data?.complete) return unavailable;
  const outstanding = data.positions.filter(p => p.heldShares > 0 && !p.redeemed && (!p.closed || p.market.voided || p.market.winningOutcome === (p.side === 'YES' ? 0 : 1)));
  const expired = outstanding.some(p => !p.closed && Number(p.market.expiry) * 1000 <= now);
  return {
    value: !balanceStale && !expired && data.balance != null && data.positions.every(p => p.value != null) ? data.balance + data.positions.reduce((sum, p) => sum + p.value!, 0) : null,
    unrealized: !expired && outstanding.every(p => p.unrealized != null) ? outstanding.reduce((sum, p) => sum + p.unrealized!, 0) : null,
    cost: outstanding.every(p => p.cost != null) ? outstanding.reduce((sum, p) => sum + p.cost!, 0) : null,
  };
}
