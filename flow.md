# DreamCurve — Implementation Flow

Tài liệu này là checklist thực thi từ workspace trống đến submission. Ưu tiên tuyệt đối là có một vertical slice chạy thật trên Shannon testnet trước khi thêm polish.

## 1. Những thứ cần chuẩn bị

### Tài khoản và quyền truy cập

- GitHub account và một repository public.
- Ví testnet riêng cho hackathon; không dùng ví giữ tài sản mainnet.
- STT testnet để trả gas.
- tUSDC testnet để mint/trade Event Contracts.
- Quyền truy cập faucet/community Telegram của Somnia nếu faucet web chưa đủ.
- Một nơi deploy app Node lâu dài, khuyến nghị Railway cho single service + persistent volume.
- Tùy chọn: API key LLM nếu làm phần diễn giải; không để đây là dependency bắt buộc.

### Phần mềm local

- Node.js 20 LTS hoặc phiên bản mà SDK/starter xác nhận hỗ trợ.
- npm hoặc pnpm; chỉ chọn một package manager.
- Git.
- Chrome/Edge và browser wallet hỗ trợ custom EVM network.
- OBS/Loom để quay demo.
- ffmpeg tùy chọn để cắt video.

### Network đã xác minh từ tài liệu hiện tại

- Shannon testnet chain ID: `50312`.
- Bot Kit hiện liệt kê RPC testnet: `https://dream-rpc.somnia.network`.
- REST testnet: `https://stg.api.dreamdex.io/v0`.
- Public WebSocket testnet: `wss://stg.api.dreamdex.io/v0/ws/public`.
- README SDK hiện minh họa indexer `https://dev.smk.somnia.host/v1/graphql` và WebSocket RPC `wss://api.infra.testnet.somnia.network/ws`.

Không trộn REST WebSocket với chain WebSocket. Hãy lấy config theo đúng constructor của phiên bản SDK đã pin và chạy doctor/smoke test trước.

### Environment variables dự kiến

```dotenv
NODE_ENV=development
PORT=8787
HOST=127.0.0.1
DATABASE_PATH=./data/dreamcurve.sqlite

SOMNIA_RPC_URL=https://dream-rpc.somnia.network
SOMNIA_WS_RPC_URL=wss://api.infra.testnet.somnia.network/ws
DREAMDEX_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql
# Optional: chỉ dùng sau khi đã xác minh venue đang hoạt động.
DREAMDEX_VENUE_ID=
# Server chỉ đọc; mọi giao dịch được ký trong ví trình duyệt.
COLLECTOR_ENABLED=true
```

Tên biến chính xác phải khớp với `.env.example`. Không đặt private key/seed phrase trên server và tuyệt đối không commit `.env`.

## 2. Chốt scope trước khi code

Definition of Done cho submission:

- [ ] Public URL hoạt động.
- [x] Hiển thị market và order book realtime.
- [x] Meta Agent tạo forecast + explanation từ input thật.
- [ ] Wallet đặt được BUY YES hoặc BUY NO trên testnet.
- [ ] Có tx hash và receipt confirmed.
- [ ] Forecast cũ được chấm sau settlement.
- [x] Có portfolio/open order và redeem flow.
- [x] README có setup, architecture, limitations và links.
- [ ] Video 2–3 phút.

Nếu một task không phục vụ một checkbox trên, đưa xuống P1.

## 3. Phase 0 — xác minh protocol trước khi làm UI

### Bước 0.1: lấy starter và pin dependency

- Tạo app từ starter template hoặc copy riêng phần lifecycle TypeScript.
- Cài `@somnia-chain/markets-sdk` bản hiện hành.
- Commit lockfile.
- Không import file xuyên qua `node_modules/dist/...` nếu SDK bản mới đã public-export ABI/API cần thiết.

### Bước 0.2: chạy read-only doctor

Viết script `scripts/doctor.ts` in ra:

- chain ID và block number;
- indexer health/sync status;
- venue ID nhìn thấy từ live market;
- ít nhất một binary market;
- on-chain market status;
- strike, interval, expiry;
- YES/NO best bid/ask;
- spot price hiện tại.

