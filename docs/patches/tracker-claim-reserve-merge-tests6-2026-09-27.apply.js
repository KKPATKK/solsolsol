#!/usr/bin/env node
/*
 * Round 6.3, tests (sixth pass): `claimLost` is published on the pass PULSE
 * (notePassPulse), not in runTick's return object — the two new tests read it
 * from the wrong place and failed as `undefined !== 1`. Everything else in
 * them (no send, no write, the held announcement, checked 1) already passed,
 * which is why these are the only two edits.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests6-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(p, "utf8");

const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= test-unit.js: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ test-unit.js: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ test-unit.js: ${label} patched`);
};

apply(
  "the lost-claim pulse reading",
  '    assert.equal(out.claimLost, 1);',
  '    assert.equal(trackerPassPulse().claimLost, 1, "the loss is published on the pulse");',
  '    assert.equal(trackerPassPulse().claimLost, 1, "the loss is published on the pulse");',
);

apply(
  "the lost-reservation pulse reading",
  '    assert.equal(out.claimLost, 0);',
  '    assert.equal(trackerPassPulse().claimLost, 0, "only the reservation was lost, not the row");',
  '"only the reservation was lost, not the row"',
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-tests6-2026-09-27.apply.js — done");
