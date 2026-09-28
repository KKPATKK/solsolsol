#!/usr/bin/env node
/*
 * APPLY (idempotent): stop the write drain from yielding a FLAT reserve.
 *
 * WHY. `DRAIN_TRACKER_RESERVE = 14` answers "what does the tracker pass behind
 * the drain need?" with a constant. 14 is the need of a pass that has ROOM to
 * be worth starting (8 rows + 6 tail writes), and the tick no longer has that
 * room to offer: once the 60s cadence was restored (docs/round-trips.md §4.42)
 * the scan's own spend read 24-36 of the 38 usable subrequests, so `left` was
 * 2-14 — `<= 14` on EVERY tick — and the drain landed nothing at all. Live
 * 00:02-00:28Z 2026-09-28: `owedTokens` 305 -> 2098, `calls 5` -> 7 lifetime,
 * `heldForTracker 2`, `failures 0`, i.e. the token_stats bookkeeping parked
 * while the tick that deferred it kept working.
 *
 * THE CHANGE (two halves, both in tickprobe.ts except the seam that feeds it):
 *   1. the yield is MEASURED — `noteTrackerPassSpend()` takes what the pass
 *      really spent in a scan tick's tail (worker.ts measures it around the
 *      pass it calls), `drainTrackerReserve()` returns the worst of the last
 *      few samples clamped to [DRAIN_TRACKER_RESERVE_MIN, DRAIN_TRACKER_RESERVE];
 *   2. a queue past `DEFERRED_FORCE_DRAIN_RECORDS` (ten capped calls' worth)
 *      drains AHEAD of the pass, keeping only `DEFERRED_FORCE_DRAIN_FLOOR`
 *      subrequests for the pass's own tail writes — the pass may defer its
 *      rotation by name, never the write that says it ran.
 *
 * src/worker.ts / src/scanner.ts are past this repo's file-edit window (the
 * editor's snapshot of them goes stale), so the edits land as an anchored,
 * verify-then-write script that prints ✓ / = / ✗ and can be re-run safely.
 *
 * Run: node docs/patches/drain-reserve-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PROBE = path.join(ROOT, "src", "tickprobe.ts");
const WORKER = path.join(ROOT, "src", "worker.ts");
const SCANNER = path.join(ROOT, "src", "scanner.ts");

/** The import block has to name the two budget constants it now reasons about. */
const IMPORT_OLD = `import { markSubreqPhase, subreqRemaining } from "./subreqs";`;
const IMPORT_NEW = `import {
  SUBREQ_BUDGET_FREE,
  SUBREQ_UNSEEN_ALLOWANCE,
  markSubreqPhase,
  subreqRemaining,
} from "./subreqs";`;

