# Submission draft — NOT SUBMISSION READY

Track: Best Integration into a Live Project (per the supplied master prompt).

## Current integrated project — Aave V3

User-approved pivot: DreamCurve Earn on Ethereum Sepolia (11155111). KeeperHub
Direct Execution performs separately reviewed bounded approvals, supplies and
withdrawals. The integration validates the actual Aave Pool/provider/reserve,
18-decimal Aave test LINK by default (6-decimal USDC retained for legacy intents), aToken, pause/freeze state, supply cap, account debt, balances
and allowance. It independently verifies the exact transaction plus Aave and
underlying token-transfer events. Manual decisions are frozen and signed; no
new AI yield model is claimed. This is NOT a dreamDEX execution on another chain.

Implemented surfaces: authenticated chain/wallet/Safe reads, contract-call dry
run/broadcast adapter, stable idempotency key, status/receipt verification. Live
evidence currently includes an authenticated read-only Aave getPool response;
no real Aave broadcast ID/hash is claimed. No prebuilt Aave plugin, MCP, x402 or
MPP usage is claimed. See [Earn guide](EARN_GUIDE.md).

Remaining prerequisites: free Sepolia ETH and exact Aave test LINK in the executor,
KeeperHub free-quota/overage review, live signed approval/supply/withdraw proof,
live Postgres verification, accessible final source commit, deployment and video.
Old Somnia balances cannot fund Sepolia. Never enable paid usage automatically.

The following sections retain the original dreamDEX plan as history; they are
not the description of the newly selected Aave submission.

## Original integrated project — dreamDEX (historical)

dreamDEX Event Contracts on Somnia Shannon, chain 50312. DreamCurve transforms
quantitative model recommendations or explicit manual selections into frozen
execution intents. KeeperHub simulates and executes the reviewed contract call;
DreamCurve independently verifies the transaction and dreamDEX order events.
The integration resolves dynamic pools and collateral, quotes actual binary
books, validates price ticks/quantity lots, manages bounded collateral approval,
checks expiry and parses dreamDEX order receipts.

## Existing versus new work

Prior submission: Arena, market discovery, quantitative forecasts, chart,
scorecard and browser-wallet trading/portfolio. Frozen at dreamdex-hackathon-v1.
New KeeperHub work: canonical intents, signed operator approval, dry-run/execute
adapter, fail-closed policy, durable duplicate prevention, execution proof UI.
The existing agents are rule-based quantitative models, not an LLM service.

## KeeperHub surfaces

Implemented in `server/keeperhub.ts`: REST Direct Execution contract-call,
`simulate:true`, stable Idempotency-Key, execution status and verified receipts.
Chain catalog and organization wallet reads support connectivity checks.
Runtime usage is not yet demonstrated with an authenticated Shannon execution.
Do not claim MCP, CLI, x402, MPP, authored workflows or an upstream bounty PR.

## Environment and unfinished work

Shannon testnet only. Initial hosted registry did not list 50312. A real KeeperHub
endpoint supporting Shannon and a funded configured organization EOA are required.
No live execution ID/hash has been obtained. No demo video has been captured.
Safe routing, multi-tenant organizations, LLM agents and organization-wallet
portfolio management are outside the current implementation.

## Required final assets

- Source repository: https://github.com/aquattda/dreamcurve/tree/keeperhub-integration
  (local implementation must be reviewed and pushed before this link represents it).
- Exact final commit/tag: NOT RECORDED YET.
- Working deployment URL: NOT RECORDED YET.
- Short working demo video: NOT RECORDED YET.
- Real KeeperHub execution ID: NOT OBTAINED.
- Real Somnia transaction hash and explorer URL: NOT OBTAINED.
- Confirmed order ID / fill and value-movement evidence: NOT OBTAINED.
- Execution timestamp: NOT OBTAINED.
- Email: <ADD BEFORE SUBMISSION>.
- X or Discord: <ADD BEFORE SUBMISSION>.

Do not replace missing evidence with test fixtures. Record a real fulfilled order
or other verified value movement, not just simulation or an allowance transaction.
If also entering the optional KeeperHub Feature bounty, use a separate BUIDL.
