# 唔付費路線：減 invocation 內嘅 Turso round trip

> 背景：一個 cron tick 嘅**真·硬上限**係 Workers Free 嘅 **50 subrequests per invocation**，
> 而呢個 bot 嘅 Turso 走 HTTP transport（`src/db.ts` `createRawClient`），所以**每個 DB round trip
> 都係一個 subrequest**。爆預算之後，下一個 fetch／DB call 直接 throw，而 tick 尾段所有寫入
> （history row、`phase:done`、note、heartbeat）都係 best-effort ⇒ 一次性解釋晒 dead tick、
> note 停在 `running`、`err:Too many subrequests`、`lost_completion_write`。
> 診斷全文見 `docs/scan-completion-loss.md` 嘅「2026-09-23：dead tick 嘅真身」。

呢份 doc 記低「唔付費」方向第一刀落咗嘅 code（2026-09-23，未 push／未 deploy）。

## 1. 改咗邊五個位

| 位 | 之前 | 現在 |
| --- | --- | --- |
| cron 到達記錄（`scheduled_tick_total` / `_at` / ring） | 自己一個 raw client：**1 read + 1 write**（線上量到 `bump 564–2211ms`） | 讀搭 cadence gate 嗰個 read（`Db.getWorkerStates` 一次讀 2–3 個 key）；寫搭 scan-lock claim batch（`Db.scheduledTickStatements`）。**正常 tick 0 額外 round trip** |
| `init` 同 gate 兩次 heartbeat read | 2 次（同一行 `scan_heartbeat`） | 1 次（`lastHeartbeatRead` ＋ `HEARTBEAT_REUSE_MS` = 2s 重用窗口；`maybeRunScanIfStale` 都用同一個） |
| pass 嘅 recap claim ＋ prune | 2 次（`markRecapClaimedMany` ＋ `prunePushWatch`） | **1 次**（`Db.claimRecapsAndPrune`：claim UPDATE 同 bulk DELETE 同一個 batch） |
| pass 嘅 heal 開場讀（untracked ＋ push-baseline ledger） | 2 次（而且 ledger 讀只喺有料返時才付，即係最貼近 budget cut 嗰一刻先加一個 subrequest） | **1 次**（`Db.findUntrackedPushesAndLedger`） |
| pass 嘅 holder 寫入 | N 次（每個 probe 一次 `setPushWatchHolders`） | **1 次**（`Db.setPushWatchHoldersMany`，loop 完一次 flush） |

claim / prune / heal / holder 呢四項，全部係 `src/pushwatch.ts` 嘅 deep call site，改動記錄喺
`docs/patches/tracker-pass-batched-consumer.apply.js`。

## 2. 唔變嘅保證（呢啲係卡片正確性嘅底線）

* **claim-before-send**：recap 卡仍然係「claim 咗才發」。claim 只係由「獨立一個 request」
  變成「同 DELETE 同一個 batch」——按 libsql 嘅語意 batch 係**一個 request、statement 依序執行**，
  所以 claim 一樣喺發卡之前完成。
* **`expired` CAS**：claim 嘅 guard（`last_state NOT IN ('expired','unwatched')`）一字不改 ⇒
  第二個 isolate 拎唔到同一個 claim，唔會重複發 🏁 卡。
* **prune 只會收窄唔會放寬**：DELETE 用同一個 `windowCutoff`；而且以前「claim 成功但 prune 未跑」
  嘅窗口冇埋（同一個 batch 一齊 land 或者一齊唔 land），冇可能出現「行被刪但張卡冇出」。
* **park 語意**：probe 冇 count（timeout／無資料／throw）即刻 park 該行；batch 被拒就 park
  佢覆蓋嘅每一行 —— 同以前「單行寫入失敗」到達嘅狀態一樣。
* **holder 每行嘅數值同 cadence**：一行一個 count、一行一個 `holders_checked_at`，唔變。
* **trips 讀數唔會講大話**：`note` 尾嘅 `trips` 係由 pass 自己按「實際 await 咗幾次」數出嚟，
  test 有一條 `assert.equal(out.trips, calls.total)` 釘住（fakes 已跟新 shape）。

## 3. 落線點驗

`/health.pushWatchPass.note`（或 `/debug/tick` 嘅 pass 讀數）：

1. `trips N` 比同類 pass 低 3–5（setup −1、heal −1、holders −(N−1)）。
2. `spent.holders.trips` = 1（note 嗰段 `holders <ms>/<trips>`）。
3. `/debug/tick.summary.preTick.steps.bump` 唔應該再出現（正常 tick 搭住 claim batch 走；
   只有 `!scanner`、gate 讀失敗、或 claim 拎唔到 lease 嘅路徑才會 fallback 用 legacy bump）。
4. `summary.pushWatch` 唔應該再出 `err:Too many subrequests`；
   `/debug/push-watch.issues` 唔應該再增加 `lost_completion_write`。
5. 卡片方向：`dup-skip` 唔應該上升（呢批改動冇新增任何「唔送」出口）。

## 4. 未做（同一條 audit 剩返落嚟）

* pair 階段嘅重複讀。
* row loop 每行嘅 `claimPushWatchCheck` / `reservePushWatchAlert` / `updatePushWatchCheck`
  —— 每個 silent row 一次，暫時當係必要嘅 per-row CAS（要改就要預先 batch 拎 claim，
  再入 loop 消費，屬下一步）。
* `bumpScheduledTick` 本体仍然留喺 `Db`（legacy fallback 用），冇再喺正常 tick 出現。

## 5. 驗證狀態（本地）

* `npm run build`（tsc）✅
* `node scripts/test-unit.js` → **275 passed, 0 failed** ✅（fakes 已跟新 shape，
  `trips` invariant 仍然釘住）
* `node scripts/test-deferred-priority.js` ✅、`node scripts/test-tick-path.js` ✅

## 6. 點解要一個 script 落呢個改動

`src/pushwatch.ts`（148KB）同 `scripts/test-unit.js`（454KB）都遠超檔案工具嘅編輯窗口：
第 ~1000 行（約 50KB）之後，`str_replace` 一律答「old string not found」（逐行 probe 過，
`docs/patches/tracker-pass-batched-consumer.apply.js` 就係因此存在）。所以：

* 改動用 script 落，**兩個階段**：先驗 18 個 replacement 每個都**只可以唯一命中**，
  有任何一個唔中就跑都唔跑、直接 exit 1（唔會出現半套改動）。
* 記錄留底喺 `docs/patches/`（同 `poolfallback.ts`、`getReevalPoolBatched` 一樣，
  呢個 repo 一直有呢類「deep call site 要繞路」嘅處理）。
* 落完之後用 `git diff` + `tsc` + 三個 test suite 驗，唔靠腳本自己講。
