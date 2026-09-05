import { describe, expect, it } from 'vitest';
import { brier, blockReason, decimalRaw, generateForecasts, quantizeDown, type Market, type Snapshot } from '../shared/domain';
const now=1_800_000_000_000;
function market(overrides:Partial<Market>={}):Market{return{id:'m1',title:'BTC closes above strike?',asset:'BTC',pool:'0xpool',venueId:'v',expiry:now+120_000,interval:900,status:'Trading',strike:100,spot:101,updatedAt:now,source:'live',yesBids:[{price:.5,size:100}],yesAsks:[{price:.52,size:80}],noBids:[{price:.48,size:80}],noAsks:[{price:.5,size:100}],priceDecimals:6,collateralDecimals:6,tick:'1000',lot:'1000',collateral:'0x',yesId:'1',noId:'2',...overrides}}
const history:Snapshot[]=Array.from({length:20},(_,i)=>({at:now-(19-i)*5000,spot:99.7+i*.065+Math.sin(i)*.02,probability:.5}));
describe('risk gates',()=>{
  it('blocks writes using stale data, closed status, or expiry without headroom',()=>{expect(blockReason(market({updatedAt:now-16_000}),now)).toMatch(/stale/);expect(blockReason(market({status:'Locked'}),now)).toMatch(/not accepting/);expect(blockReason(market({expiry:now+5_000}),now)).toMatch(/expiry/);expect(blockReason(market(),now)).toBeNull()});
  it('uses exact decimal boundaries and quantizes down',()=>{expect(decimalRaw('1.2345',6)).toBe(1_234_500n);expect(()=>decimalRaw('1.0000001',6)).toThrow();expect(quantizeDown(1_234_567n,1_000n)).toBe(1_234_000n)});
});
describe('forecast and scoring',()=>{
  it('requires sufficient data instead of inventing a signal',()=>{const fs=generateForecasts(market(),history.slice(0,4),now);expect(fs.every(f=>f.action==='NO_TRADE')).toBe(true);expect(fs[0].reasons.join(' ')).toMatch(/Warming up/)});
  it('generates bounded, auditable forecasts from sufficient inputs',()=>{const fs=generateForecasts(market(),history,now);expect(fs).toHaveLength(4);for(const f of fs){expect(f.probabilityYes).toBeGreaterThanOrEqual(.01);expect(f.probabilityYes).toBeLessThanOrEqual(.99);expect(f.version).toBe('v1-equal-weight');expect(f.reasons.length).toBeGreaterThanOrEqual(3)}});
  it('scores probability using the Brier rule',()=>{expect(brier(.8,1)).toBeCloseTo(.04);expect(brier(.8,0)).toBeCloseTo(.64);expect(()=>brier(1.1,1)).toThrow()});
});
