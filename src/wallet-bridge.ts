import type { Address } from 'viem';
import type { Market, Side } from '../shared/domain';

type QuotePreview = { shares: string; maxCost: string; limit: string };

// Keep the chain SDK out of the initial Arena bundle. It is fetched only when
// someone explicitly connects a wallet or performs a wallet action.
export async function connectWallet() {
  return (await import('./wallet')).connectWallet();
}

export async function placeStake(
  market: Market,
  side: Side,
  stake: string,
  account: Address,
  onQuoted?: (quote: QuotePreview) => void,
) {
  return (await import('./wallet')).placeStake(market, side, stake, account, onQuoted);
}

export async function loadPortfolio(account: Address) {
  return (await import('./wallet')).loadPortfolio(account);
}

export async function cancelOrder(pool: string, orderId: string, account: Address) {
  return (await import('./wallet')).cancelOrder(pool, orderId, account);
}

export async function redeemAll(account: Address) {
  return (await import('./wallet')).redeemAll(account);
}
