import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowRight, Clock3, Download, Menu, RefreshCw, Wallet } from 'lucide-react';
import type { Address } from 'viem';
import { AGENTS, blockReason, midpoint, type AgentId, type ArenaState, type Forecast, type Market, type Side } from '../shared/domain';
import { Logo } from './App';
import { claimTestUsdc, connectWallet, loadTestUsdcBalance } from './wallet-bridge';
import PortfolioPage from './portfolio/PortfolioPage';
import { TradeModal } from './TradeModal';
import { PrepareExecution } from './execution/PrepareExecution';
import ExecutionPage from './execution/ExecutionPage';
import EarnPage from './earn/EarnPage';
import { connectEarnWallet } from './earn/api';
import { HistoricalMarket } from './portfolio/HistoricalMarket';
import { ProbabilityChart } from './ProbabilityChart';
import { useArena } from './useArena';

const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
const pct=(n:number|null,d=0)=>n===null?'—':`${(n*100).toFixed(d)}%`;
const cents=(n:number|null|undefined,d=1)=>n==null?'No ask':`${(n*100).toFixed(d)}¢`;
const intervalLabel=(seconds:number)=>seconds%86400===0?`${seconds/86400}d`:seconds%3600===0?`${seconds/3600}h`:`${Math.round(seconds/60)}m`;
function walletMessage(error:unknown,fallback:string){
  const code=(error as {code?:number})?.code;
  const message=error instanceof Error?error.message:fallback;
  return code===4001||/user rejected|user denied/i.test(message)?'Request cancelled in MetaMask. No transaction was sent.':message;
}
type TestUsdcBalance={raw:bigint;decimals:number;formatted:string};
type WalletCtx={
  account:Address|null;
  connect:()=>void;
  testUsdc:TestUsdcBalance|null;
  fundingBusy:boolean;
  fundingStatus:string;
  fundingHash:string;
  refreshTestUsdc:()=>void;
  requestTestUsdc:()=>void;
};
const WalletContext=createContext<WalletCtx>({account:null,connect:()=>{},testUsdc:null,fundingBusy:false,fundingStatus:'',fundingHash:'',refreshTestUsdc:()=>{},requestTestUsdc:()=>{}});
function useWalletContext(){return useContext(WalletContext)}
function useCountdown(expiry:number){const [now,setNow]=useState(Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[]);const seconds=Math.max(0,Math.ceil((expiry-now)/1000));if(seconds>=86400)return `${Math.floor(seconds/86400)}d ${Math.floor(seconds%86400/3600)}h`;if(seconds>=3600)return `${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`;return seconds===0?'Closing':`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function AppHeader({account,onConnect,mode}:{account:Address|null;onConnect:()=>void;mode:string}){const [open,setOpen]=useState(false);const earn=useLocation().pathname.startsWith('/app/earn');const suffix=mode==='demo'?'?mode=demo':'';return <><header className="app-header"><Logo/><button className="mobile-menu" onClick={()=>setOpen(v=>!v)} aria-label="Open navigation"><Menu/></button><nav onClick={()=>setOpen(false)} className={open?'open':''}><NavLink end to={`/app${suffix}`}>Arena</NavLink><NavLink to={`/app/agents${suffix}`}>Agents</NavLink><NavLink to={`/app/leaderboard${suffix}`}>Scorecard</NavLink><NavLink to={`/app/portfolio${suffix}`}>Portfolio</NavLink><NavLink to="/app/executions">Executions</NavLink><NavLink to="/app/earn">Earn</NavLink></nav><div className="app-actions"><span className="network-chip"><span className="status-dot"/> {earn?'Sepolia testnet':'Shannon testnet'}</span><button className="button dark small" onClick={onConnect}><Wallet size={15}/>{account?`${account.slice(0,6)}…${account.slice(-4)}`:'Connect wallet'}</button></div></header>{open?<button className="menu-shade" aria-label="Close navigation" onClick={()=>setOpen(false)}/>:null}</>}
function DataBanner({state,error,mode}:{state:ArenaState|null;error:string;mode:string}){return <aside aria-label="Data status" className={`data-banner ${mode==='demo'?'demo':''}`}><span>{mode==='demo'?'ILLUSTRATIVE MODE':state?.status==='healthy'?'LIVE TESTNET':'CONNECTION STATUS'}</span><p>{error||state?.message||'Opening the DreamDEX data stream…'}</p>{mode==='demo'?<Link to="/app?mode=live">Try live testnet <ArrowRight size={14}/></Link>:<Link to="/app?mode=demo">Explore with example data <ArrowRight size={14}/></Link>}</aside>}
function AgentAvatar({id,large=false}:{id:AgentId;large?:boolean}){const a=AGENTS.find(x=>x.id===id)!;return <span aria-hidden="true" className={`agent-avatar ${a.color} ${large?'large':''}`}>{a.initial}<span>✳</span></span>}
function MarketRow({market,active,onClick}:{market:Market;active:boolean;onClick:()=>void}){const time=useCountdown(market.expiry);const mid=midpoint(market);return <button className={`market-row ${active?'active':''}`} onClick={onClick}><span aria-hidden="true" className={`coin ${market.asset==='BTC'?'bitcoin':'ethereum'}`}>{market.asset==='BTC'?'₿':'Ξ'}</span><span className="market-row-main"><strong>{market.asset} · {intervalLabel(market.interval)}</strong><small>{market.strike?`Above ${money.format(market.strike)}` :market.dataWarning?'Unverified boundary':'Opening reference'}</small></span><span className="market-row-odds"><strong>{pct(mid)}</strong><small>YES</small></span><span className="market-row-time"><Clock3 size={13}/>{time}</span></button>}
function AgentCard({forecast,onTrade,allowTrade,unavailableLabel='Illustration only'}:{forecast:Forecast;onTrade:(side:Side)=>void;allowTrade:boolean;unavailableLabel?:string}){const a=AGENTS.find(x=>x.id===forecast.agentId)!;const side=forecast.action==='BUY_NO'?'NO':'YES';return <article className={`arena-agent ${forecast.agentId==='meta'?'featured':''}`}><div className="arena-agent-head"><AgentAvatar id={forecast.agentId}/><div><strong>{a.name}</strong><span>{a.role}</span></div><span className={`confidence ${forecast.confidence.toLowerCase()}`}>{forecast.confidence} confidence</span></div><div className="forecast-value"><span>Forecast</span><strong>{pct(forecast.probabilityYes)}</strong><small>YES</small></div><div className={`signal-pill ${forecast.action==='NO_TRADE'?'neutral':side.toLowerCase()}`}>{forecast.action==='NO_TRADE'?'WAITING FOR AN EDGE':`${forecast.action.replace('_',' ')} · ${forecast.edge!==null?(forecast.edge*100).toFixed(1):'—'} PP EDGE`}</div><ul>{forecast.reasons.slice(0,3).map(r=><li key={r}>{r}</li>)}</ul><button className="button agent-button" disabled={forecast.action==='NO_TRADE'||!allowTrade} onClick={()=>onTrade(side)}>{allowTrade?'Copy this perspective':unavailableLabel} <ArrowRight size={15}/></button></article>}
function ArenaHome({state,onRetry,retrying}:{state:ArenaState;onRetry:()=>void;retrying:boolean}) {
  const [params]=useSearchParams();
  const requestedMarket=params.get('market');
  const [selected,setSelected]=useState(requestedMarket||state.markets[0]?.id||'');
  useEffect(()=>{if(requestedMarket)setSelected(requestedMarket)},[requestedMarket]);
  const [trade,setTrade]=useState<{marketId:string;side:Side;agentId?:AgentId;legacy?:boolean}|null>(null);
  useEffect(()=>{if(!state.markets.some(m=>m.id===selected))setSelected(state.markets[0]?.id||'')},[state.markets,selected]);
  const market=state.markets.find(m=>m.id===selected);
  const wallet=useWalletContext();
  const {account,connect}=wallet;
  if(requestedMarket&&!state.markets.some(m=>m.id===requestedMarket))return <HistoricalMarket id={requestedMarket} account={account}/>;
  if(!market&&state.mode==='live'&&state.status==='connecting')return <section className="loading-state"><RefreshCw className="spin"/><span>Opening the DreamDEX data stream…</span></section>;
  if(!market&&state.mode==='live'&&state.status==='degraded')return <LiveDataUnavailable state={state} onRetry={onRetry} retrying={retrying}/>;
  if(!market)return <EmptyState live={state.mode==='live'}/>;
  const forecasts=state.forecasts.filter(f=>f.marketId===market.id);
  const allowTrade=market.source==='live'&&state.status==='healthy'&&blockReason(market)===null;
  return <>
    <div className="arena-layout">
      <aside className="market-panel"><div className="panel-title"><span>Live windows</span><small>{state.markets.length} markets</small></div>{state.markets.map(m=><MarketRow key={m.id} market={m} active={m.id===market.id} onClick={()=>setSelected(m.id)}/>)}</aside>
      <section className="market-detail">
        <div className="market-title-row"><div><span className="eyebrow">{market.asset} · {intervalLabel(market.interval)} WINDOW</span><h1>{market.title}</h1><p>{market.strike?`Strike ${money.format(market.strike)} · Spot ${market.spot?money.format(market.spot):'unavailable'}`:'Waiting for the opening reference price'}</p></div><div className="market-big-odds"><span>Market says</span><strong>{pct(midpoint(market))}</strong><small>YES</small></div></div>
        {market.dataWarning?<p className="form-error" role="alert">{market.dataWarning}</p>:null}
        <div className="chart-card">
          <div className="chart-head"><span>Implied YES probability <small>Mid price</small></span><span><span className="status-dot"/> {market.source==='live'?'On-chain order book':'Illustrative series'}</span></div>
          <ProbabilityChart key={market.id} history={state.histories[market.id]||[]}/>
          <div className="book-tops">
            <button onClick={()=>setTrade({marketId:market.id,side:'YES'})} disabled={!allowTrade||!market.yesAsks.length}><span>Buy YES<small>Contract price</small></span><strong>{cents(market.yesAsks[0]?.price)}</strong></button>
            <button onClick={()=>setTrade({marketId:market.id,side:'NO'})} disabled={!allowTrade||!market.noAsks.length}><span>Buy NO<small>Contract price</small></span><strong>{cents(market.noAsks[0]?.price)}</strong></button>
          </div>
        </div>
        <div className="arena-heading"><div><span className="eyebrow">FOUR SECOND OPINIONS</span><h2>Where the agents stand</h2></div><Link to="/methodology" className="text-link">Read the method <ArrowRight size={15}/></Link></div>
        <div className="agent-grid">{forecasts.map(f=><AgentCard key={f.agentId} forecast={f} allowTrade={allowTrade} unavailableLabel={market.source==='live'?'Trading paused':'Illustration only'} onTrade={side=>setTrade({marketId:market.id,side,agentId:f.agentId})}/>)}</div>
      </section>
    </div>
    {trade?.marketId===market.id&&market.source==='live'?(trade.legacy?<TradeModal key={`${market.id}:${account??'disconnected'}`} funding={wallet} market={market} side={trade.side} account={account} onConnect={connect} onClose={()=>setTrade(null)}/>:<PrepareExecution market={market} side={trade.side} agentId={trade.agentId} account={account} onConnect={connect} onClose={()=>setTrade(null)} onLegacy={()=>setTrade({...trade,legacy:true})}/>):null}
  </>;
}
function LiveDataUnavailable({state,onRetry,retrying}:{state:ArenaState;onRetry:()=>void;retrying:boolean}){const timeout=state.issue==='INDEXER_TIMEOUT';return <section className="empty-state unavailable-state"><span className="empty-glyph error" aria-hidden="true">!</span><span className="eyebrow">LIVE DATA PAUSED</span><h1>Live market data is temporarily unavailable</h1><p>{timeout?'The DreamDEX testnet indexer did not respond in time. Your wallet and funds are not affected.':'DreamDEX or the Somnia testnet is not responding right now. Your wallet and funds are not affected.'}</p>{state.lastSuccessfulAt?<p className="retry-status">Last successful update: {new Date(state.lastSuccessfulAt).toLocaleString()}</p>:<p className="retry-status">No live snapshot has been received yet.</p>}<div className="empty-actions"><button className="button primary" onClick={onRetry} disabled={retrying||!state.retryable}>{retrying?<><RefreshCw className="spin" size={16}/> Retrying…</>:<><RefreshCw size={16}/> Retry live data</>}</button><Link to="/app?mode=demo" className="button outline">Explore example arena <ArrowRight size={16}/></Link></div></section>}
function EmptyState({live}:{live:boolean}){return <section className="empty-state"><span className="empty-glyph">⌁</span><h1>{live?'No active BTC or ETH windows':'No example markets available'}</h1><p>{live?'The collector is connected but did not find a currently tradable window. New Event Contracts appear automatically.':'Refresh the example arena.'}</p>{live?<Link to="/app?mode=demo" className="button primary">Explore example arena <ArrowRight size={16}/></Link>:null}</section>}
function AgentsPage({state}:{state:ArenaState}){return <section className="inner-page"><span className="eyebrow">OPEN METHODOLOGY</span><h1>Meet your second opinions.</h1><p className="page-lead">Four models turn the same market into four visible perspectives. Sample counts matter, and insufficient input always means “wait”.</p><div className="agents-full">{AGENTS.map(a=>{const score=state.scores.find(s=>s.agentId===a.id);return <article key={a.id}><AgentAvatar id={a.id} large/><span className="agent-role">{a.role.toUpperCase()}</span><h2>{a.name}</h2><p>{a.description}</p><dl><div><dt>Brier</dt><dd>{score?.brier===null||score?.brier===undefined?'—':score.brier.toFixed(3)}</dd></div><div><dt>Scored</dt><dd>{score?.count||0}</dd></div></dl><Link className="text-link" to="/methodology">View methodology <ArrowRight size={15}/></Link></article>})}</div></section>}
function Scorecard({state}:{state:ArenaState}){return <section className="inner-page"><div className="page-title-actions"><div><span className="eyebrow">ACCOUNTABILITY IS THE EDGE</span><h1>The open scorecard.</h1><p className="page-lead">Lower Brier scores mean confidence tracked outcomes more closely. Snapshot Paper PnL assumes one share at the recorded ask before fees and gas. NO TRADE records count as zero; this is not a backtest of every signal.</p></div>{state.mode==='live'?<a className="button outline" href="/api/proofs"><Download size={16}/> Export records</a>:null}</div><div className="score-table" role="table"><div className="score-row score-head" role="row"><span>Agent</span><span>Brier ↓</span><span>Hit rate</span><span>Snapshot PnL</span><span>Sample</span></div>{[...state.scores].sort((a,b)=>(a.brier??99)-(b.brier??99)).map((s,i)=>{const a=AGENTS.find(x=>x.id===s.agentId)!;return <div className="score-row" role="row" key={s.agentId}><span><b>{i+1}</b><AgentAvatar id={s.agentId}/><span><strong>{a.name}</strong><small>{a.role}</small></span></span><span>{s.brier===null?'Warming up':s.brier.toFixed(3)}</span><span>{s.hitRate===null?'—':pct(s.hitRate)}</span><span className={s.paperPnl>=0?'positive':'negative'}>{s.count?`${s.paperPnl>=0?'+':''}${s.paperPnl.toFixed(2)} tUSDC`:'—'}</span><span>{s.count} forecasts</span></div>})}</div><div className="proof-list"><div className="panel-title"><span>Resolved forecast record</span><small>{state.mode==='demo'?'Synthetic examples':'Recorded before settlement'}</small></div>{state.proofs.slice(0,12).map(p=><article key={`${p.marketId}-${p.agentId}`}><AgentAvatar id={p.agentId}/><div><strong>{p.title}</strong><small>{new Date(p.at).toLocaleString()} · {p.digest.slice(0,12)}…</small></div><span>{pct(p.probability)} YES</span><span>Outcome {p.outcome?'YES':'NO'}</span><b>{p.brier.toFixed(3)}</b></article>)}{!state.proofs.length?<p className="table-empty">Collector is waiting for canonical forecasts to resolve.</p>:null}</div></section>}
function PortfolioRoute(){const wallet=useWalletContext();return <PortfolioPage key={wallet.account??'disconnected'} wallet={wallet}/>}
function ExecutionRoute(){const wallet=useWalletContext();return <ExecutionPage account={wallet.account} onConnect={wallet.connect}/>}
export default function Arena(){
  const{state,error,mode,load,retry,retrying}=useArena();
  const isEarn=useLocation().pathname.startsWith('/app/earn');
  const[account,setAccount]=useState<Address|null>(null);
  const[testUsdc,setTestUsdc]=useState<TestUsdcBalance|null>(null);
  const accountRef=useRef<Address|null>(null);
  const fundingLock=useRef(false);
  const[walletError,setWalletError]=useState('');
  const[fundingBusy,setFundingBusy]=useState(false);
  const[fundingStatus,setFundingStatus]=useState('');
  const[fundingHash,setFundingHash]=useState('');
  const connect=useCallback(async()=>{
    let next:Address;
    try{
      next=await (isEarn?connectEarnWallet():connectWallet());
      accountRef.current=next;setAccount(next);setTestUsdc(null);setFundingHash('');setWalletError('');
    }catch(e){setWalletError(walletMessage(e,'Wallet connection failed'));return}
    if(isEarn)return;
    setFundingStatus('Checking tUSDC balance…');
    try{const balance=await loadTestUsdcBalance(next);if(accountRef.current===next){setTestUsdc(balance);setFundingStatus('')}}catch(e){if(accountRef.current===next)setFundingStatus(walletMessage(e,'Could not read the tUSDC balance.'))}
  },[isEarn]);
  useEffect(()=>{accountRef.current=null;setAccount(null);setTestUsdc(null);setWalletError('');},[isEarn]);
  const refreshTestUsdc=useCallback(async()=>{
    if(!account)return;
    try{const balance=await loadTestUsdcBalance(account);if(accountRef.current===account)setTestUsdc(balance)}catch(e){if(accountRef.current===account){setTestUsdc(null);setFundingStatus(e instanceof Error?e.message:'Could not read the tUSDC balance.')}}
  },[account]);
  const requestTestUsdc=useCallback(async()=>{
    if(!account||fundingLock.current)return;
    fundingLock.current=true;setFundingBusy(true);setFundingHash('');setFundingStatus('Confirm the 10,000 tUSDC faucet request in MetaMask…');
    try{
      const result=await claimTestUsdc(account);
      if(accountRef.current!==account)return;
      setFundingHash(result.hash);setFundingStatus('Faucet confirmed. 10,000 test tUSDC was added to this wallet.');
      try{const balance=await loadTestUsdcBalance(account);if(accountRef.current===account)setTestUsdc(balance)}catch{if(accountRef.current===account)setFundingStatus('Faucet confirmed. Balance refresh is delayed; use Refresh in a moment.')}
    }catch(e){if(accountRef.current===account)setFundingStatus(walletMessage(e,'The tUSDC faucet request failed.'))}finally{fundingLock.current=false;setFundingBusy(false)}
  },[account]);
  useEffect(()=>{
    const provider=window.ethereum;
    if(!provider)return;
    const changed=()=>{
      accountRef.current=null;setAccount(null);setTestUsdc(null);setFundingHash('');setFundingStatus('');
      setWalletError('Wallet account or network changed. Reconnect to load the correct portfolio.');
    };
    provider.on?.('accountsChanged',changed);
    provider.on?.('chainChanged',changed);
    return()=>{provider.removeListener?.('accountsChanged',changed);provider.removeListener?.('chainChanged',changed)};
  },[]);
  return <WalletContext.Provider value={{account,connect,testUsdc,fundingBusy,fundingStatus,fundingHash,refreshTestUsdc,requestTestUsdc}}><div className="app-shell"><AppHeader account={account} onConnect={connect} mode={mode}/>{isEarn?(walletError?<p role="alert">{walletError}</p>:null):<DataBanner state={state} error={error||walletError} mode={mode}/>}<main id="main-content" className="app-main">{<Routes><Route index element={state?<ArenaHome state={state} onRetry={retry} retrying={retrying}/>:<section className="loading-state">{error?'Data unavailable. Use Refresh data to retry.':'Opening the arena…'}</section>}/><Route path="agents" element={state?<AgentsPage state={state}/>:<section className="loading-state">Loading agents…</section>}/><Route path="leaderboard" element={state?<Scorecard state={state}/>:<section className="loading-state">Loading scorecard…</section>}/><Route path="portfolio" element={<PortfolioRoute/>}/><Route path="executions" element={<ExecutionRoute/>}/><Route path="executions/:id" element={<ExecutionRoute/>}/><Route path="earn" element={<EarnPage account={account} onConnect={connect}/>}/><Route path="earn/:id" element={<EarnPage account={account} onConnect={connect}/>}/><Route path="*" element={<section className="empty-state"><h1>This page does not exist.</h1><Link to="/app" className="button primary">Back to Arena</Link></section>}/></Routes>}</main><footer className="app-footer"><span>DreamCurve · {isEarn?'Ethereum Sepolia testnet':'Somnia Shannon testnet'}</span><Link to="/methodology">Methodology</Link>{!isEarn?<button onClick={load}>Refresh data</button>:null}</footer></div></WalletContext.Provider>
}
