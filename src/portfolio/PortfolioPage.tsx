import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink, RefreshCw, Wallet } from 'lucide-react';
import { formatUnits, type Address } from 'viem';
import { cancelOrder, fetchPortfolioData, redeemAll } from '../wallet-bridge';
import { ActivitySection, ExplorerLink, Metric, PnLDisplay, PositionCard } from './components';
import { formatMoney, formatNumber, formatPrice, formatTime, getExplorerAddressUrl, marketUrl, NETWORK_NAME, shortHash } from './format';
import { mergeActivity, PORTFOLIO_CHANGED, readJournal } from './journal';
import { orderStatus } from './status';
import { portfolioTotals } from './totals';
import type { Order, PortfolioData } from './types';
import './portfolio.css';

interface PortfolioWallet {
  account: Address | null;
  connect: () => void;
  fundingBusy: boolean;
  fundingStatus: string;
  fundingHash: string;
  refreshTestUsdc: () => void;
  requestTestUsdc: () => void;
}
function usePortfolio(account: Address | null) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const request = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (!account) return Promise.resolve();
    if (request.current) return request.current;
    setLoading(true);
    request.current = fetchPortfolioData(account).then(next => {
      if (!mounted.current) return;
      setData(previous => ({ ...next, balance: next.balance ?? previous?.balance ?? null }));
      setError('');
    }).catch((e: unknown) => {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Portfolio data unavailable.');
    }).finally(() => {
      request.current = null;
      if (mounted.current) setLoading(false);
    });
    return request.current;
  }, [account]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const changed = () => {
      if (account) setData(previous => previous ? { ...previous, activity: mergeActivity(previous.activity.filter(a => a.source === 'Indexer'), readJournal(account)) } : previous);
      void refresh();
    };
    window.addEventListener(PORTFOLIO_CHANGED, changed);
    window.addEventListener('focus', changed);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener(PORTFOLIO_CHANGED, changed); window.removeEventListener('focus', changed); };
  }, [account, refresh]);
  return { data, error, loading, refresh };
}
function OrderCard({ order: o, now, busy, onCancel }: { order: Order; now: number; busy: boolean; onCancel: (order: Order) => void }) {
  const number = (raw: string) => Number(formatUnits(BigInt(raw), o.market.quoteDecimals));
  const status = orderStatus(o, now);
  const price = o.side == null ? null : o.side.endsWith('_NO') ? 1 - number(o.price) : number(o.price);
  return <article className="pf-position"><div className="pf-card-head"><strong>{o.market.asset} · {o.side?.replace('_', ' ') ?? 'Side unavailable'}</strong><span className="pf-badge">{status}</span></div>
    <h3>{o.market.question}</h3><p className="pf-shares">{formatNumber(number(o.fullQuantity))} <span>shares @ {formatPrice(price)}</span></p>
    <dl className="pf-metrics"><Metric label="Filled">{formatNumber(number(o.filledQuantity))} / {formatNumber(number(o.fullQuantity))}</Metric><Metric label="Remaining">{formatNumber(number(o.quantityRemaining))}</Metric>
      <Metric label="Created">{formatTime(Number(o.placedAtTimestamp) * 1000)}</Metric><Metric label="Expires">{formatTime(o.expiresAt)}</Metric></dl>
    <div className="pf-actions"><button className="button outline small" disabled={busy || !['OPEN', 'PARTIALLY FILLED'].includes(status) || o.expiresAt == null} onClick={() => onCancel(o)}>Cancel order</button><ExplorerLink hash={o.placedTxHash}/></div>
  </article>;
}
export default function PortfolioPage({ wallet }: { wallet: PortfolioWallet }) {
  const { account, connect, fundingBusy, fundingStatus, fundingHash, requestTestUsdc, refreshTestUsdc } = wallet;
  const { data, error, loading, refresh } = usePortfolio(account);
  const [tab, setTab] = useState('Open');
  const [now, setNow] = useState(Date.now());
  const [action, setAction] = useState('');
  const [actionHash, setActionHash] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
  const [redeemedKey, setRedeemedKey] = useState<string>();
  const actionLock = useRef(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!account) return <section className="empty-state"><span className="empty-glyph">⌁</span><h1>Your positions, in one place.</h1><p>Connect your wallet to view actual Shannon testnet holdings and verifiable transactions.</p><button className="button primary" onClick={connect}><Wallet size={17}/> Connect wallet</button></section>;
  const open = data?.positions.filter(p => !p.closed);
  const closed = data?.positions.filter(p => p.closed);
  const shown = tab === 'Open' ? open : closed;
  const balanceStale = !!error || !!data?.warnings.some(w => w.startsWith('On-chain balance'));
  const { value: totalValue, unrealized, cost } = portfolioTotals(data, now, balanceStale);
  const pending = data?.activity.some(a => a.status === 'Pending') ?? false;
  const claimKey = data?.claimable ? `${data.claimable.count}:${data.claimable.value}:${data.positions.filter(p => p.closed && !p.redeemed && p.value).map(p => `${p.id}:${p.shares}`).join('|')}` : undefined;
  const waitingForIndexer = redeemedKey != null && redeemedKey === claimKey;
  const redeemDisabled = actionBusy || fundingBusy || loading || !!error || !data?.claimable?.count || pending || waitingForIndexer;
  const progress = (message: string, hash?: string) => { setAction(message); if (hash) setActionHash(hash); };
  async function runAction(task: () => Promise<unknown>, initial: string) {
    if (actionLock.current) return;
    actionLock.current = true; setActionBusy(true); setActionHash(undefined); setAction(initial);
    try { await task(); refreshTestUsdc(); await refresh(); }
    catch (e) { setAction(e instanceof Error ? e.message : 'The wallet action could not be completed.'); void refresh(); }
    finally { actionLock.current = false; setActionBusy(false); }
  }
  return <section className="inner-page pf-page">
    <div className="pf-heading"><div><span className="eyebrow">YOUR TESTNET WALLET</span><h1>Portfolio.</h1><p>Every position. Every fill. Verifiable on-chain.</p></div><div className="pf-actions">
      <button className="button outline" onClick={() => { void refresh(); refreshTestUsdc(); }} disabled={loading || actionBusy}><RefreshCw size={16} className={loading ? 'spin' : ''}/> Refresh</button>
      {data?.balance === 0 && !balanceStale ? <button className="button primary" onClick={requestTestUsdc} disabled={fundingBusy || actionBusy}>{fundingBusy ? 'Claiming…' : 'Claim 10,000 tUSDC'}</button> : null}
    </div></div>
    <div className="pf-wallet"><div><span>Connected wallet</span><strong>{shortHash(account)}</strong><a className="pf-link" href={getExplorerAddressUrl(account)} target="_blank" rel="noopener noreferrer">View on explorer <ExternalLink size={14}/></a></div><div><span>Network</span><strong><i className="status-dot"/>{NETWORK_NAME}</strong></div><p>Test tokens only. Wallet actions require MetaMask confirmation.</p></div>
    <div className="pf-sync" role="status">{loading ? 'Refreshing on-chain data…' : error ? 'Data service unavailable' : data ? data.warnings.length ? 'Partially synced' : 'Synced ✓' : 'Not synced'}{data ? <span>Last updated {Math.max(0, Math.floor((now - data.updatedAt) / 1000))} sec ago · {new Date(data.updatedAt).toLocaleTimeString()}</span> : null}</div>
    {error ? <div className="pf-notice" role="alert">{error} {data ? `Showing last synced data from ${new Date(data.updatedAt).toLocaleTimeString()}.` : 'No successful snapshot yet; values are unknown, not zero.'}<button className="pf-link" onClick={() => void refresh()} disabled={loading}>Retry</button></div> : null}
    {data?.warnings.length ? <details className="pf-notice"><summary>Data availability · {data.warnings.length} notice(s)</summary><ul>{data.warnings.map(w => <li key={w}>{w}</li>)}</ul></details> : null}
    {fundingStatus ? <p className="pf-notice" role="status">{fundingStatus} <ExplorerLink hash={fundingHash}/></p> : null}
    <div className="pf-summary">
      <article><span>Portfolio Value</span><strong>{formatMoney(totalValue)}</strong><small>{totalValue == null ? 'Requires complete holdings, current marks and balance.' : 'Wallet + held outcome value. Excludes order escrow and gas.'}</small></article>
      <article><span>Available tUSDC</span><strong>{formatNumber(data?.balance)}</strong><small>{balanceStale ? 'Stale balance — refresh required.' : 'Available in your connected wallet'}</small></article>
      <article><span>Unrealized P&L</span><strong><PnLDisplay value={unrealized} cost={cost}/></strong><small>Open positions + unredeemed winners · before fees and gas</small></article>
      <article><span>Realized P&L</span><strong><PnLDisplay value={data?.realized ?? null}/></strong><small>{data?.realized == null ? 'Complete trade and settlement history unavailable.' : 'Average-cost accounting · excludes trading fees and gas'}</small></article>
      <article><span>Positions held</span><strong>{data?.holdingCount ?? '--'}</strong><a className="pf-link" href="#portfolio-activity">{data ? `${data.activity.filter(a => a.kind === 'Trades').length} recent fills` : 'View activity'} <ArrowRight size={14}/></a></article>
    </div>
    <section className="pf-section"><div className="pf-section-head"><h2>Your positions</h2><div className="pf-tabs" aria-label="Filter positions">{['Open', 'Closed'].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t} Positions <span>{(t === 'Open' ? open : closed)?.length ?? '--'}</span></button>)}</div></div>
      {!data ? <p className="pf-empty">{loading ? 'Loading outcome balances…' : 'Positions unavailable. Refresh to try again.'}</p> : <>
        {shown?.length ? <div className="pf-position-grid">{shown.map(p => <PositionCard key={p.id} position={p} now={now}/>)}</div> : <p className="pf-empty">{tab === 'Open' ? 'No open positions.' : 'No closed positions in the available history.'}</p>}
        {data.unavailableHoldings.length ? <div className="pf-position-grid">{data.unavailableHoldings.map(p => <article className="pf-position" key={`${p.market.id}:${p.outcomeIndex}`}><h3>{p.market.asset} · {p.outcomeIndex === 0 ? 'YES' : 'NO'}</h3><p>{p.market.question}</p><strong>{formatNumber(Number(formatUnits(BigInt(p.balance), p.market.quoteDecimals)))} shares</strong><p className="pf-note">Market details unavailable. Price, cost basis and P&L: --</p><Link className="pf-link" to={marketUrl(p.market.id)}>View market <ArrowRight size={14}/></Link></article>)}</div> : null}
      </>}
    </section>
    <section className="pf-redeem" aria-labelledby="pf-redeem-title"><div><span className="eyebrow">SETTLED OUTCOMES</span><h2 id="pf-redeem-title">Redeem winnings</h2><p>{waitingForIndexer ? 'Redemption confirmed. Waiting for indexed balances to catch up.' : data?.claimable ? `${data.claimable.count} positions ready to redeem` : loading ? 'Checking redeemable positions…' : 'Redeemable balances unavailable.'}</p><small>Estimated net redemption: {formatMoney(data?.claimable?.value)}. Final payout comes from the receipt/indexer.</small></div>
      <button className="button primary" disabled={redeemDisabled} onClick={() => void runAction(async () => { await redeemAll(account, progress); setRedeemedKey(claimKey); }, 'Checking current redeemable balances…')}>{actionBusy ? 'Wallet action in progress…' : data?.claimable?.count ? `Redeem ${formatMoney(data.claimable.value)}` : 'Redeem winnings'}</button>
    </section>
    {action ? <p className="pf-notice" role="status">{action} <ExplorerLink hash={actionHash}/></p> : null}
    {pending ? <p className="pf-notice">A submitted transaction is still awaiting a verified receipt. Check Activity before submitting again.</p> : null}
    <ActivitySection activity={data?.activity ?? (readJournal(account).length ? readJournal(account) : null)} loading={loading} error={error}/>
    <section className="pf-section"><div className="pf-section-head"><h2>Open orders <span>{data?.orders.length ?? '--'}</span></h2></div>
      {!data ? <p className="pf-empty">{loading ? 'Loading orders…' : 'Orders unavailable. Retry the data refresh.'}</p> : data.orders.length ? <div className="pf-position-grid">{data.orders.map(o => <OrderCard key={o.id} order={o} now={now} busy={actionBusy || fundingBusy || loading || !!error || pending} onCancel={order => void runAction(async () => { const hash = await cancelOrder(order.market.poolAddress, order.orderId, account, progress); progress('Order cancellation confirmed ✓', hash); }, 'Rechecking order. Awaiting MetaMask…')}/>)}</div> : <p className="pf-empty">No resting orders.</p>}
    </section>
    <p className="pf-note">Marks are indicative, not executable exit quotes. Missing data is shown as --. Browser receipt recovery is limited to this browser; indexed transactions are available across devices. Fully sold or redeemed positions depend on indexed history. No P&L chart or simulated close transaction.</p>
  </section>;
}
