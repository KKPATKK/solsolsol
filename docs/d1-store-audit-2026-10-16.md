# 2026-10-16 D1 讀＋寫全開之後：仲有咩問題（逐項檢查，量到才講）

前提：讀寫**已經**全喺 Cloudflare D1（切換 2026-10-15 09:31:35Z，見 `docs/d1-migration-2026-10-15.md`），
而切換後手上已經落地嘅三件係 **100-param 分切**、**`runChunked`（切 statement，唔切請求）**、
同 **placement 指返去 D1 primary 隔籬**（見 `docs/d1-efficiency-2026-10-15.md`）。
呢份文件唔重覆嗰三件，只答一條問題：**換咗 store 之後，仲有咩壞咗／會壞／未算數**。

## 0. 結論

| # | 檢查 | 結果 | 動作 |
|---|---|---|---|
| 1 | 形狀翻譯（`meta.changes`→`rowsAffected`、batch 全有全無、`SELECT/WITH/PRAGMA` 走 `all()`） | **完好**（live `changes` 自我校正 `verdict: verified`） | 已有測試守，唔改 |
| 2 | 100 bound-param 上限：六個 **writer** 已按 `paramLimit()` 切 | 完好（每句 ≤ 100，仍然一個請求） | 已有測試守 |
| 3 | 同一上限：**reader** 嘅 `IN (?,?,…)` 清單（`getTokenStatsMany` 等）冇切 | **今日安全**：實測每 tick 只有 **24–26** 個 token（上限 100） | 記界線（§3.1），唔改 |
| 4 | `diag.dbMs`（`/debug/tick-legs` 嘅 `dbMs`） | **喺 D1 係死嘅：每個 tick 都答 `0`** | **已修**（§2.1）＋新測試 |
| 5 | `/health` 講唔講「而家用邊個 store」 | **唔講**（只有 `/debug/db-latency` 講） | **已修**（§2.2）＋新測試 |
| 6 | `claimTokenPush` **輸**咗要答 `false`（D1 翻譯嘅反向） | **冇任何測試釘** | **已加測試**（§2.3） |
| 7 | D1 額度（rows written／read、queries、DB 大小） | 大量餘裕（寫入 57%） | 只記讀數（§4） |
| 8 | read replication | `disabled` | 維持（§3.3） |
| 9 | Time Travel（唯一 DR 路徑） | **有 bookmark**，即係可以還原 | 記落嚟（§5.1） |
| 10 | 一個 tick 出幾多句 statement（vs D1 嘅 per-invocation 上限） | **冇讀數**（只有 24h 平均可以推） | **新增儀器**（§2.4）＋測試 |
| 11 | `npm test`（`scripts/test-filters.js`）可不可以安全咁跑 DB 階段 | **之前只可以：跳過，或寫凍結 archive** | **新增 local 模式**（§3.4），今日實跑 |
| 12 | `subs`（`subreqView`）數唔數到 D1 call | **數唔到**（只數 `fetch`；D1 call 唔係 fetch），Paid 額度文件係 10,000 而 repo 常數係 1,000 | 記落嚟，未改（§3.5） |

## 1. 現況讀數（2026-10-16 02:4x–02:5xZ，全部現讀）

```
$ npx wrangler d1 info solana-meme-bot --json
  uuid e8b4be30-e532-4866-826f-3e3c02f2bb73   num_tables 9   database_size 15,843,328
  running_in_region WNAM   read_replication.mode disabled
  read_queries_24h 98,780  write_queries_24h 117,863
  rows_read_24h 13,925,511 rows_written_24h 954,630

$ npx wrangler d1 execute solana-meme-bot --remote --json --command "SELECT 1 AS x"
  served_by_primary true   served_by_region WNAM   served_by_colo DFW
  duration 0.1323 ms       total_attempts 1

$ curl /debug/db-latency?samples=5      # placed 路徑，binding 答嘅 store
  dbStore "d1"  dbRegion null  colo LAX   ok true
  select1 p50 18ms   readRow 18ms   writeUpsert 53ms
  claimShapeOneTrip p50 16ms   claimShapeTwoTrip p50 106ms   (claimShapeSavingMs 90)
  changes { before 329, after 339, expectedDelta 10, verdict "verified" }

$ curl /debug/tick-legs?limit=5         # 最近 5 個 tick
  ms 1,258–1,995   profiles 24–26   subs 9–11   dbMs 0  0  0  0  0   ← 見 §2.1
```

