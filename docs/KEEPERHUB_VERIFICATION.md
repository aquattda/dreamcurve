# Implementation verification — 2026-09-08 / 09

Scope: local DreamCurve integration on keeperhub-integration. This report is not
proof of a live KeeperHub transaction and does not mark the submission complete.

## Passed checks

- `npm run build`: TypeScript and production Vite build passed.
- `npm test`: 111 tests across 11 files passed after executor funding and demo limits (2026-09-09).
- Earlier full browser regression suite: 20 tests passed, including existing Arena,
  chart, portfolio, market removal, wallet changes and mobile navigation.
- Latest KeeperHub browser suite: 6 tests passed, including signed success,
  missing executor funds and exhausted demo budget. Total unique browser cases
  tested across the earlier regression and later targeted runs is 23.
- `npm run lint`: unavailable because the repository has no lint script/configuration.
  This is not reported as a lint pass.
- Actual browser inspection with agent-browser + headless Edge: execution history
  and landing navigation render, no application console errors, mobile width
  390px is readable. The frozen-intent mobile browser test checks no horizontal overflow.
- `git diff --check`: passed for tracked modifications.
- `git apply --check docs/keeperhub-somnia.patch` in the pinned KeeperHub reference
  repository: passed. This checks patch application only, not upstream runtime.

## Safety cases covered by tests

- Canonical serialization, same input/same hash, altered payload/different hash.
- BUY_NO encoding uses kind 2 and the YES-side contract price.
- Invalid tick, lot, minimum, decimals, escrow, order type and expiry are rejected.
- A real operator signature is verified against the exact authorization message.
- Dry run is mandatory; balance, allowance, gas, expiry, market and simulation
  failures block execution.
- Reviewed payload equals all simulation and broadcast payloads.
- Concurrent Execute requests and process restart cannot repeat an attempted write.
- SQLite reopen preserves the intent and broadcast claim.
- Ambiguous timeout remains CONFIRMING and locks that executing wallet.
- Explicit pre-broadcast rejection terminates safely without retrying the intent.
- Interrupted preflight without an attempted broadcast becomes STALE on expiry;
  compare-and-swap prevents a competing preflight from submitting afterwards.
- KeeperHub completed alone is insufficient. Matching verified receipt plus
  independent protocol verification are needed for SUCCESS.
- A reverted receipt on another chain cannot release an uncertain Shannon broadcast.
- Receipt parsing differentiates placement/resting/partial/full fills, ignores
  unrelated logs and checks exact bounded Approval events.
- UI requires explicit review and signature; expired intents cannot execute.

All simulated API responses, transactions and keys in automated tests are labeled
test fixtures. They were not inserted into the running application's audit history.

## Actual read-only network evidence

The latest funding-specific audit at `2026-09-09T09:14:13.218Z`, after the user's
MetaMask transfers, authenticated the configured KeeperHub organization wallet
and verified **0.1 STT / 5 tUSDC** on Shannon, using the exact active-market
collateral with 6 decimals. Funding, operator and EOA configuration checks pass.
The remaining doctor failure is hosted Shannon support, also confirmed by an
earlier upstream HTTP 400 read-only contract-call probe. The user chose hosted
enablement; a support request is drafted but not submitted. See
[funding, limits and manual steps](KEEPERHUB_FUNDING_AND_LIMITS.md).

Earlier baseline observations follow for historical context:

`npm run keeperhub:doctor` at `2026-09-08T16:47:40.245Z`:

- Hosted KeeperHub does not advertise enabled Shannon 50312.
- KeeperHub API key, organization wallet and operator configuration were absent.
- Independent Shannon RPC returned chain ID 50312.

`npm run doctor` subsequently passed:

- Shannon chain ID 50312; observed block 483135203.
- Indexer discovery returned 30 market rows.
- An active ETH event market was read onchain with nonempty YES/NO books.
- Collateral decimals: 6. Tick: 1000 raw. Lot: 1000 raw.
- Market discovery/normalization worked using SDK 0.29.0.

Those market/pool observations are historical diagnostics, not permanent addresses
or demo fixtures. Runtime continues to resolve active markets dynamically.

## Outstanding evidence and prerequisites

- A real KeeperHub endpoint with enabled Shannon execution.
- Funding, organization authentication and EOA configuration now pass; the key
  remains server-side. Hosted Shannon execution support is still required.
- Real KeeperHub dry run, execution ID, confirmed transaction and dreamDEX value movement.
- Live Postgres integration test against a provisioned database.
- Upstream KeeperHub typecheck/tests and runtime validation of the Shannon patch.
- Source review/push, final submission commit, deployment, working demo video,
  real transaction URL and contact details.

The original main and dreamdex-hackathon-v1 still resolve to
`4655455e573a64b6d9e1cc46150b6c2bc6fa7453`. New implementation files are local
changes on keeperhub-integration; no merge, deployment or upstream PR was performed.
Read-only origin verification on 2026-09-09 confirmed both remote branches and
the peeled hackathon tag still point to that baseline. The new implementation
has not been committed or pushed yet.
