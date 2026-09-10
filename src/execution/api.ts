import type { Address, Hex } from 'viem';
import type { ExecutionRecord } from '../../shared/execution';

export type ExecutionView = ExecutionRecord & { authorizationMessage: string };
export type KeeperHealth = { ready: boolean; chainSupported: boolean; authenticated: boolean; walletAddress: string | null; operatorAddresses: string[]; maxTrade: string; maxSession: string; checkedAt: number; issues: { code: string; message: string }[] };
export async function executionApi<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/executions${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Execution request failed.');
  return result as T;
}
export async function signIntent(record: ExecutionView, account: Address): Promise<Hex> {
  if (!window.ethereum) throw new Error('Connect your authorized operator wallet.');
  const { createWalletClient, custom } = await import('viem');
  const { somniaShannon } = await import('@somnia-chain/markets-sdk/chains');
  const provider = window.ethereum;
  const [accounts, chain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
  if (chain !== '0xc488' || accounts[0]?.toLowerCase() !== account.toLowerCase() || account.toLowerCase() !== record.intent.operatorAddress.toLowerCase()) throw new Error('Reconnect the authorized operator wallet on Shannon before confirming.');
  const { authorizationMessage, verifyIntent } = await import('../../shared/execution');
  verifyIntent(record.intent);
  const message = authorizationMessage(record.intent);
  if (message !== record.authorizationMessage) throw new Error('Authorization message does not match the frozen intent.');
  return createWalletClient({ account, chain: somniaShannon, transport: custom(provider) }).signMessage({ message });
}
