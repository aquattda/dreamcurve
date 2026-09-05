# Shannon testnet proof log

This file is a submission checklist, not a claim that a wallet transaction has already been made.

Public prototype: https://dreamcurve-somnia-155519b47159.herokuapp.com/

## Read-only integration verified

- Network: Somnia Shannon testnet
- Chain ID: `50312`
- SDK: `@somnia-chain/markets-sdk@0.29.0`
- Verified by: `npm run doctor`
- Verified paths: RPC chain ID/block, DreamDEX indexer discovery, on-chain market normalization, price feed and two-sided order book

## Signed lifecycle evidence required

Complete this section only after using a dedicated funded testnet wallet:

| Step | Transaction hash | Explorer URL | Result |
| --- | --- | --- | --- |
| Approval, if required | Pending | Pending | Pending |
| BUY YES or BUY NO | Pending | Pending | Pending |
| Cancel, if an order rests | Pending / N/A | Pending / N/A | Pending |
| Redeem after resolution | Pending | Pending | Pending |

Record the wallet address, market ID, side, requested tUSDC stake, quoted shares, actual fill count and final receipt status. Do not paste a private key, seed phrase, access token or fabricated hash into this repository.

## Final evidence gate

- [ ] Every explorer link opens on `shannon-explorer.somnia.network`.
- [ ] The order market ID matches the market shown in the demo.
- [ ] The transaction receipt is successful.
- [ ] The UI does not describe a zero-fill receipt as a completed fill.
- [ ] No secret appears in Git history, terminal capture or video.
