import { describe, expect, it } from 'vitest';
import { concatHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, toHex, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AAVE, EARN_CHAIN, earnCall, freezeEarn, type EarnProof } from '../shared/earn';
import { verifyEarnEvents } from '../server/earn-protocol';
import { decodeWrapper, executionTypes, TURNKEY, turnkeyAbi, verifySponsoredEnvelope, type EarnVerificationContext, type SponsoredChainEvidence } from '../server/earn-sponsored';
import { earnFixture, earnHash, earnOperator, earnWallet } from './earn-fixtures';

// Public deterministic TEST-ONLY signing identity, never a user credential.
const other = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const blockHash = `0x${'bb'.repeat(32)}` as Hex;
async function fixture() {
  const { intentHash: _, ...body } = earnFixture('APPROVAL','sponsored-approval','LINK');
  const i = freezeEarn({ ...body, walletAddress: earnOperator.address, ...earnCall('APPROVAL',body.amount,earnOperator.address,body.token) });
  const deadline = Math.floor(i.expiresAt/1000), nonce = 0n;
  const signature = await earnOperator.signTypedData({ domain: { name: 'TKGasDelegate', version: '1.1', chainId: EARN_CHAIN, verifyingContract: i.walletAddress }, types: executionTypes, primaryType: 'Execution', message: { nonce, deadline, to: i.token, value: 0n, data: i.calldata } });
  const data = concatHex([signature,toHex(nonce,{ size: 16 }),toHex(deadline,{ size: 4 }),i.calldata]);
  const authorization = await earnOperator.signAuthorization({ contractAddress: TURNKEY.delegate, chainId: EARN_CHAIN, nonce: 0 });
  const tx = { hash: earnHash, chainId: EARN_CHAIN, type: 'eip7702', from: earnWallet, to: TURNKEY.wrapper, value: 0n, nonce: 9, input: encodeFunctionData({ abi: turnkeyAbi, functionName: 'execute', args: [i.walletAddress,i.token,0n,data] }), authorizationList: [authorization], blockNumber: 100n, blockHash, transactionIndex: 1 } as unknown as Transaction;
  const r = { transactionHash: earnHash, status: 'success', type: 'eip7702', from: tx.from, to: tx.to, blockNumber: 100n, blockHash, transactionIndex: 1, logs: [{ address: i.token, data: encodeAbiParameters([{ type: 'uint256' }],[BigInt(i.amount)]), topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: i.walletAddress, spender: i.pool } }) }] } as unknown as TransactionReceipt;
  const e: SponsoredChainEvidence = { blockHash, blockNumber: 100n, timestamp: BigInt(Math.floor(i.createdAt/1000)+1), latestBlock: 110n, latestBlockHash: earnHash, wrapperCodeHash: TURNKEY.wrapperCodeHash, delegateCodeHash: TURNKEY.delegateCodeHash, executorCode: `0xef0100${TURNKEY.delegate.slice(2)}`, executionNonceAfter: 1n, authorizationNonceBefore: 0, authorizationNonceAfter: 1, allowanceAtReceipt: BigInt(i.amount), currentAllowance: BigInt(i.amount) };
  const context: EarnVerificationContext = { keeperHubExecutionId: 'existing-execution', transactionHash: earnHash, intentHash: i.intentHash, broadcastAttemptedAt: i.createdAt };
  return { i,tx,r,e,context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function verify(f: Fixture): Promise<EarnProof> {
  const evidence = await verifySponsoredEnvelope(f.i,earnHash,f.tx,f.r,f.e,f.context);
  verifyEarnEvents(f.i,f.r);
  return { transactionHash: earnHash, blockNumber: '100', chainId: EARN_CHAIN, action: f.i.action, amount: f.i.amount, verified: true, confirmedAt: Date.now(), ...evidence, eventVerified: true as const };
}
function wrapper(f: Fixture, change: Partial<ReturnType<typeof decodeWrapper>>) {
  const d = { ...decodeWrapper(f.tx.input), ...change };
  f.tx.input = encodeFunctionData({ abi: turnkeyAbi, functionName: 'execute', args: [d.executor,d.target,d.value,d.data] });
}
function inner(f: Fixture, input: Hex) {
  const d = decodeWrapper(f.tx.input); wrapper(f,{ data: concatHex([d.signature,toHex(d.nonce,{ size: 16 }),toHex(d.deadline,{ size: 4 }),input]) });
}
describe('strict Turnkey sponsored approval proof',() => {
  it('verifies both signatures, exact call, receipt event and state without changing the frozen intent',async () => {
    const f = await fixture(), before = JSON.stringify(f.i), proof = await verify(f);
    expect(proof.mode).toBe('keeperhub-sponsored-eip7702');
    if (proof.mode !== 'keeperhub-sponsored-eip7702') throw new Error('mode');
    expect(proof.authorizationSigner).toBe(f.i.walletAddress); expect(proof.executionSigner).toBe(f.i.walletAddress);
    expect(proof.outerSender).not.toBe(proof.executor); expect(proof.innerTarget).toBe(f.i.token);
    expect(proof.allowance).toBe('500000000000000000'); expect(proof.stateVerified).toBe(true);
    expect(proof.eventVerified).toBe(true); expect(proof.confirmations).toBe('11'); expect(JSON.stringify(f.i)).toBe(before);
  });
  const cases: [string,(f: Fixture) => void][] = [
    ['wrong executor',f => wrapper(f,{ executor: earnWallet })],
    ['wrong inner target',f => wrapper(f,{ target: AAVE.pool })],
    ['wrong inner value',f => wrapper(f,{ value: 1n })],
    ['wrong calldata with correct event',f => inner(f,'0xdeadbeef')],
    ['wrong amount with correct event',f => inner(f,earnCall('APPROVAL','1',f.i.walletAddress,f.i.token).calldata)],
    ['wrong spender with correct event',f => inner(f,encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [earnWallet,BigInt(f.i.amount)] }))],
    ['wrong wrapper contract',f => { f.tx.to = earnWallet; f.r.to = earnWallet; }],
    ['wrong chain',f => { f.tx.chainId = 1; }],
    ['failed receipt',f => { f.r.status = 'reverted'; }],
    ['wrong native value',f => { f.tx.value = 1n; }],
    ['unrelated transaction hash',f => { f.tx.hash = blockHash; }],
    ['unrelated receipt',f => { f.r.transactionHash = blockHash; }],
    ['wrong receipt sender',f => { f.r.from = f.i.walletAddress; }],
    ['noncanonical block',f => { f.e.blockHash = earnHash; }],
    ['insufficient confirmations',f => { f.e.latestBlock = 100n; }],
    ['wrong bytecode',f => { f.e.wrapperCodeHash = earnHash; }],
    ['wrong delegate code',f => { f.e.delegateCodeHash = earnHash; }],
    ['wrong delegation',f => { f.e.executorCode = '0x'; }],
    ['unconsumed execution nonce',f => { f.e.executionNonceAfter = 0n; }],
    ['skipped authorization nonce',f => { f.e.authorizationNonceBefore = 1; }],
    ['unapplied authorization',f => { f.e.authorizationNonceAfter = 0; }],
    ['wrong current allowance',f => { f.e.currentAllowance = 0n; }],
    ['unlimited allowance',f => { f.e.currentAllowance = 2n**256n-1n; }],
    ['wrong historical allowance',f => { f.e.allowanceAtReceipt = 0n; }],
    ['missing event despite correct state',f => { f.r.logs = []; }],
    ['wrong event amount',f => { f.r.logs[0].data = toHex(1n,{ size: 32 }); }],
    ['unsupported wrapper selector',f => { f.tx.input = `0xdeadbeef${f.tx.input.slice(10)}`; }],
    ['noncanonical trailing bytes',f => { f.tx.input = concatHex([f.tx.input,'0x00']); }],
    ['truncated wrapper',f => wrapper(f,{ data: '0x' })],
    ['replay before broadcast',f => { f.e.timestamp = BigInt(Math.floor(f.i.createdAt/1000)-1); }],
    ['transaction outside intent window',f => { f.e.timestamp = BigInt(Math.floor(f.i.expiresAt/1000)+1); }],
    ['another intent binding',f => { f.context.intentHash = earnHash; }],
    ['another execution hash binding',f => { f.context.transactionHash = blockHash; }],
    ['missing execution ID',f => { f.context.keeperHubExecutionId = ''; }],
  ];
  it.each(cases)('rejects %s',async (_,mutate) => { const f = await fixture(); mutate(f); await expect(verify(f)).rejects.toThrow(); });
  it('rejects correct inner call but a different EIP-7702 signer',async () => {
    const f = await fixture(); if (f.tx.type !== 'eip7702') throw new Error('fixture');
    f.tx.authorizationList = [await other.signAuthorization({ contractAddress: TURNKEY.delegate, chainId: EARN_CHAIN, nonce: 0 })];
    await expect(verify(f)).rejects.toThrow('authorization signer');
  });
  it('rejects correct inner call but a different EIP-712 signer',async () => {
    const f = await fixture(), d = decodeWrapper(f.tx.input);
    const sig = await other.signTypedData({ domain: { name: 'TKGasDelegate', version: '1.1', chainId: EARN_CHAIN, verifyingContract: f.i.walletAddress }, types: executionTypes, primaryType: 'Execution', message: { nonce: d.nonce, deadline: d.deadline, to: d.target, value: 0n, data: d.innerCalldata } });
    wrapper(f,{ data: concatHex([sig,toHex(d.nonce,{ size: 16 }),toHex(d.deadline,{ size: 4 }),d.innerCalldata]) });
    await expect(verify(f)).rejects.toThrow('execution signer');
  });
  it.each([0,1])('rejects EIP-7702 authorization chain %s',async chainId => {
    const f = await fixture(); if (f.tx.type !== 'eip7702') throw new Error('fixture');
    f.tx.authorizationList = [await earnOperator.signAuthorization({ contractAddress: TURNKEY.delegate, chainId, nonce: 0 })];
    await expect(verify(f)).rejects.toThrow('authorization chain');
  });
  it('requires the original durable context',async () => { const f = await fixture(); await expect(verifySponsoredEnvelope(f.i,earnHash,f.tx,f.r,f.e)).rejects.toThrow('durable execution binding'); });
});
