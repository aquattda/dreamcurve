import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, ORDER_TYPE, quoteBinaryStakeOverBook, type Portfolio } from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, custom, erc20Abi, http, webSocket, type Address, type EIP1193Provider, formatUnits } from 'viem';
import { EXPLORER_URL, isTxHash } from './portfolio/format';
import { readJournal, saveActivity } from './portfolio/journal';
import type { Activity } from './portfolio/types';
import type { Market, Side } from '../shared/domain';
import { decimalRaw } from '../shared/domain';

declare global { interface Window { ethereum?: EIP1193Provider } }
const INDEXER='https://dev.smk.somnia.host/v1/graphql';
const WS='wss://api.infra.testnet.somnia.network/ws';
const RPC='https://dream-rpc.somnia.network';
const publicClient=createPublicClient({chain:somniaShannon,transport:http(RPC,{timeout:15_000,retryCount:1})});
// SDK 0.29 waits for receipts with transport.subscribe('newHeads'). HTTP has no
// subscribe method. Keep HTTP for balance/recovery reads, WS for the SDK writer.
const transactionClient=createPublicClient({chain:somniaShannon,transport:webSocket(WS,{timeout:20_000,retryCount:1})});
export type TransactionProgress=(message:string,hash?:string)=>void;

function testUsdcAddress(){
  const address=SOMNIA_TESTNET_ADDRESSES.collateral??SOMNIA_TESTNET_ADDRESSES.testUsdc;
  if(!address)throw new Error('The Shannon test tUSDC contract is not configured.');
  return address;
}