Pass condition: dữ liệu cùng một market nhất quán và không cần private key để đọc.

### Bước 0.3: chạy lifecycle với ví testnet

Theo thứ tự:

1. Kiểm tra STT/tUSDC balance.
2. Chọn market còn đủ headroom.
3. Mint set nếu flow giao dịch cần inventory.
4. Place một lệnh size tối thiểu hợp lệ.
5. Kiểm tra receipt và open/fill state.
6. Cancel nếu lệnh còn resting.
7. Sau finalization, redeem winning token.

Ghi lại tx hashes vào `docs/testnet-proof.md`. Đây là bằng chứng kỹ thuật và fallback cho demo.

Không chuyển sang UI trước khi bước này chạy end-to-end.

## 4. Phase 1 — dựng vertical slice

### Backend/data service

- Khởi tạo một `SomniaMarkets` exchange dùng config testnet.
- Watch binary markets qua API live/discovery của SDK.
- Với mỗi market `Trading`, lưu snapshot spot + order book theo chu kỳ 2–5 giây hoặc theo event.
- Dùng `marketId` làm primary identity.
- Expose:
  - `GET /api/health`
  - `GET /api/markets`
  - `GET /api/markets/:id/snapshots`
  - `GET /api/markets/:id/forecasts`
  - `GET /api/leaderboard`
  - `GET /api/stream` bằng SSE cho forecast updates

### Frontend

- Market list.
- Market detail: spot, strike, countdown, YES/NO odds, spread.
- Một chart probability theo thời gian.
- Agent cards với pYES, edge, action và explanation.
- Skeleton, empty state, reconnect state và stale-data badge.

Pass condition: mở trang public và quan sát một window thay đổi realtime mà không cần refresh.

## 5. Phase 2 — signal engine và scoring

### Feature pipeline

- Chuẩn hóa mọi probability về `[0, 1]`.
- Tính return 30s/60s, realized volatility và distance-to-strike.
- Tính book imbalance ở top N levels.
- Lưu raw features cùng forecast để audit.

### Agents

- `probability-agent.ts`: distance + volatility + time-to-expiry.
- `momentum-agent.ts`: returns + volatility regime.
- `flow-agent.ts`: imbalance + spread + price movement.
- `meta-agent.ts`: weighted ensemble; weights có version.

### Snapshot policy

- Tạo forecast định kỳ nhưng chọn một forecast canonical, ví dụ tại T−60 giây, để leaderboard không cherry-pick.
- Nếu window ngắn hơn, canonical point là một tỷ lệ cố định của interval.
- Forecast đã canonical phải immutable.

### Scoring

- Outcome YES = `1`, NO = `0`.
- `brier = (pYes - outcome) ** 2`.
- Paper trade dùng executable ask ở thời điểm signal, không dùng midpoint.
- Tính fee/slippage nếu protocol có thông số xác minh được; nếu chưa, ghi rõ paper PnL trước fee.
- Hiển thị sample size cạnh mọi metric.

Tests bắt buộc:

- [x] pYES luôn trong `[0,1]`.
- [x] Không signal khi market không Trading.
- [x] Không signal khi book rỗng.
- [x] Edge YES/NO tính đúng.
- [x] Brier score đúng cho outcome YES và NO.
- [x] Forecast canonical không update sau insert.

## 6. Phase 3 — wallet trading

### Kết nối ví

- Dùng browser wallet + `walletClient`.
- Detect chain; nếu sai thì đề nghị switch/add Shannon.
- Không yêu cầu người dùng nhập private key vào web.

### Trade flow

1. Người dùng bấm `Copy YES` hoặc `Copy NO` trên agent card.
2. Trade ticket điền side và limit price từ executable ask hiện tại.
3. Người dùng nhập max cost.
4. Preview shares/payout/profit/price impact.
5. Re-read market status và book ngay trước submit.
6. Quantize price/size.
7. Submit và chờ receipt.
8. Refresh portfolio/open orders.

### Error cases phải test

