import { formatUnits } from 'viem';
import { decimalRaw } from '../shared/domain';
import { EXECUTION_CHAIN, ExecutionError, type ExecutionIntent, type ExecutionLimits, type ExecutionRecord } from '../shared/execution';

// All comparisons use integer token units. Normalize to 18 only when combining
// historical records whose authoritative collateral decimals may differ.
export function tokenUnits(text: string, decimals: number): bigint {
  try {
    if (text.length > 80) throw new Error();
    return decimalRaw(text, decimals);
  } catch { throw new ExecutionError('INVALID_INPUT', `Use a plain decimal amount with at most ${decimals} fractional digits.`); }
}
export function keeperLimits(env: NodeJS.ProcessEnv = process.env) {
  if ((env.KEEPERHUB_CHAIN_ID ?? '50312') !== String(EXECUTION_CHAIN)) throw new ExecutionError('NETWORK_UNSUPPORTED', 'KeeperHub execution is restricted to Somnia Shannon testnet (50312).');
  const maxTrade = env.KEEPERHUB_MAX_TRADE_TUSDC ?? '1', maxSession = env.KEEPERHUB_MAX_SESSION_TUSDC ?? '5';
  const trade = tokenUnits(maxTrade, 18), session = tokenUnits(maxSession, 18);
  if (trade <= 0n || trade > 10n ** 18n || session <= 0n || session > 5n * 10n ** 18n || trade > session) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Demo limits must be positive, at most 1 tUSDC per trade and 5 tUSDC total, with trade limit no greater than total.');
  return { chainId: EXECUTION_CHAIN, maxTrade, maxSession, trade, session };
}
export function checkTradeAmount(text: string, decimals = 18): bigint {
  const amount = tokenUnits(text, decimals), limit = keeperLimits();
  if (amount <= 0n) throw new ExecutionError('INVALID_INPUT', 'Requested collateral must be positive.');
  if (amount * 10n ** BigInt(18 - decimals) > limit.trade) throw new ExecutionError('TRADE_LIMIT_EXCEEDED', `Maximum collateral is ${limit.maxTrade} tUSDC per trade.`);
  return amount;
}
export function attemptedExposure(records: ExecutionRecord[], excludeId?: string): bigint {
  return records.reduce((sum, r) => {
    if (r.intent.id === excludeId || r.intent.kind !== 'TRADE' || (!r.broadcastAttemptedAt && !['EXECUTING', 'CONFIRMING'].includes(r.status))) return sum;
    const d = r.intent.collateralDecimals;
    if (!Number.isInteger(d) || d < 0 || d > 18) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Historical exposure has invalid token decimals. Audit it before continuing.');
    // Count the whole authorized budget, including uncertain/failed attempts.
    // No automatic refund/reset; approvals do not spend the budget twice.
    return sum + BigInt(r.intent.stake) * 10n ** BigInt(18 - d);
  }, 0n);
}
export function limitStatus(requestedText: string, used: bigint): ExecutionLimits {
  const c = keeperLimits(), requested = tokenUnits(requestedText, 18);
  const issues: ExecutionLimits['issues'] = [];
  if (requested <= 0n) issues.push({ code: 'INVALID_INPUT', message: 'Requested collateral must be positive.' });
  if (requested > c.trade) issues.push({ code: 'TRADE_LIMIT_EXCEEDED', message: `Maximum collateral is ${c.maxTrade} tUSDC per trade.` });
  if (used + requested > c.session) issues.push({ code: 'SESSION_LIMIT_EXCEEDED', message: `The executor demo budget is ${c.maxSession} tUSDC. Attempted and reserved trades already use ${formatUnits(used, 18)} tUSDC.` });
  return { chainId: 50312, maxTrade: c.maxTrade, maxSession: c.maxSession, requested: requestedText, usedSession: formatUnits(used, 18), remainingSession: formatUnits(c.session > used ? c.session - used : 0n, 18), allowed: issues.length === 0, scope: 'executor-durable-demo', issues };
}
export function intentLimitStatus(i: ExecutionIntent, used: bigint) {
  if (i.chainId !== 50312 || i.payload.chainId !== 50312) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Only Shannon chain 50312 is permitted.');
  return limitStatus(formatUnits(BigInt(i.stake), i.collateralDecimals), used);
}
export function assertLimits(limits: ExecutionLimits) {
  const issue = limits.issues[0]; if (issue) throw new ExecutionError(issue.code, issue.message);
}
