# Hosted Shannon enablement request — ready to submit, NOT submitted

Historical draft, superseded for the active demo by [Aave Sepolia Earn](EARN_GUIDE.md).
Do not post automatically. The original dreamDEX path is preserved separately.

Selected approach: keep DreamCurve on hosted `https://app.keeperhub.com`.
No self-hosted deployment, upstream issue, PR or transaction was created.
No API key, private key or signature belongs in this request.

Submit using [KeeperHub's change-request form](https://github.com/KeeperHub/keeperhub/issues/new?template=change_request.yml).
Copy the title and each section below into its corresponding form field.
Review before posting publicly. Submission requires the user's GitHub account.

Preflight evidence, checked 2026-09-09:

- Public GitHub issue search, covering open and closed issues/PRs, returned zero
  matches for each of `repo:KeeperHub/keeperhub Somnia`, `Shannon`, and `50312`
  at `2026-09-09T09:18:39.729Z` (HTTP 200, no incomplete results).
- Current staging HEAD was `b3ad96793c8f587f7f64c1b23f619efe6ab16916`.
  Its RPC config and chain seed contain no Somnia/Shannon/50312 entry.
  The seed still disables entries outside its authoritative chain list.
- Reviewed the [issue policy](https://github.com/KeeperHub/keeperhub/blob/staging/ISSUES.md),
  [chain API docs](https://docs.keeperhub.com/api/chains), and
  [Direct Execution docs](https://docs.keeperhub.com/api/direct-execution).
- Recheck these preflight facts if filing later. No upstream runtime test was run.

## Title

Enable Somnia Shannon testnet (50312) on hosted KeeperHub for dreamDEX execution

## Reason: what you cannot do today

DreamCurve integrates KeeperHub Direct Execution with dreamDEX Event Contracts
on Somnia Shannon. We need to simulate a reviewed contract call, explicitly
authorize a bounded approval/order, execute through our organization EOA, and
verify the resulting receipt and dreamDEX events independently.

Hosted KeeperHub does not currently advertise enabled chain 50312 in
`GET https://app.keeperhub.com/api/chains`. Organization wallet authentication,
operator configuration, EOA configuration and independent Shannon RPC checks pass.
Our executor was verified funded with 0.1 STT and 5 units of the actual market's
6-decimal tUSDC collateral at `2026-09-09T09:14:13.218Z`.

A read-only request at `2026-09-09T03:56:01.395Z` to
`POST https://app.keeperhub.com/api/execute/contract-call` returned HTTP 400:

```text
Chain 50312 not found or not enabled
```

Reproduction body (use your own organization authentication; no key included):

```json
{
  "chainId": 50312,
  "contractAddress": "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  "functionName": "balanceOf",
  "functionArgs": "[\"0x5845504E0BF70D28820a89b4eC12bD4CaB9116a0\"]",
  "abi": "[{\"type\":\"function\",\"name\":\"balanceOf\",\"stateMutability\":\"view\",\"inputs\":[{\"name\":\"account\",\"type\":\"address\"}],\"outputs\":[{\"name\":\"\",\"type\":\"uint256\"}]}]",
  "value": "0",
  "simulate": true
}
```

This is a network-support request, not a claim that the docs promise Shannon
support. No KeeperHub write has been submitted.

## Reason: what the workaround costs

Direct MetaMask execution would bypass KeeperHub and cannot demonstrate the
intended integration. Self-hosting adds independent database, custody/signing and
deployment operations; we have selected hosted KeeperHub. Changing DreamCurve's
local RPC does not register a chain in the hosted service.

## Scope: what this touches, and what it does not

One network enablement: Somnia Shannon EVM testnet, chain ID 50312 (not Somnia
mainnet 5031). Requested metadata:

- Native currency: STT, 18 decimals.
- HTTP RPC: `https://dream-rpc.somnia.network`.
- WebSocket RPC: `wss://api.infra.testnet.somnia.network/ws`.
- Explorer: `https://shannon-explorer.somnia.network/`.
- Network reference: https://docs.somnia.network/developer/network-info.

Please confirm supported production RPC choices and hosted availability. Scope
includes the coupled chain catalog/seed and runtime RPC configuration needed for
Direct Execution simulation, execution and receipt lookup on this network.
No changes to existing networks, authentication, response formats, dependencies,
pricing, schema or spending limits are proposed. No mainnet assets are involved.
Our application independently caps trades at 1 tUSDC and cumulative attempted demo
exposure at 5 tUSDC; this is not a claim of a KeeperHub-side token policy.

## Plan: what you propose

Please confirm whether hosted Shannon support can be enabled, any organization
onboarding prerequisites, and an estimated availability date. On staging commit
`b3ad96793c8f587f7f64c1b23f619efe6ab16916`, the RPC mapping and authoritative seed
have no Shannon entry. A DB-only insertion appears insufficient because reseeding
disables unlisted chains. Please determine the supported deployment approach.

Acceptance checks after your deployment:

1. Hosted `/api/chains` advertises enabled 50312; its RPC resolves the same chain.
2. The read-only reproduction succeeds with organization authentication.
3. An exact-payload bounded approval and dreamDEX IOC order can be simulated with
   the correct EOA, target and value.
4. Only after separate user authorization, a small testnet execution returns a
   real execution ID and receipt that DreamCurve can verify independently.

If you prefer a contributor PR, please agree on the plan and mark the issue
accepted first. An existing local source-integration candidate is available for
discussion; it is not deployed or runtime-verified and was checked for patch
application only against older commit `f3d7e70798512b0dc2fcc721d0e99da08c5fedff`.

## Plan: alternatives you considered

- Self-host KeeperHub: not selected due to additional signing/deployment operations.
- Add an organization RPC override: does not register an unknown hosted chain.
- Move networks: would not execute the current Shannon dreamDEX contracts.
- Wait without enablement: blocks the real KeeperHub execution evidence.

## After submitting

Record the issue URL and maintainer response here. An accepted issue is not proof
of a hosted deployment. Once enablement is confirmed, run `npm run keeperhub:doctor`
and the exact-payload simulation before requesting any new wallet authorization.
