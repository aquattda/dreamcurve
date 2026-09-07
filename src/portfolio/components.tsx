import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Copy, ExternalLink, X } from 'lucide-react';
import { formatMoney, formatNumber, formatPrice, formatTime, getExplorerTxUrl, marketUrl, NETWORK_NAME, shortHash } from './format';
import { countdown, positionStatus } from './status';
import type { Activity, Position } from './types';

export function ExplorerLink({ hash, children = 'View transaction' }: { hash?: string; children?: ReactNode }) {
  const url = hash ? getExplorerTxUrl(hash) : undefined;
  return url ? <a className="pf-link" href={url} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={14}/></a> : null;
}
export function Metric({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
export function PnLDisplay({ value, cost }: { value: number | null; cost?: number | null }) {
  const percent = value != null && cost != null && cost > 0 ? value / cost * 100 : null;
  return <span className={value == null ? '' : value < 0 ? 'pf-negative' : value > 0 ? 'pf-positive' : ''}>
    {value != null && value > 0 ? '+' : ''}{formatMoney(value)}{percent != null ? <small> ({percent > 0 ? '+' : ''}{formatNumber(percent)}%)</small> : null}
  </span>;
}
export function PositionCard({ position: p, now }: { position: Position; now: number }) {
  const status = positionStatus(p, now);
  const markUnavailable = !p.market.voided && p.market.winningOutcome == null && (Number(p.market.expiry) * 1000 <= now || ['Locked', 'Settling'].includes(p.market.status));
  const won = p.market.winningOutcome === (p.side === 'YES' ? 0 : 1);
  const otherCollateral = p.market.collateral.toLowerCase() !== '0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e';
  return <article className="pf-position">
    <div className="pf-card-head"><strong>{p.market.asset} <span className={`pf-side ${p.side.toLowerCase()}`}>{p.side}</span></strong><span className={`pf-badge ${status === 'REDEEMABLE' || status === 'REDEEMED' ? 'accent' : status === 'CLOSING SOON' ? 'warning' : ''}`}>{status}</span></div>
    <h3>{p.market.question}</h3><p className="pf-shares">{formatNumber(p.shares)} <span>shares{p.redeemed ? ' redeemed' : ''}</span></p>
    <dl className="pf-metrics">
      <Metric label="Avg entry">{formatPrice(p.avgEntry)}</Metric><Metric label="Current price">{formatPrice(markUnavailable ? null : p.price)}</Metric>
      <Metric label="Cost basis">{formatMoney(otherCollateral ? null : p.cost)}</Metric><Metric label="Current value">{formatMoney(otherCollateral || markUnavailable ? null : p.value)}</Metric>
      <Metric label={p.closed ? 'Realized P&L' : 'Unrealized P&L'}><PnLDisplay value={otherCollateral ? null : p.closed ? p.realized : markUnavailable ? null : p.unrealized} cost={p.cost}/></Metric>
      {p.closed && !p.redeemed && p.heldShares > 0 && (won || p.market.voided) ? <Metric label="Unclaimed P&L"><PnLDisplay value={otherCollateral ? null : p.unrealized} cost={p.cost}/></Metric> : null}
      <Metric label={p.closed ? 'Settlement payout' : 'Potential payout (before fees)'}>{formatMoney(otherCollateral ? null : p.closed ? p.payout : p.shares)}</Metric>
    </dl>
    {p.unavailable ? <p className="pf-note">{p.unavailable}</p> : null}
    {otherCollateral ? <p className="pf-note">This market uses different collateral; tUSDC values are unavailable.</p> : null}
    <div className="pf-position-foot"><p>{p.market.winningOutcome != null ? `${won ? 'WON' : 'LOST'} · Settlement ${p.market.winningOutcome === 0 ? 'YES' : 'NO'}` : p.market.voided ? 'Market voided' : countdown(p.market.expiry, now)}{p.market.resolvedAtTimestamp ? <small>Resolved {formatTime(Number(p.market.resolvedAtTimestamp) * 1000)}</small> : null}</p>
      <Link className="pf-link" to={marketUrl(p.market.id)}>View market <ArrowRight size={15}/></Link><ExplorerLink hash={p.txHash}/>
    </div>
    {/* TODO: Add a reviewed SELL quote/close workflow; never simulate an exit transaction. */}
  </article>;
}
function CopyValue({ label, value }: { label: string; value?: string }) {
  const [message, setMessage] = useState('');
  return <div className="pf-copy"><span>{value ?? '--'}</span>{value ? <button aria-label={`Copy ${label}`} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setMessage('Copied'); } catch { setMessage('Copy unavailable; select the text above.'); }
  }}><Copy size={15}/></button> : null}<small role="status">{message}</small></div>;
}
export function TradeDetail({ trade, onClose }: { trade: Activity; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { el?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="pf-dialog" aria-labelledby="pf-detail-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="pf-dialog-content"><button className="pf-dialog-close" aria-label="Close trade details" onClick={onClose}><X/></button>
      <span className="eyebrow">ON-CHAIN ACTIVITY</span><h2 id="pf-detail-title">{trade.kind === 'Trades' ? 'Trade details' : 'Transaction details'}</h2>
      <p>{trade.marketTitle}</p><div className="pf-card-head"><strong>{trade.action}</strong><span className={`pf-badge ${trade.status === 'Confirmed' ? 'accent' : ''}`}>{trade.status}</span></div>
      <dl className="pf-detail-metrics">
        <Metric label="Shares">{formatNumber(trade.shares)}</Metric><Metric label="Average fill price">{formatPrice(trade.price)}</Metric>
        <Metric label="Trade / payout value">{formatMoney(trade.total)}</Metric><Metric label="Trading fee">{trade.fee == null ? '-- (not exposed)' : formatMoney(trade.fee)}</Metric>
        <Metric label={trade.source === 'Wallet submission' ? 'Submitted' : 'Executed'}>{formatTime(trade.timestamp)}</Metric>
        <Metric label="Order ID"><CopyValue label="order ID" value={trade.orderId}/></Metric>
        <Metric label="Transaction hash"><CopyValue label="transaction hash" value={trade.txHash}/></Metric>
        <Metric label="Network">{NETWORK_NAME}</Metric><Metric label="Source">{trade.source}</Metric>
      </dl>{trade.note ? <p className="pf-note">{trade.note}</p> : null}
      {!trade.txHash ? <p className="pf-note">Transaction hash is not available yet. No explorer link can be verified.</p> : null}
      <div className="pf-actions"><ExplorerLink hash={trade.txHash}/>{trade.marketId ? <Link className="pf-link" to={marketUrl(trade.marketId)} onClick={onClose}>View market <ArrowRight size={15}/></Link> : null}</div>
    </div>
  </dialog>;
}
export function ActivitySection({ activity, loading, error }: { activity: Activity[] | null; loading: boolean; error: string }) {
  const [filter, setFilter] = useState('All');
  const [detail, setDetail] = useState<Activity | null>(null);
  const rows = activity?.filter(a => filter === 'All' || a.kind === filter);
  return <section className="pf-section" id="portfolio-activity" aria-labelledby="pf-activity-title">
    <div className="pf-section-head"><h2 id="pf-activity-title">Activity <span>{activity?.length ?? '--'}</span></h2><div className="pf-tabs" aria-label="Filter activity">{['All', 'Trades', 'Orders', 'Redeems'].map(tab => <button key={tab} aria-pressed={filter === tab} onClick={() => setFilter(tab)}>{tab}</button>)}</div></div>
    {!activity ? <p className="pf-empty">{loading ? 'Loading trading activity…' : error ? 'Activity unavailable. Retry the data refresh.' : 'No trading activity yet.'}</p> : !rows?.length ? <p className="pf-empty">No {filter === 'All' ? 'trading activity' : filter.toLowerCase()} yet.<small>Your fills will appear here after your first trade.</small></p> : <div className="pf-activity-list">{rows.map(a => <article className="pf-activity" key={`${a.kind}:${a.id}`}>
      <div><span className="pf-badge">{a.action}</span><h3>{a.marketTitle}</h3><small>{formatTime(a.timestamp)}</small></div>
      <div><strong>{formatNumber(a.shares)} shares <span>@ {formatPrice(a.price)}</span></strong><p>{formatMoney(a.total)}</p></div>
      <div><span className={`pf-badge ${a.status === 'Confirmed' ? 'accent' : ''}`}>{a.status}{a.status === 'Confirmed' ? ' ✓' : ''}</span><small>{a.source}</small></div>
      <div className="pf-row-actions"><button className="pf-link" onClick={() => setDetail(a)} aria-label={`Details: ${a.action} ${a.marketTitle}`}>Details <ArrowRight size={14}/></button><ExplorerLink hash={a.txHash}>{a.txHash ? shortHash(a.txHash) : ''}</ExplorerLink></div>
    </article>)}</div>}
    {detail ? <TradeDetail trade={activity?.find(a => a.id === detail.id && a.kind === detail.kind) ?? detail} onClose={() => setDetail(null)}/> : null}
  </section>;
}
