#!/usr/bin/env node
/*
 * APPLY (idempotent): offline tests for the drain's adaptive yield + forced batch.
 *
 * scripts/test-unit.js is past this repo's file-edit window, so the block lands
 * as an anchored, verify-then-write script that prints ✓ / = / ✗.
 *
 * WHAT IT PINS (see docs/patches/drain-reserve-2026-09-28.apply.js):
 *   - an UNMEASURED isolate keeps the old flat behaviour exactly;
 *   - a measured pass moves the yield, clamped to
 *     [DRAIN_TRACKER_RESERVE_MIN, DRAIN_TRACKER_RESERVE], by the WORST of the
 *     recent samples, and broken readings are dropped rather than believed;
 *   - a queue over DEFERRED_FORCE_DRAIN_RECORDS drains ahead of the pass with
 *     only DEFERRED_FORCE_DRAIN_FLOOR left for its tail — with a control run
 *     under the cap, so the cap itself is what is being tested;
 *   - only the tick path reports a spend (source-level wiring check).
 *
 * Run: node docs/patches/drain-reserve-tests-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");

const ANCHOR = `  await test("tickprobe: a drain record is retired once it is history", () => {`;

const BLOCK = `  await test("tickprobe: the drain yields what the pass measured, and a flooded queue drains first", () => {
    // WHY (2026-09-28): the yield was a FLAT DRAIN_TRACKER_RESERVE (14), and 14
    // is the need of a pass that has ROOM to be worth starting. Once the 60s
    // cadence came back the scan's own spend read 24-36 of the 38 usable
    // subrequests, so \`left\` was 2-14 — \`<= 14\` on EVERY tick — and the drain
    // landed nothing while the queue grew 305 -> 2098 owed records in 26 minutes
    // (live 00:02-00:28Z: \`calls 0\`, \`heldForTracker 2\`, \`failures 0\`). Two
    // rules, one test: the yield is what the pass REALLY used (measured and
    // clamped), and a queue past the cap drains ahead of the pass with only its
    // tail writes protected.
    const {
      installTickProbe,
      drainDeferredWrites,
      resetTickProbe,
      writeDrainView,
      deferredWriteCount,
      noteTrackerPassSpend,
      drainTrackerReserve,
      trackerPassSpendView,
      DRAIN_TRACKER_RESERVE,
      DRAIN_TRACKER_RESERVE_MIN,
      TRACKER_PASS_SPEND_RING,
      DEFERRED_FORCE_DRAIN_RECORDS,
      DEFERRED_FORCE_DRAIN_FLOOR,
      DEFERRED_COALESCE_MAX_PER_CALL,
    } = require("../dist/tickprobe.js");
    const mkDb = () => {
      const calls = [];
      return {
        calls,
        async recordTokenStatsMany(records) { calls.push(records.length); },
        async updateTokenMaxMcaps() {},
      };
    };
    const queue = async (db, tokens) => {
      const seam = {
        runOnce: async () => {
          await db.recordTokenStatsMany(tokens.map((token) => ({ token })));
        },
      };
      installTickProbe(seam, { db, deferWrites: true });
      await seam.runOnce();
    };

    // (1) NOTHING MEASURED: the old flat reserve is untouched, so an isolate
    //     that never ran a tick-path pass behaves exactly as it always did.
    resetTickProbe();
    assert.equal(drainTrackerReserve(0), DRAIN_TRACKER_RESERVE, "unmeasured = the ceiling");
    assert.equal(trackerPassSpendView(), null, "and nothing claims to be measured");

    // (2) A MEASURED pass: the yield follows it and cannot fall below the
    //     cheapest pass that is still a pass (pushwatch's 3 + 6).
    noteTrackerPassSpend(6);
    assert.deepEqual(trackerPassSpendView(), { worst: 6, samples: 1 });
    assert.equal(drainTrackerReserve(0), DRAIN_TRACKER_RESERVE_MIN, "clamped up to the pass's floor");
    noteTrackerPassSpend(13);
    assert.equal(drainTrackerReserve(0), 13, "a wide rotation takes its room back");
    // The WORST of the recent samples, not the newest: one thin pass must not
    // license the drain to spend the room the NEXT pass needs.
    noteTrackerPassSpend(5);
    assert.equal(trackerPassSpendView().worst, 13, "the worst recent sample leads");
    for (let i = 0; i < TRACKER_PASS_SPEND_RING; i += 1) noteTrackerPassSpend(5);
    assert.equal(trackerPassSpendView().worst, 5, "and it ages out of the ring");
    assert.equal(drainTrackerReserve(0), DRAIN_TRACKER_RESERVE_MIN);
    // A BROKEN reading is dropped, not clamped: the counter is shared with the
    // peer tracker delivery, so a window opened underneath a running pass shows
    // up as a negative or absurd delta.
    noteTrackerPassSpend(-12);
    noteTrackerPassSpend(500);
    noteTrackerPassSpend(Number.NaN);
    assert.equal(trackerPassSpendView().worst, 5, "nothing broken is believed");
    assert.equal(writeDrainView().reserve, 0, "no drain yet has yielded anything");

    // (3) UNMEASURED BEHAVIOUR: at the ceiling the batch is still HELD — held is
    //     not failed, and nothing is dropped.
    resetTickProbe();
    const db = mkDb();
    await queue(db, ["T0", "T1", "T2"]);
    const held = await drainDeferredWrites(() => DRAIN_TRACKER_RESERVE);
    assert.equal(held.calls, 0, "the ceiling still yields to the pass");
    assert.equal(held.reserve, DRAIN_TRACKER_RESERVE, "and the view names the yield it respected");
    assert.equal(held.heldForTracker, 1, "one call is held");
    assert.equal(held.owedTokens, 3, "with its records still owed");
    assert.equal(held.failures, 0, "held is not failed");

    // (4) MEASURED AT THE FLOOR: the SAME room now lands the batch. This is the
    //     live shape that never drained (11 left of 38 on a p50-27 tick).
    noteTrackerPassSpend(6);
    const landed = await drainDeferredWrites(() => DRAIN_TRACKER_RESERVE);
    assert.equal(landed.calls, 1, "a thin pass costs the drain a thin yield");
    assert.equal(landed.reserve, DRAIN_TRACKER_RESERVE_MIN);
    assert.equal(landed.owedTokens, 0, "and the backlog is empty");

    // (5) THE CAP: past it the queue drains AHEAD of the pass, keeping only the
    //     subrequests its own tail writes need — the pass may defer its rotation
    //     by name, never the write that says it ran.
    resetTickProbe();
    const flood = mkDb();
    const floodTokens = Array.from({ length: DEFERRED_FORCE_DRAIN_RECORDS }, (_, i) => \`F\${i}\`);
    await queue(flood, floodTokens);
    assert.equal(deferredWriteCount(), DEFERRED_FORCE_DRAIN_RECORDS, "the queue is over the cap");
    assert.equal(drainTrackerReserve(), DEFERRED_FORCE_DRAIN_FLOOR, "so the yield is the tail floor");
    assert.equal(
      drainTrackerReserve(DEFERRED_FORCE_DRAIN_RECORDS - 1),
      DRAIN_TRACKER_RESERVE,
      "one record under the cap still yields the ceiling",
    );
    // The real counter only falls, so the fake one does too: one batch comes out
    // of a tick whose entire room is the tail floor.
    let left = DEFERRED_FORCE_DRAIN_FLOOR + 1;
    const forced = await drainDeferredWrites(() => left--);
    assert.equal(forced.calls, 1, "one batch, from the room the pass's tail leaves");
    assert.equal(forced.reserve, DEFERRED_FORCE_DRAIN_FLOOR);
    assert.equal(
      deferredWriteCount(),
      DEFERRED_FORCE_DRAIN_RECORDS - DEFERRED_COALESCE_MAX_PER_CALL,
      "capped at what one statement carries, and the rest stays owed",
    );

    // The CONTROL: the same room with a queue UNDER the cap holds, so the cap is
    // what changed the outcome above — not the smaller number.
    resetTickProbe();
    const small = mkDb();
    await queue(small, ["S0", "S1"]);
    let smallLeft = DEFERRED_FORCE_DRAIN_FLOOR + 1;
    const under = await drainDeferredWrites(() => smallLeft--);
    assert.equal(under.calls, 0, "under the cap that room is the pass's, as before");
    assert.equal(under.reserve, DRAIN_TRACKER_RESERVE);
    assert.equal(under.owedTokens, 2, "and the records stay owed");

    // WIRING: only the TICK path reports a spend. The pass's own cron delivery
    // owns its whole invocation, so what it spends there is not the shape this
    // reserve exists for (see worker.runTrackerInvocation).
    const workerSrc = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "worker.ts"),
      "utf8",
    );
    assert.equal(
      workerSrc.split("noteTrackerPassSpend(passSubreqBefore - subreqRemaining())").length - 1,
      1,
      "the tick path measures the pass it shares the invocation with",
    );
    assert.equal(
      workerSrc.split("noteTrackerPassSpend(").length - 1,
      1,
      "and it is the only call site that reports",
    );
    resetTickProbe();
  });

`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes("the drain yields what the pass measured")) {
    console.log("= scripts/test-unit.js: already applied");
    return;
  }
  const hits = original.split(ANCHOR).length - 1;
  if (hits !== 1) {
    console.log(`✗ anchor matched ${hits} times — refusing to guess`);
    process.exit(1);
  }
  const out = original.replace(ANCHOR, BLOCK + ANCHOR);
  fs.writeFileSync(FILE, out);
  console.log(`✓ scripts/test-unit.js: applied (${original.length} -> ${out.length} bytes)`);
  const written = fs.readFileSync(FILE, "utf8");
  const n = written.split("noteTrackerPassSpend(passSubreqBefore - subreqRemaining())").length - 1;
  console.log(`  ${n === 1 ? "✓" : "✗"} the wiring assertion is in place x${n}`);
}

main();
