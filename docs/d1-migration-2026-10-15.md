# 2026-10-15 由 Turso 搬去 Cloudflare D1（寫＋讀），Turso 轉唯讀 archive

## 0. 為何要搬（實測數字，唔係估）
免費 plan 係 **10M rows written／月（333k／日）**，而實測（Turso usage API，15 分鐘窗口加總）：

| 日 | rows_written | 對免費額度 |
|---|---|---|
| 10-14（全日） | **624,463** | 1.87× 超支 |
| 10-15 d1 之後（01:19→03:27 乾淨窗口） | 25,356／小時 → 608k／日 | 1.83× 超支 |
| 10-15 d4 之後（04:10→05:15，校正已剔） | 22,021／小時 → 528k／日 | 1.59× 超支 |

⇒ 10-14 嘅 call-level 裁剪**冇削到賬單**（詳見 `turso-write-trim-2026-10-14.md` §7）。賬號**已經係 Workers Paid（$5）**，而佢內含 **D1 50M rows written／月**（之後 $1/M，同 Turso 超額同一單價）——即係搬去 D1 係「用已付嘅 $5 換走超額」，唔係再省。

讀取唔係理由：實測 rows_read ≈ 13.5M／日（~405M／月），Turso 免費 500M／月（已用 81%），D1 Paid 內含 25B／月（佔 1.6%）。**讀喺兩邊都幾乎免費，所以唯一嘅問題只有寫。**

## 1. 搬嘅形狀：同一個 state machine，換一個 store
`Db` 全個檔案只靠兩個 call 同兩個欄位：

- `execute({sql, args})`、`batch([...], mode)`；結果讀 `rows` 同 `rowsAffected`。

呢個就係 seam（`src/db.ts` 嘅 `SqlStatement`／`SqlResult`／`SqlTransport`）：
- **libsql 路徑唔變**（`asSqlTransport(Client)`），Node 入口、scripts、離線測試 suite 照舊用 local `file:` DB。
- **D1 路徑**（`src/d1.ts` `createD1Transport(env.DB)`）把 binding 譯成同一形狀：
  - `{results, meta.changes}` → `{rows, rowsAffected}`。**刻意用 `meta.changes` 而唔係 `meta.rows_written`**：D1 嘅 `rows_written` 會計埋 index entry，而 write census（`noteWriteCensus`）同所有 `rowsAffected > 0` 判斷都係對 libsql 嘅 `rowsAffected` 校準，用錯欄位會令 census 靜靜地翻倍。
  - `SELECT/WITH/PRAGMA` → `all()`；其餘（INSERT／UPDATE／DELETE／DDL）→ `run()`（binding 比 libsql 嚴，DDL 走去 `all()` 會 throw）。
  - `batch()` 用 D1 自己嘅 transactional batch（同 libsql batch 同語意：順序、全有全無）——`claimScanLock` 呢類「冇寫就等於冇做」嘅單飛鎖靠呢點。

**兩個 store 唔會混用**：成個 state machine 都係 read-after-write（單飛鎖、`seen_tokens` 防重推、tracker 每行 CAS、pool 讀同 tick 自己寫嘅 `token_stats`）。所以「寫 D1、讀 Turso」係行唔通嘅設計，一混就係重複推卡／重複 ⚠️ 卡；`env.DB` 一出現，**所有**讀寫都去 D1。三個 pre-init 單發寫入（cron counter、`/debug/pool` probe、arrival stamp）都改行 `standaloneDb(env)`，跟同一個 store——唔會偷偷寫返 archive。

## 2. 唯一穿透到 SQL 嘅差異：D1 每 statement 只准 100 個 bound parameter
libsql 冇呢個限制（SQLite 預設 32,766），所以本 repo 有幾個「一個 statement 綁幾百個參數」嘅寫入。`Db.paramLimit()` 依 transport 回 100 或 32,766，五個寫入改成按 `chunkForParamLimit(rows, argsPerRow, limit, cap)` 切：

