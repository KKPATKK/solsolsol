#!/usr/bin/env node
/*
 * Round 6.3, budget half: the pass's slice is re-derived from the card's new
 * price, and the census names the method that now carries the round trip.
 *
 * The pass's arithmetic: entry (TRACKER_SUBREQ_FLOOR 3) + the tail's writes
 * (TRACKER_SUBREQ_RESERVE 6) + ONE card's path. The card was 4 subrequests
 * (claim, reservation, send, final write); it is 3 since the two CAS writes
 * ride ONE batch (Db.claimAndReservePushWatch), so the slice is 12, not 13.
 * The maintenance floor is derived from the same constant and follows on its
 * own (6 + 3 = 9).
 *
 * tickprobe's CENSUS_METHODS is the round-trip census: `claimPushWatch` and
 * `reservePushWatchAlert` are no longer called by the pass (a method that does
 * not exist on the handle is skipped, so leaving them would quietly misreport
 * which calls the row loop pays for).
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-budget-2026-09-27.apply.js
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

// ---- 1. the pass's slice, re-derived --------------------------------------
edit(
  "src/worker.ts",
  "TRACKER_PASS_SUBREQ_RESERVE 13 → 12",
  j(
    " * minutes). One alerting row's path (claim + reservation + send + final",
    " * write, see pushwatch.TRACKER_ALERT_PATH_SUBREQ) is 4 more, so the slice",
    " * is 13: what the pass needs to be worth starting IS a delivered card, not",
    " * just a closed ledger. `scanSubreqLeft` applies it; the scan's other",
    " * gating is unchanged.",
    " */",
    "export const TRACKER_PASS_SUBREQ_RESERVE = 13;",
  ),
  j(
    " * minutes). One alerting row's path (the claim+reservation batch, the send",
    " * and the final write — see pushwatch.TRACKER_ALERT_PATH_SUBREQ) is 3 more",
    " * since 2026-09-27: it was 4 while those two CAS writes were separate round",
    " * trips, which is where the 13 came from, and the pair now rides ONE batch",
    " * (Db.claimAndReservePushWatch). So the slice is 12: what the pass needs to",
    " * be worth starting IS a delivered card, not just a closed ledger.",
    " * `scanSubreqLeft` applies it; the scan's other gating is unchanged.",
    " */",
    "export const TRACKER_PASS_SUBREQ_RESERVE = 12;",
  ),
  "export const TRACKER_PASS_SUBREQ_RESERVE = 12;",
);

// ---- 2. the round-trip census follows the call site ------------------------
edit(
  "src/tickprobe.ts",
  "the census names the merged method",
  j(
    '  "claimPushWatch",',
    '  "claimPushWatchChecksMany",',
    '  "reservePushWatchAlert",',
    '  "updatePushWatchCheck",',
  ),
  j(
    '  "claimAndReservePushWatch",',
    '  "claimPushWatchChecksMany",',
    '  "updatePushWatchCheck",',
  ),
  '"claimAndReservePushWatch",',
);

console.log("node docs/patches/tracker-claim-reserve-merge-budget-2026-09-27.apply.js — done");
