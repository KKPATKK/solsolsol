#!/usr/bin/env node
/**
 * Companion to docs/patches/holder-probe-slots-measured.apply.js: the paragraph
 * above the slot rule still described the OLD rule ("a slice that covers gate +
 * fetch can serve the WHOLE due head"), which the new rule deliberately does
 * not do. Reworded so the two lines agree: a probe whose whole cost cannot be
 * waited out is started by neither rule — it would be collected as a miss and
 * parked for TRACKER_HOLDER_BACKOFF_MS.
 *
 * (Both lines sit below the ~line-1000 window where str_replace stops matching
 * in this file — see docs/round-trips.md §6 — hence the file tools cannot do
 * it.) Same discipline: exactly one match or nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const old = `        // What a probe costs on top of its fetch: ONE gate (see
        // TRACKER_HOLDER_STAGE_MS for the measured shape — the gate fires the
        // calls that queued behind it together, so extra probes do not stack
        // cost). A slice that covers gate + fetch can serve the WHOLE due head;
        // a shorter one is only worth the single probe that needs no gate,
        // because every other probe would be collected as a miss and parked.`;

const next = `        // What a probe costs on top of its fetch: ONE gate (see
        // TRACKER_HOLDER_STAGE_MS for the measured shape — the gate fires the
        // calls that queued behind it together, so extra probes do not stack
        // cost). A probe whose whole cost the stage cannot wait out is started
        // by neither rule below: it would be collected as a miss and parked.`;

const text = fs.readFileSync(PW, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      pw: the old whole-head wording in the gate note");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS pw: the old whole-head wording in the gate note");
  process.exit(1);
}
fs.writeFileSync(PW, text.slice(0, first) + next + text.slice(first + old.length));
console.log("ok        pw: the old whole-head wording in the gate note");
