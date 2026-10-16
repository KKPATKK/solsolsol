# 2026-10-16 D1 之後仲剩咩 request：一張實測清單（同一個讀錯嘅糾正）

前提：讀寫已全喺 D1（`docs/d1-migration-2026-10-15.md`），距離同 request 形狀已經執過兩次
（`docs/d1-efficiency-2026-10-15.md`：placement 去 DFW ＋ `Db.runChunked`）。呢份文件答
「仲有咩可以 trim」，同埋**糾正一個用 `writeCensus` 讀錯出嚟嘅結論**。

## 0. 結論

| # | 讀數 | 意思 |
|---|---|---|
| 1 | **同一個 429／同一個 pass 嘅靜態行，早就係一個請求** | 「pass 內冇宣佈 transition 嘅行累積到尾一次 batch」**已經喺 code 入面**（`silentChecks` → `Db.claimPushWatchChecksMany`），2026-09-25 已經有讀數釘住（`src/tickprobe.ts:1402`：「`claimPushWatchChecksMany` pipelines ~28 CAS statements into one request, and the pass note reads `rows 282/1`」）。今日再量：`dbSteps.claimPushWatchChecksMany calls=3`（＝3 個 pass，一次一個請求）、pass note `rows 152/3` |
| 2 | **`writeCensus` 數 statement，唔數 request** | 上一輪就係把「`update push_watch` 24–50 行、每行 1 statement」讀成「每行一個請求」→ 差 24–50 倍。census 唔可以用嚟估 request 數 |
| 3 | **request 唔計錢** | Workers Paid 嘅 D1 只按 rows（＋storage）計：`rows_written_24h 949,364`（≈28.5M／月＝內含 50M 嘅 57%）、`rows_read_24h` 13.79M（≈413M／月 vs 25B＝1.7%）。`write_queries_24h 116,442`／`read_queries_24h 97,192` 係 latency／headroom，唔係賬單 |
| 4 | 剩低嘅三條槓桿 | **(a) row 量**（六個 batched writer 加「只在值變動時寫」）、**(b) pass 頻率**（每分鐘 → 每 2 分鐘，pass 嘅 requests／rows 全部減半）、**(c) 非 D1 嘅 tick 時間**（feed 長杆 ＋ pair lane，見 `docs/tick-probe-and-feed-legs-2026-10-16.md`） |

## 1. 糾正：點解「pass 逐行一個請求」係錯嘅

`writeCensus`（`src/db.ts:819` `noteWriteCensus`）每句 statement 記一次
（`{ rows, stmts }`，`stmts += 1`）——**冇 request 呢個維度**。而 pass 嘅靜態行走嘅係：

```ts
// src/pushwatch.ts:4830（現在嘅 code）
// SILENT ROW — nothing to announce ... The row is QUEUED, not written: the whole
// queue goes out as ONE batched request after the loop (see silentChecks and
// Db.claimPushWatchChecksMany).
if (backfill || evalResult.alerts.length === 0) {
  silentChecks.push({ token: row.token, expectedLastChecked: row.lastChecked, backfill, v: checkFields(false) });
  continue;
}
```

```ts
// src/pushwatch.ts:5208（pass 尾；呼叫喺 :5212）
if (silentChecks.length > 0) {
  won = await this.db.claimPushWatchChecksMany(silentChecks.map(...));  // 一個 batch
}
```

`Db.claimPushWatchChecksMany`（`src/db.ts:2209`）＝ `batch()` ＋ 每行一句、每句仍然係
CAS（`WHERE token = ? AND last_checked = ?`），所以係「一行一 statement、**一個請求**」——
同 `Db.repinPushWatchPools` 同款。今日 runtime 讀數：`dbSteps` 見
`claimPushWatchChecksMany calls=3 ms=154 avg=51ms`（3 個 pass ＝ 3 次請求），
pass note `rows 152/3`（row 工作總共 3 個請求）。

而且呢條路**已經有測試釘住**：`scripts/test-unit.js` 嘅
`PushWatcher: one late pass covers all 30 tracked rows in a single batch trip`
（fake `claimPushWatchChecksMany` 數 `batchCalls`）——即係「一個 pass 一個請求」唔係
「未做」，係「做完而且回歸得有人守」。

**仍然逐行（一個請求一行）嘅只剩「有卡要發」嘅 alerting row**：`claimAndReservePushWatch`
（claim ＋ reservation 一個 batch）＋ 佢最後嗰筆 `updatePushWatchCheck`
（`src/pushwatch.ts:5176`）＋ 輸咗 reservation 嗰筆（`:4905`）。呢啲**唔可以**合批：
reserve-then-send 唔可以被切斷，`src/scanner.ts:755-784` 已經寫明（一條 row 嘅
claim／send／rollback 有自己嘅 leashes，rollback 一定要即時落地先算冇 silent miss）。
alerting row 一日幾多？睇 `/health.summary.pushed`／`alerts`，今日樣本多數 `alerted 0`。

## 2. 今日嘅 request profile（實測 2026-10-16 02:3xZ）

`/health.heartbeat.summary.dbSteps`（**per isolate、累計**；我呢個 isolate 一生 93 次 call／
4,060ms，其中 6 次 `writeScanFront` ≈ 6 個 tick）：

