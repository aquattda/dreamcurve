import 'dotenv/config';
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, type BinaryMarket } from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, formatUnits } from 'viem';
import type { Market } from '../shared/domain';

export const publicConfig = {
  chainId: 50312,
  rpcUrl: process.env.SOMNIA_RPC_URL || 'https://dream-rpc.somnia.network',
  wsRpcUrl: process.env.SOMNIA_WS_RPC_URL || 'wss://api.infra.testnet.somnia.network/ws',
  indexerUrl: process.env.DREAMDEX_INDEXER_URL || 'https://dev.smk.somnia.host/v1/graphql',
  explorer: somniaShannon.blockExplorers.default.url,
};
export function makeExchange(signal?: AbortSignal) { return new SomniaMarkets({ chain: somniaShannon, wsRpcUrl: publicConfig.wsRpcUrl, indexerUrl: publicConfig.indexerUrl, addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED, signal }); }
export const exchange = makeExchange();
export const chainClient = createPublicClient({ chain: somniaShannon, transport: http(publicConfig.rpcUrl, {timeout: 12_000, retryCount: 0}) });
export async function readMarket(row: BinaryMarket): Promise<Market> {
  const onchain = await exchange.client.getMarketOnchain(row.marketId);
  const [book, grid, feedResult, strikeResult] = await Promise.all([
    exchange.client.getBinaryOrderBook(onchain.pool, {depth: 10, decimals: onchain.decimals}),
    exchange.client.getBinaryBookParams(onchain.pool),
    exchange.client.fetchPrices([row.asset]).catch(() => []),
    // The indexer's strike/opening-price fields currently use its documented,
    // empirical explorer scale of 2. This is deliberately separate from the
    // adapter's resolution-price scale, which can be 18.
    (async () => {
      const raw = row.mode === 'reference' ? (await exchange.client.getOpeningPrices([row.marketId]))[row.marketId.toLowerCase()] : row.strike;
      return raw ? Number(formatUnits(BigInt(raw), 2)) : null;
    })().catch(() => null),
  ]);
  const feed = feedResult.find(f => f.asset.toUpperCase() === row.asset.toUpperCase());
  const spot = feed && Date.now() - feed.blockTimestamp * 1000 < 30_000 ? feed.price : null;
  const levels = (side: typeof book.yesBids) => side.map(l => ({ price: Number(formatUnits(l.price, onchain.decimals)), size: Number(formatUnits(l.quantity, onchain.decimals)) }));
  return { id: row.marketId, title: row.question, asset: row.asset, pool: onchain.pool, venueId: row.venueId || '',
    expiry: Number(onchain.expiry) * 1000, interval: Number(row.intervalSec || Number(row.expiry) - Number(row.tradingStart)),
    status: ['Listed', 'Trading', 'Locked', 'Settling', 'Resolved', 'Voided'][onchain.status] || 'Unknown',
    strike: strikeResult, spot, updatedAt: Date.now(), source: 'live', yesBids: levels(book.yesBids), yesAsks: levels(book.yesAsks), noBids: levels(book.noBids), noAsks: levels(book.noAsks),
    priceDecimals: onchain.decimals, collateralDecimals: onchain.decimals, tick: grid.tickSize.toString(), lot: grid.lotSize.toString(), collateral: onchain.collateral, yesId: onchain.yesId.toString(), noId: onchain.noId.toString() };
}