即係：**store 係 D1、SQL 本身 0.13–0.28ms、每次 call 15–55ms、tick 1.3–2.0s**，
而 `changes()`（claim 嘅配對計數器靠佢）由 live probe 自我校正驗過。

## 2. 已修（連新測試；全部未 deploy）

### 2.1 `diag.dbMs` 喺 D1 上面係死嘅
`diag.dbMs`（`/debug/tick-legs` 嘅 `dbMs`、scan summary 嘅 `db 0ms`）＝**呢個 tick 自己付嘅 DB round trip 時間**，
而佢之所以存在，係因為 libsql 嘅 **scan client** 裝咗硬牆嘅 `onCost` 鉤（`Db.ensureScanClient`）：
`enterScanMode()` 之後 `get()` 揀嘅就係嗰個 client（`src/db.ts` `get()`），所以 counter 量到嘅正正係 scan 窗內嘅 call。

D1 分支原本係 `return (this.scanClient = this.connect())`，而 `connect()` **唔會傳 `onCost`** ——
註解寫住「the scan-mode cost counter is served by the same onCost hook」但實際冇人裝。
後果：切換之後**每個 D1 tick 都報 `dbMs: 0`**（上面 §1 嘅五個 tick 全部 0），
即係一個手寫落嚟、有測試守（libsql 側）嘅讀數，喺新 store 上面靜靜地變成 0 —— 讀數死咗唔會有人知，因為 0 睇落正常。

**修法**：D1 嘅 scan client 改成第二個 wrapper 包住**同一個 binding**（唔改硬牆預算，仍然 `DB_REQUEST_TIMEOUT_MS`）＋裝 cost 鉤。
刻意**唔**用 `SCAN_DB_TIMEOUT_MS`：D1 冇 HTTP request 可以 abort（binding call 就係嗰個 RPC），
短牆只會把 D1 自己嘅排隊變成失敗嘅 tick 寫入；而 counter 係唯一一個「scan client 一定要有」嘅嘢。
偏差同 libsql 一樣、單邊：遲過 `exitScanMode()` 才 settle 嘅 call 會計入**下一個** tick（只會報大，唔會收埋）。

**測試**（`scripts/test-d1-transport.js`）：`Db on D1: a scan still reports what its round trips cost`。
Mutation 實測（把鉤改成 no-op、重新 build）：

```
❌ Db on D1: a scan still reports what its round trips cost:
   a scan must report the round trips it paid for (got 0ms)      → 9 passed, 1 failed
```
（即係測試真係捉得到上面嗰個 live 症狀，唔係寫嚟自我安慰。）

### 2.2 `/health` 唔講用邊個 store —— 而 bind 掉落去唔會 crash，只會換 database
`env.DB` **就係**切換掣，而佢取代嘅 Turso 而家係**凍結 archive**（`d1-migration-2026-10-15.md` §5）。
所以一個冇 `[[d1_databases]]` 嘅 deploy（人手 `wrangler deploy`、或者注入步驟被繞過）**唔會**壞：
佢照跑、照推卡，只係每一行讀到嘅都係**切換日嘅 state machine** —— 即係「已推過嘅幣再推一次」呢個
重複卡方向嘅產物，而且**完全靜音**。原本只有 `/debug/db-latency`（要有人去問）帶 `dbStore`；
`/health` 係**任何監控會 poll 嘅** endpoint，所以 store 要喺嗰度答到。

