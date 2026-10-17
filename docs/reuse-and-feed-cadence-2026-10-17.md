# 2026-10-17：三條「唔改變評估對象、只刪請求」嘅改動（＋兩條死腿關掉）

前提：`docs/efficiency-2026-10-16.md` 已經證明瓶頸唔喺 DB、唔喺 CPU（32%）、唔喺 tick 預算，
而喺**上游**（DexScreener 共用 egress 嘅 429）同**每 tick 白花嘅 request**。呢份文件只做四件事，
每件都係「tick 睇嘅幣一個都冇少，只係唔再問同一條問題」。

| # | 改動 | 一句話 |
|---|---|---|
| 1A | `JUP_PAIR_CACHE_SECONDS`（90s，0 = 關） | pair fallback 唔再每 tick 重問成個 slice，只問 cache 冇嘅 |
| 2A | `JUPITER_TRENDING_LIMIT = 0`、`DEXSCREENER_BOOSTS_LIMIT = 0` | 兩條 24h 內貢獻 0／23 個幣嘅腿關掉（各佔一個 request／tick） |
| 3A | `DEXSCREENER_PROFILES_INTERVAL_SECONDS`（300s，0 = 關） | profiles 頁 5 分鐘問一次，期內重用上一個 list |
| — | `feedMakeup.cadenceSkips` | 新增讀數：幾多次係「重用」而唔係「冇問到／被拒」 |

## 0. 量度方法（同一把尺，before／after 一樣）

`scripts/tick-metrics.mjs`（新，唯讀）：

```
node scripts/tick-metrics.mjs durable --label before --rows 240   # scan_history 嘅 240-tick 窗口
node scripts/tick-metrics.mjs sample --out /tmp/before.jsonl --minutes 2.7 --interval 10
node scripts/tick-metrics.mjs report --in /tmp/before.jsonl
```

- **240-tick 窗口**（`/debug/scan-history?rows=240`）：`ms`、`profiles`、`pool`、`candidates`、
  `pushed` —— 由 tick 自己寫落 D1，isolate 點 recycle 都讀得返。
- **live sample**（`/health`，10s 一次，用 `heartbeat.at` 去重）：逐 tick 嘅 `feedsMs`、
  `feedJoinMs`、`feedLegMs.*`、`pairs / pairsJup / pairsMissing`、`organicNoLine / organicWaited /
  organicRetried`、`jupReserved`，同 `feedMakeup` / `dex` 嘅累計值（報告用 first→last 嘅 delta）。
- **每 feed 新幣**：`token_stats` 按 `first_seen_at` 落在窗口內、`GROUP BY discovered_via`。之前用
  `/debug/feed-stats` 嘅前後 snapshot 做差係**錯**嘅（嗰個 endpoint 係 all-time 而且會被 prune，
  實測會出 `dex -2` 呢種負數），所以改用 D1 直接數。

## 1. Before（未改，live `solana-meme-bot`，2026-10-17 03:59–04:28Z）

### 1.1 240-tick 窗口（03:41 前回望 1.93h）

| reading | value |
|---|---|
| ticks | 240 |
| tick gap p50 / p90 | 32.0s / 40.7s |
| scan ms p50 / p90 / max | **1,679 / 2,108 / 4,531** |
| profiles p50 / min / max | 27 / 26 / 28 |
| pool p50 | 1,187 |
| candidates total | 92 |
| pushed total | 3 |

### 1.2 live sample（67 ticks，29 分鐘）

| reading | value |
|---|---|
| ms p50 / p90 / max | 1,844 / 2,480 / 4,263 ms |
| feedsMs p50 / p90 / max | **675 / 843 / 1,162 ms** |
| feedJoinMs p50 | 670 ms |
| feedLeg profiles | 13 / 45 ms |
| feedLeg pump | 70 / 118 ms |
| feedLeg jup | 112 / 235 ms |
| feedLeg raydium | 364 / 590 ms |
| feedLeg meteora | 277 / 439 ms |
| feedLeg **jupTrend** | **661 / 709 ms** |
| feedLeg gecko | 25 / 1,046 ms |
| pairs p50 / p90 | 200 / 208 |
| pairsJup p50 / p90 | 200 / 200 |
| pairsMissing p50 / p90 / max | 0 / 95 / 95 |
| **pairsMissing share** | **6.2%** |
| organicNoLine / organicWaited / organicRetried | 1 / 6 / 6 |
| **jupReserved** total / mean / ticks>0 | 36 / 0.6 / 35 of 67 |
| profiles p50 / min / max | 27 / 0 / 28 |
| candidates / pushed | 68 / 0 |

