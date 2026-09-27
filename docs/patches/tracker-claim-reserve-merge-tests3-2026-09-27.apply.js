#!/usr/bin/env node
/*
 * Round 6.3, tests (third pass): every remaining stub that stood in for the
 * alert path's two round trips, and the killed-pass throw override.
 *
 * The counting doubles matter most: `assert.equal(out.trips, calls.total)` is
 * the suite's own proof that the reported round-trip count is the one the pass
 * really paid, so the merged call has to be the thing they count — one
 * increment, exactly like a single round trip, instead of the two the claim and
 * the reservation used to cost.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests3-2026-09-27.apply.js
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

// ---- 1. the killed-pass throw override -------------------------------------
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
  j(
    "    const db = termDb([termRow()]);",
    "    db.claimAndReservePushWatch = async () => {",
    '      throw new Error("Too many subrequests by single Worker invocation");',
  ),
);

// ---- 2. the three counting doubles -----------------------------------------
apply(
  "the trips-counting double (silent batch beside it)",
  j(
    "      claimPushWatch: async () => { calls.total += 1; return true; },",
    "      claimPushWatchChecksMany: async (rows) => {",
    "        calls.total += 1;",
    "        for (const r of rows) calls.updated.push([r.token, r.v]);",
    "        return rows.map(() => true);",
    "      },",
  ),
  j(
    "      // ONE round trip for the claim and the reservation since 2026-09-27",
    "      // (Db.claimAndReservePushWatch): the counter still sees exactly what",
    "      // the pass paid, which is what `out.trips === calls.total` compares.",
    "      claimAndReservePushWatch: async () => {",
    "        calls.total += 1;",
    "        return { claimed: true, reserved: true };",
    "      },",
    "      claimPushWatchChecksMany: async (rows) => {",
    "        calls.total += 1;",
    "        for (const r of rows) calls.updated.push([r.token, r.v]);",
    "        return rows.map(() => true);",
    "      },",
  ),
  "      // ONE round trip for the claim and the reservation since 2026-09-27",
);

apply(
  "the bounded-recap double",
  j(
    "      claimPushWatch: async () => true,",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      reservePushWatchAlert: async () => true,",
    "      updatePushWatchCheck: async () => {},",
    "      deletePushWatch: async () => {},",
    "      setPushWatchHolders: async () => {},",
    "    };",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      updatePushWatchCheck: async () => {},",
    "      deletePushWatch: async () => {},",
    "      setPushWatchHolders: async () => {},",
    "    };",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      updatePushWatchCheck: async () => {},",
    "      deletePushWatch: async () => {},",
    "      setPushWatchHolders: async () => {},",
  ),
);

apply(
  "the no-op prune double",
  j(
    "      claimPushWatch: async () => { calls.total += 1; return true; },",
    "      claimPushWatchChecksMany: async (rows) => {",
    "        calls.total += 1;",
    "        return rows.map(() => true);",
    "      },",
    "      claimPushWatchCheck: async () => { calls.total += 1; return true; },",
    "      reservePushWatchAlert: async () => { calls.total += 1; return true; },",
  ),
  j(
    "      claimAndReservePushWatch: async () => {",
    "        calls.total += 1;",
    "        return { claimed: true, reserved: true };",
    "      },",
    "      claimPushWatchChecksMany: async (rows) => {",
    "        calls.total += 1;",
    "        return rows.map(() => true);",
    "      },",
    "      claimPushWatchCheck: async () => { calls.total += 1; return true; },",
  ),
  "        return { claimed: true, reserved: true };\n      },\n      claimPushWatchChecksMany: async (rows) => {\n        calls.total += 1;\n        return rows.map(() => true);",
);

// ---- 3. the two silent-row overrides ---------------------------------------
apply(
  "the silent-claims override",
  j(
    "      ...watchDb(rows, updated),",
    "      claimPushWatch: async (token) => { claims.push(token); return true; },",
  ),
  j(
    "      ...watchDb(rows, updated),",
    "      // A silent row must never reach the alert path's ONE round trip",
    "      // (Db.claimAndReservePushWatch) — the batched claim below is the",
    "      // whole of what it costs.",
    "      claimAndReservePushWatch: async (token) => {",
    "        claims.push(token);",
    "        return { claimed: true, reserved: true };",
    "      },",
  ),
  j(
    "      // A silent row must never reach the alert path's ONE round trip",
    "      // (Db.claimAndReservePushWatch) — the batched claim below is the",
  ),
);

apply(
  "the silent-claims assertion",
  "    assert.deepEqual(claims, [], \"a silent row still spends no separate claim\");",
  "    assert.deepEqual(claims, [], \"a silent row still spends no separate claim+reserve\");",
  "a silent row still spends no separate claim+reserve",
);

apply(
  "the degraded-store override",
  j(
    "      ...watchDb(rows, []),",
    "      claimPushWatch: async () => true,",
  ),
  j(
    "      ...watchDb(rows, []),",
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
  ),
  j(
    "      ...watchDb(rows, []),",
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
  ),
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-tests3-2026-09-27.apply.js — done");
