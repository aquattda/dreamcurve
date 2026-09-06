# Phân tích lỗi “No active BTC or ETH windows”

## 1. Kết luận ngắn

Thông báo trong ảnh **không phản ánh đúng sự cố đang xảy ra**.

Tại thời điểm kiểm tra ngày 06/09/2026, ứng dụng chưa chứng minh được rằng “không có market BTC/ETH đang hoạt động”. Collector thực tế **không lấy được danh sách market từ DreamDEX indexer vì truy vấn GraphQL `BinaryMarkets` bị timeout**. Do state trả về có `markets: []`, frontend lại dùng chung empty state “No active BTC or ETH windows”, khiến lỗi hạ tầng bị trình bày như một trạng thái nghiệp vụ bình thường.

Có hai vấn đề cần sửa:

1. **Sự cố vận hành hiện tại:** data-plane của DreamDEX testnet indexer không trả được truy vấn dữ liệu `Market` trong thời hạn cho phép.
2. **Lỗi thiết kế trong DreamCurve:** backend và frontend chưa phân loại nguyên nhân của danh sách rỗng; logic discovery cũng dùng API tổng quát rồi lọc phía ứng dụng, có khả năng bỏ sót market hợp lệ.

Không nên “sửa” bằng cách chèn dữ liệu demo vào live mode. Việc đó che lỗi nguồn dữ liệu và có thể khiến người dùng tưởng rằng market giả là market có thể giao dịch.

## 2. Bằng chứng thu thập được

### 2.1. Trạng thái thật của bản deploy

Đọc trực tiếp API công khai của bản deploy:

```text
GET /api/health

status:    degraded
updatedAt: 0
message:   DreamDEX connection unavailable:
           @somnia-chain/markets-sdk: indexer BinaryMarkets failed:
           The operation was aborted due to timeout
```

```text
GET /api/arena?mode=live

mode:      live
status:    degraded
updatedAt: 0
markets:   []
```

`updatedAt: 0` là chi tiết quan trọng: collector **chưa từng hoàn tất thành công một vòng thu thập dữ liệu** kể từ khi process hiện tại khởi động. Vì vậy `markets: []` ở đây mang nghĩa “không có dữ liệu đáng tin cậy”, không phải “đã truy vấn thành công và kết quả bằng 0”.

### 2.2. Cấu hình mạng không bị lệch chain

`GET /api/config` của bản deploy trả về:

```text
chainId:    50312
rpcUrl:     https://dream-rpc.somnia.network
wsRpcUrl:   wss://api.infra.testnet.somnia.network/ws
indexerUrl: https://dev.smk.somnia.host/v1/graphql
```

Gọi `eth_chainId` trực tiếp tới RPC trả `0xc488`, tương đương decimal `50312`. RPC và chain được cấu hình đúng.

Endpoint indexer cũng đúng với cấu hình Shannon testnet do package `@somnia-chain/markets-sdk@0.29.0` công bố. Vì vậy chưa có bằng chứng cho thấy lỗi đến từ việc dùng nhầm mainnet/testnet hoặc sai URL.

### 2.3. Indexer còn nhận HTTP nhưng data query bị treo

Kết quả probe trực tiếp:

- GraphQL `query { __typename }` trả HTTP 200 trong khoảng 0,9 giây.
- Query tối giản vào `Market`, chỉ lấy một số field và giới hạn 1–8 row, vẫn không hoàn tất sau 15–25 giây.
- `client.listLiveBinaryMarkets({ asset: "BTC", status: "Trading", limit: 8 })` cũng bị abort sau 25 giây.
- Query `chain_metadata` dùng để kiểm tra sync status cũng timeout.

Điều này cho thấy DNS/TLS/HTTP frontend của indexer vẫn sống, nhưng lớp truy vấn dữ liệu phía sau đang quá chậm hoặc không khả dụng. Đây không phải lỗi render React và cũng không phải lỗi ví người dùng.

SDK đặt trần mặc định 30 giây cho một GraphQL request. Thông báo “operation was aborted due to timeout” từ bản deploy phù hợp với hành vi này.

## 3. Luồng gây ra màn hình sai hiện tại

### Backend

Trong `server/index.ts`:

1. Collector gọi `listBinaryMarkets({ limit: 100, ... })`.
2. Lệnh này chờ DreamDEX indexer.
3. Indexer không trả truy vấn `BinaryMarkets` trước timeout.
4. `catch` đặt `state.status = "degraded"` và ghi lỗi vào `state.message`.
5. Do đây là cold start, `state.markets` vẫn là mảng rỗng và `updatedAt` vẫn bằng `0`.
6. `/api/arena` vẫn trả HTTP 200 cùng state rỗng.

