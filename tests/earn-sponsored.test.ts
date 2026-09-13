import { describe, expect, it } from 'vitest';
import { concatHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, toHex, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AAVE, EARN_CHAIN, earnAbi, earnCall, freezeEarn, type EarnProof } from '../shared/earn';
import { A_LINK, aTokenProofAbi } from '../server/earn-supply';
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

async function supplyFixture(reused = true) {
  const f = await fixture(), { intentHash: _, ...body } = f.i;
  f.i = freezeEarn({ ...body, action: 'SUPPLY', ...earnCall('SUPPLY',body.amount,body.walletAddress,body.token) });
  f.context.intentHash = f.i.intentHash;
  const nonce = reused ? 1n : 0n, deadline = Math.floor(f.i.expiresAt/1000), amount = BigInt(f.i.amount);
  const signature = await earnOperator.signTypedData({ domain: { name: 'TKGasDelegate', version: '1.1', chainId: EARN_CHAIN, verifyingContract: f.i.walletAddress }, types: executionTypes, primaryType: 'Execution', message: { nonce, deadline, to: f.i.pool, value: 0n, data: f.i.calldata } });
  f.tx = { ...f.tx, type: reused ? 'eip1559' : 'eip7702', authorizationList: reused ? undefined : f.tx.authorizationList,
    input: encodeFunctionData({ abi: turnkeyAbi, functionName: 'execute', args: [f.i.walletAddress,f.i.pool,0n,concatHex([signature,toHex(nonce,{ size: 16 }),toHex(deadline,{ size: 4 }),f.i.calldata])] }) } as Transaction;
  f.r.type = f.tx.type;
  f.r.logs = [
    { address: f.i.pool, topics: encodeEventTopics({ abi: earnAbi, eventName: 'Supply', args: { reserve: f.i.token, onBehalfOf: f.i.walletAddress, referralCode: 0 } }), data: encodeAbiParameters([{ type: 'address' },{ type: 'uint256' }],[f.i.walletAddress,amount]) },
    { address: f.i.token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: f.i.walletAddress, to: f.i.aToken } }), data: toHex(amount,{ size: 32 }) },
  ] as TransactionReceipt['logs'];
  f.e = { ...f.e, executorCodeBefore: f.e.executorCode, executionNonceBefore: nonce, executionNonceAfter: nonce+1n,
    wrapperCodeHashBefore: TURNKEY.wrapperCodeHash, delegateCodeHashBefore: TURNKEY.delegateCodeHash,
    authorizationNonceBefore: reused ? 1 : 0, authorizationNonceAfter: 1, allowanceAtReceipt: 0n, currentAllowance: 0n,
    supply: { tokenBefore: amount*2n, tokenAfter: amount, allowanceBefore: amount, scaledBefore: 0n, scaledAfter: amount, currentScaled: amount, previousIndexBefore: 0n, indexAfter: 10n**27n,
      implementationBefore: `0x${'0'.repeat(24)}${A_LINK.implementation.slice(2)}`, implementationAfter: `0x${'0'.repeat(24)}${A_LINK.implementation.slice(2)}`, implementationCodeHash: A_LINK.codeHash, pool: f.i.pool, underlying: f.i.token } };
  mintEvent(f,amount,0n,10n**27n);
  return f;
}
function mintEvent(f: Fixture, value: bigint, interest: bigint, index: bigint) {
  f.r.logs[2] = { address: f.i.aToken, topics: encodeEventTopics({ abi: aTokenProofAbi, eventName: 'Mint', args: { caller: f.i.walletAddress, onBehalfOf: f.i.walletAddress } }), data: encodeAbiParameters([{ type: 'uint256' },{ type: 'uint256' },{ type: 'uint256' }],[value,interest,index]) } as TransactionReceipt['logs'][number];
}
describe.each([false,true])('strict sponsored LINK supply (reuse delegation = %s)',reused => {
  it('verifies exact supply with independently checked state and explicit authorization mode',async () => {
    const f = await supplyFixture(reused), original = JSON.stringify(f.i), proof = await verify(f);
    if (proof.mode !== 'keeperhub-sponsored-eip7702') throw new Error('mode');
    expect(proof.authorizationMode).toBe(reused ? 'existing-delegation' : 'included-eip7702');
    expect(proof.authorizationSigner).toBe(reused ? null : f.i.walletAddress);
    expect(proof.outerType).toBe(reused ? 'eip1559' : 'eip7702');
    expect(proof.executionSigner).toBe(f.i.walletAddress); expect(proof.allowance).toBe('0');
    expect(proof.supply?.scaledMinted).toBe(f.i.amount); expect(JSON.stringify(f.i)).toBe(original);
  });
  it('separates accrued interest from principal using exact ray half-up accounting',async () => {
    const f = await supplyFixture(reused), s = f.e.supply!, ray = 10n**27n, amount = BigInt(f.i.amount);
    s.scaledBefore = amount; s.previousIndexBefore = ray; s.indexAfter = ray*11n/10n;
    const interest = amount/10n, minted = (amount*ray+s.indexAfter/2n)/s.indexAfter;
    s.scaledAfter = amount+minted; s.currentScaled = s.scaledAfter;
    mintEvent(f,amount+interest,interest,s.indexAfter);
    const proof = await verify(f); if (proof.mode !== 'keeperhub-sponsored-eip7702') throw new Error('mode');
    expect(proof.supply?.scaledMinted).toBe(minted.toString()); expect(proof.supply?.accruedInterest).toBe(interest.toString());
  });
  const cases: [string,(f: Fixture) => void][] = [
    ['wrong executor',f => wrapper(f,{ executor: earnWallet })],
    ['wrong target',f => wrapper(f,{ target: f.i.token })],
    ['wrong amount despite correct events',f => inner(f,earnCall('SUPPLY','1',f.i.walletAddress,f.i.token).calldata)],
    ['wrong beneficiary',f => inner(f,earnCall('SUPPLY',f.i.amount,earnWallet,f.i.token).calldata)],
    ['wrong referral code',f => inner(f,encodeFunctionData({ abi: earnAbi, functionName: 'supply', args: [f.i.token,BigInt(f.i.amount),f.i.walletAddress,1] }))],
    ['wrong chain',f => { f.tx.chainId = 1; }],
    ['failed receipt',f => { f.r.status = 'reverted'; }],
    ['wrong wrapper',f => { f.tx.to = earnWallet; }],
    ['invalid inner signature',f => { const d = decodeWrapper(f.tx.input); wrapper(f,{ data: concatHex([`0x${'00'.repeat(65)}`,toHex(d.nonce,{ size: 16 }),toHex(d.deadline,{ size: 4 }),d.innerCalldata]) }); }],
    ['replayed nonce',f => { f.e.executionNonceBefore = 99n; }],
    ['nonce not consumed',f => { f.e.executionNonceAfter = f.e.executionNonceBefore!; }],
    ['unrelated intent',f => { f.context.intentHash = earnHash; }],
    ['unrelated receipt',f => { f.r.transactionHash = blockHash; }],
    ['missing Supply',f => { f.r.logs.splice(0,1); }],
    ['missing underlying Transfer',f => { f.r.logs.splice(1,1); }],
    ['missing aToken Mint',f => { f.r.logs.splice(2,1); }],
    ['duplicate mint',f => { f.r.logs.push(f.r.logs[2]); }],
    ['wrong mint token',f => { f.r.logs[2].address = f.i.token; }],
    ['wrong minted principal',f => mintEvent(f,1n,0n,10n**27n)],
    ['invented accrued interest',f => mintEvent(f,BigInt(f.i.amount)+1n,1n,10n**27n)],
    ['wrong underlying debit',f => { f.e.supply!.tokenAfter += 1n; }],
    ['extra approval',f => { f.e.supply!.allowanceBefore += 1n; }],
    ['allowance not consumed',f => { f.e.allowanceAtReceipt = 1n; }],
    ['current allowance changed',f => { f.e.currentAllowance = 1n; }],
    ['scaled mint one unit wrong',f => { f.e.supply!.scaledAfter -= 1n; }],
    ['current position changed',f => { f.e.supply!.currentScaled = 0n; }],
    ['wrong liquidity index',f => { f.e.supply!.indexAfter = 0n; }],
    ['upgraded aToken implementation',f => { f.e.supply!.implementationAfter = earnHash; }],
    ['unknown aToken code',f => { f.e.supply!.implementationCodeHash = earnHash; }],
    ['wrong aToken underlying',f => { f.e.supply!.underlying = earnWallet; }],
    ['wrong aToken pool',f => { f.e.supply!.pool = earnWallet; }],
    ['missing state evidence',f => { f.e.supply = undefined; }],
  ];
  it.each(cases)('rejects %s',async (_,mutate) => { const f = await supplyFixture(reused); mutate(f); await expect(verify(f)).rejects.toThrow(); });
});
describe('existing delegation is not a skipped authorization check',() => {
  it.each(['missing delegation','changed delegate code','changed wrapper code','changed account nonce'])('rejects %s',async fault => {
    const f = await supplyFixture();
    if (fault === 'missing delegation') f.e.executorCodeBefore = '0x';
    if (fault === 'changed delegate code') f.e.delegateCodeHashBefore = earnHash;
    if (fault === 'changed wrapper code') f.e.wrapperCodeHashBefore = earnHash;
    if (fault === 'changed account nonce') f.e.authorizationNonceAfter++;
    await expect(verify(f)).rejects.toThrow();
  });
  it('does not treat missing EIP-7702 authorization as delegation reuse',async () => {
    const f = await supplyFixture(false); f.tx.authorizationList = []; await expect(verify(f)).rejects.toThrow('single EIP-7702 authorization');
  });
});
