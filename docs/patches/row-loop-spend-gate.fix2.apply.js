#!/usr/bin/env node
/**
 * Docs half of row-loop-spend-gate.fix1.apply.js: says out loud that the first
 * cut of the spend gate was wrong, and updates §5's test count.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/round-trips.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "doc: the send gate keeps the slice, not the clock",
    old: "| alerting row 嘅 send gate | 唔夠 slice → `break` | `overBudget` 或唔夠 slice → `continue`（該行完全唔碰） |",
    next: "| alerting row 嘅 send gate | 唔夠 slice → `break`（跳走其餘輪替） | 唔夠 slice → `continue`（該行完全唔碰，其餘照行落去） |",
  },
  {
    label: "doc: the first cut of the gate was wrong, and why",
    old: L(
      "**上線後要讀**（未做）：",
      "",
      "1. 慢 pass 嘅 `rows X/N`：X 應該貼近 N（30），唔再係 17；",
    ),
    next: L(
      "**第一刀錯咗，已修（`row-loop-spend-gate.fix1.apply.js`）**：第一版把 `overBudget` 都加落",
      "send gate —— 即「過咗 deadline 就唔准開新嘅 alerting row」。兩條既有 test 即刻紅：",
      "`a row that starts after the deadline sends inside the pass tail` 同 `a held-back card is",
      "re-announced on the next pass`。一條 row 嘅池裡面，嗰條 row **就係** progress floor，而真正",
      "bound 住 pass tail 嘅係 **send slice**（`TRACKER_SEND_CAP_MS`／`TRACKER_SEND_FLOOR_MS`），唔係",
      "個 reserve —— live 有個 tick 喺 ~4_840ms race window 嘅 4_857ms 才完，成個 flush 都輸埋。所以",
      "send gate 嘅條件**保持原狀**（只有 slice），只係 `break` → `continue`；而家被時鐘管住嘅只剩",
      "`pairMiss` 嗰個 delete（佢係唯一冇自己 slice 嘅 spend）。",
      "",
      "**上線後要讀**（未做）：",
      "",
      "1. 慢 pass 嘅 `rows X/N`：X 應該貼近 N（30），唔再係 17；",
    ),
  },
  {
    label: "doc: §5 unit-test count 303 → 304",
    old: L(
      "* `node scripts/test-unit.js` → **303 passed, 0 failed** ✅（§4.8 新增 1 條「pair batch 問全池」test ＋ 改寫 1 條 strict-subset",
      "  test 成 40 行 fixture；之前 302 ＝ §十九（duplicate-cards）嗰 2 條 no-mark",
    ),
    next: L(
      "* `node scripts/test-unit.js` → **304 passed, 0 failed** ✅（§4.8.2 換走嗰條釘住舊 `break` 行為嘅",
      "  「always evaluates a row」test ＋ 加 1 條「30 行一個 batch trip」test；§4.8 加 1 條「pair batch",
      "  問全池」test ＋ 改寫 1 條 strict-subset test 成 40 行 fixture；再之前 302 ＝ §十九（duplicate-cards）",
      "  嗰 2 條 no-mark",
    ),
  },
];

const text = fs.readFileSync(DOC, "utf8");
let out = text;
let failed = false;
for (const e of edits) {
  const first = out.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (out.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  out = out.slice(0, first) + e.next + out.slice(first + e.old.length);
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
fs.writeFileSync(DOC, out);
console.log(`wrote ${DOC}`);