### Frontend

Trong `src/Arena.tsx`:

1. `useArena()` nhận response hợp lệ về mặt HTTP nên gán response vào `state`.
2. `ArenaHome` chỉ kiểm tra có phần tử trong `state.markets` hay không.
3. Khi không tìm được `market`, component luôn render `<EmptyState live />`.
4. `EmptyState` luôn dùng headline “No active BTC or ETH windows”, không kiểm tra `state.status`, `state.updatedAt` hoặc mã lỗi.

Vì vậy ba trạng thái khác nhau đang bị gộp làm một:

| Trạng thái thật | UI hiện tại |
| --- | --- |
| Query thành công, thực sự có 0 market phù hợp | No active windows |
| Indexer timeout ở cold start | No active windows |
| Có row discovery nhưng mọi `readMarket()` đều thất bại | No active windows |

Đây là nguyên nhân trực tiếp khiến thông báo trong ảnh gây hiểu nhầm.

## 4. Điểm yếu bổ sung trong discovery

Ngay cả khi indexer hoạt động lại, logic hiện tại vẫn có thể tạo ra empty state giả.

### 4.1. Dùng sai loại API cho live discovery

Code đang gọi:

```ts
listBinaryMarkets({ limit: 100 })
```

Theo source của SDK, API này mặc định sắp xếp theo `createdAtTimestamp desc`, tức là lấy **100 binary market được tạo gần nhất**, không phải 100 market live sắp đóng.

Sau khi nhận 100 row, DreamCurve mới lọc ở Node:

```ts
BTC hoặc ETH
&& expiry > now
&& tradingStart <= now
```

Nếu 100 row mới nhất chứa nhiều asset/venue khác hoặc market đã đóng, một market BTC/ETH còn live nhưng nằm ngoài 100 row sẽ bị bỏ sót.

SDK đã có API đúng mục đích:

```ts
listLiveBinaryMarkets(...)
```

API này lọc `expiry > now` phía server, mặc định xếp theo `expiry asc` và hỗ trợ `asset`, `status`, `venueId`, `intervalSec`, `limit`, `offset`.

Lưu ý: đổi sang `listLiveBinaryMarkets` sẽ làm discovery đúng và nhẹ hơn, nhưng **không tự chữa được một indexer đang outage hoàn toàn**. Probe hiện tại cho thấy API live chuyên dụng cũng timeout.

### 4.2. Lọc asset sau khi đã áp dụng limit

BTC/ETH được lọc sau `limit: 100`, nên các row không liên quan chiếm quota. Nên lọc asset ở indexer bằng hai query nhỏ cho `BTC` và `ETH`, hoặc dùng một server-side `_in` query nếu SDK hỗ trợ sau này.

### 4.3. Không phân biệt lỗi từng market với “không có market”

`Promise.allSettled(rows.map(readMarket))` là lựa chọn đúng để một market lỗi không đánh sập toàn bộ vòng thu thập. Tuy nhiên nếu tất cả `readMarket` đều reject, code gán `state.markets = []` rồi UI lại hiển thị “No active”. Trạng thái này phải là `MARKET_READ_FAILED`.

### 4.4. Retry gần như liên tục khi upstream hỏng

Collector chạy mỗi 5 giây. Một query có thể chờ tới 30 giây; cờ `busy` ngăn request chồng nhau, nhưng ngay sau một lần timeout, tick kế tiếp sẽ thử lại gần như ngay lập tức. Khi outage kéo dài, ứng dụng liên tục tạo query đắt mà không có exponential backoff hoặc jitter.

### 4.5. Health endpoint chưa thể hiện readiness

`/api/health` luôn trả HTTP 200 dù `status = degraded` và `updatedAt = 0`. Điều này phù hợp với liveness nhưng không phù hợp với readiness. Nền tảng deploy có thể xem service là khỏe trong khi chức năng live hoàn toàn chưa dùng được.

### 4.6. Venue filter có thể tạo kết quả rỗng thật

Nếu biến `DREAMDEX_VENUE_ID` được đặt thành venue cũ/sai, SDK sẽ lọc server-side và có thể trả 0 row. Đây chưa phải nguyên nhân đã được chứng minh trong lần kiểm tra này vì lỗi hiện tại là timeout, nhưng cần log giá trị venue đã áp dụng và kiểm tra nó khi vận hành.

