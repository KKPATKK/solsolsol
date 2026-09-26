#!/usr/bin/env node
/**
 * Round 4 follow-up (2026-09-26): one existing guard follows the /health read.
 *
 * `docs/patches/tick-progress-record.apply.js` pins the property "the
 * pre-flush record is read together with the heartbeat by /health" by naming
 * the statement's exact two-key list:
 *
 *     getWorkerStates(["scan_heartbeat", TICK_PROGRESS_KEY])
 *
 * Round 4 adds the trade-mode row to that SAME batch (so /health stops paying a
 * second round trip for it — docs/round-trips.md §4.25), which changes the
 * literal while leaving the property intact. The assertion is RE-POINTED at the
 * new shape, not dropped: what it pins is that the record is published by the
 * same read, and that read is now a three-key batch.
 *
 * Run: node docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "scripts/test-unit.js",
    "the tick-progress guard's /health assertion follows the three-key batch",
    lines(
      `      "worker (/health publishes it)":`,
      `        workerSrc.includes("tickProgress,") &&`,
      `        workerSrc.includes('getWorkerStates(["scan_heartbeat",TICK_PROGRESS_KEY])'),`,
    ),
    lines(
      `      // ROUND 4 (2026-09-26): that read now carries the trade-mode row in`,
      `      // the SAME batch (docs/round-trips.md §4.25), so the pinned shape`,
      `      // follows the statement instead of the old two-key list. The property`,
      `      // is unchanged — the record is published by the same read.`,
      `      "worker (/health publishes it)":`,
      `        workerSrc.includes("tickProgress,") &&`,
      `        workerSrc.includes(`,
      `          'getWorkerStates(["scan_heartbeat",TICK_PROGRESS_KEY,"trade_mode_override",])',`,
      `        ),`,
    ),
    (src) =>
      src.includes('TICK_PROGRESS_KEY,"trade_mode_override",])'),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
