import { describe, expect, it, vi } from 'vitest';
import type { BinaryMarket, LiveBinaryMarketsFilter } from '@somnia-chain/markets-sdk';
import { discoverActiveMarkets, retryDelay } from '../server/discovery';

function market(id: string, asset: string, tradingStart: number, expiry: number) {
  return { marketId: id, asset, tradingStart: String(tradingStart), expiry: String(expiry) } as unknown as BinaryMarket;
}

describe('live market discovery', () => {
  it('queries BTC and ETH server-side, then returns only active unique windows', async () => {
    const now = 1_800_000_000_000;
    const nowSec = now / 1000;
    const shared = market('0x01', 'BTC', nowSec - 60, nowSec + 300);
    const calls: LiveBinaryMarketsFilter[] = [];
    const client = {
      listLiveBinaryMarkets: vi.fn(async (filter: LiveBinaryMarketsFilter = {}) => {
        calls.push(filter);
        if (filter.asset === 'BTC') return [shared, market('0x02', 'BTC', nowSec - 60, nowSec - 1)];
        return [market('0x03', 'ETH', nowSec - 30, nowSec + 120), shared];
      }),
    };

    const result = await discoverActiveMarkets(client, 'venue-1', now);

    expect(calls).toEqual([
      { asset: 'BTC', limit: 8, nowSec, venueId: 'venue-1' },
      { asset: 'ETH', limit: 8, nowSec, venueId: 'venue-1' },
    ]);
    expect(result.map(row => row.marketId)).toEqual(['0x03', '0x01']);
  });

  it('uses bounded exponential retry delays', () => {
    expect([1, 2, 3, 4, 5, 8].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});
