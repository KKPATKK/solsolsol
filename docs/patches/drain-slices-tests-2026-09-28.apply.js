#!/usr/bin/env node
/*
 * APPLY (idempotent): tests for the multi-slice drain (see
 * docs/patches/drain-slices-2026-09-28.apply.js).
 *
 * TWO EDITS in scripts/test-unit.js:
 *   1. the coalescing test's "cap" section claimed a 43-record backlog needs TWO
 *      drains ("what did not fit stays owed"). It now lands inside ONE drain, in
 *      slices of 40, so the assertion moves with the behaviour it describes;
 *   2. the adaptive-reserve test gains the slice assertions: 90 records = 40+40+10
 *      in one drain, and a queue past the drain's cap keeps the rest owed.
 *
 * Run: node docs/patches/drain-slices-tests-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");

const CAP_OLD = `    // The cap: a backlog longer than one call may carry drains in chunks, and
    // what did not fit stays owed.
    calls.length = 0;
    await tick(async () => {
      for (let i = 0; i < DEFERRED_COALESCE_MAX_PER_CALL + 3; i += 1) {
        await db.recordTokenStatsMany([{ token: \`C\${i}\`, firstSeenAt: 1 }]);
      }
    });
    assert.equal(
      deferredWriteCount(),
      DEFERRED_COALESCE_MAX_PER_CALL + 3,
      "every record is owed",
    );
    const first = await drainDeferredWrites(() => 50);
    assert.equal(first.calls, 1, "one call");
    assert.equal(
      calls[0].tokens.length,
      DEFERRED_COALESCE_MAX_PER_CALL,
      "capped at what one statement may carry",
    );
    assert.equal(deferredWriteCount(), 3, "the rest stays owed");
    const second = await drainDeferredWrites(() => 50);
    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(second.owedTokens, 0, "and the backlog is empty");`;

const CAP_NEW = `    // The cap: one call never carries more than the statement may, and a
    // backlog drains in SLICES of that size — inside the SAME drain while it has
    // room (2026-09-28: one slice per method per tick could not keep up with the
    // ~150 records/tick the scanner queues, so the backlog still grew; see
    // DEFERRED_MAX_CALLS_PER_DRAIN).
    calls.length = 0;
    await tick(async () => {
      for (let i = 0; i < DEFERRED_COALESCE_MAX_PER_CALL + 3; i += 1) {
        await db.recordTokenStatsMany([{ token: \`C\${i}\`, firstSeenAt: 1 }]);
      }
    });
    assert.equal(
      deferredWriteCount(),
      DEFERRED_COALESCE_MAX_PER_CALL + 3,
      "every record is owed",
    );
    const first = await drainDeferredWrites(() => 50);
    assert.equal(first.calls, 2, "the room is spent as whole slices");
    assert.equal(
      calls[0].tokens.length,
      DEFERRED_COALESCE_MAX_PER_CALL,
      "the first slice is capped at what one statement may carry",
    );
    assert.equal(calls[1].tokens.length, 3, "and the remainder rides the next one");
    assert.equal(first.owedTokens, 0, "so one roomy drain empties the backlog");`;

const REQUIRE_OLD = `      DEFERRED_FORCE_DRAIN_RECORDS,
      DEFERRED_FORCE_DRAIN_FLOOR,
      DEFERRED_COALESCE_MAX_PER_CALL,
    } = require("../dist/tickprobe.js");`;
const REQUIRE_NEW = `      DEFERRED_FORCE_DRAIN_RECORDS,
      DEFERRED_FORCE_DRAIN_FLOOR,
      DEFERRED_COALESCE_MAX_PER_CALL,
      DEFERRED_MAX_CALLS_PER_DRAIN,
    } = require("../dist/tickprobe.js");`;

const WIRING_ANCHOR = `    // WIRING: only the TICK path reports a spend.`;
const SLICES_BLOCK = `    // (6) SLICES: a deep queue catches up INSIDE one drain — the room above the
    //     reserve is spent as whole 40-record slices, up to the drain's own cap.
    //     This is the rule the live numbers asked for: ~150 records are queued
    //     per tick, so one slice per method per tick could never break even.
    resetTickProbe();
    const deep = mkDb();
    await queue(deep, Array.from({ length: 90 }, (_, i) => \`D\${i}\`));
    deep.calls.length = 0;
    const drained = await drainDeferredWrites(() => 50);
    assert.equal(drained.calls, 3, "40 + 40 + 10, all inside one drain");
    assert.deepEqual(deep.calls, [40, 40, 10], "one slice per call, each capped at 40");
    assert.equal(drained.owedTokens, 0, "so the backlog is empty");
    assert.equal(drained.heldForTracker, 0, "and nothing was held");
    // The drain's own ceiling: a queue longer than the cap can carry keeps the
    // rest owed, so a broken room reading cannot walk an unbounded number of
    // calls in one invocation.
    resetTickProbe();
    const huge = mkDb();
    await queue(
      huge,
      Array.from({ length: DEFERRED_MAX_CALLS_PER_DRAIN * DEFERRED_COALESCE_MAX_PER_CALL + 5 }, (_, i) => \`H\${i}\`),
    );
    const capped = await drainDeferredWrites(() => 50);
    assert.equal(capped.calls, DEFERRED_MAX_CALLS_PER_DRAIN, "the drain stops at its cap");
    assert.equal(capped.owedTokens, 5, "with the remainder still owed");
    assert.equal(capped.heldForTracker, 1, "named as held, not lost");

`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes("SLICES: a deep queue catches up INSIDE one drain")) {
    console.log("= scripts/test-unit.js: already applied");
    return;
  }
  let out = original;
  const report = [];
  const replaceOnce = (label, oldText, newText) => {
    const hits = out.split(oldText).length - 1;
    if (hits === 0) {
      report.push(`✗ ${label}: ANCHOR MISSING`);
      return false;
    }
    if (hits > 1) {
      report.push(`✗ ${label}: anchor matched ${hits} times — refusing to guess`);
      return false;
    }
    out = out.replace(oldText, newText);
    report.push(`✓ ${label}: applied`);
    return true;
  };
  replaceOnce("the coalescing test's cap section", CAP_OLD, CAP_NEW);
  replaceOnce("the new test's require list", REQUIRE_OLD, REQUIRE_NEW);
  replaceOnce("the slice assertions", WIRING_ANCHOR, SLICES_BLOCK + WIRING_ANCHOR);

  for (const line of report) console.log(line);
  if (report.some((line) => line.startsWith("✗"))) {
    console.log("\nscripts/test-unit.js left UNCHANGED");
    process.exit(1);
  }
  fs.writeFileSync(FILE, out);
  console.log(`\nscripts/test-unit.js written (${original.length} -> ${out.length} bytes)`);
  const written = fs.readFileSync(FILE, "utf8");
  for (const needle of [
    "DEFERRED_MAX_CALLS_PER_DRAIN * DEFERRED_COALESCE_MAX_PER_CALL + 5",
    "assert.deepEqual(deep.calls, [40, 40, 10]",
  ]) {
    const n = written.split(needle).length - 1;
    console.log(`  ${n === 1 ? "✓" : "✗"} ${needle} x${n}`);
  }
}

main();
