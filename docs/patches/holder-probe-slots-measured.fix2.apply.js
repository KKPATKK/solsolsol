#!/usr/bin/env node
/**
 * Compile-tidy sibling of docs/patches/holder-probe-slots-measured.apply.js:
 * with the slot rule no longer derived from the slice (`holderSlots` is the
 * rate the refresh window needs, one probe), the `stageMs` local has no reader
 * left — the slice is what the COLLECT clamps itself to, at the call site. The
 * probe bound keeps its own line, with the note that it is also the whole of
 * what the stage waits for. Same discipline: exactly one match or nothing.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const old = `        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);
        const probeCapMs = TRACKER_HOLDER_CAP_MS + intervalMs;
        const stageMs = Math.max(
          0,
          Math.min(TRACKER_HOLDER_STAGE_MS, deadline - Date.now()),
        );`;

const next = `        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);
        // What ONE probe is allowed to cost: its fetch plus the single gate it
        // may queue behind — the same quantity the stage's collect waits out
        // (see TRACKER_HOLDER_CAP_MS / TRACKER_HOLDER_STAGE_MS).
        const probeCapMs = TRACKER_HOLDER_CAP_MS + intervalMs;`;

const text = fs.readFileSync(PW, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      pw: drop the slot-derived slice local");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS pw: drop the slot-derived slice local");
  process.exit(1);
}
fs.writeFileSync(PW, text.slice(0, first) + next + text.slice(first + old.length));
console.log("ok        pw: drop the slot-derived slice local");