/** The reserve's own doc gains the reason it is no longer a flat yield. */
const RESERVE_DOC_OLD = ` * (or this one, after the pass) takes them — see WriteDrainView.heldForTracker.
 */
export const DRAIN_TRACKER_RESERVE = 14;`;
const RESERVE_DOC_NEW = ` * (or this one, after the pass) takes them — see WriteDrainView.heldForTracker.
 *
 * WHY IT IS A CEILING AND NOT A FLAT YIELD (2026-09-28): a flat 14 turned out
 * to be a PERMANENT yield on this bot, because 14 is what a pass needs when it
 * has room to be worth starting — and a tick whose scan has spent 24-36 of the
 * 38 usable subrequests cannot offer it. Live (00:02-00:28Z, cadence restored
 * to 60s): \`left\` was 2-14, i.e. \`<= 14\` on every tick, so the drain landed
 * nothing while the queue grew 305 -> 2098 records in 26 minutes (\`calls 5\` ->
 * 7 lifetime, \`heldForTracker 2\`, \`failures 0\`). The queue is bounded — it
 * coalesces per token — and the scanner re-issues what it still needs, but the
 * bookkeeping it exists to carry was parked, so the yield is now MEASURED
 * (see noteTrackerPassSpend) and a queue over the cap drains first
 * (see DEFERRED_FORCE_DRAIN_RECORDS).
 */
export const DRAIN_TRACKER_RESERVE = 14;

/**
 * The floor the adaptive reserve may fall to (see drainTrackerReserve): the
 * cheapest pass that is still a pass, plus the tail writes it holds back for
 * itself — pushwatch.TRACKER_SUBREQ_FLOOR (3) + TRACKER_SUBREQ_RESERVE (6).
 * Below it the pass cannot even reach its rotation, which is the starvation
 * the reserve was introduced to prevent.
 */
export const DRAIN_TRACKER_RESERVE_MIN = 9;

/**
 * How many recent TICK-PATH pass measurements the reserve is the WORST of (see
 * noteTrackerPassSpend). More than one because a single thin pass would
 * otherwise license the drain to spend the room the NEXT pass needs; five
 * smooths that without outliving the shape it measures.
 */
export const TRACKER_PASS_SPEND_RING = 5;

/**
 * Records owed before the queue stops waiting for the tracker pass entirely
 * (see drainTrackerReserve): ten capped calls' worth. Below it the queue is a
 * catch-up; above it the drain is what the invocation owes, because a
 * bookkeeping queue nobody lands is exactly the leak coalescing was built to
 * stop (its live reading is "owedTokens rising every tick with calls 0").
 */
export const DEFERRED_FORCE_DRAIN_RECORDS = DEFERRED_COALESCE_MAX_PER_CALL * 10;

/**
 * Subrequests the drain keeps for the pass's own TAIL (its note persist, the
 * deferral-counter sync) even while it is draining a queue over the cap. NOT
 * the full reserve: a forced drain is allowed to cost the pass its ROTATION —
 * the pass defers that BY NAME (\`deferred:subreq-budget\`, pushwatch) rather
 * than dying — but never the one write that says the pass ran at all, which is
 * pushwatch.TRACKER_SUBREQ_RESERVE = 6.
 */
export const DEFERRED_FORCE_DRAIN_FLOOR = 6;`;

/** The measurement, the view over it, and the resolve that uses both. */
const MEASURE_ANCHOR = `/**
 * Run every queued write, in call order, and report what it cost. Called by`;
const MEASURE_NEW = `/**
 * Subrequests the tracker pass actually spent the last few times it ran in a
 * SCAN TICK's tail (see noteTrackerPassSpend), newest last.
 *
 * WHY MEASURED (2026-09-28): the reserve answered "what does a pass need?" with
 * a constant, and that constant was the whole problem — a flat 14 is the need
 * of a pass that has room, while the pass this bot actually runs defers as soon
 * as its share runs out and so spends 5-8. Measuring turns the reserve into
 * "what this bot's pass has needed HERE", which is the only value that can be
 * right on both a thin rotation and a wide one.
 *
 * The samples come from the TICK path only (see worker.ts's pass call): the
 * pass's own cron delivery owns its whole invocation, so what it spends there
 * says nothing about the room a SHARED invocation leaves.
 */
const trackerPassSpend: number[] = [];

/**
 * Spendable subrequests in a window (src/subreqs.ts's own arithmetic, kept here
 * so that a reading outside it can be rejected as broken rather than believed).
 */
const SUBREQ_USABLE = Math.max(0, SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE);

/**
 * Feed one pass's measured subrequest spend to the drain's reserve (see
 * drainTrackerReserve). Readings outside \`[0, SUBREQ_USABLE]\` are DROPPED, not
 * clamped: the counter is shared with the peer tracker delivery (see
 * SubreqOwner), so a window opened underneath a running pass shows up as a
 * negative or absurd delta, and a broken reading must not become a policy. Zero
 * IS a real reading — a pass that deferred before its first round trip — and is
 * kept, because the floor clamps it up to what a pass needs anyway.
 */
export function noteTrackerPassSpend(subrequests: number): void {
  if (!Number.isFinite(subrequests)) return;
  if (subrequests < 0 || subrequests > SUBREQ_USABLE) return;
  trackerPassSpend.push(subrequests);
  if (trackerPassSpend.length > TRACKER_PASS_SPEND_RING) trackerPassSpend.shift();
}

/** What the reserve computes from: the worst recent sample, or null if none. */
export function trackerPassSpendView(): { worst: number; samples: number } | null {
  if (trackerPassSpend.length === 0) return null;
  return { worst: Math.max(...trackerPassSpend), samples: trackerPassSpend.length };
}

/**
 * Subrequests this drain must leave for the tracker pass behind it.
 *
 * THREE ANSWERS, in order of precedence:
 *   - the FORCED floor when the queue is over the cap: a backlog that deep is
 *     the drain's own problem, and the pass can afford to defer by name (see
 *     DEFERRED_FORCE_DRAIN_RECORDS);
 *   - the CEILING while no tick-path pass has reported a spend — an unmeasured
 *     isolate behaves exactly as it did before any of this existed;
 *   - the WORST recent measurement, clamped to \`[MIN, CEILING]\`, which is what
 *     the pass really needs here: a thin rotation then costs the drain a
 *     thinner yield, and a wide one takes the full 14 back.
 */
export function drainTrackerReserve(owed: number = owedRecordCount()): number {
  if (owed >= DEFERRED_FORCE_DRAIN_RECORDS) return DEFERRED_FORCE_DRAIN_FLOOR;
  const measured = trackerPassSpendView();
  if (measured === null) return DRAIN_TRACKER_RESERVE;
  return Math.min(
    DRAIN_TRACKER_RESERVE,
    Math.max(DRAIN_TRACKER_RESERVE_MIN, measured.worst),
  );
}

/**
 * Run every queued write, in call order, and report what it cost. Called by`;