counter deltas（first → last tick，同一 isolate 內）：`feedRequests +4`、`failedTotal +1`、
`injectedTotal +0`、`pairCacheMisses +11`、`listCacheHits +4`、`http429 +0`、`probeDeferrals +5`、
`episodeDeferrals +1`。

### 1.3 每 feed 新幣（同一 29 分鐘窗口，D1 `token_stats.first_seen_at`）

| feed | coins |
|---|---|
| pump | **674** |
| jup | **184** |
| meteora | 14 |
| gecko | 6 |
| boosts | 2 |
| dex | **0** |
| jupTrend | **0** |
| raydium | 0 |

24h 對照（同一條 query，`first_seen_at >= now-24h`）：pump 39,321／jup 11,331／meteora 710／
raydium 323／gecko 257／legacy 48／dex 39／boosts 23。**jupTrend 最後一個新幣係
2026-10-01 00:41Z（16 日前）**，24h 內 0 個。

## 2. 改動

### 2A：兩條腿關掉

- `JUPITER_TRENDING_LIMIT = "0"`：24h 0 個新幣、最後一個 16 日前；成本係每 tick 一個 Jupiter
  request，而同一個 provider 窗口（5 次／10s）要分畀卡片嘅 有機度 讀數 —— `jupReserved` 35/67
  個 tick 有 non-zero 就係嗰條隊。
- `DEXSCREENER_BOOSTS_LIMIT = "0"`：240-tick 窗口 0 個新幣，但**24h 有 23 個**（best mcap $639K，
  4 次 push 全部歷史）—— 呢個 trade-off 要明講，唔係「零貢獻」。成本係每 tick 一個
  api.dexscreener.com request，而且佢係 feed join 最長嘅腿（leg ring 997ms）。想返嚟就調
  `DEXSCREENER_BOOSTS_INTERVAL_SECONDS`（已存在，300 = 5 分鐘一次）。

### 1A：`JUP_PAIR_CACHE_SECONDS = "90"`

每一條 pair reading 喺 90s 內可以重用；過期即重新問（**staleness bound 係閘門接受嘅上限**，
唔係無限 cache）。只會問 cache 冇嘅地址；provider 答唔到嘅 mint **唔會**被記成空（下次照問）。

### 3A：`DEXSCREENER_PROFILES_INTERVAL_SECONDS = "300"`

5 分鐘內重用上一個 list。cold isolate 一定問一次，所以 `lastRawProfiles` / `failedTotal` 仍然係
上游嘅真實讀數；skip 另計 `cadenceSkips`，**唔會**計入 `feedRequests`。deferred make-up 照樣
接上被重用嘅 list。

## 3. 測試

`npm run typecheck` 0；`npm run test:unit` 全部 suite 綠（`test-unit` 569 passed / 0 failed）。

新增／改動：

- `test-unit.js`
  - `loadConfig: the pair-reuse TTL and the profiles cadence — defaults, 0 and junk`
  - `fetchTokenDataBatch: inside JUP_PAIR_CACHE_SECONDS a reading is reused — only the missing addresses are asked`
    （同一 slice 零 request、rotation 只問新增、provider 答唔到嘅 mint 會重問、過期重問、0/缺席 = 舊行為）
  - `tier 2 …` 嘅 toml pin 改成部署值：boosts `0`、trending `0`、profiles `300`、pair TTL `90`
- `test-deferred-priority.js`
  - 新 `cadenceTests`：期內零 request、同一個 list、make-up 照上、`cadenceSkips` 計數、
    `0` = 每 tick 都問
  - 其餘「測 fetch 行為」嘅 case 一律用 `DEXSCREENER_PROFILES_INTERVAL_SECONDS: "0"`
    （一個 suite 一個軸；cadence 有自己嘅 test）

Mutation 實測（唔係自我安慰）：

| mutation | 結果 |
|---|---|
| pair cache 完全冇 TTL（prune no-op ＋ `if (hit)`） | `❌ … an expired reading must be asked again` → 568 passed, 1 failed |
| cadence gate 關掉（`false &&`） | `❌ … a list younger than the cadence is REUSED, not re-asked`（2 !== 1） |

