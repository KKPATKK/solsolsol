#!/usr/bin/env node
/**
 * Fix the roll test in subreq-counter-tests.apply.js.
 *
 * The first version asserted `recent.length === 1` after a window that HAD
 * counted one subrequest rolled in — the arithmetic, not the counter, was
 * wrong: only a window with nothing counted and no phase is skipped, and the
 * window that opened at 3000 was still open (never rolled) at that point. The
 * corrected sequence opens an idle window and rolls it, which is the case the
 * assertion was meant to cover.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const old = lines(
  "    beginSubreqWindow(3_000);",
  "    const view = subreqView();",
  "    assert.equal(view.windows, 3);",
  "    assert.equal(view.recent.length, 1);",
  "    assert.equal(view.recent[0].at, 2_000);",
  "    assert.equal(view.recent[0].total, 2);",
  "    // Capped at SUBREQ_RECENT_WINDOWS, newest first.",
  "    countSubreq();",
  "    beginSubreqWindow(4_000);",
  "    countSubreq();",
  "    beginSubreqWindow(5_000);",
  "    countSubreq();",
  "    beginSubreqWindow(6_000);",
  "    const capped = subreqView();",
  "    assert.equal(capped.recent.length, SUBREQ_RECENT_WINDOWS);",
  "    assert.equal(capped.recent[0].at, 5_000);",
  "    assert.equal(capped.recent[1].at, 4_000);",
);

const next = lines(
  "    beginSubreqWindow(3_000);",
  "    beginSubreqWindow(4_000);",
  "    const view = subreqView();",
  "    assert.equal(view.windows, 4);",
  "    // The idle 3000 window took no slot, so the two counted ones are both",
  "    // still there, newest first.",
  "    assert.equal(view.recent.length, 2);",
  "    assert.equal(view.recent[0].at, 2_000);",
  "    assert.equal(view.recent[0].total, 2);",
  "    assert.equal(view.recent[1].at, 1_000);",
  "    assert.equal(view.recent[1].total, 1);",
  "    // Capped at SUBREQ_RECENT_WINDOWS, newest first.",
  "    countSubreq();",
  "    beginSubreqWindow(5_000);",
  "    countSubreq();",
  "    beginSubreqWindow(6_000);",
  "    countSubreq();",
  "    beginSubreqWindow(7_000);",
  "    const capped = subreqView();",
  "    assert.equal(capped.recent.length, SUBREQ_RECENT_WINDOWS);",
  "    assert.equal(capped.recent[0].at, 6_000);",
  "    assert.equal(capped.recent[1].at, 5_000);",
);

let text = fs.readFileSync(T, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      test-unit: the roll test");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the roll test");
  process.exit(1);
}
text = text.slice(0, first) + next + text.slice(first + old.length);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the roll test");
