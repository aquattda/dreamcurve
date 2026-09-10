import { isAddress, type Address } from 'viem';
import { ExecutionError, type ContractExecutionPayload, type Failure, type FailureCode } from '../shared/execution';
import { keeperLimits } from './execution-limits';

type JsonObject = Record<string, unknown>;
// The official direct route returns an executionId for every accepted write.
// These HTTP rejections without an ID/hash are pre-broadcast guards.
export class KeeperRejection extends ExecutionError {}
export function object(value: unknown): JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
export function safeText(value: unknown): string {
  return (typeof value === 'string' ? value : 'KeeperHub request failed.').replace(/kh_[\w-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}
export function normalizeKeeperError(body: unknown, status = 502): Failure {
  const b = object(body);
  const map: Record<string, FailureCode> = { insufficient_balance: 'INSUFFICIENT_BALANCE', insufficient_scope: 'UNAUTHORIZED', invalid_input: 'INVALID_INPUT', network_unsupported: 'NETWORK_UNSUPPORTED', unsupported_chain: 'NETWORK_UNSUPPORTED', idempotency_in_progress: 'EXECUTION_UNCERTAIN', idempotency_conflict: 'INTENT_CHANGED' };
  const code = typeof b.code === 'string' ? map[b.code] : undefined;
  return { code: code ?? (b.failureKind === 'unavailable' ? 'SIMULATOR_UNAVAILABLE' : b.failureKind === 'revert' && b.wouldRevert === true ? 'CONTRACT_REVERT' : status === 401 || status === 403 ? 'UNAUTHORIZED' : status === 400 ? 'INVALID_INPUT' : 'KEEPERHUB_ERROR'), message: safeText(b.error ?? b.revertReason ?? b.message) };
}
export type KeeperConfig = { baseUrl: string; apiKey: string; wallet: Address | null; operators: Address[]; domain: string; eoaConfirmed: boolean };
export function keeperConfig(): KeeperConfig {
  keeperLimits();
  const raw = process.env.KEEPERHUB_WALLET_ADDRESS || '';
  const baseUrl = (process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com').replace(/\/$/, '');
  const url = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('KeeperHub URL must use HTTPS (HTTP allowed only for local self-hosting).');
  return { baseUrl, apiKey: process.env.KEEPERHUB_API_KEY || '', wallet: isAddress(raw) ? raw : null,
    operators: (process.env.KEEPERHUB_OPERATOR_ADDRESSES || '').split(',').map(x => x.trim()).filter((x): x is Address => isAddress(x)),
    domain: process.env.KEEPERHUB_AUTHORIZATION_DOMAIN || 'dreamcurve.local', eoaConfirmed: process.env.KEEPERHUB_SIGNER_MODE === 'eoa' };
}
export type KeeperResponse = { body: JsonObject; pollAfterMs: number };
export class KeeperClient {
  constructor(readonly config: KeeperConfig, private fetcher: typeof fetch = fetch) {}
  async request(path: string, body?: unknown, key?: string): Promise<KeeperResponse> {
    if (!this.config.apiKey && path !== '/api/chains') throw new ExecutionError('CONFIGURATION_REQUIRED', 'Configure the server-side KeeperHub API key.');
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Accept: 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(body === undefined ? 20_000 : 90_000) });
    } catch { throw new ExecutionError(key ? 'EXECUTION_UNCERTAIN' : 'SIMULATOR_UNAVAILABLE', key ? 'KeeperHub response was interrupted. Execution may have started; do not submit a new trade. Reconcile the KeeperHub audit record.' : 'KeeperHub could not be reached. No execution was requested.'); }
    let result: unknown;
    try { result = await response.json(); } catch { throw new ExecutionError(key ? 'EXECUTION_UNCERTAIN' : 'KEEPERHUB_ERROR', 'KeeperHub returned an unreadable response.'); }
    if (!response.ok) {
      const failure = normalizeKeeperError(result, response.status);
      // Keep IDs/hashes in write responses even when HTTP status reports failure.
      if (key && (typeof object(result).executionId === 'string' || typeof object(result).transactionHash === 'string')) return { body: object(result), pollAfterMs: 5000 };
      if (key && [400,401,403,404,429].includes(response.status)) throw new KeeperRejection(failure.code, failure.message);
      throw new ExecutionError(failure.code, failure.message);
    }
    const hint = Number(response.headers.get('X-Poll-Interval-Hint'));
    const pollAfterMs = Number.isFinite(hint) && hint > 0 ? Math.min(60_000, Math.max(3000, hint * 1000)) : 5000;
    return { body: Array.isArray(result) ? { items: result } : object(result), pollAfterMs };
  }
  async chains() { return (await this.request('/api/chains')).body.items as unknown[] | undefined; }
  async assertChain() {
    const chains = await this.chains();
    if (!chains?.some(c => { const x = object(c); return x.chainId === 50312 && x.isEnabled === true && x.isTestnet === true && x.chainType === 'evm'; })) throw new ExecutionError('NETWORK_UNSUPPORTED', 'KeeperHub does not advertise enabled Somnia Shannon (50312). Configure a real KeeperHub endpoint with Shannon support.');
  }
  simulate(payload: ContractExecutionPayload) { return this.request('/api/execute/contract-call', { ...payload, simulate: true }); }
  execute(payload: ContractExecutionPayload, hash: string) { return this.request('/api/execute/contract-call', payload, `dreamcurve:${hash}`); }
  status(id: string) { return this.request(`/api/execute/${encodeURIComponent(id)}/status`); }
}