## 4. After（deploy `a91f343` 04:52Z；加讀數嗰個 `5c10b07` 05:12Z）

### 4.1 live sample（52 ticks，27 分鐘，05:14:09–05:41:01Z）

同 §1.2 同一支探針、同一個 interval。

| reading | before | after |
|---|---|---|
| scan ms p50 / p90 / max | 1,844 / 2,480 / 4,263 | **1,227 / 1,864 / 2,247** |
| **feedsMs p50 / p90 / max** | 675 / 843 / 1,162 | **362 / 607 / 1,039** |
| feedJoinMs p50 | 670 | **362** |
| feedLeg jupTrend | 661 / 709 | —（腿已關） |
| feedLeg jup | 112 / 235 | 166 / 209 |
| feedLeg pump | 70 / 118 | 70 / 153 |
| feedLeg raydium | 364 / 590 | 352 / 454 |
| feedLeg meteora | 277 / 439 | 286 / 509 |
| feedLeg profiles | 13 / 45 | **8 / 19** |
| pairs p50 | 200 | 202 |
| pairsJup p50 | 200 | 201 |
| **pairsMissing p50 / p90 / max** | 0 / 95 / 95 | **0 / 0 / 0** |
| **pairsMissing share** | 6.2% | **0.0%** |
| organicNoLine / organicWaited / organicRetried | 1 / 6 / 6 | **0 / 0 / 0** |
| **jupReserved** total / ticks>0 | 36 / 35 of 67 | **0 / 0 of 52** |
| profiles p50 / min / max | 27 / 0 / 28 | 25 / 0 / 25 |
| candidates total | 68 | 21 |

逐項閱讀：

- **feedsMs 675 → 362ms**：關掉 jupTrend（661ms 嘅腿）＋ boosts（每 tick 一個 request），
  feed join 嘅上界即刻由 jupTrend 交返畀 pump/jup/raydium。呢個係 2A 嘅直接效果，唔係推算。
- **pairsMissing 6.2% → 0%**：呢個唔係 1A 嘅功勞（下面講），係 **3A** 嘅副作用 —— profiles list 由
  5 分鐘內重用，令同一個 list 嘅幣喺多個 tick 之間被反覆評估，第一次因為 chunk 用盡而未拿到 pair 嘅幣，
  下一個 tick 仲有機會補上（`pairs 202 / pairsJup 201`，即係幾乎全部都有讀數）。
- **jupReserved 36 → 0**：trending 腿關掉之後，bulk lane 冇再撞到 provider 嘅 5-call 窗口，所以冇一個 tick
  需要為卡片嘅 有機度 讀數讓路（`organicWaited` 6 → 0 係同一件事嘅另一端）。
- **profiles p50 27 → 25**：頁面本身嘅大小（重用嗰個 list 冇改變評估對象，只係唔再問）。

### 4.2 1A 嘅實測：reuse 只有 2.5%，唔係一半

新讀數 `summary.jupPairCache`（per-tick delta）：

| reading | 52 ticks |
|---|---|
| hits / fetched（sum） | **149 / 5,850** |
| reuse share | **2.5%** |
| ttlMs / size p50 | 90,000 / 202 |

原因睇得見：tick 由 `/internal/cron-relay` 嘅 self-fetch 執行，**每次可能落在唔同 isolate**，而 cache
係 per-isolate 嘅（`size` p50 = 202 ≈ 一個 tick 嘅 slice，即係每次都係冷快取開始）。偶然同一 isolate
連續服務兩個 tick 就會命中（實測見過一格 `71 hits / 114 fetched / size 297`）。

**所以 1A 冇達到原本嘅預期**（原本假設「同一個 client 連續幾 tick 問同一批幣」）。要講清楚：
佢而家係一個**正確但邊際**嘅改動 —— 2.5% 嘅讀數重用、~0.05 個 request／tick —— 真正嘅收益嚟自 2A/3A。
保留佢嘅理由：暖 isolate 真係會中（上表 149 個 pair 就係），成本只係每個 isolate ~200 個物件，
而 `JUP_PAIR_CACHE_SECONDS="0"` 係一個字就關返。

### 4.3 3A 嘅實測：暖 isolate 40–57% 嘅 profile fetch 被 skip

