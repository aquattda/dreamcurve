# Executor funding and safe demo limits

Scope: KeeperHub testnet funding verification and trade/demo caps only. All new
work is on `keeperhub-integration`. No funding transaction, token mint, trade,
mainnet call, bridge, purchase or deployment was performed by this change.

## Actual read-only verification

Update at **2026-09-09T03:57:26.335Z**: API key, organization wallet, operator and
EOA configuration checks passed. Authenticated `GET /api/user/safe` returned an
empty Safe list; both supplied addresses have no contract bytecode on Shannon.
The official signer resolver defaults to the organization EOA when no Safe exists,
so local `KEEPERHUB_SIGNER_MODE=eoa` is now set for this verified connection.

Latest update at **2026-09-09T09:14:13.218Z**, after the user completed MetaMask
funding: the executor has **0.1 STT / 5 tUSDC**, using the verified collateral
contract below. Funding readiness passes against the observed 0.024 STT initial
gas reserve and 1 tUSDC requirement. Authentication and EOA configuration also pass.
The [prepared funding requests](keeperhub-funding-transactions.json) remain a
historical unsigned preparation artifact; the agent did not broadcast them and
no transfer hash has been recorded here. Do not repeat those transfers merely
because that artifact still says unsigned.

A direct read-only `balanceOf` simulation request to hosted KeeperHub returned
HTTP 400, `Chain 50312 not found or not enabled`. Changing local RPC settings does
not enable this chain on KeeperHub's servers. The user selected hosted support;
see the [support request draft](KEEPERHUB_HOSTED_SUPPORT_REQUEST.md).

The earlier baseline follows for historical comparison:

`npm run keeperhub:doctor`, checked at **2026-09-09T03:14:42.959Z**:

| Check | Observed result |
| --- | --- |
| RPC network | Somnia Shannon, chain 50312 |
| KeeperHub organization wallet authentication | Passed; address matches configured executor |
| Executor | `0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0` |
| Operator | `0x2b270B135667f38bB58Fc9376F29c95173641D31` |
| Executor STT | **0 STT** |
| Executor collateral | **0 tUSDC** |
| Verified collateral contract | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| Collateral decimals | 6 |
| Active market checked | `0x0000000000000000000000000000000000000000000000000000000000017a3b` |
| Initial gas reserve at observed gas price | 0.024 STT |
| KeeperHub hosted Shannon support | Not advertised; blocked |
| Explicit EOA execution mode | Not confirmed; blocked |

These are observations at the timestamp above. Runtime discovers active markets
and reads their collateral; it does not hardcode the historical market or token
address from this report. Re-run the doctor to verify current values.

Current status: **FUNDED; HOSTED SHANNON ENABLEMENT REQUIRED**. The zero-balance
table above is historical, not the latest result. Funding alone does not enable
hosted KeeperHub execution. Future approvals/trades still require authorization.

## Backend enforcement

The server checks `KEEPERHUB_CHAIN_ID=50312`; any other value fails closed. The
funding reader verifies the RPC chain before reading contracts, then requires the
market collateral to match `SOMNIA_TESTNET_ADDRESSES.collateral ?? testUsdc` from
the existing SDK. Token decimals are read onchain and matched to the market.
The executor address comes only from server configuration, not the browser.

`checkExecutorFunding()` blocks missing STT and collateral with
`INSUFFICIENT_EXECUTOR_GAS` and `INSUFFICIENT_EXECUTOR_COLLATERAL`. A different token
or decimals returns `COLLATERAL_MISMATCH`. Initial gas reserve uses 2,000,000 gas
units × live gas price × 2. After simulation it uses the actual gas estimate ×
live gas price × 2. This is a conservative changing estimate, not a fixed gas fee.

`KEEPERHUB_MAX_TRADE_TUSDC=1` and `KEEPERHUB_MAX_SESSION_TUSDC=5` are server-only
defaults and hard demo ceilings. They may be lowered but not increased past 1/5.
Parsing and comparisons use integer units with the token's authoritative decimals;
excess precision is rejected rather than rounded. Exposure is normalized to 18
integer decimal places solely to combine historical records consistently.

The demo scope is the executor's durable database history, shared across operators,
tabs and server processes using that same database. It is **not** a browser session
or daily reset. Attempted trade budgets, including uncertain/failed attempts,
continue to count conservatively; approvals do not count twice. An EXECUTING claim
reserves its full reviewed stake. The existing unique in-flight wallet constraint
and a budget recheck after claiming prevent concurrent requests from overspending.
Unbroadcast claims released by the existing expiry recovery stop reserving budget.
There is no public reset endpoint. Retain the database; separate databases cannot
coordinate usage and must not be used for the same funded executor.

Preparation, simulation and final execution all enforce the policy, including
older frozen intents created before these limits. Server requests cannot supply
their own limit, usage total or alternative chain. `TRADE_LIMIT_EXCEEDED` and
`SESSION_LIMIT_EXCEEDED` identify the reason. Before asking for a signature, the UI
refreshes funding and limits; the server independently repeats its checks.