## 5. Phương án giải quyết đề xuất

### P0 — Sửa thông báo và state machine

Không dùng `markets.length === 0` làm bằng chứng duy nhất.

Nên bổ sung metadata có cấu trúc vào `ArenaState`, ví dụ:

```ts
type DataIssue =
  | 'INDEXER_TIMEOUT'
  | 'INDEXER_ERROR'
  | 'MARKET_READ_FAILED'
  | 'COLLECTOR_DISABLED'
  | null;

type ArenaState = {
  status: 'healthy' | 'degraded' | 'connecting';
  issue: DataIssue;
  updatedAt: number;
  lastSuccessfulAt: number | null;
  markets: Market[];
  // ...
};
```

Frontend nên render theo thứ tự:

```text
state chưa tải                         -> Loading
degraded + chưa từng thành công        -> Live data unavailable
degraded + có last-known-good data     -> Stale/degraded banner + dữ liệu read-only
healthy + markets.length === 0          -> No active BTC or ETH windows
healthy + markets.length > 0            -> Arena
```

Thông báo phù hợp cho lỗi hiện tại:

```text
Live market data is temporarily unavailable

DreamDEX's testnet indexer did not respond in time.
Your wallet and funds are not affected. Retry shortly or explore illustrative data.
```

Nút nên có `Retry live data` và `Explore example arena`. Không ghi “collector is connected” khi collector chưa từng hoàn thành một lần đọc.

### P0 — Dùng live discovery API đúng mục đích

Thay query tổng quát bằng query live, lọc asset và status ngay tại indexer:

```ts
const assets = ['BTC', 'ETH'] as const;

const discovered = await Promise.all(
  assets.map(asset => exchange.client.listLiveBinaryMarkets({
    asset,
    status: 'Trading',
    limit: 8,
    ...(venueId ? { venueId } : {}),
  })),
);

rows = discovered
  .flat()
  .filter((market, index, all) =>
    all.findIndex(candidate => candidate.marketId === market.marketId) === index
  )
  .sort((a, b) => Number(a.expiry) - Number(b.expiry))
  .slice(0, 8);
```

Vẫn nên kiểm tra lại `expiry`, `tradingStart` và on-chain status sau discovery vì indexer có thể lag. Query indexer dùng để tìm candidate; chain là nguồn xác nhận trạng thái giao dịch.

### P0 — Không xóa last-known-good state khi refresh lỗi

Nếu hệ thống từng tải thành công:

- Giữ market chưa hết hạn trong state.
- Đặt state là `degraded` và đánh dấu timestamp dữ liệu cũ.
- Disable giao dịch vì `blockReason()` đã chặn dữ liệu quá 15 giây.
- Hiển thị rõ “Last updated …; trading disabled until a fresh quote arrives”.

Nếu đây là cold start và không có cache, hiển thị error state thay vì no-market state.

Không nên giữ một market đã hết hạn chỉ để tránh màn hình rỗng.

### P1 — Thêm cache discovery có thể phục hồi sau restart

State trong RAM không giúp được khi dyno restart. Có thể tận dụng bảng `markets` hiện có:

1. Thêm hàm đọc các normalized market có `expiry > now` từ store.
2. Khi indexer discovery timeout, tải candidate gần nhất từ DB.
3. Xác minh lại market ID, expiry, status và order book trên chain trước khi hiển thị.
4. Chỉ hiển thị cache ở chế độ read-only nếu quote không còn fresh.

Giới hạn của fallback này: nó giữ được market đã biết, nhưng không thể phát hiện market mới được tạo trong lúc indexer ngừng hoạt động. Muốn discovery hoàn toàn không phụ thuộc indexer cần một cơ chế quét/subscription event `MarketCreated` có checkpoint; đó là thay đổi kiến trúc lớn hơn.

### P1 — Backoff, timeout và quan sát hệ thống

Đề xuất retry discovery theo chuỗi 5s → 10s → 20s → 40s → tối đa 60s, kèm jitter; reset về 5s sau lần thành công.

Mỗi vòng nên log có cấu trúc:

```text
discovery_started
discovery_succeeded: total, btc, eth, elapsedMs
discovery_failed: issue, operation, elapsedMs, attempt, nextRetryMs
market_reads_finished: requested, succeeded, failed
```

Không log secrets, wallet data hoặc toàn bộ payload không cần thiết.

Tách endpoint:

