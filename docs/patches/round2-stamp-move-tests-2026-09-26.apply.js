#!/usr/bin/env node
/**
 * The RUNNING stamp's move, pinned in the tests it changed (2026-09-26).
 *
 * WHY A SECOND SCRIPT: the three cases below live in scripts/test-unit.js
 * (615KB, far past the file tool's ~50KB edit window), and the round-2 merge
 * script (docs/patches/round2-tick-merges-2026-09-26.apply.js) already sits at
 * the same window. Splitting them keeps both scripts editable, and this one is
 * only about the three assertions that pinned the OLD owner of the RUNNING
 * stamp: `Scanner.runTrackerPass` used to write it as its own round trip, and it
 * now rides the pass's ONE entry request (Db.beginTrackerPass).
 *
 * The cases are UPDATED, never deleted: what they exist for — a pass that starts
 * moves the durable row, and a cut pass says it was cut — is still pinned, one
 * assertion narrower because the scanner no longer owns the stamp.
 *
 * Verify-then-write: every anchor is checked (present, unique, span sane)
 * before a byte is written.
 *
 * Run: node docs/patches/round2-stamp-move-tests-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const FILE = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [label, old, new] — exact-match, unique, each idempotent via `already`. */
const EDITS = [
  [
    "the err-note case: the scanner's own write is the note, ONE of it",
    `    assert.equal(rowWrites, 2, "the row is still attempted immediately (running stamp + the note), so the common case stays instant");`,
    `    assert.equal(rowWrites, 1, "exactly ONE write: the note. The RUNNING stamp rides the pass's entry batch now (Db.beginTrackerPass), so the common case stays instant without a second round trip");`,
    (src) =>
      src.includes(
        `    assert.equal(rowWrites, 1, "exactly ONE write: the note.`,
      ),
  ],
  [
    "the three-state-send guard: settle's call site",
    `        "constsettle=awaitthis.settleUnconfirmedCards(now);",`,
    `        "constsettle=awaitthis.settleUnconfirmedCards(now,entryUnconfirmed);",`,
    (src) =>
      src.includes(
        `        "constsettle=awaitthis.settleUnconfirmedCards(now,entryUnconfirmed);",`,
      ),
  ],
  [
    "the watchdog case: the cut note is the scanner's only write",
    lines(
      `    assert.equal(writes[0].phase, "running", "the running stamp still lands before the pass works");`,
      `    assert.equal(writes[1].phase, "cut", "the durable row says the pass was cut, not that it finished");`,
    ),
    lines(
      `    assert.equal(writes.length, 1, "one write: the RUNNING stamp rides the pass's entry batch now (Db.beginTrackerPass), so the scanner's own write is the cut note");`,
      `    assert.equal(writes[0].phase, "cut", "the durable row says the pass was cut, not that it finished");`,
    ),
    (src) => src.includes(`    assert.equal(writes.length, 1, "one write: the RUNNING stamp`),
  ],
];

const abs = path.join(root, FILE);
let src = fs.readFileSync(abs, "utf8");
const problems = [];
const pending = [];
for (const [label, oldText, newText, already] of EDITS) {
  if (already(src)) {
    console.log(`skip ${FILE}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${label} — anchor matched ${n} times (want exactly 1)`);
    console.error(`ABORT ${FILE}: ${label} — anchor matched ${n} times`);
    continue;
  }
  pending.push([label, oldText, newText]);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  process.exit(1);
}
for (const [label, oldText, newText] of pending) {
  src = src.replace(oldText, newText);
  console.log(`ok   ${FILE}: ${label}`);
}
if (pending.length > 0) {
  fs.writeFileSync(abs, src);
  console.log(`wrote ${FILE} (${src.length} bytes)`);
}
console.log("\nall anchors applied.");
