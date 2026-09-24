#!/usr/bin/env node
/**
 * Follow-up to tracker-pair-head-whole-pool.apply.js: one test fixture and one
 * doc line that the pair batch's bigger reserve moves.
 *
 * The heal's slice is derived by SUBTRACTING the rotation's reserve:
 *   healDeadline = deadline − (TRACKER_PAIRS_BUDGET_MS + TRACKER_ROW_RESERVE × TRACKER_ROW_MIN_MS)
 * With the whole-pool batch that reserve is 1_800ms instead of 1_200ms, so the
 * "chronic heal is cut at its slice" fixture — a 2_500ms allowance — no longer
 * has room to START the heal (2_500 − 1_800 − ~600ms of setup < the 450ms
 * minimum), and the pass reports `heal-skipped` instead of `heal-cut`. Both are
 * fail-open (the next pass re-offers the same missing pushes), but they are two
 * different guarantees, and the second one is already pinned by the next test
 * in the file. The fixture moves to 3_200ms: the heal starts, spends its first
 * reads and is cut at its slice, which is exactly what this test is named for.
 *
 * Same discipline: exactly one match per replacement or nothing is written.
 */
const fs = require("fs");

const TESTS = "scripts/test-unit.js";
const DOC = "docs/round-trips.md";

/** @type {Array<{file: string, label: string, old: string, next: string}>} */
const edits = [
  {
    file: TESTS,
    label: "test: the cut-heal fixture keeps room to START the heal",
    old:
      "    // The self-heal's path is five to seven store round trips; against a\n" +
      "    // 2_500ms allowance it spent 2_926ms, so the pass deferred BEFORE the pair\n" +
      "    // batch and the row loop — zero rows evaluated, tick after tick, while the\n" +
      "    // note read healthy and the same work was redone on the next pass. The old\n" +
      "    // 29-row rotation's oldest row measured 99 minutes stale.",
    next:
      "    // The self-heal's path is five to seven store round trips; against a\n" +
      "    // 2_500ms allowance it spent 2_926ms, so the pass deferred BEFORE the pair\n" +
      "    // batch and the row loop — zero rows evaluated, tick after tick, while the\n" +
      "    // note read healthy and the same work was redone on the next pass. The old\n" +
      "    // 29-row rotation's oldest row measured 99 minutes stale.\n" +
      "    //\n" +
      "    // The fixture asks for 3_200ms rather than the live 2_500ms because the\n" +
      "    // rotation's reserve (deadline − heal) is priced from the pair batch, and\n" +
      "    // the whole-pool batch raised it 1_200 → 1_800ms: at 2_500 the heal has no\n" +
      "    // room to START (setup ~600ms + 1_800 reserve leaves < TRACKER_HEAL_MIN_MS)\n" +
      "    // and the pass reports `heal-skipped`, which is the NEXT test's guarantee.\n" +
      "    // 3_200 leaves a slice ~800ms — enough to start, too little to finish —\n" +
      "    // i.e. the cut-at-its-slice shape this test exists for.",
  },
  {
    file: TESTS,
    label: "test: the cut-heal fixture's allowance",
    old:
      "    const out = await pw.runTick(Date.now() + 2_500);\n" +
      "    assert.ok(\n" +
      "      out.checked >= 1,\n" +
      "      `the rotation must still be served behind a chronic heal, got ${out.checked} rows`,\n" +
      "    );\n" +
      "    assert.match(String(out.note), /heal-cut/, `a heal stopped at its slice says so: ${out.note}`);",
    next:
      "    const out = await pw.runTick(Date.now() + 3_200);\n" +
      "    assert.ok(\n" +
      "      out.checked >= 1,\n" +
      "      `the rotation must still be served behind a chronic heal, got ${out.checked} rows`,\n" +
      "    );\n" +
      "    assert.match(String(out.note), /heal-cut/, `a heal stopped at its slice says so: ${out.note}`);",
  },
  {
    file: DOC,
    label: "doc: the heal's reserve is what pays for the wider batch",
    old: "**一個附帶修好**：holder stage",
    next:
      "**一個要知嘅代價**：heal 嘅 slice 係 `deadline − (TRACKER_PAIRS_BUDGET_MS + TRACKER_ROW_RESERVE ×\n" +
      "TRACKER_ROW_MIN_MS)`，即由 1_200 變 **1_800** —— 一個只淨 ~2.5s 嘅 pass 而家會 `heal-skipped`\n" +
      "（讓路畀輪替），唔再係以前嗰種「開咗 heal 再喺中途 cut」。兩個形狀都係 fail-open（下一 pass 由\n" +
      "同一個 listing 重新提供嗰啲 missing push），而 live pass 多數 `allow ≈ 4_800`，heal 一樣食得到\n" +
      "自己嗰 2_600ms 上限。單元測試嗰個 cut-heal fixture 因此由 2_500 → 3_200ms（見 fix1 script）。\n" +
      "\n" +
      "**一個附帶修好**：holder stage",
  },
];

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, "utf8"));
  return cache.get(file);
};

let failed = false;
for (const e of edits) {
  const text = read(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  cache.set(e.file, text.slice(0, first) + e.next + text.slice(first + e.old.length));
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
for (const [file, text] of cache) fs.writeFileSync(file, text);