/** The loop resolves the yield once, then walks its buckets under it. */
const LOOP_OLD = `    // One round trip per BUCKET, not per record (see DeferredBucket): the
    // backlog is measured in records (\`owedTokens\`) but paid for in calls.
    const ready = owedBuckets();`;
const LOOP_NEW = `    // One round trip per BUCKET, not per record (see DeferredBucket): the
    // backlog is measured in records (\`owedTokens\`) but paid for in calls.
    // The yield is resolved ONCE for this drain (see drainTrackerReserve): a
    // reserve that moved while the queue drained would make the batch depend on
    // the order it happened to land in.
    const reserve = drainTrackerReserve();
    const ready = owedBuckets();`;

const GATE_OLD = `      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {
        heldForTracker = ready.length;
        break;
      }`;
const GATE_NEW = `      if (subreqLeft() <= reserve) {
        heldForTracker = ready.length;
        break;
      }`;

/** Every WriteDrainView literal (the type has no optional fields here). */
const VIEW_TYPE_OLD = `  heldForTracker: number;
  /** Cumulative since the isolate booted, so the effect is readable either way. */`;
const VIEW_TYPE_NEW = `  heldForTracker: number;
  /**
   * Subrequests this drain left for the tracker pass behind it — the yield it
   * respected while it walked the queue (see drainTrackerReserve), so a reader
   * can tell a held batch from a spent one. Four readings are meaningful: 14 an
   * unmeasured isolate (the old flat reserve, i.e. nothing has changed for it),
   * a value between DRAIN_TRACKER_RESERVE_MIN and that ceiling a MEASURED
   * yield, DEFERRED_FORCE_DRAIN_FLOOR a queue over the cap being drained ahead
   * of the pass, and 0 an empty queue (nothing was held back).
   */
  reserve: number;
  /** Cumulative since the isolate booted, so the effect is readable either way. */`;

const INIT_OLD = `let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
  owedTokens: 0,
  heldForTracker: 0,
  totals: { calls: 0, ms: 0, failures: 0 },
};`;
const INIT_NEW = `let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
  owedTokens: 0,
  heldForTracker: 0,
  reserve: 0,
  totals: { calls: 0, ms: 0, failures: 0 },
};`;

