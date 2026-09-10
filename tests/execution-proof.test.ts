import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type AbiEvent, type Log, type TransactionReceipt } from 'viem';
import { orderBookEventsAbi } from '@somnia-chain/markets-sdk';
import { parseProof } from '../server/execution-protocol';
import { fixtureIntent, wallet, pool, token, txHash, operator } from './execution-fixtures';

function log(abi: readonly unknown[], name: string, args: Record<string, unknown>, address = pool): Log {
  const event = abi.find(e => (e as AbiEvent).type === 'event' && (e as AbiEvent).name === name) as AbiEvent;
  return { address, data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name!])), topics: encodeEventTopics({ abi: [event], eventName: name, args }) } as Log;
}
function receipt(logs: Log[]): TransactionReceipt { return { transactionHash: txHash, from: wallet, to: pool, status: 'success', blockNumber: 1n, logs } as TransactionReceipt; }
function tradeLogs(filled: bigint, rested = false) {
  const intent = fixtureIntent();
  const placedOrder = { orderId: 7n, isBid: true, owner: wallet, userData: 0n, price: 500000n, fullQuantity: 20000000n, quantityRemaining: 20000000n - filled, expireTimestampNs: BigInt(intent.expireTimestampNs) };
  const logs = [log(orderBookEventsAbi, 'OrderPlaced', { orderId: 7n, placedOrder })];
  if (filled) logs.push(log(orderBookEventsAbi, 'OrderFilled', { takerOrderId: 7n, makerOrderId: 6n, quantityFilled: filled, takerRemainingQuantity: 20000000n-filled, makerRemainingQuantity: 0n, fillPrice: 500000n }));
  if (rested) logs.push(log(orderBookEventsAbi, 'OrderRested', { orderId: 7n }));
  return { intent, logs };
}
describe('independent dreamDEX receipt verification', () => {
  it.each([[0n,false,'PLACED'],[0n,true,'RESTING'],[10000000n,false,'PARTIALLY_FILLED'],[20000000n,false,'FILLED']] as const)('classifies %s fill / rested %s as %s', (filled,rested,status) => {
    const {intent,logs} = tradeLogs(filled,rested);
    const proof = parseProof(intent,receipt(logs),12345);
    expect(proof.orderStatus).toBe(status); expect(proof.filledQuantity).toBe(filled.toString()); expect(proof.confirmedAt).toBe(12345);
  });
  it('rejects a reverted receipt, wrong sender and unrelated pool events', () => {
    const { intent,logs } = tradeLogs(0n);
    expect(() => parseProof(intent,{...receipt(logs),status:'reverted'},1)).toThrow(/reverted/);
    expect(() => parseProof(intent,{...receipt(logs),from:operator.address},1)).toThrow(/sender/);
    expect(() => parseProof(intent,receipt(logs.map(l=>({...l,address:token}))),1)).toThrow(/OrderPlaced/);
  });
  it('does not count unrelated maker fills as this order execution', () => {
    const {intent,logs} = tradeLogs(0n);
    logs.push(log(orderBookEventsAbi,'OrderFilled',{takerOrderId:999n,makerOrderId:7n,quantityFilled:20000000n,takerRemainingQuantity:0n,makerRemainingQuantity:0n,fillPrice:500000n}));
    expect(parseProof(intent,receipt(logs),1).orderStatus).toBe('PLACED');
  });
  it('records actual collateral transfer evidence, not the indicative quote', () => {
    const {intent,logs} = tradeLogs(10000000n);
    logs.push(log(erc20Abi,'Transfer',{from:wallet,to:pool,value:5000000n},token));
    expect(parseProof(intent,receipt(logs),1).collateralMoved).toBe('5000000');
  });
  it('requires the exact bounded allowance in an Approval event', () => {
    const intent = fixtureIntent({kind:'APPROVAL'});
    const valid = log(erc20Abi,'Approval',{owner:wallet,spender:pool,value:10000000n},token);
    expect(parseProof(intent,{...receipt([valid]),to:token},1).orderStatus).toBe('APPROVED');
    const wrong = log(erc20Abi,'Approval',{owner:wallet,spender:pool,value:1n},token);
    expect(() => parseProof(intent,{...receipt([wrong]),to:token},1)).toThrow(/Approval/);
  });
});
