# DreamCurve — Agent Arena

## 1. Kết luận và hướng thay đổi

Ý tưởng cũ **Market Pulse** có thể làm được, nhưng khả năng cạnh tranh chưa cao nếu chỉ dừng ở dashboard đọc dữ liệu:

- Không tạo giao dịch trực tiếp, trong khi ban tổ chức ưu tiên sản phẩm có khả năng tăng trading activity và adoption.
- Biểu đồ xác suất, alert và calibration là các tính năng hữu ích nhưng khá gần một analytics dashboard thông thường.
- `detail.md` nói codebase `dreamdex-dashboard/` đã tồn tại, nhưng workspace hiện tại chỉ có `detail.md`; vì vậy trạng thái “đã build và verify” không thể kiểm chứng.
- Cách quét `MarketCreated` logs thủ công là phương án dự phòng hợp lý, nhưng SDK mới đã hỗ trợ market discovery, live watches, React hooks, order book, portfolio và giao dịch. Không nên chọn log scanner làm phần trung tâm của sản phẩm.
- “Probability jumped” không tự nó là một trading signal: người dùng chưa biết giá đang sai, vì sao sai, nên chọn YES hay NO, và kết quả lịch sử của tín hiệu ra sao.

Phương án mới giữ lại phần tốt nhất của Market Pulse — dữ liệu realtime, probability chart và resolved-market analytics — nhưng biến nó thành một trải nghiệm giao dịch có vòng lặp hoàn chỉnh:

> **DreamCurve là đấu trường các agent dự báo ngắn hạn. Mỗi agent công khai xác suất, lý do và track record; người dùng chọn agent, kiểm tra edge so với odds DreamDEX và copy lệnh trực tiếp bằng ví của mình. Khi market settle, hệ thống tự chấm điểm agent bằng Brier score và PnL.**

Tagline: **See the edge. Trust the record. Trade the event.**

## 2. Tại sao ý tưởng này có cơ hội có giải

### Innovation & Originality — 20%

Không chỉ hiển thị odds. Sản phẩm biến mỗi Event Contract thành một cuộc thi dự báo có thể kiểm chứng giữa nhiều agent. Mọi dự báo được lưu trước khi kết quả xảy ra và được chấm sau settlement, hạn chế kiểu “AI nói gì cũng đúng sau sự kiện”.

Điểm khác biệt nên trình bày với giám khảo:

- **Agent Arena:** nhiều mô hình có phong cách khác nhau cùng dự báo một market.
- **Proof of Prediction:** lưu timestamp, market ID, xác suất và action trước expiry.
- **Explainable edge:** so sánh xác suất của agent với mức giá có thể khớp thật trên order book, không so với một con số trang trí.
- **Copy-to-chain:** tín hiệu dẫn thẳng tới giao dịch Event Contract.
- **Self-scoring:** sau settlement, agent được chấm bằng accuracy, Brier score và simulated/live PnL.

### Technical Implementation — 25%

MVP sử dụng toàn bộ vòng đời có ý nghĩa của DreamDEX:

`discover/watch market -> read on-chain order book -> forecast -> place order -> track position -> settlement -> redeem -> score`

Các primitive cần thể hiện trong demo:

- SDK `@somnia-chain/markets-sdk` để lấy binary markets và realtime order book.
- On-chain status là nguồn sự thật trước khi đặt lệnh.
- Ví người dùng ký lệnh; private key không bao giờ gửi lên frontend hoặc lưu trong database.
- `placeOrder`/exchange order API cho lệnh YES hoặc NO.
- Portfolio/open orders để người dùng biết trạng thái thực.
- `redeem` sau khi market finalized.
- Live update bằng SDK watch/WebSocket; polling chỉ là fallback.

### User Experience & Design — 20%

Luồng chính chỉ gồm ba hành động: chọn market, chọn agent, xác nhận trade. Người mới vẫn hiểu nhờ cách diễn đạt “56% khả năng UP”, còn người có kinh nghiệm vẫn thấy spread, executable price, edge, confidence và order book.