- `/api/health` hoặc `/api/live`: process còn chạy thì trả 200.
- `/api/ready`: chỉ trả 200 khi có ít nhất một vòng collector thành công gần đây; cold-start degraded trả 503.

Việc “không có active market” vẫn là readiness thành công nếu query đã hoàn tất và xác nhận kết quả bằng 0.

### P1 — Làm rõ lỗi từ API

Không bắt frontend parse chuỗi `message`. Backend nên trả mã ổn định:

```json
{
  "status": "degraded",
  "issue": "INDEXER_TIMEOUT",
  "retryable": true,
  "updatedAt": 0,
  "lastSuccessfulAt": null,
  "message": "DreamDEX testnet indexer did not respond in time."
}
```

Thông tin kỹ thuật đầy đủ nên nằm trong server log; UI chỉ cần thông điệp dễ hiểu và không gây hoang mang.

## 6. Những cách không nên làm

- Không tự động chuyển live mode sang demo data mà không đổi nhãn.
- Không coi `[]` là bằng chứng upstream khỏe.
- Không tăng timeout vô hạn; điều này chỉ khiến cold start/loading kéo dài.
- Không bỏ kiểm tra on-chain chỉ vì indexer đã trả status `Trading`.
- Không hard-code một venue ID khi chưa xác minh venue hiện tại.
- Không đổi RPC để chữa lỗi GraphQL: kiểm tra cho thấy RPC đang trả đúng chain, còn request lỗi nằm ở indexer.

## 7. Kế hoạch kiểm thử sau khi sửa

### Unit tests

1. `healthy + markets=[]` render đúng “No active windows”.
2. `degraded + updatedAt=0 + INDEXER_TIMEOUT` render “Live data unavailable”.
3. `degraded + lastSuccessfulAt!=null` giữ dữ liệu cũ, có stale badge và trade bị disable.
4. `COLLECTOR_DISABLED` hiển thị hướng dẫn cấu hình, không hiển thị no-market.
5. Discovery gọi `listLiveBinaryMarkets` với filter BTC/ETH và `Trading`.
6. Hai asset được merge, deduplicate theo `marketId` và sort theo expiry.
7. Một market read lỗi không làm ẩn các market đọc thành công.
8. Tất cả market read lỗi trả `MARKET_READ_FAILED`, không trả `NO_MATCHING_MARKETS`.

### Integration tests

1. Mock indexer timeout: API phải trả `degraded`, `INDEXER_TIMEOUT`, `retryable: true`.
2. Mock query thành công với `[]`: API phải trả `healthy`, `markets: []`.
3. Mock indexer hồi phục: collector tự trở lại `healthy` mà không restart process.
4. Mock dữ liệu cũ: UI hiển thị read-only và không mở flow ký giao dịch.
5. Xác minh backoff không tạo request chồng nhau.

### Production verification

```text
1. GET /api/health hoặc /api/live        -> process alive
2. GET /api/ready                        -> phản ánh collector readiness
3. GET /api/arena?mode=live              -> issue/state nhất quán
4. So sánh candidate từ indexer với on-chain status
5. Theo dõi ít nhất một chu kỳ market mới/market expiry
```

## 8. Definition of Done

- UI chỉ hiển thị “No active BTC or ETH windows” sau một discovery thành công trả 0 market phù hợp.
- Indexer timeout có error state riêng, nút retry và đường dẫn demo được ghi rõ là illustrative.
- Discovery dùng server-side live/asset/status filters và không bị giới hạn sai bởi 100 row mới nhất toàn hệ thống.
- Last-known-good data không biến mất vì một lần refresh lỗi; giao dịch luôn bị khóa khi quote stale.
- Có exponential backoff và log đủ để phân biệt discovery failure với market-read failure.
- Readiness không trả success trong cold start khi collector chưa từng cập nhật.
- Test bao phủ timeout, zero-result thật, partial failure, recovery và stale cache.

## 9. Thứ tự triển khai thực tế

1. Sửa state/error taxonomy và UI để ngừng báo sai ngay lập tức.
2. Đổi sang `listLiveBinaryMarkets` với BTC/ETH + `Trading` filter.
3. Giữ last-known-good state và khóa trade khi stale.
4. Thêm retry backoff, readiness endpoint và structured logs.
5. Thêm DB cache/on-chain fallback nếu yêu cầu độ sẵn sàng cao hơn indexer.

Sau bước 1–4, ứng dụng sẽ không còn biến một lỗi indexer thành “không có market”, tự hồi phục rõ ràng khi upstream hoạt động lại và giảm đáng kể nguy cơ false-empty do discovery sai phạm vi.

