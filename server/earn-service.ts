import { randomUUID } from 'node:crypto';
import { isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { AAVE, EARN_ASSETS, EARN_CHAIN, EARN_TOTAL, earnAmount, earnAuthorization, earnCall, freezeEarn, freshEarn, verifyEarn, type EarnAction, type EarnAsset, type EarnIntent, type EarnOverview, type EarnRecord } from '../shared/earn';
import { ExecutionError, type Failure, type PreflightResult } from '../shared/execution';
import { checkEarnSnapshot, type EarnProtocol } from './earn-protocol';
import { earnExposure, type EarnStore } from './earn-store';
import { KeeperClient, KeeperRejection, normalizeKeeperError, object, type KeeperResponse } from './keeperhub';

const hashPattern = /^0x[\da-fA-F]{64}$/;
const pending = (r: EarnRecord) => ['EXECUTING','CONFIRMING'].includes(r.status);
const failure = (e: unknown): Failure => e instanceof ExecutionError ? { code: e.code, message: e.message } : { code: 'KEEPERHUB_ERROR', message: 'Earn network or storage check failed. No automatic resend is allowed.' };
function event(r: EarnRecord, name: string, detail: string) { r.timeline.push({ at: Date.now(), event: name, detail }); }
export function initialEarn(intent: EarnIntent): EarnRecord {
  return { intent, revision: 0, status: 'REVIEW_REQUIRED', preflight: null, failure: null, broadcastAttemptedAt: null, keeperHubExecutionId: null, txHash: null, keeperHubStatus: null, proof: null, pollAfterMs: 5000, lastPollAt: 0, timeline: [{ at: intent.createdAt, event: 'Intent frozen', detail: intent.rationale }] };
}
export class EarnService {
  constructor(readonly store: EarnStore, readonly keeper: KeeperClient, readonly protocol: EarnProtocol, readonly freeTierConfirmed = () => process.env.EARN_FREE_TIER_CONFIRMED === 'true') {}
  configured() {
    const c = this.keeper.config;
    if (!c.apiKey || !c.wallet || !c.operators.length || !c.eoaConfirmed) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Configure the KeeperHub organization key, executor, operator and verified EOA mode.');
    if (process.env.EARN_CHAIN_ID && process.env.EARN_CHAIN_ID !== String(EARN_CHAIN)) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Earn is restricted to Sepolia 11155111.');
  }
  async connection() {
    this.configured();
    const [chains, wallet, safes] = await Promise.all([this.keeper.chains(), this.keeper.request('/api/user/wallet'), this.keeper.request('/api/user/safe')]);
    if (!chains?.some(c => { const x = object(c); return x.chainId === EARN_CHAIN && x.isEnabled === true && x.isTestnet === true && x.chainType === 'evm'; })) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Hosted KeeperHub does not advertise enabled Sepolia.');
    if (typeof wallet.body.walletAddress !== 'string' || wallet.body.walletAddress.toLowerCase() !== this.keeper.config.wallet!.toLowerCase()) throw new ExecutionError('PROOF_MISMATCH', 'KeeperHub organization executor mismatch.');
    // Fail closed on unknown Safe response shapes as well as active Safe routing.
    if (!Array.isArray(safes.body.safes) || safes.body.safes.length !== 0) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Earn currently requires an organization with no Safe accounts. Verify EOA routing before use.');
  }
  async overview(): Promise<EarnOverview> {
    const issues: Failure[] = [], c = this.keeper.config;
    let snapshot: EarnOverview['snapshot'] = null, authenticated = false;
    const results = await Promise.allSettled([this.connection(), c.wallet ? this.protocol.snapshot(c.wallet) : Promise.reject(new ExecutionError('CONFIGURATION_REQUIRED','Executor wallet is missing.'))]);
    if (results[0].status === 'fulfilled') authenticated = true; else issues.push(failure(results[0].reason));
    if (results[1].status === 'fulfilled') snapshot = results[1].value; else issues.push(failure(results[1].reason));
    const rows = c.wallet ? await this.store.list(c.wallet) : [];
    return { snapshot, issues, chainSupported: authenticated, authenticated, freeTierConfirmed: this.freeTierConfirmed(), usedSupply: earnExposure(rows,'SUPPLY').toString(), usedWithdraw: earnExposure(rows,'WITHDRAW').toString(), walletAddress: c.wallet, operators: c.operators, checkedAt: Date.now() };
  }
  async get(id: string) { const r = await this.store.get(id); if (!r) throw new ExecutionError('INVALID_INPUT','Earn intent not found.'); return r; }
  async budget(i: EarnIntent) {
    if (i.action === 'APPROVAL') return;
    const used = earnExposure(await this.store.list(i.walletAddress),i.action,i.id);
    if (used + BigInt(i.amount) * 10n ** BigInt(18-i.decimals) > EARN_TOTAL) throw new ExecutionError('SESSION_LIMIT_EXCEEDED', 'Earn durable demo limit is 5 test-token units supplied and 5 withdrawn across allowlisted assets. This is not a USD valuation. Failed/uncertain attempts count; withdrawals never reset the supply budget.');
  }
  async prepare(action: EarnAction, amountText: string, operator: Address, assetId: EarnAsset = 'LINK') {
    this.configured();
    if (!['APPROVAL','SUPPLY','WITHDRAW'].includes(action) || !isAddress(operator) || !this.keeper.config.operators.some(a => a.toLowerCase() === operator.toLowerCase())) throw new ExecutionError('UNAUTHORIZED','Use an allowlisted operator and Earn action.');
    if (!['USDC','LINK'].includes(assetId)) throw new ExecutionError('INVALID_INPUT','Select an allowlisted test asset.');
    const asset = EARN_ASSETS[assetId], amount = earnAmount(amountText,asset.decimals).toString();
    await this.connection();
    const s = await this.protocol.snapshot(this.keeper.config.wallet!,asset.token);
    if (s.token !== asset.token || s.aToken !== asset.aToken || s.decimals !== asset.decimals) throw new ExecutionError('PROOF_MISMATCH','Snapshot does not match the selected asset.');
    const createdAt = Date.now();
    const intent = freezeEarn({ version: 'earn-v1', protocol: 'aave-v3', id: randomUUID(), chainId: EARN_CHAIN, action, amount, decimals: asset.decimals, token: asset.token, pool: AAVE.pool, aToken: asset.aToken, walletAddress: s.walletAddress, operatorAddress: operator, authorizationDomain: this.keeper.config.domain, createdAt, expiresAt: createdAt + 600_000, rationale: `Manual ${action.toLowerCase()} request. Live Aave reserve checked at ${new Date(s.checkedAt).toISOString()}. No AI prediction or guaranteed yield is claimed.`, ...earnCall(action,amount,s.walletAddress,asset.token) });
    verifyEarn(intent); await this.budget(intent);
    const r = initialEarn(intent); await this.store.insert(r); return r;
  }
  async preflight(r: EarnRecord): Promise<PreflightResult> {
    this.configured(); verifyEarn(r.intent); freshEarn(r.intent);
    if (r.intent.walletAddress.toLowerCase() !== this.keeper.config.wallet!.toLowerCase()) throw new ExecutionError('UNAUTHORIZED','Earn executor configuration changed.');
    await this.budget(r.intent); await this.connection();
    checkEarnSnapshot(r.intent,await this.protocol.snapshot(r.intent.walletAddress,r.intent.token));
    const { body } = await this.keeper.simulate(r.intent.payload);
    if (body.success !== true || body.status !== 'simulated' || body.wouldRevert !== false) { const f = normalizeKeeperError(body,400); throw new ExecutionError(f.code,f.message); }
    if (typeof body.from !== 'string' || body.from.toLowerCase() !== r.intent.walletAddress.toLowerCase() || typeof body.to !== 'string' || body.to.toLowerCase() !== r.intent.payload.contractAddress.toLowerCase() || body.value !== '0' || typeof body.gasEstimate !== 'string') throw new ExecutionError('PROOF_MISMATCH','KeeperHub dry run must match executor, target, value and return a gas estimate.');
    checkEarnSnapshot(r.intent,await this.protocol.snapshot(r.intent.walletAddress,r.intent.token),body.gasEstimate);
    freshEarn(r.intent);
    return { passed: true, at: Date.now(), checks: ['Sepolia registry and EOA verified','Aave reserve, balances, allowance, debt and caps checked','Exact frozen KeeperHub simulation passed'], simulation: { from: body.from, to: body.to, gasEstimate: body.gasEstimate, wouldRevert: false } };
  }
  async safety(id: string) {
    const r = await this.get(id), issues: Failure[] = [];
    try { this.configured(); verifyEarn(r.intent); freshEarn(r.intent); await this.budget(r.intent); await this.connection(); checkEarnSnapshot(r.intent,await this.protocol.snapshot(r.intent.walletAddress,r.intent.token),r.preflight?.simulation?.gasEstimate); }
    catch (e) { issues.push(failure(e)); }
    if (!this.freeTierConfirmed()) issues.push({ code: 'CONFIGURATION_REQUIRED', message: 'Writes are locked until the operator checks KeeperHub billing/free quota and confirms no paid overage. No billing setting is changed by DreamCurve.' });
    return { ready: issues.length === 0, issues, checkedAt: Date.now() };
  }
  async simulate(id: string) {
    let r = await this.get(id);
    if (r.broadcastAttemptedAt !== null || pending(r) || r.status === 'SUCCESS') return r;
    if (r.status === 'SIMULATING') throw new ExecutionError('BUSY','Simulation is already running.');
    r.status = 'SIMULATING'; r.failure = null; event(r,'Dry run started','No signing or broadcast.'); r = await this.store.save(r);
    try { r.preflight = await this.preflight(r); r.status = 'READY'; event(r,'Dry run passed','Exact frozen payload simulated.'); }
    catch (e) { r.failure = failure(e); r.status = r.failure.code === 'MARKET_EXPIRED' ? 'STALE' : 'BLOCKED'; r.preflight = { passed: false, at: Date.now(), checks: [], failure: r.failure }; event(r,'Execution blocked',r.failure.message); }
    return this.store.save(r);
  }
  async authorize(r: EarnRecord, signature: Hex) {
    this.configured(); verifyEarn(r.intent);
    if (r.intent.authorizationDomain !== this.keeper.config.domain || r.intent.walletAddress.toLowerCase() !== this.keeper.config.wallet!.toLowerCase() || !this.keeper.config.operators.some(a => a.toLowerCase() === r.intent.operatorAddress.toLowerCase()) || !await verifyMessage({ address: r.intent.operatorAddress, message: earnAuthorization(r.intent), signature })) throw new ExecutionError('UNAUTHORIZED','Signature or configured operator does not authorize this Earn intent.');
  }
  async execute(id: string, signature: Hex) {
    let r = await this.get(id); await this.authorize(r,signature);
    if (r.broadcastAttemptedAt !== null) return this.refresh(id);
    if (!this.freeTierConfirmed()) throw new ExecutionError('CONFIGURATION_REQUIRED','Confirm free KeeperHub quota and disabled paid overage before enabling Earn writes.');
    if (r.status !== 'READY' || !r.preflight?.passed) throw new ExecutionError('INVALID_INPUT','A successful dry run is required.');
    freshEarn(r.intent);
    r.status = 'EXECUTING'; event(r,'User authorized','Signature bound to exact intent.'); r = await this.store.save(r);
    try { r.preflight = await this.preflight(r); }
    catch (e) { r.failure = failure(e); r.status = r.failure.code === 'MARKET_EXPIRED' ? 'STALE' : 'BLOCKED'; event(r,'Final preflight blocked',r.failure.message); return this.store.save(r); }
    // Save the at-most-once claim BEFORE contacting KeeperHub. Never resend an attempted write.
    r.broadcastAttemptedAt = Date.now(); event(r,'KeeperHub requested','Durable broadcast claim persisted.'); r = await this.store.save(r);
    try { this.capture(r,await this.keeper.execute(r.intent.payload,r.intent.intentHash)); }
    catch (e) { r.status = e instanceof KeeperRejection ? 'FAILED' : 'CONFIRMING'; r.failure = failure(e); event(r,'KeeperHub response unresolved',r.failure.message); }
    return this.store.save(r);
  }
  private capture(r: EarnRecord, response: KeeperResponse) {
    const b = response.body;
    if (typeof b.executionId === 'string' && /^[\w-]{1,200}$/.test(b.executionId)) {
      if (r.keeperHubExecutionId && r.keeperHubExecutionId !== b.executionId) throw new ExecutionError('PROOF_MISMATCH','KeeperHub execution ID changed.');
      r.keeperHubExecutionId = b.executionId;
    }
    if (typeof b.transactionHash === 'string' && hashPattern.test(b.transactionHash)) {
      if (r.txHash && r.txHash !== b.transactionHash) throw new ExecutionError('PROOF_MISMATCH','KeeperHub transaction hash changed.');
      r.txHash = b.transactionHash as Hex;
    }
    r.keeperHubStatus = typeof b.status === 'string' ? b.status : 'unknown';
    r.pollAfterMs = response.pollAfterMs; r.status = 'CONFIRMING';
    if (!r.keeperHubExecutionId) r.failure = { code: 'EXECUTION_UNCERTAIN', message: 'No execution ID returned. Reconcile the KeeperHub audit; do not resubmit.' };
  }
  async refresh(id: string) {
    let r = await this.get(id);
    if (r.broadcastAttemptedAt === null && Date.now() >= r.intent.expiresAt && !['STALE','SUCCESS','FAILED'].includes(r.status)) { r.status = 'STALE'; event(r,'Intent expired','No broadcast claim exists.'); return this.store.save(r); }
    if (!pending(r) || !r.keeperHubExecutionId || Date.now() - r.lastPollAt < r.pollAfterMs) return r;
    // Persist polling throttle, even when the upstream read later fails.
    r.lastPollAt = Date.now(); r = await this.store.save(r);
    try {
      const response = await this.keeper.status(r.keeperHubExecutionId!);
      if (response.body.executionId !== r.keeperHubExecutionId) throw new ExecutionError('PROOF_MISMATCH','Status returned a different execution ID.');
      this.capture(r,response);
      const receipts = Array.isArray(response.body.receipts) ? response.body.receipts.map(object) : [];
      const receipt = receipts.find(p => p.hash === r.txHash && p.chainId === EARN_CHAIN && p.verified === true);
      if (r.txHash && r.keeperHubStatus === 'completed' && receipt?.receiptStatus === 'success') {
        r.proof = await this.protocol.verify(r.intent,r.txHash); r.status = 'SUCCESS'; r.failure = null; event(r,'Aave proof verified','Exact call, Aave event and underlying token movement verified independently.');
      } else if ((!r.txHash && r.keeperHubStatus === 'failed') || (receipt && ['reverted','safe_inner_failure'].includes(String(receipt.receiptStatus)))) { r.status = 'FAILED'; r.failure = normalizeKeeperError(response.body); }
      else { r.failure = { code: 'EXECUTION_UNCERTAIN', message: 'Waiting for matching verified Sepolia receipt and Aave proof. No resend.' }; }
    } catch (e) { r.failure = failure(e); r.status = 'CONFIRMING'; r.pollAfterMs = Math.min(60_000,r.pollAfterMs * 2); }
    if (r.timeline.length > 100) r.timeline = [...r.timeline.slice(0,20),...r.timeline.slice(-80)];
    return this.store.save(r);
  }
  async recover(id: string, executionId: string, signature: Hex) {
    let r = await this.get(id); await this.authorize(r,signature);
    if (r.broadcastAttemptedAt === null || !pending(r) || r.keeperHubExecutionId) throw new ExecutionError('INVALID_INPUT','Only unresolved attempted executions without an ID may be recovered.');
    const response = await this.keeper.status(executionId), b = response.body;
    if (b.executionId !== executionId || typeof b.transactionHash !== 'string' || !hashPattern.test(b.transactionHash)) throw new ExecutionError('PROOF_MISMATCH','Recovery needs the original KeeperHub execution and transaction.');
    await this.protocol.verify(r.intent,b.transactionHash as Hex);
    this.capture(r,response); event(r,'Execution ID recovered','Exact onchain payload and Aave proof checked before binding ID.');
    r = await this.store.save(r); return this.refresh(r.intent.id);
  }
}
