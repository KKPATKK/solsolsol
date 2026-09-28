#!/usr/bin/env node
/*
 * Apply: SHED a tick whose race window is too small to scan in, instead of
 * spending it (2026-09-28).
 *
 * WHY: live 03:50-04:18Z, 26 consecutive ticks completed with
 * `scan exceeded its 680ms race window (… preRace 4320ms = json 0 + claim
 * 1440)` and `profiles 0 pool 0 candidates 0` — every one of those minutes also
 * carried an `exceededResources` at 10,000-21,752us (see docs/round-trips.md
 * §4.46). The scan was granted a window it could do nothing in, and the tick
 * spent its feeds, its pool query and its CPU to produce a row that says
 * nothing happened. That is the shape this change removes: keep the completion
 * (the mandatory half, the only thing the no-completion alert reads), give up
 * the scan, and say so by name.
 *
 * WHY A SCRIPT AND NOT AN EDITOR: str_replace's snapshot of src/worker.ts is
 * stale — every anchor below was verified against the file on disk. Anchored +
 * idempotent, the same discipline the other docs/patches/*.apply.js scripts
 * use: a `marker` that exists ONLY after the edit lands, so a second run
 * reports "=" instead of doubling anything.
 *
 * Idempotent + self-verifying: prints ✓ (applied), = (already there), ✗ (the
 * anchor is missing — the file has moved on) and exits non-zero on any ✗.
 *
 * Run: node docs/patches/race-window-shed-2026-09-28.apply.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const worker = path.join(root, "src", "worker.ts");
const unit = path.join(root, "scripts", "test-unit.js");
const tickPath = path.join(root, "scripts", "test-tick-path.js");

const EDITS = [
  // ------------------------------------------------------------- worker ----
  {
    file: worker,
    name: "W1 the shed floor + its pure rule (SCAN_RACE_MIN_USEFUL_MS)",
    marker: "export const SCAN_RACE_MIN_USEFUL_MS",
    from: `      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,
    ),
  );
}
`,
    to: `      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,
    ),
  );
}

/**
 * The smallest race window a scan can still be GRANTED — below it the tick's
 * scan is SHED instead (see scanRaceShedReason).
 *
 * WHY A FLOOR IS RIGHT HERE even though granting one is not (2026-09-28): the
 * floor removed from the GRANT in 2026-09-25 clamped the window UPWARDS, which
 * broke \`preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS\` and killed the very
 * tick it was meant to protect. This one clamps nothing: it only decides whether
 * a window that is ALREADY too small gets spent on a scan at all, so it can
 * never lengthen a tick.
 *
 * WHERE THE NUMBER COMES FROM (measured, not chosen). The scan's own front is
 * the feed phase — live /health 2026-09-28 04:54Z read \`feedsMs 541\` — and the
 * pair phase behind it is a FIXED 1,000ms window (PAIRS_FETCH_BUDGET_MS), so a
 * granted window under ~1,541ms cannot reach the pair phase and cannot evaluate
 * a single coin, which is the only way a tick can push. The live readings sit
 * on either side of that line: ticks cut at a 680ms window landed
 * \`profiles 0 pool 0 candidates 0\` for 26 minutes straight (03:50-04:18Z,
 * while the isolate was CPU-starved), while ticks cut at 3,430ms and 3,629ms
 * landed \`profiles 25\` and \`profiles 31\` with candidates beside them. 1,500
 * keeps the line between the two with room on both sides.
 *
 * WHAT A SHED TICK COSTS: one rotation turn of evaluation, exactly like every
 * other budget cut — the re-eval pool re-offers the candidate next tick. What it
 * saves is the whole scan: in the 680ms case the feeds, the pool query and the
 * scan's CPU were all spent to produce a row that says \`profiles 0\`.
 */
export const SCAN_RACE_MIN_USEFUL_MS = 1_500;

/**
 * The skip reason a tick records when its granted race window is too small to
 * scan in (see SCAN_RACE_MIN_USEFUL_MS), or null when the window is usable.
 *
 * Same shape as drainShedReason's rule: a pure function returning null for the
 * ordinary case, exported so the boundary is pinned by a test rather than by a
 * comment. The caller ZEROES the window when this is non-null, which reuses the
 * already-tested \`scanRaceMs === 0\` branch — the timeout fires at once,
 * abort() stops the scan at its next phase boundary, and the completion row (the
 * tick's mandatory half, and the only thing the no-completion alert reads) still
 * lands.
 *
 * Recording the reason as well is what makes a shed COUNTABLE: in scan_history
 * a shed tick looks like any other timeout, and a shed and a genuine cut have
 * different fixes.
 */
export const SCAN_RACE_SHED_REASON = "race-window-shed";

