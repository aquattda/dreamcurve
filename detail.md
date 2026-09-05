DreamDEX Market Pulse — Project Brief (paste this into your AI coding assistant)
Context

Building for the Somnia × DreamDEX Event Contracts Hackathon. Deadline: 8th Sep (few days left). Prize pool: $5,000 USDso. Submission needs: working testnet prototype, GitHub repo, 2–3 min demo video.

What we're building

"Market Pulse" — a read-only, real-time analytics dashboard for DreamDEX Event Contracts (binary Up/Down prediction markets on Somnia Shannon testnet). It never mints/trades/redeems — it discovers live markets, reads their order books, and turns best bid/ask price (= implied probability) into a live chart + a "probability jumped" alert feed. This maps directly onto the hackathon's own suggested "Analytics & odds tools" track (historical resolved-market analytics, implied-probability charts, mispriced-window alerting).

Domain facts an AI needs to know before touching this code
Each Event Contract has two ERC-6909 outcome tokens: Up ("YES") and Down ("NO"). 1 collateral (tUSDC) mints 1 Up + 1 Down (mintSet).
Price = probability, in millionths. 900000 = 0.90 = "90% chance." Convert with probabilityToPrice() / priceToProbability() from the SDK.
Chain: Somnia Shannon testnet, chain id 50312.
SDK: @somnia-chain/markets-sdk (pin >=0.28.1; older versions can't be imported by plain node). Constructor needs wsRpcUrl or loadMarkets() throws.
Discover markets by scanning MarketCreated chain logs, not the indexer — the indexer can be down; chain logs can't. Somnia caps getLogs at 1000 blocks/call, so you must walk backwards in windows.
MarketCreated has no venueId — scope discovery by the collateral token (SOMNIA_TESTNET_ADDRESSES.testUsdc) instead.
Key read methods: ex.client.getMarketOnchain(marketId) (status, finalized, yesId, noId), ex.client.getAllOpenOrdersOnchain(pool, {isBid}) (order book), ex.client.listBinaryMarkets({}) (indexer-backed, can be down — prefer chain-log discovery).
The ABI needed for log scanning (marketCreatorEventsAbi) is not in the package's public exports map — import it via a relative path into node_modules (../node_modules/@somnia-chain/markets-sdk/dist/eventsAbi.js), same trick the official starter template uses.
A market only settles after its expiry; short windows (15 min) are best for demoing the full lifecycle.
Current state of the code (already built, in the attached/zipped project)
dreamdex-dashboard/
  package.json         — deps: @somnia-chain/markets-sdk, viem, express, cors, dotenv
  .env.example          — PRIVATE_KEY, RPC_URL, WS_RPC_URL, INDEXER_URL, POLL_INTERVAL_MS, PORT
  src/client.mjs         — read-only SDK client (needs a PRIVATE_KEY, even
                            unfunded — never signs a tx)
  src/discover.mjs       — scans MarketCreated logs → live + recently-expired markets
  src/store.mjs          — simple JSON-file time-series store (data/snapshots.json)
  src/poller.mjs         — every POLL_INTERVAL_MS: discovers markets, reads
                            order books, computes implied probability,
                            flags jumps ≥8pp as alerts, appends snapshots
  src/server.mjs         — Express API: GET /api/markets, GET
                            /api/markets/:marketId/history, GET /api/alerts
  public/index.html      — dark "trading terminal" dashboard, vanilla JS,
                            hand-rolled canvas chart (no CDN dependency),
                            market list + detail chart + alert ticker

Verified so far: npm install succeeds, all modules pass node --check, all SDK exports used (SomniaMarkets, priceToProbability, SOMNIA_TESTNET_ADDRESSES, marketCreatorEventsAbi) resolve correctly. Not yet verified: actual chain calls — needs a real Shannon testnet RPC connection and a private key, which the sandbox that built this couldn't reach.

What's needed next (in priority order)
Get it running against live testnet data. Set PRIVATE_KEY in .env (any Shannon testnet key, funded or not), run npm run poll + npm run server, open localhost:8787, fix whatever breaks against the real RPC/indexer.
Resolved-market scoreboard: once getMarketOnchain().finalized is true, compare the implied probability just before expiry to the actual settled outcome (Up or Down) — a calibration view ("when the market said 80%, was it right 80% of the time?"). This is the single highest-value addition for the judging criteria (Technical Implementation + Business/Ecosystem Impact).
Polish + demo prep: tighten the UI, write the 2–3 min demo script (problem → solution → live demo → future vision), record it.
(Stretch) Sharpest-traders tracker, WebSocket push instead of polling, mispriced-window alert based on external volatility signal instead of raw probability jump.
Resources
Event Contracts docs: https://docs.dreamdex.io/developers/event-contracts
DreamDEX Bot Kit: https://github.com/somnia-chain/dreamdex-bot-kit
Bot Builder (no-code): https://dreambot-builder.vercel.app/
Official starter template: https://github.com/IronicDeGawd/ec-dreamdex-hackathon-template
Somnia docs: https://docs.somnia.network
Hackathon page: https://dorahacks.io/hackathon/event-contracts/detail
Testnet faucet (tUSDC/STT) + dev community: https://t.me/+XHq0F0JXMyhmMzM0 (faucet command in-chat: /faucet tusdc <wallet_address>, 1 claim/24h)
Task for you (the AI reading this)

Take the zipped dreamdex-dashboard/ project, help me get it running end to end against the real Shannon testnet, then implement the resolved-market scoreboard described above. Ask me for .env values or wallet details if you need them — don't invent RPC URLs or addresses not listed here.