import type { BinaryMarket, PortfolioOrder, PortfolioPosition } from '@somnia-chain/markets-sdk';

export type ActivityKind = 'Trades' | 'Orders' | 'Redeems' | 'Wallet';
export type TransactionStatus = 'Pending' | 'Confirmed' | 'Failed';
export interface Activity {
  id: string;
  kind: ActivityKind;
  action: string;
  marketId?: string;
  marketTitle: string;
  side: 'YES' | 'NO' | null;
  shares: number | null;
  price: number | null;
  total: number | null;
  fee: number | null;
  timestamp: number | null;
  txHash?: string;
  orderId?: string;
  status: TransactionStatus;
  source: 'Indexer' | 'Wallet receipt' | 'Wallet submission';
  note?: string;
}
export interface Position {
  id: string;
  market: BinaryMarket;
  side: 'YES' | 'NO';
  shares: number;
  heldShares: number;
  avgEntry: number | null;
  price: number | null;
  cost: number | null;
  value: number | null;
  unrealized: number | null;
  realized: number | null;
  payout: number | null;
  redeemed: boolean;
  closed: boolean;
  txHash?: string;
  unavailable?: string;
}
export interface Order extends PortfolioOrder {
  expiresAt: number | null;
  indexedStatus: string;
}
export interface PortfolioData {
  account: string;
  positions: Position[];
  orders: Order[];
  activity: Activity[];
  balance: number | null;
  realized: number | null;
  claimable: { count: number; value: number | null } | null;
  updatedAt: number;
  warnings: string[];
  complete: boolean;
  holdingCount: number;
  unavailableHoldings: PortfolioPosition[];
}
