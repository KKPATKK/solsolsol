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
| 2 | **CPU 讀數**（Workers Logs，$5 plan 已包） | repo **完全冇** CPU 讀數；`ms`／`dbMs` 都係 wall clock | **高、零 code** | 低 |
| 3 | **cadence 天花板 = `rows written`**（唔係 tick 預算、唔係 subrequest） | 30s ＝ 30.1M/月（**60%** 額度）；20s ≈ 90%；15s ≈ 120%（≈$10/月） | 高（決策輸入） | 低（純算術） |
| 4 | **寫入裁剪**（只為換 cadence 而做） | 每個 tick 固定寫：`scan_heartbeat` 14.6KB、`tick_leg_slow` 12.6KB、`scan_history` 1 行、`token_stats` 更新 × partial index predicate | 中（係 #3 嘅前置） | 中 |
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
| Workers 請求 | 10M／月 | §1 每日約 6.0K 個 invocation（2,880 scan ＋ 2,880 pass ＋ 288 maint）→ ~0.18M／月 | ~55× |
| CPU 時間 | **30M CPU ms／月**（每次 HTTP invocation 預設 30s，可調到 5 min；cron／queue 15 min） | **未量到**（見 §4） | ? |
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

**所以「效率」喺呢個系統度已經唔係賬單**（讀 2%、存 0.3%、請求 2%）：唯一有壓力嘅係
**rows written 60%**，而同佢一齊係**未量到嘅 CPU**。其餘全部係上游 API 同 latency。

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

## 4. 槓桿 2（零 code、最高性價比）：補上 CPU 讀數

今日 repo **冇任何 CPU 讀數** —— `ms`、`dbMs`、`poolLegMs` 全部係 wall clock，而 wall clock 有大量 I/O 等待，
唔可以用嚟判「係唔係 CPU 樽頸」。

**$5 plan 已經包咗答案**：Workers Logs（Paid 20M log events／月、保留 7 日）嘅 invocation log 帶
**CPU time ＋ wall time**；metrics 儀表板亦有 **CPU Time per execution** 嘅歷史 quantile。
喺 dashboard 開 Workers Logs（同埋 observability）就讀得到，**唔需要改一行 code**。
（注意：官方講 Workers Logs 由 **2026-12-01** 起轉去 Observability 定價。）

**為何要量**：額度係 30M CPU ms／月，而每日約 6,048 個 invocation ⇒
**break-even ＝ 30,000,000 ÷ 30 ÷ 6,048 ≈ 165ms CPU／invocation（平均）**。
即係「每個 invocation 平均燒幾多 CPU」直接決定 30M 夠唔夠。若果 P50/P99 遠低過 165ms，CPU 唔係樽頸；
若果接近，就係 cadence（§5）之前必須先解決嘅第二個天花板。**未量到之前，唔可以講 CPU 有餘裕。**

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

（線性推算係**上界**：push 相關嘅寫入係跟卡片數，唔跟 cadence；但每 tick 固定嘅寫入係主體，所以方向啱。）

**結論**：想要 20s 就要先**裁剪每 tick 固定寫入**（候選：`scan_heartbeat` 14.6KB ＋ `tick_leg_slow` 12.6KB
每 tick 一寫、`scan_history` 一行、以及 `token_stats` 更新被
`idx_pool_band_m48000 ON token_stats(launch_ms) WHERE (max_mcap_observed IS NULL OR max_mcap_observed >= 48000)`
嘅 **predicate** 放大 —— 每次 `max_mcap_observed` 跨過 48,000 都會重寫條 index entry）；
想要 15s 就係**用錢買**（≈$10／月超額），要明講。

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

1. **開 Workers Logs**（dashboard；零 code），讀 P50/P99 CPU ms／invocation，對 165ms break-even。
2. ~~量 pair lane~~ **已做（§3）**：量度顯示 block 已經覆蓋成條 lane，真正成本係 spacing 喺 critical path 白等；
   已改成整個 refusal episode 都 off-path（`inRefusalEpisode()`）。驗收讀數見 §3。
3. **先有 (1)(2) 嘅讀數，才決定 cadence**：20s 睇 §5 嘅 90%，15s 明碼 ≈$10／月。
4. **若果要 20s**：先做 §5 嘅每 tick 寫入裁剪，再用 `/debug/clock` 嘅 `lastWorkMs` + `rows_written_24h` 覆核。
5. （獨立）Time Travel 還原演練；清走陳舊嘅 `crime_wallets_list`。

## 8. 限制（唔可以當過）

- 樣本細：`tick-legs` 3 個 tick，`db-latency` 每個 op 3 個 sample。
- **CPU 未量到**：§2 同 §4 嘅 CPU 全部係額度＋算術，唔係讀數；喺開 Workers Logs 之前唔可以講「CPU 有餘裕」。
- `rows_written` 包含 index entry，所以「邊個 table 佔幾多」唔可以精確歸因；`writeCensus` 係 **per-isolate**
  （§1 嗰個 isolate 睇到 541 rows／h，而 fleet 係 ~41,783 rows／h），唔可以當 fleet 度量。
- §5 嘅 cadence 推算係**線性上界**：假設每 tick 固定寫入佔主體，未逐項拆分。
- §3 嘅診斷係**假設**，未用 `pairFleetRefusedAgeMs`／`probeDeferrals` 證實；證實之前唔應改 code。
- 呢份文件 §1–§2 係評估讀數；**§3 嘅改動已落地**（`src/dexscreener.ts` ＋ 兩個 `scripts/test-unit.js` 測試），
  跑過 `npm run typecheck`（0）同 `npm run test:unit`（全部 suite 0 failed，`test-unit` 553 passed）。
- §3 嘅驗收（1–4）係 **deploy 之後** 才量得到：dev 環境冇 Workers 嘅 `waitUntil`、冇 DexScreener 429，
  所以「episodeDeferrals 開始升、scanMs 回落 ~1s」係 live 讀數，唔係今次跑得到嘅檢查。
