#!/usr/bin/env node
/*
 * Round 6.3, tracker half: the alerting row's claim and reservation ride ONE
 * batch, so a card costs three subrequests instead of four.
 *
 * Live 2026-09-27T00:07-00:15Z (the readings this is for):
 *   `ok:21/0 rows 21/30 … defer-send 9 subreq-cut 9`
 *   `ok:13/1 rows 13/30 … defer-send 17 budget-cut`
 *   `ok:0/0 deferred:subreq-budget`            ← the whole pass yields
 * with the tick's front at 18-36 of the invocation's 50 subrequests. Cards go
 * out 0-1 per pass while 9-17 rows wait (oldest 16 minutes).
 *
 * The two losses stay distinct: a lost CLAIM leaves the row untouched (it is
 * another isolate's row), a lost RESERVATION still lands the row's
 * measurements with the announcement columns held.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-watch-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "pushwatch.ts");
let src = fs.readFileSync(p, "utf8");

const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= pushwatch.ts: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ pushwatch.ts: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ pushwatch.ts: ${label} patched`);
};

// ---- 1. the alerting path: two CAS writes in one round trip ----------------
apply(
  "the merged claim+reserve call",
  j(
    "      trips += 1;",
    "      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now))) {",
    "        claimLost += 1;",
    "        continue;",
    "      }",
    "      checked += 1;",
    "      // HOLD THE RESERVATION → FINAL-WRITE SPAN (see holdRowSpan and",
    "      // docs/duplicate-cards.md §17.5): the reservation below commits the",
    "      // transition before the send, and only the final write restores the",
    "      // bookkeeping that says so. Created HERE — before the reservation goes",
    "      // out, so that write is covered too — and released at both of the span's",
    "      // exits: the lost race below, and the final write at the row's end.",
    "      const releaseRowSpan = this.holdRowSpan(TRACKER_ROW_SPAN_HOLD_MS);",
    "      // Authoritative duplicate guard: reserve the state transition",
    "      // BEFORE delivering. The last_checked claim alone cannot stop an",
    "      // isolate that reads between this isolate's claim and its final",
    "      // write — it inherits the claimed stamp but the pre-alert state.",
    "      // Matching on (last_state, last_alert_at) makes exactly one",
    "      // contender's UPDATE win; the loser skips delivery. Skipped entirely",
    "      // on a backfill pass, which sends nothing.",
    "      // Wrapped so the ledger counts the reservation exactly when it runs",
    "      // (the && chain short-circuits when there is nothing to alert).",
    "      const reserveAlert = async (): Promise<boolean> => {",
    "        trips += 1;",
    "        return this.db.reservePushWatchAlert(",
    "          row.token,",
    "          row.lastState ?? null,",
    "          row.lastAlertAt ?? 0,",
    "          evalResult.lastState ?? null,",
    "          evalResult.lastAlertAt,",
    "        );",
    "      };",
    "      if (",
    "        !backfill &&",
    "        evalResult.alerts.length > 0 &&",
    "        !(await reserveAlert())",
    "      ) {",
    "        trips += 1;",
  ),
  j(
    "      // ONE round trip pays for BOTH of this row's compare-and-swaps: the",
    "      // per-tick claim and the alert reservation are the same row, one",
    "      // `await` apart, and batching them is what takes an alerting row's",
    "      // path from four subrequests to three (see Db.claimAndReservePushWatch",
    "      // and TRACKER_ALERT_PATH_SUBREQ). Statement order still runs claim →",
    "      // reservation, and the reservation additionally inherits the claim's",
    "      // own stamp (`last_checked = ?`), so it can never commit for a row a",
    "      // concurrent isolate claimed instead.",
    "      //",
    "      // The AUTHORITATIVE duplicate guard is still the reservation (matching",
    "      // on (last_state, last_alert_at) is what makes exactly one contender's",
    "      // UPDATE win — the last_checked claim alone cannot stop an isolate that",
    "      // reads between this isolate's claim and its final write).",
    "      //",
    "      // The two losses stay DISTINCT, because they mean different things: a",
    "      // lost CLAIM is another isolate's row, so this pass leaves it completely",
    "      // untouched; a lost RESERVATION means the row is ours but the transition",
    "      // was already announced elsewhere, so the announcement columns stay held",
    "      // and only the measurements land (the write below).",
    "      //",
    "      // HOLD THE RESERVATION → FINAL-WRITE SPAN (see holdRowSpan and",
    "      // docs/duplicate-cards.md §17.5): the batch below commits the transition",
    "      // before the send, and only the final write restores the bookkeeping",
    "      // that says so. Created BEFORE the batch goes out, so that write is",
    "      // covered too, and released at all three exits — the lost claim, the",
    "      // lost reservation, and the row's final write.",
    "      const releaseRowSpan = this.holdRowSpan(TRACKER_ROW_SPAN_HOLD_MS);",
    "      trips += 1;",
    "      const { claimed, reserved } = await this.db.claimAndReservePushWatch(",
    "        row.token,",
    "        row.lastChecked,",
    "        now,",
    "        row.lastState ?? null,",
    "        row.lastAlertAt ?? 0,",
    "        evalResult.lastState ?? null,",
    "        evalResult.lastAlertAt,",
    "      );",
    "      if (!claimed) {",
    "        claimLost += 1;",
    "        releaseRowSpan();",
    "        continue;",
    "      }",
    "      checked += 1;",
    "      if (!reserved) {",
    "        trips += 1;",
  ),
  "claimAndReservePushWatch(",
);

// ---- 2. the card's price, re-derived ---------------------------------------
apply(
  "TRACKER_ALERT_PATH_SUBREQ 4 → 3",
  j(
    " * What ONE alerting row's path spends, and why it is a named number: the",
    " * claim CAS, the reservation, the Telegram send and the row's final write.",
    " * The maintenance floor below is derived from it (and so is",
    ' * worker.TRACKER_PASS_SUBREQ_RESERVE), because "the pass fits" has to mean',
    ' * "a card fits", not "the gates close cleanly".',
    " */",
    "const TRACKER_ALERT_PATH_SUBREQ = 4;",
  ),
  j(
    " * What ONE alerting row's path spends, and why it is a named number: the",
    " * claim CAS **and** the alert reservation (2026-09-27: they ride ONE batch,",
    " * see Db.claimAndReservePushWatch), the Telegram send and the row's final",
    " * write. The maintenance floor below is derived from it (and so is",
    ' * worker.TRACKER_PASS_SUBREQ_RESERVE), because "the pass fits" has to mean',
    ' * "a card fits", not "the gates close cleanly".',
    " *",
    " * 4 → 3 on 2026-09-27, and that −1 is the pass's throughput story: the two",
    " * statements hit the same row with nothing between them but an `await`,",
    " * while live the tick's front had already spent 18-36 of the invocation's",
    " * 50 and the row loop was refusing `defer-send 9`-`17` cards a pass.",
    " */",
    "const TRACKER_ALERT_PATH_SUBREQ = 3;",
  ),
  "const TRACKER_ALERT_PATH_SUBREQ = 3;",
);

// ---- 3. the terminal-row hygiene note: the pair is one batch now -----------
apply(
  "the hygiene note names the merged pair",
  j(
    " *   - `last_alert_at` — `reservePushWatchAlert` writes the pass's `now`;",
    " *   - `last_checked` — `claimPushWatch` writes that same `now`, and then the",
  ),
  j(
    " *   - `last_alert_at` — the alert reservation writes the pass's `now` (since",
    " *     2026-09-27 it rides the SAME batch as the claim, see",
    " *     Db.claimAndReservePushWatch — two statements, one `now`);",
    " *   - `last_checked` — the claim writes that same `now`, and then the",
  ),
  "Db.claimAndReservePushWatch — two statements, one `now`",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-watch-2026-09-27.apply.js — done");
