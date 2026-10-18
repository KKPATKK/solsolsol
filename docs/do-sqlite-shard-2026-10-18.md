# 2026-10-18 DO SQLite 分流：可唔可以做、值唔值得做（量到才講）

問題：可唔可以用 Durable Object 嘅 SQLite storage 幫 D1 分流（把部分表／寫入搬去 DO）？
呢份文件只答「可唔可以」同「值唔值」，**冇改任何 code、冇 deploy**。全部數字係 2026-10-18
00:0x–00:2xZ 現讀，DO 嘅價格／限額係同日照 Cloudflare 文件核對（§2）。

## 0. 結論

| 問題 | 答案 |
|---|---|
| 技術上做唔做到？ | **做到**。repo 已經有一個 SQLite-backed DO（`TickClock`，`new_sqlite_classes` v1），DO SQLite 2025-04-07 GA，`ctx.storage.sql` 係 in-process 同步 SQL。 |
| 值唔值得今日做？ | **唔值得**。D1 寫入用咗 **29.9%**（§1），分流兩邊都仍然喺 included 額度內，省唔到錢；延遲亦唔會因為 DO 而自動變快（cron path 唔受 placement 管，§4C）。 |
| 幾時值得？ | D1 rows written 過 **~35M/月**，或者要跑 20s cadence 而又唔想付 $1/M overage。 |
| 要分就分邊張表？ | 只有 append-only telemetry（`scan_history` + `tick_legs`）低風險，但只佔 **1.7%**。高量嘅 `token_stats`（57.7%）／`push_watch`（24.1%）／`worker_state`（16.4%）全部綁住跨表不變量。 |
| 最乾淨嘅版本？ | 唔係「分流」，而係「**成個 store 搬入一個 DO**」——15.8MB vs 10GB 上限，技術上可行，但收益只係多一個 50M 額度，兼要自己補 tooling。 |

一句：**呢個唔係「可唔可以做」嘅問題，係「分完之後賺咩」嘅問題；今日嘅答案係賺唔到。**

## 1. 今日量到嘅讀數

### 1.1 D1 每日用量（`scripts/cf-d1-usage.mjs`，DAYS=4）

```
| day        | rows written | rows read  |
| 2026-10-15 |      907,385 | 11,458,230 |   ← 切換日，偏高
| 2026-10-16 |      492,691 | 18,633,756 |
| 2026-10-17 |      498,490 | 22,523,339 |
| 2026-10-18 |        6,563 |    232,244 |   ← 未完結
```

最後一個完整日（10-17）：**498,490 written → 29.9%/月**（50M allowance）；
read 22.5M → **2.7%/月**（25B）。即係寫入仲有 **3.3×** 餘裕。

### 1.2 寫入係邊張表（`/health.writeCensus`，per-isolate 窗口 9,618,323ms ≈ 2.67h，22 ticks）

| key | rows | 佔比 | 每 tick |
|---|---:|---:|---:|
| `delete token_stats`（prune） | 614 | 24.2% | 27.9 |
| `update push_watch` | 613 | 24.1% | 27.9 |
| `update token_stats` | 484 | 19.0% | 22.0 |
| `insert token_stats` | 369 | 14.5% | 16.8 |
| `insert worker_state` | 347 | 13.7% | 15.8 |
| `update worker_state` | 48 | 1.9% | 2.2 |
| `delete worker_state` | 22 | 0.9% | 1.0 |
| `insert scan_history` | 22 | 0.9% | 1.0 |
| `insert tick_legs` | 22 | 0.9% | 1.0 |
| **合計** | **2,541** | 100% | **115.5** |

按 subsystem 合併：

| subsystem | rows | 佔比 |
|---|---:|---:|
| `token_stats`（insert + update + prune delete） | 1,467 | **57.7%** |
| `push_watch` | 613 | **24.1%** |
| `worker_state`（counter / front / lock stamps） | 417 | **16.4%** |
| `scan_history` + `tick_legs`（telemetry） | 44 | **1.7%** |