## 10. Nguồn đối chiếu

- SDK đang dùng trong dự án: `@somnia-chain/markets-sdk@0.29.0`.
- SDK package/readme: <https://www.npmjs.com/package/@somnia-chain/markets-sdk>
- Somnia network reference: <https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/skills/somnia/SKILL.md>
- Local SDK source: `node_modules/@somnia-chain/markets-sdk/src/markets.ts` — `listBinaryMarkets`, `listLiveBinaryMarkets`, server-side filters và sort order.
- Local SDK source: `node_modules/@somnia-chain/markets-sdk/src/indexerRead.ts` — GraphQL timeout mặc định 30 giây.
- DreamCurve collector: `server/index.ts`.
- DreamCurve adapter/config: `server/protocol.ts`.
- DreamCurve live empty state: `src/Arena.tsx`.

## 11. Trạng thái triển khai (06/09/2026)

Đã triển khai các phần P0/P1 cần thiết trong mã nguồn:

- `ArenaState` có `issue`, `retryable`, `lastSuccessfulAt` và `retryAt`; frontend không còn suy luận nguyên nhân chỉ từ `markets.length`.
- Cold start bị timeout/lỗi upstream hiển thị **“Live market data is temporarily unavailable”**, có nút retry và liên kết sang example arena. Chỉ một lần discovery thành công với kết quả rỗng mới hiển thị **“No active BTC or ETH windows”**.
- Discovery chuyển sang `listLiveBinaryMarkets`, query BTC và ETH riêng ở indexer, sau đó kiểm tra lại `tradingStart`/`expiry`, deduplicate và sort theo expiry.
- Chủ động không truyền filter `status: "Trading"` cho indexer. SDK ghi rõ chuyển tiếp `Listed -> Trading` có thể chỉ xảy ra theo timestamp và không phát event, nên status được index có thể trễ và tạo false-empty. Trạng thái giao dịch thật vẫn được `readMarket()` xác minh on-chain trước khi cho phép đặt lệnh.
- Khi một market read thất bại, dữ liệu tốt gần nhất chưa hết hạn được giữ lại. Timestamp cũ và trạng thái degraded làm toàn bộ thao tác trade bị khóa cho tới khi có quote mới.
- Retry tự động dùng exponential backoff 5s, 10s, 20s, 40s, tối đa 60s. Có `POST /api/retry` với throttle 5 giây cho thao tác retry thủ công.
- `/api/health` tiếp tục là liveness endpoint; `/api/ready` trả 503 khi collector chưa healthy và trả 200 cho trường hợp discovery thành công nhưng thực sự không có market.
- Thông tin lỗi kỹ thuật chi tiết chỉ ghi ở server log; UI nhận mã lỗi ổn định và thông báo an toàn, dễ hiểu.

Đã bổ sung kiểm thử cho discovery/backoff và hai nhánh UI `upstream timeout` so với `healthy empty`. Typecheck, unit test, production build và 7 bài E2E đều pass khi chạy bằng Microsoft Edge hệ thống.

### Về các cảnh báo preload trong Console

Các URL bắt đầu bằng `chrome-extension://hkledmpjpaehamkiehglnbelcpdflcab/...` thuộc một Chrome extension, không thuộc bundle hoặc origin của DreamCurve. Cảnh báo `cross-world extension resource mismatch` và `preloaded ... but not used` xuất phát từ extension inject/preload resource sai context hoặc không dùng kịp sau `load`; chúng không làm collector trả `markets: []` và không gây lỗi indexer timeout.

Có thể xác nhận bằng cách mở trang trong cửa sổ Incognito không bật extension hoặc tắt extension có ID trên. Không cần thêm/xóa `<link rel="preload">` trong DreamCurve để xử lý nhóm cảnh báo này.

### Giới hạn còn lại

Thay đổi này sửa false-empty, UX lỗi, retry và khả năng tự phục hồi của ứng dụng; nó không thể tự khôi phục data-plane của DreamDEX indexer khi dịch vụ upstream đang outage. Sau khi deploy, nếu `/api/ready` vẫn trả 503 với `INDEXER_TIMEOUT`, cần phía vận hành DreamDEX/Somnia khôi phục indexer. DB cache phục hồi qua lần restart và discovery hoàn toàn từ event logs vẫn là hạng mục kiến trúc P1 riêng, chưa được thêm trong bản sửa này.
