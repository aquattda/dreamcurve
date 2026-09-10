# DreamCurve Earn — Aave V3 / Ethereum Sepolia

This is the user-approved alternative to waiting for hosted KeeperHub Shannon
support. The original master DOCX remains unchanged. Its dreamDEX-specific
submission requirements are not satisfied by an Aave transaction; the new
submission must name Aave and disclose the change of protocol.

## Scope and routes

- `/app/earn`: live executor balances, Aave reserve state, bounded action builder,
  and durable execution history.
- `/app/earn/:id`: exact frozen payload, operator authorization, real KeeperHub
  dry run, execution, recovery and independently checked proof.
- `/app`, portfolio and legacy dreamDEX executions remain on Somnia Shannon.
- All work stays on `keeperhub-integration`; no merge to main or frozen-tag rewrite.

This MVP uses explicit manual supply/withdraw decisions, not an LLM or a new yield
prediction model. The existing Arena quantitative agents have not been relabeled
as Aave agents. No borrowing, leverage, mainnet or guaranteed-return claims.

## Configuration and zero-real-money policy

Reuse the existing server-only KeeperHub key, executor, operator allowlist and EOA
mode. Keep `KEEPERHUB_CHAIN_ID=50312` for legacy dreamDEX. Earn has independent
`EARN_CHAIN_ID=11155111` and `EARN_RPC_URL`; the default is the public Sepolia RPC
`https://ethereum-sepolia-rpc.publicnode.com`. No paid RPC subscription is created.
Read-only RPC requests are batched with one bounded retry. KeeperHub broadcasts
are NOT transport-retried.

`EARN_FREE_TIER_CONFIRMED` defaults to false. Before setting it to true, the
operator must check their KeeperHub account's free quota and make sure paid
overage is not enabled. This flag is an operator acknowledgment, NOT an automated
billing verification or a permanent quota guarantee. DreamCurve never changes
billing, subscribes to a plan, or purchases tokens. Monitor quota during demos.
If quota cannot be verified without paying, leave writes disabled.

The local `.env` is already Git-ignored. Put any local values there, not in client
`VITE_` variables. No new API key or wallet private key is required.

## Verified deployment allowlist

Source: [Aave DAO address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Sepolia.sol).

