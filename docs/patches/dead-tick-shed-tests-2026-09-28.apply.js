#!/usr/bin/env node
/**
 * 2026-09-28 — offline tests for the death-driven drain ceiling.
 *
 *   T1  scripts/test-unit.js  — the waitUntil drift guard pinned an EMPTY
 *       argument list; the drain now carries its options.
 *   T2  scripts/test-unit.js  — the shed itself: one call, reason published,
 *       the rest owed, and a control that proves the room allowed more.
 *   T3  scripts/test-tick-path.js — the pure rule the worker decides by
 *       (drainCallCeiling / drainShedReason) next to the other dead-tick rules.
 *
 * Idempotent (each edit carries a marker that only exists once applied), no
 * regex. Run: node docs/patches/dead-tick-shed-tests-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
let ok = true;

function apply(rel, edits) {
  const file = path.join(root, rel);
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const edit of edits) {
    if (src.includes(edit.marker)) {
      console.log(`= ${rel} ${edit.label}: already applied`);
      continue;
    }
    const at = src.indexOf(edit.anchor);
    if (at === -1) {
      console.log(`✗ ${rel} ${edit.label}: anchor NOT found`);
      ok = false;
      continue;
    }
    if (src.indexOf(edit.anchor, at + 1) !== -1) {
      console.log(`✗ ${rel} ${edit.label}: anchor is not unique`);
      ok = false;
      continue;
    }
    src = src.slice(0, at) + edit.next + src.slice(at + edit.anchor.length);
    console.log(`✓ ${rel} ${edit.label}`);
  }
  if (src !== before) fs.writeFileSync(file, src);
}

// ── T1: the drift guard follows the call site's new shape ────────────────────
apply("scripts/test-unit.js", [
  {
    label: "T1/drift guard",
    marker: "constdrained=drainDeferredWrites(subreqRemaining,{",
    anchor: `      "patch B (drain held, not fire-and-forget)":
        workerSrc.includes("constdrained=drainDeferredWrites()") &&
        workerSrc.includes("tickWaitUntil(drained)"),`,
    next: `      // The call site carries OPTIONS since 2026-09-28 (the drain's ceiling and
      // the shed reason for a tick that backfilled a death), so this marker pins
      // the slot rather than an empty argument list. The three markers still
      // describe one shipped shape: held by waitUntil, with no fire-and-forget
      // twin left beside it.
      "patch B (drain held, not fire-and-forget)":
        workerSrc.includes("constdrained=drainDeferredWrites(subreqRemaining,{") &&
        workerSrc.includes("tickWaitUntil(drained)"),`,
  },
  {
    label: "T2/shed test",
    marker: "a tick that backfilled a death sheds its drain to one call",
    anchor: `    // (c) The next drain takes them once the allowance is back — still ONE call.
    await drainDeferredWrites(() => 40);
    assert.equal(landedOf(db), before + 1, "the catch-up is one round trip");
    assert.equal(db.landed[before].length, 3, "carrying all three records");
    assert.equal(writeDrainView().owedTokens, 0);
    resetTickProbe();
  });`,
    next: `    // (c) The next drain takes them once the allowance is back — still ONE call.
    await drainDeferredWrites(() => 40);
    assert.equal(landedOf(db), before + 1, "the catch-up is one round trip");
    assert.equal(db.landed[before].length, 3, "carrying all three records");
    assert.equal(writeDrainView().owedTokens, 0);
    resetTickProbe();
  });

  await test("tickprobe: a tick that backfilled a death sheds its drain to one call", async () => {
    // WHY (2026-09-28): a tick that backfilled a dead predecessor is the tick
    // whose OWN completion flush has to end the stretch — twelve cron ticks in
    // twenty minutes died before theirs (live 00:33-00:53Z) — and the drain sits
    // behind that flush in the same invocation. WHICH ceiling applies is the
    // caller's decision (worker.drainCallCeiling), so what is pinned here is the
    // drain's half of it: a lowered ceiling lands exactly one call, keeps the
    // rest owed, publishes the reason, and the SAME queue under the normal
    // ceiling really does land more (the control — without it, a shed that
    // happened to be the queue's own size would look identical).
    const {
      installTickProbe,
      drainDeferredWrites,
      resetTickProbe,
      writeDrainView,
      deferredWriteCount,
      DEFERRED_MAX_CALLS_PER_DRAIN,
      DEFERRED_DEAD_PREDECESSOR_MAX_CALLS,
      DEFERRED_COALESCE_MAX_PER_CALL,
    } = require("../dist/tickprobe.js");
    // Two deferred METHODS, each with more records than one coalesced slice
    // carries, so the room alone allows several calls and the ceiling is what
    // ends the walk. The methods touch \`this\` on purpose (the real Db methods
    // call \`this.get\`): the drain invokes them later, from runBucket.
    const db = {
      landed: [],
      recordTokenStatsMany: async function (tokens) {
        this.landed.push(["register"].concat(tokens.slice()));
      },
      updateTokenMaxMcaps: async function (rows) {
        this.landed.push(["raise"].concat(rows.slice()));
      },
      getTokenStatsMany: async () => [],
    };
    const runTick = async (n) => {
      const seam = {
        runOnce: async () => {
          for (let i = 0; i < n; i++) {
            const token = "T" + i;
            await db.recordTokenStatsMany([token]);
            await db.updateTokenMaxMcaps([{ token, mcap: 100 + i }]);
          }
        },
      };
      installTickProbe(seam, { db, deferWrites: true });
      await seam.runOnce();
    };
    const owedPerMethod = DEFERRED_COALESCE_MAX_PER_CALL * 2;
    resetTickProbe();
    await runTick(owedPerMethod);
    assert.equal(deferredWriteCount(), owedPerMethod * 2, "two full slices are owed");

    // The shed tick: one call, whatever the room says.
    const shed = await drainDeferredWrites(() => 50, {
      maxCalls: DEFERRED_DEAD_PREDECESSOR_MAX_CALLS,
      shed: "dead-predecessor",
    });
    assert.equal(shed.calls, DEFERRED_DEAD_PREDECESSOR_MAX_CALLS, "one call");
    assert.equal(shed.shed, "dead-predecessor", "and the reason is published");
    assert.equal(shed.failures, 0, "held is not failed");
    assert.ok(shed.owedTokens > 0, "the rest of the queue stays owed, not dropped");
    assert.equal(shed.heldForTracker, 2, "both buckets are named as held");

    // CONTROL: the same queue, the same room, the normal ceiling.
    const full = await drainDeferredWrites(() => 50);
    assert.equal(full.shed, null, "an ordinary drain publishes no shed reason");
    assert.ok(
      full.calls > shed.calls,
      "the room allowed more calls than the shed did (" +
        shed.calls +
        " vs " +
        full.calls +
        ")",
    );
    assert.equal(full.owedTokens, 0, "and the control drains what the shed left");
    assert.equal(writeDrainView().owedTokens, 0);
    // The isolates that never backfill a death are untouched by all of this.
    assert.ok(DEFERRED_DEAD_PREDECESSOR_MAX_CALLS < DEFERRED_MAX_CALLS_PER_DRAIN);
    resetTickProbe();
  });`,
  },
]);

// ── T3: the pure rule the worker decides by ──────────────────────────────────
// ── T4: the drain's call site sits AFTER the completion flush ────────────────
apply("scripts/test-unit.js", [
  {
    label: "T4/flush ordering",
    marker: "the drain must be fired AFTER the completion flush",
    anchor: `    console.log("  ℹ writeDrain waitUntil patch present - the cron drain is held");
  });`,
    next: `    // ...and since 2026-09-28 its call site sits AFTER the completion flush in
    // program order. It used to live in tickprobe's onTickEnd hook, which runs
    // BEFORE \`db?.persistScanCompletion(...)\` (that hook is the scanner's
    // runOnce wrapper's \`finally\`, and the flush payload is only built once
    // runOnce returns) — so up to DEFERRED_MAX_CALLS_PER_DRAIN bookkeeping round
    // trips were spent in front of the one write a tick cannot lose.
    const drainAt = workerSrc.indexOf("constdrained=drainDeferredWrites(");
    const flushAt = workerSrc.indexOf("db?.persistScanCompletion(");
    assert.ok(flushAt !== -1, "the completion flush is still a call site here");
    assert.ok(
      drainAt !== -1,
      "the held drain call site is still here",
    );
    assert.ok(
      drainAt > flushAt,
      "the drain must be fired AFTER the completion flush",
    );
    console.log("  ℹ writeDrain waitUntil patch present - the cron drain is held");
  });`,
  },
]);

apply("scripts/test-tick-path.js", [
  {
    label: "T3/ceiling rule",
    marker: "death-driven drain ceiling: pass",
    anchor: `    assert.equal(nextDeadStreak(-5, true), 1);
    console.log("dead-tick recovery: pass");
  }`,
    next: `    assert.equal(nextDeadStreak(-5, true), 1);
    console.log("dead-tick recovery: pass");
  }

  // ---------- the death-driven drain ceiling (worker.ts drainCallCeiling) ----
  // Live 2026-09-28 00:33-00:53Z: twelve cron ticks in twenty minutes lost their
  // completion write, and the successor tick is the one that has to prove the
  // stretch is over — while the deferred-write drain sits behind its flush in
  // the SAME invocation. That tick therefore drains under a LOWER ceiling, so
  // the invocation's allowance goes to its flush, the tracker pass and the
  // deferral sync. The rule is pure and pinned here rather than inferred from
  // whatever /health happens to show.
  {
    const { drainCallCeiling, drainShedReason } = require("../dist/worker.js");
    const {
      DEFERRED_MAX_CALLS_PER_DRAIN,
      DEFERRED_DEAD_PREDECESSOR_MAX_CALLS,
    } = require("../dist/tickprobe.js");
    assert.equal(DEFERRED_DEAD_PREDECESSOR_MAX_CALLS, 1, "one call is the shed ceiling");
    assert.ok(
      DEFERRED_DEAD_PREDECESSOR_MAX_CALLS < DEFERRED_MAX_CALLS_PER_DRAIN,
      "and it must stay BELOW the normal ceiling, or a shed would mean nothing",
    );
    assert.equal(drainCallCeiling(true), DEFERRED_DEAD_PREDECESSOR_MAX_CALLS);
    assert.equal(drainCallCeiling(false), DEFERRED_MAX_CALLS_PER_DRAIN);
    assert.equal(drainShedReason(true), "dead-predecessor");
    assert.equal(drainShedReason(false), null, "an ordinary tick publishes no reason");
    console.log("death-driven drain ceiling: pass");
  }`,
  },
]);

process.exit(ok ? 0 : 1);