Read-only routes: `GET /api/executions/funding` (active Arena market, optional
`marketId`) and `GET /api/executions/:id/safety` (frozen intent). Funding readiness
does not imply that the full KeeperHub execution prerequisites are satisfied.

## Manual steps

1. The supplied organization key and addresses are configured in the Git-ignored
   local `.env`, with chain 50312 and limits 1 / 5. EOA mode has been verified and
   configured. Funding is now complete: skip steps 2–4 unless a fresh balance
   check shows additional test tokens are needed. Do not repeat the prepared
   MetaMask transfers automatically.
2. Obtain **STT test tokens** from the [Somnia testnet faucet](https://testnet.somnia.network/).
   If it accepts a destination address, use the executor above. If it funds only
   the connected MetaMask account, claim there, then manually send STT to the
   executor on Shannon. Retain some STT in MetaMask for the collateral faucet and
   transfer. The initial observed reserve was 0.024 STT; more is needed for several
   approvals/trades, and the app rechecks current gas requirements.
3. Open DreamCurve, connect the operator on Shannon and open **Portfolio**. When
   its test-token balance is zero, use **Claim 10,000 tUSDC** and explicitly confirm
   the faucet transaction in MetaMask. The existing legacy trade modal also offers
   this faucet for insufficient browser-wallet balance. Claiming tokens does not
   authorize or execute a trade.
4. In MetaMask, import the **verified collateral contract** shown by the latest
   doctor/status result (currently the address in the table, decimals 6). Manually
   send up to **5 test tUSDC** to the KeeperHub executor address on Shannon. A token
   with the same symbol but another contract is not valid. The remaining faucet
   tokens may stay in the browser wallet; they do not affect executor funding.
5. Run `npm run keeperhub:doctor` again. Confirm that the executor, token address
   and balances are correct. Open Executions to see funding and budget status.
6. Obtain hosted Shannon enablement through the
   [support request](KEEPERHUB_HOSTED_SUPPORT_REQUEST.md). EOA mode is already
   configured; retain it and verify the actual simulation sender after enablement.
   A maintainer accepting an issue is not proof the hosted chain is enabled.
7. Prepare a small trade (default input 0.5 tUSDC). Review funding/limits, run the
   dry run, explicitly approve any bounded allowance intent, then separately
   confirm and sign the trade. Expired intents require a new review.

Somnia documents the [network and testnet faucet sources](https://docs.somnia.network/developer/network-info).
No real-money purchase is required.

## Additional KeeperHub policy layer

The [official Direct Execution API](https://docs.keeperhub.com/api/direct-execution)
documents native-value daily caps and `GET /api/analytics/spend-cap` for inspecting
effective caps. Native-value caps do not measure this order's tUSDC transfer.
It also documents a recognized-stablecoin per-transaction ceiling; on self-hosted
KeeperHub the documented `EXECUTE_DEFAULT_STABLECOIN_CAP_MICRO_USD` can lower that
ceiling (1,000,000 micro-USD is 1 USD). This depends on token recognition and the
specific write path. It is not evidence that a custom dreamDEX order or this tUSDC
is covered. Validate that independently before claiming additional protection.
No invented token-policy API or automatic organization policy change is used.

## Changed implementation areas

- `server/executor-funding.ts`: exact-token/executor reads and funding guard.
- `server/execution-limits.ts`: exact decimal caps and conservative exposure.
- `server/execution-store.ts`: full-history exposure for SQLite and Postgres.
- `server/execution-service.ts`, `execution-protocol.ts`, `execution-routes.ts`,
  `keeperhub.ts`: enforce policy and expose read-only readiness checks.
- `shared/execution.ts`: typed status and failure contracts.
- `src/execution/`: funding/limits review, refreshed pre-sign checks and button guards.
- `scripts/keeperhub-doctor.ts`, `.env.example`: diagnostics and configuration.
- `tests/execution-safety.test.ts`, existing execution unit/browser tests: funding,
  exact-unit boundaries, HTTP bypass attempts, persistence and concurrency.

## Verification result

**CODE COMPLETE** for the two scoped funding/limit requirements, with the external
prerequisites above still blocking a real KeeperHub execution.

- TypeScript checks and production build: passed.
- Unit/integration suite: **111 passed across 11 files**.
- Relevant browser suite: **6 passed**, including missing funds, exhausted budget,
  and a test-fixture signed success flow; mobile overflow checks passed.
- Real browser inspection: page renders and home navigation works, with no
  JavaScript errors. The isolated UI verification server disabled market collection
  and correctly reported no active market instead of asserting funding readiness.
- `git diff --check`: passed for tracked changes; `.env` is Git-ignored.
- `npm run lint`: attempted; npm reports **Missing script: lint**.

All new test balances, signatures and transaction responses are explicit automated
test fixtures. Actual executor balances are the separately timestamped RPC results
above. No real KeeperHub transaction has been submitted.

SQLite integration is covered locally. The Postgres exposure implementation uses
the same full-history calculation but still needs a provisioned Postgres instance
for a live database integration run. The repository has no lint script or configured
linter; TypeScript, tests, build and whitespace checks are reported separately.