- [ ] Wrong network.
- [ ] User reject signature.
- [ ] Insufficient STT.
- [ ] Insufficient tUSDC/inventory.
- [ ] Price moved/book empty.
- [ ] Market locked trong lúc ký.
- [ ] Transaction reverted.
- [ ] Partial fill hoặc resting remainder.

### Safety

- Default size nhỏ.
- Không có infinite approval nếu không cần.
- Hiển thị testnet rõ ràng.
- Không tự trade bằng ví người dùng.
- Agent server signer, nếu dùng, phải có `MAX_ORDER_COST`, `MAX_DAILY_LOSS`, expiry và kill switch.

## 7. Phase 4 — settlement, portfolio và redeem

- Worker query các binary market `Finalized`, không chỉ live list.
- Match settlement với forecast theo `marketId`.
- Ghi outcome một lần và chạy scorer idempotently.
- Portfolio phân biệt filled position, open order escrow và claimable.
- Redeem bằng wallet người dùng; chờ receipt rồi refresh balance.
- Có nút cancel cho resting order.

Pass condition: ít nhất một resolved market thật có full chain `forecast -> outcome -> score`, và ít nhất một redeem tx thành công hoặc proof tx đã ghi lại.

## 8. Phase 5 — polish và khả năng demo

### UX checklist

- [x] Mobile 390px không vỡ layout.
- [x] Desktop 1440px tận dụng không gian.
- [x] Màu YES/NO không phải tín hiệu duy nhất; có label/icon cho accessibility.
- [x] Số tiền, probability, timestamp và timezone format nhất quán.
- [x] Stale data/reconnecting nhìn thấy rõ.
- [x] Loading không làm layout nhảy mạnh.
- [x] Transaction link mở đúng explorer testnet.

### Demo-safe mode

- Cache một resolved market thật trong DB.
- Có seed script chỉ seed dữ liệu đã thu thật, gắn nhãn `historical`, không giả là live.
- Lưu tx hashes và screenshots của lifecycle.
- Chuẩn bị hai browser profile: presenter wallet và clean viewer.
- Tắt notification, kiểm tra balance và market headroom trước khi quay.

## 9. Lịch 3 ngày đề xuất

### Ngày 1 — protocol + live arena

- Sáng: setup repo, funded wallet, doctor script, market discovery.
- Trưa: lifecycle order thật nhỏ, ghi tx proof.
- Chiều: backend watcher + DB schema + APIs.
- Tối: Live Arena UI và probability chart.

Kết quả cuối ngày: live data public/local hoạt động và đã có ít nhất một tx thật.

### Ngày 2 — agents + trading + settlement

- Sáng: ba feature agents + Meta Agent + unit tests.
- Trưa: wallet connect + trade ticket + receipt states.
- Chiều: portfolio/open orders/cancel.
- Tối: finalized-market worker + leaderboard + redeem.

Kết quả cuối ngày: vertical slice hoàn chỉnh.

### Ngày 3 — hardening + submission

- Sáng: deploy, env/volume, end-to-end test trên URL public.
- Trưa: responsive polish, failure states, seeded historical fallback.
- Chiều: README, architecture diagram, pitch, demo script.
- Tối: quay/cắt video, upload, submit sớm và kiểm tra link ở cửa sổ ẩn danh.

Nếu trễ: cắt LLM, share card và auto-trade trước; không cắt one-click trade, scoreboard hoặc redeem.

## 10. Cấu trúc repository đề xuất

```text
dreamcurve/
  apps/
    web/
      src/components/
      src/pages/
      src/lib/wallet.ts
      src/lib/dreamdex.ts
    api/
      src/routes/
      src/workers/
      src/db/
  packages/
    agents/
      src/probability-agent.ts
      src/momentum-agent.ts
      src/flow-agent.ts
      src/meta-agent.ts
      src/scoring.ts
    shared/
      src/types.ts
      src/config.ts
  scripts/
    doctor.ts
    lifecycle-smoke.ts
    seed-historical.ts
  docs/
    architecture.md
    testnet-proof.md
    demo-script.md
  .env.example
  README.md
  package.json
  package-lock.json
```