### Business & Ecosystem Impact — 20%

- Mỗi signal có CTA giao dịch nên có khả năng tạo volume thực tế.
- Scoreboard tạo lý do quay lại sau mỗi window.
- Kiến trúc có thể mở cho cộng đồng đăng ký agent/strategy mới.
- Về sau DreamDEX có thể thu builder fee cho order được route từ ứng dụng, nếu cơ chế và quyền builder được ban tổ chức xác nhận.
- Có thể phát triển thành marketplace cho agent, trading league hoặc embedded widget cho cộng đồng.

### Presentation & Demo — 15%

Sản phẩm có câu chuyện demo rất rõ: odds on-chain đang là bao nhiêu, các agent nghĩ gì, agent nào có track record tốt, người dùng copy một lệnh, transaction xuất hiện, rồi xem một market cũ được chấm điểm và redeem.

## 3. Trải nghiệm sản phẩm

### Màn hình 1 — Live Arena

- Danh sách BTC/ETH Event Contracts đang `Trading`.
- Mỗi card có strike, spot price, countdown, YES/NO best bid/ask và spread.
- Market sắp hết hạn được cảnh báo; market đã khóa không cho bấm trade.

### Màn hình 2 — Agent Battle

Ba agent trong MVP:

1. **Probability Agent**
   - Dùng khoảng cách spot–strike, thời gian còn lại và realized volatility.
   - Cho baseline probability theo mô hình xác suất định lượng.

2. **Momentum Agent**
   - Dùng return ngắn hạn, tốc độ thay đổi và volatility regime.
   - Phù hợp khi thị trường đang breakout.

3. **Flow Agent**
   - Dùng order-book imbalance, spread và thay đổi best bid/ask.
   - Đo tín hiệu từ chính DreamDEX.

**Nexus (Meta Agent)** tổng hợp ba dự báo bằng trọng số cố định, công khai trong MVP. Điều chỉnh trọng số theo Brier score chỉ là roadmap sau khi có đủ sample để tránh overfit; không cần giả vờ rằng một LLM có thể dự báo giá.

Mỗi agent hiển thị:

- Dự báo UP/YES (%).
- Confidence: low/medium/high.
- Edge so với executable ask của YES hoặc NO.
- Ba yếu tố ảnh hưởng lớn nhất.
- Action: BUY YES, BUY NO hoặc NO TRADE.
- Record: Brier score, hit rate, paper PnL, số dự báo đã chấm.

LLM chỉ là tính năng tùy chọn để biến feature data thành một giải thích ngắn, dễ đọc. Quyết định và xác suất phải được tạo bởi model định lượng có thể tái lập; nếu LLM lỗi, hệ thống vẫn hoạt động.

### Màn hình 3 — Trade Ticket

- Connect wallet và tự động đề nghị thêm Somnia Shannon nếu sai network.
- Chọn YES/NO, amount và slippage/limit price.
- Preview: giá dự kiến, số shares, max cost, potential payout, estimated profit và price impact.
- Người dùng ký giao dịch trực tiếp.
- Hiển thị trạng thái `Awaiting signature -> Submitted -> Confirmed/Failed` và link explorer.
- Không báo thành công chỉ vì SDK trả về; phải kiểm tra receipt.

### Màn hình 4 — Proof & Leaderboard

- Timeline dự báo đã được tạo trước expiry.
- Kết quả settled, winning side và giá trị redeem.
- Brier score: `(forecastProbability - outcome)^2`, thấp hơn là tốt hơn.
- Paper PnL cho tất cả agent để so sánh công bằng.
- Live PnL chỉ áp dụng cho agent/demo wallet thực sự đã giao dịch.
- Bộ lọc theo BTC/ETH, interval và 24h/all-time.

### Màn hình 5 — Portfolio

- Positions, open orders, claimable winnings và lịch sử giao dịch của wallet.
- Nút `Claim all` hoặc `Redeem` từng market sau khi finalized.
- Không tính token đang escrow là “mất”; UI phân biệt wallet balance, open-order escrow và position.

