import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BinaryMarket, WatchHandle } from '@somnia-chain/markets-sdk';
import type { Hex } from 'viem';
import { demoState } from '../shared/demo';
import { generateForecasts, midpoint, type ArenaState, type DataIssue } from '../shared/domain';
import { discoverActiveMarkets, retryDelay } from './discovery';
import { createStore } from './store';
import { createPostgresStore } from './store-postgres';
import { exchange, readMarket, publicConfig, chainClient } from './protocol';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.DATABASE_URL
  ? await createPostgresStore(process.env.DATABASE_URL)
  : createStore(process.env.DATABASE_PATH || path.join(root, 'data/dreamcurve.sqlite'));
const state: ArenaState = {mode:'live',status:'connecting',message:'Connecting to DreamDEX testnet…',issue:null,retryable:false,updatedAt:0,lastSuccessfulAt:null,retryAt:null,markets:[],forecasts:[],histories:{},scores:await store.scores(),proofs:await store.proofs()};
let rows: BinaryMarket[] = [];
let lastDiscover = 0;
let consecutiveFailures = 0;
let lastManualRetry = 0;
let busy = false;
const watches = new Map<string, WatchHandle>();
const streams = new Set<express.Response>();
function broadcast(){for(const res of streams)res.write(`data: ${JSON.stringify(state)}\n\n`);}
function errorMessage(e: unknown) { return e instanceof Error ? e.message.slice(0, 240) : 'Unknown upstream error'; }
function classifyIssue(e: unknown): Exclude<DataIssue, null> {
  const message = errorMessage(e).toLowerCase();
  if (/rpc|chain id|network mismatch/.test(message)) return 'RPC_ERROR';
  if (/timeout|timed out|aborted/.test(message)) return 'INDEXER_TIMEOUT';
  if (/indexer|graphql|hasura/.test(message)) return 'INDEXER_ERROR';
  return 'SERVICE_ERROR';
}
function publicIssueMessage(issue: Exclude<DataIssue, null>) {
  if (issue === 'INDEXER_TIMEOUT') return 'DreamDEX market data did not respond in time. Retrying automatically.';
  if (issue === 'INDEXER_ERROR') return 'DreamDEX market data is temporarily unavailable. Retrying automatically.';
  if (issue === 'RPC_ERROR') return 'The Somnia Shannon RPC is temporarily unavailable. Retrying automatically.';
  if (issue === 'MARKET_READ_FAILED') return 'Live market quotes could not be refreshed. Trading is disabled until fresh data arrives.';
  if (issue === 'COLLECTOR_DISABLED') return 'Live collector is disabled by configuration.';
  return 'The live data service is temporarily unavailable. Retrying automatically.';
}
function scheduleRetry(issue: Exclude<DataIssue, null>) {
  consecutiveFailures += 1;
  state.status = 'degraded';
  state.issue = issue;
  state.retryable = issue !== 'COLLECTOR_DISABLED';
  state.retryAt = state.retryable ? Date.now() + retryDelay(consecutiveFailures) : null;
  state.message = publicIssueMessage(issue);
}
async function collect(force = false) {
  if (busy || (!force && state.retryAt !== null && Date.now() < state.retryAt)) return false;
  busy = true;
  try {
    if (Date.now()-lastDiscover>25_000) {
      let id: number;
      try{id=await chainClient.getChainId();}catch(e){throw new Error(`RPC connection failed: ${errorMessage(e)}`);}
      if(id!==50312)throw new Error('RPC network mismatch: expected Shannon 50312');
      rows=await discoverActiveMarkets(exchange.client,process.env.DREAMDEX_VENUE_ID);
      lastDiscover=Date.now();
      for(const [id,h] of watches)if(!rows.some(r=>r.marketId===id)){h.stop();watches.delete(id);}
      // Watches warm the SDK live store. Periodic chain reads independently verify freshness.
      for(const row of rows)if(!watches.has(row.marketId))try { const handle=await exchange.client.watchMarket(row.poolAddress); watches.set(row.marketId,handle); }catch{/* Chain reads below remain the explicit fallback. */}
    }
    const results = await Promise.allSettled(rows.map(readMarket));
    const now = Date.now();
    const freshMarkets=results.flatMap(r=>r.status==='fulfilled'&&r.value.expiry>now?[r.value]:[]);
    const freshIds=new Set(freshMarkets.map(m=>m.id));
    const activeRowIds=new Set<string>(rows.map(row=>row.marketId));
    // Keep last-known-good rows when a quote read fails. Their old updatedAt
    // makes blockReason() reject trading until a fresh on-chain read arrives.
    const retainedMarkets=state.markets.filter(m=>activeRowIds.has(m.id)&&m.expiry>now&&!freshIds.has(m.id));
    state.markets=[...freshMarkets,...retainedMarkets].sort((a,b)=>a.expiry-b.expiry);
    const retainedIds=new Set(retainedMarkets.map(m=>m.id));
    state.forecasts=state.forecasts.filter(f=>retainedIds.has(f.marketId));
    state.histories=Object.fromEntries(Object.entries(state.histories).filter(([id])=>retainedIds.has(id)));
    for(const m of freshMarkets){
      await store.saveMarket(m);await store.snapshot(m,{at:m.updatedAt,spot:m.spot,probability:midpoint(m),yesPrice:m.yesAsks[0]?.price??null,noPrice:m.noAsks[0]?.price??null});
      const history=await store.history(m.id); state.histories[m.id]=history;
      const forecasts=generateForecasts(m,history);state.forecasts.push(...forecasts);await store.canonical(m,forecasts);
    }
    for(const pending of (await store.pending()).filter(p=>p.expiry<Date.now()).slice(0,8)){
      try { const resolved=await exchange.client.getMarketOnchain(pending.id as Hex);if(resolved.finalized&&resolved.isResolved&&!resolved.isVoided&&[0,1].includes(resolved.winningOutcome))await store.settle(pending.id,resolved.winningOutcome===0?1:0); }catch(e){console.warn('Settlement read:',errorMessage(e));}
    }
    state.scores=await store.scores();state.proofs=await store.proofs();
    const failed=results.filter(r=>r.status==='rejected').length;
    if(failed){
      scheduleRetry('MARKET_READ_FAILED');
      console.warn(`DreamDEX market reads failed: ${failed}/${results.length}`);
    }else{
      consecutiveFailures=0;
      state.status='healthy';state.issue=null;state.retryable=false;state.retryAt=null;
      state.message=rows.length?'Read-only collector connected. Quotes are rechecked before signing.':'Connected, but no active BTC/ETH contracts were found. New Event Contracts appear automatically.';
      state.lastSuccessfulAt=now;
    }
    state.updatedAt=now;await store.prune();
    return true;
  }catch(e){
    const issue=classifyIssue(e);scheduleRetry(issue);
    console.warn(`DreamDEX collector ${issue}: ${errorMessage(e)}`);
    return false;
  }
  finally {busy=false;broadcast();}
}
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');next();});
app.get('/api/health',(_req,res)=>res.json({status:state.status,chainId:50312,mode:'testnet',updatedAt:state.updatedAt,lastSuccessfulAt:state.lastSuccessfulAt,retryAt:state.retryAt,issue:state.issue,message:state.message}));
app.get('/api/ready',(_req,res)=>res.status(state.status==='healthy'?200:503).json({ready:state.status==='healthy',status:state.status,issue:state.issue,lastSuccessfulAt:state.lastSuccessfulAt}));
app.get('/api/config',(_req,res)=>res.json(publicConfig));
app.get('/api/arena',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(req.query.mode==='demo'?demoState():state);});
app.post('/api/retry',async(_req,res)=>{
  if(process.env.COLLECTOR_ENABLED==='false'){res.status(503).json(state);return;}
  const now=Date.now();
  if(now-lastManualRetry<5_000){res.setHeader('Retry-After','5');res.status(429).json(state);return;}
  lastManualRetry=now;
  if(busy){res.status(409).json(state);return;}
  await collect(true);res.setHeader('Cache-Control','no-store');res.json(state);
});
app.get('/api/proofs',async(_req,res)=>{res.setHeader('Content-Disposition','attachment; filename="dreamcurve-forecasts.json"');res.json({schema:1,network:50312,note:'Application-recorded forecasts; hashes are not on-chain commitments.',proofs:await store.proofs()});});
app.get('/api/stream',(req,res)=>{
  if(streams.size>=100){res.status(503).json({error:'Connection limit reached; polling remains available.'});return;}
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();
  res.write(`data: ${JSON.stringify(state)}\n\n`);streams.add(res);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15_000);req.on('close',()=>{clearInterval(heartbeat);streams.delete(res);});
});
app.use('/api',(_req,res)=>res.status(404).json({error:'Unknown API route'}));
const production=process.argv.includes('--production')||process.env.NODE_ENV==='production';
if(production){app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(root,'dist/index.html')));}
else {const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'custom'});app.use(vite.middlewares);app.use(async(req,res,next)=>{try{const template=await vite.transformIndexHtml(req.originalUrl,await readFile(path.join(root,'index.html'),'utf8'));res.status(200).type('html').send(template);}catch(e){next(e);}});}
const host=process.env.HOST||(process.env.DYNO?'0.0.0.0':'127.0.0.1');const port=Number(process.env.PORT||8787);
const server=app.listen(port,host,()=>{console.log(`DreamCurve ready at http://${host}:${port}`);if(process.env.COLLECTOR_ENABLED!=='false')void collect();else{scheduleRetry('COLLECTOR_DISABLED');}});
const timer=setInterval(()=>{if(process.env.COLLECTOR_ENABLED!=='false')void collect();},5000);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(timer);for(const h of watches.values())h.stop();for(const res of streams)res.end();server.close(()=>{void Promise.resolve(store.close()).finally(()=>process.exit(0));});setTimeout(()=>process.exit(0),2000).unref();});