const EMPTY_OLD = `        pending: 0,
        owedTokens: 0,
        heldForTracker: 0,
      };`;
const EMPTY_NEW = `        pending: 0,
        owedTokens: 0,
        heldForTracker: 0,
        // Nothing was owed, so nothing was held back for the tail.
        reserve: 0,
      };`;

const SNAPSHOT_OLD = `    pending: owedBuckets().length,
    owedTokens: owedRecordCount(),
    heldForTracker,`;
const SNAPSHOT_NEW = `    pending: owedBuckets().length,
    owedTokens: owedRecordCount(),
    heldForTracker,
    reserve,`;

const RESET_OLD = `    pending: 0,
    owedTokens: 0,
    heldForTracker: 0,
    totals: { calls: 0, ms: 0, failures: 0 },
  };`;
const RESET_NEW = `    pending: 0,
    owedTokens: 0,
    heldForTracker: 0,
    reserve: 0,
    totals: { calls: 0, ms: 0, failures: 0 },
  };`;

const RING_RESET_OLD = `  buckets = [];
  opaqueRecords = 0;`;
const RING_RESET_NEW = `  buckets = [];
  opaqueRecords = 0;
  // The pass measurements go with the buckets they reserve against: a test that
  // measures a spend must not leak it into the next test's drain.
  trackerPassSpend.length = 0;`;

/** worker.ts: import the seam, then measure the pass this tick shares with. */
const WORKER_IMPORT_OLD = `  writeDrainView,
  drainDeferredWrites,
  noteDuplicateCards,`;
const WORKER_IMPORT_NEW = `  writeDrainView,
  drainDeferredWrites,
  noteDuplicateCards,
  noteTrackerPassSpend,`;

const WORKER_CALL_OLD = `          const holdTick = tickWaitUntil;
          await scanner.runTrackerPass(`;
const WORKER_CALL_NEW = `          const holdTick = tickWaitUntil;
          // WHAT THIS PASS COSTS, measured rather than assumed (see
          // tickprobe.noteTrackerPassSpend): the write drain ahead of this
          // stage yields a reserve, and a FLAT one yielded more than the pass
          // needed on every tick of 2026-09-28 — live 00:02-00:28Z the queue
          // went 305 -> 2098 owed records with \`calls 0\`. ONLY this call site
          // reports: the pass's own cron delivery owns its whole subrequest
          // window, so its spend there is not the shape the reserve is for.
          const passSubreqBefore = subreqRemaining();
          await scanner.runTrackerPass(`;

const WORKER_TAIL_OLD = `          );
          // The pass returned: its rotation ran, so the last failure is history.
          trackerPassFailure = null;`;
const WORKER_TAIL_NEW = `          );
          noteTrackerPassSpend(passSubreqBefore - subreqRemaining());
          // The pass returned: its rotation ran, so the last failure is history.
          trackerPassFailure = null;`;

/** scanner.ts: the heartbeat's writeDrain type carries the yield too. */
const SCANNER_OLD = `    /** Calls held back for the tracker pass behind the drain. */
    heldForTracker?: number;`;
const SCANNER_NEW = `    /** Calls held back for the tracker pass behind the drain. */
    heldForTracker?: number;
    /** Subrequests the drain left for the pass — its adaptive yield (tickprobe). */
    reserve?: number;`;

