# STEP 1 reconciliation — 2026-09-13

STEP 1 is **SUCCESS / VERIFIED**, not just KeeperHub-confirmed. No new transaction was submitted. STEP 2 was prepared and simulated only; it has no broadcast claim, execution ID or transaction hash. No supply, withdrawal, mainnet operation or billing change occurred.

## Existing execution and immutable intent

| Field | Verified value |
| --- | --- |
| Network | Ethereum Sepolia, chain ID 11155111 |
| Intent ID | `3d22f010-7969-4d1e-af2a-b0b3190470ac` |
| Frozen hash | `0x725a6aec7a61841b88660a0d4aebbdd3a7eee9fde25e04a0abaec6a01df782fd` |
| KeeperHub execution ID | `n6nukxlv993auch3ijex7` |
| Transaction hash | `0xb4e35d6908e95e6b0bd6efc7994e9a4c58180af9d28ccfbf623f6ca4c6085026` |
| Receipt | success, block 11671820 |
| Block hash | `0x17de027fd7d7596e722b79b3b577ec7441c7c22b740195b9d3e3f3874624d184` |
| Confirmations at verification | 21462 (minimum 2) |
| Proof saved at | 2026-09-13 03:28:33.038 UTC |
| Outer sender / sponsor | `0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87` |
| Outer target | `0x5af5194b4b0909eb978e3cf1e25333852277f07d` |
| Outer nonce / value | 45659 / 0 ETH |
| Executor and both recovered signers | `0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0` |
| Inner target / LINK | `0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5` |
| Approval spender | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| Amount / inner value | 500000000000000000 (0.5 LINK) / 0 ETH |
| Authorization / execution nonce | Both 0; account and delegate nonce independently observed advancing to 1 |
| Allowance at receipt block | 500000000000000000 |
| Current allowance at verification | 500000000000000000, block 11693281 |
| Current-state block hash | `0xc1bf5c949901d8a9a10f44e56d60ed35bb1eb8968a478fd0a757f05650f86574` |

The original database `intent` string was compared before/after reconciliation and remained byte-for-byte unchanged. Only execution metadata, proof, revision and verification timeline were updated. The full outer calldata is retained in the proof and visible under **Full sponsored proof** in the Earn UI.

Exact verified inner call:

```text
approve(0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951, 500000000000000000)
0x095ea7b30000000000000000000000006ae43d3271ff6888e7fc43fd7321a503ff73895100000000000000000000000000000000000000000000000006f05b59d3b20000
```

## Root cause and trusted deployment

The old direct verifier correctly rejected `transaction.from`, `transaction.to`, `transaction.input`, `receipt.from` and `receipt.to`: it compared the sponsored outer envelope with the frozen inner intent. The solution is a separate verifier, not accepting mismatches in the direct path.

