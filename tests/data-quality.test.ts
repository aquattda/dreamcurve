import { describe, expect, it, vi } from 'vitest';
import { demoState } from '../shared/demo';
import { blockReason } from '../shared/domain';
import { publicArenaState, referencePriceVerified } from '../shared/data-quality';
import { readWithDeadline } from '../server/read-deadline';

describe('public data quality', () => {
  it('marks stale snapshots degraded without deleting last-known data or mutating collector state', () => {
    const now = Date.now();
    const state = { ...demoState(now), mode: 'live' as const };
    const current = publicArenaState(state, now + 20_000);
    expect(current.status).toBe('degraded');
    expect(current.issue).toBe('MARKET_READ_FAILED');
    expect(current.markets).toBe(state.markets);
    expect(state.status).toBe('healthy');
    expect(publicArenaState(state, now).status).toBe('healthy');
    expect(publicArenaState(demoState(now), now + 60_000).status).toBe('healthy');
  });

  it('does not call a partly stale market set healthy', () => {
    const now = Date.now();
    const state = { ...demoState(now), mode: 'live' as const };
    state.markets[0].updatedAt = now - 30_000;
    expect(publicArenaState(state, now).status).toBe('degraded');
  });

  it('refuses unverified reference scales rather than guessing decimal shifts', () => {
    expect(referencePriceVerified(79_610.75, 79_000)).toBe(true);
    expect(referencePriceVerified(79_610_750_000, 79_000)).toBe(false);
    expect(referencePriceVerified(2_450_580_000, 2485)).toBe(false);
    expect(referencePriceVerified(79_610.75, null)).toBe(false);
    const market = demoState().markets[0];
    expect(blockReason({ ...market, dataWarning: 'Opening price scale unverified' })).toMatch(/unverified/);
  });

  it('releases a read deadline when an upstream request never settles', async () => {
    vi.useFakeTimers();
    try {
      const result = expect(readWithDeadline(new Promise<never>(() => {}), 'Market read', 1000)).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(vi.getTimerCount()).toBe(0);
      await expect(readWithDeadline(Promise.resolve(42), 'Market read')).resolves.toBe(42);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
