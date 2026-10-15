# 2026-10-15 D1 之後嘅效率：把 Worker 搬返 DB 隔籬，同埋唔好把「parameter 上限」變成「round-trip 乘數」

前提：讀寫已經全喺 Cloudflare D1（`docs/d1-migration-2026-10-15.md`，2026-10-15 09:31:35Z 切換）。
呢份文件只答一條問題：**切換之後仲有咩可以做嚟提升效率**，而每一條都先量度、後改。

## 0. 結論（兩件已落地，全部有實測）

| # | 發現 | 代價（實測） | 已做 |
|---|---|---|---|
| 1 | **placement 指錯地方**：D1 primary 由 **DFW（達拉斯）** 服務，但 Worker 嘅 fetch path（＝每個 tick 實際跑嘅地方，見 relay）仲綁死喺 **NRT（東京）**——2026-10-02 為 Turso-Tokyo 而設 | 每次 DB 請求 ~**140ms 跨太平洋**；5 個 tick 嘅 `dbTickSteps` 加總 **~25.0s**（每 tick ~5s，其中 ~3.5s 純距離） | `wrangler.toml` placement → `gcp:us-south1`（GCP 達拉斯） |
| 2 | **100-param 上限被 chunk 實作變成 round-trip 乘數**：D1 每 statement 只准 100 個 bound parameter，六個 writer 於是把一批 row 切成 N 個 statement——但**逐個 `await execute()`**，即 N 次請求 | `recordTokenStatsMany` **2,875ms / 3 calls**（一次 dense tick 20–40 隻幣 = 3–5 個 statement）、`updateTokenMaxMcaps` **1,954ms / 5 calls** | `Db.runChunked()`：切 statement，唔切請求（一個 `batch()`） |

D1 自己嘅 SQL 係免費嘅：一次真 `SELECT 1` 嘅 `meta.duration` = **0.2165ms**。**貴嘅係請求數 × 距離**，兩樣都係上面兩條。

## 1. 量度（方法同讀數，2026-10-15 22:4x–22:5xZ）

### 1.1 D1 伺服器自己講嘅嘢
```
$ npx wrangler d1 info solana-meme-bot --json
  uuid                e8b4be30-e532-4866-826f-3e3c02f2bb73
  running_in_region   WNAM            read_replication disabled
  num_tables          9               database_size 16,211,968
  read_queries_24h    77,766          write_queries_24h 100,073
  rows_read_24h       10,317,695      rows_written_24h  890,634

$ npx wrangler d1 execute solana-meme-bot --remote --json --command "SELECT 1 AS x"
  meta.served_by_primary  true
  meta.served_by_region   WNAM
  meta.served_by_colo     DFW        ← 真正服務嗰部機喺達拉斯
  meta.duration           0.2165     ← SQL 本身 0.2ms
  meta.total_attempts     1
```
`running_in_region` 係 billing／group 標籤（粗），`served_by_colo` 才係實際 colo——所以「WNAM」唔可以當成「喺西岸」，一定要睇 `served_by_colo`。

### 1.2 從 deployed Worker 量（即用戶會用到嘅介面）
```
$ curl /debug/db-latency            # 呢條 route 行 placed fetch path
  colo LAX（入口；handler 讀唔到自己嘅 placement 位置）, dbStore "d1", dbRegion null
  select1            p50 143ms   (min 139 max 151)
  readRow            p50 156ms
  writeUpsert        p50 169ms
  claimShapeTwoTrip  p50 347ms
  claimShapeOneTrip  p50 146ms

$ curl /health                      # heartbeat.summary.dbTickSteps，五個 tick 嘅窗口
  getWorkerStates        37 calls / 7,486ms      recordTokenStatsMany  3 / 2,875ms
  updateTokenMaxMcaps     5 / 1,954ms            findUntrackedPushesAndLedger 3 / 1,472ms
  writeScanFront          7 / 1,217ms            readPostScanTelemetry 4 / 1,001ms
  claimScanLock           5 / 931ms              persistScanCompletion 4 / 915ms
  getTokenStatsMany       5 / 758ms              readScanFront         5 / 723ms
  recordObservedLiquidity 4 / 664ms              releaseScanLock       4 / 645ms
  setWorkerState:tick_progress 4 / 736ms         …（其餘 12 項 ≤ 535ms）
  ── 加總 ≈ 25.0s，≈ 每 tick 5s（連 tracker pass）
  lastScanMs 3,599–4,058；heartbeat.colo NRT（＝relayed tick 跑喺東京）
```

