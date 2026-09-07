import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryMarket, FillRow, RouterActionRecord } from '@somnia-chain/markets-sdk';
import { derivePositions, fillActivity } from '../src/portfolio/model';
import { formatPrice, formatProbability, getExplorerTxUrl, getExplorerAddressUrl } from '../src/portfolio/format';
import { positionStatus } from '../src/portfolio/status';
import { portfolioTotals } from '../src/portfolio/totals';
import { mergeActivity, readJournal, saveActivity } from '../src/portfolio/journal';
import type { Activity } from '../src/portfolio/types';

const account = `0x${'12'.repeat(20)}`;
const hash = `0x${'34'.repeat(32)}`;
const now = 1_800_000_000_000;
const market = { id: `0x${'56'.repeat(32)}`, marketType: 'BINARY', question: 'BTC closes above its opening price',
  asset: 'BTC', quoteDecimals: 6, collateral: '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E', lastPrice: '253000',
  expiry: String(now / 1000 + 300), tradingStart: String(now / 1000 - 300), winningOutcome: null, voided: false, status: 'Trading',
} as unknown as BinaryMarket; // Minimal read-only fixture: only fields consumed by the pure fold.
const fill: FillRow = { id: '100_1', market: market.id, pool: `0x${'78'.repeat(20)}`, fillPrice: '231000', quantity: '40000000', quoteQuantity: '9240000',
  maker: `0x${'90'.repeat(20)}`, makerSide: 'SELL_YES', taker: account, takerSide: 'BUY_YES', takerOrder: { owner: account, side: 'BUY_YES' },
  kind: null, takerIsBid: true, makerOrderId: '123', takerOrderId: '456', timestamp: String(now / 1000 - 60), txHash: hash };
const derive = (overrides: Partial<BinaryMarket> = {}, balances: [bigint, bigint] = [40_000_000n, 0n], fills = [fill], actions: RouterActionRecord[] = [], complete = true) => derivePositions(account, { ...market, ...overrides }, balances, fills, actions, undefined, complete, now);

