import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, ORDER_TYPE, type Portfolio } from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, custom, erc20Abi, http, type Address, type EIP1193Provider, formatUnits } from 'viem';
import type { Market, Side } from '../shared/domain';
import { decimalRaw } from '../shared/domain';

declare global { interface Window { ethereum?: EIP1193Provider } }
const INDEXER='https://dev.smk.somnia.host/v1/graphql';
const WS='wss://api.infra.testnet.somnia.network/ws';
const RPC='https://dream-rpc.somnia.network';
const publicClient=createPublicClient({chain:somniaShannon,transport:http(RPC,{timeout:15_000,retryCount:1})});

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
    await provider.request({method:'wallet_addEthereumChain',params:[{chainId:'0xc488',chainName:'Somnia Testnet',nativeCurrency:{name:'STT',symbol:'STT',decimals:18},rpcUrls:[RPC],blockExplorerUrls:['https://shannon-explorer.somnia.network']}]});
  }
}
export async function connectWallet(){
  if(!window.ethereum)throw new Error('No browser wallet found. Install MetaMask or another EVM wallet.');
  await switchShannon(window.ethereum);
  const accounts=await window.ethereum.request({method:'eth_requestAccounts'}) as Address[];
  if(!accounts[0])throw new Error('The wallet did not provide an account.');
  return accounts[0];
}
function sdkFor(account:Address){
  if(!window.ethereum)throw new Error('Wallet disconnected.');
  const walletClient=createWalletClient({account,chain:somniaShannon,transport:custom(window.ethereum)});
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
  const trader=sdk.client.createTrader({walletClient,publicClient});
  const result=await trader.faucet({testUsdc:testUsdcAddress()});
  if(result.receipt.status!=='success')throw new Error('The tUSDC faucet transaction was mined but reverted.');
  return {hash:result.hash};
}
export async function placeStake(m:Market,side:Side,stakeText:string,account:Address,onQuoted?:(q:{shares:string;maxCost:string;limit:string})=>void){
  if(m.source!=='live')throw new Error('Trading is disabled for illustrative data.');
  const {sdk,walletClient}=sdkFor(account);
  const chainId=await walletClient.getChainId();if(chainId!==50312)throw new Error('Switch your wallet to Somnia Testnet.');
  const onchain=await sdk.client.getMarketOnchain(m.id as `0x${string}`);
  if(onchain.status!==1)throw new Error('This market is no longer trading.');
  const now=Date.now();const expiry=Number(onchain.expiry)*1000;
  if(expiry-now<=Math.min(60_000,Math.max(10_000,m.interval*100)))throw new Error('Too close to expiry to submit safely.');
  const watch=await sdk.client.watchMarket(onchain.pool);
  try{
    const stake=decimalRaw(stakeText,onchain.decimals);
    const quote=await sdk.client.quoteBinaryStake({marketId:m.id,side:`BUY_${side}` as 'BUY_YES'|'BUY_NO',stake,slippageBps:200n,slippageMinTicks:2n});
    if(!quote)throw new Error('No fillable quote for this amount. Try another market or amount.');
    onQuoted?.({shares:formatUnits(quote.quantity,onchain.decimals),maxCost:formatUnits(quote.escrow,onchain.decimals),limit:formatUnits(quote.limitPrice,onchain.decimals)});
    const latest=await sdk.client.getMarketOnchain(m.id as `0x${string}`);if(latest.status!==1)throw new Error('Market locked before submission.');
    const trader=sdk.client.createTrader({walletClient,publicClient});
    const expiresMs=Math.min(expiry-1000,Date.now()+30_000);if(expiresMs<=Date.now())throw new Error('There is no safe order lifetime remaining.');
    const result=await trader.placeOrder({pool:onchain.pool,side:`BUY_${side}` as 'BUY_YES'|'BUY_NO',price:quote.yesPrice,quantity:quote.quantity,orderType:ORDER_TYPE.MARKET,expireTimestampNs:BigInt(Math.floor(expiresMs))*1_000_000n,autoApprove:true});
    if(result.receipt.status!=='success')throw new Error('The transaction was mined but reverted.');
    return {hash:result.hash,fills:result.fills.length,restingOrderId:result.orderId?.toString()||null};
  }finally{watch.stop();}
}
export async function loadPortfolio(account:Address):Promise<Portfolio>{const {sdk}=sdkFor(account);return sdk.client.getPortfolio(account,{ordersLimit:50,tradesLimit:50});}
export async function cancelOrder(pool:string,orderId:string,account:Address){const {sdk,walletClient}=sdkFor(account);const trader=sdk.client.createTrader({walletClient,publicClient});const result=await trader.cancelOrder({pool:pool as Address,orderId});if(result.receipt.status!=='success')throw new Error('Cancel transaction reverted.');return result.hash;}
export async function redeemAll(account:Address){const {sdk,walletClient}=sdkFor(account);const claimable=await sdk.client.getClaimable(account);if(!claimable.length)throw new Error('No claimable positions were found.');const trader=sdk.client.createTrader({walletClient,publicClient});const result=await trader.redeemMany({entries:claimable.map(c=>({marketId:c.marketId as `0x${string}`,outcomeIdx:c.outcomeIdx,amount:c.amount}))});if(result.receipt.status!=='success')throw new Error('Redeem transaction reverted.');return {hash:result.hash,count:claimable.length};}
