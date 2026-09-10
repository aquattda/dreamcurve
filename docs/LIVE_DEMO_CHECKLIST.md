# Live demo checklist

## Before the panel

- Preserve dreamdex-hackathon-v1 and work on keeperhub-integration.
- Run typecheck, tests, build and browser tests. Record results and final commit.
- Configure the real KeeperHub endpoint, organization key, EOA and operator allowlist.
- Run `npm run keeperhub:doctor`; all checks must pass before live execution.
- Fund the KeeperHub wallet with STT and current SDK test collateral.
- Keep server time synchronized, use durable storage and preserve the audit database.
- Keep execution routes behind HTTPS outside local development.
- Verify organization writes use its EOA rather than a Safe.

## Success demonstration

1. Open Arena in live mode; select an active BTC/ETH market with sufficient lifetime.
   Use dynamic discovery; do not depend on yesterday's market or pool address.
2. Explain that existing forecast agents are quantitative baselines. Show a real
   recommendation, then prepare its execution intent.
3. Show wallet, collateral, side, quote, quantity, expiry, calldata and intent hash.
4. Dry-run through KeeperHub. If allowance is missing, follow the separate bounded
   approval review/signature flow, then return and re-simulate the trade.
5. Explicitly approve the exact trade; sign the operator authorization message.
6. Show execution progress, the real KeeperHub ID and confirmed transaction link.
7. Show independent dreamDEX order-event verification and actual filled quantity.
   Do not label an IOC with zero fills as a filled position.
8. Open the explorer and record real evidence in HACKATHON_SUBMISSION.md.

## Failure demonstration

Prepare an intent and allow it to expire. Attempt dry-run/execution and show
STALE/BLOCKED, unchanged hash/expiry and no broadcast request for that intent.
Create a new intent only after showing the blocked result.

## Recovery

- Market disappeared/expired: choose another active market and create a new intent.
- Unsupported chain or invalid key: repair KeeperHub configuration; never bypass it.
- Missing balance: fund the executing organization wallet, then repeat preflight.
- Simulator unavailable: wait for service recovery; broadcast remains disabled.
- Known execution ID pending: refresh/poll status; do not create a retry trade.
- Lost ID after interrupted write: locate its real KeeperHub audit record and use
  signed recovery. Exact sender/target/calldata must verify before binding the ID.
- Process died before the durable broadcast-attempt record: wait for intent expiry,
  then refresh to invalidate the unfinished preflight. An actual attempted broadcast
  retains its lock and requires KeeperHub reconciliation.

Capture a short video of the working integration. A slide-only presentation or
test-double recording does not satisfy the supplied submission requirements.
