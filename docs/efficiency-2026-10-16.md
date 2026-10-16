# 2026-10-16 用緊 $5 Workers Paid + D1：效率仲有咩可以做（先量度，後改）

前提：讀寫**已經**全喺 Cloudflare D1（切換 2026-10-15，見 `docs/d1-migration-2026-10-15.md`），
`placement` 已經指返 D1 primary 隔籬（`gcp:us-south1` ＝ DFW，見 `docs/d1-efficiency-2026-10-15.md`），
`docs/d1-store-audit-2026-10-16.md` 已經補完 store 形狀、100-param 分切、`dbMs`／`dbStatements` 儀器。

呢份文件答一條問題：**賬號會長用 Workers Paid（$5）而 D1 用得着，仲有咩值得做嚟提升效率？**
每一條都先量度，量到才寫；量唔到嘅明確標住「未量到」。

## 0. 結論

| # | 槓桿 | 今日讀數 | 值唔值 | 風險 |
|---|---|---|---|---|
| 1 | **pair lane 空轉**（**已修**，見 §3）：lane 喺 refusal episode 內喺間距隊白等 | block 內嘅 tick 已經係 `poolLegMs.pairs 0`；殘餘係 `blockedForMs 0 / spacingFleetSteps 3 / intervalMs 1,200` 嘅 tick 等足 **1,024ms** | **最高**（單一最大嘅 tick 成本） | 中 — 已保住「復原探測」同 DexScreener 讀數，唔係整條 lane 砍走 |
| 2 | ~~CPU 讀數~~ **已做（§4）** | Workers Logs 已喺 `wrangler.toml` 開（零 code）**並已 deploy（07:40:49Z，§4b）**；逐個 invocation 實測（36 分鐘窗口）：median **6ms**／mean **17.75ms**／p90 **53ms**／max **140ms** ⇒ 月用量 **32%（calculations 視圖 38%）**，唔係天花板但餘裕只有 **2.6–3.2×**。GraphQL 嗰個 **21% 已退役**：佢用嘅 `cpuTimeP50` 實測落喺每分鐘嘅 ~p85（§4c），唔係 per-invocation 統計量 | ~~高~~ 完成 | 低 |
| 3 | **cadence 天花板 = `rows written`**（唔係 tick 預算、唔係 subrequest） | 30s ＝ 30.1M/月（**60%** 額度；同日晚複讀 1.02M／日 → 30.7M／月 ＝ **61%**。兩者係同一個 24h 窗口移動，唔係矛盾）；20s ≈ 90%；15s ≈ 120%（≈$10/月） | 高（決策輸入） | 低（純算術） |
| 4 | **寫入裁剪**（只為換 cadence 而做） | ⚠️ **唔可以照 KB 排**：額度數 **row**，14.6KB 同 40 bytes 都係 1 row。每 tick 固定嘅係 **~3 row**（`scan_heartbeat` 1 row／`tick_leg_slow` 1 row／`scan_history` 1 row）＝ **~8.6K row／日 ≈ 0.9%**，裁佢哋換唔到 cadence。真槓桿係**跟每 tick 觀察到嘅 token 而變**嘅寫入（`token_stats` 更新加佢個 partial index entry）——抽樣密啲就會**睇到多啲變化** | 中（係 #3 嘅前置） | 中（要逐 table 按 **row** 量，見 §8） |
| 5 | D1 read replication / 搬去 DO / 加大存儲 / 砍 index | 全部**唔應該做**，理由見 §6 | 0 | — |

一句講完：**DB 同 tick 預算嘅效率已經解決晒**（SQL 0.2ms、round trip 11–51ms、tick 用 1.4–3.3s 而預算係 20s），
剩返嘅效率喺**上游**（DexScreener 共用 egress 嘅 429）同**寫入額度**（佢先係 cadence 嘅真天花板）。

## 1. 今日實讀（全部現讀，2026-10-16 05:1x–05:2xZ）

```
$ npx wrangler d1 info solana-meme-bot --json
  uuid e8b4be30-…  num_tables 9  database_size 15,691,776 (15.7MB)
  running_in_region WNAM   read_replication.disabled
  read_queries_24h 112,456   write_queries_24h 130,109
  rows_read_24h 16,868,164   rows_written_24h 1,002,799
```

```
$ curl /health
  dbStore "d1"  dbReady true  lastScanMs 3338  scanCount 8 (per-isolate)
  tokenStatsCount 52,161  pushedTotal 1,228  scheduledTickTotal 86,142
  birdeyeCu.monthCu 3,180 / 30,000
  writeCensus rows 655 over sinceMs 4,368,734 (72.8 min, ONE isolate)

$ curl /debug/db-latency?samples=3        # placed 路徑
  select1 p50 12ms   readRow 12ms   writeUpsert 51ms
  claimShapeOneTrip 11ms   claimShapeTwoTrip 101ms   (saving 90ms)
  changes { before 345, after 351, expectedDelta 6, verdict "verified" }

$ curl /debug/clock
  tickMs 30000  on true  ticks 127  lastWorkMs 2,340
  lastResults { scan: "relayed", tracker: "relayed" }

$ curl /debug/dex429
  total 26,113   ring 50 (cap)  →  last hour 50
```

