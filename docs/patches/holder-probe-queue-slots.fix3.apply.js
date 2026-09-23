#!/usr/bin/env node
/**
 * Third correction: two comments still described the abandoned per-index cap
 * model ("probeIndex × interval") instead of the measured one gate per probe.
 * Text only — no behaviour — but the repo's habit is that the note and the code
 * say the same thing.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

const EDITS = [
  {
    file: PW,
    name: "pw: the collect comment names one gate, not the retired index model",
    old: `      // No new unbounded await: every probe is already capped by its own
      // queue-aware slice (TRACKER_HOLDER_CAP_MS + probeIndex × interval), and
      // this only decides how long the pass is willing to WAIT for the ones
      // still in flight — the stage slice the dispatch above sized the started
      // probes to fit inside (TRACKER_HOLDER_STAGE_MS).`,
    new: `      // No new unbounded await: every probe is already capped by its own
      // fetch plus one gate (see TRACKER_HOLDER_CAP_MS and the dispatch above),
      // and this only decides how long the pass is willing to WAIT for the ones
      // still in flight — the stage slice those caps were sized to fit inside
      // (TRACKER_HOLDER_STAGE_MS).`,
  },
  {
    file: TU,
    name: "tu: the starvation test's assertion matches the gate model",
    old: `    assert.equal(probes, 1, "the slice covers one queue turn, so one probe starts");`,
    new: `    assert.equal(probes, 1, "a slice shorter than gate + fetch starts only the gate-free probe");`,
  },
];

const staged = new Map();
for (const e of EDITS) {
  if (!staged.has(e.file)) staged.set(e.file, fs.readFileSync(e.file, "utf8"));
  const text = staged.get(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.name}`);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.name}`);
    process.exit(1);
  }
  staged.set(e.file, text.slice(0, first) + e.new + text.slice(first + e.old.length));
  console.log(`staged    ${e.name}`);
}

for (const [file, text] of staged) {
  fs.writeFileSync(file, text);
  console.log(`ok        ${file}`);
}
