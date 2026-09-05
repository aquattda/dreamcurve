import { makeExchange, chainClient, publicConfig, readMarket } from '../server/protocol';
const timeout = setTimeout(() => { console.error('Doctor deadline exceeded (45 seconds). No transactions were sent.'); process.exit(1); }, 45_000);
try {
  const sdk = makeExchange(AbortSignal.timeout(15_000));
  const results = await Promise.allSettled([chainClient.getChainId(), chainClient.getBlockNumber(), sdk.client.listBinaryMarkets({limit: 30})]);
  results.forEach((r, i) => console.log(['chainId', 'block', 'market discovery'][i], r.status === 'fulfilled' ? typeof r.value === 'object' ? `${(r.value as unknown[]).length} rows` : String(r.value) : String(r.reason)));
  console.log('Public configuration:', publicConfig);
  const rows = results[2];
  if (rows.status === 'fulfilled' && Array.isArray(rows.value)) {
    const active = rows.value.find(m => Number(m.expiry) * 1000 > Date.now() && Number(m.tradingStart) * 1000 <= Date.now());
    console.log('Active market:', active || 'No active markets in latest 30.');
    if (active) console.log('On-chain normalized market:', await readMarket(active));
  }
  process.exitCode = results.some(r => r.status === 'rejected') ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; }
clearTimeout(timeout);
process.exit(process.exitCode || 0);
