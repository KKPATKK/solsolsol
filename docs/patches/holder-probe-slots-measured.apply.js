#!/usr/bin/env node
/**
 * Charge the holder stage's probe slots to the endpoint's MEASURED latency.
 *
 * Live 2026-09-23, `/debug/birdeye-overview` from the worker's own egress on a
 * live tracked mint: 1_008 / 2_368 / 2_525 / 2_281 / 2_451 / 2_272ms — five of
 * six calls above the 1_200ms fetch cap the stage handed each probe. So every
 * pass with four due rows read `probe4 miss3` while waiting 2_307ms for its
 * one count: three Birdeye calls spent, three rows parked for the 10-minute
 * backoff, ONE count written. The gate is not the problem (probes dispatched
 * together fire in the same window, so N of them cost one wait, not N) — the
 * cap sat below the endpoint's own median.
 *
 * The two constants are edited by the file tools in this same change (they sit
 * above the ~line-1000 window where str_replace stops matching in this file —
 * see docs/round-trips.md §6): TRACKER_HOLDER_CAP_MS 1_200 → 2_400 and
 * TRACKER_HOLDER_STAGE_MS 2_400 → 3_500 (the fetch plus the one gate a call may
 * queue behind). This script carries the part below that window: the slot rule
 * itself, which now starts ONE probe a pass — the rate the refresh window needs
 * (~1 count/min on ~30 tracked rows over 30 minutes) — instead of the whole due
 * head at three wasted subrequests a pass.
 *
 * Same discipline as every other script in here: exactly one match or nothing
 * is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const old = `        const holderSlots = stageMs >= probeCapMs ? cfg.maxHolderChecksPerTick : 1;`;

const next = `        // ONE probe per pass — the rate the refresh window needs, not the whole
        // due head (see TRACKER_HOLDER_STAGE_MS for the measurements: ~1 count a
        // minute keeps a 30-minute window turning on ~30 tracked rows). Every
        // extra probe is another Birdeye subrequest out of the invocation's 50,
        // and the old cap threw 3 of every 4 of them away. The config cap stays
        // the upper bound, so the table can be widened again by changing this
        // rule alone; the rows it cannot reach are reported as \`cut\` and keep
        // the front of the next pass's due list.
        const holderSlots = Math.min(cfg.maxHolderChecksPerTick, 1);`;

const text = fs.readFileSync(PW, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      pw: one probe a pass, charged to the measured cap");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS pw: one probe a pass, charged to the measured cap");
  process.exit(1);
}
fs.writeFileSync(PW, text.slice(0, first) + next + text.slice(first + old.length));
console.log("ok        pw: one probe a pass, charged to the measured cap");