### 1.3 對照：同一個 store 換咗就慢咗 15 倍
同一條 `/debug/db-latency`、同一個 placed 路徑，2026-10-02 換嚟 NRT 隔籬嘅 Turso-Tokyo 之後量到
`select1 p50 8-9ms`、`readRow 9-10ms`（wrangler.toml 嘅 PLACEMENT block 有原文）。
今日同一條 route 係 **143ms**。唯一改變咗嘅變數係 store——即係嗰 130ms 差值**係距離**，唔係 D1 本身慢
（§1.1 嘅 0.2165ms 亦證明伺服器端冇嘢做）。

### 1.4 所以「效率」喺呢個系統度係咩
- **唔係賬單**：`rows_written` 890,634／24h ≈ **26.7M／月**，Workers Paid 內含 50M（53%）；`rows_read` 10.3M／24h ≈ 310M／月，內含 25B（1.2%）。兩者都仲有大量餘量（見 `d1-migration-2026-10-15.md` §0：搬去 D1 就係為咗用已付嘅 $5 蓋過 Turso 嘅超額）。
- **係 latency 同 headroom**：tick 嘅 `ms`、60s／30s cadence 嘅餘裕、D1 每個 batch 30 秒上限、每個 invocation 嘅 subrequest 預算、同埋 tracker pass 每分鐘要行完嘅窗。

## 2. 修正一：placement 由 `aws:ap-northeast-1` 改去 `gcp:us-south1`

**為何係呢個值。** Cloudflare placement region 嘅語意（官方文件原句）：「Cloudflare maps your specified
cloud region to the data center with the lowest latency to that region」，格式係 `{provider}:{region}`
（AWS／GCP／Azure 嘅原生 region 代碼）。而 **GCP `us-south1` 就係達拉斯**（GCP locations 頁：`us-south1-a`
等三隻 zone，位置 Texas；社群嘅 region 表直接寫 `dfw-zone1-*`）。所以 `gcp:us-south1` 就係「請把我放喺 DFW」——
同 2026-10-02 揀 `aws:ap-northeast-1` 嘅推理一樣，只係今次重新由「邊個 store 真正持有 state」推一次。

**Fallback（已寫入 wrangler.toml 嘅 block，按次序）**：`azure:southcentralus`（San Antonio）、`aws:us-east-2`（俄亥俄，~20ms，仍然係 NRT 嘅七份一）。三個都係改一個字串嘅事。

**為何唔用其他 lever**：
- **Read replication（而家係 `disabled`）**：官方講明只幫讀，而且要有 Session 才讀得到自己寫入（本 repo 由構造決定係 read-after-write：單飛鎖、`seen_tokens` 防重推、tracker 每行 CAS）。把 Worker 放喺 primary 隔籬之後，replica 冇任何嘢好補。
- **Smart Placement（`mode = "smart"`）**：同 `region` 互斥，而且需要「多個位置嘅一致流量」才決定到；本 Worker 嘅 fetch path 係低流量（uptime monitor、Telegram webhook、operator /debug）——2026-10-02 已經行過同一條推理。

**驗收（deploy 之後讀三個位）**：
1. `/health.heartbeat.colo` 唔再係 NRT（期望 DFW 或附近美中／美南 colo）；
2. `/debug/db-latency` 嘅 `select1 p50` 由 143ms 落到單位數／幾十 ms，`dbTickSteps` 各項加總跟住塌；
3. 三個 relay marker 仍然係 `inner`（`heartbeat.relay`、`pushWatchPass.relay`、`summary.diag.maintRelay`）——placement 決定「喺邊跑」，唔決定「跑唔跑」。

**Revert**：改返字串（或刪成個 block）。cron 路徑從來唔靠 placement：relay 失敗會回落自己嘅 region（歷史上量到 ORD），
而且 Turso 已經冇任何讀者（`d1-migration-2026-10-15.md` §5），所以冇其他 consumer 依賴「fetch path 喺東京」。
上游（DexScreener／CoinGecko／Jupiter／Telegram／Birdeye）全部係 global 或 Cloudflare fronted，唔會因為達拉斯而變差。

