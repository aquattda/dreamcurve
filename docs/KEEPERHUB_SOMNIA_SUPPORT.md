# Somnia Shannon support investigation

Historical investigation: the user subsequently approved Aave V3 Sepolia Earn
as the active demo path. See [Earn guide](EARN_GUIDE.md). This document preserves
the earlier Shannon findings; hosted enablement is no longer the next demo step.

## Selected path — hosted KeeperHub (2026-09-09)

The user selected hosted enablement, not self-hosting. Keep the existing hosted
base URL and organization configuration. At `2026-09-09T09:14:13.218Z`, executor
funding passed with 0.1 STT and 5 tUSDC; the remaining doctor failure was the
hosted Shannon registry. A [ready-to-submit request](KEEPERHUB_HOSTED_SUPPORT_REQUEST.md)
contains reproduction evidence and the official form link. It has NOT been posted.

Public issue searches for Somnia, Shannon and 50312 found no matches on September 9.
Latest staging `b3ad96793c8f587f7f64c1b23f619efe6ab16916` still has no Shannon
entry in its RPC config or seed. The older candidate patch below remains optional
reference material, not the selected deployment approach or proof of support.

## Historical investigation and optional source candidate

The public hosted catalog https://app.keeperhub.com/api/chains returned 24 enabled
chains at the 2026-09-08 audit. Neither 50312 nor 5031 appeared. The read-only
`keeperhub:doctor` repeated this result and independently verified Shannon RPC's
`eth_chainId` is 50312. The public catalog does not authenticate an organization.

Official source reviewed: https://github.com/KeeperHub/keeperhub, staging commit
`f3d7e70798512b0dc2fcc721d0e99da08c5fedff`.

## Minimum source integration

The companion [keeperhub-somnia.patch](keeperhub-somnia.patch) adds Shannon to:

- `lib/rpc/rpc-config.ts`: explicit chain mapping, configurable primary/fallback
  RPC endpoints, public HTTP/WS defaults.
- `scripts/seed/seed-chains.ts`: EVM testnet metadata, STT, experimental maturity,
  public mempool routing, explorer metadata and chain-name mapping.
- `tests/unit/somnia-shannon-config.test.ts`: registry and RPC override checks.

The seed currently disables chain rows absent from its own list. Merely inserting
a Shannon DB row is therefore not maintainable: a later standard seed would
disable it again. The patch adds Shannon to that authoritative list as well.
Runtime `lib/rpc/config-service.ts` resolves enabled chains from DB; the existing
generic EVM adapter can then resolve the chain's configured RPC. Providing the
SDK's explicit ABI avoids dependence on automatic explorer ABI lookup.

This is a **source integration candidate**, not a deployed or live-tested feature.
Its application is checked against the pinned source. Upstream typecheck, tests,
seed behavior and real simulation/broadcast must still be verified on the actual
KeeperHub deployment before claiming working Somnia support.

## Apply in a KeeperHub development checkout

Use the official repository's Node/pnpm requirements and contribution instructions.
Keep its database and secrets separate from DreamCurve's database and `.env`.

```sh
git switch -c somnia-shannon-integration
git apply --check /path/to/dreamcurve/docs/keeperhub-somnia.patch
git apply /path/to/dreamcurve/docs/keeperhub-somnia.patch
pnpm install
pnpm type-check
pnpm fix
# Run the project's current unit-test command including somnia-shannon-config.test.ts.
# Provision the official KeeperHub database/Turnkey setup before seeding/running.
pnpm tsx scripts/seed/seed-chains.ts
```

Seeding changes the target KeeperHub database; inspect the configured environment
before running it. Existing standard seeding also reconciles other chains; use a
local development database first. Configure RPC overrides through
`CHAIN_SOMNIA_SHANNON_PRIMARY_RPC` and `CHAIN_SOMNIA_SHANNON_FALLBACK_RPC` or
the matching `CHAIN_RPC_CONFIG` key `somnia-shannon`.

After starting a real KeeperHub instance, point DreamCurve's
`KEEPERHUB_BASE_URL` to it, configure its organization key/EOA and run the doctor.
The actual success gate remains a successful exact-payload dry run followed by
an explicitly authorized KeeperHub write and independently verified dreamDEX
event proof. A chain row or passing config test alone is insufficient.

## Required runtime checks

1. `/api/chains` exposes enabled testnet 50312; primary/fallback RPC return 50312.
2. Organization wallet and EOA routing resolve correctly with the organization's key.
3. `readContract` can read the active pool and collateral decimals/balance/allowance.
4. A bounded collateral approval can be simulated and executed through KeeperHub.
5. A dynamic dreamDEX IOC order dry-run returns the expected EOA/target/value.
6. The reviewed identical call broadcasts through KeeperHub and returns a real ID.
7. The status endpoint verifies receipts and DreamCurve independently verifies them.
8. Gas settings and confirmation timing are tested specifically on Shannon.

No upstream issue or PR was submitted. KeeperHub CONTRIBUTING.md requires a
maintainer-accepted issue before a behavior-changing PR. If entering the optional
feature bounty, submit this work as a separate BUIDL from DreamCurve's integration.
