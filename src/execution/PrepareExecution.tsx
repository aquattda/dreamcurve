import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck, X } from 'lucide-react';
import type { Address } from 'viem';
import { decimalRaw, type AgentId, type Market, type Side } from '../../shared/domain';
import { executionApi, type ExecutionView, type KeeperHealth } from './api';
import './execution.css';

type Props = { market: Market; side: Side; agentId?: AgentId; account: Address | null; onConnect: () => void; onClose: () => void; onLegacy: () => void };
export function PrepareExecution({ market, side, agentId, account, onConnect, onClose, onLegacy }: Props) {
  const [stake, setStake] = useState('0.5');
  const [health, setHealth] = useState<KeeperHealth | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), dialog = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  useEffect(() => { let active = true; void executionApi<KeeperHealth>('/health').then(v => { if (active) setHealth(v); }).catch(e => { if (active) setError(String(e.message)); }); return () => { active = false; }; }, []);
  useEffect(() => { const previous = document.activeElement; dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  async function prepare() {
    if (!account) { onConnect(); return; }
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const r = await executionApi<ExecutionView>('/prepare', { marketId: market.id, side, stake, operatorAddress: account, agentId });
      navigate(`/app/executions/${r.intent.id}`); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not prepare execution.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const allowed = !!account && !!health?.operatorAddresses.some(a => a.toLowerCase() === account.toLowerCase());
  let validStake = false;
  try { const amount = decimalRaw(stake, market.collateralDecimals); validStake = amount > 0n && amount <= decimalRaw(health?.maxTrade || '1', market.collateralDecimals); } catch { /* Show the backend's exact-decimal validation on submission. */ }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section ref={dialog} className="trade-modal keeper-prepare" role="dialog" aria-modal="true" aria-labelledby="keeper-prepare-title" onKeyDown={e => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key !== 'Tab') return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)');
      if (!nodes?.length) return;
      if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus(); }
    }}>
      <button className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}><X/></button>
      <span className="eyebrow">DETERMINISTIC EXECUTION</span><h2 id="keeper-prepare-title">Prepare {side} on {market.asset}</h2><p>{market.title}</p>
      <div className="execution-boundary"><span>Model proposes</span><ArrowRight size={16}/><strong>You review</strong><ArrowRight size={16}/><span>KeeperHub executes</span></div>
      <label>Maximum stake (tUSDC)<input value={stake} onChange={e => setStake(e.target.value)} disabled={busy} inputMode="decimal" aria-describedby="keeper-stake-help"/></label>
      <small id="keeper-stake-help">Up to {health?.maxTrade || '1'} tUSDC per trade; {health?.maxSession || '5'} tUSDC cumulative demo budget per executor. Live depth, protective limit and expiry are frozen before review.</small>
      <div className="ticket-warning"><ShieldCheck size={20}/><span>KeeperHub's organization wallet holds the collateral and resulting position. Your connected wallet authorizes the intent with a message signature.</span></div>
      {health?.walletAddress ? <p className="execution-address">Executing wallet: <code>{health.walletAddress}</code></p> : null}
      {!health && !error ? <p role="status">Checking KeeperHub connectivity…</p> : null}
      {health?.issues.map((issue, n) => <p key={`${issue.code}-${n}`} className="form-error">{issue.message}</p>)}
      {account && health && !allowed ? <p className="form-error">Your connected wallet is not configured as a KeeperHub operator.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button primary full" disabled={busy || (!!account && (!health?.ready || !allowed)) || !validStake} onClick={() => void prepare()}>{busy ? 'Freezing live intent…' : !account ? 'Connect operator wallet' : 'Prepare execution'} <ArrowRight size={16}/></button>
      <div className="execution-secondary"><Link to="/app/executions" onClick={onClose}>Execution history</Link><button onClick={onLegacy} disabled={busy}>Legacy direct-wallet trade</button></div>
    </section>
  </div>;
}