**改咗嘅檔案**：`wrangler.toml`（新 block + 舊 block 保留作為歷史：NRT 指標對 Turso 係啱嘅，所以唔可以當「錯」嚟睇），
`scripts/test-unit.js` 一條 pin（見 §4）。

## 3. 修正二：`Db.runChunked()` —— 上限切 statement，唔切請求

**問題。** D1 每 statement ≤ 100 個 bound parameter 係**一句 statement 嘅大小上限**，唔係「一個 request 可以帶幾多句」。
但六個 writer 為咗避開上限，把 row 切細之後仍然**逐塊 `await execute()`**——於是上限變成請求乘數：

| writer | bindings／row | D1 每 statement | D1 切幾多句（今次量度嘅輸入） | 舊：幾個請求 | 新：幾個請求 |
|---|---|---|---|---|---|
| `recordTokenStatsMany` | 12 | 8 行 | 200 行 → **25** 句 | 25（＋1 個 counter） | **1**（＋1 counter） |
| `recordObservedLiquidity` | 5 | 20 行 | 200 行 → **10** 句 | 10 | **1** |
| `updateTokenMaxMcaps` | 7 | 14 行 | 60 項 → **5** 句 | 5 | **1** |
| `noteSweptWithoutReading` | 1 | 100 | 150 個 → **2** 句 | 2 | **1** |
| `upsertPushWatchMany` | 9 | 11 行 | 30 行 → **3** 句 | 3 | **1** |
| `recordPushedHolders` | 7 | 14 行 | 40 行 → **3** 句 | 3 | **1** |

**修法。** 六個 writer 改成「砌 statement 清單 → 交去 `this.get().batch(stmts)`」，由 `Db.runChunked(stmts)` 統一收口並加總 `rowsAffected`。
batch 本身就係一個 request（順序執行，兩邊 store 都係：D1 嘅 transactional batch、libsql 嘅 batch），所以：

- **D1 上**：六個 writer 每個「一次 call = 一次請求」，statement 數由上限決定（上面第 4 欄），唔再由請求數決定。
- **libsql 上形狀不變**：同一批 statement、同一個次序、同一個 bind 數（`recordTokenStatsMany(200)` 仍然係一句 2,400 個 parameter），
  而今次係「本來就係一次請求」——唔會為 Turso 加 subrequest（呢點由 `scripts/test-d1-transport.js` 嘅 libsql 個案釘住）。

**刻意嘅語意變化（要記住）**：batch 係**全有全無**，所以一個 chunk 失敗會連坐其他 chunk，唔會再留低「半批成功」。
喺呢幾個 writer 嘅尺寸下（tick 20–40 個註冊、每次 push ≤ 9 行、sweep 自己嘅 cap）呢個係更乾淨嘅性質（同 `claimScanLock`
靠嘅「冇寫就等於冇做」同一個方向），而且所有 caller 都係 idempotent 或者由 deferred drain 重試。
另一個方向係**更嚴**、唔係更鬆：硬牆由「每塊 1.44s／3s」變成「整批一個 1.44s／3s」（`SCAN_DB_TIMEOUT_MS` 內 1.2×；`DB_REQUEST_TIMEOUT_MS` 外 1.2×），
即係以前可以「25 塊 × 各 3 秒」嘅情形，而家 3 秒內冇完就當失敗——而 batch 只係一個 round trip，所以實際上前面嘅 140ms 係一次過付。

**點解 counter 唔入同一個 batch**：`telemetry_token_stats_count` 加嘅係 `INSERT OR IGNORE` **真正收咗**幾行，
只有伺服器答得到（`changes()`），所以嗰句一定要**跟在**佢數嘅 statement 後面；而註冊係切咗幾句，
跟在最後一句只會數到最後一塊。結論：counter 保持「每次註冊一次請求」（唔係每塊一次），呢點由測試釘住（見 §4）。

## 4. 釘住呢兩條規則（測試）

