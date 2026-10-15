# jup 先登記、Raydium 頁跟尾（2026-10-14）

> 相關：`src/raydiumlaunch.ts`（LaunchLab feed，`/get/list?sort=new`）、
> `scripts/raydium-attribution.js --overlap`（可重跑讀數，今次加咗 registration lag
> 同 birthDelta）、`docs/profiles-feed-zeros.md`（feed 腿覆蓋）。

## 一、問題

「jup feed 先登記、raydium 頁跟尾」一直係一個**未量度**嘅假設：raydium 腿嘅 cohort
（`discovered_via = 'raydium'`，68 條）細，可能唔係因為冇 launch，而係每個 LaunchLab
launch 都已經被 `jup` 腿先登記（`token_stats` 一個 mint 只有一個 owner，INSERT OR
IGNORE 一寫就定）。今次用唯讀探針分開量：**邊條腿先見到、差幾久**。

## 二、方法

- **同一個 upstream**：`RaydiumLaunchClient.fetchNewLaunches` 打嘅係
  `https://launch-mint-v1.raydium.io/get/list?sort=new` + 同一個 UA（`src/raydiumlaunch.ts`），
  所以探針讀到嘅就係隻腿讀到嘅。jup 側係 `lite-api.jup.ag/tokens/v2/recent?limit=30`
  （`JUPITER_RECENT_LIMIT`，config default 30）。
- **兩個探針**（唯讀，每 4–14 秒一次）：(a) 10 個 poll 對比兩邊 head 嘅年齡；
  (b) 密集 poll 捉頁面 head **換行嘅一刻** —— 新 row 第一次出現時嘅年齡 = 頁面
  嘅 listing lag。
- **DB 側**：`node scripts/raydium-attribution.js --overlap`，今次擴充到印每個 page
  mint 嘅 `first_seen_at - launch_ms`（= **擁有嗰條腿自己嘅見幣延遲**）同 `birthDelta`
  （`launch_ms - 頁面 createAt`，用嚟證明兩邊同一個出生鐘：p50 0s、最差 13s
  —— 相對 15s+ 嘅 lag 可以忽略）。
- **點解 label 可以證明「頁面未 serve」**：同一個 tick 兩條腿都抬到同一粒 mint 時，
  label 由 priority 決定，而 `raydium > jup`（`src/scanner.ts` 嘅 `discoveredVia`
  reverse，`scripts/test-unit.js:17739` pin 住）。所以一粒標咗 `jup` 嘅 page mint
  ⇒ **登記嗰個 tick，頁面根本冇 serve 佢**。

## 三、讀數（2026-10-14 04:50–05:02Z）

**A. head 年齡（10 個 poll，約 14s 一次）**

| feed | head 年齡 | 備註 |
|---|---|---|
| raydium 頁 | 380.9 → 519.4s（單調上升） | head 由頭到尾冇換過 |
| jup `/recent` | 5.0 – 10.9s | 一直新鮮 |

同一個窗口兩邊 union：頁 100 粒、jup 83 粒，**交集 0**（jup 個窗只有 50s，頁面最
新嗰粒已經 6 分鐘大）。

**B. 直接捉到嘅 listing lag**

- 04:53:54–04:56:08Z（17 個 poll）：head `9PnRP2…6H32`，birth 04:44:37Z，年齡
  557 → 691s，冇換。
- 04:57:11–04:59:01Z（24 個 poll，約 4.3s 一次）：同一個 head，年齡 754 → 864s。
- **04:59:06Z**：head 換成 `AE9Cp6…XzU6`，birth **04:57:10Z** ⇒ 第一次見到已經
  **116.1s** 大（poll 粒度 ±4s）。
- 同一個 mint 喺 DB：`owned by jup`、**birth + 10s 就登記** ⇒ 呢一單，**頁面遲 jup
  106 秒**。

**C. `--overlap`（三次讀數：04:59Z / 05:0x Z / 05:1x Z）**