Nếu monorepo làm chậm tiến độ, dùng một app với `src/client`, `src/server`, `src/agents`; kiến trúc đơn giản chạy được tốt hơn cấu trúc đẹp nhưng chưa tích hợp.

## 11. README và submission cần có

### README

- Problem và one-line solution.
- 3 ảnh/GIF chính.
- Live URL và demo video.
- Architecture + data flow.
- DreamDEX primitives đã dùng.
- Setup local và `.env.example`.
- Testnet tx hashes.
- Agent methodology và scoring formula.
- Security model: non-custodial, paper mode default.
- Known limitations và roadmap.

### Video 2–3 phút

Kịch bản mục tiêu 2:30:

- `0:00–0:20`: vấn đề — odds không nói model nào đáng tin.
- `0:20–0:40`: giải pháp — agent arena + verifiable track record.
- `0:40–1:15`: live market, odds, countdown, agent reasoning.
- `1:15–1:50`: copy signal, ký ví, receipt on-chain.
- `1:50–2:15`: resolved leaderboard + Brier/PnL + redeem.
- `2:15–2:30`: ecosystem vision — open agent marketplace và recurring trading league.

### Submission form

- [ ] Public prototype URL.
- [ ] Public GitHub repository.
- [ ] Video link không yêu cầu permission.
- [ ] Địa chỉ/tx proof trên Shannon testnet.
- [ ] Team members và contact.
- [ ] Optional deck 5 slide.
- [ ] Optional SDK feedback: lỗi gặp phải, version, reproduction và đề xuất.

## 12. Quyết định cần chốt ngay

Trước khi bắt đầu code, người thực hiện cần có câu trả lời cho bốn điểm:

1. Ví testnet đã có cả STT và tUSDC chưa?
2. Repo sẽ deploy ở đâu và persistent storage nằm ở đâu?
3. Chọn exact SDK version nào sau khi lifecycle smoke test pass?
4. Có đủ resolved windows trước giờ quay để chấm scoreboard không? Nếu không, bắt đầu collector ngay lập tức.

Không cần đợi có LLM key để bắt đầu. Việc quan trọng nhất là bật collector sớm, vì dữ liệu forecast trước settlement không thể tạo lại một cách trung thực sau khi kết quả đã biết.

## 13. Trạng thái triển khai hiện tại

Đã hoàn thành trong repo:

- [x] Landing page responsive và các trang Arena, Agents, Scorecard, Portfolio, Methodology.
- [x] Đọc chain ID, Event Contracts, order book và price feed thật trên Somnia Shannon testnet.
- [x] Bốn agent có phương pháp, lý do, ngưỡng `NO_TRADE` và version model rõ ràng.
- [x] Collector lưu snapshot/forecast/settlement vào SQLite local hoặc PostgreSQL production; forecast chuẩn là bản ghi bất biến.
- [x] Chế độ demo được gắn nhãn `ILLUSTRATIVE MODE`, không ghi vào database và không cho giao dịch.
- [x] Luồng ví non-custodial, kiểm tra chain/status/expiry, báo giá theo độ sâu sổ lệnh, giới hạn trượt giá và kiểm tra receipt.
- [x] Unit test, storage test, browser E2E, production build, live doctor và accessibility check.
- [x] Cấu hình deploy Railway và Heroku; Heroku tự dùng `DATABASE_URL` khi gắn Postgres.

Việc chủ dự án vẫn cần cung cấp/làm trước khi nộp:

- [ ] Ví testnet có STT trả gas và tUSDC để ký một giao dịch thật.
- [ ] Xác minh URL Heroku public; dùng Heroku Postgres để scorecard không mất dữ liệu khi dyno restart.
- [ ] Chạy collector đủ lâu để tích lũy market đã resolve và giữ lại ít nhất một tx hash thật.
- [ ] Đưa code lên public GitHub, quay video 2–3 phút và điền link vào submission.
- [ ] Kiểm tra link video ở cửa sổ ẩn danh và kiểm tra URL production trên desktop/mobile.
