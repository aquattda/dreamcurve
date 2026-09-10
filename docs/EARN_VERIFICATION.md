# Earn verification — 2026-09-09

Status: implementation and local regression checks passed; NOT submission-ready.
No real approval, supply or withdrawal was broadcast by the coding agent.

## Verified locally

- `npm test`: 172 passing tests across 12 files, including 61 Earn cases.
- `npm run build`: TypeScript checking and Vite production build passed.
- `npm run test:e2e`: all 28 browser cases passed (57.3 seconds), including
  5 Earn cases plus original Arena, portfolio and dreamDEX execution regressions.
- `git diff --check`: passed (Windows line-ending notices only).
- Edge headless live page check: `/app/earn` rendered the real API response,
  correct LINK address/18 decimals, active reserve, no protocol cap, zero executor
  balances and disabled writes. Homepage navigation worked; no JS errors reported.
- Browser tests used a separate in-memory database with the collector disabled.
  Their mocked signatures, execution IDs and receipts are not live evidence.

Earn tests cover exact 6/18-decimal parsing, fixed deployment/calldata, asset
substitution rejection, legacy intent preservation, combined durable budgets,
funding/allowance/debt/reserve guards, free-tier gate, signature and dry-run
requirements, concurrent execution claims, timeout/no-resend behavior, persisted
SQLite history, and independent Approval/Supply/Withdraw event and transfer proofs.

## Live read-only evidence

`npm run earn:doctor` at `2026-09-09T14:12:03.213Z` returned:

- Sepolia `11155111`, hosted KeeperHub connection verified, no Safe accounts.
- Authenticated Aave `getPool`: `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`.
- LINK `0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5`, 18 decimals.
- aLINK `0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24`.
- Reserve active, not frozen, not paused; supply cap 0 (no protocol cap).
- Executor: 0 Sepolia ETH, 0 Aave test LINK, 0 aLINK.
- `freeTierConfirmed=false`, `fundingReadyForHalfToken=false`.

The view-function response `{result: poolAddress}` is not a successful write
simulation or transaction. The doctor intentionally reports not-ready until
funding and operator free-tier acknowledgment are present. It does not verify
account billing or the durable budget; the app checks the latter in its database.

At an earlier same-day read, USDC/USDT/DAI supplies exceeded their configured
caps. LINK is the new UI default; USDC remains supported explicitly for legacy
intents. Preflight revalidates current state instead of relying on this snapshot.

Deployment references: [Aave address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Sepolia.sol),
[Pool configuration bitmap](https://aave.com/docs/aave-v3/smart-contracts/pool#getconfiguration),
[KeeperHub Direct Execution](https://docs.keeperhub.com/api/direct-execution).

## Still required

1. Free Sepolia ETH and the exact Aave test LINK token in the executor.
2. User review of KeeperHub free quota and disabled paid overage before enabling
   `EARN_FREE_TIER_CONFIRMED`. This flag is not a permanent zero-cost guarantee.
3. Real user-authorized approval, supply and withdrawal with matching KeeperHub
   execution IDs, Sepolia transaction hashes and independently verified proofs.
4. Live Postgres validation if that backend is used for the submitted deployment.
5. Final source commit/push, deployment, demonstration video and submission details.

Use [the Earn guide](EARN_GUIDE.md) for the exact funding and demo sequence.
No mainnet assets, token purchases, paid subscriptions or billing changes are needed
or authorized by this implementation. If free resources are unavailable, stop.

## Preservation and scope

Active branch: `keeperhub-integration`. The latest work is uncommitted/unpushed.
`main` and `dreamdex-hackathon-v1^{commit}` remain at
`4655455e573a64b6d9e1cc46150b6c2bc6fa7453`; no merge or tag rewrite occurred.
The API key remains server-side in Git-ignored `.env`.

The 16-page master DOCX remains unchanged. This is the user-approved Aave fallback,
not proof of dreamDEX execution. Earn decisions are manual, not an AI yield model.