function main() {
  const report = [];
  const step = (label, oldText, newText, file, state) => {
    const hits = state.out.split(oldText).length - 1;
    if (hits === 0) {
      const applied =
        state.out.includes(newText) || state.out.includes(newText.split("\n")[0]);
      report.push(`${applied ? "=" : "✗"} ${label}: ${applied ? "already applied" : "ANCHOR MISSING"}`);
      return applied;
    }
    if (hits > 1) {
      report.push(`✗ ${label}: anchor matched ${hits} times — refusing to guess`);
      return false;
    }
    state.out = state.out.replace(oldText, newText);
    report.push(`✓ ${label}: applied`);
    return true;
  };

  const files = [
    { file: PROBE, name: "src/tickprobe.ts", state: null },
    { file: WORKER, name: "src/worker.ts", state: null },
    { file: SCANNER, name: "src/scanner.ts", state: null },
  ];
  for (const f of files) f.state = { out: fs.readFileSync(f.file, "utf8"), original: null };
  for (const f of files) f.state.original = f.state.out;
  const edit = (label, oldText, newText) => {
    const f = label.startsWith("worker") ? files[1] : label.startsWith("scanner") ? files[2] : files[0];
    return step(label, oldText, newText, f.file, f.state);
  };

  edit("probe: subreqs import", IMPORT_OLD, IMPORT_NEW);
  edit("probe: reserve doc + new constants", RESERVE_DOC_OLD, RESERVE_DOC_NEW);
  edit("probe: measurement + drainTrackerReserve", MEASURE_ANCHOR, MEASURE_NEW);
  edit("probe: resolve the yield once", LOOP_OLD, LOOP_NEW);
  edit("probe: gate on the resolved yield", GATE_OLD, GATE_NEW);
  edit("probe: WriteDrainView.reserve", VIEW_TYPE_OLD, VIEW_TYPE_NEW);
  edit("probe: initial drain literal", INIT_OLD, INIT_NEW);
  edit("probe: empty-queue literal", EMPTY_OLD, EMPTY_NEW);
  edit("probe: drain-time snapshot", SNAPSHOT_OLD, SNAPSHOT_NEW);
  edit("probe: resetTickProbe literal", RESET_OLD, RESET_NEW);
  edit("probe: resetTickProbe clears the ring", RING_RESET_OLD, RING_RESET_NEW);
  edit("worker: import the seam", WORKER_IMPORT_OLD, WORKER_IMPORT_NEW);
  edit("worker: measure the shared pass", WORKER_CALL_OLD, WORKER_CALL_NEW);
  edit("worker: report the measurement", WORKER_TAIL_OLD, WORKER_TAIL_NEW);
  edit("scanner: writeDrain.reserve", SCANNER_OLD, SCANNER_NEW);

  for (const line of report) console.log(line);
  const failed = report.some((line) => line.startsWith("✗"));
  if (failed) {
    console.log("\nNOTHING written");
    process.exit(1);
  }

  let wrote = 0;
  for (const f of files) {
    if (f.state.out === f.state.original) {
      console.log(`\n${f.name} already carries the change — nothing written`);
      continue;
    }
    fs.writeFileSync(f.file, f.state.out);
    wrote += 1;
    console.log(
      `\n${f.name} written (${f.state.original.length} -> ${f.state.out.length} bytes)`,
    );
  }

  // Post-write sanity: every piece present exactly once.
  const checks = [
    [PROBE, "export const DRAIN_TRACKER_RESERVE_MIN = 9;"],
    [PROBE, "export const TRACKER_PASS_SPEND_RING = 5;"],
    [PROBE, "export const DEFERRED_FORCE_DRAIN_RECORDS = DEFERRED_COALESCE_MAX_PER_CALL * 10;"],
    [PROBE, "export const DEFERRED_FORCE_DRAIN_FLOOR = 6;"],
    [PROBE, "export function noteTrackerPassSpend("],
    [PROBE, "export function drainTrackerReserve("],
    [PROBE, "const reserve = drainTrackerReserve();"],
    [PROBE, "if (subreqLeft() <= reserve) {"],
    [WORKER, "noteTrackerPassSpend(passSubreqBefore - subreqRemaining());"],
    [WORKER, "const passSubreqBefore = subreqRemaining();"],
    [SCANNER, "reserve?: number;"],
  ];
  for (const [file, needle] of checks) {
    const text = fs.readFileSync(file, "utf8");
    const n = text.split(needle).length - 1;
    console.log(`  ${n === 1 ? "✓" : "✗"} ${path.basename(file)} ${needle} x${n}`);
  }
  if (wrote === 0) console.log("\n(no file needed a write)");
}

main();