| 讀數 | 值 |
|---|---|
| page mints / known | 100 / 100（net_new 0–1） |
| owners（三次讀數 04:59 / 05:0x / 05:1x Z） | **jup 85 / 84 / 83**，raydium **15 / 15 / 17** |
| registration lag — jup | n=83–85，min 3s，**p50 15–16s**，max 38s |
| registration lag — raydium | n=15–17，min 18s，**p50 31–32s**，max 167s |
| birthDelta（`launch_ms - 頁面 createAt`，n=100） | **p50 0s**，最差 \|Δ\| **13s**（jup 側；raydium 側最差 5s） → 兩邊同一個出生鐘 |
| label-share-last-60min | raydium 3 粒（其餘 pump/jup/…） |

**D. 兩個 upstream 自己嘅節奏**

| | 數 |
|---|---|
| jup `/recent` 窗 | 30 行跨 **50s**，head 5.3s，~34.8 新 mint/min |
| raydium 頁 | 100 行跨 **390.7min**，median createAt 間隔 141s ⇒ ~15.4 launch/h |
| tick 節奏 | ~34s ⇒ jup 個 50s 窗**長過 tick** |

## 四、結論

1. **假設成立**：最新 100 粒 LaunchLab launch，**83–85% 由 jup 先登記**（p50 15–16s
   出世），只有 15–17% 由 raydium 腿登記（自己 p50 31–32s）；jup 係「出世即見」
   （head 5–11s）。直接捉到嘅一單：jup birth+10s、頁面 birth+116s。
2. **但「跟尾」幅度唔固定**：頁面有時好快 —— 15 條 raydium label 就係頁面喺第
   一個 tick 已經 serve 到（18–167s，p50 32s ≈ 一個 tick offset）。捉到嗰單 116s
   係重尾樣本，唔係每次。
3. **對 raydium 腿嘅意義**：jup 窗（50s）長過 tick（34s）⇒ 每個 launch 幾乎一定
   喺第一個 tick 前後被 jup 抬走；raydium label 只出現喺「頁面喺同一 tick 都抬到」
   嘅情形，即 label 上 raydium 係**同 tick 搶贏**，唔係頁面先。所以 83–85% 嘅
   launch 係 jup 嘅邊際發現，raydium 腿今次冇貢獻新發現（唯一剩餘價值：jup 429
   backoff 窗、Jupiter 冇 index 嘅 mint、同埋做 tag 分析）。
4. 呢個亦解釋咗「raydium 0 推送」嘅一半：cohort 68 粒係**餘數**，唔係全市場
   sample；best mcap $53,969 < $60K floor 呢個結論唔變，但用 cohort 去 judge 條腿
   嘅視野會低估（佢睇唔到嗰 85%）。

## 五、界線（老實講）

- 直接量到嘅頁面延遲 **n=1**（116s，poll 粒度 ±4s）；B 段係最硬嘅一單，A 段係
  聚合旁證。C 段嘅 83–85 / 15–17 分割只可以話「頁面延遲 > jup 嘅 p50（15–16s）」，**幅度未
  分佈化**（要多捉幾次 head 換行，但頁面只有 ~15.4 launch/h）。
- 探針由呢個沙盒出網，唔保證同 worker egress 同一個 POP／edge；不過 **worker 自己
  嘅 raydium 登記形狀（18–167s、p50 32s）同沙盒一致**，所以效果喺 worker 路徑一樣
  存在。
- **機制未定**：上游 indexer 慢／回應有 cache，今次只有 effect-level 讀數，冇 log
  證明原因。
- 一個 mint 一個 owner 係 schema 保證，所以**睇唔到** raydium 腿係咪喺同一 tick 都
  抬過嗰 15 粒（priority 收埋呢個資訊）。
- 出生鐘唔係 bit-for-bit 一樣：p50 0s 但最差 13s（jup 行嘅 `createdAt` 對頁面
  `createAt`），所以 C 段嘅秒數應該當 ±13s 誤差睇，唔會改變任何結論。
- 冇改任何 runtime 代碼；唯一改動係 `scripts/raydium-attribution.js`（唯讀診斷）。

## 六、驗收

- `node scripts/raydium-attribution.js --overlap` → 表 C（exit 0，output 未經管道
  過濾前已核對）。
- `node scripts/test-unit.js` → **535 passed / 0 failed**（含 pin 住 priority
  reverse 嗰條）。