## 4. Cách tính signal

### Input tối thiểu

- `spot`: giá BTC/ETH realtime từ price-feed API có trong SDK trên testnet, hoặc adapter được xác minh.
- `strike` và `intervalSec`: đọc từ field có cấu trúc; không parse question text.
- `timeToExpiry`.
- YES/NO best bid, best ask, depth và spread.
- Short returns và realized volatility từ chuỗi spot snapshots.
- Order-book imbalance.

### Output chuẩn hóa

Mỗi forecast record:

```ts
type Forecast = {
  marketId: string;
  agentId: "probability" | "momentum" | "flow" | "meta";
  createdAt: string;
  expiresAt: string;
  probabilityYes: number;
  confidence: "low" | "medium" | "high";
  action: "BUY_YES" | "BUY_NO" | "NO_TRADE";
  executablePrice: number | null;
  edge: number | null;
  features: Record<string, number>;
  modelVersion: string;
};
```

### Luật quyết định an toàn cho MVP

- `yesEdge = pYes - yesAsk`.
- `noEdge = (1 - pYes) - noAsk`.
- Chỉ tạo BUY signal nếu edge lớn hơn `spread + safetyMargin` và còn đủ expiry headroom.
- Nếu không có thanh khoản hoặc status khác `Trading`, trả về `NO_TRADE`.
- Luôn quantize price và size theo tick/lot của venue.
- Agent mặc định chạy paper mode. Live auto-trade là stretch goal, có cap mỗi lệnh và daily loss limit.

Không hứa lợi nhuận và không gọi score là “độ chính xác AI” khi sample size còn nhỏ. UI phải hiển thị sample count.

## 5. Kiến trúc đề xuất

```text
DreamDEX indexer + Somnia WebSocket + price feed
                    |
                    v
          Market Data / Watch Service
           |          |           |
           v          v           v
      Snapshot DB  Signal Engine  Settlement Worker
           |          |           |
           +----------+-----------+
                      |
                 REST/SSE API
                      |
       React UI + walletClient + SDK trader
                      |
                      v
             DreamDEX Event Contracts
```

Stack có thể hoàn thành nhanh:

- Frontend: React + Vite + TypeScript, Tailwind CSS, `wagmi`/`viem`.
- DreamDEX: `@somnia-chain/markets-sdk` phiên bản được pin và test; không dùng range mơ hồ trong bản submission.
- Backend/worker: Node.js + TypeScript + Fastify hoặc Express.
- Database MVP: SQLite + `better-sqlite3`; deploy trên Railway với persistent volume. Nếu đã có Postgres thì dùng Drizzle + Postgres, nhưng không đổi stack sát deadline chỉ để “production-looking”.
- Realtime UI: SDK live watch ở frontend; SSE từ backend cho forecast/leaderboard.
- Chart: lightweight-charts hoặc Recharts.
- Test: Vitest cho signal/scoring; Playwright cho happy path nếu còn thời gian.

### Database tối thiểu

- `markets`: metadata, pool, strike, interval, status, resolution.
- `snapshots`: spot, book, probability, spread, timestamp.
- `forecasts`: agent, probability, action, features, model version, timestamp.
- `settlements`: outcome, resolved timestamp.
- `scores`: Brier, paper PnL, live PnL.
- `trades`: wallet, market, side, requested/filled price, quantity, tx hash, status.

Không lưu private key. Địa chỉ ví là public nhưng vẫn chỉ lưu dữ liệu cần cho portfolio/demo.

## 6. Phạm vi MVP và những thứ phải cắt

### P0 — bắt buộc để submit

- Market discovery + realtime order book cho ít nhất một live BTC/ETH Event Contract.
- Spot/strike/countdown và probability chart.
- Ba agent + Meta Agent tạo forecast thật từ dữ liệu.
- Buy YES/NO bằng browser wallet trên Shannon testnet.
- Receipt/transaction link và trạng thái lỗi rõ ràng.
- Forecast history + resolved scoreboard có ít nhất một market thật.
- Portfolio tối thiểu và redeem một market đã finalized.
- Deploy public, README, demo video 2–3 phút.