**修法**：`/health` 加 `dbStore: env.DB ? "d1" : "turso"`（同 `/debug/db-latency` 用同一個來源：binding，
唔係 URL —— `TURSO_DATABASE_URL` 仍然留喺 Worker 做 archive／Node 路徑）。
**測試**（`scripts/test-unit.js`）：`/health names the store in use, so a lost D1 binding is visible to a monitor`
（切 `/health` 到下一條 route 之間嘅文字，唔可以靠 `/debug/db-latency` 自己嗰句矇混過去）。
**監控規則（人手加）**：`dbStore != "d1"` 就報警。

### 2.3 冇人釘「輸咗嘅 claim 要答 false」
重複卡嘅唯一閘係 `seen_tokens` 嘅 `INSERT OR IGNORE`：`claimTokenPush` 直接讀
**第一句嘅 `rowsAffected`**（D1 側＝`meta.changes`，insert 被 `OR IGNORE` 跳過就係 0）。
已有嘅 D1 測試只釘咗**贏**嘅方向（新行→1）；輸嘅方向（同一個 (chat,token) 再 claim）之前冇測，
而佢壞咗嘅後果正正係重複卡。**加測試**（`Db on D1: a duplicated push claim answers false — the guard's own 0`）：
第一次 `true`、第二次 `false`、`seen_tokens` 仍然只有 1 行、配對計數器（`telemetry_seen_tokens_count`）仍然係 1。

### 2.4 一個 tick 出幾多句 statement —— 之前冇讀數，而家逐 tick 讀得到
`d1-migration-2026-10-15.md` §8 同 `d1-efficiency-2026-10-15.md` §6 都記住同一條未答嘅問題：
**「一個 tick 嘅 statement 總數同預算嘅關係」**。當時唯一嘅讀數係 `dbTickSteps`（per-method 時間）同
D1 自己嘅 24 小時 rollup，所以「一個 tick 會唔會撞到 D1 嘅 per-invocation 上限」只可以由平均值推（§4）。

**新增儀器（`dbStatementView`，`src/db.ts`）**：每個 statement 都會經過硬牆（`wrapClientWithHardWall`），
所以就在那裏數——`execute` ＝ 1 statement／1 request，`batch` ＝ N statements／1 request（D1 文件把 per-statement
上限「apply to each individual statement contained within a batch statement」，即係一句 batch 算 N 條 query，
但只算一次 request）。

- `/health.dbStatements` ＝ 這個 isolate 嘅 `{ stmts, calls, sinceMs }`（同 `writeCensus` 一樣係 per-isolate、
  唔會 reset 嘅窗口，時鐘同樣係 lazy：module scope 喺 pre-init 評估，`Date.now()` 答 0）。
- `/debug/tick-legs` 嘅每一行加 `dbStmts` ／ `dbCalls` ＝ **由 tick entry 到收尾嘅 delta**（entry 同 ring row
  捕捉兩次，計數器單調所以一定唔會負）。`subs` 唔可以代替它們：`subs` 只數 `fetch`，而 D1 binding call 唔係 fetch
  （見 §3.5）。

**測試**：`scripts/test-unit.js` —
`db statements: a tick's queries are counted the way D1's allowance counts them`（1 execute ＝ 1 條、3-statement batch
＝ 3 條／1 request、string 形 batch 同樣計數、`/health` 同 ring 嘅接線要存在、baseline 一定要 lazy）；
`scripts/test-tick-legs.js` 釘住 ring row 真係帶 `dbStmts`／`dbCalls`。

## 3. 檢查過但**唔改**（連理由）

### 3.1 reader 嘅 `IN (?)` 清單冇按 `paramLimit()` 切
`getTokenStatsMany(tokens)`（一個 `?` 一個 token）、`getHolderClusters(owners)`、`getWorkerStates(keys)`、
`readScanFront(stateKeys)`、`readHealthFront(keys)`、`readPostScanTelemetry(stateKeys)`、`seenChatIds` 子句
都係「清單幾長就綁幾個 parameter」。D1 每句上限 100，libsql 係 32,766 —— 即係呢批讀者係**切換帶入**嘅新風險面，
而 10-15 嗰次只做咗 writer。

