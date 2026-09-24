#!/usr/bin/env node
/**
 * Record the pre-init cron-arrival stamp (2026-09-24) in docs/round-trips.md.
 *
 * WHY A SCRIPT: round-trips.md (~60KB) sits past the file-tool edit window, so
 * the deeper insertions have to go the same way every other record in this
 * directory does (see the file's own §6): verify every anchor matches EXACTLY
 * ONCE first, write nothing unless all of them do, and stay re-runnable — a
 * record that is already present is reported ALREADY, never an error.
 *
 * The §4.5 bullet is written here too, but the caller may already have applied
 * it through the file tool: each job carries its own "done" witness, so a
 * partially-applied record converges instead of half-failing.
 *
 * Run: node docs/patches/preinit-arrival-record.apply.js
 */
const fs = require("fs");
const path = require("path");

const T = path.join(__dirname, "..", "round-trips.md");
const lines = (...xs) => xs.join("\n");

// --------------------------------------------------------------- §4.5.3 -----
const SECTION = lines(
  "### 4.5.3 cron 到達盲點：pre-init arrival stamp（2026-09-24，已修）",
  "",
  "§5.1 第 3 點／§4.5 第一項：到達記錄搭喺 claim batch，令「cron 死喺 init」同「cron 冇投遞」喺",
  "`/health` 上長得一模一樣。",
  "",
  "* **形狀**：每一個到達記錄都只喺 `ensureInitialized` **之後**才 reachable —— 正常路徑搭 claim",
  "  batch（`Db.scheduledTickStatements`），到唔到 claim 嘅路徑各自寫自己嗰份 —— 所以**死喺 init 嘅",
  "  tick 一個字都冇寫**。樣本（2026-09-23 21:41–00:07Z）：ring 凍 19 分鐘",
  "  （23:43:26 → 00:02:26Z）、再凍 2h42m（20:21:26 → 23:03:26Z），期間 scan row 每 ~70s 照落",
  "  （HTTP monitor 兜住）；durable counter 54_546（13:46Z）→ 54_846（23:56Z）十個鐘 ⇒ **約一半 beat",
  "  冇記錄**。successor-tick recovery 只證明「到達去到 heartbeat read」，證明唔到「投遞本身」。",
  "* **修法**：`Db.stampScheduledArrival(at)`（**一個 batch、三個 statement、零 read**，counter 喺 SQL",
  "  加）＋ worker 喺 `ensureInitialized` **之前**呼叫，條件係純函數",
  "  `shouldStampArrival(scheduledTickFinishedAt, cronAt)`。",
  "* **點解唔係每個 tick 都寫**：`scheduledTickFinishedAt` ＝ 本 isolate 最近一個**返到**嘅 scheduled",
  "  tick。冷 isolate（0）或前人 tick 冇返到（gap > `SCHEDULED_ARRIVAL_SUSPECT_GAP_MS` = 90s）才",
  "  stamp ⇒ 健康 warm isolate **零成本**；瀕死 isolate 就「每個收到嘅 arrival 都 stamp」（flag 冇得",
  "  前進，正正令 wedge 嘅投遞**可數**而唔係隱形）。",
  "* **成本／界**：1 個 subrequest、0 read。`PRE_INIT_ARRIVAL_BOUND_MS` = 1_500 用 `recoveryAwait`",
  "  兜住 —— stamp 唔可以食咗佢自己存在嘅目的（envelope）；被 bound 走就繼續跑（寫入 idempotent），",
  "  tick 唔付。",
  "* **cold-isolate fallback**：`db === null` 時起一個 raw `new Db(...)`（同 `bumpScheduledTickLegacy` 同形）。",
  "* **flag 設定位**：legacy bump return、cadence-gate skip return、正常 tick 尾（**故意最後**設 ——",
  "  死喺前面就留住舊值，嗰個 stale 值就係證人）。",
  "* **讀數**：`/health` 同 `/debug/scan-history` 都出 `scheduledArrivalTotal` / `scheduledArrivalAt` /",
  "  `scheduledArrivalUnaccounted`（`scheduledArrivalAt > scheduledTickAt` ⇒ 最新一個 cron 投遞未為",
  "  自己入賬）。兩邊嘅 state read 順手合成一個（`/health` 2→1；`/debug/scan-history` 5→1）。",
  "* **測試**：`test-unit.js` 加 3 條 —— Db stamp 一 trip 零 read（counting client 度到",
  "  `executes 0 / batch 1 / statements 3`）、`shouldStampArrival` 規則（含「單一 lost arrival 都要",
  "  捉到」嘅 < 120s 關係）、out-of-window patch guard（半套貼上係危險狀態）。296 → **299 passed, 0 failed**。",
  "* **落線 script**：`docs/patches/preinit-arrival-stamp.apply.js`（`db.ts` ＋ `worker.ts`）＋",
  "  `…fix1.apply.js`（export `SCHEDULED_ARRIVAL_SUSPECT_GAP_MS`）＋ `…-tests.apply.js` /",
  "  `…-tests.fix1.apply.js`。",
  "",
  "**落線點驗**（deploy 後第一個鐘）：",
  "",
  "1. 健康 warm isolate **唔應該**令 `scheduledArrivalTotal` 動 —— 佢一動就代表嗰個 arrival 嘅前人 tick",
  "   冇返（stamp 只喺呢種 arrival 上開火）。",
  "2. ring 有洞而 `scheduledArrivalTotal` **同時**上升 ⇒「cron 有投遞、tick 死喺 claim 之前」，兩個原因",
  "   唔再分唔開。",
  "3. `scheduledArrivalUnaccounted === true` 持續 ⇒ 最新投遞未入賬（＝仲有死亡路徑喺 init 之前）。",
  "4. 若 `scheduledArrivalAt` 都唔動而 scan row 照落 ⇒ 真係 cron 冇投遞（HTTP monitor 兜緊）。",
  "",
);

