#!/usr/bin/env node
/**
 * Corrects row-loop-spend-gate.apply.js: the alerting path must NOT be gated
 * by the loop's clock.
 *
 * The first cut added `overBudget` to the send gate. Two tests pin why that is
 * wrong, and both are about a real incident:
 *
 *   - "a row that starts after the deadline sends inside the pass tail": in a
 *     one-row pool the row IS the progress floor, and the SEND SLICE
 *     (TRACKER_SEND_CAP_MS / TRACKER_SEND_FLOOR_MS), not the per-row cap, is
 *     what bounds the tick — a live tick finished 4_857ms into a ~4_840ms race
 *     window and lost its flush entirely. Adding `overBudget` refused the row
 *     instead of attempting it.
 *   - "a held-back card is re-announced on the next pass": same floor, one
 *     pass later — the rollback/recovery path only exists if the first pass
 *     really sends.
 *
 * What remains of the clock check is the pairMiss delete: the one spend with no
 * slice of its own. `break` → `continue` at the send gate stays: a refused row
 * is left untouched, and the quiet rows behind it still ride the pass's single
 * batch (the whole point of the patch).
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const PUSHWATCH = "src/pushwatch.ts";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "pushwatch: the clock check keeps only the spend with no slice of its own",
    old: L(
      "      // The check now governs the two things a row can actually spend: the",
      "      // pairMiss delete below and the alerting path's claim + reservation +",
      "      // send + final write. The 2026-09-17 incident this gate descends from",
      "      // (front stages ate the budget, the loop `break`-ed, 28 rows went",
      "      // unrefreshed while the note read `ok:0/0`) is answered harder than",
      "      // before: no quiet row is ever left behind, and every refused spend",
      "      // still says so — `budget-cut` plus `defer-send N`.",
    ),
    next: L(
      "      // What is LEFT of the clock check is the pairMiss delete below: a row's",
      "      // only spend with no slice of its own. The alerting path keeps the rule",
      "      // it was built with (its own send slice — see the send gate further",
      "      // down), because that slice is what bounds the pass tail: a live tick",
      "      // finished 4_857ms into a ~4_840ms race window and lost its flush",
      "      // entirely. The 2026-09-17 incident this gate descends from (front",
      "      // stages ate the budget, the loop `break`-ed, 28 rows went unrefreshed",
      "      // while the note read `ok:0/0`) is answered harder than before: no",
      "      // quiet row is ever left behind, and a refused card still says so",
      "      // (`budget-cut` plus `defer-send N`).",
    ),
  },
  {
    label: "pushwatch: the reserve doc names the one spend it still governs",
    old: L(
      "    /**",
      "     * Room a SPEND needs before it may START. The alerting path pays three",
      "     * round trips plus a Telegram send and the pairMiss delete pays one, and",
      "     * neither can be interrupted once begun — a row refused here is left",
      "     * untouched and re-claimed by the next tick (see the gate in the loop).",
      "     */",
    ),
    next: L(
      "    /**",
      "     * Room a SPEND needs before it may START — the pairMiss delete, which is",
      "     * the one spend with no send slice of its own to bound it. Refusing it is",
      "     * free: the row stays listed and the next pass re-finds it.",
      "     */",
    ),
  },
  {
    label: "pushwatch: the send gate keeps the slice as the only affordability rule",
    old: L(
      "        // `continue`, not `break`: a refused row is left COMPLETELY",
      "        // untouched (no claim, no write — see the alerting path below), so",
      "        // the rest of the rotation is still worth walking. Breaking here is",
      "        // what turned a short pass into an unmeasured tail of quiet rows.",
      "        if (overBudget || sendBudgetEnd - Date.now() < needMs) {",
    ),
    next: L(
      "        // `continue`, not `break`: a refused row is left COMPLETELY",
      "        // untouched (no claim, no write — see the alerting path below), so",
      "        // the rest of the rotation is still worth walking — the quiet rows",
      "        // behind it ride the pass's ONE batch for free. Breaking here is what",
      "        // turned a short pass into an unmeasured tail of quiet rows.",
      "        //",
      "        // The send SLICE alone decides (not the loop's clock): in a one-row",
      "        // pool this is still the progress floor's row, and the slice — not the",
      "        // per-row cap — is what bounds the pass tail (see the live tick cited",
      "        // at the top of the loop).",
      "        if (sendBudgetEnd - Date.now() < needMs) {",
    ),
  },
];

const text = fs.readFileSync(PUSHWATCH, "utf8");
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
fs.writeFileSync(PUSHWATCH, out);
console.log(`wrote ${PUSHWATCH}`);
