import { createPublicClient, decodeEventLog, erc20Abi, http, keccak256, parseAbi, type Address, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import { sepolia } from 'viem/chains';
import { AAVE, EARN_ASSETS, EARN_CHAIN, earnAbi, earnAssetFor, freshEarn, verifyEarn, type EarnIntent, type EarnProof, type EarnSnapshot } from '../shared/earn';
import { ExecutionError } from '../shared/execution';
import { TURNKEY, turnkeyNonceAbi, turnkeyNonceSlot, verifySponsoredEnvelope, type EarnVerificationContext } from './earn-sponsored';
import { A_LINK, aTokenProofAbi, type SupplyChainEvidence } from './earn-supply';

const providerAbi = parseAbi(['function getPool() view returns (address)']);
const dataAbi = parseAbi([
  'function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)',
]);
const accountAbi = parseAbi(['function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)', 'function getConfiguration(address asset) view returns ((uint256 data))']);
// Aave ReserveConfigurationMap: decimals 48..55, active 56, frozen 57,
// paused 60, whole-token supply cap 116..151. Read the deployed Pool directly:
// the Sepolia Data Provider does not implement getReserveIsPaused.
export function decodeReserveConfiguration(data: bigint) {
  return { decimals: Number((data >> 48n) & 255n), active: Boolean((data >> 56n) & 1n), frozen: Boolean((data >> 57n) & 1n), paused: Boolean((data >> 60n) & 1n), supplyCap: ((data >> 116n) & ((1n << 36n) - 1n)).toString() };
}
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
export function earnClient(endpoint = process.env.EARN_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new ExecutionError('CONFIGURATION_REQUIRED', 'Earn RPC must be an HTTPS URL without embedded credentials.');
  // Batch parallel reads instead of opening a connection for every balance/flag.
  // This client is read-only; one bounded transport retry cannot repeat a write.
  return createPublicClient({ chain: sepolia, transport: http(endpoint, { batch: { wait: 20, batchSize: 20 }, timeout: 15_000, retryCount: 1 }) });
}
export function checkEarnSnapshot(i: EarnIntent, s: EarnSnapshot, gasEstimate = '500000') {
  verifyEarn(i); freshEarn(i);
  if (s.chainId !== EARN_CHAIN || !same(s.walletAddress,i.walletAddress) || !same(s.pool,i.pool) || !same(s.token,i.token) || !same(s.aToken,i.aToken) || s.decimals !== i.decimals) throw new ExecutionError('PROOF_MISMATCH', 'Earn network, executor or Aave deployment changed.');
  if (!s.active || s.paused || (i.action !== 'WITHDRAW' && s.frozen)) throw new ExecutionError('MARKET_CLOSED', 'Aave reserve is inactive, paused or frozen for this action.');
  if (BigInt(s.debtBase) !== 0n) throw new ExecutionError('INVALID_INPUT', 'Earn demo requires an executor without Aave debt. Borrowing is not supported.');
  if (!/^\d{1,12}$/.test(gasEstimate) || BigInt(gasEstimate) <= 0n) throw new ExecutionError('SIMULATOR_UNAVAILABLE', 'Missing valid gas estimate.');
  if (BigInt(s.gasPrice) <= 0n) throw new ExecutionError('SIMULATOR_UNAVAILABLE', 'A positive live gas price is required.');
  if (BigInt(s.gasBalance) < BigInt(gasEstimate) * BigInt(s.gasPrice) * 2n) throw new ExecutionError('INSUFFICIENT_EXECUTOR_GAS', 'Fund the executor with free Sepolia ETH. Somnia STT cannot pay Sepolia gas.');
  const amount = BigInt(i.amount);
  if (i.action === 'WITHDRAW') {
    if (BigInt(s.aTokenBalance) < amount || BigInt(s.availableLiquidity) < amount) throw new ExecutionError('INSUFFICIENT_BALANCE', 'Insufficient Aave position or available reserve liquidity for this exact withdrawal.');
  } else {
    if (BigInt(s.tokenBalance) < amount) throw new ExecutionError('INSUFFICIENT_EXECUTOR_COLLATERAL', `Fund the executor with the allowlisted Aave Sepolia test ${earnAssetFor(i.token).symbol}, not a same-symbol token.`);
    if (i.action === 'SUPPLY' && BigInt(s.allowance) < amount) throw new ExecutionError('ALLOWANCE_REQUIRED', 'Prepare, review and execute a separate bounded approval first.');
    if (BigInt(s.supplyCap) > 0n && BigInt(s.supplied) + amount > BigInt(s.supplyCap) * 10n ** BigInt(i.decimals)) throw new ExecutionError('MARKET_CLOSED', 'Aave reserve supply cap would be exceeded.');
  }
}
export function verifyEarnReceipt(i: EarnIntent, hash: Hex, tx: Transaction, receipt: TransactionReceipt): EarnProof {
  verifyEarn(i);
  const checks: Record<string, boolean> = {
    'receipt.status': receipt.status === 'success',
    'receipt.transactionHash': receipt.transactionHash === hash,
    'transaction.hash': tx.hash === hash,
    'transaction.chainId': tx.chainId === EARN_CHAIN,
    'transaction.from': same(tx.from,i.walletAddress),
    'transaction.to': same(tx.to,i.payload.contractAddress),
    'transaction.input': tx.input.toLowerCase() === i.calldata.toLowerCase(),
    'transaction.value': tx.value === 0n,
    'receipt.from': same(receipt.from,i.walletAddress),
    'receipt.to': same(receipt.to,i.payload.contractAddress),
  };
  const mismatches = Object.entries(checks).filter(([,matches]) => !matches).map(([field]) => field);
  if (mismatches.length) {
    // Diagnose the actual envelope; never reinterpret a sponsored wrapper as
    // a direct transaction, or accept an allowance alone as intent proof.
    const routing = tx.type === 'eip7702' ? ' EIP-7702 envelope detected; sponsored-call reconciliation is required. Do not resubmit.' : '';
    throw new ExecutionError('PROOF_MISMATCH', `Sepolia transaction does not match this exact Earn intent. Mismatched fields: ${mismatches.join(', ')}.${routing}`);
  }
  verifyEarnEvents(i,receipt);
  return { mode: 'direct', transactionHash: hash, blockNumber: receipt.blockNumber.toString(), chainId: EARN_CHAIN, action: i.action, amount: i.amount, verified: true, confirmedAt: Date.now() };
}
// Shared event checks only. Never manufacture a direct envelope for a wrapper.
export function verifyEarnEvents(i: EarnIntent, receipt: TransactionReceipt) {
  let eventMatch = false, transferMatch = i.action === 'APPROVAL';
  for (const log of receipt.logs) {
    if (same(log.address,i.token)) {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (i.action === 'APPROVAL' && e.eventName === 'Approval' && same(e.args.owner,i.walletAddress) && same(e.args.spender,AAVE.pool) && e.args.value === BigInt(i.amount)) eventMatch = true;
        if (e.eventName === 'Transfer' && e.args.value === BigInt(i.amount)) {
          if (i.action === 'SUPPLY' && same(e.args.from,i.walletAddress) && same(e.args.to,i.aToken)) transferMatch = true;
          if (i.action === 'WITHDRAW' && same(e.args.from,i.aToken) && same(e.args.to,i.walletAddress)) transferMatch = true;
        }
      } catch { /* Ignore unrelated event signatures. */ }
    }
    if (same(log.address,AAVE.pool)) {
      try {
        const e = decodeEventLog({ abi: earnAbi, data: log.data, topics: log.topics });
        if (i.action === 'SUPPLY' && e.eventName === 'Supply' && same(e.args.reserve,i.token) && same(e.args.user,i.walletAddress) && same(e.args.onBehalfOf,i.walletAddress) && e.args.amount === BigInt(i.amount) && e.args.referralCode === 0) eventMatch = true;
        if (i.action === 'WITHDRAW' && e.eventName === 'Withdraw' && same(e.args.reserve,i.token) && same(e.args.user,i.walletAddress) && same(e.args.to,i.walletAddress) && e.args.amount === BigInt(i.amount)) eventMatch = true;
      } catch { /* Ignore unrelated event signatures. */ }
    }
  }
  if (!eventMatch || !transferMatch) throw new ExecutionError('PROOF_MISMATCH', 'Matching Aave event and exact underlying token movement are required.');
}
export interface EarnProtocol {
  snapshot(wallet: Address, token?: Address): Promise<EarnSnapshot>;
  verify(i: EarnIntent, hash: Hex, context?: EarnVerificationContext): Promise<EarnProof>;
  checkSupplyRoute?(i: EarnIntent): Promise<void>;
}
export function liveEarnProtocol(): EarnProtocol {
  const c = earnClient();
  return {
    async checkSupplyRoute(i) {
      verifyEarn(i);
      if (i.action !== 'SUPPLY' || i.token !== EARN_ASSETS.LINK.token) throw new ExecutionError('CONFIGURATION_REQUIRED','Sponsored SUPPLY supports only audited Sepolia LINK.');
      if (await c.getChainId() !== EARN_CHAIN) throw new ExecutionError('NETWORK_UNSUPPORTED','Supply route RPC is not Sepolia.');
      const block = await c.getBlock(), at = { blockNumber: block.number };
      const [wrapper,delegate,executor,implementation,implementationCode,pool,underlying,allowance] = await Promise.all([
        c.getCode({ address: TURNKEY.wrapper, ...at }), c.getCode({ address: TURNKEY.delegate, ...at }), c.getCode({ address: i.walletAddress, ...at }),
        c.getStorageAt({ address: i.aToken, slot: A_LINK.implementationSlot, ...at }), c.getCode({ address: A_LINK.implementation, ...at }),
        c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'POOL', ...at }),
        c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'UNDERLYING_ASSET_ADDRESS', ...at }),
        c.readContract({ address: i.token, abi: erc20Abi, functionName: 'allowance', args: [i.walletAddress,i.pool], ...at }),
      ]);
      if (keccak256(wrapper || '0x') !== TURNKEY.wrapperCodeHash || keccak256(delegate || '0x') !== TURNKEY.delegateCodeHash || (executor && executor !== '0x' && !same(executor,`0xef0100${TURNKEY.delegate.slice(2)}`)) || !same(implementation,`0x${'0'.repeat(24)}${A_LINK.implementation.slice(2)}`) || keccak256(implementationCode || '0x') !== A_LINK.codeHash || !same(pool,i.pool) || !same(underlying,i.token)) throw new ExecutionError('PROOF_MISMATCH','SUPPLY verifier deployment/delegation readiness check failed. No broadcast.');
      if (allowance !== BigInt(i.amount)) throw new ExecutionError('ALLOWANCE_REQUIRED','SUPPLY verifier requires an exact bounded allowance matching this amount. Do not auto-approve.');
      if ((await c.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new ExecutionError('EXECUTION_UNCERTAIN','Supply readiness block changed. Read again.');
    },
    async snapshot(wallet, token = EARN_ASSETS.LINK.token) {
      try {
      const asset = earnAssetFor(token);
      if (await c.getChainId() !== EARN_CHAIN) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Earn RPC must return Ethereum Sepolia 11155111.');
      const pool = await c.readContract({ address: AAVE.provider, abi: providerAbi, functionName: 'getPool' });
      if (!same(pool,AAVE.pool)) throw new ExecutionError('PROOF_MISMATCH', 'Aave Pool changed; review the deployment before creating new intents.');
      const [tokens, configuration, gas, gasPrice, balance, position, allowance, liquidity, supplied, decimals, account] = await Promise.all([
        c.readContract({ address: AAVE.dataProvider, abi: dataAbi, functionName: 'getReserveTokensAddresses', args: [token] }),
        c.readContract({ address: AAVE.pool, abi: accountAbi, functionName: 'getConfiguration', args: [token] }),
        c.getBalance({ address: wallet }), c.getGasPrice(),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
        c.readContract({ address: asset.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet,AAVE.pool] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [asset.aToken] }),
        c.readContract({ address: asset.aToken, abi: erc20Abi, functionName: 'totalSupply' }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
        c.readContract({ address: AAVE.pool, abi: accountAbi, functionName: 'getUserAccountData', args: [wallet] }),
      ]);
      const config = decodeReserveConfiguration(configuration.data);
      if (!same(tokens[0],asset.aToken) || decimals !== asset.decimals || config.decimals !== asset.decimals) throw new ExecutionError('COLLATERAL_MISMATCH', 'Aave reserve token mapping or decimals differ from the allowlist.');
      return { checkedAt: Date.now(), chainId: EARN_CHAIN, walletAddress: wallet, pool, token, aToken: tokens[0], decimals, gasBalance: gas.toString(), gasPrice: gasPrice.toString(), tokenBalance: balance.toString(), aTokenBalance: position.toString(), allowance: allowance.toString(), availableLiquidity: liquidity.toString(), debtBase: account[1].toString(), active: config.active, frozen: config.frozen, paused: config.paused, supplyCap: config.supplyCap, supplied: supplied.toString() };
      } catch (e) {
        if (e instanceof ExecutionError) throw e;
        const name = (e as { functionName?: unknown })?.functionName;
        const known = ['getPool','getReserveTokensAddresses','getConfiguration','balanceOf','allowance','totalSupply','decimals','getUserAccountData'];
        throw new ExecutionError('SIMULATOR_UNAVAILABLE', typeof name === 'string' && known.includes(name) ? `Aave Sepolia read failed at ${name}. Check the RPC and deployed contract; execution stays blocked.` : 'Sepolia RPC did not complete the state read. Retry the read or configure a working free EARN_RPC_URL. Execution stays blocked.');
      }
    },
    async verify(i, hash, context) {
      if (await c.getChainId() !== EARN_CHAIN) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Proof RPC is not Sepolia.');
      // Current reserve reads and historical proof reads can use endpoints with
      // different retention profiles. Both are independently chain-checked.
      let reader = process.env.EARN_PROOF_RPC_URL ? earnClient(process.env.EARN_PROOF_RPC_URL) : c;
      if (reader !== c && await reader.getChainId() !== EARN_CHAIN) throw new ExecutionError('NETWORK_UNSUPPORTED', 'Configured proof RPC is not Sepolia.');
      let receipt: TransactionReceipt;
      try { receipt = await reader.getTransactionReceipt({ hash }); }
      catch {
        // A public RPC may prune receipts. This no-key public endpoint is used
        // for reads only; all proof evidence is re-read from the selected RPC.
        reader = earnClient('https://sepolia.gateway.tenderly.co');
        if (await reader.getChainId() !== EARN_CHAIN) throw new ExecutionError('NETWORK_UNSUPPORTED','Fallback proof RPC is not Sepolia.');
        receipt = await reader.getTransactionReceipt({ hash });
      }
      const [tx, mined, latest] = await Promise.all([reader.getTransaction({ hash }), reader.getBlock({ blockNumber: receipt.blockNumber }), reader.getBlock({ blockTag: 'latest' })]);
      if (latest.number < receipt.blockNumber + 1n) throw new ExecutionError('EXECUTION_UNCERTAIN', 'Waiting for two Sepolia confirmations.');
      if (tx.blockHash !== mined.hash || receipt.blockHash !== mined.hash || tx.blockNumber !== receipt.blockNumber || tx.transactionIndex !== receipt.transactionIndex || receipt.logs.some(l => l.removed || l.transactionHash !== hash || l.blockHash !== mined.hash || l.blockNumber !== mined.number)) throw new ExecutionError('PROOF_MISMATCH','Canonical transaction, receipt and log block binding failed.');
      let proof: EarnProof;
      if (same(tx.to,TURNKEY.wrapper)) {
        const atReceipt = { blockNumber: receipt.blockNumber };
        const [wrapperCode,delegateCode,executorCode,executionNonceAfter,allowanceAtReceipt,currentAllowance,authorizationNonceBefore,authorizationNonceAfter] = await Promise.all([
          reader.getCode({ address: TURNKEY.wrapper, ...atReceipt }), reader.getCode({ address: TURNKEY.delegate, ...atReceipt }),
          reader.getCode({ address: i.walletAddress, ...atReceipt }),
          reader.readContract({ address: i.walletAddress, abi: turnkeyNonceAbi, functionName: 'nonce', ...atReceipt }),
          reader.readContract({ address: i.token, abi: erc20Abi, functionName: 'allowance', args: [i.walletAddress,i.pool], ...atReceipt }),
          reader.readContract({ address: i.token, abi: erc20Abi, functionName: 'allowance', args: [i.walletAddress,i.pool], blockNumber: latest.number }),
          reader.getTransactionCount({ address: i.walletAddress, blockNumber: receipt.blockNumber - 1n }),
          reader.getTransactionCount({ address: i.walletAddress, ...atReceipt }),
        ]);
        const prior = { blockNumber: receipt.blockNumber - 1n };
        const supplyReads = i.action === 'SUPPLY' ? await Promise.all([
          reader.getCode({ address: i.walletAddress, ...prior }), reader.getStorageAt({ address: i.walletAddress, slot: turnkeyNonceSlot, ...prior }),
          reader.getCode({ address: TURNKEY.wrapper, ...prior }), reader.getCode({ address: TURNKEY.delegate, ...prior }),
          readSupplyEvidence(reader,i,receipt.blockNumber,latest.number),
        ]) : null;
        const evidence = await verifySponsoredEnvelope(i,hash,tx,receipt,{
          blockHash: mined.hash, blockNumber: mined.number, timestamp: mined.timestamp, latestBlock: latest.number, latestBlockHash: latest.hash,
          wrapperCodeHash: keccak256(wrapperCode || '0x'), delegateCodeHash: keccak256(delegateCode || '0x'), executorCode: executorCode || '0x',
          executionNonceAfter, allowanceAtReceipt, currentAllowance, authorizationNonceBefore, authorizationNonceAfter,
          ...(supplyReads ? { executorCodeBefore: supplyReads[0] || '0x', executionNonceBefore: BigInt(supplyReads[1] || '0x0') & ((1n << 128n)-1n),
            wrapperCodeHashBefore: keccak256(supplyReads[2] || '0x'), delegateCodeHashBefore: keccak256(supplyReads[3] || '0x'), supply: supplyReads[4] } : {}),
        },context);
        verifyEarnEvents(i,receipt);
        proof = { transactionHash: hash, blockNumber: receipt.blockNumber.toString(), chainId: EARN_CHAIN, action: i.action, amount: i.amount, verified: true, confirmedAt: Date.now(), ...evidence, eventVerified: true as const };
      } else proof = verifyEarnReceipt(i,hash,tx,receipt);
      // Historical reads are block-number pinned. Detect a reorg spanning them
      // before accepting the proof (including the current allowance snapshot).
      const [minedAgain,latestAgain] = await Promise.all([reader.getBlock({ blockNumber: mined.number }),reader.getBlock({ blockNumber: latest.number })]);
      if (minedAgain.hash !== mined.hash || latestAgain.hash !== latest.hash) throw new ExecutionError('EXECUTION_UNCERTAIN','Sepolia block changed during proof verification. Read again; do not resend.');
      return proof;
    },
  };
}