### P1 — chỉ làm sau khi P0 ổn định

- One-click copy preset từ agent vào trade ticket.
- Shareable prediction card/URL.
- Claim-all.
- LLM-generated explanation với fallback deterministic.
- Agent paper-trading tự động qua nhiều window.

### Không làm trong hackathon

- Smart contract riêng nếu không thực sự cần.
- Social login, referral system, token/NFT, mobile app native.
- Agent dùng tiền người dùng tự động hoặc custody.
- News sentiment pipeline phức tạp.
- Tự xây indexer từ đầu.
- Backtest giả bằng dữ liệu không có provenance.

## 7. Tiêu chí nghiệm thu

MVP chỉ được coi là xong khi:

1. App public mở được mà không cần private key server để xem live arena.
2. Wallet testnet có thể đặt ít nhất một lệnh thật và UI hiển thị receipt thành công.
3. Wrong-network, rejected signature, reverted tx, empty book và expired market đều có trạng thái rõ ràng.
4. Forecast được ghi trước expiry và không bị sửa sau settlement.
5. Ít nhất một market finalized xuất hiện trong leaderboard với outcome, Brier score và paper PnL đúng.
6. Có thể redeem winning token hoặc có bằng chứng tx của flow redeem.
7. Demo không phụ thuộc vào một market duy nhất: có recorded fallback hoặc seeded historical resolved view nếu live window không thuận lợi.

## 8. Rủi ro kỹ thuật cần tránh

- Indexer có thể lag; trước write phải kiểm tra on-chain status.
- Market/pool thay đổi theo window; key state bằng `marketId`, không dựa vào pool address hoặc question text.
- Venue ID có thể thay đổi; discover từ market data hiện tại và cho phép override bằng env, không hard-code như chân lý vĩnh viễn.
- Lệnh chưa fill có thể tiếp tục nằm trên book và khóa collateral; UI phải hiển thị/cancel open order.
- Order cần expiry và phải có headroom tương ứng độ dài window.
- Price/quantity phải đúng tick/lot và dùng integer/bigint ở boundary.
- Market finalized không nhất thiết còn trong live list; query binary markets với trạng thái finalized để chấm/redeem.
- Winning tokens phải chủ động redeem.
- Không chạy nhiều worker cùng một signer nếu có agent live-trade, tránh nonce race.
- SDK đang thay đổi nhanh; pin exact version và commit `package-lock.json`.

## 9. Cách pitch trong 20 giây

> Prediction markets cho bạn odds, nhưng không cho bạn biết odds đó có đáng tin hay không. DreamCurve cho nhiều agent dự báo cùng một DreamDEX Event Contract, giải thích edge của từng agent và công khai track record sau settlement. Người dùng có thể copy tín hiệu thành một giao dịch on-chain, rồi redeem và kiểm chứng toàn bộ vòng đời ngay trên Somnia.

## 10. Nguồn kỹ thuật cần dùng

- DreamDEX Event Contracts docs: https://docs.dreamdex.io/developers/event-contracts
- markets SDK: https://www.npmjs.com/package/@somnia-chain/markets-sdk
- DreamDEX Bot Kit: https://github.com/somnia-chain/dreamdex-bot-kit
- Event Contracts notes/gotchas: https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/docs/event-contracts.md
- Starter template: https://github.com/IronicDeGawd/ec-dreamdex-hackathon-template
- DreamDEX Event Contracts app: https://app.dreamdex.io/event-contracts
- Somnia docs: https://docs.somnia.network

Lưu ý: tài liệu npm cho thấy SDK hiện đã tiến lên `0.29.0` tại thời điểm rà soát. Không mặc định rằng code viết cho `0.28.1` tương thích hoàn toàn; hãy pin một phiên bản sau khi chạy lifecycle test thành công.
