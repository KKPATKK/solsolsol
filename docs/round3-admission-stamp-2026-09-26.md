# Round 3：admission stamp 騎上 scan-lock claim（2026-09-26）

承接 §4.20（round 2）。round 2 收咗 cold init、tracker pass entry、RUNNING stamp 三刀，順手令
census 嘅 label 帶埋 key（`getWorkerState:<key>` / `setWorkerState:<key>`），所以「下一輪應該
郁邊個」變成有數可依。

## 量到咗乜

2026-09-26 01:50–02:05Z（deploy run `36209665481` 之後）嘅 `/debug/tick` census，累積 delta：

    setWorkerState:tick_progress           +5 / tick   ← 排頭
    getWorkerState:trade_mode_override     +1..2
    getWorkerState:scan_heartbeat          +1..2
    …（其餘各 1）

`setWorkerState:tick_progress` 就係 phase ladder（`tickPhaseLadder`）——「一個 tick 行到邊」嘅
durable trail，係 /health 同死 tick 診斷嘅唯一證據。五個 stamp 係：admission（`scan`）＋
front／pair／gate ＋ postscan。per-tick 窗只讀到 1–3，係因為 trail 係「queued、never awaited」，
最後幾個 stamp 喺 census 讀完之後才落。

## 今次合併咗乜

**admission stamp 騎上 scan-lock claim batch**（`Db.claimScanLock` 第 7 個參數
`tickProgressJson`）。

理據：admission stamp 嘅全部內容＝「呢個 tick 被接納、仲未入 scan」。而 claim batch 本身已經寫住
呢件事——同一個 batch 內嘅 heartbeat upsert 就係 `{at: startedAt, phase: "scanning"}`，同一個
`at`。所以呢個 stamp 由「自己一個 round trip（claim 之後 ~150ms）」變成免費：**每 tick 少一個
request**，而且 admission 嘅讀數同 claim 原子咁一齊落，唔會再有「claim 贏咗但 stamp 未到」嘅窗。

**守衛（同 historyStmt 一樣嘅 EXISTS 慣用法）：**

    INSERT INTO worker_state (key, value)
    SELECT 'tick_progress', ?
    WHERE EXISTS (SELECT 1 FROM worker_state WHERE key = 'scan_lock' AND value = ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value

（`INSERT..SELECT` 嗰個 `WHERE` 係兩個作用：SQLite 嘅 UPSERT parser 要佢嚟 disambiguate
`ON CONFLICT`，而佢本身又係守衛。）只有**本 tick 自己嘅 lock value** 在位先寫得入，所以輸咗
lease（= 跳過咗 scan）嘅 tick 唔可能 stamp 一個佢冇行到嘅 phase。claim batch 係 transaction：
被拒 = stamp 跟住 claim 一齊冇，即係 pre-merge 形狀（冇 claim、冇 admission 讀數）。

claim 有三條 arm 可以帶額外 statement（win／row-vanished retry／stale-holder takeover），三條都
收 admission stamp——守衛喺三條 arm 都係同一個 lock value，所以「冇贏但 stamp 落咗」係寫唔出嚟。
`winBatch` 嘅空檢查亦加咗 `progressStmt`，令「只有 stamp 冇其他 statement」嘅 claim 都會行 batch
路徑。

**代價／已知取捨**

- 冇贏 lease 嘅 tick：ladder 嘅第一個寫入變成 scan 嘅第一個 phase（或 postscan record）——
  同「一個從未入到 scan 嘅 tick」一樣嘅形狀，死 tick note 沿路搵上一個 stamp 嘅行為不變。
- 讀數本身冇損失：admission 嘅「at」仍然係 `startedAt`（claim 傳落去），只係落地時間由
  claim 之後變為 claim 之中。
- `tickProgressNote` 對未量度嘅 preRace（admission record 嘅 `preRaceMs: 0`，因為 pre-race
  split 係 claim 返嚟之後才算）改印 `preRace n/a`，唔會扮成「一個唔使時間嘅 phase」。

## 改咗嘅檔

`src/db.ts`（`claimScanLock`：新參數、`progressStmt`、三條 arm）＋ `src/worker.ts`
（claim call site 建 `admissionRecord` 並傳落去、ladder 唔再 `notePhase("scan")`、note 嘅
`preRace n/a`）。落線：`docs/patches/round3-admission-stamp-2026-09-26.apply.js`（9 edits，
verify-then-write）；測試更新：`docs/patches/round3-admission-stamp-tests-2026-09-26.apply.js`。

## 驗收

本地：`npm run typecheck` clean；`npm run test:unit` **354 passed / 0 failed**（前值 353）。
測試改動：`tick-progress-record.apply.js` 嘅 guard 由 pin `notePhase("scan")` 改為 pin「record
喺 claim 前建好、傳入 claim」＋hook wiring/unwiring 照舊；新增一條 round-3 out-of-window guard
（三個 arm、guarded SQL、call site、`preRace n/a`）。`npx wrangler deploy --dry-run` 過。

落線後（`/debug/tick` 嘅 census 累積 delta）：

- `setWorkerState:tick_progress` 由 **5 → 4**／tick（admission 唔再自己一個 request）。
- `tick_progress` 行嘅 `at` 應該同 `scan_heartbeat` 嘅 `at` 差 < 10ms（同 claim 一齊落）。
- `preRace n/a` 出現在 admission record 嘅 note 上（有 preRace 數嘅 postscan record 照舊 `nms`）。
- `getWorkerState` / `getWorkerStates` 讀數不變；`budgetDrops` / `dropsByLeg` 不變。
