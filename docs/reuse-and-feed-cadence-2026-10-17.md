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

## 4. After

deploy 之後用同一把尺再量，數字同對照見 §5（append）。