| method | calls | ms | avg |
|---|---|---|---|
| `getWorkerStates` | 21 | 598 | 28ms |
| `writeScanFront` | 6 | 333 | 56ms |
| `findUntrackedPushesAndLedger` | 5 | 194 | 39ms |
| `getPushAudit`（＝`getWorkerState:push_audit`，同一請求）| 5 | 218 | 44ms |
| `setWorkerState:push_watch_pass` | 5 | 296 | 59ms |
| `claimScanLock` | 4 | 277 | 69ms |
| `readScanFront` | 4 | 65 | 16ms |
| `getTokenStatsMany` | 4 | 74 | 19ms |
| `claimPushWatchChecksMany` | 3 | 154 | 51ms |
| `setWorkerState:tick_progress` | 3 | 213 | 71ms |
| `persistScanCompletion` | 3 | 246 | 82ms |
| `readPostScanTelemetry` | 3 | 112 | 37ms |
| `releaseScanLock` | 3 | 56 | 19ms |
| `recordTokenStatsMany` | 2 | 296 | 148ms |
| `updateTokenMaxMcaps` | 2 | 147 | 74ms |

同一時間嘅 tick 側：`dbTickSteps` 76–145ms/tick（`writeScanFront` 50–110ms 最大），
`dbMs 0`，tick `ms` 1,655–2,662。

**已經係「一個請求」嘅（唔使再碰）**：

- `Db.claimScanLock`（`src/db.ts:3748`）：claim ＋ `scan_heartbeat` ＋ dead-tick history
  ＋ cron tick ＋ `tick_progress` 入場印，全部一個 batch。
- `Db.stampScheduledArrival`（`src/db.ts:1978`）：2 句、1 個請求。
- 六個 row-count writer（`docs/d1-efficiency-2026-10-15.md` §3）：`recordTokenStatsMany`／
  `recordObservedLiquidity`／`updateTokenMaxMcaps`／`noteSweptWithoutReading`／
  `upsertPushWatchMany`／`recordPushedHolders`。
- `Db.claimPushWatchChecksMany`（上面 §1）、`Db.repinPushWatchPools`。

## 3. 睇完之後仍然剩低嘅（排序＋為何唔係「即改即賺」）

1. **row 量（`rows_written`，57% of 50M／月）**：六個 writer 可以加「只在值變動時寫」
   （`recordObservedLiquidity` 郁過門檻才寫、`noteSweptWithoutReading` 改 per-slot stamp、
   `updateTokenMaxMcaps` 只在新 peak、`recordTokenStatsMany` 只寫有變嘅欄）。
   **要 per-writer 量先 size**——今日冇 per-writer rows counter（`writeCensus` 係 statement
   級、per isolate、亦會被我嘅 `/health` 讀污染）。而家超額 $0，屬 headroom 衛生。
2. **pass 頻率**：每分鐘一次 → 每 2 分鐘（或只做「mark 過 N 秒」嘅行）會把 pass 嘅
   requests（~1–3/pass）同 rows（~24–50/分鐘）同時減半；代價係卡上狀態／價格更新變
   2 分鐘一次——係最實在嘅產品代價，所以唔係默認選項。
3. **`claimScanLock` 兩趟**（`/debug/db-latency`：`claimShapeTwoTrip p50 108ms` vs
   `claimShapeOneTrip 21ms`）：嗰趟第二程係**必須**嘅——`INSERT ... ON CONFLICT DO NOTHING`
   之後要讀返行先知道贏唔贏（單飛鎖「冇寫＝冇做」）。要合一就要改鎖嘅語意，唔係順手改。
4. **`getWorkerStates` ~3.5 次/tick（28ms 一次）**：已經係一次多 key 讀；
   `docs/d1-efficiency-2026-10-15.md` §5.2 已經判過「唔值得為咗合併而改鎖／順序」。
5. **其餘單發（`setWorkerState:push_watch_pass` 59ms、`tick_progress` 71ms、
   `readPostScanTelemetry` 37ms、`persistScanCompletion` 82ms）**：各 1 次/tick，
   冇一個值得為幾十 ms 去動 tick 嘅次序（呢啲正正係 2026-09-26 已經把五個
   `tick_progress` stamp 併入 claim 之後剩返嘅）。
6. **`getPushAudit` 同 `getWorkerState:push_audit` 係同一個請求嘅兩個 label**（calls／ms
   完全一樣：5/218）——`src/tickprobe.ts` 就係為咗避免雙重計數而排除 wrapper。
   唔係「兩個請求」。

## 4. 限制（唔可以當過）

- `dbSteps` 係 **per isolate、累計**，而且**我自己 curl `/health` 嘅讀都會計入**同一個
  isolate；所以「93 次 call」唔可以除成「每 tick 幾多次」，只可以當形狀睇。
- `/debug/db-latency` 同 `dbSteps` 都係「落到邊個 isolate 唔受控」；`select1 p50 22ms`
  呢個讀數同日仍然係 14–22ms 級（距離已塌）。
- 呢份文件**冇改任何 code**：第 1 條嘅結論係「已經做咗」，第 3 節每一項都寫明為何
  唔係「即改即賺」。下一件值得做嘅係第 1 節（row 量）＋先加 per-writer 讀數。