| reading | value |
|---|---|
| `feedMakeup.cadenceSkips`（單一 isolate 最多） | 4 |
| 同一 tick 嘅 `feedRequests`（最多） | 3 |
| **profile-list tick 被 skip 嘅中位 share** | **40%**（31 個有讀數嘅 tick） |
| `feedMakeup.failedTotal`（最多） | 2（before 11） |

同 1A 同一個結構限制：**cold isolate 一定問一次**（故意嘅，咁 `lastRawProfiles`／`failedTotal`
先至仍然係上游嘅真實讀數），所以 fleet 層面嘅 request 減幅細過「暖 isolate 嘅 40%」。

### 4.4 每 feed 新幣（同一把尺）

窗口長度唔同（before 29 分鐘、after 27 分鐘），所以同時列 10 分鐘桶嘅原始序列，免得用一個比率
蓋過變異。

| feed | before（29 min） | after（27 min） |
|---|---|---|
| pump | 674 | 615 |
| jup | 184 | 115 |
| meteora | 14 | 16 |
| gecko | 6 | 2 |
| raydium | 0 | 7 |
| **dex（profiles）** | **0** | **0** |
| **boosts** | 2 | **0（腿已關）** |
| **jupTrend** | **0** | **0（腿已關）** |

10 分鐘桶（`first_seen_at`，pump / jup）：

```
03:40 245/91   03:50 221/78   04:00 244/56   04:10 196/53   04:20 254/81
04:30 235/55   04:40 207/62   04:50 199/52   05:00 209/46   05:10 223/31
05:20 260/62   05:30 218/31
```

**jup 由 184 跌到 115 唔係改動造成**：同一個 feed 喺 before 窗口自己都喺 46–91／10min 之間浮動，
after 嘅 05:20 桶係 62（before 嘅中位數附近），05:30 桶 31（before 05:00 桶都係 46）。
pump 由 232 → 228／10min（雜訊內），所以市場成交量冇變。

真正要睇嘅係兩條被關嘅腿：**boosts 由 2 → 0**（呢個係代價，見 §2A：24h 23 個幣）、
**jupTrend 由 0 → 0**（冇損失）、**dex 由 0 → 0**（cadence gate 冇令任何一個幣消失）。

### 4.5 durable 窗口（`scan_history`）

兩個切法，因為 deploy 之後未夠鐘寫滿 240 個 tick：

**(a) 同一個 240-tick 尺（before 齊、after 未夠鐘）**

| reading | before（240 ticks） | after（90 ticks，0.78h） |
|---|---|---|
| scan ms p50 / p90 / max | 1,679 / 2,108 / 4,531 | **1,213 / 1,633 / 2,247** |
| profiles p50 / min / max | 27 / 26 / 28 | 25 / 25 / 27 |
| pool p50 | 1,187 | 1,131 |
| tick gap p50 / p90 | 32.0s / 40.7s | 31.8s / 41.4s |
| gaps > 120s | 0 | 0 |

**(b) 等長、相鄰、同一小時（最硬嘅對照：79 vs 79 ticks）**

| reading | before 04:30–05:12（79 ticks） | after 05:12–05:53（79 ticks） |
|---|---|---|
| scan ms p50 / p90 / max | 1,712 / 2,923 / 4,187 | **1,218 / 1,633 / 2,247** |
| profiles p50 | 25 | **25** |
| pool p50 | 1,200 | 1,130 |
| candidates | 127 | 31 |
| pushed | 3 | 0 |

**candidates 127 → 31 要老實講，唔可以歸功／歸咎於呢次改動。** 兩個窗口相隔 40 分鐘但市場唔同：
05:30 之後 24 分鐘係 **0 candidates**，而同一個鐘數 2026-10-16 本身都只有 3–7 個／30 min
（10-16 05:00–06:00：3、7；06:30：1；09:30：1）—— 即係呢個時段本身就係最靜。
支撐「唔關事」嘅讀數：`profiles p50` 兩個窗口一樣（25，覆蓋冇跌）、`pairs 202 / pairsJup 201`、
`pairsMissing 0%`（before 6.2%）、而該 tick 嘅 reject 係 **178 個 `市值 — < $60K`**，名單係 age 660–750
分鐘嘅 pool 舊幣（唔係 profiles 嘅新幣），所以「profiles list 重用」唔可能係成因。

**（待真 240-tick after）**：deploy 夠鐘之後
`node scripts/tick-metrics.mjs durable --label after --rows 240` 就係同一把尺，唔需要再改 code。
