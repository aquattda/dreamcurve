import type { BinaryMarket, LiveBinaryMarketsFilter } from '@somnia-chain/markets-sdk';

type LiveMarketClient = {
  listLiveBinaryMarkets(filter?: LiveBinaryMarketsFilter): Promise<BinaryMarket[]>;
};

const SUPPORTED_ASSETS = ['BTC', 'ETH'] as const;

/**
 * Query each supported asset on the indexer so unrelated, newer markets cannot
 * push a tradable BTC/ETH window out of a fixed-size global result set.
 */
export async function discoverActiveMarkets(client: LiveMarketClient, venueId?: string, now = Date.now()) {
  // Do not filter by indexed lifecycle status here: Listed -> Trading can be a
  // timestamp-only transition with no event, so that field may legitimately lag.
  const pages = await Promise.all(SUPPORTED_ASSETS.map(asset => client.listLiveBinaryMarkets({
    asset,
    limit: 8,
    nowSec: Math.floor(now / 1000),
    ...(venueId ? { venueId } : {}),
  })));

  const unique = new Map<string, BinaryMarket>();
  for (const market of pages.flat()) {
    const expiry = Number(market.expiry) * 1000;
    const tradingStart = Number(market.tradingStart) * 1000;
    if (!SUPPORTED_ASSETS.includes(market.asset.toUpperCase() as typeof SUPPORTED_ASSETS[number])) continue;
    if (!Number.isFinite(expiry) || expiry <= now || !Number.isFinite(tradingStart) || tradingStart > now) continue;
    unique.set(market.marketId, market);
  }

  return [...unique.values()]
    .sort((a, b) => Number(a.expiry) - Number(b.expiry))
    .slice(0, 8);
}

export function retryDelay(failures: number) {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}