```
$ curl /debug/tick-legs?limit=6
```

| 完成時間 | via | ms | dbStmts | dbCalls | dbMs | subs | profiles | pool | pairs | pairsJup | poolLegMs.pairs | poolLegMs.pairs-jup | evalMs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 05:14:13.847 | cron | 3,272 | 19 | 8 | 127 | 19 | 26 | 907 | 199 | 157 | **1,771** | 615 | 2,402 |
| 05:13:48.598 | clock | 1,446 | 18 | 8 | 247 | 18 | 26 | 908 | 200 | 200 | **0** | 458 | 536 |
| 05:11:41.076 | clock | 2,727 | 31 | 14 | — | 26 | 26 | 1,013 | — | — | **1,221** | 631 | — |

（`raceMs 15,443` 係**獲批嘅 race 窗口**，唔係花咗嘅時間：`SCAN_TICK_BUDGET_MS 20,000`
− `SCAN_FLUSH_RESERVE_MS 4,500` − `preRace 57`。即係 tick 有 1.4–3.3s 用，窗口有 15.4s。）

```
$ npx wrangler d1 execute … "SELECT COUNT(*) …"
  token_stats 52,179   seen_tokens 1,228   push_watch 25
  worker_state 70      scan_history 57,840
$ worker_state 行大小 TOP
  crime_wallets_list 216,423 B (!! 客戶端已停用，見 §6)
  push_ledger 47,118   push_audit 33,201   scan_heartbeat 14,559   tick_leg_slow 12,618
```

## 2. 額度 vs 用量（$5 plan 事實，連來源）

| 額度 | $5 Workers Paid | 今日用量 | 餘裕 |
|---|---|---|---|
| Workers 請求 | 10M／月 | **實測 4,448 個／6h ＝ 17,792／日 → 0.53M／月**（唔止 cron：2,880 scan ＋ 2,880 pass ＋ 288 maint ＝ 6,048／日，即 **2.9×** —— `/health` 輪詢、Telegram webhook、debug 頁全部係 invocation） | **18.7×** |
| CPU 時間 | **30M CPU ms／月**（每次 HTTP invocation 預設 30s，可調到 5 min；cron／queue 15 min） | **實測 6.3M ms／月 ＝ 21%**（見 §4） | 4.8× |
| D1 rows written | 50M／月，之後 $1/M | 1.00M／日 → **30.1M／月 ＝ 60%** | 1.66× |
| D1 rows read | 25B／月，之後 $0.001/M | 16.9M／日 → 506M／月 ＝ **2.0%** | 49× |
| D1 storage | 5GB 內含（10GB／db，1TB／帳號） | 15.7MB ＝ **0.3%** | 318× |
| D1 queries／invocation | 1,000 | 每 tick 18–31 句 | 32–55× |
| bound params／statement | 100 | 已按 `paramLimit()` 分切 | — |
| Time Travel 保留 | 30 日（Free 7 日） | bookmark 有（`d1-store-audit` §5.1） | — |

來源：`developers.cloudflare.com/workers/platform/pricing`（10M 請求、30M CPU ms、CPU/invocation 預設 30s／上限 5min）、
`…/workers/platform/limits`、`…/workers/observability/logs/workers-logs`（已包，Paid 20M events／月、保留 7 日，
且**每次 invocation 都帶 CPU time＋wall time**）、`…/d1/platform/pricing`（25B read／50M write／5GB／1000 queries）、
`…/d1/platform/limits`、`…/d1/platform/release-notes`、`…/d1/best-practices/read-replication`（replica 唔另收費，要用 Sessions API）。

**所以「效率」喺呢個系統度已經唔係賬單**（讀 2%、存 0.3%、請求 5%）：唯一有壓力嘅係
**rows written 60%**。CPU 亦已經量到（**21%**），證實**唔係**第二個天花板 —— 呢點之前只係假設。
其餘全部係上游 API 同 latency。

## 3. 槓桿 1（最大）：pair lane 為一個 fleet 已知嘅 429 付間距

**證據（§1 嘅 tick 表）**
- 批次 lane 真跑嘅 tick：`poolLegMs.pairs` **1,221–1,771ms**，而佢交回嘅地址係 `pairs − pairsJup`
  ＝ tick A **42/199（21%）**、tick B **0/200**。同一時間 Jupiter fallback 用 **458–631ms** 交回其餘。
- `dex429` ring 已經**爆滿 50／小時**（總數 26,113）；2026-10-16 已落地嘅寫入係
  `pairRefusedAt` 上 fleet row（`worker_state dex_spacing`）＋ `PAIR_PROBE_INLINE_WAIT_MS 400` 嘅**探針**延遲。

**量度結果（2026-10-16 05:30–05:33Z，先量後改）**