注意：呢個係 `rowsAffected > 0` 嘅 statement 級 census，**唔包 index row**；
D1 嘅 `rows_written` 包（見 `src/d1.ts` 開頭註解）。`token_stats` 有 PK + 3 個 secondary index
（`idx_token_stats_first_seen`、`idx_token_stats_launch`、pool band 嘅 partial index
`idx_pool_band_m…`），所以佢喺真正賬單上嘅佔比比 57.7% **更高**。

### 1.3 Tick 嘅 DB 成本（`/debug/tick-legs?limit=3`）

| 完成（Z） | tick ms | dbMs | dbStmts | dbCalls | pool |
|---|---:|---:|---:|---:|---:|
| 00:16:04 | 934 | 266 | 14 | 7 | 1,204 |
| 00:13:25 | 858 | 288 | 8 | 4 | 1,198 |
| 00:06:04 | 881 | 150 | 13 | 6 | 1,191 |

即係一個 tick 用 4–7 個 D1 call、8–14 句 statement，DB 佔 **150–288ms**（tick 本身 858–934ms）。

### 1.4 距離（`/debug/db-latency?samples=3`，`colo LAX`）

```
select1          p50 36ms
readRow          p50 40ms
writeUpsert      p50 67ms
claimShapeTwoTrip p50 131ms
claimShapeOneTrip p50  39ms
```

D1 primary 喺 DFW、Worker 喺 LAX；`wrangler.toml` 已量過 placement 令 **fetch path** 落到 8–9ms，
但 **cron `scheduled` 唔受 placement 管**（同一段註解），所以掃描 tick 仍然付距離。

### 1.5 現時規模

`/health`：`tokenStatsCount 66,683`、pool 1,191–1,204、DB size 15.8MB（10-16 讀數）。
`/debug/tick-legs` ring 15 行、capacity 120。

## 2. DO SQLite 嘅硬事實（2026-10-18 查證）

| 項目 | 數 | 對呢個 repo 嘅意思 |
|---|---|---|
| Rows written | **50M/月 included**，之後 **$1.00/M** | 同 D1 同價；DO 係另一個 meter（文件冇寫會同 D1 合併，**唔好當合併**做預算） |
| Rows read | 25B/月 included，之後 $0.001/M | 同 D1 一樣；今日讀 2.7% |
| Storage | 5GB-month included，之後 **$0.20/GB-month** | D1 係 $0.75/GB-month；但 15.8MB 兩邊都免費 |
| Requests | 1M/月 included，之後 $0.15/M | 一個 tick 一次 RPC ≈ 86K/月，用得 8.6% |
| Duration | 400K GB-s/月 included，之後 $12.50/M GB-s | SQLite DO 仍然計 duration；長命請求才會碰到 |
| 每個 object | **10GB**（Paid） | 15.8MB ≈ 630× 餘裕 |
| 每句 | 100 bound params、100 columns、100KB SQL、2MB row | 同 D1 一樣；`paramLimit()` 已經係 100，冇新 regression |
| 併發 | 單線程；soft ~1,000 req/s，寫入類 ~200–500 req/s | 今日平均 < 5 rows/s，峰值一個 tick ~115 rows，遠低於上限 |
| PITR | **30 日**（bookmark；`transactionSync`） | 唔係「冇 DR」——呢點同直覺相反，係支持搬遷嘅一面 |
| 狀態 | 2025-04-07 GA；官方建議新 namespace 用 SQLite backend | `TickClock` 已經係 `new_sqlite_classes` |

來源（2026-10-18 讀）：
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- https://developers.cloudflare.com/workers/platform/pricing/

官方原文（storage 頁）：**「SQL query pricing and limits are intended to be identical between D1 and
SQLite in Durable Objects」**，同埋「With D1, your application code and SQL database queries are not
colocated … With SQLite in Durable Objects … the Durable Object itself runs on the same machine as the
SQLite database」，但**前端 Worker 同 DO 之間仍然係一次 network hop**。

## 3. 逐個 boundary：切得定切唔得