describe('portfolio accounting and lifecycle', () => {
  it('separates cents from implied probability and validates explorer targets', () => {
    expect(formatPrice(.253)).toBe('25.3¢'); expect(formatProbability(.253)).toBe('25.3%');
    expect(getExplorerTxUrl(hash)).toContain(`/tx/${hash}`); expect(getExplorerTxUrl('0xfake')).toBeUndefined();
    expect(getExplorerAddressUrl(account)).toContain(`/address/${account}`); expect(getExplorerAddressUrl('javascript:alert(1)')).toBeUndefined();
  });
  it('uses executed NO price, not YES price or quoteQuantity', () => {
    const row = fillActivity({ ...fill, fillPrice: '769000', takerSide: 'BUY_NO', takerOrder: { owner: account, side: 'BUY_NO' } }, account, market);
    expect(row.price).toBe(.231); expect(row.total).toBe(9.24); expect(row.orderId).toBe('456'); expect(row.txHash).toBe(hash);
  });
  it('uses the maker order and side for maker fills', () => {
    const row = fillActivity({ ...fill, maker: account, makerSide: 'SELL_NO' }, account, market);
    expect(row.action).toBe('SELL NO'); expect(row.orderId).toBe('123'); expect(row.price).toBe(.769);
  });
  it('derives exact fixed-point average cost, current value and P&L', () => {
    const [p] = derive(); expect(p.avgEntry).toBe(.231); expect(p.cost).toBe(9.24); expect(p.value).toBe(10.12); expect(p.unrealized).toBe(.88);
  });
  it('keeps YES and NO cost books separate', () => {
    const no = { ...fill, id: '101_2', takerOrder: { owner: account, side: 'BUY_NO' as const }, fillPrice: '600000', quantity: '10000000' };
    const rows = derive({}, [40_000_000n, 10_000_000n], [fill, no]);
    expect(rows[0].avgEntry).toBe(.231); expect(rows[1].avgEntry).toBe(.4); expect(rows[1].value).toBe(7.47);
  });
  it('does not invent zero cost for transferred or unindexed tokens', () => {
    const [p] = derive({}, [41_000_000n, 0n]); expect(p.avgEntry).toBeNull(); expect(p.cost).toBeNull(); expect(p.unrealized).toBeNull(); expect(p.value).toBe(10.373);
  });
  it('never asserts a complete P&L over capped history', () => { expect(derive({}, [40_000_000n, 0n], [fill], [], false)[0].realized).toBeNull(); });
  it('leaves never-priced markets unknown, rather than zero', () => { const [p] = derive({ lastPrice: null }); expect(p.price).toBeNull(); expect(p.value).toBeNull(); expect(p.avgEntry).toBe(.231); });
  it('invalidates stale marks at expiry and uses live countdown status', () => {
    expect(positionStatus(derive()[0], now)).toBe('OPEN'); expect(positionStatus(derive()[0], now + 240_000)).toBe('CLOSING SOON');
    expect(positionStatus(derive()[0], now + 300_000)).toBe('TRADING CLOSED');
    const [p] = derive({ expiry: String(now / 1000 - 1) }); expect(p.price).toBeNull(); expect(p.unrealized).toBeNull();
    expect(positionStatus(derive({ status: 'Settling' })[0], now)).toBe('AWAITING RESOLUTION');
  });
  it('recognizes redeemable winners without realizing unclaimed profit', () => {
    const [p] = derive({ status: 'Resolved', winningOutcome: 0 }); expect(positionStatus(p, now)).toBe('REDEEMABLE'); expect(p.value).toBe(40); expect(p.realized).toBe(0); expect(p.payout).toBeNull();
  });
  it('keeps unredeemed winners in unrealized summary rather than losing their gain', () => {
    const positions = derive({ status: 'Resolved', winningOutcome: 0 });
    const totals = portfolioTotals({ complete: true, balance: 100, positions }, now);
    expect(totals.value).toBe(140); expect(totals.unrealized).toBe(30.76);
  });
  it('uses actual redemption payout and keeps its genuine hash', () => {
    const action: RouterActionRecord = { id: '200_1', kind: 'Redeem', account, market: market.id, amount: '40000000', payout: '39600000', routedVia: null, timestamp: String(now / 1000), txHash: hash };
    const [p] = derive({ status: 'Resolved', winningOutcome: 0 }, [0n, 0n], [fill], [action]);
    expect(positionStatus(p, now)).toBe('REDEEMED'); expect(p.payout).toBe(39.6); expect(p.realized).toBe(30.36); expect(p.txHash).toBe(hash); expect(p.value).toBe(0);
  });
  it('records a resolved loser as zero payout and a real loss', () => {
    const [p] = derive({ status: 'Resolved', winningOutcome: 1 }); expect(p.payout).toBe(0); expect(p.realized).toBe(-9.24); expect(p.closed).toBe(true);
  });
  it('does not infer a voided redemption outcome from an unlabelled action', () => {
    const action: RouterActionRecord = { id: '200_1', kind: 'Redeem', account, market: market.id, amount: '40000000', payout: '20000000', routedVia: null, timestamp: String(now / 1000), txHash: hash };
    const [p] = derive({ voided: true }, [0n, 0n], [fill], [action]); expect(p.realized).toBeNull(); expect(positionStatus(p, now)).toBe('VOIDED');
  });
});
describe('wallet-scoped transaction recovery', () => {
  const record: Activity = { id: hash, txHash: hash, kind: 'Trades', action: 'BUY YES', marketTitle: 'BTC', side: 'YES', shares: 40, price: .231, total: 9.24, fee: null, timestamp: now, status: 'Confirmed', source: 'Wallet receipt' };
  beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
  it('persists real receipts, scopes account keys and rejects fake hashes', () => {
    expect(saveActivity(account, record)).toBe(true); expect(readJournal(account)[0].txHash).toBe(hash);
    expect(readJournal(`0x${'ab'.repeat(20)}`)).toEqual([]); expect(saveActivity(account, { ...record, txHash: '0xfake' })).toBe(false);
  });
  it('replaces the receipt aggregate with all indexed fills without double counting', () => {
    const indexed = [{ ...record, id: '1_1', source: 'Indexer' as const }, { ...record, id: '1_2', source: 'Indexer' as const }];
    expect(mergeActivity(indexed, [record])).toHaveLength(2);
  });
  it('retains in-memory recovery when browser storage fails', () => {
    vi.stubGlobal('localStorage', { getItem: () => '[]', setItem: () => { throw new Error('Quota'); } });
    expect(saveActivity(account, { ...record, status: 'Pending' })).toBe(false); expect(readJournal(account)[0].status).toBe('Pending');
  });
});