| 寫入 | bindings／row | D1 每 statement | libsql（原狀） |
|---|---|---|---|
| `recordObservedLiquidity` | **5**（SET 嘅 CASE pair ＋ IN ＋ WHERE 再綁一次 CASE） | 20 行（100） | 120 行（600）— 兩個 statement |
| `recordTokenStatsMany` | 12 | 8 行（96） | 200 行（2,400）— 一個 statement |
| `updateTokenMaxMcaps` | 7 | 14 行（98） | 60 行（420）— 一個 statement |
| `upsertPushWatchMany` | 9 | 11 行（99） | 一次過 |
| `noteSweptWithoutReading` | 1 | 100 | 120 |
| `recordPushedHolders` | 7 | 14 | 一次過 |

`cap` 保留原本嘅行數上限，所以 **Turso 嘅 round-trip profile 完全不變**（切得太細會喺 Turso 白加 subrequest）。

**第二條規則（2026-10-15 第一次真 seed 撞到）**：D1 嘅 statement 上限係 **SQL 文字 100 KB**
（workerd 直接套 sqlite 嘅 `SQLITE_LIMIT_SQL_LENGTH`；SQLite 對「大 value」嘅建議本身就係綁做 parameter，
見 cloudflare/workerd#3049），**唔包** bound parameter；單一 value／row 上限係 **2 MB**。
當日 `scripts/d1-rest.js` 嘅 `planRequests` 把 SQL ＋ params 一齊量，所以 `worker_state`
（67 行、合共 ~323 KB 嘅 JSON blob ring，最大一行 `push_audit` 33 KB）連一行都寫唔出：
`statement is 335048 bytes, over D1's 100000-byte limit`——而 D1 其實收得落（處理器只收到 2 MB）。
修法：**per-statement 只量 SQL 文字**（`sqlTextBytes`）；**per-request 先量 SQL＋params**
（`MAX_REQUEST_BYTES` 1 MB 係自訂嘅運輸界線，唔係 D1 規則），另加 D1 文件明寫嘅 **2 MB／value·row**
檢查（copy 會指名 rowid，因為呢個冇任何 chunking 救得到）。`--dry-run` 亦改成**照 plan requests**
（乾跑唔 plan 就係 37.9s 乾跑都睇唔到呢條死因嘅原因；順帶第一次跑就快捉到一個 `{sql,args}`／`{sql,params}`
未 normalize 嘅錯），`scripts/test-d1-migrate.js` 加咗一條 150 KB 嘅 `worker_state` row—用舊規則會紅
（mutation 實測：`statement is 189037 bytes`）。

## 3. 已經落地嘅檔案
**Worker／state machine**
- `src/d1.ts`：`createD1Transport`、`normalizeD1Result`、`chunkForParamLimit`、`D1_MAX_BOUND_PARAMS`，同一個唔靠 `@cloudflare/workers-types` 嘅 binding 型別。
- `src/db.ts`：seam ＋ `paramLimit()`；`connect()`／`ensureScanClient()`／`get()` 行 transport；D1 模式下 scan client 同主 client 係同一個。
- `src/worker.ts`：`Env.DB`（binding 出現＝切換掣）；主 init 用 `env.DB`；三個 pre-init 單發寫入行 `standaloneDb(env)`。

**遷移／維運（全部都係同一套規則，冇第二份真相）**
- `scripts/d1-rest.js`：D1 嘅 REST client（`/accounts/{acct}/d1/database` list／create，`/{uuid}/query`）＋ 一個 **binding 形狀**嘅 adapter（`prepare/bind/all/run/batch`）。所以遷移係行 `src/d1.ts` 自己嘅 transport、自己嘅 100-param 規則、自己嘅 `{results,meta.changes}` 翻譯。
- `scripts/d1-copy.js`：`ensure`（DB 存在／建立）、`schema`（**跑真嘅 `Db.init()`** 落 D1）、`seed`、`catchup`、`verify`。表清單／欄位／primary key 全部由「本地跑一次真 init」再 `PRAGMA table_info` 讀出，唔手寫；statement 尺寸用 `chunkForParamLimit`；`--dry-run` 可以只讀 archive 唔寫任何嘢。
- `scripts/d1-bind.js`：把 `[[d1_databases]]` 寫入**runner 自己嘅** `wrangler.toml`（repo 唔 commit database id）。
- `scripts/test-d1-migrate.js`：用「真 SQLite 引擎 + 假 D1 REST API」跑完整 copy，斷言冇 statement 超 100 params、upsert／ignore 兩個模式嘅語意（ignore 唔可以覆蓋 D1 較新嘅 row）、schema 真係落咗、partial copy 會被 `verify` 捉到；再加 CI wiring 嘅斷言（見 §5 尾）。
- `scripts/test-d1-transport.js`：D1 binding 形狀 ＋ 五個寫入嘅 parameter ceiling（同 libsql 形狀不變）。

