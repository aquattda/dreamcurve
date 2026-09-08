import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Address } from 'viem';
import { blockReason, decimalRaw, type Market, type Side } from '../shared/domain';
import { placeStake } from './wallet-bridge';
import { getExplorerTxUrl } from './portfolio/format';

interface Props {
  market: Market; side: Side; account: Address | null; onConnect: () => void; onClose: () => void;
  funding: {
    testUsdc: { raw: bigint; decimals: number; formatted: string } | null;
    fundingBusy: boolean; fundingStatus: string; fundingHash: string;
    refreshTestUsdc: () => void; requestTestUsdc: () => void;
  };
}
const cents = (n: number | undefined) => n == null ? 'No ask' : `${(n * 100).toFixed(1)}¢`;

export function TradeModal({ market, side, account, onConnect, onClose, funding }: Props) {
  const { testUsdc, fundingBusy, fundingStatus, fundingHash, refreshTestUsdc, requestTestUsdc } = funding;
  const [stake, setStake] = useState('10');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [quote, setQuote] = useState<{ shares: string; maxCost: string; limit: string } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const submittedHash = useRef('');
  const blocked = blockReason(market, now);
  const validStake = /^\d+(\.\d+)?$/.test(stake) && Number(stake) > 0;
  let insufficientFunds = false;
  if (account && testUsdc && validStake) {
    try { insufficientFunds = decimalRaw(stake, testUsdc.decimals) > testUsdc.raw; }
    catch { insufficientFunds = true; }
  }
  const ask = market[side === 'YES' ? 'yesAsks' : 'noAsks'][0]?.price;
  useEffect(() => { if (account) refreshTestUsdc(); }, [account, refreshTestUsdc]);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  async function submit() {
    if (submitting.current || confirmed || submittedHash.current) return;
    if (!account) { onConnect(); return; }
    if (!validStake || !testUsdc || insufficientFunds || blocked || fundingBusy || ask == null) return;
    submitting.current = true; setBusy(true); setQuote(null);
    setStatus('Refreshing the order book and checking market status…');
    try {
      const result = await placeStake(market, side, stake, account, q => {
        setQuote(q); setStatus('Quote ready. Confirm the wallet request to continue…');
      }, (message, transactionHash) => {
        if (transactionHash) { submittedHash.current = transactionHash; setHash(transactionHash); }
        setStatus(message);
      });
      setHash(result.hash); setConfirmed(true);
      setStatus(result.fills ? `Confirmed with ${result.fills} fill${result.fills === 1 ? '' : 's'}.`
        : 'Transaction confirmed with no fills. The unfilled IOC quantity was cancelled; no position was bought.');
      refreshTestUsdc();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The trade could not be completed.';
      setStatus(submittedHash.current
        ? `${message} A transaction was submitted (possibly an approval). Check its receipt and Portfolio before retrying.`
        : /user rejected|user denied/i.test(message) ? 'Request cancelled in your wallet. No transaction hash was received.' : message);
    } finally { submitting.current = false; setBusy(false); }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy && !fundingBusy) onClose(); }}>
    <section ref={dialog} className="trade-modal" role="dialog" aria-modal="true" aria-labelledby="trade-title" onKeyDown={e => {
      if (e.key === 'Escape' && !busy && !fundingBusy) { e.preventDefault(); onClose(); }
      if (e.key !== 'Tab') return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)');
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }}>
      <button className="modal-close" onClick={onClose} disabled={busy || fundingBusy} aria-label="Close"><X/></button>
      <span className="eyebrow">REVIEW YOUR MOVE</span><h2 id="trade-title">Buy {side} on {market.asset}</h2><p>{market.title}</p>
      <div className="ticket-odds"><span>Current executable ask</span><strong>{cents(ask)}</strong></div>
      <div className="wallet-funding"><div><span>Wallet balance</span><strong>{account ? testUsdc ? `${Number(testUsdc.formatted).toLocaleString('en-US', { maximumFractionDigits: 2 })} tUSDC` : 'Checking…' : 'Connect wallet to check'}</strong></div>
        {account && !testUsdc ? <button className="button outline" onClick={refreshTestUsdc} disabled={fundingBusy || busy}>Retry balance</button> : null}
        {account && insufficientFunds ? <button className="button outline" onClick={requestTestUsdc} disabled={fundingBusy || busy}>{fundingBusy ? 'Claiming…' : 'Claim 10,000 tUSDC'}</button> : null}
      </div>
      {fundingStatus ? <p className="form-status" role="status">{fundingStatus}</p> : null}
      {fundingHash ? <a className="text-link" href={getExplorerTxUrl(fundingHash)} target="_blank" rel="noopener noreferrer">View faucet transaction <ExternalLink size={14}/></a> : null}
      <label>Maximum stake (tUSDC)<input value={stake} disabled={busy || confirmed || !!hash} onChange={e => setStake(e.target.value)} inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" aria-describedby="stake-help"/></label>
      <small id="stake-help">The final quote uses current on-chain depth, a 2% protective limit and the market’s tick/lot grid.</small>
      {quote ? <div className="quote-grid"><span>Shares <strong>{Number(quote.shares).toFixed(2)}</strong></span><span>Max cost <strong>{quote.maxCost} tUSDC</strong></span><span>Limit <strong>{cents(Number(quote.limit))}</strong></span></div> : null}
      <div className="ticket-warning"><ShieldCheck size={19}/><span>Your wallet signs every transaction. Faucet, approval and trade requests are shown separately. STT is required for gas.</span></div>
      {blocked ? <p className="form-error">{blocked}</p> : null}
      {insufficientFunds ? <p className="form-error">Insufficient tUSDC for this stake.</p> : null}
      {status ? <p className={confirmed ? 'form-success' : 'form-status'} role="status">{status}</p> : null}
      {hash ? <a className="text-link" href={getExplorerTxUrl(hash)} target="_blank" rel="noopener noreferrer">View transaction <ExternalLink size={14}/></a> : null}
      <button className="button primary full" onClick={() => void submit()} disabled={busy || fundingBusy || !!blocked || insufficientFunds || !validStake || ask == null || !!account && !testUsdc || !!hash}>
        {busy ? <><RefreshCw className="spin"/> Awaiting wallet / confirmation…</> : hash ? 'Check transaction in Portfolio' : account ? `Review ${side} trade` : 'Connect wallet to continue'}
      </button>
      <p className="fine-print">Testnet event contract. tUSDC is a test token with no real-money value. An outcome share can settle at zero.</p>
    </section>
  </div>;
}
