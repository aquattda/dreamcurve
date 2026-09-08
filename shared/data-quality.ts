import type { ArenaState } from './domain';
import { isFresh } from './domain';

// Do not guess a different decimal scale. A reference price implausibly far
// from the current underlying is unverified, not a usable model input.
export function referencePriceVerified(price: number, spot: number | null) {
  return Number.isFinite(price) && price > 0 && spot !== null && Number.isFinite(spot) && spot > 0
    && price / spot >= 0.01 && price / spot <= 100;
}

export function publicArenaState(state: ArenaState, now = Date.now()): ArenaState {
  if (state.mode !== 'live' || state.status !== 'healthy') return state;
  if (state.updatedAt > 0 && now - state.updatedAt < 15_000 && state.markets.every(m => isFresh(m, now))) return state;
  return { ...state, status: 'degraded', issue: 'MARKET_READ_FAILED', retryable: true,
    retryAt: state.retryAt ?? now + 5000,
    message: 'Live market data is stale. Trading is paused while the collector refreshes. Last-known data remains visible.' };
}
