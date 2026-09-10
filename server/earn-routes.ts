import { Router, type ErrorRequestHandler } from 'express';
import { isAddress, type Hex } from 'viem';
import { EARN_CHAIN, earnAuthorization, type EarnRecord } from '../shared/earn';
import { ExecutionError } from '../shared/execution';
import { EarnService } from './earn-service';

const view = (r: EarnRecord) => ({ ...r, authorizationMessage: earnAuthorization(r.intent) });
export function earnRoutes(service: EarnService) {
  const router = Router(), calls = new Map<string,{ at: number; count: number }>();
  router.use((req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    if (req.method === 'POST' && req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: 'Cross-site Earn requests are not allowed.' }); return; }
    const now = Date.now(), key = req.ip || 'unknown';
    for (const [k,v] of calls) if (now - v.at >= 60_000) calls.delete(k);
    if (!calls.has(key) && calls.size >= 1000) { res.status(429).json({ error: 'Earn service is busy.' }); return; }
    const entry = calls.get(key) || { at: now, count: 0 }; entry.count++; calls.set(key,entry);
    if (entry.count > 40) { res.setHeader('Retry-After','60'); res.status(429).json({ error: 'Too many Earn requests. Retry in one minute.' }); return; }
    next();
  });
  let overview: { at: number; result: Awaited<ReturnType<EarnService['overview']>> } | null = null;
  let loading: Promise<Awaited<ReturnType<EarnService['overview']>>> | null = null;
  router.get('/overview',async (_req,res) => {
    if (overview && Date.now() - overview.at < 10_000) { res.json(overview.result); return; }
    if (!loading) loading = service.overview().finally(() => { loading = null; });
    const result = await loading; overview = { at: Date.now(), result }; res.json(result);
  });
  router.get('/intents',async (_req,res) => res.json((await service.store.list()).map(view)));
  router.post('/intents',async (req,res) => {
    const b = req.body || {};
    if (Object.keys(b).some(k => !['chainId','action','amount','operatorAddress','asset'].includes(k)) || b.chainId !== EARN_CHAIN || !['APPROVAL','SUPPLY','WITHDRAW'].includes(b.action) || (b.asset !== undefined && !['USDC','LINK'].includes(b.asset)) || typeof b.amount !== 'string' || typeof b.operatorAddress !== 'string' || !isAddress(b.operatorAddress)) throw new ExecutionError('INVALID_INPUT','Provide only Sepolia chainId, allowlisted asset, Earn action, decimal amount and operatorAddress. Targets and ABI are server-owned.');
    res.status(201).json(view(await service.prepare(b.action,b.amount,b.operatorAddress,b.asset ?? 'LINK')));
  });
  router.get('/intents/:id',async (req,res) => res.json(view(await service.refresh(req.params.id))));
  router.get('/intents/:id/safety',async (req,res) => res.json(await service.safety(req.params.id)));
  router.post('/intents/:id/simulate',async (req,res) => res.json(view(await service.simulate(req.params.id))));
  for (const action of ['execute','recover'] as const) router.post(`/intents/:id/${action}`,async (req,res) => {
    const { signature, executionId } = req.body || {};
    if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature)) throw new ExecutionError('UNAUTHORIZED','A signature from the authorized operator is required.');
    if (action === 'recover' && (typeof executionId !== 'string' || !/^[\w-]{1,200}$/.test(executionId))) throw new ExecutionError('INVALID_INPUT','Invalid KeeperHub execution ID.');
    const r = action === 'execute' ? await service.execute(req.params.id,signature as Hex) : await service.recover(req.params.id,executionId,signature as Hex);
    overview = null; res.json(view(r));
  });
  const errors: ErrorRequestHandler = (e,_req,res,_next) => {
    res.status(e instanceof ExecutionError ? e.code === 'UNAUTHORIZED' ? 403 : e.code === 'BUSY' ? 409 : 400 : 503).json({ code: e instanceof ExecutionError ? e.code : 'SERVICE_UNAVAILABLE', error: e instanceof ExecutionError ? e.message : 'Earn service unavailable. No automatic broadcast retry.' });
  };
  router.use(errors); return router;
}
