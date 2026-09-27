#!/usr/bin/env node
/*
 * Round 6.3, tests (second pass): the first script's markers matched as
 * SUBSTRINGS of the sites they had already rewritten (the 6- and 4-space
 * markers are suffixes of their 8-space twins), so four sites need their own
 * unambiguous anchors:
 *
 *   - the killed-pass throw override (it must throw from the merged call, or
 *     the test would pass on a path the pass no longer walks);
 *   - the note above it, which still named `claimPushWatch`;
 *   - the two watcher stubs (fakeDb, watchDb) whose row loop would otherwise
 *     die on a missing method instead of exercising the merge.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests2-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
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
  "the killed-pass throw override",
  j(
    "    const db = termDb([termRow()]);",
    "    db.claimPushWatch = async () => {",
    '      throw new Error("Too many subrequests by single Worker invocation");',
    "    };",
  ),
  j(
    "    const db = termDb([termRow()]);",
    "    db.claimAndReservePushWatch = async () => {",
    '      throw new Error("Too many subrequests by single Worker invocation");',
    "    };",
  ),
  '    const db = termDb([termRow()]);\n    db.claimAndReservePushWatch = async () => {',
);

apply(
  "the throw note's method name",
  j(
    "        // The row loop only runs when the listing HAS rows, so an empty",
    "        // listing would leave `claimPushWatch` uncalled and the pass would",
    "        // complete without ever hitting the throw.",
  ),
  j(
    "        // The row loop only runs when the listing HAS rows, so an empty",
    "        // listing would leave `claimAndReservePushWatch` uncalled and the",
    "        // pass would complete without ever hitting the throw.",
  ),
  "leave `claimAndReservePushWatch` uncalled",
);

apply(
  "the fakeDb stub",
  j(
    "      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },",
    "      claimPushWatch: async () => true,",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      reservePushWatchAlert: async () => true,",
  ),
  j(
    "      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },",
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
  ),
  "      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },\n      claimAndReservePushWatch:",
);

apply(
  "the watchDb stub",
  j(
    "    upsertPushWatchMany: async () => {},",
    "    claimPushWatch: async () => true,",
    "    // The silent row path claims AND writes in ONE batched round trip for the",
  ),
  j(
    "    upsertPushWatchMany: async () => {},",
    "    claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "    // The silent row path claims AND writes in ONE batched round trip for the",
  ),
  "    upsertPushWatchMany: async () => {},\n    claimAndReservePushWatch:",
);

apply(
  "the watchDb stub's reserved half",
  j(
    "    claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },",
    "    reservePushWatchAlert: async () => true,",
    "    updatePushWatchCheck: async (token, v) => { updated.push([token, v]); },",
  ),
  j(
    "    claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },",
    "    updatePushWatchCheck: async (token, v) => { updated.push([token, v]); },",
  ),
  "    claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },\n    updatePushWatchCheck: async (token, v) => { updated.push([token, v]); },",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-tests2-2026-09-27.apply.js — done");