**實測（2026-10-15，`node scripts/d1-copy.js seed --dry-run` 對真 archive 跑，只讀唔寫）**
9 張表、**116,598 行** → **16,871 個 statement**（token_stats 57,889 行 → 11,578 個；scan_history 56,670 → 5,214；seen_tokens 1,212 → 39），每個 statement 最多 100 個 binding，讀完 archive 用 **37.9s**。D1 每 request 50 個 statement → 約 340 個 request，離 1,200／5 分鐘嘅 token 限額好遠。（行數每分鐘都變，數字只作量級參考。）

## 4. 切換：`deploy.yml` 三個 job（`migrate` → `deploy` → `catchup`）
**憑證**：CI **已經有** Turso 憑證（`backfill-pumpfun.yml`、`axiom-refresh.yml` 一直用 `secrets.TURSO_DATABASE_URL`／`TURSO_AUTH_TOKEN`），所以唔需要新 secret；CF 側就係本身用緊嘅 `CLOUDFLARE_API_TOKEN`（要有 **D1:Edit**）＋ `CLOUDFLARE_ACCOUNT_ID`。

**實測（2026-10-15 08:39Z，第一次 push 去 main）**：`migrate` 喺第一步 `ensure` 就死，
`GET /accounts/<acct>/d1/database → HTTP 401 (10000 Authentication error)`。**同一個** secret
喺 04:12Z 嘅 deploy run 仲係成功（`wrangler deploy` ＋ 三個 `wrangler secret put` 全綠），
即係「wrangler 過得」唔等於「D1 過得」：Cloudflare 嘅 "Edit Cloudflare Workers" 模板**冇** D1 權限，
而 D1 REST 要 **Account > D1 > Edit**。`401 / 10000` 呢個碼本身分唔開「憑證唔 valid」同
「憑證冇 D1 權限」（cloudflare/workers-sdk#9320 就係呢個形狀：deploy 成功、D1 call 被拒），
所以 `scripts/d1-copy.js` 喺 401/403 嘅失敗路徑會再問一次 `/user/tokens/verify`（唔需要 account、
唔需要額外權限）：答 `active` ＝ 憑證有效、係權限問題；答唔到 ＝ 要換憑證。呢個 hint 由
`scripts/test-d1-migrate.js` 釘住（401 嘅真實形狀：D1 route 401/10000 ＋ verify 400）。

**點加 `D1:Edit`（2026-10-15，dashboard 位置記低，下次唔使搵）**：Cloudflare 右上角頭像 →
**My Profile → API Tokens**（account-owned token 就係 **Manage Account → Account API Tokens**）→
該行 `...` → **Edit** → Permissions 區 **+ Add more** → 三個下拉揀 `Account` ／ `D1` ／ `Edit`
（**只 Read 唔夠**：Cloudflare release note 講明 HTTP API 寫 D1 要 `D1:Edit`）→ 順手確認
**Account Resources** 包住 `CLOUDFLARE_ACCOUNT_ID` 嗰個 account → **Continue to summary** → **Save**。
權限**即時生效**，token 值唔變、GitHub secret 唔使換，所以只需要重跑一次 workflow。

1. **migrate**（`timeout-minutes: 45`）：`ensure` → `schema` → `seed`。`ensure` 用 `wrangler` name 搵 DB（`solana-meme-bot`），冇就 create，uuid 交去下一個 job（`outputs.database_id`）。
2. **deploy**：照舊 typecheck＋全套測試，然後 `scripts/d1-bind.js` 注入 binding，再 `wrangler deploy`。**binding 出現就係切換**：D1 未 seeded 就 deploy 唔到（job 依賴 migrate），所以 prod 永遠唔會指住一個空 DB。
3. **catchup**：deploy 之後跑，把 copy→deploy 呢段窗口寫入嘅行補落 D1（**只插入、唔覆蓋**）。

