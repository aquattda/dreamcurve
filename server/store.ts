import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { AGENTS, brier, paperPnl, type Market, type Forecast, type Proof, type ScoreRow, type Snapshot } from '../shared/domain';

export function createStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (market_id TEXT, at INTEGER, payload TEXT NOT NULL, PRIMARY KEY(market_id,at));
    CREATE TABLE IF NOT EXISTS forecasts (market_id TEXT, agent_id TEXT, at INTEGER, payload TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(market_id,agent_id));
    CREATE TABLE IF NOT EXISTS settlements (market_id TEXT PRIMARY KEY, outcome INTEGER NOT NULL CHECK(outcome IN(0,1)), at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(at);
    CREATE TRIGGER IF NOT EXISTS forecasts_immutable BEFORE UPDATE ON forecasts BEGIN SELECT RAISE(ABORT,'Canonical forecasts are immutable'); END;`);
  return {
    db,
    saveMarket(m: Market) { db.prepare('INSERT INTO markets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(m.id, JSON.stringify(m)); },
    snapshot(m: Market, s: Snapshot) { db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?)').run(m.id,s.at,JSON.stringify(s)); },
    history(id: string): Snapshot[] { return (db.prepare('SELECT payload FROM snapshots WHERE market_id=? ORDER BY at DESC LIMIT 180').all(id) as {payload:string}[]).reverse().map(r=>JSON.parse(r.payload)); },
    canonical(m: Market, forecasts: Forecast[], now = Date.now()) {
      const window = Math.min(60_000, m.interval * 200);
      if (m.source !== 'live' || m.expiry <= now || m.expiry - now > window || m.status !== 'Trading' || now - m.updatedAt >= 15_000) return;
      for (const f of forecasts) {
        if (f.at >= m.expiry || f.at > now || now-f.at > 15_000 || f.marketId !== m.id) continue;
        const payload = JSON.stringify({...f, canonical:true});
        const digest = createHash('sha256').update(payload).digest('hex');
        db.prepare('INSERT OR IGNORE INTO forecasts VALUES (?,?,?,?,?)').run(m.id,f.agentId,f.at,payload,digest);
      }
    },
    pending(): {id:string;expiry:number}[] { return (db.prepare('SELECT DISTINCT m.id,m.payload FROM markets m JOIN forecasts f ON m.id=f.market_id LEFT JOIN settlements s ON s.market_id=m.id WHERE s.market_id IS NULL LIMIT 50').all() as {id:string;payload:string}[]).map(r=>({id:r.id,expiry:JSON.parse(r.payload).expiry})); },
    settle(id: string, outcome: number, at = Date.now()) { if (![0,1].includes(outcome)) throw new Error('Non-binary outcome cannot be scored'); db.prepare('INSERT OR IGNORE INTO settlements VALUES (?,?,?)').run(id,outcome,at); },
    proofs(): Proof[] { return (db.prepare('SELECT f.*,s.outcome,m.payload AS market_payload FROM forecasts f JOIN settlements s ON f.market_id=s.market_id JOIN markets m ON m.id=f.market_id ORDER BY f.at DESC LIMIT 400').all() as {payload:string;market_payload:string;digest:string;outcome:number}[]).map(r=>{const f:Forecast=JSON.parse(r.payload); return {marketId:f.marketId,title:JSON.parse(r.market_payload).title,at:f.at,outcome:r.outcome,agentId:f.agentId,probability:f.probabilityYes,brier:brier(f.probabilityYes,r.outcome),pnl:paperPnl(f,r.outcome),digest:r.digest};}); },
    scores(): ScoreRow[] {
      const rows = db.prepare('SELECT f.payload,s.outcome FROM forecasts f JOIN settlements s ON f.market_id=s.market_id').all() as {payload:string;outcome:number}[];
      return AGENTS.map(a=>{const fs=rows.map(r=>({f:JSON.parse(r.payload) as Forecast,outcome:r.outcome})).filter(r=>r.f.agentId===a.id); return {agentId:a.id,count:fs.length,brier:fs.length?fs.reduce((s,r)=>s+brier(r.f.probabilityYes,r.outcome),0)/fs.length:null,hitRate:fs.length?fs.filter(r=>Number(r.f.probabilityYes>=.5)===r.outcome).length/fs.length:null,paperPnl:fs.reduce((s,r)=>s+paperPnl(r.f,r.outcome),0),traded:fs.filter(r=>r.f.action!=='NO_TRADE').length};});
    },
    prune() { db.prepare('DELETE FROM snapshots WHERE at<?').run(Date.now()-7*86_400_000); },
    close() { db.close(); },
  };
}
