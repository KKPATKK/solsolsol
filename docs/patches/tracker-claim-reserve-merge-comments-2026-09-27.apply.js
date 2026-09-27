#!/usr/bin/env node
/*
 * Round 6.3, comment truth: three notes still describe the claim and the
 * reservation as two separate round trips.
 *
 *  - pushwatch.TRACKER_SEND_CAP_MS: the transition "was already reserved (see
 *    reservePushWatchAlert)" — the guard is unchanged, only its name moved.
 *  - the send-ability gate's note, same rename.
 *  - scanner's watchdog audit: the chain's first two lines were one leash
 *    each; they are ONE batched call now, so the audited sum drops 1_500ms to
 *    5_850 (+1_200 pair = 7_050). The constant itself stays at 8_600 on
 *    purpose — this bound's job is to catch awaits NO bound covers, and an
 *    abandoned pass is the silent-miss class (duplicate-cards §17.5), so
 *    following the chain down wants its own live reading rather than riding
 *    this merge.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-comments-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const root = path.join(__dirname, "..", "..");

const edit = (rel, label, old, next, marker) => {
  const p = path.join(root, rel);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${rel}: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ ${rel}: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  fs.writeFileSync(p, src.replace(old, next));
  console.log(`✓ ${rel}: ${label} patched`);
};

edit(
  "src/pushwatch.ts",
  "the send cap's guard reference",
  j(
    " * exactly like a failed one — logged, not retried, because the state",
    " * transition was already reserved (see reservePushWatchAlert) and a retry",
    " * could deliver the duplicate card that guard exists to prevent.",
  ),
  j(
    " * exactly like a failed one — logged, not retried, because the state",
    " * transition was already reserved (the reservation rides the claim's own",
    " * batch — see Db.claimAndReservePushWatch) and a retry could deliver the",
    " * duplicate card that guard exists to prevent.",
  ),
  "the reservation rides the claim's own",
);

edit(
  "src/pushwatch.ts",
  "the send-ability gate's guard reference",
  j(
    "      // pass refuse a row it cannot finish: every alerting row reserves its",
    "      // state transition before sending and never retries (see",
    "      // reservePushWatchAlert), so starting one without the send slice",
  ),
  j(
    "      // pass refuse a row it cannot finish: every alerting row reserves its",
    "      // state transition before sending and never retries (see",
    "      // Db.claimAndReservePushWatch), so starting one without the send slice",
  ),
  "      // Db.claimAndReservePushWatch), so starting one without the send slice",
);

edit(
  "src/scanner.ts",
  "the watchdog's chain audit",
  j(
    " * A pass cannot be cut in half and still be correct: its rule is",
    " * reserve-then-send. Db.reservePushWatchAlert flips (last_state, last_alert_at)",
    " * BEFORE the card goes out, and only the row's FINAL updatePushWatchCheck rolls",
  ),
  j(
    " * A pass cannot be cut in half and still be correct: its rule is",
    " * reserve-then-send. The claim+reservation batch (Db.claimAndReservePushWatch;",
    " * they were two calls until 2026-09-27) flips (last_state, last_alert_at)",
    " * BEFORE the card goes out, and only the row's FINAL updatePushWatchCheck rolls",
  ),
  "The claim+reservation batch (Db.claimAndReservePushWatch;",
);

edit(
  "src/scanner.ts",
  "the audited chain, minus one leash",
  j(
    " * That outer edge is ONE row's worst-case bounded chain, audited 2026-09-23:",
    " *   claim          TRACKER_ROW_LEASH_MS   1_500ms",
    " *   reservation    TRACKER_ROW_LEASH_MS   1_500ms",
    " *   sends (row)    TRACKER_SEND_CAP_MS    1_350ms  (sendBudgetEnd's window)",
    " *   audit insert   TRACKER_ROW_LEASH_MS   1_500ms",
    " *   final write    TRACKER_ROW_LEASH_MS   1_500ms",
    " *                                        -------",
    " *                                        7_350ms",
    " * plus the pair batch (TRACKER_PAIRS_BUDGET_MS 1_200ms since the whole-pool",
    " * head, 2026-09-24) on the row that opens a pass, so 8_600ms is that chain with",
    " * slack. A pass on a degraded Turso can genuinely need all of it; anything",
    " * LONGER is an await no bound covers — which is exactly what this is for (live",
    " * 2026-09-23: 61 seconds on one pass).",
  ),
  j(
    " * That outer edge is ONE row's worst-case bounded chain, audited 2026-09-23",
    " * and re-audited 2026-09-27 — the claim and the reservation became ONE",
    " * batched call (Db.claimAndReservePushWatch), so the chain lost one leash:",
    " *   claim+reserve  TRACKER_ROW_LEASH_MS   1_500ms  (ONE batch, two statements)",
    " *   sends (row)    TRACKER_SEND_CAP_MS    1_350ms  (sendBudgetEnd's window)",
    " *   audit insert   TRACKER_ROW_LEASH_MS   1_500ms",
    " *   final write    TRACKER_ROW_LEASH_MS   1_500ms",
    " *                                        -------",
    " *                                        5_850ms",
    " * plus the pair batch (TRACKER_PAIRS_BUDGET_MS 1_200ms since the whole-pool",
    " * head, 2026-09-24) on the row that opens a pass: 7_050ms. The constant stays",
    " * at 8_600 rather than following the chain down, because this bound's ONE job",
    " * is to catch awaits no bound covers, and an abandoned pass is the silent-miss",
    " * class (docs/duplicate-cards.md §17.5) — tightening it to the new sum wants a",
    " * live reading of the merged path, not just the arithmetic. A pass on a",
    " * degraded Turso can genuinely need the whole chain; anything LONGER is an",
    " * await no bound covers — which is exactly what this is for (live",
    " * 2026-09-23: 61 seconds on one pass).",
  ),
  "and re-audited 2026-09-27 — the claim and the reservation became ONE",
);

console.log("node docs/patches/tracker-claim-reserve-merge-comments-2026-09-27.apply.js — done");
