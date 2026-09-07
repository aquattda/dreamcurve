# Portfolio implementation and verification

## Data flow

`PortfolioPage` → lazy `wallet-bridge` → `portfolio/data` → existing Somnia Markets SDK 0.29.0 / Shannon RPC. No new backend, synthetic balance, or simulated trade is used.

- `getPortfolio`: indexed non-zero holdings, open orders, recent fill fallback.
- `getUserFills`: market-linked executions, maker/taker side, order IDs, timestamps and real hashes.
- `getRouterActions`: mint/merge/redemption history and actual redemption payouts.
- `getMarket`, `getBookTops`, `getOrder`, `getClaimable`: market metadata, marks, order expiry, claimable amounts.
- ERC-20 `balanceOf` and token decimals: available wallet balance.
- SDK `pnlEventsFor` + `computePositionPnL`: separate YES/NO weighted-average books, with additional history/balance reconciliation before asserting cost basis.

Pool addresses are recycled; accounting and navigation use the stable market ID. NO execution price is `oneCollateral - fillPrice`. Raw fixed-point arithmetic precedes display conversion. Prices use cents; probability uses percent.

## Delivered

- Summary, wallet/network block, centralized validated explorer links.
- Open/closed positions, entry cost, marks, value, P&L, settlement and frontend countdown.
- Activity filters, individual fills, accessible native-dialog details, copy IDs/hash, real explorer links.
- Open order quantities, placement/expiry, partial/expired states and real cancellation.
- Redeem availability and estimated net payout, actual wallet submission hash, confirmation state, refresh after success, duplicate-action locks.
- Auto-refresh every 15 seconds while visible, manual refresh/focus refresh, last-synced indicator, previous snapshot retained on failure.
- Account-scoped component state; wallet account/network changes disconnect the displayed session and require reconnecting. In-flight balance results for an old account are ignored.
- Exact-market navigation: expired/non-current markets have a read-only record rather than silently opening another live window.

## Receipt recovery and the subscribe error

The existing HTTP public client could not support the SDK writer's `waitReceiptViaHeads` / `newHeads` subscription. The writer now gets a WebSocket public client; HTTP remains used for balance reads and receipt recovery.

The scoped injected transport records a real hash as soon as `eth_sendTransaction` returns. It does not label approvals or unknown contract calls as trades. Successful order receipts provide actual fill aggregates, later replaced by individual indexed fills. Pending receipts are rechecked using HTTP. A timeout or missing receipt is **not** proof of failure and never causes automatic resubmission.

Recovery records use `dreamcurve:transactions:v1:50312:<lowercase-account>` in localStorage, with a 500-row cap and session-memory fallback if storage fails. They store no keys/signatures and never determine balances or cost basis. The indexer is the cross-device history. Clearing browser storage can remove unindexed receipt recovery records. Wallet rejection before a hash exists does not create a fictional on-chain Failed transaction.

## Honest limitations

- Fees and gas are not invented. Cost/P&L is before separately charged trading fees and gas; redemption accounting uses indexed actual payouts when available.
- Portfolio Value includes available tUSDC plus held marked outcomes, including unredeemed winners. It excludes order escrow/vault credits and is explicitly labelled.
- Unrealized P&L includes open positions **and unredeemed winning claims**. Moving a resolved winner to Closed Positions does not make its unclaimed gain disappear. Historical shares and currently held shares are tracked separately, so an already-burned voided leg is not labelled redeemable.
- Expired/unresolved markets have no current mark. Transferred/unindexed outcome tokens, capped history, ambiguous same-second mint/merge ordering, and unsupported partial/void redemption accounting can make cost/P&L unavailable (`--`).
- Reads are bounded: 1,000 fills/actions, 200 holdings, 50 open orders/recent fallback fills and 30 additional historical markets. Full-page limits or unavailable market details suppress lifetime totals. Closed positions are limited to reconstructible indexed history, not a claim of an unlimited archive.
- Order history includes current indexed orders and locally confirmed cancellations; it is not a complete cross-device archive of every historical order. Unknown expiry disables cancellation in the UI.
- A fresh confirmed trade may appear in Activity before its position is indexed; combined valuation remains unavailable until indexed fills catch up.
- P&L chart and a SELL/Close Position transaction workflow are intentionally omitted. A TODO remains at the position card, with no fake exit button.
- An unknown transaction remains Pending until a receipt is verifiable. Check its explorer link before retrying an action.

## Verification

- `npm.cmd run typecheck`
- `npm.cmd test`: accounting, YES/NO execution units, receipt deduplication, wallet isolation, storage fallback, lifecycle/expiry and SDK writer transport regression.
- `npm.cmd run build`: passes; the existing large SDK chunk remains lazy-loaded.
- `npx.cmd playwright test tests/e2e/portfolio.spec.ts --workers=1`: desktop/modal/explorer, retained snapshot after failure, account-switch isolation, mobile overflow and modal bounds. Uses deterministic fixtures and a provider that forbids signing/sending.
- Browser gut-check: actual localhost Portfolio and Arena load without page errors.
- Read-only live adapter verification also returned actual balance, both indexed fills with hashes, holdings and claimability for the previously supplied public wallet. No wallet transaction was sent or signed during verification.

For the final user acceptance step, confirm one intended testnet trade in MetaMask, open Portfolio, and match the new activity hash against the explorer. Check that the indexed position catches up after refresh. Redeem testing similarly requires the user's explicit wallet confirmation; a simulated browser test is not proof that a signed transaction succeeded.
