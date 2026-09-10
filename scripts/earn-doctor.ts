import 'dotenv/config';
import { formatEther, formatUnits } from 'viem';
import { AAVE, EARN_CHAIN, earnAssetFor } from '../shared/earn';
import { EarnService } from '../server/earn-service';
import { liveEarnProtocol } from '../server/earn-protocol';
import { KeeperClient, keeperConfig } from '../server/keeperhub';
import type { EarnStore } from '../server/earn-store';

// No database, signatures, billing mutations or chain writes. This does NOT
// report durable budget usage: the running app reads that from its database.
const noStore: EarnStore = { list: async () => [], get: async () => null, insert: async () => { throw new Error('read-only'); }, save: async () => { throw new Error('read-only'); } };
const keeper = new KeeperClient(keeperConfig()), service = new EarnService(noStore,keeper,liveEarnProtocol());
try {
  const result = await service.overview(), s = result.snapshot;
  let keeperRead: unknown = null;
  if (result.authenticated) keeperRead = (await keeper.simulate({ chainId: EARN_CHAIN, contractAddress: AAVE.provider, functionName: 'getPool', functionArgs: '[]', abi: JSON.stringify([{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address', name: '' }] }]), value: '0' })).body;
  const funded = s !== null && BigInt(s.gasBalance) >= BigInt(s.gasPrice) * 1_000_000n && BigInt(s.tokenBalance) >= 10n ** BigInt(s.decimals) / 2n;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, chainId: EARN_CHAIN, connectionReady: result.authenticated, freeTierConfirmed: result.freeTierConfirmed, fundingReadyForHalfToken: funded, executor: result.walletAddress, balances: s ? { sepoliaETH: formatEther(BigInt(s.gasBalance)), asset: earnAssetFor(s.token).symbol, testToken: formatUnits(BigInt(s.tokenBalance),s.decimals), aToken: formatUnits(BigInt(s.aTokenBalance),s.decimals) } : null, snapshot: s, keeperRead, issues: result.issues, note: 'Read-only contract response is not a successful supply simulation or execution. No free-quota guarantee; verify billing before enabling writes. Durable budget is available only in the app.' },null,2));
  process.exitCode = result.authenticated && funded && result.freeTierConfirmed ? 0 : 1;
} catch { console.error('Earn doctor failed. Check server configuration and network access. No transaction submitted.'); process.exitCode = 1; }