export function scanRaceShedReason(grantedRaceMs: number): string | null {
  return grantedRaceMs < SCAN_RACE_MIN_USEFUL_MS
    ? SCAN_RACE_SHED_REASON
    : null;
}
`,
  },
  {
    file: worker,
    name: "W2 scanRaceWindowMs docstring: the shed floor is not a grant floor",
    marker: "THE SHED FLOOR IS NOT A GRANT FLOOR",
    from: ` * next tick) beats a dead tick that evaluates nothing.
 */
`,
    to: ` * next tick) beats a dead tick that evaluates nothing.
 *
 * THE SHED FLOOR IS NOT A GRANT FLOOR (2026-09-28): the arithmetic below still
 * drains 1:1 to zero and still returns 0 rather than a minimum, so nothing HERE
 * changed. What changed is what the CALLER does with a window this small — see
 * SCAN_RACE_MIN_USEFUL_MS and scanRaceShedReason.
 */
`,
  },
  {
    file: worker,
    name: "W3 the call site: refuse the window, record the reason",
    marker: "const raceShedReason = scanRaceShedReason(grantedRaceMs);",
    from: `      const scanRaceMs = scanRaceWindowMs(Date.now() - startedAt);
`,
    to: `      const grantedRaceMs = scanRaceWindowMs(Date.now() - startedAt);
      // A window the scan cannot reach its pair phase in is SHED, not granted
      // (2026-09-28): the tick keeps its completion flush — the mandatory half,
      // and the only thing the no-completion alert reads — and gives up a scan
      // that could only land \`profiles 0\`. Zeroing the window reuses the
      // documented \`scanRaceMs === 0\` branch below, and the reason is recorded
      // so the shed shows up in the skip counters instead of reading as a cut.
      const raceShedReason = scanRaceShedReason(grantedRaceMs);
      if (raceShedReason) noteSkipReason(raceShedReason);
      const scanRaceMs = raceShedReason ? 0 : grantedRaceMs;