**今日唔爆**：`getTokenStatsMany` 係唯一由 feed 大小驅動嘅，而 live tick 嘅 `profiles` 係 **24–26**（§1），
其餘 caller 都係細固定清單（`keys` 5–12、`owners` ~9、`/debug/token` 1 個 mint）。
**幾時會爆**：`PUMPFUN_PROFILE_LIMIT` 可以設到 300（`src/config.ts`），或者多條 feed 疊加令
`feedProfiles` 嘅 union 過 100。爆嘅形狀係 `getTokenStatsMany` throw →
caller 已經有 catch（`diag.dbDegraded = "stats-read"`，跳過**整個 tick** 嘅註冊）——
即係「唔會壞資料，但新幣喺 densest ticks 會靜靜地唔入 pool」。所以呢條係**配置界線**，唔係今日嘅 bug；
如果日後要調高 feed 上限，呢個係要一齊切嘅位。

### 3.2 `writeCensus` 唔可以用嚟量 statement 數（所以另加一個 counter，見 §2.4）
佢係 **per-isolate**（module scope）而且**只計 `rowsAffected > 0` 嘅 statement**，所以「一個 tick 出幾多句」
喺佢身上答唔到（`d1-migration` §8 同 `d1-efficiency` §6 都記住呢點）；`dbSteps` 亦只係 method 級。
所以唔改佢，而是加一個專用嘅 statement／request 計數器（§2.4）。

### 3.3 read replication
`disabled`（§1）。佢要 `withSession()`／read-your-writes 手續，而呢個 Worker 係 **read-after-write**
（單飛鎖、`seen_tokens`、tracker CAS、pool 讀同 tick 自己寫嘅 `token_stats`）——
喺 placement 已經釘喺 primary 隔籬嘅前提下，開佢只有風險冇收益。維持，並記住驗收條件：
如果 `served_by_colo` 唔再係 DFW（Cloudflare 可以因維護自動調整 placement），先值得重新討論。

### 3.4 `npm test`（`scripts/test-filters.js`）而家真跑到 DB 階段
呢個檔案係 `npm test`，而 10-15 嘅 archive 護欄留下兩個選擇：只跑 phase 1（DB 階段完全唔碰
`Db` 同 `Scanner.runOnce`），或者寫凍結嘅 Turso archive。但 phase 2／3 覆蓋嘅係**寫入路徑**
（註冊、claim、完成 flush），所以「npm test 跳過它」等於「寫入路徑冇手動檢查」。

**新增 LOCAL 模式**：`FILTERS_LOCAL_DB=/tmp/filters.db npm test` —— 經注入 client seam
（`Db(url, token, injectedClient)`）跑一個真正嘅本地 SQLite file，唔要憑證、冇 remote store 可達。
兩個性質保證它唔係護欄嘅洞：**archive opt-in 優先**（帶 `--allow-archive-write` 時完全忽略 `FILTERS_LOCAL_DB`，
即係一個陳舊嘅環境變數唔可能偷偷把一個刻意嘅 archive run 改道），同名為 `USE_LOCAL = Boolean(LOCAL_DB) && !ARCHIVE_WRITE_OK`；
以及 local Db 一定建在本地 file 上（唔係 Turso URL），連 phase 3 嘅 `seen_tokens` 清理都一樣。
同一個 pin（`scripts/test-d1-migrate.js`）同時守住舊有嘅「archive 要旗標 AND 憑證」規則。

**今日實跑（2026-10-16，`FILTERS_LOCAL_DB=/tmp/filters-test.db npm test`，exit 0）**：
- Phase 1：14 項 config／文案檢查 ✅；種一個 enabled chat（唔種嘅話 scanner 會早退
  `no chats with push enabled, skipping`，phase 3 就變成量一個 early return）。
