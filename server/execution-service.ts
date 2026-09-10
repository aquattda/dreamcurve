import { verifyMessage, type Address, type Hex } from 'viem';
import type { Forecast, Market, Side } from '../shared/domain';
import { assertFresh, authorizationMessage, ExecutionError, isPending, verifyIntent, type ExecutionIntent, type ExecutionRecord, type Failure, type ExecutionStatus, type ExecutionSafety } from '../shared/execution';
import { KeeperClient, KeeperRejection, object, normalizeKeeperError, type KeeperResponse } from './keeperhub';
import { approvalFor, type ExecutionProtocol } from './execution-protocol';
import type { ExecutionStore } from './execution-store';
import { assertLimits, checkTradeAmount, keeperLimits, limitStatus, intentLimitStatus } from './execution-limits';

const hashPattern = /^0x[\da-fA-F]{64}$/;
const failureOf = (e: unknown): Failure => e instanceof ExecutionError ? { code: e.code, message: e.message } : { code: 'KEEPERHUB_ERROR', message: 'An upstream or persistence check failed. Execution is blocked; retry the check.' };
const failureStatus = (f: Failure): ExecutionStatus => f.code === 'MARKET_EXPIRED' ? 'STALE' : ['MARKET_CLOSED','NETWORK_UNSUPPORTED','ALLOWANCE_REQUIRED','INSUFFICIENT_GAS','INSUFFICIENT_BALANCE','INSUFFICIENT_EXECUTOR_GAS','INSUFFICIENT_EXECUTOR_COLLATERAL','COLLATERAL_MISMATCH','TRADE_LIMIT_EXCEEDED','SESSION_LIMIT_EXCEEDED','CONFIGURATION_REQUIRED'].includes(f.code) ? 'BLOCKED' : 'SIMULATION_FAILED';
function event(r: ExecutionRecord, name: string, detail: string) { r.timeline.push({ at: Date.now(), event: name, detail }); }
export function initialRecord(intent: ExecutionIntent): ExecutionRecord {
  return { intent, revision: 0, status: 'REVIEW_REQUIRED', preflight: null, failure: null, keeperHubExecutionId: null, keeperHubStatus: null, txHash: null, broadcastAttemptedAt: null, approvalSignature: null, proof: null, pollAfterMs: 5000, timeline: [{ at: intent.createdAt, event: 'Intent frozen', detail: `${intent.recommendationSource}; ${intent.kind}; canonical payload and hash saved.` }] };
}
export class ExecutionService {
  constructor(readonly store: ExecutionStore, readonly keeper: KeeperClient, readonly protocol: ExecutionProtocol) {}
  configured() {
    keeperLimits();
    const c = this.keeper.config;
    const missing = [!c.apiKey && 'server-side API key', !c.wallet && 'executor wallet address', !c.operators.length && 'authorized operator address', !c.eoaConfirmed && 'verified EOA signer mode'].filter(Boolean);
    if (missing.length) throw new ExecutionError('CONFIGURATION_REQUIRED', `Complete KeeperHub configuration: ${missing.join(', ')}.`);
  }
  async get(id: string) { const r = await this.store.get(id); if (!r) throw new ExecutionError('INVALID_INPUT', 'Execution intent not found.'); return r; }
  async prepare(market: Market, side: Side, stake: string, operator: Address, forecast: Forecast | null) {
    this.configured();
    checkTradeAmount(stake);
    if (!this.keeper.config.operators.some(o => o.toLowerCase() === operator.toLowerCase())) throw new ExecutionError('UNAUTHORIZED', 'This connected wallet is not an authorized KeeperHub operator.');
    assertLimits(limitStatus(stake, await this.store.exposure(this.keeper.config.wallet!)));
    await this.keeper.assertChain();
    const intent = await this.protocol.prepare(market, side, stake, operator, forecast);
    const record = initialRecord(intent); await this.store.insert(record); return record;
  }
  async approval(id: string) {
    const parent = await this.get(id); verifyIntent(parent.intent); assertFresh(parent.intent);
    if (parent.intent.kind !== 'TRADE' || parent.broadcastAttemptedAt) throw new ExecutionError('INVALID_INPUT', 'Cannot create an approval for this execution.');
    const approvalId = `${id}-approval`;
    const prior = await this.store.get(approvalId); if (prior) return prior;
    const body = approvalFor(parent.intent);
    // Use one stable child per trade; concurrent requests cannot create duplicate approvals.
    const { freezeIntent } = await import('../shared/execution');
    const { intentHash: _hash, ...fields } = body;
    const r = initialRecord(freezeIntent({ ...fields, id: approvalId }));
    try { await this.store.insert(r); return r; } catch (e) { const existing = await this.store.get(approvalId); if (existing) return existing; throw e; }
  }
  private async preflight(r: ExecutionRecord) {
    this.configured(); verifyIntent(r.intent); assertFresh(r.intent);
    assertLimits(intentLimitStatus(r.intent, await this.store.exposure(r.intent.walletAddress, r.intent.id)));
    await this.keeper.assertChain();
    const checks = await this.protocol.check(r.intent);
    const { body } = await this.keeper.simulate(r.intent.payload);
    if (body.success !== true || body.status !== 'simulated' || body.wouldRevert !== false) { const f = normalizeKeeperError(body, 400); throw new ExecutionError(f.code, f.message); }
    if (typeof body.from !== 'string' || body.from.toLowerCase() !== r.intent.walletAddress.toLowerCase() || typeof body.to !== 'string' || body.to.toLowerCase() !== r.intent.payload.contractAddress.toLowerCase() || body.value !== '0') throw new ExecutionError('PROOF_MISMATCH', 'KeeperHub simulated a different sender, target or native value.');
    if (typeof body.gasEstimate !== 'string' || !/^\d+$/.test(body.gasEstimate) || BigInt(body.gasEstimate) <= 0n) throw new ExecutionError('SIMULATOR_UNAVAILABLE', 'KeeperHub did not return a usable gas estimate.');
    await this.protocol.check(r.intent, body.gasEstimate);
    verifyIntent(r.intent); assertFresh(r.intent);
    return { passed: true, at: Date.now(), checks, simulation: { from: body.from, to: body.to, gasEstimate: body.gasEstimate, wouldRevert: false as const } };
  }
  async safety(id: string): Promise<ExecutionSafety> {
    const r = await this.get(id), issues: Failure[] = [];
    let funding: ExecutionSafety['funding'] = null, limits: ExecutionSafety['limits'] = null;
    try { verifyIntent(r.intent); this.configured(); assertFresh(r.intent); } catch (e) { issues.push(failureOf(e)); }
    const results = await Promise.allSettled([
      this.protocol.funding(r.intent, r.preflight?.simulation?.gasEstimate),
      this.store.exposure(r.intent.walletAddress, r.intent.id).then(used => intentLimitStatus(r.intent, used)),
    ]);
    if (results[0].status === 'fulfilled') { funding = results[0].value; issues.push(...funding.issues); } else issues.push(failureOf(results[0].reason));
    if (results[1].status === 'fulfilled') { limits = results[1].value; issues.push(...limits.issues); } else issues.push(failureOf(results[1].reason));
    return { funding, limits, issues, readyToExecute: issues.length === 0, checkedAt: Date.now() };
  }
  async simulate(id: string) {
    let r = await this.get(id);
    if (r.broadcastAttemptedAt || isPending(r) || r.status === 'SUCCESS') return r;
    if (r.status === 'SIMULATING') throw new ExecutionError('BUSY', 'Simulation already running. Refresh the execution.');
    r.status = 'SIMULATING'; r.failure = null; event(r, 'Simulation started', 'KeeperHub dry run; no broadcast.'); r = await this.store.save(r);
    try {
      r.preflight = await this.preflight(r); r.status = 'READY'; event(r, 'Simulation passed', 'Frozen payload, live state and executing wallet verified.');
    } catch (e) { const f = failureOf(e); r.failure = f; r.status = failureStatus(f); r.preflight = { passed: false, at: Date.now(), checks: [], failure: f }; event(r, 'Execution blocked', f.message); }
    return this.store.save(r);
  }
  private async authorize(r: ExecutionRecord, signature: Hex) {
    this.configured(); verifyIntent(r.intent);
    if (!this.keeper.config.operators.some(o => o.toLowerCase() === r.intent.operatorAddress.toLowerCase()) || this.keeper.config.domain !== r.intent.authorizationDomain) throw new ExecutionError('UNAUTHORIZED', 'The intent operator or authorization domain is no longer authorized.');
    if (!await verifyMessage({ address: r.intent.operatorAddress, message: authorizationMessage(r.intent), signature })) throw new ExecutionError('UNAUTHORIZED', 'The wallet signature does not authorize this frozen intent.');
  }
  async execute(id: string, signature: Hex) {
    let r = await this.get(id);
    await this.authorize(r, signature);
    // This durable check deliberately precedes expiry and preflight. An already
    // submitted order remains retrievable after expiry, but is never resubmitted.
    if (r.broadcastAttemptedAt) return this.refresh(id);
    if (r.status !== 'READY' || !r.preflight?.passed) throw new ExecutionError('INVALID_INPUT', 'Run a successful KeeperHub dry run before confirming execution.');
    try { assertFresh(r.intent); } catch (e) { r.failure = failureOf(e); r.status = 'STALE'; event(r, 'Execution blocked', r.failure.message); return this.store.save(r); }
    r.status = 'EXECUTING'; r.approvalSignature = signature;
    event(r, 'User authorized', 'Operator signature bound to this exact intent.');
    r = await this.store.save(r); // CAS + unique wallet-inflight index across all server instances.
    try {
      r.preflight = await this.preflight(r); // Recheck exact payload after review, without re-quoting.
      event(r, 'Final preflight passed', 'Same frozen payload; live state rechecked after authorization.');
    } catch (e) { r.failure = failureOf(e); r.status = failureStatus(r.failure); event(r, 'Execution blocked', r.failure.message); return this.store.save(r); }
    r.broadcastAttemptedAt = Date.now(); event(r, 'KeeperHub execution requested', 'Durable at-most-once claim saved before outbound request.');
    r = await this.store.save(r);
    try {
      const response = await this.keeper.execute(r.intent.payload, r.intent.intentHash);
      this.capture(r, response); r = await this.store.save(r);
      return r.keeperHubExecutionId ? this.refresh(id, true) : r;
    } catch (e) {
      // Even a timeout or unreadable HTTP response can follow a broadcast.
      r = await this.get(id);
      if (e instanceof KeeperRejection && !r.keeperHubExecutionId && !r.txHash) {
        r.status = 'FAILED'; r.failure = failureOf(e);
        event(r, 'KeeperHub rejected request', 'Explicit pre-broadcast rejection. Fix the prerequisite and create a new reviewed intent.');
        return this.store.save(r);
      }
      r.status = 'CONFIRMING'; r.failure = { code: 'EXECUTION_UNCERTAIN', message: failureOf(e).message };
      event(r, 'Outcome unconfirmed', 'No automatic rebroadcast. Reconcile the KeeperHub execution ID.');
      return this.store.save(r);
    }
  }
  private capture(r: ExecutionRecord, response: KeeperResponse) {
    const b = response.body;
    if (typeof b.executionId === 'string' && b.executionId.length <= 200) r.keeperHubExecutionId = b.executionId;
    if (typeof b.transactionHash === 'string' && hashPattern.test(b.transactionHash)) r.txHash = b.transactionHash as Hex;
    r.keeperHubStatus = typeof b.status === 'string' ? b.status : 'unknown';
    r.pollAfterMs = response.pollAfterMs; r.status = 'CONFIRMING';
    if (!r.keeperHubExecutionId) r.failure = { code: 'EXECUTION_UNCERTAIN', message: 'KeeperHub did not return an execution ID. Reconcile its audit log before any new execution.' };
  }
  async refresh(id: string, force = false) {
    let r = await this.get(id);
    // A crashed simulation/preflight never reached the durable broadcast claim.
    // Once the payload has expired, invalidate that claim using the same CAS.
    // An in-process preflight racing this update then fails its final save and
    // cannot issue the outbound request. Attempted broadcasts are never unlocked.
    if (!r.broadcastAttemptedAt && Date.now() >= r.intent.expiresAt && !['STALE','SUCCESS','FAILED'].includes(r.status)) {
      r.status = 'STALE'; r.failure = { code: 'MARKET_EXPIRED', message: 'Intent expired before a broadcast was requested. Create a new reviewed intent.' };
      event(r, 'Intent expired', 'No durable broadcast attempt exists for this intent.');
      return this.store.save(r);
    }
    if (!isPending(r) || !r.keeperHubExecutionId) return r;
    const last = r.timeline.findLast(e => e.event === 'KeeperHub status checked');
    if (!force && last && Date.now() - last.at < r.pollAfterMs) return r;
    try {
      const response = await this.keeper.status(r.keeperHubExecutionId);
      if (response.body.executionId !== r.keeperHubExecutionId) throw new ExecutionError('PROOF_MISMATCH', 'KeeperHub status returned a different execution ID.');
      this.capture(r, response); event(r, 'KeeperHub status checked', r.keeperHubStatus || 'unknown');
      const receipts = Array.isArray(response.body.receipts) ? response.body.receipts.map(object) : [];
      const proof = receipts.find(p => p.hash === r.txHash && p.chainId === 50312 && p.verified === true && p.receiptStatus === 'success');
      if (r.txHash && proof && r.keeperHubStatus === 'completed') {
        r.proof = await this.protocol.verify(r.intent, r.txHash);
        r.status = 'SUCCESS'; r.failure = null; event(r, 'Onchain proof verified', `${r.proof.orderStatus}; receipt and transaction independently verified on Shannon.`);
      } else if ((r.keeperHubStatus === 'failed' && !r.txHash) || receipts.some(p => p.hash === r.txHash && p.chainId === 50312 && p.verified === true && ['reverted','safe_inner_failure'].includes(String(p.receiptStatus)))) {
        r.status = 'FAILED'; r.failure = normalizeKeeperError(response.body); event(r, 'Execution failed', r.failure.message);
      } else if (r.keeperHubStatus === 'completed') {
        r.failure = { code: 'EXECUTION_UNCERTAIN', message: 'KeeperHub reports completed but has not supplied a matching verified Shannon receipt. Confirmation remains pending; no retry trade was submitted.' };
      } else if (r.keeperHubStatus === 'failed' && r.txHash) {
        r.failure = { code: 'EXECUTION_UNCERTAIN', message: 'KeeperHub reports failure after broadcast, but no definitive reverted receipt is available. The transaction may still confirm. Continue verification without resubmitting.' };
      }
    } catch (e) {
      r.failure = failureOf(e);
      // Verification mismatch stays unresolved and retains the wallet lock.
      // It must not license a second trade against an uncertain first one.
      r.status = 'CONFIRMING'; r.pollAfterMs = Math.min(60_000, r.pollAfterMs * 2);
      event(r, 'Verification pending', r.failure.message);
    }
    // Keep diagnostics bounded while retaining initial and terminal milestones.
    if (r.timeline.length > 120) r.timeline = [...r.timeline.slice(0, 30), ...r.timeline.slice(-90)];
    return this.store.save(r);
  }
  async recover(id: string, executionId: string, signature: Hex) {
    let r = await this.get(id); await this.authorize(r, signature);
    if (!r.broadcastAttemptedAt || !isPending(r) || r.keeperHubExecutionId) throw new ExecutionError('INVALID_INPUT', 'Only an unresolved execution without an ID can be reconciled.');
    const { body } = await this.keeper.status(executionId);
    if (body.executionId !== executionId || typeof body.transactionHash !== 'string' || !hashPattern.test(body.transactionHash)) throw new ExecutionError('PROOF_MISMATCH', 'Recovery needs a KeeperHub execution with an onchain transaction.');
    // Verify the exact payload before binding an externally supplied execution ID.
    await this.protocol.verify(r.intent, body.transactionHash as Hex);
    r.keeperHubExecutionId = executionId; event(r, 'Execution ID recovered', 'Authorized recovery; exact onchain payload verified.');
    r = await this.store.save(r); return this.refresh(r.intent.id, true);
  }
}
