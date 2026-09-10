# DREAMCURVE → KEEPERHUB INTEGRATION AUDIT

Baseline: `4655455e573a64b6d9e1cc46150b6c2bc6fa7453`, preserved by
`dreamdex-hackathon-v1`. Work branch: `keeperhub-integration`.

## Current execution

React 19 / Vite 8 → TradeModal → wallet.placeStake → SDK 0.29 quote and
createTrader.placeOrder → browser wallet approval → BinaryPool.placeBinaryOrder
→ Shannon receipt → browser portfolio journal.

Express 5 collects live markets and quantitative forecasts. These agents are
rule-based quantitative baselines, not LLM calls. SQLite (local) or Postgres
(DATABASE_URL) stores market snapshots, canonical forecasts and settlements.
There was no root README at baseline.

## Target execution

DreamCurve recommendation → server-built immutable ExecutionIntent → review →
KeeperHub dry run → authorized operator's signature → durable claim → KeeperHub
Direct Execution → independently verified Shannon receipt and dreamDEX events.
Approval is a separate reviewed, simulated, signed intent for the exact escrow.
The KeeperHub EOA owns collateral and resulting positions, not the browser wallet.

## Reuse

- server/discovery.ts and server/protocol.ts: registry/SDK discovery and chain reads.
- shared/domain.ts: forecasts, decimal conversion and data freshness checks.
- SDK quoteBinaryStakeOverBook, binaryPoolWriteAbi, orderBookEventsAbi.
- SQLite/Postgres connections and existing Arena / direct-wallet portfolio.

## Modify

- server/index.ts: mount execution routes ahead of API 404.
- server/store.ts and server/store-postgres.ts: durable execution tables.
- src/Arena.tsx: KeeperHub review entry and addressable execution history.
- .env.example: server-only credentials, EOA and authorized operators.

## Create

- shared/execution.ts: canonical intent, hash, payload and lifecycle.
- server/keeperhub.ts: authenticated REST transport and error normalization.
- server/execution-{store,protocol,service,routes}.ts: persistence, validation,
  orchestration and authenticated explicit authorization.
- src/execution/: review, history and real proof UI.
- tests and reproducible doctor/submission/demo documentation.

## External blockers verified on 2026-09-08

GET https://app.keeperhub.com/api/chains returned 24 chains, neither 50312 nor
5031. A successful public chain-catalog call is NOT authentication proof.
No KeeperHub key/wallet/operator configuration was present at audit time.
No real KeeperHub execution ID or transaction proof exists yet.

Official KeeperHub staging source inspected at
`f3d7e70798512b0dc2fcc721d0e99da08c5fedff` in a separate reference checkout.
Chain metadata is DB-backed; seeding and RPC configuration need coordinated
Somnia support. Do not substitute a direct viem write. Hosted enablement or
an operational self-hosted KeeperHub deployment with Shannon is required.
Upstream contributions require a maintainer-accepted issue before a PR;
no external issue/PR has been opened.

## Specific correctness findings

- Dynamic market/pool addresses must be read onchain again before each stage.
- Binary ABI entrypoint is placeBinaryOrder, not generic placeOrder.
- BUY_NO kind is 2, but its contract price remains YES-denominated.
- SDK MARKET is IOC; a successful receipt need not buy a position.
- Collateral decimals are read, escrow rounds up, allowance spender is the pool.
- Order expiry is uint64 nanoseconds, capped before market expiry.
- Frozen parameters must never be refreshed by simulation or execution.
- KeeperHub documents a Safe simulation sender mismatch; this version requires
  explicitly configured EOA routing and verifies the simulated sender.
- Hosted idempotency lasts only 24 hours. DreamCurve also persists its claim
  indefinitely and never automatically rebroadcasts an ambiguous attempt.

## Implementation order

1. Connectivity/chain doctor and exact contract payload; record live blockers.
2. Intent, bounded approval, authenticated authorization, durable claim and adapter.
3. Safety/receipt tests including stale, duplicates, timeouts and wrong payloads.
4. Extend existing UI with review, preflight, timeline and proof.
5. Run regression/build/browser checks and document limitations.
6. Once external prerequisites exist: real dry run and explicitly reviewed
   testnet execution, record proof, capture video, complete submission fields.

Authoritative references:
- https://docs.keeperhub.com/api/direct-execution
- https://docs.keeperhub.com/api/chains
- https://github.com/KeeperHub/keeperhub/tree/staging
- Installed SDK source: src/orders.ts, src/writer.ts, src/tradeAbi.ts.