**兩個 marker（`worker_state`）決定邊個 pass 要跑**
- `d1_seed_v1`：`seed` 完成後寫。之後嘅 deploy 唔會再 seed——archive 已經凍結，再 upsert 落去就係拿舊嘢倒灌 live D1。**seed 失敗就唔會 stamp，job 亦唔會 deploy。**
- `d1_cutover_v1`：`catchup` 完成後寫。之後兩個 pass 都係 no-op，只剩 `verify` 嘅行數報告。

**窗口語意（要記住嘅一句）**：deploy 之後，**D1 係新過 archive**。所以 catchup 只可以 `INSERT OR IGNORE`——覆蓋就會把 live state（tracker `up_stages`、push-audit ring、`seen_tokens` 認領）倒返去幾分鐘前，而重複推卡正正係呢個方向嘅產物。窗口最多幾分鐘，漏嘅係「D1 已有、archive 較舊」嘅欄位值，會由下一個 tick 自己寫返（`token_stats`）或由每小時嘅 `reconcileTelemetryCounts` 校正。

**萬一中間死咗**
- seed 死 → marker 冇 stamp → 下次 push 由頭再做（upsert 冪等，安全）。
- deploy 死（seed 已 stamp）→ 下次 push 直接 deploy，catchup 用 ignore 補返整段漂移（唔會倒退 live 值，只會保留 seed 時嘅舊值，之後自己收斂）。
- catchup 死（已 deploy，即係已經切咗）→ 手動再跑：**Actions → Deploy Worker to Cloudflare → Run workflow → catchup = true**（`FORCE_CATCHUP`）。呢個係唯一嘅安全重跑掣；`--force` 嘅 seed 唔會由 workflow 提供，因為佢會覆蓋 live D1。

**驗證**：每個 pass 都印每個表嘅 `read`（copy 開始時 archive 幾多行）／`archive`（而家）／`d1`。
- `seed` 用 **strict**：D1 一定要 ≥ `read`（即係 copy 真正讀到嘅行數），另外 assert **每個表 `rowsAffected` == 讀入行數**——upsert 每一行（新增或更新）都算一個 change，所以少過就代表有 statement 靜靜地冇做。
- **點解同 `read` 比而唔係同「而家嘅 archive」比**：seed 嗰陣 bot 仲寫緊 Turso（deploy 未發生），archive 一路增長（每個 tick 都有 `scan_history`、每次推卡都有 `seen_tokens`、pool 不停改 `token_stats`）。同讀完之後嘅 archive 比，就等於要求 copy 交出一啲佢根本冇見過嘅行——**會令唯一一次應該成功嘅 run 失敗**。copy 只可以為佢讀過嘅嘢負責。
- 之後嘅 pass 只報告（唔 fail）：切換後兩邊已經唔可比——D1 保留「live 年齡窗」會 prune，archive 凍結，而 D1 只會增加。
- **唯一永遠 fail 嘅情況**：`worker_state`／`seen_tokens`／`token_stats` 喺 D1 係空——嗰個意思係指錯 DB（或者 DB 畀人 reset），唔係 prune。

