#!/usr/bin/env node
/**
 * Record the live reading for the no-mark dedupe change (2026-09-24).
 *
 * The honest reading is thin on purpose: the rule only fires on a coincidence
 * (a delivered card whose mark never landed AND a proof inside the same check
 * bucket), so what the first hour can show is that the pass still completes
 * with the widened proof read in place and that nothing regressed. Saying that
 * plainly is worth more than implying the rule was observed working.
 *
 * Run: node docs/patches/cut-card-proof-no-mark-readings.apply.js
 */
const fs = require("fs");
const path = require("path");

const lines = (...xs) => xs.join("\n");

// ------------------------------------------------------ duplicate-cards.md ---
const DOC = path.join(__dirname, "..", "duplicate-cards.md");
const DOC_ANCHOR =
  "* **落線 script**：`docs/patches/cut-card-proof-no-mark.apply.js`（row loop ＋ proof 讀取閘 ＋ 兩條測試）。";
const DOC_NEXT = lines(
  DOC_ANCHOR,
  "* **落線讀數**（2026-09-24 02:36Z，deploy run 35947790374）：pass note",
  "  `ok:10/1 rows 10/29 pairs 10/10 miss 0 lost 0 undelivered 1 … trips 14 db 2456ms` ⇒ pass 正常完結",
  "  （phase `done`），`/debug/push-watch.issueCount` 仍然係 2（兩條舊 `lost_completion_write`，冇新增）。",
  "  `dup-skip` **未出現** —— 呢條規則要「已送達但 mark 冇落地」嘅巧合，唔會即刻撞到。驗收係佢出現嗰陣",
  "  **唔會**跟住多送一張卡（同一條 row 嘅 `undelivered` 唔會因為我哋壓抑咗一張而升）。",
);

// -------------------------------------------------------- round-trips.md ----
const RT = path.join(__dirname, "..", "round-trips.md");
const RT_ANCHOR =
  "  `a9711fd`（§4.5.3.1 cold-handle fix）→ run 35945163059 **success** ✅（落線讀數見 §4.5.3.1）";
const RT_NEXT = lines(
  RT_ANCHOR,
  "* `4021c35`（duplicate-cards §十九 no-mark dedupe）→ Deploy Worker run 35947790374 **success** ✅",
);

const JOBS = [
  { label: "§十九 live reading", file: DOC, done: "落線讀數**（2026-09-24 02:36Z", anchor: DOC_ANCHOR, next: DOC_NEXT },
  { label: "§5 deploy run", file: RT, done: "§十九 no-mark dedupe）→ Deploy Worker run", anchor: RT_ANCHOR, next: RT_NEXT },
];

let failed = false;
const pending = [];
for (const job of JOBS) {
  const text = fs.readFileSync(job.file, "utf8");
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
  console.log("ok        the no-mark reading is already recorded");
  process.exit(0);
}
for (const job of pending) {
  const text = fs.readFileSync(job.file, "utf8");
  fs.writeFileSync(job.file, text.replace(job.anchor, job.next));
  console.log(`ok        ${job.label}`);
}
console.log(`ok        ${pending.length} insertions written`);
