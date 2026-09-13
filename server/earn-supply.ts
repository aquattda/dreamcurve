import { decodeEventLog, parseAbi, type Hex, type TransactionReceipt } from 'viem';
import { AAVE, EARN_ASSETS, type EarnIntent, type SponsoredEarnEvidence } from '../shared/earn';
import { ExecutionError } from '../shared/execution';

// Audited Sepolia aLINK implementation, revision 1 (Aave V3 ray half-up math).
// Reject upgrades instead of silently switching accounting rules.
export const A_LINK = {
  implementation: '0x48424f2779be0f03cdf6f02e17a591a9bf7af89f',
  codeHash: '0x6d4978b4862ad22d5903db41a2f09a1a783053c12d8936fa7a63ed915aef008b',
  implementationSlot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
} as const;
export const aTokenProofAbi = parseAbi([
  'function scaledBalanceOf(address) view returns (uint256)',
  'function getPreviousIndex(address) view returns (uint256)',
  'function POOL() view returns (address)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'event Mint(address indexed caller,address indexed onBehalfOf,uint256 value,uint256 balanceIncrease,uint256 index)',
]);
export type SupplyChainEvidence = {
  tokenBefore: bigint; tokenAfter: bigint; allowanceBefore: bigint;
  scaledBefore: bigint; scaledAfter: bigint; currentScaled: bigint;
  previousIndexBefore: bigint; indexAfter: bigint;
  implementationBefore: Hex; implementationAfter: Hex; implementationCodeHash: Hex;
  pool: string; underlying: string;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const RAY = 10n ** 27n;
const rayMul = (a: bigint, b: bigint) => (a*b+RAY/2n)/RAY;
export function verifySupplyState(i: EarnIntent, receipt: TransactionReceipt, s: SupplyChainEvidence, allowanceAfter: bigint, currentAllowance: bigint): NonNullable<SponsoredEarnEvidence['supply']> {
  function check(ok: boolean, field: string): asserts ok { if (!ok) throw new ExecutionError('PROOF_MISMATCH',`Sponsored SUPPLY mismatch: ${field}. No resend.`); }
  check(i.action === 'SUPPLY' && i.token === EARN_ASSETS.LINK.token,'supported LINK supply');
  const implementationWord = `0x${'0'.repeat(24)}${A_LINK.implementation.slice(2)}`;
  check(same(s.implementationBefore,implementationWord) && same(s.implementationAfter,implementationWord) && same(s.implementationCodeHash,A_LINK.codeHash),'pinned aLINK implementation');
  check(same(s.pool,AAVE.pool) && same(s.underlying,i.token),'aToken pool/underlying mapping');
  const amount = BigInt(i.amount);
  check(s.tokenBefore-s.tokenAfter === amount,'exact underlying balance debit');
  // Demo requires bounded approval exactly matching the intended supply.
  check(s.allowanceBefore === amount && allowanceAfter === 0n && currentAllowance === 0n,'exact allowance consumption');
  const mints = receipt.logs.flatMap(log => {
    if (!same(log.address,i.aToken)) return [];
    try { const event = decodeEventLog({ abi: aTokenProofAbi, data: log.data, topics: log.topics });
      return event.eventName === 'Mint' && same(event.args.caller,i.walletAddress) && same(event.args.onBehalfOf,i.walletAddress) ? [event.args] : [];
    } catch { return []; }
  });
  check(mints.length === 1,'one exact aToken Mint event');
  const mint = mints[0];
  check(mint.index >= RAY && mint.index === s.indexAfter && mint.index >= s.previousIndexBefore,'liquidity index');
  const interest = rayMul(s.scaledBefore,mint.index)-rayMul(s.scaledBefore,s.previousIndexBefore);
  check(mint.balanceIncrease === interest && mint.value === amount+interest,'mint principal versus accrued interest');
  const scaledMinted = (amount*RAY+mint.index/2n)/mint.index;
  check(scaledMinted > 0n && s.scaledAfter-s.scaledBefore === scaledMinted,'exact scaled aToken mint');
  check(s.currentScaled === s.scaledAfter,'current scaled position');
  return { tokenBalanceBefore: s.tokenBefore.toString(), tokenBalanceAfter: s.tokenAfter.toString(), allowanceBefore: s.allowanceBefore.toString(),
    scaledBalanceBefore: s.scaledBefore.toString(), scaledBalanceAfter: s.scaledAfter.toString(), scaledMinted: scaledMinted.toString(), currentScaledBalance: s.currentScaled.toString(),
    liquidityIndex: mint.index.toString(), accruedInterest: interest.toString(), aTokenImplementation: A_LINK.implementation, aTokenCodeHash: s.implementationCodeHash };
}