- Phase 2：live DexScreener **22 profiles** + 逐條件 verdict 表 ✅。
- Phase 3：真 `Scanner.runOnce`（mock bot）**1,129ms**，寫入路徑真跑過 ——
  `[db] pool band index ready: idx_pool_band_m32000`（DDL）、`token_stats` 39 行、
  日誌 `scan done in 1127ms: 22 profiles, 22/22 pooled, 0 candidates, 0 pushed`，
  `seen_tokens` 清理後 0 行。（`scan_history` 0 行係預期：完成 flush 係 worker 嘅工作，唔係 scanner 的。）
- **archive 冇碰**：這條 run 只連本地 file（URL／TOKEN 根本冇傳過）。

### 3.5 未修但已查實：`subreqView`（`subs`）而家數唔到 D1 call
`src/subreqs.ts` 只數 global `fetch`，而 **D1 binding call 唔係 fetch** —— 所以切換之後
`/debug/tick-legs` 嘅 `subs` 由 Turso 年代嘅 ~29–39 跌到 **9–11**，減嘅正好係 DB 嘅份額。

Cloudflare 文件的事實（查證日期 2026-10-16）：
- Workers Limits 頁：**「A subrequest is any request a Worker makes using the Fetch API or to Cloudflare
  services like R2, KV, or D1.」** ⇒ D1 binding call **係** subrequest，即係運行時會計，而本 repo 嘅 counter 唔計。
- 同一頁現在給 Paid 嘅 subrequest 額度係 **10,000／invocation（可配置至 10M）**，而本 repo 嘅常數係
  `SUBREQ_BUDGET = 1_000`（subreqs.ts，2026-09-28 落）：即係**現行代碼比平台上限保守十倍**
  （除非帳號喺 wrangler／dashboard 另外限過 —— `wrangler.toml` 冇 `[limits]` block）。
- D1 Limits 頁：**1,000 queries／invocation（Paid）**，而 batch 頁寫明 per-statement 限制
  「apply to each individual statement contained within a batch statement」——即係一句 batch 算 N 條 query
  （§2.4 嘅計數器就係照這個口徑數）；batch 嘅**最大句數冇文件寫明**。

**為何未即改**：`subreqRemaining()` 係 opt-in legs／tracker pass 收手的依據。
把 D1 call 計進去（或者把 1,000 改成 10,000）係改**決策輸入**，要先量到自己嘅 D1 call/tick 分佈
（§2.4 新儀器給嘅 `dbCalls` 正是這個）才值得動。今日嘅保守方向係安全側（早點收手），
唔係壞嘅方向；但它令「tick 用咗幾多 subrequest」這個讀數**偏低**，寫落嚟免得日後有人用它做面積計算。

## 4. D1 上限 vs 今日用量（完全冇一個接近）

| 上限（D1 文件／`src/d1.ts` 註解已引用） | 今日用量（§1） | 餘裕 |
|---|---|---|
| 100 bound params／statement | 六個 writer 切到 ≤100；reader 最長 26 | —— |
| 100 KB SQL 文字／statement（唔包 parameter） | 最大 shape 係 chunk 後嘅 INSERT（`d1-migration` §2 有逐個列） | —— |
| 2 MB／value 或 row | `worker_state` 最大 33 KB（push-audit ring） | ~60× |
| 1,000 queries／invocation（Paid） | **~75 句／tick**（216,643 queries／24h ÷ 2,880 ticks，平均上界；deploy 後改讀 `tick-legs.dbStmts`，per-tick） | ~13× |
| 30 秒／batch | 一個 batch 係 1 個請求，15–55ms 級 | —— |
| 50M rows written／月 | 954,630／日 → **~57%** 額度 | 1.75× |
| 25B rows read／月 | 13.9M／日 → **~1.7%** 額度 | 59× |
| 10 GB／database（Paid） | 15.8 MB | 630× |
| 每個 database 單線程 | batch 會排隊 → 睇每 tick 加總，唔好睇單次 max | —— |

## 5. 運維

