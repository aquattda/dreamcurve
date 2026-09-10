import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatUnits, type Address } from 'viem';
import { isPending, type ExecutionSafety, type ExecutorFunding, type ExecutionLimits } from '../../shared/execution';
import { getExplorerTxUrl } from '../portfolio/format';
import { executionApi, signIntent, type ExecutionView, type KeeperHealth } from './api';
import './execution.css';
import { FundingCard } from './FundingCard';

export default function ExecutionPage({ account, onConnect }: { account: Address | null; onConnect: () => void }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<ExecutionView | null>(null);
  const [history, setHistory] = useState<ExecutionView[]>([]);
  const [health, setHealth] = useState<KeeperHealth | null>(null);
  const [safety, setSafety] = useState<ExecutionSafety | null>(null);
  const [overview, setOverview] = useState<{ funding: ExecutorFunding; limits: ExecutionLimits } | null>(null);
  const [fundingError, setFundingError] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [accepted, setAccepted] = useState(false), [recoveryId, setRecoveryId] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setRecord(null); setError(''); setAccepted(false);
    async function load() {
      try {
        if (id) { const r = await executionApi<ExecutionView>(`/${id}`); if (active) setRecord(r); }
        else {
          const [rows, status] = await Promise.all([executionApi<ExecutionView[]>(), executionApi<KeeperHealth>('/health')]);
          if (active) { setHistory(rows); setHealth(status); }
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Execution data unavailable.'); }
    }
    void load(); return () => { active = false; };
  }, [id]);
  useEffect(() => {
    if (id) return;
    let active = true; setOverview(null); setFundingError('');
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const v = await executionApi<{ funding: ExecutorFunding; limits: ExecutionLimits }>('/funding'); if (active) { setOverview(v); setFundingError(''); } }
      catch (e) { if (active) { setOverview(null); setFundingError(e instanceof Error ? e.message : 'Funding check unavailable.'); } }
      finally { if (active) timer = setTimeout(() => void load(), 15_000); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [id]);
  useEffect(() => {
    setSafety(null); setFundingError('');
    if (!id || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const v = await executionApi<ExecutionSafety>(`/${id}/safety`); if (active) { setSafety(v); setFundingError(''); } }
      catch (e) { if (active) { setSafety(null); setFundingError(e instanceof Error ? e.message : 'Funding check unavailable.'); } }
      finally { if (active) timer = setTimeout(() => void load(), 15_000); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [id, record?.revision, busy]);
  useEffect(() => {
    if (!record || record.intent.id !== id || busy || (!isPending(record) && record.status !== 'SIMULATING')) return;
    let active = true;
    const timer = setTimeout(() => void executionApi<ExecutionView>(`/${record.intent.id}`).then(r => { if (active) { setRecord(r); setError(''); } }).catch(e => { if (active) { setError(e.message); setRecord(r => r ? { ...r, pollAfterMs: Math.min(60_000, r.pollAfterMs * 2) } : r); } }), record.pollAfterMs);
    return () => { active = false; clearTimeout(timer); };
  }, [record, busy, id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function action(kind: 'simulate' | 'execute' | 'approval' | 'refresh' | 'recover') {
    if (!record || lock.current) return;
    if ((kind === 'execute' || kind === 'recover') && !account) { onConnect(); return; }
    lock.current = true; setBusy(kind); setError('');
    try {
      if (kind === 'refresh') setRecord(await executionApi<ExecutionView>(`/${record.intent.id}`));
      else {
        if (kind === 'execute') {
          const latest = await executionApi<ExecutionSafety>(`/${record.intent.id}/safety`);
          setSafety(latest);
          if (!latest.readyToExecute) throw new Error(latest.issues.map(i => i.message).join(' ') || 'Executor funding or demo limits block this intent.');
        }
        const body = kind === 'execute' || kind === 'recover' ? { signature: await signIntent(record, account!), ...(kind === 'recover' ? { executionId: recoveryId } : {}) } : {};
        const next = await executionApi<ExecutionView>(`/${record.intent.id}/${kind}`, body);
        if (kind === 'approval') navigate(`/app/executions/${next.intent.id}`); else setRecord(next);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed. Refresh the record before retrying.'); }
    finally { lock.current = false; setBusy(''); }
  }
  if (!id) return <section className="inner-page execution-page">
    <span className="eyebrow">KEEPERHUB EXECUTION</span><h1>Every intent. An open record.</h1><p className="page-lead">Agents decide. KeeperHub executes. dreamDEX settles.</p>
    <div className="keeper-connection"><ShieldCheck/><div><strong>{health?.ready ? 'KeeperHub ready on Shannon' : 'Execution prerequisites'}</strong>{health?.issues.map((i, n) => <p key={n}>{i.message}</p>)}{!health && !error ? <p>Checking connectivity…</p> : null}<small>Testnet 50312 · Existing models use quantitative rules · Only real records appear below.</small></div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <FundingCard funding={overview?.funding || null} limits={overview?.limits || null} error={fundingError}/>
    {!history.length ? <div className="execution-empty"><h2>No execution intents yet.</h2><p>Select a live market in Arena and choose Prepare execution.</p><Link className="button primary" to="/app">Open Arena</Link></div> : <div className="execution-history">{history.map(r => <Link key={r.intent.id} to={`/app/executions/${r.intent.id}`}><div><strong>{r.intent.kind === 'APPROVAL' ? 'Collateral approval' : `Buy ${r.intent.side}`} · {r.intent.marketSymbol}</strong><small>{new Date(r.intent.createdAt).toLocaleString()}</small></div><span>{r.status}</span><code>{r.intent.intentHash.slice(0, 14)}…</code></Link>)}</div>}
  </section>;
  if (!record || record.intent.id !== id) return <section className="inner-page"><p role="status">{error || 'Loading frozen execution…'}</p><Link to="/app/executions">Back to execution history</Link></section>;
  const i = record.intent, raw = (value: string) => formatUnits(BigInt(value), i.collateralDecimals);
  const stale = now >= i.expiresAt && !record.broadcastAttemptedAt;
  const pending = isPending(record), terminal = record.status === 'SUCCESS' || record.status === 'FAILED';
  const canOperate = account?.toLowerCase() === i.operatorAddress.toLowerCase();
  const safeToSign = safety?.readyToExecute === true && now - safety.checkedAt < 30_000;
  return <section className="inner-page execution-page">
    <Link className="text-link" to="/app/executions"><ArrowLeft size={16}/> Execution history</Link>
    <div className="execution-heading"><div><span className="eyebrow">{i.kind === 'APPROVAL' ? 'BOUNDED COLLATERAL APPROVAL' : 'FROZEN EXECUTION INTENT'}</span><h1>{i.kind === 'APPROVAL' ? 'Approve exact collateral.' : `Buy ${i.side}. Exactly as reviewed.`}</h1><p>{i.marketTitle}</p></div><span className={`execution-state ${record.status.toLowerCase()}`} role="status">{stale ? 'STALE' : record.status.replaceAll('_', ' ')}</span></div>
    <div className="execution-boundary"><span>Recommendation · {i.recommendationSource === 'manual' ? 'Manual selection' : 'Quantitative model'}</span><strong>Intent · Frozen</strong><span>KeeperHub · Execution</span><span>dreamDEX · Settlement</span></div>
    <div className="execution-columns"><div>
      <article className="execution-card"><h2>Review the exact instruction</h2><dl className="execution-facts">
        <div><dt>Network / protocol</dt><dd>Somnia Shannon (50312) / dreamDEX</dd></div>
        <div><dt>Outcome</dt><dd>BUY {i.side} · IOC order</dd></div><div><dt>Maximum collateral</dt><dd>{raw(i.estimatedSpend)} tUSDC</dd></div>
        <div><dt>Quantity</dt><dd>{raw(i.quantity)} shares</dd></div><div><dt>Protective limit</dt><dd>{raw(i.limitPrice)} tUSDC / share</dd></div>
        <div><dt>Expiry</dt><dd>{new Date(i.expiresAt).toLocaleString()} · {Math.max(0, Math.ceil((i.expiresAt - now) / 1000))}s remaining</dd></div>
        <div><dt>Executing KeeperHub wallet</dt><dd><code>{i.walletAddress}</code></dd></div><div><dt>Authorizing operator</dt><dd><code>{i.operatorAddress}</code></dd></div>
        <div><dt>Market pool</dt><dd><code>{i.poolAddress}</code></dd></div><div><dt>Collateral / decimals</dt><dd><code>{i.collateralToken}</code> / {i.collateralDecimals}</dd></div>
        <div><dt>Intent hash</dt><dd><code>{i.intentHash}</code></dd></div>
      </dl><p className="quiet-note">This hash verifies payload integrity. Your separate wallet signature authorizes execution. An IOC order can partially fill or buy no position.</p></article>
      {i.recommendation ? <article className="execution-card"><h2>Recorded recommendation</h2><p>{i.recommendation.agentId} · {i.recommendation.action} · {(i.recommendation.probabilityYes * 100).toFixed(1)}% YES</p><ul>{i.recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><small>Model {i.recommendation.version} · {new Date(i.recommendation.at).toLocaleString()}</small></article> : null}
      <details className="execution-card"><summary>Frozen payload and technical details</summary><pre>{JSON.stringify(i, null, 2)}</pre><h3>Authorization message</h3><pre>{record.authorizationMessage}</pre></details>
      <article className="execution-card"><h2>Audit timeline</h2><ol className="execution-timeline">{record.timeline.map((e, n) => <li key={`${e.at}-${n}`}><span>{new Date(e.at).toLocaleTimeString()}</span><div><strong>{e.event}</strong><p>{e.detail}</p></div></li>)}</ol></article>
    </div><aside>
      <FundingCard funding={safety?.funding || null} limits={safety?.limits || null} error={fundingError}/>
      <article className="execution-card execution-controls"><h2>{record.proof ? 'Execution proof' : 'Preflight & execution'}</h2>
        {record.preflight ? <div className={record.preflight.passed ? 'form-success' : 'form-error'}><strong>{record.preflight.passed ? 'KeeperHub simulation passed' : 'Execution blocked'}</strong><ul>{record.preflight.checks.map(c => <li key={c}>{c}</li>)}</ul>{record.preflight.simulation ? <small>Gas estimate: {record.preflight.simulation.gasEstimate} · {new Date(record.preflight.at).toLocaleTimeString()}</small> : null}</div> : <p>Run a real KeeperHub dry run before authorizing this payload.</p>}
        {record.failure ? <p className="form-error" role="alert">{record.failure.code}: {record.failure.message}</p> : null}
        {stale ? <p className="form-error">This intent expired. Its parameters will not be changed. Return to Arena to create a new intent.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {!record.broadcastAttemptedAt && !terminal && !stale ? <>
          <button className="button outline full" disabled={!!busy || pending} onClick={() => void action('simulate')}>{busy === 'simulate' || busy === 'execute' ? 'Checking frozen payload…' : 'Run KeeperHub dry run'}</button>
          {record.failure?.code === 'ALLOWANCE_REQUIRED' && i.kind === 'TRADE' ? <button className="button outline full" disabled={!!busy} onClick={() => void action('approval')}>Review bounded approval</button> : null}
          <label className="execution-consent"><input type="checkbox" checked={accepted} disabled={!!busy || pending} onChange={e => setAccepted(e.target.checked)}/><span>I reviewed the wallet, amount, side and expiry. Execute this exact intent once.</span></label>
          {!account ? <button className="button dark full" onClick={onConnect}>Connect operator wallet</button> : !canOperate ? <p className="form-error">Connect the authorizing operator shown above.</p> : null}
          {safety?.issues.filter(issue => !safety.funding?.issues.some(f => f.code === issue.code) && !safety.limits?.issues.some(f => f.code === issue.code)).map(issue => <p key={issue.code} className="form-error">{issue.message}</p>)}
          <button className="button primary full" disabled={!!busy || !accepted || !canOperate || record.status !== 'READY' || !safeToSign} onClick={() => void action('execute')}>{busy === 'execute' ? 'Authorizing / executing…' : i.kind === 'APPROVAL' ? 'Approve collateral with KeeperHub' : 'Execute with KeeperHub'}</button>
        </> : null}
        {record.broadcastAttemptedAt && !record.keeperHubExecutionId && pending ? <><p>Recover the real ID from the KeeperHub audit log. Recovery only verifies an existing transaction.</p><label>KeeperHub execution ID<input value={recoveryId} onChange={e => setRecoveryId(e.target.value)}/></label><button className="button outline full" disabled={!!busy || !canOperate || !recoveryId} onClick={() => void action('recover')}>Verify and recover ID</button></> : null}
        <button className="button outline full" disabled={!!busy} onClick={() => void action('refresh')}><RefreshCw size={15}/> Refresh status</button>
        {record.keeperHubExecutionId ? <p>KeeperHub execution ID<br/><code>{record.keeperHubExecutionId}</code><br/>Status: {record.keeperHubStatus}</p> : null}
        {record.txHash ? <a className="text-link" href={getExplorerTxUrl(record.txHash)} target="_blank" rel="noopener noreferrer">View transaction <ExternalLink size={14}/></a> : null}
        {record.proof ? <div className="execution-proof"><ShieldCheck/><strong>{record.proof.orderStatus.replaceAll('_',' ')}</strong><p>Independently verified onchain</p><dl><dt>Order ID</dt><dd>{record.proof.orderId || 'Collateral approval'}</dd><dt>Filled quantity</dt><dd>{raw(record.proof.filledQuantity)}</dd><dt>Collateral sent (gross)</dt><dd>{raw(record.proof.collateralMoved)} tUSDC</dd></dl><small>Block {record.proof.blockNumber} · {new Date(record.proof.confirmedAt).toLocaleString()}</small></div> : null}
        {i.parentIntentId ? <Link className="button primary full" to={`/app/executions/${i.parentIntentId}`}>Return to frozen trade</Link> : <Link className="text-link" to="/app">Create new intent in Arena</Link>}
      </article>
    </aside></div>
  </section>;
}
