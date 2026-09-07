import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import type { BinaryMarket } from '@somnia-chain/markets-sdk';
import { formatTime, getExplorerAddressUrl } from './format';

export function HistoricalMarket({ id, account }: { id: string; account: Address | null }) {
  const [result, setResult] = useState<{ id: string; market?: BinaryMarket; error?: string }>();
  useEffect(() => {
    let active = true;
    if (!account) return;
    void import('../wallet').then(({ sdkFor }) => sdkFor(account).sdk.client.getMarket(id)).then(market => {
      if (active) setResult(market?.marketType === 'BINARY' ? { id, market } : { id, error: 'This market was not found in the indexer.' });
    }).catch(() => { if (active) setResult({ id, error: 'Market details are temporarily unavailable.' }); });
    return () => { active = false; };
  }, [id, account]);
  const current = result?.id === id ? result : undefined;
  const market = current?.market;
  return <section className="inner-page pf-page"><span className="eyebrow">MARKET RECORD · READ ONLY</span>
    <h1>{market?.question ?? 'Historical market'}</h1>
    {!account ? <p>Connect your wallet using the header to read this market record.</p> : !current ? <p role="status">Loading market details…</p> : current.error ? <p role="alert">{current.error}</p> : null}
    {market ? <article className="pf-position"><div className="pf-card-head"><strong>{market.asset}</strong><span className="pf-badge">{market.winningOutcome != null ? `RESOLVED ${market.winningOutcome === 0 ? 'YES' : 'NO'}` : market.voided ? 'VOIDED' : Number(market.expiry) * 1000 <= Date.now() ? 'TRADING CLOSED' : market.status.toUpperCase()}</span></div><p>Trading ends: {formatTime(Number(market.expiry) * 1000)}</p><p>Resolved: {market.resolvedAtTimestamp ? formatTime(Number(market.resolvedAtTimestamp) * 1000) : '--'}</p><a className="pf-link" href={getExplorerAddressUrl(market.marketAddress)} target="_blank" rel="noopener noreferrer">View market contract ↗</a></article> : null}
    <p className="pf-note">This exact market is not in the current Arena feed. Trading is disabled here; a different live window will never be substituted silently.</p><div className="pf-actions"><Link className="button outline" to="/app/portfolio">Back to Portfolio</Link><Link className="pf-link" to="/app">Browse live windows →</Link></div>
  </section>;
}
