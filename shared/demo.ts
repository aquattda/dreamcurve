import { AGENTS, generateForecasts, brier, paperPnl, type ArenaState, type Market, type Proof, type Snapshot } from './domain';
// Deliberately synthetic and isolated. Never persisted as live results or sent to a wallet.
export function demoState(now = Date.now()): ArenaState {
  const expiry = Math.floor(now / 900_000) * 900_000 + 900_000;
  const assets = ['BTC', 'ETH', 'BTC', 'ETH'];
  const markets: Market[] = assets.map((asset, i) => {
    const price = [0.61, 0.43, 0.53, 0.68][i];
    const strike = asset === 'BTC' ? 97400 + i * 100 : 3420 + i * 5;
    return { id: `demo-${i}`, title: `${asset} above $${strike.toLocaleString('en-US')}?`, asset, pool: '', venueId: 'illustration',
      expiry: expiry + (i > 1 ? 900_000 : 0), interval: 900, status: 'Trading', strike,
      spot: strike * (1 + (price - 0.5) * 0.003), updatedAt: now, source: 'demo',
      yesBids: [0, 1, 2, 3, 4].map(n => ({price: price - 0.02 - n * 0.01, size: 65 + n * 35})),
      yesAsks: [0, 1, 2, 3, 4].map(n => ({price: price + n * 0.01, size: 50 + n * 24})),
      noBids: [0, 1, 2].map(n => ({price: 1 - price - 0.02 - n * 0.01, size: 80 + n * 20})),
      noAsks: [0, 1, 2].map(n => ({price: 1 - price + 0.02 + n * 0.01, size: 60 + n * 30})),
      priceDecimals: 6, collateralDecimals: 6, tick: '10000', lot: '1000000', collateral: '', yesId: '', noId: '' };
  });
  const histories: Record<string, Snapshot[]> = Object.fromEntries(markets.map((m, i) => [m.id, Array.from({length: 80}, (_, j) => {
    const probability = Math.min(0.9, Math.max(0.1, m.yesAsks[0].price - (79 - j) * 0.0011 + Math.sin(j * 0.55 + i) * 0.025));
    return {
      at: now - (79 - j) * 5000,
      spot: m.spot! * (1 + Math.sin(j * 0.9 + i) * 0.00008 - (79 - j) * 0.000003),
      probability,
      yesPrice: Math.min(0.99, probability + 0.012),
      noPrice: Math.min(0.99, 1 - probability + 0.018),
    };
  })]));
  const forecasts = markets.flatMap(m => generateForecasts(m, histories[m.id], now));
  const proofs: Proof[] = Array.from({length: 24}, (_, i) => {
    const agent = AGENTS[i % 4]; const outcome = Math.floor(i / 4) % 2;
    const probability = Math.min(0.95, Math.max(0.05, (outcome ? 0.68 : 0.32) + Math.sin(i * 2) * 0.18));
    const f = { ...forecasts[i % 4], agentId: agent.id, probabilityYes: probability, price: 0.55, action: (probability >= 0.5 ? 'BUY_YES' : 'BUY_NO') as 'BUY_YES' | 'BUY_NO' };
    return { marketId: `illustration-${Math.floor(i / 4)}`, title: `${i % 2 ? 'ETH' : 'BTC'} · illustrated resolved window`, at: now - (Math.floor(i / 4) + 1) * 900_000, outcome, agentId: agent.id, probability, brier: brier(probability, outcome), pnl: paperPnl(f, outcome), digest: 'synthetic-example-not-chain-proof' };
  });
  const scores = AGENTS.map(a => { const rows = proofs.filter(p => p.agentId === a.id); return { agentId: a.id, count: rows.length, brier: rows.reduce((s, r) => s + r.brier, 0) / rows.length, hitRate: rows.filter(r => Number(r.probability >= 0.5) === r.outcome).length / rows.length, paperPnl: rows.reduce((s, r) => s + r.pnl, 0), traded: rows.length }; });
  return { mode: 'demo', status: 'healthy', message: 'Illustrative data. Predictions, prices and scores are synthetic. Wallet trading is disabled.', issue: null, retryable: false, updatedAt: now, lastSuccessfulAt: now, retryAt: null, markets, forecasts, histories, scores, proofs };
}