1. **fleet block 其實已經覆蓋成條 lane**（原本嘅假設唔成立）。block 窗口內嘅 tick 讀
   `blockedForMs 25,040` 配 `poolLegMs.pairs 0`、`pairs 199 / pairsJup 199` —— lane 一個請求都冇出，
   Jupiter 頂晒。所以「只有探針採用 block」唔係實況，嗰度唔使改。
2. **真正嘅殘餘成本係 spacing，唔係 block**。實況讀數：`blockedForMs 0`（fleet refusal
   `pairFleetRefusedAgeMs 97,138`，即 block 已過期）但 `spacingFleetSteps 3`、`intervalMs 1,200`
   —— 而個 tick 已經 serve 過（`probeDue false`），所以 lane 當自己「working」⇒ **inline** 派，
   第一 batch 喺間距隊等足 **1,024ms**，即係實測嘅 `poolLegMs.pairs 1,221–1,771ms`（tick 2,727–3,272ms）。
   兩個壽命唔同：block 決定「出唔出得街」，spacing 決定「要等幾久先出得街」。

**為何唔係「直接砍走條 lane」**
DexScreener 係 mcap／liquidity 閘嘅**校準來源**（`comparableLiquidity`／`gateLiquidityUsd`：
Jupiter 嘅 liquidity 讀數係同一個池嘅另一個 metric，約一半，**唔可以**判 DexScreener 校準過嘅地板）。
砍走條 lane ＝ 更少幣有可比讀數 ＝ 更少 gate 判得成。所以正確形狀係
**「被封時唔好付排隊成本」**，唔係「唔要條 lane」。

**已落地（`src/dexscreener.ts`）**

節點係 **refusal episode 本身**，唔係「探針」：新增 `inRefusalEpisode()`
（＝ `probeDue()` **或** `spacing.growthSteps > 0`），延遲條件由「只限探針」改成「整個 episode」——
只要 lane 仲喺 episode（被拒未復原，或者嗰次拒絕買落嘅 spacing 未回落），而佢嘅隊 slot 遠過
`PAIR_PROBE_INLINE_WAIT_MS 400`，就交去 invocation 嘅 `waitUntil`，唔喺 tick 嘅 critical path 等。
請求本身一個都冇少：佢照舊喺隊自己嘅 slot 出，照舊落 pair cache 俾下一個 tick 用。
計數分開——`probeDeferrals` ＝ episode 嘅**第一**次嘗試、`episodeDeferrals` ＝ 其餘；
`/health` 嘅 `summary.dex` 自動帶埋兩個新欄（`getStats()` 原樣序列化）。
**fleet block 覆蓋成條 lane 嘅不變量照舊保留**（`if (Date.now() < this.batchBlockedUntil) return result;`），
所以「每個 backoff 窗口最多一個探針」冇變。健康 lane（無 refusal、無 raise）完全唔變。

**驗收（deploy 後讀）**

1. `summary.dex.episodeDeferrals` 開始上升（之前永遠 0），配 `spacingSteps > 0` 嘅 tick 嘅
   `poolLegMs.pairs` 貼近 0；
2. `pairs` 總數唔跌（`pairsJup` 照樣頂）、`pairsMissing` 唔升；
3. `dex429` 速率唔升 —— 延遲咗嘅 pass 一樣會出一個請求，只係唔喺 critical path 等佢；
4. `lastScanMs` 喺 episode tick 回落 ~1s。

**Revert**：`inRefusalEpisode()` 改返 `probeDue()`（一個 token）。

**測試**（`scripts/test-unit.js`，兩個新測試，全部 pass）

- `the fleet's block silences the WHOLE lane — one probe per backoff window, not per tick`
  （釘住 §3 上面嘅不變量：block 窗內零請求、零 hand-off、零 deferral）；
- `the rest of a refusal episode is dispatched off the pair phase too`
  （釘住新行為，同埋 `episodeDeferrals` 升而 `probeDeferrals` 唔升）。
- Mutation 實測（把條件改返 `this.probeDue()`、重 build）：
  `❌ … an episode pass must not wait the raised gap inline (waited 1024ms)` → `552 passed, 1 failed`。
  即係個測試真係捉得到（唔係自我安慰）。

### §3 修正（2026-10-16 06:0xZ：deploy 後量到唔達標，已再落地）

第一次 deploy（commit `956dd03`，run 38858553715 全 success）之後嘅實測：
block 覆蓋成條 lane 嘅不變量**冇問題**（3/3 blocked tick 讀 `pairsLeg 0`），
但 `episodeDeferrals` 由 0 只升到 **1**，而 **6 個 episode tick 之中 5 個**照樣付
`pairsLeg 1,384–2,000ms`（該 tick 總數 1,813–4,932ms）。**即係唔達標。**

**原因**：gate 讀嘅係「隊嘅下一個 slot」。scan 嘅 pair phase 同上一 tick 相隔 ~30s，隊係**空**嘅，
`nextSlotAt()` 答「即係」，所以 gate 讀成「平」⇒ inline 派。真正成本係**批次之間嘅 spacing**
（4–7 個 batch × 400–1,200ms），唔係第一個請求嘅等待 —— 「第一個 slot」呢個讀數結構上睇唔到。

