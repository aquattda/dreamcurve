export type Mode = 'live' | 'demo';
export type Side = 'YES' | 'NO';
export type AgentId = 'probability' | 'momentum' | 'flow' | 'meta';
export type Level = { price: number; size: number };
export type Market = {
  id: string; title: string; asset: string; pool: string; venueId: string;
  expiry: number; interval: number; status: string; strike: number | null;
  spot: number | null; updatedAt: number; source: Mode;
  yesBids: Level[]; yesAsks: Level[]; noBids: Level[]; noAsks: Level[];
  priceDecimals: number; collateralDecimals: number; tick: string; lot: string;
  collateral: string; yesId: string; noId: string;
};
export type Snapshot = { at: number; spot: number | null; probability: number | null };
export type Forecast = {
  id: string; marketId: string; agentId: AgentId; at: number; probabilityYes: number;
  action: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE'; confidence: 'Low' | 'Medium';
  edge: number | null; price: number | null; reasons: string[];
  version: string; canonical: boolean;
};
export type ScoreRow = { agentId: AgentId; count: number; brier: number | null; hitRate: number | null; paperPnl: number; traded: number };
export type Proof = { marketId: string; title: string; at: number; outcome: number; agentId: AgentId; probability: number; brier: number; pnl: number; digest: string };
export type ArenaState = { mode: Mode; status: 'healthy' | 'degraded' | 'connecting'; message: string; updatedAt: number; markets: Market[]; forecasts: Forecast[]; histories: Record<string, Snapshot[]>; scores: ScoreRow[]; proofs: Proof[] };
export const AGENTS: { id: AgentId; name: string; role: string; initial: string; description: string; color: string }[] = [
  { id: 'probability', name: 'Atlas', role: 'Probability', initial: 'A', color: 'lime', description: 'Distance to strike, volatility and time. A measured view of what comes next.' },
  { id: 'momentum', name: 'Flux', role: 'Momentum', initial: 'F', color: 'violet', description: 'Follows short-term price changes and looks for a move with staying power.' },
  { id: 'flow', name: 'Echo', role: 'Order flow', initial: 'E', color: 'blue', description: 'Reads the depth of the book to see where buying and selling pressure meet.' },
  { id: 'meta', name: 'Nexus', role: 'Ensemble', initial: 'N', color: 'peach', description: 'Combines three perspectives into one transparent, equal-weight forecast.' },
];
export const clamp = (n: number, lo = 0.01, hi = 0.99) => Math.min(hi, Math.max(lo, n));
export const midpoint = (m: Market) => m.yesBids[0] && m.yesAsks[0] ? (m.yesBids[0].price + m.yesAsks[0].price) / 2 : null;
export const isFresh = (m: Market, now = Date.now()) => now - m.updatedAt < 15_000 && now >= m.updatedAt - 5_000;
export const headroom = (m: Market) => Math.min(60, Math.max(10, m.interval * 0.1)) * 1000;
export function blockReason(m: Market, now = Date.now()): string | null {
  if (m.status !== 'Trading') return 'This market is not accepting orders.';
  if (!isFresh(m, now)) return 'Market data is stale. Wait for a fresh quote.';
  if (m.expiry - now <= headroom(m)) return 'Too close to expiry to submit safely.';
  return null;
}
export function brier(p: number, outcome: number) {
  if (!Number.isFinite(p) || p < 0 || p > 1 || ![0, 1].includes(outcome)) throw new Error('Invalid score input');
  return (p - outcome) ** 2;
}
export function paperPnl(f: Forecast, outcome: number) {
  if (f.action === 'NO_TRADE' || f.price === null) return 0;
  return (f.action === 'BUY_YES' ? outcome : 1 - outcome) - f.price;
}
export function generateForecasts(m: Market, history: Snapshot[], now = Date.now()): Forecast[] {
  const prices = history.filter(s => s.spot !== null && s.at <= now).slice(-120);
  const returns = prices.slice(1).map((p, i) => Math.log(p.spot! / prices[i].spot!));
  const variance = returns.length > 1 ? returns.reduce((a, r) => a + r * r, 0) / returns.length : 0;
  const step = prices.length > 1 ? (prices.at(-1)!.at - prices[0].at) / (prices.length - 1) / 1000 : 5;
  const sigma = Math.sqrt(variance / Math.max(1, step));
  const ready = prices.length >= 12 && m.spot !== null && m.strike !== null && m.strike > 0 && sigma > 0;
  const time = Math.max(1, (m.expiry - now) / 1000);
  const z = ready ? Math.log(m.spot! / m.strike!) / (sigma * Math.sqrt(time)) : 0;
  const probability = ready ? clamp(1 / (1 + Math.exp(-1.702 * z))) : 0.5;
  const recent = ready ? Math.log(prices.at(-1)!.spot! / prices[Math.max(0, prices.length - 12)].spot!) : 0;
  const momentum = ready ? clamp(probability + 0.12 * Math.tanh(recent / (sigma * Math.sqrt(Math.max(step * 12, 1))))) : 0.5;
  const bidDepth = m.yesBids.slice(0, 5).reduce((a, b) => a + b.size, 0);
  const askDepth = m.yesAsks.slice(0, 5).reduce((a, b) => a + b.size, 0);
  const bookReady = bidDepth > 0 && askDepth > 0 && midpoint(m) !== null;
  const imbalance = (bidDepth - askDepth) / Math.max(1, bidDepth + askDepth);
  const flow = bookReady ? clamp(midpoint(m)! + imbalance * 0.08) : 0.5;
  const values = [probability, momentum, flow, (probability + momentum + flow) / 3];
  return AGENTS.map((agent, index) => {
    const p = values[index];
    const sufficient = index === 2 ? bookReady : index === 3 ? ready && bookReady : ready;
    const yesAsk = m.yesAsks[0]?.price;
    const noAsk = m.noAsks[0]?.price;
    const yesEdge = yesAsk === undefined ? -Infinity : p - yesAsk;
    const noEdge = noAsk === undefined ? -Infinity : 1 - p - noAsk;
    const chooseYes = yesEdge >= noEdge;
    const edge = Math.max(yesEdge, noEdge);
    const blocked = blockReason(m, now);
    // Executable asks already include the spread. Reserve an additional 3pp for model uncertainty.
    const take = sufficient && !blocked && edge >= 0.03;
    const explanations = [
      [`${prices.length} observed price samples`, ready ? `Distance-to-strike score: ${z.toFixed(2)}` : 'Warming up: need 12 spot samples and non-zero volatility', 'Log-return model; short-horizon estimate, not a calibrated probability'],
      [`Recent log-return: ${(recent * 100).toFixed(3)}%`, 'Momentum adjustment capped at 12 percentage points', ready ? 'Uses observed spot movement' : 'Waiting for enough spot history'],
      [`Top-five YES book imbalance: ${(imbalance * 100).toFixed(1)}%`, 'Order flow adjustment capped at 8 percentage points', bookReady ? 'Two-sided YES book available' : 'Waiting for a two-sided order book'],
      ['Equal weights: Atlas, Flux and Echo', 'Model version v1: weights are fixed', ready && bookReady ? 'All three models have inputs' : 'Waiting for every model to have sufficient inputs'],
    ];
    return { id: `${m.id}:${agent.id}:${now}`, marketId: m.id, agentId: agent.id, at: now, probabilityYes: p,
      action: take ? chooseYes ? 'BUY_YES' : 'BUY_NO' : 'NO_TRADE', confidence: sufficient ? 'Medium' : 'Low',
      edge: Number.isFinite(edge) ? edge : null, price: take ? chooseYes ? yesAsk! : noAsk! : null,
      reasons: blocked ? [blocked, ...explanations[index]] : explanations[index], version: 'v1-equal-weight', canonical: false };
  });
}
// Exact decimal conversion for transaction inputs. Never pass a float to a raw SDK write.
export function decimalRaw(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimal input');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function quantizeDown(raw: bigint, grid: bigint) {
  if (raw < 0n || grid <= 0n) throw new Error('Invalid tick or lot');
  return raw / grid * grid;
}
