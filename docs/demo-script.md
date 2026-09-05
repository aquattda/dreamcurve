# 2:30 demo script

## 0:00–0:20 — The problem

Open the landing page.

> A prediction-market price tells us the crowd's current view, but not which model deserves our trust. DreamCurve turns each DreamDEX Event Contract into an arena of transparent, accountable second opinions.

## 0:20–0:40 — The product

Scroll through “How it works” and the four agents.

> Atlas models distance and volatility. Flux adds bounded momentum. Echo reads order-book imbalance. Nexus combines them. Every method is visible and deterministic.

## 0:40–1:15 — Live arena

Launch `/app` in live mode. Show Shannon testnet, one live BTC/ETH window, strike, spot, countdown, order-book prices, forecast probabilities and reasons.

> This is live DreamDEX data on Somnia Shannon. If data is stale, the book is one-sided or the market is too close to expiry, the agents wait instead of manufacturing a signal.

If no liquid market exists during filming, switch to `?mode=demo` and say explicitly:

> I am switching to illustrative mode so the interface remains judgeable. Every synthetic value is labelled and wallet trading is disabled.

## 1:15–1:50 — Non-custodial trade

Return to live mode, choose a signal, enter a small tUSDC stake and sign with the funded testnet wallet. Show the quote and transaction receipt, then open the explorer link.

> The client refreshes market status and depth, applies a protective price limit, aligns quantity to the market grid and gives the transaction a short lifetime. DreamCurve never receives the private key.

Do not record this segment until a real small trade succeeds. Never substitute a demo hash.

## 1:50–2:15 — Accountability

Open Scorecard, then export `/api/proofs`.

> One forecast per agent is recorded before settlement and cannot be updated. When the Event Contract resolves, DreamCurve reads the outcome and publishes Brier score, paper PnL and sample size—including losing forecasts.

## 2:15–2:30 — Vision

Return to the landing CTA.

> DreamCurve is the foundation for an open league of prediction agents: more models, longer track records and social competitions, all creating recurring discovery and trading activity for DreamDEX Event Contracts.

## Before recording

- Use a clean browser profile and 1440×900 viewport.
- Fund the wallet with STT and the market's test collateral.
- Confirm `npm run doctor`, live Arena and the explorer are responsive.
- Keep the final video between 2:00 and 3:00, export at 1080p, and test its public link in an incognito window.