**修正**：預算改成**兩半之中較大者** —— 第一 slot 嘅等待，同 pass 自己嘅 pacing
（`batches × intervalMs ÷ PAIR_BATCH_CONCURRENCY`）；常數改名 `PAIR_INLINE_WAIT_BUDGET_MS`
（一次涵蓋兩半）。單一個 30 地址 batch 喺空隊仍然 inline（真係平）；~200 地址嘅 rotation 永遠唔平。
計數語意不變：`probeDeferrals` ＝ episode 第一次嘗試、`episodeDeferrals` ＝ 其餘。

**再驗收**：同 §3 上面一樣，但今次係「6 個 episode tick 之中 0 個」付 `pairsLeg > 400ms`。
**測試**：新增 `an idle queue still defers an episodic pass the ROTATION makes long`；
Mutation（把 `inlineWaitMs` 改返 `queueWaitMs`、重 build）：
`❌ … a 4-batch pass must not be waited on inline (waited 1201ms)` → `553 passed, 1 failed`。

## 4. 槓桿 2 —— **已做（2026-10-16）**：CPU 有讀數，月用量 27–46%，唔係天花板

原本 repo **冇任何 CPU 讀數** —— `ms`、`dbMs`、`poolLegMs` 全部係 wall clock，而 wall clock 有大量 I/O 等待，
唔可以用嚟判「係唔係 CPU 樽頸」。

### §4a 預算讀數（GraphQL，唔使開 Workers Logs）

**讀嘅方法（零 code，而且唔使開 Workers Logs）**：`scripts/cf-invocations.mjs` 本身已經用 deploy workflow 嘅 token
讀 Cloudflare GraphQL `workersInvocationsAdaptive`，而個 dataset 一直都有
`quantiles { cpuTimeP50 cpuTimeP99 }` 同 `max { cpuTime wallTime memoryUsageBytes }` ——
即係「讀 P50/P99 CPU」呢一步**由頭到尾都唔需要 Workers Logs**，一個 invocations 前就讀得到。
（Workers Logs 另加嘅係 **per-invocation** 記錄 —— 邊個 invocation 燒嘅 CPU —— 同 log 行本身。）

**實測（2026-10-16 00:43:40–06:43:40Z，6h，`HOURS=6 node scripts/cf-invocations.mjs`）**

| 讀數 | 值 |
|---|---|
| invocations | **4,448**（361 分鐘，平均 **12.32／分鐘** → **17,792／日 → 0.53M／月**） |
| status | 全部 `success`，**0** 個非 `success` |
| subrequests／invocation（平均） | **2.2**（對 1,000 額度零壓力） |
| `cpuTimeP50`（典型分鐘） | **5,922µs** |
| `max.cpuTime` 每分鐘 | p50 **74.6ms**、mean **79.1ms**、p90 **117.4ms**、max **188.8ms** |
| 推算月用量 | **6.31M ms ＝ 30M 嘅 21%**（唔係逼近） |

**⚠️ 同時修正兩個喺呢份文件入面嘅錯數（原本兩條都錯）**

1. **invocation 數唔係每日 6,048。** 原本只數 cron（2,880 scan ＋ 2,880 pass ＋ 288 maint），
   但 `/health` 輪詢、Telegram webhook、debug 頁**全部**都係 invocation：實測 **17,792／日 ＝ 6,048 嘅 2.9×**。
   所以 §2 嘅請求餘裕由 ~55× 修正為 **18.7×**（0.53M 對 10M）。
2. **break-even 唔係 165ms 而係 56ms。** 30,000,000 ÷ 533,760 ≈ **56ms／invocation**。
   「165ms」係用一個細 2.9× 嘅分母算出嚟嘅，把風險睇細咗。用返真分母，**實測仍然只係 21%**，
   所以結論冇變 —— 但「有 4.8× 餘裕」而家係**量出嚟**，唔再係算術。（**但見 §4c**：
   6.31M 等於攞一個「每分鐘分位數」乘 invocation 數，而同一個窗口逐分鐘對照顯示嗰個 `cpuTimeP50`
   實際落喺同一分鐘自己嗰批記錄嘅 **~p85**；逐個 invocation 直接量到嘅係 mean 17.75ms ⇒ **32%**
   （38% 用 calculations 視圖 21.39ms），所以「4.8×」要收窄做 **2.6–3.2×**。）

### §4b per-invocation 讀數（Workers Logs）—— 邊個 invocation 燒嘅 CPU

