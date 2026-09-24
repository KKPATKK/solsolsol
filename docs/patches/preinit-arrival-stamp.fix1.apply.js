#!/usr/bin/env node
/**
 * fix1 for the pre-init arrival stamp: EXPORT the suspect-gap constant.
 *
 * `scripts/test-unit.js` pins the rule against the real bound rather than a
 * copied 90_000 (so retuning the constant cannot leave the test asserting a
 * number production no longer uses), and that needs the export. Same shape as
 * DEAD_TICK_STREAK_RESET, which is exported for the same reason.
 *
 * Safe to run twice: a second run reports that there is nothing to do and
 * exits 0 (unlike the main patch script, whose "already applied" state is an
 * error — a fix is not a paste).
 */
const fs = require("fs");

const T = "src/worker.ts";
const old = "const SCHEDULED_ARRIVAL_SUSPECT_GAP_MS = 90_000;";
const next = "export const SCHEDULED_ARRIVAL_SUSPECT_GAP_MS = 90_000;";

const text = fs.readFileSync(T, "utf8");
if (text.includes(next)) {
  console.log("ok        worker: SCHEDULED_ARRIVAL_SUSPECT_GAP_MS is exported");
  process.exit(0);
}
if (text.indexOf(old) < 0) {
  console.error("MISS      worker: SCHEDULED_ARRIVAL_SUSPECT_GAP_MS (apply the main patch first)");
  process.exit(1);
}
if (text.indexOf(old, text.indexOf(old) + 1) >= 0) {
  console.error("AMBIGUOUS worker: SCHEDULED_ARRIVAL_SUSPECT_GAP_MS");
  process.exit(1);
}
fs.writeFileSync(T, text.replace(old, next));
console.log("ok        worker: SCHEDULED_ARRIVAL_SUSPECT_GAP_MS is exported");