## 5. Turso 轉唯讀 archive：邊啲寫入已經封死
| 寫入者 | 切換後 | 點解 |
|---|---|---|
| Worker（624k rows／日） | **冇** | `env.DB` 一出現，所有讀寫行 D1；`standaloneDb(env)` 亦跟同一個 store |
| `scripts/d1-copy.js` | **只讀** | 由構造決定：只出 `SELECT`／聚合 |
| `.github/workflows/backfill-pumpfun.yml`（手動） | 寫 **D1**，但**唔係自己寫** | 已經轉為跑 `scripts/backfill-pool.mjs` → 打 Worker 嘅 `/debug/backfill`，由 Worker 自己嘅 binding 寫。所以呢個 job **唔持任何 secret**、唔解析任何 database id（2026-10-15 之前佢拿 `CLOUDFLARE_API_TOKEN`）；舊版會喺 pump.fun 403 時靜靜地 skip 成個 run 但報 success，所以 `backfill-pool.mjs` 會 exit non-zero，並用 `/debug/token` 讀返 route 自己報嘅 sample mint（route 講 ok 但行讀唔返＝fail） |
| `scripts/backfill-pumpfun.mjs`（本機，residential egress） | 寫 **D1**（要明寫例外才寫 archive） | 同一個舊 levers 嘅**住宅網絡**版本（pump.fun 擋 datacenter IP）：pump.fun launch feed → `token_stats`。默認經 Cloudflare API 寫 `D1_DATABASE_ID`，冇 id 就 **throw**；要寫 archive 必須明寫 **`--allow-archive-write`** 加 `TURSO_DATABASE_URL`／`TURSO_AUTH_TOKEN` |
| `scripts/axiom-refresh-action.py`（CI，**停用中**） | 寫 **D1** | 已改：有 `D1_DATABASE_ID` 就經 Cloudflare API 讀寫 `worker_state`；冇就 **die**（要寫 archive 必須 `ALLOW_ARCHIVE_WRITE=1`）。理由唔只係一致性：Axiom 每次 call 都換 refresh token，喺 Worker 唔讀嘅 store 度輪換＝直接整死條 session |
| `scripts/pool-read-cost.js`（本機診斷，`index` 模式） | **refuse** | 其餘模式全部只讀；只有 `index` 模式會 `CREATE INDEX`（寫 archive）——要寫必須明加 `--allow-archive-write`（或 `ALLOW_ARCHIVE_WRITE=1`），因為 Worker 自己會在 D1 開 `idx_pool_band_*`（`Db.ensurePoolBandIndex`） |
| `scripts/test-filters.js`（＝**`npm test`**，本機最常跑） | **refuse**（默認跳過 DB 階段） | 呢個唔係讀者：phase 2 會 upsert `token_stats`（rugcheck／trader／min-mcap），phase 3 跑真 `Scanner.runOnce`（`seen_tokens` 認領、`scan_history`）再 `DELETE` 自己寫嘅 `seen_tokens`。所以冇 `--allow-archive-write`（或 `ALLOW_ARCHIVE_WRITE=1`）就完全唔碰 Turso，只跑 phase 1 config 檢查同 phase 2 feed 診斷；`USE_ARCHIVE = Boolean(URL && TOKEN) && ARCHIVE_WRITE_OK` 係 AND，唔係 OR——憑證出現喺環境（本 workspace 就係）唔等於可以寫 |
| Node 入口（`npm start`，本機 dev／離線測試） | 仲係 Turso | 係本地 harness（測試用 injected `file:` client），唔係生產路徑 |

驗證方法：Turso usage API 嘅 rows_written 應該跌到接近 0（唯一例外：有人明寫 `--allow-archive-write`）。

`scripts/test-d1-migrate.js` 會把上面呢張表釘死（包含三個仍然自己寫 store 嘅工具各自嘅 opt-in 護欄：`backfill-pumpfun.mjs`、`axiom-refresh-action.py`、`pool-read-cost.js` 嘅 `index` 模式、同 `test-filters.js`（`npm test`）——後者另外釘住 `USE_ARCHIVE` 一定要係 flag **AND** 憑證；而 pool backfill 嘅 workflow 由**自己嘅一條測試**釘住：只可以跑 `backfill-pool.mjs`、唔准提 `backfill-pumpfun.mjs`、唔准出現 `secrets.` 任何一個）：`deploy.yml` 三個 job 嘅順序／每個 step 有冇收到 `D1_DATABASE_ID`（順便釘住一個真實踩過嘅 bug：第一版 `schema`／`seed` 兩個 step 冇收到 id）、binding 一定要喺 `wrangler deploy` **之前**注入、repo 度唔准出現寫死嘅 `database_id`、而且除咗只讀嘅 copy 之外冇任何 job 拿得住 Turso 憑證。