**已 deploy**：`wrangler.toml` 嘅 `[observability] enabled = true` ＋ `head_sampling_rate = 1`
（純 config：冇 binding、冇 var、冇改一行 source）已經隨 commit `44491b4` 經 deploy run **38868524921**
（success）上線 —— 唔再係「等下一次 deploy」。新版本實際上線係 **07:40:49Z**（`Deployed
solana-meme-bot triggers`，Version ID `a9311571`），而 Workers Logs 第一批記錄係 **07:41:06Z**，
即係開關真係喺呢一日呢一秒開始入庫。
dashboard 開（Workers & Pages → 本 Worker → Settings → Observability → Workers Logs）等效。
deploy 前嘅驗證：`npx wrangler deploy --dry-run` 綠燈；mutation 檢查（把 `head_sampling_rate`
改成字串）→ `Expected "observability.head_sampling_rate" to be of type number`，
證明 wrangler **真係識呢個 key**（唔係靜靜忽略）。

**讀嘅方法（新）**：`scripts/cf-worker-logs.mjs` ＋ workflow `cf-worker-logs.yml` —— 打 Cloudflare
Workers Observability query API（`POST /accounts/{id}/workers/observability/telemetry/query`），
`view: "invocations"` 攞 per-invocation 記錄（`$workers.cpuTimeMs`／`wallTimeMs` ＋ `eventType`／
`outcome`／`$metadata.trigger`），再用 `view: "calculations"` 攞**唔受 limit 限制**嘅
count／min／median／avg／max／p90／p99。同 `cf-invocations.mjs` 一樣用 deploy workflow 嘅 token，
所以答案喺 run log 度讀（`gh run view --log`），唔需要 dashboard。

**實測（run 38869664557，窗口 06:49:43–07:49:43Z）**：入庫由 07:41:06Z 起，即係 60 分鐘嘅窗口裡
只有 **~8 分鐘**有資料 —— **101 個 invocation group**（其中 **100 個**帶 `$workers.cpuTimeMs`）。

| 讀數 | 值 |
|---|---|
| 計數（calculations；樣本 interval **1.21** ⇒ 連 Workers Logs 都抽樣，數字係估計） | **n ≈ 103** |
| min ／ median ／ avg | **1 ／ 15 ／ 25.76 ms** |
| p90 ／ p99 ／ max | **70 ／ 131 ／ 133 ms** |
| 推算月用量（avg × 533,760） | 13.7M ms ＝ 46% —— **8 分鐘窗口，已被 §4c 嘅 33 分鐘複讀取代** |
| 推算月用量（median × 533,760） | 8.0M ms ＝ 27% —— 同上 |

**邊個 invocation 貴**：頭 15 名**全部**係 `fetch`、`outcome ok`、trigger `POST /internal/cron-relay`
（即 tick 本體），cpu **133／131／112／112／111ms**，wall 1,697–3,238ms。按 eventType 分：

| eventType | n | mean cpuMs | max cpuMs |
|---|---|---|---|
| `fetch`（relay ＝ tick 本體） | 80 | 29.3 | 133 |
| `alarm` | 5 | 2.2 | 3 |
| `scheduled`（只係派一個 self-fetch） | 15 | **0.1** | 1 |

**三件新事實**

1. **貴嘅係 relay 嗰個 fetch，唔係 cron entry。** 15 個 `scheduled` 平均 **0.1ms** CPU，wall 卻
   945–1,881ms —— 個 entry 只係派一個 self-fetch，真成本喺 relay 嗰邊（同 `wrangler.toml` 頂部
   嘅 relay routing 一致）。
2. **spike 睇得到。** 月總量嘅讀數（§4a）睇唔到單一 invocation：呢個窗口 max **133ms**、p99 131ms。
   §4a 嘅每分鐘 `max.cpuTime`（p50 74.6ms、max 188.8ms）同呢度一致 —— 兩個 dataset 對**尾部**
   冇分歧。
3. **峰值一致、中間唔一致 —— 而且成因查清咗（§4c），唔係「21% 樂觀」咁簡單。** 同一個窗口逐分鐘對照：
   兩邊嘅每分鐘 max **33 分鐘之中 30 分鐘一模一樣**（即係睇到同一批 invocation），但 GraphQL 每分鐘
   `cpuTimeP50` 喺**同一分鐘自己嗰批記錄裡面嘅百分位**中位數係 **84.6%** —— 即係 Cloudflare 個「P50」
   實際上係嗰分鐘嘅 **~p85**，唔係中位數。所以 §4a 嘅 21%（＝ 11.8ms／invocation）係一個分位數乘 invocation 數，
   唔可以直接用；逐個 invocation 量到嘅係 mean **17.48ms**。
   （獨立交叉檢查：呢個窗口 **475 個 group／~36 分鐘 ≈ 13.2／分鐘**，對 §4a 嘅 **12.32／分鐘** ——
   兩個 dataset 對 invocation 速率一致，即係 0.53M／月 呢個分母冇問題。）

**複讀（36 分鐘窗口）**：同一支探針再 push（run `38872589328`，窗口 07:16:35–08:16:35Z；
Workers Logs 由 07:41:06 起入庫 ⇒ 有數據嘅係 **~36 分鐘**）—— 475 個 group（469 個帶
`$workers.cpuTimeMs`），逐個 invocation **mean 17.75ms／median 6ms／p90 53ms／max 140ms**；
calculations 視圖（n=403、sampleInterval 1.05）**median 10／avg 21.39／p90 56／p99 119／max 140 ms**；
按 eventType：`fetch` **338**（mean 24.3、max 140）、`alarm` **57**（1.5）、`scheduled` **74**（0.2）。
**即係第一次 8 分鐘嘅 25.8ms 係最貴嗰一端**（deploy 之後幾分鐘最貴），窗口一長就回落 —— 所以
<30 分鐘嘅窗口唔應該用嚟外推月總量。