`,
  },
  {
    file: worker,
    name: "W4 the row and the log name a shed as a shed",
    marker: "scan shed: the front left a",
    from: `      lastScanError = timedOut
        ? \`scan exceeded its \${scanRaceMs}ms race window (tick budget \${SCAN_TICK_BUDGET_MS}ms, flush reserve \${SCAN_FLUSH_RESERVE_MS}ms, \${frontSplitNote(preTick)})\`
        : null;
      if (timedOut) {
        console.error(\`[worker] scan ran past its \${scanRaceMs}ms race window — completion written with timeout flag\`);
      }
`,
    to: `      lastScanError = timedOut
        ? raceShedReason
          ? \`scan shed: the front left a \${grantedRaceMs}ms window, under the \${SCAN_RACE_MIN_USEFUL_MS}ms floor it takes to reach the pair phase (tick budget \${SCAN_TICK_BUDGET_MS}ms, flush reserve \${SCAN_FLUSH_RESERVE_MS}ms, \${frontSplitNote(preTick)})\`
          : \`scan exceeded its \${scanRaceMs}ms race window (tick budget \${SCAN_TICK_BUDGET_MS}ms, flush reserve \${SCAN_FLUSH_RESERVE_MS}ms, \${frontSplitNote(preTick)})\`
        : null;
      if (timedOut) {
        console.error(
          raceShedReason
            ? \`[worker] scan shed: only \${grantedRaceMs}ms of race window is under the \${SCAN_RACE_MIN_USEFUL_MS}ms floor — completion written without scanning\`
            : \`[worker] scan ran past its \${scanRaceMs}ms race window — completion written with timeout flag\`,
        );
      }
`,
  },

  // -------------------------------------------------------------- tests ----
  {
    file: unit,
    name: "T1 test-unit: the boundary, the live witnesses, the call site",
    marker: "race window shed: a window under the pair-phase floor is refused",
    from: `    assert.equal(
      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - SCAN_TICK_DEADLINE_MS,
      800,
    );
  });
`,
    to: `    assert.equal(
      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - SCAN_TICK_DEADLINE_MS,
      800,
    );
  });

  // ---------- a window too small to scan in is refused, not spent ----------
  // Live 2026-09-28 03:50-04:18Z: 26 consecutive ticks completed with
  // "scan exceeded its 680ms race window … preRace 4320ms" and
  // profiles 0 / pool 0 / candidates 0, every one of them on a minute that also
  // carried an exceededResources at 10,000-21,752us. The scan was granted a
  // window it could do nothing in. The rule is pure and pinned here rather than
  // inferred from whatever /health happens to show.
  await test("race window shed: a window under the pair-phase floor is refused, not spent", () => {
    const {
      scanRaceShedReason,
      SCAN_RACE_MIN_USEFUL_MS,
      SCAN_RACE_SHED_REASON,
      scanRaceWindowMs,
    } = require("../dist/worker.js");
    // The boundary, both sides of it.
    assert.equal(
      scanRaceShedReason(SCAN_RACE_MIN_USEFUL_MS - 1),
      SCAN_RACE_SHED_REASON,
      "one millisecond under the floor is a shed",
    );
    assert.equal(scanRaceShedReason(SCAN_RACE_MIN_USEFUL_MS), null, "at the floor it scans");
    assert.equal(SCAN_RACE_SHED_REASON, "race-window-shed");
    // The two live shapes that named the number.
    assert.equal(scanRaceShedReason(680), SCAN_RACE_SHED_REASON, "the 680ms no-op window");
    assert.equal(scanRaceShedReason(3_430), null, "the 3430ms tick that landed profiles 25");
    // A HEALTHY tick can never be shed: the floor has to stay under the window
    // an unencumbered front gets, or it would refuse windows that today carry
    // the whole sweep.
    assert.ok(
      SCAN_RACE_MIN_USEFUL_MS < scanRaceWindowMs(0),
      "the floor must sit below the unencumbered window",
    );
    // The live witness: preRace 4320ms is exactly the front the 680ms window
    // came off, and the arithmetic itself must not have moved.
    assert.equal(scanRaceWindowMs(4_320), 680);
    assert.equal(scanRaceShedReason(scanRaceWindowMs(4_320)), SCAN_RACE_SHED_REASON);
    // ...and the call site has to ACT on it: zero the window (0 = the
    // documented no-scan branch) and record why, or a shed is indistinguishable
    // from a cut in the row the operator reads.
    const strip = (text) =>
      text
        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
        .replace(/\\/\\/[^\\n]*/g, "")
        .replace(/\\s+/g, "");
    const workerSrc = strip(
      fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8"),
    );
    assert.ok(
      workerSrc.includes("constscanRaceMs=raceShedReason?0:grantedRaceMs;"),
      "the shed must zero the granted window",
    );
    assert.ok(
      workerSrc.includes("if(raceShedReason)noteSkipReason(raceShedReason);"),
      "and must record the reason, or a shed reads as a timeout",
    );
    assert.ok(
      workerSrc.includes("scanshed:thefrontlefta"),
      "the row must say shed, not exceeded",
    );
  });
`,
  },
  {
    file: tickPath,
    name: "T2 test-tick-path: the shed rule, both sides of the boundary",
    marker: "the race-window shed floor (worker.ts scanRaceShedReason)",
    from: `    assert.equal(drainShedReason(false), null, "an ordinary tick publishes no reason");
    console.log("death-driven drain ceiling: pass");
  }
`,
    to: `    assert.equal(drainShedReason(false), null, "an ordinary tick publishes no reason");
    console.log("death-driven drain ceiling: pass");
  }

  // ---------- the race-window shed floor (worker.ts scanRaceShedReason) ------
  // The tick-level counterpart of the drain ceiling above, and the same shape: a
  // pure rule returning null for the ordinary case. Live 2026-09-28 03:50-04:18Z
  // 26 consecutive ticks landed profiles 0 behind race windows of 680ms while the
  // isolate was CPU-starved (an exceededResources on every one of those minutes).
  // A window that cannot reach the scan's pair phase — a FIXED 1,000ms behind a
  // ~541ms feed — cannot evaluate a single coin, so the scan is SHED: the
  // completion still lands, the scan does not run.
  {
    const { scanRaceShedReason, SCAN_RACE_MIN_USEFUL_MS, scanRaceWindowMs } =
      require("../dist/worker.js");
    assert.equal(
      scanRaceShedReason(SCAN_RACE_MIN_USEFUL_MS - 1),
      "race-window-shed",
      "one millisecond under the floor is a shed",
    );
    assert.equal(scanRaceShedReason(SCAN_RACE_MIN_USEFUL_MS), null, "at the floor it scans");
    assert.equal(scanRaceShedReason(680), "race-window-shed", "the live no-op window");
    assert.equal(
      scanRaceShedReason(scanRaceWindowMs(0)),
      null,
      "a healthy front is never shed",
    );
    console.log("race-window shed floor: pass");
  }
`,
  },
];

let ok = true;
for (const e of EDITS) {
  const before = fs.readFileSync(e.file, "utf8");
  const label = path.relative(root, e.file);
  if (before.includes(e.marker)) {
    console.log(`= ${e.name} (already present)`);
    continue;
  }
  const at = before.indexOf(e.from);
  if (at < 0) {
    console.log(`✗ ${e.name} — anchor not found in ${label}`);
    ok = false;
    continue;
  }
  if (before.indexOf(e.from, at + 1) >= 0) {
    console.log(`✗ ${e.name} — anchor is not unique in ${label}`);
    ok = false;
    continue;
  }
  fs.writeFileSync(e.file, before.slice(0, at) + e.to + before.slice(at + e.from.length));
  console.log(`✓ ${e.name}`);
}

console.log(ok ? "done" : "FAILED — see ✗ above");
process.exit(ok ? 0 : 1);