## 6. 風險同限制（唔可以當過）
- **D1 每個 DB 單線程**，文件上限係 30 秒／batch、100 個 bound parameter／query、100KB／statement（**只計 SQL 文字**，見 §2）、200 萬 bytes／value·row、1,200 request／5 分鐘／token。本 bot 每 tick 約 250 個 statement（已大量 batch），遷移亦只係 ~338 個 request；**Worker runtime 喺真 D1 嘅數字見 §8**：每 tick 嘅 batched call 110–242ms、tick `ms` 3.6–4.8s，比 Turso 同期嘅 1.73s 慢約 2.3×（仍然遠低於 60 秒 cadence）。
- D1 binding call 亦算 Workers subrequest（服務類），所以唔會「省 subrequest」——只係換 quota。
- `SELECT name FROM pragma_table_info(?)`（`addColumnIfMissing` 嘅 batched probe）同 `PRAGMA` 支援係 D1 側要真跑一次先知嘅嘢：`migrate` job 嘅 `schema` step 就係喺真 D1 上跑 `Db.init()`，佢失敗就唔會 deploy（即係 prod 唔會踩到）。
- 搬數期間 archive 仍在寫入，所以 catchup 一定要喺 deploy 之後跑（見 §4 窗口語意）。
- 讀複製（read replication）**唔會**開：只幫讀，而且要用 Session 先讀到自己寫嘅嘢。
- **回滾**：`deploy` step **之前**抽走（或者唔 commit 呢個 workflow）＝零資料損失，Worker 照舊 Turso。**之後**回滾＝由 revert workflow 再 deploy，但會失去 D1 窗口內嘅寫入（重複推卡風險），所以只可以即刻做。

## 7. 落地 checklist
1. Merge（或者手動 `workflow_dispatch`）`deploy.yml` → 睇 migrate job：`created/found D1 database solana-meme-bot (uuid …)`、`schema_tables=9`、`copied=true`、行數表全部 `+0` 或以上。（`ensure` 死喺 `HTTP 401` 就係上面 §4 嘅憑證問題，唔係搬數問題——worker 仲喺 Turso，冇嘢寫過。）
2. 睇 deploy job log：`injected [[d1_databases]] …` 之後 `wrangler deploy` 成功。**呢一刻就係切換。**
3. 睇 catchup job：`d1_cutover_v1` stamp、行數表（archive 同 d1 會唔同，正常）。
4. 15 分鐘後睇 `/health`：`dbOk`、`dbTickSteps`、`writeCensus`、tick `ms`；用 `/debug/pool` 對照 pool 行數（同 archive 唔會一樣，D1 係 live）。
5. Turso usage API：rows_written 應該跌到 ~0。

## 8. 切換實測（2026-10-15，run 38713155760：migrate 1m52s → deploy 1m33s → catchup 2m15s，全綠）

- **`ensure`／`schema`**：`found D1 database solana-meme-bot (uuid e8b4be30-…)`；`schema` **喺真 D1 上跑真 `Db.init()` 成功**，`schema_tables=10`（9 張 bot table ＋ D1 自己嘅內部表）、`schema_ddl_fingerprint=b9f7c39c` ⇒ §6 嗰句「`PRAGMA`／`pragma_table_info(?)` 要真跑一次先知」有答案：冇問題。
- **`seed`**：9 張表 **115,402 行**抄完（token_stats 56,907／scan_history 56,837／seen_tokens 1,212／pushed_holders 346…），每張表 `rows affected == rows read`，`stamped d1_seed_v1 = 09:30:05Z`。第一次跑死喺 `worker_state`（335KB params）——即 §2 第二條規則，修好後同一條 statement 一行 planRequests 就過。
- **`deploy`（＝切換）**：`injected [[d1_databases]] binding="DB" database_id="e8b4be30-…"` → `Uploaded solana-meme-bot (3.94s)` → `Deployed … triggers (0.93s)`；**09:31:35Z 就係切換時刻**。
- **`catchup`**：115,432 行讀、16,694 statements、**只有 12 行 affected**（窗口內 archive 新過 D1 嘅行），`stamped d1_cutover_v1 = 09:33:57Z`；行數表見到方向反轉（token_stats archive 56,932 vs d1 57,665 **+733**；scan_history **+3**）＝D1 係活嘅一邊，archive 已經落後。
- **Turso 唯讀**：archive 最新一行 `scan_history.at = 09:31:23Z`（切換前最後一個 tick）；usage API 嘅 09:35–09:40Z 桶 **`rows_written=0`、`rows_read=0`**（對照同日 09:25–09:30 桶：2,213／263,825）。
- **Worker 喺真 D1 嘅成本**（`/health.heartbeat.summary.dbTickSteps`，placed 路徑 NRT）：`getReevalPool 242ms`、`writeScanFront 144–153ms`、`getTokenStatsMany 123–131ms`、`readScanFront 110–116ms`、`isTokenSeen 109–110ms`（每個＝一次 batched call）；tick `ms` 3.6–4.8s，**比 Turso 同期嘅 1.73s 慢約 2.3×**（仍遠低於 60 秒 cadence）；三次抽樣 `writeDrainError` 都係 `null`、`initError` 一直 `null`、`dbReady true`、tracker lane 正常（`checked 20`）。
- **未量**：D1 每 tick 嘅 statement 總數同 50-subrequest 預算嘅關係（`dbTickSteps` 係 per-method，唔係 per-statement）。

