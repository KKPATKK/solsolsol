#!/usr/bin/env node
/*
 * Round 6.3, tests: the tracker's stubs follow the merged call, the slice
 * arithmetic is re-derived (13 → 12), and four new pins hold the merge:
 *
 *   - an alerting row pays ONE round trip, and neither of the two old calls is
 *     made separately (a later edit that reintroduces either one fails here);
 *   - a lost CLAIM leaves the row untouched (no send, no write);
 *   - a lost RESERVATION still lands the measurements with the announcement
 *     columns held — the distinction the merge had to preserve;
 *   - Db.claimAndReservePushWatch is ONE batch of exactly two CAS statements,
 *     the reserve guarded by the claim's own stamp, with per-statement
 *     outcomes mapped back to {claimed, reserved}.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests-2026-09-27.apply.js
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

// ---- 1. the shared watcher stub -------------------------------------------
apply(
  "termDb's alert-path stub",
  j(
    "      claimPushWatch: async () => true,",
    "      claimPushWatchChecksMany: async (rows) => {",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => {",
  ),
  "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
);

apply(
  "termDb's second stub",
  j(
    "      claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },",
    "      reservePushWatchAlert: async () => true,",
  ),
  j(
    "      claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },",
  ),
  "      claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },\n      updatePushWatchCheck:",
);

// ---- 2. the two "the throw is the row loop's" overrides --------------------
apply(
  "the setup-vs-rows throw override",
  j(
    "        db.listPushWatch = async () => [termRow()];",
    "        db.claimPushWatch = async () => {",
    '          throw new Error("Too many subrequests by single Worker invocation");',
    "        };",
  ),
  j(
    "        db.listPushWatch = async () => [termRow()];",
    "        db.claimAndReservePushWatch = async () => {",
    '          throw new Error("Too many subrequests by single Worker invocation");',
    "        };",
  ),
  "        db.claimAndReservePushWatch = async () => {",
);

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
  "    db.claimAndReservePushWatch = async () => {",
);

// ---- 3. the two one-off watcher stubs --------------------------------------
apply(
  "the enrollment test's stub",
  j(
    "        claimPushWatch: async () => true,",
    "        claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "        claimPushWatchCheck: async () => true,",
    "        reservePushWatchAlert: async () => true,",
  ),
  j(
    "        claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "        claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "        claimPushWatchCheck: async () => true,",
  ),
  "        claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
);

apply(
  "the fakeDb stub",
  j(
    "      claimPushWatch: async () => true,",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
    "      reservePushWatchAlert: async () => true,",
  ),
  j(
    "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
    "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
    "      claimPushWatchCheck: async () => true,",
  ),
  "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
);

// ---- 4. the slice arithmetic, re-derived -----------------------------------
apply(
  "the subreq reserve arithmetic",
  j(
    "    // The pass's own arithmetic: entry floor 3 + tail reserve 6 + ONE alerting",
    "    // row's path 4 (the claim, the reservation, the send and the final write).",
    "    // The first version stopped at 9 and the live pass read `rows 8/30 …",
    "    // subreq-cut 22 defer-send 22`: the pass could start and close while every",
    "    // card behind it was refused.",
    "    assert.equal(TRACKER_PASS_SUBREQ_RESERVE, 13);",
    "    assert.equal(scanSubreqLeft(30), 17);",
    "    assert.equal(scanSubreqLeft(TRACKER_PASS_SUBREQ_RESERVE), 0);",
    "    // Negative is a real answer — clamping it to 0 would read as \"exactly at",
    "    // the reserve\" and hide that the slice is already spent.",
    "    assert.equal(scanSubreqLeft(2), -11);",
  ),
  j(
    "    // The pass's own arithmetic: entry floor 3 + tail reserve 6 + ONE alerting",
    "    // row's path. That path was 4 (claim, reservation, send, final write); it",
    "    // is 3 since 2026-09-27, when the claim and the reservation began riding",
    "    // ONE batch (Db.claimAndReservePushWatch, pushwatch.TRACKER_ALERT_PATH_SUBREQ).",
    "    // The first version stopped at 9 and the live pass read `rows 8/30 …",
    "    // subreq-cut 22 defer-send 22`: the pass could start and close while every",
    "    // card behind it was refused.",
    "    assert.equal(TRACKER_PASS_SUBREQ_RESERVE, 12);",
    "    assert.equal(scanSubreqLeft(30), 18);",
    "    assert.equal(scanSubreqLeft(TRACKER_PASS_SUBREQ_RESERVE), 0);",
    "    // Negative is a real answer — clamping it to 0 would read as \"exactly at",
    "    // the reserve\" and hide that the slice is already spent.",
    "    assert.equal(scanSubreqLeft(2), -10);",
  ),
  "assert.equal(TRACKER_PASS_SUBREQ_RESERVE, 12);",
);

// ---- 5. the three pass-level pins -----------------------------------------
apply(
  "the three new pass-level tests",
  j(
    "    // The row counters are published when the LOOP RETURNS, so a death inside the",
    "    // loop honestly reports zero: how far the rotation got is the durable row's own",
    "    // `fresh` count, not this.",
    "    assert.equal(live.checked, 0);",
    "  });",
  ),
  j(
    "    // The row counters are published when the LOOP RETURNS, so a death inside the",
    "    // loop honestly reports zero: how far the rotation got is the durable row's own",
    "    // `fresh` count, not this.",
    "    assert.equal(live.checked, 0);",
    "  });",
    "",
    "  // ---------- the alerting row's two CAS writes ride ONE round trip ----------",
    "  //",
    "  // 2026-09-27: the per-tick claim and the alert reservation are the same row,",
    "  // one `await` apart, so they became ONE batch (Db.claimAndReservePushWatch) —",
    "  // an alerting row's path drops from four subrequests to three. Live",
    "  // 2026-09-27T00:07-00:15Z: `rows 13-21/30 … defer-send 9-17` per pass while the",
    "  // tick's front had already spent 18-36 of the invocation's 50.",
    "  await test(\"PushWatcher: an alerting row pays ONE round trip for claim + reservation\", async () => {",
    "    const calls = { merged: 0, claim: 0, reserve: 0 };",
    "    const db = termDb([termRow()]);",
    "    db.claimAndReservePushWatch = async () => {",
    "      calls.merged += 1;",
    "      return { claimed: true, reserved: true };",
    "    };",
    "    // The two old round trips must be GONE from this path, not merely unused",
    "    // by luck: a later edit that reintroduces either one fails right here.",
    "    db.claimPushWatch = async () => { calls.claim += 1; return true; };",
    "    db.reservePushWatchAlert = async () => { calls.reserve += 1; return true; };",
    "    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
    "    const out = await pw.runTick();",
    "    assert.equal(calls.merged, 1, \"the claim and the reservation ride ONE batch\");",
    "    assert.equal(calls.claim + calls.reserve, 0, \"neither half is a round trip of its own\");",
    "    assert.equal(out.alerted, 1, \"and the card still goes out\");",
    "  });",
    "",
    "  await test(\"PushWatcher: a lost CLAIM leaves the row untouched — no send, no write\", async () => {",
    "    let writes = 0;",
    "    let sends = 0;",
    "    const db = termDb([termRow()]);",
    "    db.claimAndReservePushWatch = async () => ({ claimed: false, reserved: false });",
    "    db.updatePushWatchCheck = async () => { writes += 1; };",
    "    const pw = termWatcher(db, { api: { sendMessage: async () => { sends += 1; return { message_id: 1 }; } } }, 2_000);",
    "    const out = await pw.runTick();",
    "    assert.equal(sends, 0, \"another isolate's row is never delivered here\");",
    "    assert.equal(writes, 0, \"and it is not written either — the loss is total, by design\");",
    "    assert.equal(out.claimLost, 1);",
    "    assert.match(String(out.note), /lost 1/);",
    "  });",
    "",
    "  await test(\"PushWatcher: a lost RESERVATION holds the announcement and lands the measurements\", async () => {",
    "    // The distinction the merge had to keep: the claim was WON (the row is this",
    "    // pass's), the reservation was LOST (the transition was announced elsewhere),",
    "    // so no card is sent and the announcement columns stay held at their",
    "    // pre-alert values while the row's own measurements land.",
    "    const written = [];",
    "    let sends = 0;",
    "    const db = termDb([termRow()]);",
    "    db.claimAndReservePushWatch = async () => ({ claimed: true, reserved: false });",
    "    db.updatePushWatchCheck = async (token, v) => { written.push([token, v]); };",
    "    const pw = termWatcher(db, { api: { sendMessage: async () => { sends += 1; return { message_id: 1 }; } } }, 2_000);",
    "    const out = await pw.runTick();",
    "    assert.equal(sends, 0, \"the loser never delivers\");",
    "    assert.equal(written.length, 1, \"the claimed row still records its check\");",
    "    const [, v] = written[0];",
    "    assert.equal(v.lastState, null, \"the announcement is held at the pre-alert state\");",
    "    assert.equal(v.lastAlertAt, 0, \"and at the pre-alert clock\");",
    "    assert.equal(out.checked, 1, \"a won claim is not a lost row\");",
    "    assert.equal(out.claimLost, 0);",
    "  });",
  ),
  "an alerting row pays ONE round trip for claim + reservation",
);

// ---- 6. the DB-level pin ---------------------------------------------------
apply(
  "the Db.claimAndReservePushWatch pin",
  j(
    "    assert.ok(",
    "      elapsed < 6_000,",
    "      `call settled in ${elapsed}ms — the old 6s wall (7200ms) would leave no retry window`,",
    "    );",
    "  });",
  ),
  j(
    "    assert.ok(",
    "      elapsed < 6_000,",
    "      `call settled in ${elapsed}ms — the old 6s wall (7200ms) would leave no retry window`,",
    "    );",
    "  });",
    "",
    "  await test(\"Db.claimAndReservePushWatch: ONE batch, claim first, reservation bound to its stamp\", async () => {",
    "    // The duplicate-safety hinge of the 2026-09-27 merge. Statement order alone",
    "    // cannot stop the reservation from committing for a row a CONCURRENT isolate",
    "    // claimed between the caller's read and the batch, so the reserve statement",
    "    // carries `last_checked = ?` bound to THIS batch's claim stamp. The",
    "    // authoritative (last_state, last_alert_at) CAS is unchanged.",
    "    const scripted = (claimed, reserved) => {",
    "      const seen = [];",
    "      const isClaim = (s) => /UPDATE push_watch SET last_checked = \\? WHERE token/.test(String(s.sql));",
    "      return {",
    "        seen,",
    "        execute: async () => ({ rows: [], rowsAffected: 0 }),",
    "        batch: async (stmts) => {",
    "          seen.push(stmts);",
    "          return stmts.map((s) => {",
    "            const sql = String(s.sql);",
    "            if (!/UPDATE push_watch SET/.test(sql)) return { rows: [], rowsAffected: 1 };",
    "            return { rows: [], rowsAffected: isClaim(s) ? (claimed ? 1 : 0) : reserved ? 1 : 0 };",
    "          });",
    "        },",
    "      };",
    "    };",
    "    const roundTrip = (client) =>",
    "      client.seen.filter((b) => b.some((s) => /UPDATE push_watch/.test(String(s.sql))));",
    "",
    "    const both = scripted(true, true);",
    "    const db = new Db(\"libsql://unused\", undefined, both);",
    "    await db.init();",
    "    assert.deepEqual(",
    "      await db.claimAndReservePushWatch(\"tok\", 111, 222, null, 0, \"rug\", 222),",
    "      { claimed: true, reserved: true },",
    "    );",
    "    const cas = roundTrip(both);",
    "    assert.equal(cas.length, 1, \"the claim and the reservation are ONE round trip\");",
    "    assert.equal(cas[0].length, 2, \"carrying exactly the two compare-and-swaps\");",
    "    assert.match(cas[0][0].sql, /SET last_checked = \\? WHERE token = \\? AND last_checked = \\?/);",
    "    assert.match(cas[0][1].sql, /last_state IS \\? AND last_alert_at = \\?/);",
    "    assert.match(cas[0][1].sql, /AND last_checked = \\?/, \"the reservation inherits the claim's stamp\");",
    "    assert.deepEqual(",
    "      cas[0][1].args,",
    "      [\"rug\", 222, \"tok\", null, 0, 222],",
    "      \"…bound to THIS batch's own claim stamp, not the caller's read\",",
    "    );",
    "",
    "    // Per-statement outcomes travel separately: the two losses are DIFFERENT",
    "    // paths in the pass (skip untouched vs hold the announcement), so a batch",
    "    // that could not tell them apart would be a silent-miss bug.",
    "    const lostReserve = scripted(true, false);",
    "    const db2 = new Db(\"libsql://unused\", undefined, lostReserve);",
    "    await db2.init();",
    "    assert.deepEqual(",
    "      await db2.claimAndReservePushWatch(\"tok\", 111, 222, null, 0, \"rug\", 222),",
    "      { claimed: true, reserved: false },",
    "    );",
    "    const lostClaim = scripted(false, false);",
    "    const db3 = new Db(\"libsql://unused\", undefined, lostClaim);",
    "    await db3.init();",
    "    assert.deepEqual(",
    "      await db3.claimAndReservePushWatch(\"tok\", 111, 222, null, 0, \"rug\", 222),",
    "      { claimed: false, reserved: false },",
    "      \"a lost claim is reported as one — the reservation never gets to commit\",",
    "    );",
    "  });",
  ),
  "Db.claimAndReservePushWatch: ONE batch, claim first, reservation bound to its stamp",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/tracker-claim-reserve-merge-tests-2026-09-27.apply.js — done");