| 表 | 佔 rows | 讀／寫依賴 | 判斷 |
|---|---:|---|---|
| `scan_history` + `tick_legs` | 1.7% | 只係 `/debug`、`/health`、腳本讀；tick 寫 | ✅ **切得**，冇跨表 transaction；但省 ~8K rows/day |
| `worker_state` 嘅純 counter | 16.4%（混合） | `telemetry_*` 係 counter；`scan_front`／`tick_progress`／lock 係 gate | ⚠️ 只可以拆純 counter；鎖同 front 要留喺 D1 |
| `push_watch` | 24.1% | pass 逐行 CAS、`reserve → send → rollback`、讀 `token_stats` | ⚠️ 技術上得，但多一個 consistency domain；reserve／commit 跨 store 要自己排序 |
| `token_stats`（pool） | 57.7% | tick 嘅 pool query `NOT EXISTS (SELECT 1 FROM seen_tokens …)`、registration、prune | ❌ **唔可以局部切**：anti-join 同 dedup 要同一個 store |
| 成個 DB | 100% | 單 writer tick、read-after-write | ✅ 最一致；要 transport + tooling + 遷移，見 §4C |

`token_stats` 唔可以切嘅原因係實際 SQL，唔係潔癖：

```
SELECT … FROM token_stats
WHERE first_seen_at >= ?
  AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)
ORDER BY … LIMIT ?
```

（`src/db.ts:5517`、prune 同 `never_pushed` 統計亦同款。）`seen_tokens` 就係重複卡嘅唯一閘
（`claimTokenPush` 嘅 `INSERT OR IGNORE`），兩個表一定要同一個 store，否則 pool 要拉 6 萬行
`seen_tokens` 去 Worker 做 anti-join，或者接受兩個 store 之間嘅 race。

## 4. 三個方案嘅成本／收益

### A. Telemetry shard（低風險、低收益）

- 搬 `scan_history` + `tick_legs`，一個 `TelemetryShard` DO，每一／兩個 tick 一個 batched RPC。
- D1 減：44 rows / 22 ticks ≈ **2 rows/tick**，≈ 6–8K rows/day，**1.6%**。
- DO 加：~86K requests/月（8.6% of 1M）、~240K rows written/月（0.5% of 50M）、storage < 100MB。
- 成本：**~$0**（兩邊都喺 included）。
- 風險：低（append-only、冇跨表 transaction、有 kill switch）。
- 延遲：仍然係一次 Worker→DO hop；除非 DO 同 tick 同 colo，否則同今日 D1 差唔多。
- 結論：**唯一適合做 pilot 嘅切法，但唔會解決任何現有問題**（D1 只減 1.6%）。

### B. 熱表 shard（`push_watch` 或 `worker_state` counters）

- `push_watch` 減 D1 **24.1%**（≈ 120K rows/day）；`worker_state` 純 counter 再減一部分。
- 代價：pass 嘅 `claimAndReservePushWatch`（兩句一個 batch）＋ send ＋ commit 變成跨 store；
  要自己處理「DO 已 reserve、D1 未寫」嘅中間態。呢個 workflow 嘅註解已經寫明 reserve-then-send
  唔可以被切斷（`src/pushwatch.ts:4745`、`src/scanner.ts:755-784`）。
- 收益：**$0**（兩邊都喺 included）；只係把 24% 嘅寫入搬離 D1 嘅單線程隊列。
- 結論：**唔值得**，除非 D1 寫入真係撞牆；即使撞牆，先做「只在值變動時寫」更便宜。

### C. 成個 store 搬入一個 DO（唯一有結構性收益）

- D1 寫入 → 0；DO ≈ 498K rows/day → **29.9% of DO 50M**，storage 15.8MB。
- Requests：今日 4–7 call/tick × ~3,000 ticks/day ≈ **12–21K/day ≈ 360–630K/月**（36–63% of 1M），
  加 `/health`／`/debug`／uptime 輪詢仍然喺 1M 內，但唔係「用唔晒」。
