#!/usr/bin/env node
/*
 * APPLY (idempotent): let ONE drain land more than one slice per bucket.
 *
 * WHY (measured live, hours after drain-reserve-2026-09-28 landed): the force
 * rule made the drain start landing again — 01:00Z read `calls 2`,
 * `heldForTracker 0`, `reserve 6`, `failures 0` — but the queue kept GROWING:
 * `owedTokens` 356 -> 424 -> 477 -> 548 one tick apart (+53..+71/tick) while
 * `totals.calls` rose by 2 per tick. The reason is structural: `ready` is a
 * snapshot of the owed buckets and the walk runs each bucket ONCE, so a deep
 * queue lands at most one 40-record slice per method per tick — 80 records —
 * while the scanner registers/raises ~150 distinct records per tick
 * (recordTokenStatsMany x2 + updateTokenMaxMcaps over the pool slice). Net
 * +55..70/tick, i.e. the queue still ran away, just more slowly.
 *
 * THE CHANGE: a bucket that still owes records after its slice goes to the BACK
 * of the drain's worklist, so the room above the reserve is spent as whole
 * slices and the two methods stay fair to each other. A per-drain call cap
 * bounds the walk (the room check is the real bound; the cap is what stops a
 * room reading that never falls from turning one invocation into an unbounded
 * walk).
 *
 * Run: node docs/patches/drain-slices-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "tickprobe.ts");

/** The cap, documented next to the other drain constants. */
const CONST_OLD = `export const DEFERRED_FORCE_DRAIN_FLOOR = 6;`;
const CONST_NEW = `export const DEFERRED_FORCE_DRAIN_FLOOR = 6;

/**
 * Calls ONE drain may make, whatever the room says.
 *
 * WHY IT EXISTS (live 2026-09-28, right after the force rule landed): landing
 * ONE slice per bucket per tick was not enough, because the queue's inflow is
 * per-tick too — \`owedTokens\` read 356 -> 424 -> 477 -> 548 on consecutive ticks
 * with \`calls 2\` and \`heldForTracker 0\`, i.e. ~150 records were queued per tick
 * while at most two 40-record slices (one per method) landed. A bucket that
 * still owes records now goes to the BACK of this drain's rotation (fair
 * between the two methods), so the surplus room above the reserve is spent as
 * whole slices.
 *
 * The room check is the REAL bound — every call spends one subrequest, and the
 * drain stops at its reserve — so this cap is the belt to that braces: a room
 * reading that never falls must not turn one invocation into an unbounded walk.
 * Ten slices = 400 records, the queue's own cap, which is what makes "one drain
 * can clear a flooded queue" a true statement.
 */
export const DEFERRED_MAX_CALLS_PER_DRAIN = 10;`;

/** The walk: a worklist, a cap, and the re-queue behind a landed slice. */
const WALK_OLD = `    reserve = drainTrackerReserve();
    const ready = owedBuckets();
    while (ready.length > 0) {`;
const WALK_NEW = `    reserve = drainTrackerReserve();
    // A WORKLIST, not one pass over the buckets: a bucket that still owes
    // records after its slice goes to the back (see
    // DEFERRED_MAX_CALLS_PER_DRAIN), so the room above the reserve is spent as
    // whole slices instead of one slice per method per tick.
    const ready = owedBuckets();
    while (ready.length > 0) {`;

const CAP_OLD = `      if (subreqLeft() <= reserve) {
        heldForTracker = ready.length;
        break;
      }`;
const CAP_NEW = `      if (calls >= DEFERRED_MAX_CALLS_PER_DRAIN) {
        // The drain's own ceiling (see DEFERRED_MAX_CALLS_PER_DRAIN): the room
        // check below is what normally ends this walk, and this is what ends it
        // when the room reading cannot be trusted to fall.
        heldForTracker = ready.length;
        break;
      }
      if (subreqLeft() <= reserve) {
        heldForTracker = ready.length;
        break;
      }`;

const REQUEUE_OLD = `        // A landed batch proves the handle works, so the count is for
        // CONSECUTIVE failures (the old per-entry rule): without this reset, a
        // bucket that failed twice hours ago would be DROPPED — the whole
        // backlog and all — by a single new failure today.
        bucket.attempts = 0;
      } catch (err) {`;
const REQUEUE_NEW = `        // A landed batch proves the handle works, so the count is for
        // CONSECUTIVE failures (the old per-entry rule): without this reset, a
        // bucket that failed twice hours ago would be DROPPED — the whole
        // backlog and all — by a single new failure today.
        bucket.attempts = 0;
        // Still owing records? Its slice is capped at 40, so the rest goes to
        // the back of the rotation: a deep queue catches up INSIDE this tick
        // instead of one slice per method per tick.
        if (bucket.owed.size > 0) ready.push(bucket);
      } catch (err) {`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  let out = original;
  const report = [];
  const replaceOnce = (label, oldText, newText) => {
    const hits = out.split(oldText).length - 1;
    if (hits === 0) {
      const applied = out.includes(newText);
      report.push(`${applied ? "=" : "✗"} ${label}: ${applied ? "already applied" : "ANCHOR MISSING"}`);
      return applied;
    }
    if (hits > 1) {
      report.push(`✗ ${label}: anchor matched ${hits} times — refusing to guess`);
      return false;
    }
    out = out.replace(oldText, newText);
    report.push(`✓ ${label}: applied`);
    return true;
  };
  replaceOnce("the per-drain call cap", CONST_OLD, CONST_NEW);
  replaceOnce("the walk is a worklist", WALK_OLD, WALK_NEW);
  replaceOnce("the cap ends the walk", CAP_OLD, CAP_NEW);
  replaceOnce("a landed slice re-queues its bucket", REQUEUE_OLD, REQUEUE_NEW);

  for (const line of report) console.log(line);
  if (report.some((line) => line.startsWith("✗"))) {
    console.log("\nsrc/tickprobe.ts left UNCHANGED");
    process.exit(1);
  }
  if (out === original) {
    console.log("\nsrc/tickprobe.ts already carries the change — nothing written");
    return;
  }
  fs.writeFileSync(FILE, out);
  console.log(`\nsrc/tickprobe.ts written (${original.length} -> ${out.length} bytes)`);
  const written = fs.readFileSync(FILE, "utf8");
  for (const needle of [
    "export const DEFERRED_MAX_CALLS_PER_DRAIN = 10;",
    "if (calls >= DEFERRED_MAX_CALLS_PER_DRAIN) {",
    "if (bucket.owed.size > 0) ready.push(bucket);",
  ]) {
    const n = written.split(needle).length - 1;
    console.log(`  ${n === 1 ? "✓" : "✗"} ${needle} x${n}`);
  }
}

main();
