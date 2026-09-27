#!/usr/bin/env node
/*
 * Round 6.3, tests (fourth pass): the last two stubs, plus the real-DB pin the
 * merge most needs.
 *
 * The new test runs the merged call against a REAL local libsql database, in
 * the same shape the two-step test beside it already uses, and it isolates the
 * one guard the batch added: a pass whose CLAIM lost must not get to commit a
 * reservation either. Case (c) is written so the reservation's own
 * (last_state, last_alert_at) CAS would still MATCH — another isolate claimed
 * the row and reserved nothing yet — i.e. without `AND last_checked = ?` on the
 * second statement the expectation flips to {claimed:false, reserved:true} and
 * this test fails.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests4-2026-09-27.apply.js
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

// ---- 1. the dead half of the trips-counting double -------------------------
apply(
  "the counting double's dead reserve stub",
  j(
    "      claimPushWatchCheck: async (token, _expected, _now, v) => {",
    "        calls.total += 1;",
    "        calls.updated.push([token, v]);",
    "        return true;",
    "      },",
    "      reservePushWatchAlert: async () => { calls.total += 1; return true; },",
  ),
  j(
    "      claimPushWatchCheck: async (token, _expected, _now, v) => {",
    "        calls.total += 1;",
    "        calls.updated.push([token, v]);",
    "        return true;",
    "      },",
  ),
  j(
    "      claimPushWatchCheck: async (token, _expected, _now, v) => {",
    "        calls.total += 1;",
    "        calls.updated.push([token, v]);",
    "        return true;",
    "      },",
    "      updatePushWatchCheck: async (token, v) => {",
  ),
);

// ---- 2. the bounded-recap double ------------------------------------------
apply(
  "the bounded-recap double",
  j(
    "      claimPushWatch: async () => true,",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      reservePushWatchAlert: async () => true,",
    "      updatePushWatchCheck: async () => {},",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      updatePushWatchCheck: async () => {},",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      updatePushWatchCheck: async () => {},",
  ),
);

// ---- 3. the real-DB pin ----------------------------------------------------
apply(
  "the real-DB merged-call pin",
  j(
    "      assert.equal(s1, true);",
    "      assert.equal(s2, false);",
    "      assert.notEqual(mid, undefined);",
    "    } finally { t.cleanup(); }",
    "  });",
  ),
  j(
    "      assert.equal(s1, true);",
    "      assert.equal(s2, false);",
    "      assert.notEqual(mid, undefined);",
    "    } finally { t.cleanup(); }",
    "  });",
    "",
    "  // ---------- the merged claim+reservation, against the real store ----------",
    "  await test(\"claimAndReservePushWatch: one batch, and a lost claim can never reserve\", async () => {",
    "    // 2026-09-27: the two CAS writes became ONE batch (the alerting path's",
    "    // four subrequests → three). The claim's own create-once property is",
    "    // unchanged; what this pins is the guard the batch ADDED, because",
    "    // statement order inside one request is not what makes it safe:",
    "    // a pass whose claim lost must not get to commit a reservation either,",
    "    // even when the (state, alertAt) it read still matches — which is",
    "    // exactly case (c), where another isolate holds the claim and has not",
    "    // reserved yet.",
    "    const t = tmpDb();",
    "    try {",
    "      const db = new Db(t.p, undefined, t.client);",
    "      await db.init();",
    "      for (const [tok, sym] of [[\"MINTMRG\", \"MRG\"], [\"MINTMRG2\", \"MRG2\"]]) {",
    "        await db.upsertPushWatch({",
    "          token: tok, chatId: \"c1\", symbol: sym,",
    "          pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000,",
    "        });",
    "      }",
    "      const snapOf = async (tok) =>",
    "        (await db.listPushWatch(10)).find((r) => r.token === tok);",
    "",
    "      // (a) the happy path: both halves land, in ONE round trip.",
    "      const snap = await snapOf(\"MINTMRG\");",
    "      const a = await db.claimAndReservePushWatch(",
    "        \"MINTMRG\", snap.lastChecked, 5000,",
    "        snap.lastState ?? null, snap.lastAlertAt ?? 0, \"holder50\", 5000,",
    "      );",
    "      assert.deepEqual(a, { claimed: true, reserved: true });",
    "      const afterA = await snapOf(\"MINTMRG\");",
    "      assert.equal(afterA.lastState, \"holder50\", \"the transition is committed before the send\");",
    "      assert.equal(afterA.lastAlertAt, 5000);",
    "      assert.equal(afterA.lastChecked, 5000);",
    "",
    "      // (b) a concurrent isolate reading the SAME snapshot loses both",
    "      // halves: the claim on last_checked, and the reservation with it —",
    "      // the row must not end up carrying B's announcement.",
    "      const b = await db.claimAndReservePushWatch(",
    "        \"MINTMRG\", snap.lastChecked, 6000,",
    "        snap.lastState ?? null, snap.lastAlertAt ?? 0, \"liq1\", 6000,",
    "      );",
    "      assert.deepEqual(b, { claimed: false, reserved: false });",
    "      const afterB = await snapOf(\"MINTMRG\");",
    "      assert.equal(afterB.lastState, \"holder50\", \"B's transition never commits\");",
    "      assert.equal(afterB.lastAlertAt, 5000, \"…and A's clock is not moved\");",
    "",
    "      // (c) THE GUARD THE BATCH ADDED: another isolate claimed the row",
    "      // (7777) and has reserved nothing, so the pre-alert (state, alertAt)",
    "      // this call reads still MATCHES — the reservation's own CAS alone",
    "      // would commit. Only `AND last_checked = ?` (bound to this batch's own",
    "      // claim stamp, 8888) refuses it. Delete that half of the statement and",
    "      // this assertion flips to {claimed:false, reserved:true}.",
    "      const snap2 = await snapOf(\"MINTMRG2\");",
    "      assert.equal(await db.claimPushWatch(\"MINTMRG2\", snap2.lastChecked, 7777), true);",
    "      const c = await db.claimAndReservePushWatch(",
    "        \"MINTMRG2\", snap2.lastChecked, 8888,",
    "        snap2.lastState ?? null, snap2.lastAlertAt ?? 0, \"holder50\", 8888,",
    "      );",
    "      assert.deepEqual(",
    "        c, { claimed: false, reserved: false },",
    "        \"a pass that never claimed must not announce\",",
    "      );",
    "      const afterC = await snapOf(\"MINTMRG2\");",
    "      assert.equal(afterC.lastState, null, \"no transition landed\");",
    "      assert.equal(afterC.lastAlertAt, 0);",
    "      assert.equal(afterC.lastChecked, 7777, \"the claim holder's stamp is left alone\");",
    "    } finally { t.cleanup(); }",
    "  });",
  ),
  "claimAndReservePushWatch: one batch, and a lost claim can never reserve",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-tests4-2026-09-27.apply.js — done");