async function readSupplyEvidence(c: ReturnType<typeof earnClient>, i: EarnIntent, receiptBlock: bigint, stateBlock: bigint): Promise<SupplyChainEvidence> {
  const before = { blockNumber: receiptBlock-1n }, after = { blockNumber: receiptBlock };
  const [tokenBefore,tokenAfter,allowanceBefore,scaledBefore,scaledAfter,currentScaled,previousIndexBefore,indexAfter,implementationBefore,implementationAfter,code,pool,underlying] = await Promise.all([
    c.readContract({ address: i.token, abi: erc20Abi, functionName: 'balanceOf', args: [i.walletAddress], ...before }),
    c.readContract({ address: i.token, abi: erc20Abi, functionName: 'balanceOf', args: [i.walletAddress], ...after }),
    c.readContract({ address: i.token, abi: erc20Abi, functionName: 'allowance', args: [i.walletAddress,i.pool], ...before }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'scaledBalanceOf', args: [i.walletAddress], ...before }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'scaledBalanceOf', args: [i.walletAddress], ...after }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'scaledBalanceOf', args: [i.walletAddress], blockNumber: stateBlock }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'getPreviousIndex', args: [i.walletAddress], ...before }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'getPreviousIndex', args: [i.walletAddress], ...after }),
    c.getStorageAt({ address: i.aToken, slot: A_LINK.implementationSlot, ...before }), c.getStorageAt({ address: i.aToken, slot: A_LINK.implementationSlot, ...after }),
    c.getCode({ address: A_LINK.implementation, ...after }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'POOL', ...after }),
    c.readContract({ address: i.aToken, abi: aTokenProofAbi, functionName: 'UNDERLYING_ASSET_ADDRESS', ...after }),
  ]);
  return { tokenBefore,tokenAfter,allowanceBefore,scaledBefore,scaledAfter,currentScaled,previousIndexBefore,indexAfter,implementationBefore: implementationBefore || '0x',implementationAfter: implementationAfter || '0x',implementationCodeHash: keccak256(code || '0x'),pool,underlying };
}
