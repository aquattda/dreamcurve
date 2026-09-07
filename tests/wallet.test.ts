import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, EIP1193Provider } from 'viem';
import type { Market } from '../shared/domain';

const mocks=vi.hoisted(()=>{
  const pool='0x1111111111111111111111111111111111111111' as Address;
  const onchain={status:1,expiry:BigInt(Math.floor(Date.now()/1000)+3600),pool,decimals:6};
  const getMarketOnchain=vi.fn().mockResolvedValue(onchain);
  const getBinaryOrderBook=vi.fn().mockResolvedValue({yesBids:[],yesAsks:[],noBids:[],noAsks:[]});
  const getBinaryBookParams=vi.fn().mockResolvedValue({tickSize:1_000n,minQuantity:1_000_000n,lotSize:1_000_000n});
  const placeOrder=vi.fn().mockResolvedValue({hash:'0xabc',receipt:{status:'success'},fills:[],orderId:null});
  const createTrader=vi.fn((_config:unknown)=>({placeOrder}));
  const quoteBinaryStakeOverBook=vi.fn(()=>({side:'BUY_YES',yesPrice:510_000n,limitPrice:510_000n,quantity:19_000_000n,escrow:9_690_000n}));
  return {pool,onchain,getMarketOnchain,getBinaryOrderBook,getBinaryBookParams,placeOrder,createTrader,quoteBinaryStakeOverBook};
});

vi.mock('@somnia-chain/markets-sdk',()=>({
  SomniaMarkets:class {client={
    getMarketOnchain:mocks.getMarketOnchain,
    getBinaryOrderBook:mocks.getBinaryOrderBook,
    getBinaryBookParams:mocks.getBinaryBookParams,
    createTrader:mocks.createTrader,
  }},
  SOMNIA_TESTNET_ADDRESSES:{collateral:'0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E'},
  SOMNIA_TESTNET_PRICE_FEED:{},
  ORDER_TYPE:{MARKET:0},
  quoteBinaryStakeOverBook:mocks.quoteBinaryStakeOverBook,
}));

import { placeStake } from '../src/wallet';
import { readJournal } from '../src/portfolio/journal';

const account='0x2b270B135667f38bB58Fc9376F29c95173641D31' as Address;
const market:Market={
  id:`0x${'22'.repeat(32)}`,title:'BTC test',asset:'BTC',pool:mocks.pool,venueId:'test',
  expiry:Date.now()+3_600_000,interval:3600,status:'Trading',strike:80_000,spot:80_100,updatedAt:Date.now(),source:'live',
  yesBids:[],yesAsks:[],noBids:[],noAsks:[],priceDecimals:6,collateralDecimals:6,tick:'1000',lot:'1000000',
  collateral:'0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E',yesId:'1',noId:'2',
};

describe('wallet trade path',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.onchain.expiry=BigInt(Math.floor(Date.now()/1000)+3600);
    Object.defineProperty(globalThis,'window',{configurable:true,value:{ethereum:{
      request:vi.fn(async({method}:{method:string})=>method==='eth_chainId'?'0xc488':null),
    } as unknown as EIP1193Provider}});
  });

  it('quotes from a one-shot on-chain book without opening a subscription',async()=>{
    const quoted=vi.fn();
    const result=await placeStake({...market,expiry:Date.now()+3_600_000},'YES','10',account,quoted);

    expect(mocks.getBinaryOrderBook).toHaveBeenCalledWith(mocks.pool,{depth:10,decimals:6});
    expect(mocks.getBinaryBookParams).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.quoteBinaryStakeOverBook).toHaveBeenCalledOnce();
    expect(quoted).toHaveBeenCalledWith({shares:'19',maxCost:'9.69',limit:'0.51'});
    expect(mocks.placeOrder).toHaveBeenCalledOnce();
    expect(mocks.createTrader.mock.calls[0]).toBeDefined();
    // SDK 0.29's receipt waiter requires a transport with subscribe(newHeads).
    const config=mocks.createTrader.mock.calls[0][0] as unknown as {publicClient:{transport:{type:string;subscribe:unknown}}};
    expect(config.publicClient.transport.type).toBe('webSocket');
    expect(typeof config.publicClient.transport.subscribe).toBe('function');
    expect(result.hash).toBe('0xabc');
  });

  it('stores actual receipt fills and the real hash, never the indicative quote',async()=>{
    const hash=`0x${'cd'.repeat(32)}`;
    mocks.placeOrder.mockResolvedValueOnce({hash,receipt:{status:'success'},fills:[{quantityFilled:20_000_000n,fillPrice:250_000n,takerOrderId:456n,makerOrderId:123n,takerRemainingQuantity:0n,makerRemainingQuantity:0n}],orderId:456n});
    await placeStake({...market,expiry:Date.now()+3_600_000},'YES','10',account);
    const row=readJournal(account).find(r=>r.txHash===hash);
    expect(row).toMatchObject({kind:'Trades',status:'Confirmed',shares:20,price:.25,total:5,orderId:'456',source:'Wallet receipt'});
    expect(row?.timestamp).toBeNull(); // Missing block time is not replaced by an invented execution time.
  });
});