- `scripts/test-d1-transport.js`
  - `FakeD1` 而家數 **round trip**：`all()`／`run()` = 一次 `singles`，`batch()` = 一次 `batches`（帶幾多句都係一次）。
  - `Db on D1: every row-count-sized writer is ONE request under 100 bindings`：逐個 writer 斷言
    `{ singles, batches: 1, batchStatements }`——即「上限切 statement，唔切請求」，同時仍然斷言每個 statement ≤ 100 個 binding、
    行真係落咗（`token_stats`／`push_watch`／`pushed_holders`）同 write census 有數。
  - `Db on libsql: the same calls keep their original statement shape, in ONE request`：同一批 call 喺 libsql 上
    仍然係「1 句 2,400 parameter」等原本形狀，而且係一個請求。
- `scripts/test-unit.js`
  - `placement pointer: the fetch path is pinned near the D1 primary, not the Turso region`：`[placement] region = "gcp:us-south1"`、
    冇 `mode`、block 內仍然寫住 `served_by_colo`／`DFW`／`meta.duration 0.2165`／兩個 fallback／`dbTickSteps`＋`/debug/db-latency` 嘅驗收讀法，
    而且 `region = "aws:ap-northeast-1"` 唔准無新量度就返嚟。

## 5. 未做嘅（按證據排，全部要新量度才值得做）

1. **睇 re-point 之後嘅 `dbTickSteps`**：如果每 tick 由 ~5s 落到 <1s，就冇嘢要再做；如果有某一項仍然係幾百 ms，先值得再查（可能要 per-statement 讀數，見 §7 限制）。
2. **pre-scan 嘅 `getWorkerStates` 已經係一次多 key 讀**（37 calls／5 ticks ≈ 7.4 次／tick，每次都係一次請求）：re-point 之後每 tick 大約 100ms 上下，
   唔值得為咗合併而改鎖／順序。
3. **`rows_read` 熱點**（pool 讀、`getPoolHistogram` 嘅全表掃）：離內含額度好遠（1.2%），唔係今日嘅槓桿。
4. **如果 Cloudflare 唔收 `gcp:us-south1`**（deploy step 會紅、prod 停喺舊 build）：改 `azure:southcentralus`，再唔得就 `aws:us-east-2`。

## 6. 限制（唔可以當過）

- **呢兩個修正喺寫呢份文件時未 deploy**：§1 係改之前嘅實測（before），「after」係**待驗**——驗收讀數見 §2 嘅三點。
  呢個 repo 既有嘅做法（`wrangler.toml` PLACEMENT block）就係「量 → 改 → 再量 → 保留或 revert」，今次照跟。
- `wrangler d1 info` 嘅 `running_in_region` 係 group 標籤（WNAM），同 `served_by_colo`（DFW）唔同層次：呢份文件用後者。
- **placement 係 hint**：官方講明「Cloudflare automatically adjusts placement to account for network maintenance or changes」——
  所以驗收要睇讀數，唔可以假設永遠釘死係 DFW。
- `dbTickSteps` 係 **per-method**，唔係 per-statement：今次「25 句 = 1 個請求」係由測試釘住嘅形狀，而 runtime 只量到 method 級。
  一個 tick 嘅 statement 總數同 50-subrequest 預算嘅關係**仍然未量**（`d1-migration-2026-10-15.md` §8 亦記住同一點）。
- `gcp:us-south1` 只通過 `npx wrangler deploy --dry-run` 嘅 config 解析，**未經真 deploy**（真驗證喺 API 側）。
- 呢份文件冇碰 read replication：佢係 `disabled`，而 enable 就要 Session／read-your-writes——喺同 store 隔籬之後冇意義，唔係「未夠好」。

## 7. 落地清單

1. Push（或 `workflow_dispatch`）`deploy.yml` → deploy job 綠（`wrangler deploy` 接受 `gcp:us-south1`）。
2. 5 分鐘後讀三個位：`/health.heartbeat.colo`（唔再 NRT）、`/debug/db-latency`（`select1 p50` 應大幅下降）、
   `/health.heartbeat.summary.dbTickSteps`（各項加總塌）、同三個 relay marker 仍然 `inner`。
3. 15 分鐘後確認 tick 冇斷（`lastScanMs`、`scan_history` 間距、tracker pass 嘅 `trackerMs`／`db Nms`）。
4. 如果 (2) 冇改善：改 fallback region（§2），重複 (2)。如果連 fallback 都冇用，就係「唔係距離」——到時要量 per-statement 讀數。