const OLD_BULLET = lines(
  "* **durable cron 到達記錄會停**（2026-09-23 13:46:27Z 起 ≥ 30 分鐘，見 §5.1 第 3 點）：",
  "  `scheduled_tick_total` / `scheduled_tick_at` / ring 尾一齊凍結，而 scan row 照落。要一個**唔經",
  "  claim batch** 嘅到達標記（或者直接睇 Cloudflare 嘅 cron 指標）才分得開「cron 冇投遞」同",
  "  「cron 死喺 init」；而後者係 §1 搬走 pre-init 寫入之後新開嘅盲點（舊 code 喺 init **之前**寫到達",
  "  記錄，正正係為咗呢件事）。fix 之前唔應該再加任何「到達記錄搭去第二個 write」嘅優化。",
);

const NEW_BULLET = lines(
  "* ~~**durable cron 到達記錄會停**（2026-09-23 13:46:27Z 起 ≥ 30 分鐘，見 §5.1 第 3 點）~~ →",
  "  **已修，見 §4.5.3**。原本：`scheduled_tick_total` / `scheduled_tick_at` / ring 尾一齊凍結，而",
  "  scan row 照落；要一個**唔經 claim batch** 嘅到達標記（或者睇 Cloudflare 嘅 cron 指標）才分得開",
  "  「cron 冇投遞」同「cron 死喺 init」，而後者係 §1 搬走 pre-init 寫入之後新開嘅盲點（舊 code 喺",
  "  init **之前**寫到達記錄，正正係為咗呢件事）。**呢句仍然成立**：fix 之前唔應該再加任何「到達記錄",
  "  搭去第二個 write」嘅優化 —— 新 stamp 亦冇打破佢（佢係唯一一個唔搭 claim、又唔屬正常 path 嘅寫入）。",
);

const OLD_COUNT = lines(
  "* `node scripts/test-unit.js` → **295 passed, 0 failed** ✅（§4.7 新增 1 條 grouped-telemetry test；",
  "  再之前係 292",
);
const NEW_COUNT = lines(
  "* `node scripts/test-unit.js` → **299 passed, 0 failed** ✅（§4.5.3 新增 3 條 pre-init arrival test；",
  "  再之前係 296 —— §17.6 嗰 3 條 row-span-hold test；295 ＝ §4.7 嗰 1 條 grouped-telemetry test；",
  "  292",
);

const OLD_POINTER = lines(
  "   收 cron，所以**唔算證據**，唔應該當結論。呢條列入 §4.5 未做第一項。",
);
const NEW_POINTER = lines(
  "   收 cron，所以**唔算證據**，唔應該當結論。呢條列入 §4.5 未做第一項。",
  "   **2026-09-24 已修**：見 §4.5.3（pre-init arrival stamp —— 到達記錄唔再只喺 claim batch 上出現）。",
);

// Each job: `done` is the witness that this piece is already in the file.
const JOBS = [
  { label: "§4.5.3 section", done: "### 4.5.3 cron 到達盲點", anchor: "### 4.6 invocation 預算：先量度，才切", next: SECTION + "### 4.6 invocation 預算：先量度，才切" },
  { label: "§5 test count", done: "**299 passed, 0 failed** ✅（§4.5.3", anchor: OLD_COUNT, next: NEW_COUNT },
  { label: "§5.1 pointer", done: "**2026-09-24 已修**：見 §4.5.3", anchor: OLD_POINTER, next: NEW_POINTER },
  { label: "§4.5 bullet", done: "~~**durable cron 到達記錄會停**", anchor: OLD_BULLET, next: NEW_BULLET },
  // The §4.5.3 block is glued to the next heading otherwise; a blank line keeps the
  // file's own spacing convention (ATX headings still parse, but stay consistent).
  {
    label: "§4.5.3 blank line",
    done: "兜緊）。\n\n### 4.6 invocation",
    anchor: "兜緊）。\n### 4.6 invocation",
    next: "兜緊）。\n\n### 4.6 invocation",
  },
];

let text = fs.readFileSync(T, "utf8");

// Pass 1: verify. Every pending job's anchor must match exactly once.
let failed = false;
const pending = [];
for (const job of JOBS) {
  if (text.includes(job.done)) {
    console.log(`ALREADY   ${job.label}`);
    continue;
  }
  const at = text.indexOf(job.anchor);
  if (at < 0) {
    console.error(`MISS      ${job.label}`);
    failed = true;
    continue;
  }
  if (text.indexOf(job.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${job.label}`);
    failed = true;
    continue;
  }
  pending.push(job);
}
if (failed) process.exit(1);
if (pending.length === 0) {
  console.log("ok        the pre-init arrival record is already in place");
  process.exit(0);
}

// Pass 2: write. Each replacement is from the freshly-updated text.
for (const job of pending) {
  text = text.replace(job.anchor, job.next);
  console.log(`ok        ${job.label}`);
}
fs.writeFileSync(T, text);
console.log(`ok        ${pending.length} insertions written to docs/round-trips.md`);
