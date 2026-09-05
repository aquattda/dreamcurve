import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BinaryMarket, WatchHandle } from '@somnia-chain/markets-sdk';
import type { Hex } from 'viem';
import { demoState } from '../shared/demo';
import { generateForecasts, midpoint, type ArenaState } from '../shared/domain';
import { createStore } from './store';
import { createPostgresStore } from './store-postgres';
import { exchange, readMarket, publicConfig, chainClient } from './protocol';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.DATABASE_URL
  ? await createPostgresStore(process.env.DATABASE_URL)
  : createStore(process.env.DATABASE_PATH || path.join(root, 'data/dreamcurve.sqlite'));
const state: ArenaState = {mode:'live',status:'connecting',message:'Connecting to DreamDEX testnet…',updatedAt:0,markets:[],forecasts:[],histories:{},scores:await store.scores(),proofs:await store.proofs()};
let rows: BinaryMarket[] = [];
let lastDiscover = 0;
let busy = false;
const watches = new Map<string, WatchHandle>();
const streams = new Set<express.Response>();
function broadcast(){for(const res of streams)res.write(`data: ${JSON.stringify(state)}\n\n`);}
function errorMessage(e: unknown) { return e instanceof Error ? e.message.slice(0, 240) : 'Unknown upstream error'; }
async function collect() {
  if (busy) return; busy = true;
  try {
    if (Date.now()-lastDiscover>25_000) {
      const id = await chainClient.getChainId(); if(id!==50312)throw new Error('RPC network mismatch: expected Shannon 50312');
      const found = await exchange.client.listBinaryMarkets({limit:100,...(process.env.DREAMDEX_VENUE_ID?{venueId:process.env.DREAMDEX_VENUE_ID}:{})});
      rows=found.filter(m=>['BTC','ETH'].includes(m.asset.toUpperCase())&&Number(m.expiry)*1000>Date.now()&&Number(m.tradingStart)*1000<=Date.now()).sort((a,b)=>Number(a.expiry)-Number(b.expiry)).slice(0,8);
      lastDiscover=Date.now();
      for(const [id,h] of watches)if(!rows.some(r=>r.marketId===id)){h.stop();watches.delete(id);}
      // Watches warm the SDK live store. Periodic chain reads independently verify freshness.
      for(const row of rows)if(!watches.has(row.marketId))try { const handle=await exchange.client.watchMarket(row.poolAddress); watches.set(row.marketId,handle); }catch{/* Chain reads below remain the explicit fallback. */}
    }
    const results = await Promise.allSettled(rows.map(readMarket));
    // A timestamp transition may not emit a StatusChanged event immediately.
    // Hide expired rows even when the contract/indexer still says Trading.
    state.markets=results.flatMap(r=>r.status==='fulfilled'&&r.value.expiry>Date.now()?[r.value]:[]);
    state.forecasts=[];
    state.histories={};
    for(const m of state.markets){
      await store.saveMarket(m);await store.snapshot(m,{at:m.updatedAt,spot:m.spot,probability:midpoint(m)});
      const history=await store.history(m.id); state.histories[m.id]=history;
      const forecasts=generateForecasts(m,history);state.forecasts.push(...forecasts);await store.canonical(m,forecasts);
    }
    for(const pending of (await store.pending()).filter(p=>p.expiry<Date.now()).slice(0,8)){
      try { const resolved=await exchange.client.getMarketOnchain(pending.id as Hex);if(resolved.finalized&&resolved.isResolved&&!resolved.isVoided&&[0,1].includes(resolved.winningOutcome))await store.settle(pending.id,resolved.winningOutcome===0?1:0); }catch(e){console.warn('Settlement read:',errorMessage(e));}
    }
    state.scores=await store.scores();state.proofs=await store.proofs();
    const failed=results.filter(r=>r.status==='rejected').length;
    state.status=failed?'degraded':'healthy';
    state.message=failed?`${failed} market reads failed; unavailable markets are hidden.`:rows.length?'Read-only collector connected. Quotes are rechecked before signing.':'Connected, but no active BTC/ETH contracts were found. Try again when a new window opens.';
    state.updatedAt=Date.now();await store.prune();
  }catch(e){state.status='degraded';state.message=`DreamDEX connection unavailable: ${errorMessage(e)}`;console.warn(state.message);}
  finally {busy=false;broadcast();}
}
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');next();});
app.get('/api/health',(_req,res)=>res.json({status:state.status,chainId:50312,mode:'testnet',updatedAt:state.updatedAt,message:state.message}));
app.get('/api/config',(_req,res)=>res.json(publicConfig));
app.get('/api/arena',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(req.query.mode==='demo'?demoState():state);});
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
const server=app.listen(port,host,()=>{console.log(`DreamCurve ready at http://${host}:${port}`);if(process.env.COLLECTOR_ENABLED!=='false')void collect();else{state.status='degraded';state.message='Live collector is disabled by configuration.';}});
const timer=setInterval(()=>{if(process.env.COLLECTOR_ENABLED!=='false')void collect();},5000);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(timer);for(const h of watches.values())h.stop();for(const res of streams)res.end();server.close(()=>{void Promise.resolve(store.close()).finally(()=>process.exit(0));});setTimeout(()=>process.exit(0),2000).unref();});