async function switchShannon(provider:EIP1193Provider){
  try { await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xc488'}]}); }
  catch(e:unknown){
    const code=(e as {code?:number}).code;
    if(code!==4902)throw e;
    await provider.request({method:'wallet_addEthereumChain',params:[{chainId:'0xc488',chainName:'Somnia Testnet',nativeCurrency:{name:'STT',symbol:'STT',decimals:18},rpcUrls:[RPC],blockExplorerUrls:[EXPLORER_URL]}]});
  }
}
export async function connectWallet(){
  if(!window.ethereum)throw new Error('No browser wallet found. Install MetaMask or another EVM wallet.');
  await switchShannon(window.ethereum);
  const accounts=await window.ethereum.request({method:'eth_requestAccounts'}) as Address[];
  if(!accounts[0])throw new Error('The wallet did not provide an account.');
  return accounts[0];
}
export function sdkFor(account:Address,onProgress?:TransactionProgress){
  if(!window.ethereum)throw new Error('Wallet disconnected.');
  const provider=window.ethereum;
  const walletClient=createWalletClient({account,chain:somniaShannon,transport:custom({request:async(args)=>{
    if(args.method==='eth_sendTransaction') {
      const [chain,accounts]=await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);
      if(chain!=='0xc488'||accounts[0]?.toLowerCase()!==account.toLowerCase())throw new Error('Wallet account or network changed. Reconnect before signing.');
    }
    const result=await provider.request(args);
    if(args.method==='eth_sendTransaction'&&isTxHash(result)){
      const stored=saveActivity(account,{id:result,kind:'Wallet',action:'Wallet transaction',marketTitle:'Awaiting indexed transaction details',side:null,shares:null,price:null,total:null,fee:null,timestamp:Date.now(),txHash:result,status:'Pending',source:'Wallet submission',note:'May be an approval or contract call. Submission time shown; execution details appear after confirmation.'});
      onProgress?.(`Transaction submitted. Confirming…${stored?'':' Browser storage unavailable; keep this transaction hash.'}`,result);
    }
    return result;
  },},{retryCount:0})});
  const sdk=new SomniaMarkets({chain:somniaShannon,wsRpcUrl:WS,indexerUrl:INDEXER,addresses:SOMNIA_TESTNET_ADDRESSES,priceFeed:SOMNIA_TESTNET_PRICE_FEED,walletClient});
  return {sdk,walletClient};
}
export async function loadTestUsdcBalance(account:Address){
  const address=testUsdcAddress();
  const [balance,decimals]=await Promise.all([
    publicClient.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[account]}),
    publicClient.readContract({address,abi:erc20Abi,functionName:'decimals'}),
  ]);
  return {raw:balance,decimals,formatted:formatUnits(balance,decimals)};
}
export async function claimTestUsdc(account:Address){
  const {sdk,walletClient}=sdkFor(account);
  const chainId=await walletClient.getChainId();
  if(chainId!==50312)throw new Error('Switch your wallet to Somnia Testnet.');
  const trader=sdk.client.createTrader({walletClient,publicClient:transactionClient});
  const result=await trader.faucet({testUsdc:testUsdcAddress()});
  if(result.receipt.status!=='success')throw new Error('The tUSDC faucet transaction was mined but reverted.');
  return {hash:result.hash};
}
export async function placeStake(m:Market,side:Side,stakeText:string,account:Address,onQuoted?:(q:{shares:string;maxCost:string;limit:string})=>void,onProgress?:TransactionProgress){
  if(m.source!=='live')throw new Error('Trading is disabled for illustrative data.');
  if(m.dataWarning)throw new Error(m.dataWarning);
  const {sdk,walletClient}=sdkFor(account,onProgress);
  const chainId=await walletClient.getChainId();if(chainId!==50312)throw new Error('Switch your wallet to Somnia Testnet.');
  const onchain=await sdk.client.getMarketOnchain(m.id as `0x${string}`);
  if(onchain.status!==1)throw new Error('This market is no longer trading.');
  const now=Date.now();const expiry=Number(onchain.expiry)*1000;
  if(expiry-now<=Math.min(60_000,Math.max(10_000,m.interval*100)))throw new Error('Too close to expiry to submit safely.');
  const stake=decimalRaw(stakeText,onchain.decimals);
  if(stake<=0n)throw new Error('Stake must be greater than zero.');
  const [book,grid]=await Promise.all([
    sdk.client.getBinaryOrderBook(onchain.pool,{depth:10,decimals:onchain.decimals}),
    sdk.client.getBinaryBookParams(onchain.pool),
  ]);
  const orderSide=`BUY_${side}` as 'BUY_YES'|'BUY_NO';
  const quote=quoteBinaryStakeOverBook(book,orderSide,stake,10n**BigInt(onchain.decimals),{...grid,slippageBps:200n,slippageMinTicks:2n});
  if(!quote)throw new Error('No fillable quote for this amount. Try another market or amount.');
  onQuoted?.({shares:formatUnits(quote.quantity,onchain.decimals),maxCost:formatUnits(quote.escrow,onchain.decimals),limit:formatUnits(quote.limitPrice,onchain.decimals)});
  const latest=await sdk.client.getMarketOnchain(m.id as `0x${string}`);if(latest.status!==1)throw new Error('Market locked before submission.');
  const trader=sdk.client.createTrader({walletClient,publicClient:transactionClient});
  const expiresMs=Math.min(expiry-1000,Date.now()+30_000);if(expiresMs<=Date.now())throw new Error('There is no safe order lifetime remaining.');
  const result=await trader.placeOrder({pool:onchain.pool,side:orderSide,price:quote.yesPrice,quantity:quote.quantity,orderType:ORDER_TYPE.MARKET,expireTimestampNs:BigInt(Math.floor(expiresMs))*1_000_000n,autoApprove:true});
  if(result.receipt.status!=='success')throw new Error('The transaction was mined but reverted.');
  const one=10n**BigInt(onchain.decimals);
  const quantity=result.fills.reduce((sum,f)=>sum+f.quantityFilled,0n);
  const total=result.fills.reduce((sum,f)=>sum+f.quantityFilled*(side==='NO'?one-f.fillPrice:f.fillPrice)/one,0n);
  let executedAt:number|null=null;
  try{if(result.receipt.blockNumber!=null)executedAt=Number((await publicClient.getBlock({blockNumber:result.receipt.blockNumber})).timestamp)*1000}catch{/* The hash and receipt remain valid if block metadata is delayed. */}
  saveActivity(account,{id:result.hash,kind:quantity>0n?'Trades':'Orders',action:quantity>0n?`BUY ${side}`:'Order submitted (no fills)',marketId:m.id,marketTitle:m.title,side,
    shares:quantity>0n?Number(formatUnits(quantity,onchain.decimals)):null,price:quantity>0n?Number(formatUnits(total*one/quantity,onchain.decimals)):null,
    total:quantity>0n?Number(formatUnits(total,onchain.decimals)):null,fee:null,timestamp:executedAt,txHash:result.hash,
    orderId:result.orderId?.toString()??result.fills[0]?.takerOrderId.toString(),status:'Confirmed',source:'Wallet receipt',note:'Receipt fill aggregate; the indexer will replace it with individual fills. Fee is not separately exposed.'});
  return {hash:result.hash,fills:result.fills.length,restingOrderId:result.orderId?.toString()||null};
}
export async function loadPortfolio(account:Address):Promise<Portfolio>{const {sdk}=sdkFor(account);return sdk.client.getPortfolio(account,{ordersLimit:50,tradesLimit:50});}
export async function cancelOrder(pool:string,orderId:string,account:Address,onProgress?:TransactionProgress){
  const {sdk,walletClient}=sdkFor(account,onProgress);
  const detail=await sdk.client.getOrder(pool,orderId);
  if(!detail||detail.status!=='Open')throw new Error('This order is no longer open. Refresh the portfolio.');
  const trader=sdk.client.createTrader({walletClient,publicClient:transactionClient});
  const result=await trader.cancelOrder({pool:pool as Address,orderId});
  if(result.receipt.status!=='success')throw new Error('Cancel transaction reverted.');
  saveActivity(account,{id:result.hash,kind:'Orders',action:'CANCEL ORDER',marketTitle:'Order cancellation',side:null,shares:null,price:null,total:null,fee:null,timestamp:null,txHash:result.hash,orderId,status:'Confirmed',source:'Wallet receipt'});
  return result.hash;
}
export async function redeemAll(account:Address,onProgress?:TransactionProgress){
  const {sdk,walletClient}=sdkFor(account,onProgress);
  const claimable=await sdk.client.getClaimable(account);
  if(!claimable.length)throw new Error('No claimable positions were found.');
  onProgress?.('Awaiting MetaMask…');
  const trader=sdk.client.createTrader({walletClient,publicClient:transactionClient});
  const result=await trader.redeemMany({entries:claimable.map(c=>({marketId:c.marketId as `0x${string}`,outcomeIdx:c.outcomeIdx,amount:c.amount}))});
  if(result.receipt.status!=='success')throw new Error('Redeem transaction reverted.');
  saveActivity(account,{id:result.hash,kind:'Redeems',action:'REDEEM',marketTitle:`${claimable.length} redeemed position(s)`,side:null,shares:null,price:null,total:null,fee:null,timestamp:null,txHash:result.hash,status:'Confirmed',source:'Wallet receipt',note:'Actual payout and per-market detail will appear when indexed.'});
  onProgress?.('Redeemed ✓',result.hash);
  return {hash:result.hash,count:claimable.length};
}
export async function reconcileJournal(account:Address){
  await Promise.all(readJournal(account).filter(r=>r.status==='Pending').slice(0,20).map(async(row:Activity)=>{
    if(!isTxHash(row.txHash))return;
    try{
      const receipt=await publicClient.getTransactionReceipt({hash:row.txHash});
      let timestamp:number|null=null;
      try{timestamp=Number((await publicClient.getBlock({blockNumber:receipt.blockNumber})).timestamp)*1000}catch{}
      saveActivity(account,{...row,status:receipt.status==='success'?'Confirmed':'Failed',timestamp,source:'Wallet receipt',note:'Receipt verified on-chain. Detailed execution data may still be indexing.'});
    }catch{/* Not found / RPC timeout is not proof of failure. Never resend automatically. */}
  }));
}