- Duration：~10ms/call × 128MB × 600K ≈ **770 GB-s/月** → 超過 400K included 少少（cents）。
- 延遲：SQL 喺 DO 內係微秒級，但 **Worker→DO 仍然係 network hop**；DO 位置固定喺一個 colo，
  而 cron tick 每次可能喺唔同 colo（今日 LAX／之前 ORD），所以 **唔保證快過今日 36ms**。
  要真係贏，要連掃描邏輯都搬入 DO（或者由 clock DO 直接跑），呢個係另一個 project。
- DR：DO 有 **30 日 PITR**（bookmark），唔使靠 D1 Time Travel。
- Tooling：**至少 7 個 script／workflow 直接經 D1 讀寫**（共用 `scripts/d1-rest.js`：
  `backfill-pumpfun`、`d1-copy`、`raydium-attribution`、`test-d1-migrate`，加 `deploy.yml` 嘅
  migrate/catchup、`axiom-refresh`），全部要改寫或者加一個 DO admin endpoint；
  `wrangler d1 execute` 唔再適用。
- 結論：技術上可行、數字上唔會爆，但係一次**完整遷移**，唔係「分流」；今日冇必要。

### D. 維持現狀

- $0、3.3× 寫入餘裕、DR 有 Time Travel、tooling 齊。
- 唯一「成本」係 cron tick 嘅 150–288ms `dbMs` —— 而呢個喺 858–934ms 嘅 tick 入面只佔 ~25–30%。

## 5. 如果真係要試：最小 pilot（唔係今次）

只搬 `tick_legs`（1 row/tick），因為佢係最乾淨嘅 append-only 表，而且 `/debug/tick-legs` 已經係
唯一讀者：

1. `TelemetryShard` DO（`new_sqlite_classes` v2），name = `telemetry-YYYY-MM`（按月分，PITR 同 prune 都簡單）。
   `CREATE TABLE tick_log(at INTEGER PRIMARY KEY, …)`，`INSERT OR REPLACE` 保留 idempotent flush。
2. Worker 每次 flush 一個 RPC：`transactionSync` 內 `exec` 一次；回 `{ rowsWritten, rowsRead }`。
3. Kill switch：冇 `TELEMETRY` binding 就照舊寫 D1（同 `TickClock` 一樣「冇 binding = 功能關」）。
4. 驗收讀數（deploy 後 24h）：
   - RPC p50 < 20ms（由 tick 嘅 colo 量）；
   - 0 遺失：DO 行數 == D1 `scan_history` 同時段行數；
   - DO rows written ≈ 1/tick（`tick_log` 嘅 `at INTEGER PRIMARY KEY` 係 rowid alias，冇額外 index）；
   - `/debug/tick-legs` 由 DO 讀返同一批 `at`；
   - 成本：86K requests/月、~86K rows written/月（1 row/tick），兩邊都喺 included。

只有 pilot 過到，才值得討論搬 `push_watch`；`token_stats` 唔好碰（除非成個 store 搬）。

## 6. 限制（唔可以當過）

- `writeCensus` 係 **per-isolate**、只計 `rowsAffected > 0`、樣本係 22 個 tick；§1.2 嘅佔比係
  **形狀**，唔係全 fleet 總數。全 fleet 嘅總數只有 §1.1 嘅 D1 analytics。
- D1 `rows_written` 包 index row（`src/d1.ts` 自己寫明），所以 `token_stats` 嘅真實佔比比
  57.7% 高；`scan_history` insert 亦係 2 rows（1 row + `idx_scan_history_at`），`tick_legs` 係
  `INTEGER PRIMARY KEY`（rowid alias，冇額外 index，1 row）。
- DO 嘅價格／限額係**文件數字**，未喺呢個帳戶量過；DO 同 D1 嘅 included 額度係咪合併，
  文件冇明講，所以本文所有「多一個 50M」都係上限估算，唔係保證。
- 冇做任何 code change、冇 deploy、冇量過 DO SQLite 嘅實際 RPC latency。
- 一個 object 嘅 10GB／單線程／1K req/s 係文件 soft limit；未做負載測試。
- §1.4 嘅 36ms 係 `placed` 咗嘅 fetch path 讀數（`colo LAX`）；cron path 同 fetch path 唔同，
  唔可以互相代表（`wrangler.toml` 嘅 placement 段已記低呢個分別）。