**限制**：窗口只有 **~33 分鐘**（Workers Logs 由 deploy 那一刻才入庫）—— 未跨 deploy／cold start，
亦未覆蓋重腳（Axiom／Birdeye backfill）。要一個跨整日嘅讀數，就係再 push 一次 `cf-worker-logs.yml`
（path-scoped push 係 run 掣 —— read-only token 唔可以 `workflow_dispatch`，會 403
`Resource not accessible by integration`）。

### §4c 兩個 dataset 差 2.2× —— 已查清：`cpuTimeP50` 係 ~p85，唔係中位數

**做法**：同一支探針、同一次 run 問兩個 dataset 同一個窗口 —— Workers Logs（`view: "invocations"`，逐個
invocation 記錄）同 GraphQL `workersInvocationsAdaptive`（每分鐘一列：`quantiles.cpuTimeP50/P99`、
`max.cpuTime`、`sum.requests`），然後**逐分鐘 join**。兩邊都有數據嘅係 **36 分鐘**（GraphQL 另外 25 分鐘
係 deploy 之前，冇 per-invocation 記錄可以比）。

**三個讀數**

1. **兩邊對「峰值」完全一致。** GraphQL 每分鐘 `max.cpuTime` 同 Workers Logs 同一分鐘嘅 max，
   喺 **36 分鐘之中 33 分鐘一模一樣**（±1ms 內；112.44／112、133.75／133、140.69／140、81.06／81 …；
   3 分鐘唔對，係跨分鐘邊界 —— 07:59、08:01、同窗口最後一分鐘）。
   單位唔同（GraphQL 係 **µs**、Logs 係 **ms**），換返 ms 就對得上 ⇒ 兩個 dataset 睇到嘅係**同一批
   invocation、同一個 CPU 量**，唔係「一個計多一個計少」。
2. **分歧喺「中間」，而且方向同原先嘅假設相反。** Cloudflare 每分鐘 `cpuTimeP50` 喺**同一分鐘自己嗰批
   per-invocation 值裡面嘅百分位**：中位數 **84.6%**（最低 50%、最高 100%），當中 **1 分鐘佢等於該分鐘嘅 max**。
   即係**「P50」實際上係嗰分鐘嘅 ~p85**：36 分鐘 join 嘅每分鐘 P50 係 **中位 30.25ms／平均 29.45ms**，
   而同一批分鐘逐個 invocation 係 **median 6ms／mean 17.75ms** ⇒ 即係 **5.0× median、1.7× mean**，
   而且**偏高**（唔係原先以為嘅偏低）。抽 7 分鐘睇（完整 36 行喺 run log）：

   | minute (UTC) | gql requests | gql cpuP50 | logs n | logs median | logs p75 | logs p90 | logs max | P50 落喺 Logs 嘅 |
   |---|---|---|---|---|---|---|---|---|
   | 07:41 | 12 | **53.39** | 12 | 20 | 34 | 70 | 112 | 83% |
   | 07:44 | 11 | **26.87** | 11 | 20 | 54 | 75 | 112 | 64% |
   | 07:55 | 13 | **11.84** | 17 | 3 | 11 | 58 | 105 | 76% |
   | 08:02 | 12 | 48.05 | 14 | 4.5 | 16 | 44 | 48 | **100%（＝該分鐘 max）** |
   | 08:08 | 9 | **17.05** | 12 | 3 | 9 | 17 | 45 | 92% |
   | 08:12 | 12 | **48.05** | 15 | 16 | 31 | 48 | 61 | 93% |
   | 08:15 | 13 | **27.3** | 16 | 6 | 18 | 52 | 114 | 81% |

3. **所以 §4a 嘅 21% 要退役。** 6.31M／月 → 11.8ms／invocation 係攞一個「每分鐘分位數」乘 invocation 數；
   同一個窗口直接量到嘅逐個 invocation 統計係 mean **17.75ms**（calculations 視圖 **21.39ms**）／
   median **6ms**（視圖 10ms）／p90 **53ms**（視圖 56ms）／max **140ms**。乘返 533,760：
   **mean ⇒ 9.47M ms／月 ＝ 32%**、**calculations avg ⇒ 11.4M ＝ 38%**、median ⇒ 3.2M ＝ 11%（視圖 10ms ⇒ 18%）。
   **結論方向唔變**（CPU 離天花板仍遠），但餘裕係 **2.6–3.2×**，唔係 4.8×，亦唔係第一次讀到嘅 46%。