Only Turnkey Gas Station **v1.1** at the address above and delegate `0x955d84139e7621bc571b117d8eb5d28a4a222c6f` are allowlisted. Turnkey publishes these deployments for Sepolia in its [official deployment list](https://github.com/tkhq/gas-station#deployments-v11). The supported four-argument execute overload forwards one call to the delegated executor; see the [wrapper implementation](https://raw.githubusercontent.com/tkhq/gas-station/main/src/TKGasStation/TKGasStation.sol).

Historical bytecode pins, independently read at block 11671820:

```text
wrapper:  0xe4d6148bc2ecd5409b1c3b488cd54a099957a57104310009e42055e10ec66daa
delegate: 0x5db3af5e712d94b894ac715ecc2f57145fb56a663354ee192087e6bf6d729f61
```

These are deployment trust anchors, not a claim that we reproduced the Solidity compilation. Chain/receipt/state reads trust the selected Sepolia RPC. Signers are recovered locally rather than taken from KeeperHub fields.

## Mandatory sponsored checks

1. Frozen intent hash and existing deployment/action/amount allowlists remain valid. Direct envelope checks are unchanged in strength.
2. Transaction and receipt type EIP-7702, chain exactly 11155111, successful receipt, both hashes equal the bound transaction, zero outer native value, allowlisted outer target and consistent receipt sender.
3. Canonical block/hash/index and receipt log binding; at least two confirmations. Re-read the mined and state blocks after verification to detect a reorg during the reads.
4. Original durable KeeperHub execution ID, tx hash, intent hash and broadcast timestamp are required. Check the complete wallet history for reuse of either hash or execution ID by another intent. Mining must occur within this conservative intent window and after its original broadcast claim.
5. Historical wrapper/delegate bytecode hashes must match the pins. Executor code must be exactly `0xef0100` followed by the allowlisted delegate address.
6. Only `execute(address,address,uint256,bytes)`, selector `0x9aefaff8`. Decode then re-encode the entire outer call exactly: no unknown selectors, noncanonical offsets, padding changes, trailing data or arbitrary wrappers.
7. Decode packed signature (65 bytes), nonce (16), deadline (4), and remaining inner calldata. Match executor, target, zero value and complete calldata bytes to the frozen intent. This includes exact spender and amount, not merely the function selector.
8. Exactly one EIP-7702 authorization, restricted to Sepolia and the allowlisted delegate. Recover its signer locally; require the frozen executor and the historical account nonce transition `authorization.nonce → nonce+1`.
9. Independently recover the inner EIP-712 signer with domain `TKGasDelegate`, version `1.1`, chain 11155111 and verifying contract = executor. Verify signed nonce, deadline, target, value and calldata. Check mined timestamp against deadline and consumed delegate nonce. These fields follow the [delegate implementation](https://raw.githubusercontent.com/tkhq/gas-station/main/src/TKGasStation/TKGasDelegate.sol).
10. Receipt must include the exact LINK Approval(owner=executor, spender=pool, amount=500000000000000000). Read allowance at the receipt block and at a captured current block; both must equal the frozen amount. Neither an event nor allowance alone is sufficient.

The proof records `keeperhub-sponsored-eip7702`, original execution ID/hash, outer and inner fields, both recovered signers, delegation/code pins, nonce/deadline, receipt status, confirmations and block-bound event/state verification. The UI labels the allowance as a saved snapshot, not a permanently current balance.

## Files changed

- `server/earn-sponsored.ts`: strict envelope/authorization/delegation verifier and trust pins.
- `server/earn-protocol.ts`: separate dispatch, shared exact event checks, historical/state reads, canonical block verification and read-only receipt fallback.
- `server/earn-service.ts`: bind verification to original execution metadata; reject proof reuse; persist verified result.
- `shared/earn.ts`: mode-aware proof types and sponsored evidence fields.
- `src/earn/EarnPage.tsx`: explicit VERIFIED status, sponsor/executor distinction and evidence snapshot; hide new-submission safety warnings on already submitted records.
- `scripts/earn-reconcile.ts`: scoped original STEP 1 reconciliation and optional exact STEP 2 dry run. Transport allowlist plus an execute method that always throws; no signing/broadcast path.
- `tests/earn-sponsored.test.ts`: 40 sponsored-verifier regression tests.
- `tests/earn.test.ts`: reconciliation binding and cross-intent hash/execution ID replay regressions.
- `tests/e2e/earn.spec.ts`: VERIFIED label and sponsored proof/no-resend UI regression.
- This report.

## Verification results

- TypeScript typecheck: PASS.
- All Vitest unit/integration tests: **216 passed, 13 files** (including 105 Earn tests).
- Production build: PASS.
- Earn browser E2E tests: **6 passed**. Wallet and execution responses were explicitly mocked; these tests did not submit live transactions.
- Live local UI → GET API → durable database → rendered proof: PASS, HTTP 200, SUCCESS, sponsored mode, verified=true, exact allowance. Disabled resend controls confirmed.
- Browser screenshot inspected; meaningful content, no error overlay or application console errors. Home navigation also checked.

Publicnode returned the original mined transaction but `null` for its receipt. The no-key public Tenderly Sepolia endpoint returned the receipt and historical state. The verifier falls back for receipt reads, verifies chain ID again, and obtains all remaining proof evidence from the selected reader; no paid plan or account was created.

## STEP 2 — simulation review only

| Field | Prepared value |
| --- | --- |
| Intent ID | `78576827-fd72-4caf-be8d-e8c0f33f40e9` |
| Intent hash | `0xd19d69ade410b7c60bac17a6cb61c12f70d0ea70abdcd5f383b172169b431e11` |
| Network | Ethereum Sepolia, 11155111 |
| Executor / beneficiary | `0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0` |
| Target | Aave Pool `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| Asset | LINK `0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5` |
| Amount / value / referralCode | 500000000000000000 (0.5 LINK) / 0 ETH / 0 |
| Simulation | PASS, wouldRevert=false, gas estimate **218328** |
| Simulated at | 2026-09-13 03:33:13.236 UTC |
| Intent expiry | 2026-09-13 03:43:09.945 UTC (10:43:09.945 Vietnam time) |
| Broadcast claim / KeeperHub ID / tx hash | All null — **not executed** |

```text
supply(asset=0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5,
       amount=500000000000000000,
       onBehalfOf=0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0,
       referralCode=0)

0x617ba037000000000000000000000000f8fb3713d459d7c1018bd0a49d19b4c44290ebe500000000000000000000000000000000000000000000000006f05b59d3b200000000000000000000000000005845504e0bf70d28820a89b4ec12bd4cab9116a00000000000000000000000000000000000000000000000000000000000000000
```

## Remaining limits / next gate

STEP 1 has no remaining reconciliation blocker. The new sponsored path deliberately supports only this audited **single-call approval with an included EIP-7702 authorization**. Sponsored supply/withdrawal, batches, other overloads and reuse of pre-existing delegation without an included authorization remain fail-closed. Support and tests for the actual next-step envelope must be added before authorizing a sponsored supply; a successful dry run alone does not establish proof-verifier readiness for that transaction.

No STEP 2 execution is authorized by this report. Wait for explicit user approval and manual MetaMask authorization, then recheck state, billing conditions and simulation before any future broadcast. After expiry, a fresh reviewed intent is required; never modify this frozen intent's expiry. No withdrawal is prepared or authorized.

Work remains on `keeperhub-integration`; no merge to `main`, Git commit, push, or tag mutation was performed in this turn.
