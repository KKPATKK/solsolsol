#!/usr/bin/env node
/**
 * Record the grouped post-scan telemetry cut in docs/round-trips.md (§4.7) and
 * refresh the suite count in §5.
 *
 * An apply script because the anchors sit past the file-tool window, the same
 * reason docs/patches/*.patch exist for this doc.
 */
const fs = require("fs");

const T = "docs/round-trips.md";
const lines = (...xs) => xs.join("\n");

const anchor = "## 5. 驗證狀態（本地 + 上線）";

const section = lines(
  "### 4.7 三個 5 分鐘 sync 合成一個 grouped read ＋ 一個 batch write（2026-09-23，已修）",
  "",
  "§4.6.2 嘅結論係「下一刀砍 tick 內嘅 Turso round trip，而清單 5（三個 5 分鐘 sync）係已確認可以",
  "batch 嘅第一刀」。三個 sync 各自係「一次讀（ledger 嗰個係四次讀）＋ 有事就一次寫」，所以佢哋同時",
  "到鐘嘅嗰個 tick（5 分鐘一次嘅常見形狀）要 **6 個 read ＋ 最多 3 個 write ＝ 9 個 subrequest**。",
  "",
  "改動：**一次 grouped read ＋ 一次 batch write**。",
  "",
  "* **grouped read**（`Db.readPostScanTelemetry`）：一個 libsql `batch`（＝ 一個 HTTP request）載住",
  "  (a) 四條 `worker_state` 讀（`push_ledger`、`push_audit`、`skip_capture`、`birdeye_cu_v1` ——",
  "  原本係 `getWorkerState` 逐條 ＋ `getPushAudit` 自己一條），(b) `push_watch` 嘅 baselines，",
  "  (c) enabled chats 嘅 band。statement 順序＝原本嘅讀取順序，batch 結果照 statement 順序返嚟。",
  "* **batch write**（`Db.setWorkerStatesMany`）：三個 sync 想落地嘅 key 合成一個 `batch`；每一個",
  "  statement 同 `setWorkerState` 逐字一樣（`INSERT ... ON CONFLICT(key) DO UPDATE`）。",
  "* **merge 邏輯冇分身**：三個 sync 嘅合併抽成純函式（`planPushLedgerSync` /",
  "  `planSkipCaptureSync` / `planBirdeyeCuSync`），單獨嘅 `syncPushLedger` /",
  "  `syncSkipCaptureState` / `syncBirdeyeCu` 同 grouped path 用**同一個** planner，所以兩條路一定",
  "  寫出逐字一樣嘅 row（唔係 `getReevalPoolBatched` 嗰種「兩份 SQL、一條 test 釘住」）。",
  "* **唔變嘅保證**：throttle（5 分鐘）、「冇變就唔寫」、「冇 delta 就唔讀」、`markSkipCaptureSynced`",
  "  / `consumeBirdeyeCuDelta` 只喺 **batch 真係落地之後**才跑（寫失敗＝三個 delta 全部留返俾下一個",
  "  attempt，正係以前「三個獨立寫全部失敗」到達嘅狀態）。",
  "* **代價（老實講）**：以前一個 sync throw 唔會擋住另外兩個；而家係一個 batch，所以一次過全中或",
  "  全唔中。讀數上唯一分別係 `/health` 嘅三個 mirror 會一齊更新，而唔係逐個。",
  "* **bound 亦簡化**：以前三個 sync 各自 `Promise.race` 一個 900ms、順序行（最差 2.7s）；而家一個",
  "  request，所以一個 bound 蓋得住整塊 —— 而且「有冇到鐘」先算，三個都未到鐘就 0 request。",
  "",
  "落線紀錄：`docs/patches/post-scan-telemetry-grouped-tests.apply.js`（test-unit.js）。",
  "測試：`test-unit.js` 加 1 條 —— 用一個 counting client 釘住「四條 state row ＋ 兩個 listing 係",
  "**一個** client call」，同時釘住 grouped 嘅 row set／band 同 `listPushWatch(60)` /",
  "`listEnabledChats` 逐個一樣（`ORDER BY ... LIMIT` 逐字抄過去，防兩邊漂移）⇒ 294 →",
  "**295 passed, 0 failed**。",
  "",
  "**落線點驗**：`/health.heartbeat.subreqs.current.hosts` 裡面嘅 turso 計數，喺 5 分鐘邊界嗰個 tick",
  "應該比之前少 4–7；而 turso 仍然係最大嗰個 host（DB 本身冇消失，只係同一件事嘅 request 變少）。",
  "",
  anchor,
);

const before = "* `node scripts/test-unit.js` → **292 passed, 0 failed** ✅（§4.6 新增 6 條 subrequest-counter test；";
const after = lines(
  "* `node scripts/test-unit.js` → **295 passed, 0 failed** ✅（§4.7 新增 1 條 grouped-telemetry test；",
  "  再之前係 292 —— §4.6 嗰 6 條 subrequest-counter test ＋ `cc333db` 嗰 2 條 host-split test；",
);

let text = fs.readFileSync(T, "utf8");
if (text.includes("### 4.7 三個 5 分鐘 sync 合成一個 grouped read")) {
  console.error("ALREADY   round-trips: §4.7");
  process.exit(1);
}
const at = text.indexOf(anchor);
if (at < 0) {
  console.error("MISS      round-trips: the §5 heading");
  process.exit(1);
}
if (text.indexOf(anchor, at + 1) >= 0) {
  console.error("AMBIGUOUS round-trips: the §5 heading");
  process.exit(1);
}
text = text.slice(0, at) + section + text.slice(at + anchor.length);

const bat = text.indexOf(before);
if (bat < 0) {
  console.error("MISS      round-trips: the §5 suite-count line");
  process.exit(1);
}
if (text.indexOf(before, bat + 1) >= 0) {
  console.error("AMBIGUOUS round-trips: the §5 suite-count line");
  process.exit(1);
}
text = text.slice(0, bat) + after + text.slice(bat + before.length);

fs.writeFileSync(T, text);
console.log("ok        round-trips: §4.7 + the refreshed suite count");