**Cloudflare 官方文件解答唔到呢件事**：`workersInvocationsAdaptive` 係 adaptive-sampled dataset
（官方只講 quantiles 係估算、CPU 分位數用 reservoir sampling），**冇任何文檔**講佢點加權、或者點解
讀出嚟似 p85 而唔係 median；亦冇文檔講 Workers Logs 嘅 `sampleInterval`（呢次 1.03）嘅抽樣同 CPU 有冇關係。
所以上面嘅結論係**實測**（可重複：再 push 一次 `cf-worker-logs.mjs` 就再量一次），唔係引用官方定義。

**仍然未解釋（呢個窗口分唔開）**：GraphQL 每分鐘 P50 嘅**水平**喺窗口內亦變過 —— 07:41 之前中位 ~12ms，
之後 33 分鐘 ~30ms。個 step 啱啱就喺 deploy 前後，兩個可能：tick 負載真係重咗，或者**開 Workers Logs
本身要 CPU**（每次寫 log 都要序列化／送出）。用現有數據**分唔開**（deploy 之前冇 per-invocation 記錄）；
要分開就要一個冇 deploy 嘅長窗口複讀。

**成本上限（不變）**：57 個 `console.log` 站點 × 0.53M invocation ＝ 病態情況 ~30M events／月
（超 20M 額度），實況 tick 只出幾行、health poll 更少，即 ~1–2M／月；`head_sampling_rate` 就係旋鈕。
（官方講 Workers Logs 由 **2026-12-01** 起轉去 Observability 定價，到時要重睇。）

## 5. 槓桿 3：cadence 嘅真天花板係 `rows written`（唔係 tick 預算）

**先排除兩個其實唔係天花板嘅嘢**（今日實測）：
- **tick 預算**：獲批 race 窗口 **15,443ms**（`SCAN_TICK_BUDGET_MS 20,000 − SCAN_FLUSH_RESERVE_MS 4,500 − preRace`），
  而 tick 實際用 **1,446–3,272ms**。
- **clock 週期**：`tickMs 30,000` 而 `lastWorkMs 2,340` —— 每個週期有 ~27.7s 空置。
- **subrequest／queries**：`subs 18–26`、`dbStmts 18–31`，對 10,000／1,000 嘅額度係零壓力。

**真正嘅天花板：`rows written`。** 一個 tick 嘅固定寫入（heartbeat、scan_history、worker_state、
token_stats sweep）大致同 tick 數成正比，所以：

| clock 週期 | scans／日 | rows written／日 | ／月 | 對 50M 額度 | 超額 |
|---|---|---|---|---|---|
| **30s（今日）** | 2,880 | 1.00M（實測） | 30.1M | **60%** | — |
| 20s | 4,320 | ~1.50M（×1.5 上界） | 45.1M | **90%** | — |
| 15s | 5,760 | ~2.01M（×2.0 上界） | 60.2M | **120%** | ~10.2M → **≈$10／月** |

（線性推算係**上界**：push 相關嘅寫入跟卡片數，唔跟 cadence。注意方向嘅**來源唔係**「每 tick 固定寫入」
—— 佢只佔 ~0.9%，裁咗都換唔到 cadence —— 而係**同一批 token 被抽樣多咗 → 被觀察到嘅變化多咗**。
所以要真係加 cadence 之前，必須逐 table 按 **row** 量清楚，唔可以只靠呢個上界。）

**結論**：想要 20s 就要先**裁剪每 tick 寫入**，但**唔可以按 KB 揀** —— 額度數嘅係 row，
所以 `scan_heartbeat` 14.6KB 同 `tick_leg_slow` 12.6KB 兩個大細差幾倍，實際各佔 **1 row／tick**；
佢哋加 `scan_history` 合共 ~3 row／tick（~8.6K／日 ＝ 1.00M 嘅 **0.9%**）—— 裁呢三條換唔到 cadence。
真正跟 cadence 走嘅係**每次觀察而寫嘅 token 行**：抽樣密啲，同一個 token 就會**被睇到多啲次變化**，
即係寫入量跟嘅係「覆蓋 × 頻率」，唔係「tick 數」。呢部分要逐 table 按 **row** 量（§8 已記低未做）。

`idx_pool_band_m48000 ON token_stats(launch_ms) WHERE (max_mcap_observed IS NULL OR max_mcap_observed >= 48000)`
係一個**乘數**而唔係一個獨立來源：凡 UPDATE 一條喺 band 內（或 `max_mcap_observed` 仍係 NULL）嘅
`token_stats` row，SQLite 都會**順手重寫佢條 index entry**，所以嗰啲 update 嘅 row 成本 **×2**。
band 只會隨時間填滿（`max_mcap_observed` 單調上升，過咗 48,000 就唔會出返去），
即係呢個乘數作用喺「update **次數**」之上，唔係每個 tick 一次。

想要 15s 就係**用錢買**（≈$10／月超額，見上表），要明講。

## 6. 檢查過、但**唔改**（連理由）

- **D1 read replication**：$5 plan 已包（replica 唔另收 storage／compute），但要用 Sessions API 做
  read-your-writes；本 Worker 由構造決定係 read-after-write（單飛鎖、`seen_tokens` 防重推、tracker CAS）。
  喺 placement 已經釘喺 primary 隔籬（`select1 12ms`）之下，開佢只有風險冇收益。**維持 disabled。**
