#!/usr/bin/env node
/**
 * The §4.20 pointer in docs/round-trips.md (2026-09-26).
 *
 * WHY A SCRIPT: docs/round-trips.md is 126KB and every round appends its own
 * section here — the file tool's edit window ends around 50KB, and the CJK
 * anchors do not round-trip through the tool's matcher. Appending the same way
 * every other section was appended keeps this one step.
 *
 * Verify-then-write: the tail anchor is checked (present, exactly once, at the
 * END of the file) before a byte is written, and the section is skipped whole
 * if the heading is already there.
 *
 * Run: node docs/patches/round2-doc-pointer-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const FILE = "docs/round-trips.md";
const headings = (src, needle) => src.split(needle).length - 1;

const HEADING = "## 4.20 Round 2";
const TAIL_ANCHOR = "docs/tick-spend-and-profiles-2026-09-25.md`\u3002\n";
const SECTION = [
  "",
  "---",
  "",
  "## 4.20 Round 2：tick 嘅 Turso round trip 再收三刀 ＋ `budgetDrops` 嘅真身（2026-09-26）",
  "",
  "§4.11 量到嘅「一個 tick ~16–20 個 distinct one-shot statement」今次收咗三個：**cold init 嘅",
  "四個 `worker_state` 讀 → 1 個 `getWorkerStates`**、**tracker pass 嘅 entry（RUNNING stamp ＋",
  "listing ＋ settle 嗰行）3 → 1 個 batch**（`Db.beginTrackerPass`，被拒就跌落 pre-merge 三步，",
  "代價最多等於舊 code）、**stamp 由 scanner 自己嘅一個 round trip 改為騎 entry batch**；",
  "同時 census 加咗 key 入 label（`getWorkerState:axiom_access_token`），令下一輪合併有數可依。",
  "",
  "另外一條獨立讀數：`budgetDrops` 每 tick 2–3 唔係被拒（429），係 **request 根本冇發出** ——",
  "throttle 條 global 鏈會俾「注定答唔到嘅 attempt」佔 250ms 一個 slot，所以一個 drop 會推遲",
  "後面嘅腿、變兩個。修法＝ `Throttle.nextSlotAt()` 喺入隊前先問 slot（冇窗就免費 drop，queue",
  "內舊檢查留做 backstop），pair 階段喺 `nextSlotAt() >= deadline` 時直接收工、唔再製造尾巴",
  "batch；同時 `dropsByLeg` / `lastDropLeg` 令讀數點名邊條腿（profiles / boosts / pairs 三種處理）。",
  "",
  "本地驗收：`npm run typecheck` clean、`npm run test:unit` **353 passed / 0 failed**（前值 348；",
  "新增真 Db 嘅 entry-batch case、source-shape guard、census labelled case，同",
  "`test-deferred-priority` 嘅兩條 drop-slot case）。",
  "",
  "全部細節、代價、已知取捨同落線驗收步驟：`docs/round2-merges-and-budget-drops-2026-09-26.md`；",
  "落線紀錄：`docs/patches/round2-tick-merges-2026-09-26.apply.js` ＋",
  "`docs/patches/round2-stamp-move-tests-2026-09-26.apply.js`。",
  "",
].join("\n");

const abs = path.join(root, FILE);
const src = fs.readFileSync(abs, "utf8");
if (headings(src, HEADING) > 0) {
  console.log(`skip ${FILE}: ${HEADING} (already appended)`);
  process.exit(0);
}
const n = headings(src, TAIL_ANCHOR);
if (n !== 1) {
  console.error(`ABORT ${FILE}: tail anchor matched ${n} times (want exactly 1)`);
  process.exit(1);
}
if (!src.endsWith(TAIL_ANCHOR)) {
  console.error(`ABORT ${FILE}: tail anchor is not at the end of the file`);
  process.exit(1);
}
fs.writeFileSync(abs, src + SECTION);
console.log(`ok   ${FILE}: §4.20 appended (${SECTION.length} bytes)`);
console.log("\nall anchors applied.");
