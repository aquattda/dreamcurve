import { createHash } from 'node:crypto';
import pg from 'pg';
import { chartHistoryQuery, HISTORY_RETENTION_MS } from './chart-history';
import { AGENTS, brier, paperPnl, type Forecast, type Market, type Proof, type ScoreRow, type Snapshot } from '../shared/domain';

const { Pool } = pg;

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

export async function createPostgresStore(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'dreamcurve',
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      market_id TEXT NOT NULL,
      at BIGINT NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (market_id, at)
    );
    CREATE TABLE IF NOT EXISTS forecasts (
      market_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      at BIGINT NOT NULL,
      payload JSONB NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (market_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS settlements (
      market_id TEXT PRIMARY KEY,
      outcome SMALLINT NOT NULL CHECK (outcome IN (0, 1)),
      at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(at);
    CREATE OR REPLACE FUNCTION reject_forecast_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Canonical forecasts are immutable';
    END;
    $$;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'forecasts_immutable') THEN
        CREATE TRIGGER forecasts_immutable
        BEFORE UPDATE ON forecasts
        FOR EACH ROW EXECUTE FUNCTION reject_forecast_update();
      END IF;
    END;
    $$;
  `);

  return {
    async saveMarket(m: Market) {
      await pool.query('INSERT INTO markets(id,payload) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [m.id, JSON.stringify(m)]);
    },
    async snapshot(m: Market, s: Snapshot) {
      await pool.query('INSERT INTO snapshots(market_id,at,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [m.id, s.at, JSON.stringify(s)]);
    },
    async history(id: string): Promise<Snapshot[]> {
      const result = await pool.query<{payload: Snapshot}>('SELECT payload FROM snapshots WHERE market_id=$1 ORDER BY at DESC LIMIT 180', [id]);
      return result.rows.reverse().map(row => json<Snapshot>(row.payload));
    },
    async chartHistory(id: string, now = Date.now()): Promise<Snapshot[]> {
      const result = await pool.query<{payload: Snapshot}>(chartHistoryQuery('postgres'), [id, now - HISTORY_RETENTION_MS, now]);
      return result.rows.map(row => json<Snapshot>(row.payload));
    },
    async canonical(m: Market, forecasts: Forecast[], now = Date.now()) {
      const window = Math.min(60_000, m.interval * 200);
      if (m.source !== 'live' || m.expiry <= now || m.expiry - now > window || m.status !== 'Trading' || now - m.updatedAt >= 15_000) return;
      for (const f of forecasts) {
        if (f.at >= m.expiry || f.at > now || now - f.at > 15_000 || f.marketId !== m.id) continue;
        const payload = JSON.stringify({...f, canonical: true});
        const digest = createHash('sha256').update(payload).digest('hex');
        await pool.query('INSERT INTO forecasts(market_id,agent_id,at,payload,digest) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING', [m.id, f.agentId, f.at, payload, digest]);
      }
    },
    async pending(): Promise<{id:string;expiry:number}[]> {
      const result = await pool.query<{id:string;payload:Market}>('SELECT DISTINCT m.id,m.payload FROM markets m JOIN forecasts f ON m.id=f.market_id LEFT JOIN settlements s ON s.market_id=m.id WHERE s.market_id IS NULL LIMIT 50');
      return result.rows.map(row => ({id: row.id, expiry: json<Market>(row.payload).expiry}));
    },
    async settle(id: string, outcome: number, at = Date.now()) {
      if (![0, 1].includes(outcome)) throw new Error('Non-binary outcome cannot be scored');
      await pool.query('INSERT INTO settlements(market_id,outcome,at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, outcome, at]);
    },
    async proofs(): Promise<Proof[]> {
      const result = await pool.query<{payload:Forecast;market_payload:Market;digest:string;outcome:number}>(
        'SELECT f.payload,s.outcome,m.payload AS market_payload,f.digest FROM forecasts f JOIN settlements s ON f.market_id=s.market_id JOIN markets m ON m.id=f.market_id ORDER BY f.at DESC LIMIT 400',
      );
      return result.rows.map(row => {
        const f = json<Forecast>(row.payload);
        return {marketId:f.marketId,title:json<Market>(row.market_payload).title,at:f.at,outcome:row.outcome,agentId:f.agentId,probability:f.probabilityYes,brier:brier(f.probabilityYes,row.outcome),pnl:paperPnl(f,row.outcome),digest:row.digest};
      });
    },
    async scores(): Promise<ScoreRow[]> {
      const result = await pool.query<{payload:Forecast;outcome:number}>('SELECT f.payload,s.outcome FROM forecasts f JOIN settlements s ON f.market_id=s.market_id');
      const rows = result.rows.map(row => ({f:json<Forecast>(row.payload),outcome:row.outcome}));
      return AGENTS.map(a => {
        const fs = rows.filter(row => row.f.agentId === a.id);
        return {agentId:a.id,count:fs.length,brier:fs.length?fs.reduce((sum,row)=>sum+brier(row.f.probabilityYes,row.outcome),0)/fs.length:null,hitRate:fs.length?fs.filter(row=>Number(row.f.probabilityYes>=.5)===row.outcome).length/fs.length:null,paperPnl:fs.reduce((sum,row)=>sum+paperPnl(row.f,row.outcome),0),traded:fs.filter(row=>row.f.action!=='NO_TRADE').length};
      });
    },
    async prune() {
      await pool.query('DELETE FROM snapshots WHERE at<$1', [Date.now() - HISTORY_RETENTION_MS]);
    },
    async close() {
      await pool.end();
    },
  };
}
