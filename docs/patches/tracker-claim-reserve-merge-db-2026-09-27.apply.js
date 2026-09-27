#!/usr/bin/env node
/*
 * Round 6.3, DB half: `claimAndReservePushWatch` — the tracker's per-tick
 * claim and its alert reservation in ONE batch.
 *
 * WHY: an alerting row's path was claim (1) + reservation (1) + Telegram send
 * (1) + final write (1) = FOUR subrequests of the invocation's 50, and the
 * first two hit the same row with nothing between them but an `await`. Live
 * 2026-09-27T00:07-00:15Z: the pass read `rows 13-21/30 … defer-send 9-17`
 * with the tick's front already at 18-36 subrequests, so cards queued while
 * the scan's own work kept the budget. Batching the pair makes a card cost
 * THREE — the +33% the pass's throughput is short of.
 *
 * The reservation keeps its (last_state, last_alert_at) CAS, the ONLY
 * authoritative duplicate guard, and gains `last_checked = ?` bound to this
 * batch's claim stamp so it can never commit for a row a concurrent isolate
 * claimed instead.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-db-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "db.ts");
let src = fs.readFileSync(p, "utf8");

const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= db.ts: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ db.ts: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ db.ts: ${label} patched`);
};

apply(
  "claimAndReservePushWatch",
  j(
    "    return Number(res.rowsAffected ?? 0) > 0;",
    "  }",
    "",
    "  async markRecapClaimed(token: string): Promise<boolean> {",
  ),
  j(
    "    return Number(res.rowsAffected ?? 0) > 0;",
    "  }",
    "",
    "  /**",
    "   * ONE round trip for the alerting path's two writes — the per-tick claim",
    "   * and the alert reservation, in that order (2026-09-27).",
    "   *",
    "   * WHY: an alerting row paid claim (1) + reservation (1) + send (1) + final",
    "   * write (1) = FOUR subrequests, and the first two touch the same row with",
    "   * nothing between them but an `await`. Live readings measured what that",
    "   * costs the pass that only exists to deliver cards: `rows 13-21/30 …",
    "   * defer-send 9-17` per pass while the tick's front had already spent 18-36",
    "   * of the invocation's 50. Batching the pair makes a card cost THREE — the",
    "   * +33% the tracker's card throughput is actually short of (see",
    "   * pushwatch.TRACKER_ALERT_PATH_SUBREQ and",
    "   * worker.TRACKER_PASS_SUBREQ_RESERVE).",
    "   *",
    "   * WHAT IS UNCHANGED: both statements are the exact compare-and-swaps",
    "   * claimPushWatch and reservePushWatchAlert send — same guards, same",
    "   * columns — and the AUTHORITATIVE duplicate guard is still the",
    "   * reservation: matching on (last_state, last_alert_at) is what makes",
    "   * exactly one contender's UPDATE win, so the loser skips delivery.",
    "   *",
    "   * WHAT THE SECOND STATEMENT ADDS is `last_checked = ?`, bound to this",
    "   * batch's own claim stamp. Statement order alone could not stop the",
    "   * reservation from committing on a row a CONCURRENT isolate claimed",
    "   * between the caller's read and this batch: the row then carries that",
    "   * isolate's stamp, the reservation's guard fails, and the caller takes its",
    "   * ordinary lost-reservation path (hold the announcement, land the",
    "   * measurements, re-derive next pass). Two isolates stamping the same",
    "   * millisecond still cannot both reserve — the (last_state, last_alert_at)",
    "   * CAS decides, exactly as it did when the two writes were separate.",
    "   *",
    "   * Result order follows statement order — the same contract the recap",
    "   * claims and the silent-row batch rely on — so `claimed` false means the",
    "   * caller must leave the row completely untouched.",
    "   */",
    "  async claimAndReservePushWatch(",
    "    token: string,",
    "    expectedLastChecked: number,",
    "    now: number,",
    "    fromState: string | null,",
    "    fromAlertAt: number,",
    "    toState: string | null,",
    "    alertAt: number,",
    "  ): Promise<{ claimed: boolean; reserved: boolean }> {",
    "    const res = await this.get().batch(",
    "      [",
    "        {",
    '          sql: "UPDATE push_watch SET last_checked = ? WHERE token = ? AND last_checked = ?",',
    "          args: [now, token, expectedLastChecked],",
    "        },",
    "        {",
    "          sql: `UPDATE push_watch SET last_state = ?, last_alert_at = ?",
    "                WHERE token = ? AND last_state IS ? AND last_alert_at = ?",
    "                  AND last_checked = ?`,",
    "          args: [toState, alertAt, token, fromState, fromAlertAt, now],",
    "        },",
    "      ],",
    '      "write",',
    "    );",
    "    return {",
    "      claimed: Number(res[0]?.rowsAffected ?? 0) > 0,",
    "      reserved: Number(res[1]?.rowsAffected ?? 0) > 0,",
    "    };",
    "  }",
    "",
    "  async markRecapClaimed(token: string): Promise<boolean> {",
  ),
  "async claimAndReservePushWatch(",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-db-2026-09-27.apply.js — done");
