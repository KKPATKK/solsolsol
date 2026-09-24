#!/usr/bin/env node
/**
 * Narrows §4.8.3's "unproven half": a later pass DID carry an alerting row
 * (`ok:30/1 rows 30/30 … rows 1931/5`, 06:31:41Z) and still walked the whole
 * pool without a single `budget-cut` — so what is left unwitnessed is only the
 * REFUSAL path (`defer-send` + `budget-cut`), not the alerting path itself.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/round-trips.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "doc: the alerting row did show up, and the tail survived it",
    old: L(
      "**未證嘅一半（老實講）**：三個抽樣 pass 都係 `ok:30/0` —— **冇一條 alerting row**，所以",
      "「被拒嘅 card 仍然會出聲」（`defer-send N` ＋ `budget-cut`）今次 **live 抽唔到**，只由 unit test",
      "釘住：`a card that cannot be sent leaves its row untouched` 斷言 `defer-send 1` ＋ `budget-cut`，",
      "而 fix1 把 `overBudget` 由 send gate 拿返出嚟之後佢仍然綠。要等一條真 alerting row 出現，",
      "先可以話 live 都證實。",
    ),
    next: L(
      "**06:31:41Z 補充 —— 抽到一條 alerting row，而個尾冇斷**：",
      "",
      "```",
      "ok:30/1 rows 30/30 pairs 30/30 miss 0 lost 0 allow 4783",
      "spend[setup 791/2 heal 389/1 miss0 enrolled0 pairs 33/0 rows 1931/5 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 9 db 3011ms",
      "```",
      "",
      "`ok:30/1` ＝ 30 行 checked、1 條出咗 card；`rows 1931/5` ＝ 5 個 trip（batch 1 ＋ 嗰行嘅",
      "claim／reservation／final write）。**alerting row 在場都一樣 `rows 30/30`、冇 `budget-cut`、",
      "`trackerMs 3_567` 仍在 `allow 4_783` 之内** —— 即係「alerting row 會唔會再切尾」呢個問題 live",
      "答咗：唔會（以前 3 條 alerting row 就已經令 pass 停喺 17/30）。",
      "",
      "**未證嘅只剩「被拒」嗰半（老實講）**：抽樣期間冇一條 card 因為唔夠 slice 而被拒，所以",
      "`defer-send N` ＋ `budget-cut` 今次 **live 抽唔到**，只由 unit test 釘住：",
      "`a card that cannot be sent leaves its row untouched` 斷言 `defer-send 1` ＋ `budget-cut`，",
      "而 fix1 把 `overBudget` 由 send gate 拿返出嚟之後佢仍然綠。",
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
