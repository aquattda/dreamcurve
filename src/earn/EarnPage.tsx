import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatEther, formatUnits, type Address } from 'viem';
import { EARN_ASSETS, EARN_CHAIN, earnAmount, earnAssetFor, type EarnAction, type EarnOverview } from '../../shared/earn';
import { earnApi, signEarn, type EarnView } from './api';
import '../execution/execution.css';
import './earn.css';

const units = (n: string, decimals = 18) => formatUnits(BigInt(n),decimals);
type Safety = { ready: boolean; issues: { message: string }[]; checkedAt: number };
export default function EarnPage({ account, onConnect }: { account: Address | null; onConnect: () => void }) {
  const { id } = useParams(), navigate = useNavigate();
  const [overview,setOverview] = useState<EarnOverview | null>(null), [records,setRecords] = useState<EarnView[]>([]);
  const [record,setRecord] = useState<EarnView | null>(null), [safety,setSafety] = useState<Safety | null>(null);
  const [action,setAction] = useState<EarnAction>('SUPPLY'), [amount,setAmount] = useState('0.5');
  const [error,setError] = useState(''), [busy,setBusy] = useState(''), [reviewed,setReviewed] = useState(false), [recoveryId,setRecoveryId] = useState('');
  const [now,setNow] = useState(Date.now()), lock = useRef(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()),1000); return () => clearInterval(t); },[]);
  useEffect(() => { setRecord(null); setSafety(null); setReviewed(false); setError(''); },[id,account]);
  useEffect(() => {
    if (busy) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        if (id) {
          const [r,s] = await Promise.all([earnApi<EarnView>(`/intents/${id}`),earnApi<Safety>(`/intents/${id}/safety`)]);
          if (active) { setRecord(r); setSafety(s); }
        } else {
          const [o,rs] = await Promise.all([earnApi<EarnOverview>('/overview'),earnApi<EarnView[]>('/intents')]);
          if (active) { setOverview(o); setRecords(rs); }
        }
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : 'Earn check failed.'); setSafety(null); setOverview(null); } }
      finally { if (active) timer = setTimeout(() => void load(),15_000); }
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  },[id,busy,account]);
  async function run(kind: 'prepare' | 'simulate' | 'execute' | 'recover') {
    if (lock.current) return;
    lock.current = true; setBusy(kind); setError('');
    try {
      if (kind === 'prepare') {
        if (!account) throw new Error('Connect the authorized Sepolia operator first.');
        earnAmount(amount,18);
        const r = await earnApi<EarnView>('/intents',{ chainId: EARN_CHAIN, asset: 'LINK', action, amount, operatorAddress: account });
        navigate(`/app/earn/${r.intent.id}`);
      } else if (record && record.intent.id === id) {
        let body: unknown = {};
        if (kind === 'execute' || kind === 'recover') {
          if (!account || !reviewed) throw new Error('Connect your wallet and review the exact intent.');
          if (kind === 'execute') {
            const fresh = await earnApi<Safety>(`/intents/${id}/safety`); setSafety(fresh);
            if (!fresh.ready) throw new Error(fresh.issues.map(i => i.message).join(' '));
          }
          body = { signature: await signEarn(record,account,kind === 'recover'), ...(kind === 'recover' ? { executionId: recoveryId } : {}) };
        }
        setRecord(await earnApi<EarnView>(`/intents/${id}/${kind}`,body)); setReviewed(false);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Earn action failed.'); }
    finally { lock.current = false; setBusy(''); }
  }
  const r = record?.intent.id === id ? record : null, s = overview?.snapshot;
  const amountValid = (() => { try { earnAmount(amount,18); return true; } catch { return false; } })();
  const authorized = account && (id ? r?.intent.operatorAddress.toLowerCase() === account.toLowerCase() : overview?.operators.some(o => o.toLowerCase() === account.toLowerCase()));
  return <section className="inner-page execution-page earn-page">
    <span className="eyebrow">DREAMCURVE EARN · AAVE V3 · SEPOLIA TESTNET</span>
    <h1>{id ? 'One intent. Exact execution.' : 'Put control before execution.'}</h1>
    <p className="page-lead">Review a test-token supply or withdrawal. KeeperHub executes only the frozen call you authorize.</p>
    <div className="earn-notice">Testnet only · No borrowing or leverage · No mainnet funds · Manual decisions, not AI investment advice.</div>
    {error ? <p role="alert" className="execution-error">{error}</p> : null}
    <div className="execution-actions"><Link to="/app">DreamDEX Arena (Somnia)</Link>{id ? <Link to="/app/earn">Earn overview</Link> : null}<button onClick={onConnect} disabled={Boolean(busy)}>{account ? 'Reconnect on Sepolia' : 'Connect Sepolia operator'}</button></div>
    {!id ? <>
      <section className="execution-card"><h2>Live Aave position</h2>
        {!overview ? <p role="status">Checking KeeperHub and Aave…</p> : <>
          <p>KeeperHub connection: {overview.authenticated ? 'Verified' : 'Not ready'}</p>
          {overview.issues.map((i,n) => <p role="status" key={n}>{i.message}</p>)}
          <dl className="earn-grid"><div><dt>Executor (not your browser wallet)</dt><dd>{overview.walletAddress || 'Not configured'}</dd></div><div><dt>Network</dt><dd>Ethereum Sepolia · {EARN_CHAIN}</dd></div><div><dt>Sepolia ETH for gas</dt><dd>{s ? formatEther(BigInt(s.gasBalance)) : 'Unavailable'}</dd></div><div><dt>Aave test LINK available</dt><dd>{s ? units(s.tokenBalance,s.decimals) : 'Unavailable'}</dd></div><div><dt>Aave aLINK position</dt><dd>{s ? units(s.aTokenBalance,s.decimals) : 'Unavailable'}</dd></div><div><dt>Attempted supply / withdrawal budgets</dt><dd>{units(overview.usedSupply)} / 5 supplied · {units(overview.usedWithdraw)} / 5 withdrawn</dd></div><div><dt>Reserve status (test LINK)</dt><dd>{s ? `${s.active ? 'Active' : 'Inactive'} · ${s.paused ? 'Paused' : 'Not paused'} · ${s.frozen ? 'Frozen' : 'Not frozen'}` : 'Unavailable'}</dd></div><div><dt>Reserve supplied / cap</dt><dd>{s ? `${units(s.supplied,s.decimals)} / ${s.supplyCap === '0' ? 'No protocol cap' : s.supplyCap}` : 'Unavailable'}</dd></div><div><dt>KeeperHub free-tier confirmation</dt><dd>{overview.freeTierConfirmed ? 'Operator confirmed; monitor quota' : 'Not confirmed — writes locked'}</dd></div></dl>
          <p>Token: <a href={`https://sepolia.etherscan.io/address/${EARN_ASSETS.LINK.token}`} target="_blank" rel="noreferrer">{EARN_ASSETS.LINK.token}</a> · 18 decimals</p>
          <p>USDC is not the default: its Sepolia reserve exceeded its supply cap at the audit. Existing USDC intents keep their original asset.</p><p>Use free Sepolia ETH faucets and the Aave testnet faucet for this exact token. STT and tUSDC on Somnia cannot fund this module. <a href="https://aave.com/help/aave-101/accessing-aave" target="_blank" rel="noreferrer">Official Aave testnet information</a></p>
          {!overview.freeTierConfirmed ? <p>Check free quota and paid-overage settings in your KeeperHub account before the server operator enables Earn writes. The app never changes billing.</p> : null}
        </>}
      </section>
      <section className="execution-card"><h2>Prepare an exact action</h2><p>Maximum 1 test token per action; combined 5-token supply and withdrawal budgets are not USD valuations. Approve only the amount you intend to supply; approvals and supplies are separately reviewed and signed. Withdrawals do not reset supply limits.</p>
        <form onSubmit={e => { e.preventDefault(); void run('prepare'); }} className="earn-form">
          <label>Action<select value={action} onChange={e => setAction(e.target.value as EarnAction)} disabled={Boolean(busy)}><option value="SUPPLY">Supply to Aave</option><option value="APPROVAL">Approve exact supply amount</option><option value="WITHDRAW">Withdraw from Aave</option></select></label>
          <label>Amount (Aave test LINK)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={Boolean(busy)}/></label>
          <button className="button primary" disabled={Boolean(busy) || !authorized || !amountValid || !overview?.authenticated}>{busy === 'prepare' ? 'Freezing intent…' : 'Prepare Earn intent'}</button>
        </form>{account && !authorized ? <p role="status">This wallet is not an authorized KeeperHub operator.</p> : null}
      </section>
      <section className="execution-card"><h2>Earn execution history</h2>{records.length ? <ul>{records.map(v => <li key={v.intent.id}><Link to={`/app/earn/${v.intent.id}`}>{v.intent.action} {units(v.intent.amount,v.intent.decimals)} test {earnAssetFor(v.intent.token).symbol} · {v.status}</Link></li>)}</ul> : <p>No Earn intents yet. No transaction proof is fabricated.</p>}</section>
    </> : r ? <>
      <section className="execution-card"><h2>{r.intent.action} {units(r.intent.amount,r.intent.decimals)} test {earnAssetFor(r.intent.token).symbol}</h2><p role="status">Status: {r.status}{now >= r.intent.expiresAt && r.broadcastAttemptedAt === null ? ' · EXPIRED' : ''}</p>
        <dl className="earn-grid"><div><dt>Executor and beneficiary</dt><dd>{r.intent.walletAddress}</dd></div><div><dt>Aave Pool</dt><dd>{r.intent.pool}</dd></div><div><dt>Token</dt><dd>{r.intent.token}</dd></div><div><dt>Intent hash</dt><dd>{r.intent.intentHash}</dd></div><div><dt>Authorization expires</dt><dd>{new Date(r.intent.expiresAt).toLocaleString()}</dd></div><div><dt>Native value</dt><dd>0 ETH (gas paid separately in Sepolia ETH)</dd></div></dl>
        <p>Aave calls have no onchain deadline argument. Expiry blocks new submissions; a submitted transaction may confirm after expiry.</p>
        <details><summary>Exact frozen payload and authorization</summary><pre>{JSON.stringify(r.intent.payload,null,2)}</pre><pre>{r.authorizationMessage}</pre></details>
        {r.failure ? <p role="alert">{r.failure.code}: {r.failure.message}</p> : null}
        {safety?.issues.map((i,n) => <p key={n}>{i.message}</p>)}
        <label className="earn-review"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} disabled={Boolean(busy)}/>I reviewed the exact action, token, amount, executor, network and expiry.</label>
        <div className="execution-actions"><button onClick={() => void run('simulate')} disabled={Boolean(busy) || r.broadcastAttemptedAt !== null || now >= r.intent.expiresAt || r.status === 'SIMULATING'}>Run KeeperHub dry run</button><button className="button primary" onClick={() => void run('execute')} disabled={Boolean(busy) || !reviewed || !authorized || r.status !== 'READY' || !safety?.ready || now - safety.checkedAt > 30_000 || now >= r.intent.expiresAt}>Authorize & execute with KeeperHub</button></div>
        {busy ? <p role="status">{busy} in progress…</p> : null}
      </section>
      <section className="execution-card"><h2>Execution proof</h2><p>KeeperHub ID: {r.keeperHubExecutionId || 'Not available'}</p><p>Independent Aave proof: {r.proof?.verified ? 'Verified event and token movement' : 'Not verified'}</p>{r.txHash ? <a href={`https://sepolia.etherscan.io/tx/${r.txHash}`} target="_blank" rel="noreferrer">View Sepolia transaction</a> : <p>No transaction hash yet.</p>}
        {r.broadcastAttemptedAt !== null && !r.keeperHubExecutionId && r.status === 'CONFIRMING' ? <><label>Original KeeperHub execution ID<input value={recoveryId} onChange={e => setRecoveryId(e.target.value)}/></label><button disabled={Boolean(busy) || !reviewed || !authorized || !/^[\w-]{1,200}$/.test(recoveryId)} onClick={() => void run('recover')}>Verify & recover ID (no resend)</button></> : null}
        <ol>{r.timeline.map((e,n) => <li key={n}><time>{new Date(e.at).toLocaleTimeString()}</time> · {e.event}<p>{e.detail}</p></li>)}</ol>
      </section>
    </> : <p role="status">Loading frozen Earn intent…</p>}
  </section>;
}