- **把 scan 搬入 Durable Object（location hint）**：relay 已經令 tick 跑喺 DFW 隔籬（`db-latency` 11–12ms 就係證據），
  多出嘅只係一個 ~30ms 嘅 self-fetch。唔值。
- **砍 index 減寫入**：`token_stats` 三個 index（`idx_token_stats_first_seen`、`idx_token_stats_launch`、
  partial `idx_pool_band_m48000`）**全部都有查詢用到**（`src/db.ts` 588／2635／2639／2965／2984／6367），
  冇一個係死嘅。要減就要改查詢，唔係刪 index。
- **加大存儲／搬更大 DB**：15.7MB／5GB ＝ 0.3%。冇需要。
- **`crime_wallets_list` 216KB row**：`CRIME_WALLETS_ENABLED = "false"` 之後客戶端唔會建、唔會讀，
  即係一個陳舊嘅 216KB row。**唔算效率問題**，但屬於可以順手清走嘅死重量（要清就係一次 DELETE）。
- **Time Travel 還原演練**：係可靠性（不是效率），喺 `d1-store-audit` §5.1 已經記低未做。

## 7. 建議次序

1. ~~開 Workers Logs，讀 P50/P99 CPU ms／invocation，對 165ms break-even~~ **已做（§4）**：
   CPU ＝ 6.3M ms／月 ＝ **21%**；`wrangler.toml` 已開 `[observability]`（未 deploy）；
   break-even 由 165ms 修正為 **56ms**（分母本身錯咗 2.9×）。
2. ~~量 pair lane~~ **已做（§3）**：量度顯示 block 已經覆蓋成條 lane，真正成本係 spacing 喺 critical path 白等；
   已改成整個 refusal episode 都 off-path（`inRefusalEpisode()`）。驗收讀數見 §3。
3. **先有 (1)(2) 嘅讀數，才決定 cadence**：20s 睇 §5 嘅 90%，15s 明碼 ≈$10／月。
4. **若果要 20s**：先做 §5 嘅每 tick 寫入裁剪，再用 `/debug/clock` 嘅 `lastWorkMs` + `rows_written_24h` 覆核。
5. （獨立）Time Travel 還原演練；清走陳舊嘅 `crime_wallets_list`。

## 8. 限制（唔可以當過）

- 樣本細：`tick-legs` 3 個 tick，`db-latency` 每個 op 3 個 sample。
- ~~CPU 未量到~~ **已量（§4）：21%**，但有兩個限制不可以當「CPU 完全冇問題」——(a) 係**一個 6h 窗口一個 sample**，
  未跨越一次 deploy／cold-start 週期，亦未覆蓋 Axiom／Birdeye backfill 嘅間歇重腳；
  (b) `max.cpuTime` 去到 **188.8ms**，即係**個別 tick 可以遠高過平均**，所以 21% 係「月總量」嘅讀數，
  唔係「每個 tick 都有 4.8× 餘裕」。
- §4 嗰個 reading 全部嚟自 **GraphQL**（唔係 Workers Logs）——`[observability]` 已寫入 `wrangler.toml` 但**未 deploy**，
  per-invocation CPU 要等下次 deploy 之後才讀得到。
- `rows_written` 係 **row 數**、而且包含 index entry：所以 (a) **byte 大細唔等於 row 數**
  （14.6KB 嘅 row 同 40 bytes 嘅 row 都係 1 row，所以「邊個 payload 最大」唔可以用嚟排裁剪次序），
  同 (b)「邊個 table 佔幾多」唔可以精確歸因；`writeCensus` 係 **per-isolate**
  （§1 嗰個 isolate 睇到 541 rows／h，而 fleet 係 ~41,783 rows／h），唔可以當 fleet 度量。
- §5 嘅 cadence 推算係**線性上界**，而個上界嘅**機制本身未經量度**。此處原本寫「假設每 tick 固定寫入佔主體」
  —— 呢句**係錯嘅**（經查固定寫入只佔 ~0.9%），已喺 §5 更正；要真正判 20s 可唔可行，必須逐 table 按 **row** 量一次。
- §3 嘅診斷係**假設**，未用 `pairFleetRefusedAgeMs`／`probeDeferrals` 證實；證實之前唔應改 code。
- 呢份文件 §1–§2 係評估讀數；**§3 嘅改動已落地**（`src/dexscreener.ts` ＋ 兩個 `scripts/test-unit.js` 測試），
  跑過 `npm run typecheck`（0）同 `npm run test:unit`（全部 suite 0 failed，`test-unit` 553 passed）。
- §3 嘅驗收（1–4）係 **deploy 之後** 才量得到：dev 環境冇 Workers 嘅 `waitUntil`、冇 DexScreener 429，
  所以「episodeDeferrals 開始升、scanMs 回落 ~1s」係 live 讀數，唔係今次跑得到嘅檢查。
