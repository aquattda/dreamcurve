import 'dotenv/config';
import { KeeperClient, keeperConfig } from '../server/keeperhub';
import { chainClient, makeExchange } from '../server/protocol';
import { readExecutorFunding } from '../server/executor-funding';
import { keeperLimits } from '../server/execution-limits';
import type { ExecutorFunding } from '../shared/execution';

// Read-only diagnostic. Never signs, approves, simulates a write, or broadcasts.
const config = keeperConfig(), client = new KeeperClient(config);
let funding: ExecutorFunding | null = null;
const checks: { name: string; passed: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { checks.push({name,passed:true,detail:await fn()}); }
  catch (e) { checks.push({name,passed:false,detail:e instanceof Error?e.message:'Check failed'}); }
}
await check('KeeperHub Shannon registry', async () => { await client.assertChain(); return '50312 is an enabled EVM testnet'; });
await check('KeeperHub authenticated organization wallet', async () => {
  const {body} = await client.request('/api/user/wallet');
  if (!config.wallet || typeof body.walletAddress !== 'string' || body.walletAddress.toLowerCase() !== config.wallet.toLowerCase()) throw new Error('Configure KEEPERHUB_WALLET_ADDRESS to match the organization wallet.');
  return config.wallet;
});
await check('Authorized operator and signer mode', async () => {
  if (!config.operators.length || !config.eoaConfirmed) throw new Error('Configure operator addresses and verify KEEPERHUB_SIGNER_MODE=eoa. Safe routing is unsupported.');
  return `${config.operators.length} operator(s); explicit EOA mode; authorization domain ${config.domain}`;
});
await check('Shannon RPC', async () => { const id = await chainClient.getChainId(); if (id!==50312) throw new Error(`Unexpected chain ${id}`); return 'RPC chainId=50312'; });
await check('KeeperHub wallet testnet funding', async () => {
  if (!config.wallet) throw new Error('No executing wallet configured.');
  const sdk = makeExchange(AbortSignal.timeout(20_000));
  const rows = await sdk.client.listBinaryMarkets({ limit: 30 });
  const active = rows.find(m => Number(m.expiry) * 1000 > Date.now() && Number(m.tradingStart) * 1000 <= Date.now());
  if (!active) throw new Error('No active market found. Funding readiness cannot be verified against live collateral.');
  funding = await readExecutorFunding(config.wallet, active.marketId);
  if (!funding.readyToExecute) throw new Error(funding.issues.map(i => i.message).join(' '));
  return `STT=${funding.gas.balance}; tUSDC=${funding.collateral.balance}; token=${funding.collateral.tokenAddress}`;
});
const { maxTrade, maxSession } = keeperLimits();
console.log(JSON.stringify({checkedAt:new Date().toISOString(),readOnly:true,ready:checks.every(c=>c.passed),executorAddress:config.wallet,limits:{maxTrade,maxSession,scope:'executor-durable-demo'},funding,checks},null,2));
process.exitCode=checks.every(c=>c.passed)?0:1;
process.exit(process.exitCode);
