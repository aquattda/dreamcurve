import type { Address } from 'viem';
import { earnAuthorization, freshEarn, verifyEarn, type EarnRecord } from '../../shared/earn';

export type EarnView = EarnRecord & { authorizationMessage: string };
export async function earnApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/earn${path}`,{ method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Earn request failed.');
  return result;
}
export async function connectEarnWallet(): Promise<Address> {
  const provider = window.ethereum;
  if (!provider) throw new Error('Install MetaMask or an EVM browser wallet.');
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] }); }
  catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xaa36a7', chainName: 'Ethereum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Wallet did not provide an account.');
  return accounts[0];
}
export async function signEarn(r: EarnView, account: Address, recovery = false) {
  const provider = window.ethereum;
  if (!provider) throw new Error('Connect the authorized operator wallet.');
  const [accounts,chain] = await Promise.all([provider.request({ method: 'eth_accounts' }),provider.request({ method: 'eth_chainId' })]);
  if (chain !== '0xaa36a7' || accounts[0]?.toLowerCase() !== account.toLowerCase() || account.toLowerCase() !== r.intent.operatorAddress.toLowerCase()) throw new Error('Reconnect the authorized operator on Ethereum Sepolia.');
  verifyEarn(r.intent); if (!recovery) freshEarn(r.intent);
  const message = earnAuthorization(r.intent);
  if (message !== r.authorizationMessage) throw new Error('Earn authorization differs from the reviewed intent.');
  const { createWalletClient, custom } = await import('viem');
  const { sepolia } = await import('viem/chains');
  return createWalletClient({ account, chain: sepolia, transport: custom(provider) }).signMessage({ message });
}
