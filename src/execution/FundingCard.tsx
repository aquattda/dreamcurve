import type { ExecutionLimits, ExecutorFunding } from '../../shared/execution';

export function FundingCard({ funding, limits, error }: { funding: ExecutorFunding | null; limits: ExecutionLimits | null; error?: string }) {
  return <article className="execution-card" aria-label="Executor funding and limits">
    <h2>Executor funding & demo limits</h2>
    {funding ? <>
      <dl className="execution-facts">
        <div><dt>KeeperHub executor</dt><dd><code>{funding.executorAddress}</code></dd></div>
        <div><dt>Network</dt><dd>Somnia Shannon Testnet · 50312</dd></div>
        <div><dt>STT balance</dt><dd>{funding.gas.balance} STT</dd></div>
        <div><dt>Gas reserve required</dt><dd>{funding.gas.required} STT</dd></div>
        <div><dt>tUSDC balance</dt><dd>{funding.collateral.balance} tUSDC</dd></div>
        <div><dt>Verified collateral contract</dt><dd><code>{funding.collateral.tokenAddress}</code></dd></div>
        <div><dt>Funding status</dt><dd>{funding.readyToExecute ? 'Ready' : 'Funding Required / Market Unavailable'}</dd></div>
      </dl>
      {funding.issues.map(issue => <p className="form-error" key={issue.code}>{issue.message}</p>)}
      <small>Balance checked {new Date(funding.checkedAt).toLocaleTimeString()}. Gas reserve uses {funding.gas.estimateSource === 'simulation' ? 'the latest simulation estimate' : 'a conservative initial estimate'} with a 2× buffer.</small>
      {!funding.gas.sufficient || !funding.collateral.sufficient ? <p className="quiet-note">Fund the executor address above manually. Obtain STT from the <a href="https://testnet.somnia.network/" target="_blank" rel="noopener noreferrer">Shannon testnet faucet</a>. Use DreamCurve's test tUSDC faucet for the verified token, then send the test tokens from your browser wallet to this executor. Funding transactions require your explicit wallet confirmation.</p> : null}
    </> : <p role="status">{error || 'Checking executor balances against active market collateral…'}</p>}
    {limits ? <><dl className="execution-facts">
      <div><dt>Requested collateral budget</dt><dd>{limits.requested} tUSDC</dd></div>
      <div><dt>Maximum per trade</dt><dd>{limits.maxTrade} tUSDC</dd></div>
      <div><dt>Maximum demo budget</dt><dd>{limits.maxSession} tUSDC</dd></div>
      <div><dt>Reserved / attempted</dt><dd>{limits.usedSession} tUSDC</dd></div>
      <div><dt>Remaining demo budget</dt><dd>{limits.remainingSession} tUSDC</dd></div>
    </dl>{limits.issues.map(issue => <p className="form-error" key={issue.code}>{issue.message}</p>)}
      <small>The demo budget persists across page reloads and server restarts. Pending and attempted trade budgets remain counted; approvals are not counted twice.</small></> : null}
  </article>;
}
