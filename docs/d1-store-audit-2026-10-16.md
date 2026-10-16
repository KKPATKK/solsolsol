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
| 8 | read replication | `disabled` | 維持（§5.3） |
| 9 | Time Travel（唯一 DR 路徑） | **有 bookmark**，即係可以還原 | 記落嚟（§5.1） |

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

### 3.2 `writeCensus` 唔可以用嚟量 statement 數
佢係 **per-isolate**（module scope）而且**只計 `rowsAffected > 0` 嘅 statement**，所以「一個 tick 出幾多句」
喺佢身上答唔到（`d1-migration` §8 同 `d1-efficiency` §6 都記住呢點）。今日嘅 tick 讀數仍然係 method 級。

### 3.3 read replication
`disabled`（§1）。佢要 `withSession()`／read-your-writes 手續，而呢個 Worker 係 **read-after-write**
（單飛鎖、`seen_tokens`、tracker CAS、pool 讀同 tick 自己寫嘅 `token_stats`）——
喺 placement 已經釘喺 primary 隔籬嘅前提下，開佢只有風險冇收益。維持，並記住驗收條件：
如果 `served_by_colo` 唔再係 DFW（Cloudflare 可以因維護自動調整 placement），先值得重新討論。

## 4. D1 上限 vs 今日用量（完全冇一個接近）

| 上限（D1 文件／`src/d1.ts` 註解已引用） | 今日用量（§1） | 餘裕 |
|---|---|---|
| 100 bound params／statement | 六個 writer 切到 ≤100；reader 最長 26 | —— |
| 100 KB SQL 文字／statement（唔包 parameter） | 最大 shape 係 chunk 後嘅 INSERT（`d1-migration` §2 有逐個列） | —— |
| 2 MB／value 或 row | `worker_state` 最大 33 KB（push-audit ring） | ~60× |
| 1,000 queries／invocation（Paid） | **~75 句／tick**（216,643 queries／24h ÷ 2,880 ticks） | ~13× |
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

### 5.3 兩個 fix 要 deploy 才生效
到今日為止 `dbStore` 只喺 `/debug/db-latency`、`dbMs` 仍然係 0。**Deploy 之後嘅驗收讀數**：
`/health.dbStore === "d1"`、`/debug/tick-legs` 任何一個 tick 嘅 `dbMs > 0`（同 libsql 側一樣係 scan 嘅 round trip 總和）。

## 6. 限制（唔可以當過）

- **呢兩個 fix 未 deploy**：上面 §2 全部係「代碼＋測試」級證據（build／typecheck 過、mutation 過），
  唔係 live 讀數。Live 驗收要等下一次 deploy，讀 §5.3 嗰兩個位。
- **跑過嘅檢查**：`npm run typecheck`（`tsc --noEmit`）＋ CI 條鏈嘅全部 suite
  （`test-unit` 549、`test-deferred-priority`、`test-tick-path`、`test-schema-gate`、`test-health-front`、
  `test-dex-list-cache`、`test-usd-formatter`、`test-dex-last-profiles`、`test-tick-legs`、
  `test-unconfirmed-cards`、`test-d1-transport` 11、`test-d1-migrate` 18），全部 0 failed。
  **冇跑** `npm test`（`scripts/test-filters.js`）：佢要 DB 憑證而且會寫 archive，冇 `--allow-archive-write` 就唔碰
  （`d1-migration-2026-10-15.md` §5 嘅護欄）—— 即係今次冇驗過佢，唔可以當佢過。
- **queries／tick 係 24 小時平均嘅上界**，唔係 per-tick 量度（per-statement 讀數仍然未有）。
- **D1 單線程**：一個 tick 內多個請求會排隊，所以單次 call 嘅 `max` 唔代表成本（睇每 tick 加總）。
- 樣本細：`/debug/db-latency` 每個 op 5 個 sample，`tick-legs` 5 個 tick。