## 9. 切換後兩個修正（2026-10-15，跟 §5 嘅 store 問題同一類）

### 9.1 `/debug/backfill` 嘅 cooldown 改為 durable
呢條 route 每次行 42h Birdeye `new_listing`、花 30–80 CU，所以有 5 分鐘冷卻——但冷卻原本係**module scope 變數**（`let backfillDebugLastRunAt`），而 module scope 喺呢個 Worker 唔等於「一部機」：fleet 由接到 request 嘅 isolate 各自答，新 isolate 讀到自己嘅 `0`，所以「40 秒前跑過」喺另一個 isolate 完全睇唔到，冷卻只擋得住**撞返同一個 isolate** 嘅第二次 call。

改法：stamp 落 **`worker_state.debug_backfill_at`**（全部 isolate 共用一行），即係同 `DEBUG_SCAN_CACHE_*` 同一個理由。兩個細節：
- **stamp 記「嘗試」而唔係「成功」**，而且寫喺 42h 行之前——行到一半死咗都已經花咗 CU。
- stamp 喺**就緒檢查之前**寫，同舊 code 一樣：所以 `birdeye`／`db` 未配置嘅 503 一樣會吃掉冷卻（否則一個配置錯嘅 Worker 可以被人以行頻打）。
- 規則抽成**純函數** `backfillCooldownRemainingMs(stamp, nowMs)`（`src/worker.ts` 匯出）：冇行／讀唔到／非正數 → 0（未跑過，唔應該堵），**未來**嘅 stamp（isolate 之間時鐘偏移）→ 0（唔可以等到時鐘追返），過期 → 0。`worker_state` 讀失敗一律當 0（放行）——佢係閘，讀唔到唔應該令手動 lever 變成永久 429。
- `scripts/test-unit.js` 釘住上面全部 case，另加 route wiring（唔准再出現 module-scope `let backfillDebugLastRunAt`、一定要 `getWorkerState`／`setWorkerState` 同一個 key、429 形狀不變——`backfill-pool.mjs` 靠呢個形狀分辨「良性」）。

### 9.2 `/debug/db-latency` 唔再由 Turso URL 報「當前 store」
呢條 route 原本 `dbRegion: dbRegionFromUrl(env.TURSO_DATABASE_URL)` 係無條件嘅，切換之後就變成報緊一個**呢次 probe 根本冇碰過**嘅 database（`TURSO_DATABASE_URL` 仍然留喺 Worker 做 archive／Node 路徑）。

改法：由 binding 自己報 store——`dbStore: env.DB ? "d1" : "turso"`——而 `dbRegion` 只有喺 **Turso 就係當前 store** 時才由 URL 解析（D1 唔係 `null` 就係假嘅 region，所以寧願 `null` 加一個真嘅 store label）。留意 D1 binding 唔會報邊個 region 服務嗰個 query，所以喺 D1 上面 `colo` 係唯一嘅距離訊號（而 §2 嘅 CAVEAT 亦適用：`colo` 係入口而唔係執行地）。同一條測試（`scripts/test-unit.js`）同時釘住 store label 同「URL 只喺 Turso 模式下解析」。
