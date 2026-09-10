import { Router } from 'express';
import { isAddress, type Hex } from 'viem';
import type { ArenaState, AgentId } from '../shared/domain';
import { ExecutionError, authorizationMessage, type ExecutionRecord } from '../shared/execution';
import { KeeperClient, keeperConfig } from './keeperhub';
import { liveExecutionProtocol } from './execution-protocol';
import { ExecutionService } from './execution-service';
import type { ExecutionStore } from './execution-store';
import { keeperLimits, limitStatus } from './execution-limits';
import { readExecutorFunding } from './executor-funding';

function publicRecord(r: ExecutionRecord) { return { ...r, approvalSignature: null, authorizationMessage: authorizationMessage(r.intent) }; }
export function executionRoutes(store: ExecutionStore, arena: () => ArenaState) {
  const router = Router();
  const keeper = new KeeperClient(keeperConfig());
  const service = new ExecutionService(store, keeper, liveExecutionProtocol(keeper.config));
  const calls = new Map<string, { at: number; count: number }>();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: 'Cross-site execution requests are not allowed.' }); return; }
    const key = req.ip || 'unknown', now = Date.now();
    if (calls.size > 1000) for (const [k, v] of calls) if (now - v.at > 60_000) calls.delete(k);
    const old = calls.get(key), current = old && now - old.at < 60_000 ? old : { at: now, count: 0 };
    current.count++; calls.set(key, current);
    if (current.count > 40) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Execution request limit reached. Retry in one minute.' }); return; }
    next();
  });
  let cachedHealth: { at: number; data: unknown } | null = null;
  router.get('/health', async (_req, res) => {
    if (cachedHealth && Date.now() - cachedHealth.at < 30_000) { res.json(cachedHealth.data); return; }
    const config = keeper.config;
    const issues: { code: string; message: string }[] = [];
    try { service.configured(); } catch (e) { if (e instanceof ExecutionError) issues.push({ code: e.code, message: e.message }); }
    let chainSupported = false, authenticated = false;
    try { await keeper.assertChain(); chainSupported = true; } catch (e) { issues.push({ code: e instanceof ExecutionError ? e.code : 'KEEPERHUB_ERROR', message: e instanceof Error ? e.message : 'Chain registry unavailable.' }); }
    if (config.apiKey) {
      try {
        const { body } = await keeper.request('/api/user/wallet');
        authenticated = true;
        if (!config.wallet || typeof body.walletAddress !== 'string' || body.walletAddress.toLowerCase() !== config.wallet.toLowerCase()) issues.push({ code: 'CONFIGURATION_REQUIRED', message: 'Configured executing wallet differs from the KeeperHub organization wallet.' });
      } catch (e) { issues.push({ code: 'UNAUTHORIZED', message: e instanceof Error ? e.message : 'KeeperHub authentication failed.' }); }
    }
    const { maxTrade, maxSession } = keeperLimits();
    const data = { ready: issues.length === 0, chainId: 50312, chainSupported, authenticated, walletAddress: config.wallet, operatorAddresses: config.operators, maxTrade, maxSession, issues, checkedAt: Date.now() };
    cachedHealth = { at: Date.now(), data }; res.json(data);
  });
  router.get('/', async (_req, res) => res.json((await store.list()).map(publicRecord)));
  router.get('/funding', async (req, res) => {
    const wallet = keeper.config.wallet;
    if (!wallet) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Configure the KeeperHub executor wallet.');
    const market = arena().markets.find(m => m.source === 'live' && m.status === 'Trading' && m.expiry > Date.now() && (!req.query.marketId || m.id === req.query.marketId));
    if (!market) throw new ExecutionError('MARKET_CLOSED', 'No active live market is available to verify the exact collateral.');
    const [funding, used] = await Promise.all([readExecutorFunding(wallet, market.id as Hex), store.exposure(wallet)]);
    res.json({ funding, limits: limitStatus(keeperLimits().maxTrade, used) });
  });
  router.post('/prepare', async (req, res) => {
    if (req.body?.chainId !== undefined && req.body.chainId !== 50312) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Only Somnia Shannon chain 50312 is permitted.');
    const { marketId, side, stake, operatorAddress, agentId } = req.body || {};
    if (typeof marketId !== 'string' || !['YES','NO'].includes(side) || typeof stake !== 'string' || stake.length > 40 || typeof operatorAddress !== 'string' || !isAddress(operatorAddress)) throw new ExecutionError('INVALID_INPUT', 'Provide a live market, YES/NO side, decimal stake and operator wallet.');
    const state = arena(), market = state.markets.find(m => m.id === marketId);
    if (!market || state.mode !== 'live' || state.status !== 'healthy') throw new ExecutionError('INVALID_INPUT', 'A fresh, healthy live market is required.');
    const forecast = agentId ? state.forecasts.find(f => f.marketId === market.id && f.agentId === agentId as AgentId) : null;
    if (agentId && (!forecast || forecast.action !== `BUY_${side}` || Date.now() - forecast.at > 15_000)) throw new ExecutionError('INVALID_INPUT', 'The selected model no longer recommends this side. Review its latest recommendation.');
    res.status(201).json(publicRecord(await service.prepare(market, side, stake, operatorAddress, forecast || null)));
  });
  router.get('/:id', async (req, res) => res.json(publicRecord(await service.refresh(req.params.id))));
  router.get('/:id/safety', async (req, res) => res.json(await service.safety(req.params.id)));
  router.post('/:id/simulate', async (req, res) => res.json(publicRecord(await service.simulate(req.params.id))));
  router.post('/:id/approval', async (req, res) => res.status(201).json(publicRecord(await service.approval(req.params.id))));
  router.post('/:id/execute', async (req, res) => {
    const signature = req.body?.signature;
    if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature)) throw new ExecutionError('UNAUTHORIZED', 'A wallet signature for this frozen intent is required.');
    res.json(publicRecord(await service.execute(req.params.id, signature as Hex)));
  });
  router.post('/:id/recover', async (req, res) => {
    const { signature, executionId } = req.body || {};
    if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature) || typeof executionId !== 'string' || !/^[\w-]{1,200}$/.test(executionId)) throw new ExecutionError('INVALID_INPUT', 'Supply an execution ID and intent authorization signature.');
    res.json(publicRecord(await service.recover(req.params.id, executionId, signature as Hex)));
  });
  router.use((error: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    const status = error instanceof ExecutionError ? error.code === 'UNAUTHORIZED' ? 403 : error.code === 'BUSY' ? 409 : 400 : 503;
    res.status(status).json({ code: error instanceof ExecutionError ? error.code : 'SERVICE_UNAVAILABLE', error: error instanceof ExecutionError ? error.message : 'Execution service is temporarily unavailable. No automatic retry was submitted.' });
  });
  return router;
}
