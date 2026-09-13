import { decodeFunctionData, encodeFunctionData, parseAbi, recoverTypedDataAddress, sliceHex, type Address, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { EARN_CHAIN, verifyEarn, type EarnIntent, type SponsoredEarnEvidence } from '../shared/earn';
import { ExecutionError } from '../shared/execution';

// Turnkey's official v1.1 Sepolia deployment (not an arbitrary sponsor address).
// https://github.com/tkhq/gas-station#deployments-v11
// Runtime hashes independently read at Sepolia block 11671820. These pins are
// deployment trust anchors, NOT a claim of a reproducible source compilation.
export const TURNKEY = {
  wrapper: '0x5af5194b4b0909eb978e3cf1e25333852277f07d',
  delegate: '0x955d84139e7621bc571b117d8eb5d28a4a222c6f',
  wrapperCodeHash: '0xe4d6148bc2ecd5409b1c3b488cd54a099957a57104310009e42055e10ec66daa',
  delegateCodeHash: '0x5db3af5e712d94b894ac715ecc2f57145fb56a663354ee192087e6bf6d729f61',
} as const;
export const turnkeyAbi = parseAbi(['function execute(address executor,address target,uint256 value,bytes data)']);
export const turnkeyNonceAbi = parseAbi(['function nonce() view returns (uint128)']);
export const executionTypes = { Execution: [
  { name: 'nonce', type: 'uint128' }, { name: 'deadline', type: 'uint32' },
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
] } as const;
export type EarnVerificationContext = {
  keeperHubExecutionId: string; transactionHash: Hex; intentHash: Hex; broadcastAttemptedAt: number;
};
// Constructed only by the server's chain reader, never from KeeperHub / HTTP
// proof fields. Code hashes are computed locally from historical RPC bytecode.
export type SponsoredChainEvidence = {
  blockHash: Hex; blockNumber: bigint; timestamp: bigint; latestBlock: bigint; latestBlockHash: Hex;
  wrapperCodeHash: Hex; delegateCodeHash: Hex; executorCode: Hex;
  executionNonceAfter: bigint; allowanceAtReceipt: bigint; currentAllowance: bigint;
  authorizationNonceBefore: number; authorizationNonceAfter: number;
};
function requireProof(ok: unknown, field: string): asserts ok {
  if (!ok) throw new ExecutionError('PROOF_MISMATCH', `Sponsored proof mismatch: ${field}. No resend.`);
}
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** Verifies the envelope and authorization, NOT an event-only proof. The caller
 * must additionally run the shared exact receipt event checks before persisting.
 * Only the audited single-call APPROVAL path is enabled; batches, other wrapper
 * overloads, and pre-existing delegation without this authorization fail closed.
 */
export async function verifySponsoredEnvelope(i: EarnIntent, hash: Hex, tx: Transaction, r: TransactionReceipt, e: SponsoredChainEvidence, context?: EarnVerificationContext): Promise<Omit<SponsoredEarnEvidence, 'eventVerified'>> {
  verifyEarn(i);
  requireProof(i.action === 'APPROVAL', 'unsupported sponsored action (approval only)');
  requireProof(tx.type === 'eip7702' && r.type === 'eip7702', 'transaction type');
  requireProof(tx.chainId === EARN_CHAIN, 'chainId');
  requireProof(r.status === 'success', 'receipt.status');
  requireProof(same(tx.hash,hash) && same(r.transactionHash,hash), 'transaction hash');
  requireProof(same(tx.to,TURNKEY.wrapper) && same(r.to,TURNKEY.wrapper), 'allowlisted wrapper');
  requireProof(same(r.from,tx.from), 'receipt.from');
  requireProof(tx.value === 0n && i.payload.value === '0', 'outer value');
  requireProof(tx.blockNumber === r.blockNumber && r.blockNumber === e.blockNumber && same(tx.blockHash,e.blockHash) && same(r.blockHash,e.blockHash) && tx.transactionIndex === r.transactionIndex, 'canonical receipt block');
  requireProof(e.latestBlock >= r.blockNumber + 1n, 'two confirmations');
  requireProof(context && /^[\w-]{1,200}$/.test(context.keeperHubExecutionId) && same(context.transactionHash,hash) && context.intentHash === i.intentHash, 'durable execution binding');
  requireProof(Number.isSafeInteger(context.broadcastAttemptedAt) && context.broadcastAttemptedAt >= i.createdAt && context.broadcastAttemptedAt < i.expiresAt, 'broadcast claim');
  requireProof(e.timestamp >= BigInt(Math.floor(context.broadcastAttemptedAt / 1000)) && e.timestamp <= BigInt(Math.floor(i.expiresAt / 1000)), 'mined intent window / replay');
  requireProof(same(e.wrapperCodeHash,TURNKEY.wrapperCodeHash) && same(e.delegateCodeHash,TURNKEY.delegateCodeHash), 'historical deployment code hashes');
  requireProof(same(e.executorCode,`0xef0100${TURNKEY.delegate.slice(2)}`), 'executor delegation');

  let decoded: ReturnType<typeof decodeWrapper>;
  try { decoded = decodeWrapper(tx.input); } catch { throw new ExecutionError('PROOF_MISMATCH','Unsupported or non-canonical Turnkey wrapper calldata. No resend.'); }
  const { executor, target, value, signature, nonce, deadline, innerCalldata } = decoded;
  requireProof(same(executor,i.walletAddress), 'inner executor');
  requireProof(same(target,i.payload.contractAddress), 'inner target');
  requireProof(value === 0n, 'inner value');
  requireProof(same(innerCalldata,i.calldata), 'exact inner calldata (including spender and amount)');
  requireProof(e.timestamp <= BigInt(deadline), 'execution deadline');
  requireProof(e.executionNonceAfter === nonce + 1n, 'consumed execution nonce');
  const auths = tx.authorizationList;
  requireProof(auths?.length === 1, 'single EIP-7702 authorization');
  const auth = auths[0];
  requireProof(auth.chainId === EARN_CHAIN && same(auth.address,TURNKEY.delegate), 'authorization chain / delegate');
  requireProof(e.authorizationNonceBefore === auth.nonce && e.authorizationNonceAfter === auth.nonce + 1, 'applied authorization nonce');
  let authorizationSigner: Address, executionSigner: Address;
  try {
    authorizationSigner = await recoverAuthorizationAddress({ authorization: auth });
    executionSigner = await recoverTypedDataAddress({
      domain: { name: 'TKGasDelegate', version: '1.1', chainId: EARN_CHAIN, verifyingContract: executor },
      types: executionTypes, primaryType: 'Execution', message: { nonce, deadline, to: target, value, data: innerCalldata }, signature,
    });
  } catch { throw new ExecutionError('PROOF_MISMATCH','Invalid EIP-7702 or EIP-712 signature. No resend.'); }
  requireProof(same(authorizationSigner,i.walletAddress), 'authorization signer');
  requireProof(same(executionSigner,i.walletAddress), 'execution signer');
  // Explicitly require both historical effect and a current, block-bound read.
  requireProof(e.allowanceAtReceipt === BigInt(i.amount) && e.currentAllowance === BigInt(i.amount), 'exact historical/current allowance');
  return {
    mode: 'keeperhub-sponsored-eip7702', keeperHubExecutionId: context.keeperHubExecutionId, intentHash: i.intentHash,
    outerSender: tx.from, outerTarget: TURNKEY.wrapper, outerCalldata: tx.input, outerValue: '0', outerNonce: tx.nonce,
    executor, innerTarget: target, innerCalldata, innerValue: '0', receiptStatus: 'success',
    confirmations: (e.latestBlock-r.blockNumber+1n).toString(), blockHash: e.blockHash,
    authorizationSigner, executionSigner, delegate: TURNKEY.delegate, wrapperCodeHash: e.wrapperCodeHash, delegateCodeHash: e.delegateCodeHash,
    authorizationNonce: auth.nonce, executionNonce: nonce.toString(), executionDeadline: deadline,
    stateVerified: true, allowance: e.currentAllowance.toString(), allowanceAtReceipt: e.allowanceAtReceipt.toString(),
    stateBlockNumber: e.latestBlock.toString(), stateBlockHash: e.latestBlockHash,
  };
}
export function decodeWrapper(input: Hex) {
  const decoded = decodeFunctionData({ abi: turnkeyAbi, data: input });
  const [executor,target,value,data] = decoded.args;
  // Canonical encoding forbids alternate offsets, ignored trailing bytes, etc.
  if (decoded.functionName !== 'execute' || !same(encodeFunctionData({ abi: turnkeyAbi, functionName: 'execute', args: decoded.args }),input) || data.length < 2 + 85*2) throw new Error('wrapper');
  return { executor, target, value, data, signature: sliceHex(data,0,65), nonce: BigInt(sliceHex(data,65,81)), deadline: Number(BigInt(sliceHex(data,81,85))), innerCalldata: sliceHex(data,85) };
}