| Field | Value |
| --- | --- |
| Network | Ethereum Sepolia, 11155111 |
| PoolAddressesProvider | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` |
| Pool | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| Data Provider | `0x3e9708d80f7B3e43118013075F7e95CE3AB31F31` |
| Default Aave test LINK | `0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5`, 18 decimals |
| aLINK | `0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24` |
| Legacy Aave test USDC | `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`, 6 decimals |
| aUSDC | `0x16dA4541aD1807f4443d92D26044C1147406EB80` |
| Aave faucet | `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D` |

Provider→Pool and reserve→aToken mappings and token decimals are checked onchain.
A deployment mismatch blocks execution and requires an explicit source review.
No client-supplied contract, ABI, token, recipient or spender is accepted.

New UI intents default to Aave test LINK. USDC remains explicitly allowlisted for
legacy intents; existing payloads, hashes and authorizations are never converted.
At the 2026-09-09 audit, the USDC, USDT and DAI reserves exceeded their supply
caps. LINK was active, not paused/frozen, with supply cap 0 (no protocol cap).
Every preflight checks current state again; this is not a future availability guarantee.

## Funding and first demo

1. Run `npm run earn:doctor` (`npm.cmd` on PowerShell if script policy blocks npm).
   It only reads state; it does not prepare a persistent intent, sign or broadcast.
2. Fund executor `0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0` with **free Sepolia
   ETH** for gas. Do not buy ETH or bridge mainnet assets. Faucet limits/login
   requirements may require a user browser. Somnia STT is not Sepolia ETH.
3. Use the official [Aave interface](https://app.aave.com/) in testnet mode,
   Ethereum Sepolia V3 market, to obtain its Aave test LINK. Verify the exact token
   address above; a Chainlink faucet token with a different address is not this reserve asset.
   If tokens arrive in the browser operator wallet, manually send up to 5 test
   LINK to the executor on Sepolia. Keep Sepolia ETH in the operator wallet for
   any faucet/transfer gas. Never provide a private key or seed phrase.
4. Confirm KeeperHub free quota/disabled overage as described above, then have
   the local server operator set `EARN_FREE_TIER_CONFIRMED=true` and restart.
5. Open Earn, connect the authorized operator on Sepolia, and prepare an
   **APPROVAL for 0.5 test LINK**. Review, dry-run, then separately authorize it.
   Wait for verified approval proof. Skip this only if sufficient allowance
   already exists onchain.
6. Prepare a new **SUPPLY for 0.5 test LINK**, dry-run and authorize. Open its real
   KeeperHub ID and Sepolia transaction evidence. SUCCESS requires both the
   matching Aave event and underlying token Transfer, not just an API success.
7. Prepare a separate **WITHDRAW for 0.5 test LINK** back to the same executor.
   Review, simulate, authorize, and verify again. No arbitrary recipient is allowed.
8. Demonstrate an expired intent or failed mandatory preflight being blocked.
   Save actual execution IDs/hashes and record a video only after live success.

At 2026-09-09T14:12:03Z, the read-only doctor verified the KeeperHub connection
and LINK reserve mapping, but the executor had 0 Sepolia ETH, 0 test LINK and
0 aLINK. Free-tier confirmation was false. No approval/supply dry run or real
execution is claimed by this read-only check.

Funding and wallet signatures are explicit user actions; no faucet transaction,
approval, supply or withdrawal has been broadcast by the coding agent.

## Safety and limitations

- 1 test token maximum per action; separate durable ceilings of 5 supplied and 5
  withdrawn. Approvals do not count as token movement. Attempted/uncertain/failed
  writes remain charged to the relevant budget; withdrawals do not reset supply.
  USDC (6 decimals) and LINK (18) amounts are normalized to 18 decimals before
  aggregation. This is a test-token count, not a USD valuation or exchange rate.
- SQLite/Postgres retain immutable intents, compare-and-swap revisions and a
  unique in-flight Earn executor lock. Keep one shared database per executor.
  Separate databases cannot coordinate budgets or duplicate protection.
- Every write requires an allowlisted operator's message signature, exact-payload
  KeeperHub simulation and a final fresh preflight after the durable wallet claim.
- Aave debt, paused/inactive reserve, frozen supply, supply cap, insufficient gas,
  token balance, allowance, position or liquidity block the relevant action.
- `getReserveIsPaused` on this Sepolia Data Provider reverts. Pause/freeze/cap are
  read from Pool `getConfiguration` using the
  [documented bitmap](https://aave.com/docs/aave-v3/smart-contracts/pool#getconfiguration),
  not assumed from SDK helper availability. Bit-decoding is unit-tested.
- Intents expire after 10 minutes. Aave supply/withdraw have no deadline argument:
  expiry prevents new submissions, not confirmation of an already-submitted call.
- Simulation must identify the correct EOA/target/value. Organizations with any
  Safe accounts are conservatively blocked until routing support is implemented.
- A timed-out broadcast is never resent. A missing ID can be recovered only with
  operator authorization and independent exact transaction/event verification.
- Proof checks require two Sepolia confirmations. RPC failures keep proof pending;
  no retry action is authorized by an uncertain receipt.
- The Aave prebuilt KeeperHub plugin's documented networks are mainnet. Earn uses
  KeeperHub Direct Execution with the explicit Aave Sepolia ABI instead.
- Live transaction proof, live Postgres validation, final submission commit/push,
  deployment, video and contact details remain outstanding until explicitly verified.

## Verification commands

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e -- tests/e2e/earn.spec.ts tests/e2e/execution.spec.ts
npm run earn:doctor
```

Start the normal app with `npm run dev`, then open `/app/earn` on the printed
server URL. Use the normal durable database for real execution; never use the
isolated in-memory browser-test database for a live audit trail.

Unit/integration and browser fixtures are explicitly simulated. They are never
written to the live audit database and are not hackathon transaction evidence.
