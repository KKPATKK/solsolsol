#!/usr/bin/env node
/*
 * Round 6.3, docs: §4.37 in docs/round-trips.md (the readings, the change, the
 * safety argument, the arithmetic, the tests and the live acceptance points)
 * and a §20 section in docs/duplicate-cards.md, because the merge touches the
 * one invariant that file exists to guard.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-doc-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const root = path.join(__dirname, "..", "..");

const append = (rel, label, block, marker) => {
  const p = path.join(root, rel);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${rel}: ${label} already applied`);
    return;
  }
  if (!src.endsWith("\n")) src += "\n";
  fs.writeFileSync(p, src + block);
  console.log(`✓ ${rel}: ${label} appended`);
};

append(
  "docs/round-trips.md",
  "§4.37",
  j(
    "",
    "### §4.37 一張卡 4 → 3 個 subrequest：claim 同 reservation 合併成一個 batch（2026-09-27）",
    "",
    "**動機（live 讀數，2026-09-27T00:07–00:15Z）：**",
    "",
    "```",
    "ok:0/0                deferred:subreq-budget      ← 整個 pass 讓路（scan front 食晒額度）",
    "ok:21/0 rows 21/30 …  defer-send 9  subreq-cut 9",
    "ok:21/1 rows 21/30 …  defer-send 9  subreq-cut 9",
    "ok:13/1 rows 13/30 …  defer-send 17 budget-cut",
    "```",
    "",
    "同一時段 `heartbeat.subreqs.current.total` 讀 **18–36**（usable 38）、追蹤池最舊一行 16 分鐘冇 check、",
    "而卡係出得到嘅（23:57–00:15 之間 10 張：liqwarn×4、w45×3、up200、sell、revive）——即係「出得，但每個 pass 得 0–1 張，9–17 行排隊」。",
    "條路本身係 **4 個 subrequest**：claim CAS、reservation、Telegram send、final write。頭兩個係同一個 row，中間淨係隔一個 `await`。",
    "",
    "**改咗啲乜：** `Db.claimAndReservePushWatch(token, expectedLastChecked, now, fromState, fromAlertAt, toState, alertAt)` ——",
    "ONE `batch()`（`\"write\"`）帶兩句 CAS，次序照舊 claim → reservation：",
    "",
    "1. `UPDATE push_watch SET last_checked = ? WHERE token = ? AND last_checked = ?`",
    "2. `UPDATE push_watch SET last_state = ?, last_alert_at = ? WHERE token = ? AND last_state IS ? AND last_alert_at = ? AND last_checked = ?`",
    "",
    "回傳 `{claimed, reserved}`（逐句 `rowsAffected`）。Call site（`pushwatch.ts` 嘅 alerting path）由兩次 await（`claimPushWatch` ＋ `reservePushWatchAlert`）變成一次。",
    "",
    "**點解唔會漏、唔會重複：**",
    "",
    "- **權威守衛冇變**：仍然係 reservation 嘅 `(last_state, last_alert_at)` CAS —— 兩個 contender 之中只有一句 UPDATE 入到，輸家唔送。",
    "- **新增嘅係「唔可以幫自己冇 claim 到嘅 row 宣佈」**：第二句綁住同一個 batch 嘅 claim stamp（`last_checked = ?`）。",
    "  單靠次序唔夠：如果**另一個 isolate** 喺 caller 讀完之後、batch 送出之前贏咗個 claim，row 身上係對方嘅 stamp，",
    "  呢句就會失配 ⇒ 走返普通嘅 lost-reservation 路徑（hold announcement、寫 measurements、下一個 pass 重新推導）。",
    "- 兩個 isolate 撞正同一毫秒都唔會**兩個都** reserve 到：`(last_state, last_alert_at)` CAS 照舊決定。",
    "- 兩種 loss 分開：**lost claim** ＝ 對方嘅 row ⇒ 原封不動（`claimLost += 1`，span 即時 release）；",
    "  **lost reservation** ＝ row 係我哋但過場已被人宣佈 ⇒ 照舊寫 measurements、announcement 兩欄保持舊值。",
    "- Terminal-row hygiene 嘅不變量（`0 < last_checked - last_alert_at`）完好：兩句仍然寫同一個 `now`，final write 之後再 re-stamp 一個新 `Date.now()`。",
    "",
    "**算術（同一條鏈，少一個 round trip）：**",
    "",
    "- `pushwatch.TRACKER_ALERT_PATH_SUBREQ` 4 → 3（一張卡）。",
    "- `worker.TRACKER_PASS_SUBREQ_RESERVE` 13 → 12（entry 3 ＋ tail 6 ＋ 卡 3）；`scanSubreqLeft` 嘅測試跟住更新（30 → 18、2 → -10）。",
    "- `TRACKER_MAINTENANCE_SUBREQ_FLOOR` 自動跟（6 ＋ 3 = 9）。",
    "- Watchdog 審計：claim＋reserve 由兩個 leash 變一個 ⇒ 7,350 → 5,850（＋pair 1,200 ＝ 7,050）；`TRACKER_PASS_OVERRUN_MS` **照留 8,600** ——",
    "  呢個 bound 嘅唯一職責係捉「冇 bound 包住嘅 await」，而 abandoned pass 正正係 §17.5 嘅 silent-miss class；跟住條鏈收窄要配 live 讀數，唔係騎呢個 merge。",
    "",
    "**測試（5 條新，3 個 mutation 全咬）：**",
    "",
    "- `PushWatcher: an alerting row pays ONE round trip for claim + reservation`（同時釘死兩個舊 call 唔會返生）",
    "- `…a lost CLAIM leaves the row untouched — no send, no write`（`claimLost` 係讀 pulse，唔係 runTick 嘅 return）",
    "- `…a lost RESERVATION holds the announcement and lands the measurements`",
    "- `Db.claimAndReservePushWatch: ONE batch, claim first, reservation bound to its stamp`（fake client：一個 batch、兩句、args 綁 stamp、逐句結果映射）",
    "- `claimAndReservePushWatch: one batch, and a lost claim can never reserve`（**真 DB**；case (c) 專砌「另一 isolate 淨係 claim 咗、未 reserve」——",
    "  拎走 `AND last_checked = ?` 就會變成 `{claimed:false, reserved:true}`）",
    "- Mutation：拆 `last_checked = ?` ⇒ 2 條 fail（SQL pin ＋ 真 DB case c）；`if (!reserved)` 變 no-op ⇒ 1 條 fail；`if (!claimed)` 變 no-op ⇒ 1 條 fail。",
    "- `npm run test:unit` ＝ **406 passed / 0 failed**（369＋6＋5＋9＋4＋13）；`npx tsc --noEmit` 清；`wrangler deploy --dry-run` OK。",
    "",
    "**驗收點（live，deploy 後）：**",
    "",
    "1. 同一形狀嘅 pass note：`defer-send`／`subreq-cut` 應該明顯細過 9–17，`ok:N/M` 嘅出卡率升（0–1 → 期望 ≥2）。",
    "2. `trips` 每張卡少 1。",
    "3. 追蹤池最舊未 check 行由 16 分鐘回落。",
    "4. 冇新增重複卡（`dup-skip` 冇異常、`/debug/push-watch.issueCount` 保持 0）。",
    "",
    "**落線紀錄：** `docs/patches/tracker-claim-reserve-merge-{db,watch,budget,comments,tests,tests2,tests3,tests4,tests5,tests6}-2026-09-27.apply.js`；",
    "`src/db.ts`（`claimAndReservePushWatch`）、`src/pushwatch.ts`（alerting path ＋ `TRACKER_ALERT_PATH_SUBREQ 3`）、`src/worker.ts`（slice 12）、",
    "`src/tickprobe.ts`（census 改名）、`src/scanner.ts`（watchdog 審計）、`scripts/test-unit.js`。",
    "",
  ),
  "### §4.37 一張卡 4 → 3 個 subrequest",
);

append(
  "docs/duplicate-cards.md",
  "§20",
  j(
    "---",
    "",
    "## 二十、claim 同 reservation 合併成一個 batch（2026-09-27）—— 守衛點樣保持",
    "",
    "`Db.claimAndReservePushWatch` 把 §17.5 講嘅 claim CAS 同 reservation 併成一個 `batch()`（兩句、次序不變），",
    "一張卡嘅 subrequest 由 4 變 3。對呢份文件最重要嘅係**守衛冇變鬆**：",
    "",
    "- **權威守衛仍然係 reservation**：`(last_state, last_alert_at)` CAS —— 兩個 isolate 之中只有一句 UPDATE 入到，",
    "  輸家唔送卡。呢個係所有「重複卡」修法嘅地基，冇動。",
    "- **新增 `last_checked = ?`（綁住同一個 batch 嘅 claim stamp）**：防止「自己冇 claim 到嘅 row 都宣佈」。",
    "  場景：isolate B 喺 A 落 claim 之後、A 落 reservation 之前讀（或者 B 嘅 call 之前個 claim 已經被 A 搶走）——",
    "  B 嘅 claim 會輸（`last_checked` 唔再係 B 讀到嘅值），冇呢句嘅話 B 嘅 reservation 仍然可以 commit（因為",
    "  `(state, alertAt)` 對得上），於是 B 會發一張 A 已經擁有嘅卡。有咗呢句，B 兩句都輸，走 lost-reservation 路徑：",
    "  寫 measurements、announcement 兩欄保持舊值、下一個 pass 重新推導。",
    "- **span**：`holdRowSpan`（§17.6 交俾 tick 嘅 waitUntil）而家喺 batch **之前**開，三個出口各自 release",
    "  （lost claim／lost reservation／final write），所以「reservation 已 commit 但 final write 未落」嘅窗口依然被覆蓋。",
    "- **測試**：真 DB 一條（另一 isolate 淨係 claim、未 reserve；拎走 `last_checked = ?` ⇒ 期望值反轉）、",
    "  SQL／round-trip 一條（一個 batch、兩句、args 綁 stamp）、pass 層兩條（兩種 loss 分流）。",
    "",
    "詳情同 live 讀數見 `docs/round-trips.md` §4.37。",
    "",
  ),
  "## 二十、claim 同 reservation 合併成一個 batch",
);

console.log("node docs/patches/tracker-claim-reserve-merge-doc-2026-09-27.apply.js — done");