### 5.1 Time Travel＝目前唯一嘅還原路徑（未寫落任何 runbook）
```
$ npx wrangler d1 time-travel info solana-meme-bot --json
{ "bookmark": "00000006-00001f1b-00005106-fcc4036f806765cc76134d71c44bebb3" }
```
有 bookmark 即係 D1 側有可還原點（Paid 計劃係 30 日窗口）。
**未做**：還原演練。**要記住**：`time-travel restore` 係**覆蓋 live**，所以出事時嘅次序係
「先 export／fork，再 restore」，而唔係直接 restore 落生產。

### 5.2 綁定掉落（= 跑凍結 archive）
`/health.dbStore`（§2.2 新增）係讀得到嘅訊號；文件層面嘅語意同風險見 `d1-migration-2026-10-15.md` §6
（回滾之後會失去 D1 窗口內嘅寫入＝重複卡風險，所以只可以即刻做）。呢次**冇**加 fail-closed 守衛：
凍結 archive 係官方記低嘅回滾方向，硬停會令嗰條路要改 code —— 改成「睇得到」係同風險成比例嘅一步。

### 5.3 2026-10-16 早上：已 deploy，驗收讀數
Commit `00a2637`（run 38843036295：`migrate`／`deploy`／`catchup` 全 success）之後嘅 live 讀數：
- `/health.dbStore` ＝ **`"d1"`** ✅（`dbReady true`、`initError null`、`writeDrainError null`、`deadTickStreak 0`、
  `heartbeat.colo DFW`）。
- `/debug/tick-legs` 嘅 `dbMs`：deploy 前最後一個 tick（02:59:35Z）＝ `0`，deploy 後 03:00:00Z ＝ **102ms**、
  03:02:00Z ＝ **82ms** ✅。
- 寫入路徑冇壞：`scan_history` 最新三行 03:01:11Z／03:01:34Z／03:02:00Z（tick 每 ~25–30s 完成 flush）。

### 5.4 §2.4 嘅新儀器要下一次 deploy 才讀得到
`dbStmts`／`dbCalls`／`dbStatements` 係新增欄位：deploy 之後嘅驗收讀數係
`/debug/tick-legs` 任何一行有 `dbStmts`（非 null），而同一個回應嘅 `/health.dbStatements.stmts` 會隨時間上升。

## 6. 限制（唔可以當過）

- **§2.1／§2.2 已 deploy 並 live 核對**（§5.3）；**§2.4 嘅新儀器（`dbStmts`／`dbStatements`）未 deploy**：
  佢嘅證據目前只到「代碼＋測試」（typecheck 過、新測試釘住 ring 同 /health 嘅接線）。驗收讀數見 §5.4。
- **跑過嘅檢查**：`npm run typecheck`（`tsc --noEmit`）＋ CI 條鏈嘅全部 suite
  （`test-unit` **550**、`test-deferred-priority`、`test-tick-path`、`test-schema-gate`、`test-health-front`、
  `test-dex-list-cache`、`test-usd-formatter`、`test-dex-last-profiles`、`test-tick-legs` 9、
  `test-unconfirmed-cards`、`test-d1-transport` 11、`test-d1-migrate` 18），全部 0 failed。
- **`npm test`（`scripts/test-filters.js`）今次真跑過**（§3.4，local 模式，exit 0）：
  phase 1／2／3 全行，寫入路徑（註冊、DDL、`runOnce`）真跑。**archive 模式仍然只可以明加
  `--allow-archive-write`**，而嗰條路今次**冇跑** —— 即係「寫凍結 archive」嘅路徑依然未驗。
- **queries／tick 由 deploy 之後改讀 per-tick 嘅 `dbStmts`**（§2.4）；今日嘅 ~75 係 24 小時平均上界。
- **`subs` 讀數偏低**：D1 call 唔經 `fetch`，所以 `subreqView()` 數唔到（§3.5）；未改，因為它係決策輸入。
- **D1 單線程**：一個 tick 內多個請求會排隊，所以單次 call 嘅 `max` 唔代表成本（睇每 tick 加總）。
- 樣本細：`/debug/db-latency` 每個 op 5 個 sample，`tick-legs` 5 個 tick。
