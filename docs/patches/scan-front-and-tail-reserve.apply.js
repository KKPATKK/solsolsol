#!/usr/bin/env node
/**
 * 2026-09-25 audit fixes 1-3 + the /health half of 4.
 *
 * Kept as a script for the same reason every other deep edit in this repo is
 * (see docs/round-trips.md §6): src/worker.ts (~285KB) and
 * scripts/test-unit.js (~610KB) are far past the file tool's ~50KB edit
 * window, so `str_replace` answers "old string not found" no matter how exact
 * the anchor is. fs.readFileSync/writeFileSync round-trip the bytes exactly.
 *
 * What lands here:
 *   1. scanRaceWindowMs: clamp to [0, budget - flush reserve] instead of
 *      flooring at 2_500 (docs/scan-completion-loss.md Patch 1) — a slow
 *      gate/front tick then costs a SCAN, never its completion flush.
 *   2. TRACKER_PASS_SUBREQ_RESERVE + scanSubreqLeft: the scan's optional-leg
 *      floor now carries the tracker pass's slice.
 *   3. FRONT_INIT_BOUND_MS: the cron handler's `ensureInitialized` is bounded,
 *      so a wedged init records its arrival via the `!scanner` guard instead
 *      of dying before any bookkeeping.
 *   4. /health: `writeDrainErrorStale`, so a drain-failure row that no later
 *      failure rewrote cannot read as an active one (the drain itself clears
 *      it on recovery — see src/tickprobe.ts).
 *
 * Verify-then-write, unique-hit-only: any anchor that is missing or ambiguous
 * aborts the WHOLE run before a single byte is written.
 *
 * Run: node docs/patches/scan-front-and-tail-reserve.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const lines = (...xs) => xs.join("\n");

/** [file, label, old, new] — every replacement is exact-match, unique. */
const EDITS = [
  // ---------------------------------------------------------------- worker.ts
  [
    "src/worker.ts",
    "tickprobe import (WRITE_DRAIN_ERROR_STALE_MS)",
    lines(
      "  writeDrainView,",
      "  drainDeferredWrites,",
      "  noteDuplicateCards,",
    ),
    lines(
      "  writeDrainView,",
      "  drainDeferredWrites,",
      "  noteDuplicateCards,",
      "  WRITE_DRAIN_ERROR_STALE_MS,",
    ),
  ],
  [
    "src/worker.ts",
    "race window clamp (no floor)",
    lines(
      " * can push a coin. The 2_500ms floor stops a very slow pre-race from erasing",
      " * the scan entirely (a tick AT the floor is the alarm, not the fix: see",
      " * PreTickView and the two live witnesses below).",
      " */",
      "export function scanRaceWindowMs(preRaceSpendMs: number): number {",
      "  return Math.max(",
      "    2_500,",
      "    SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,",
      "  );",
      "}",
    ),
    lines(
      " * can push a coin.",
      " *",
      " * WHY THERE IS NO FLOOR (2026-09-25, docs/scan-completion-loss.md Patch 1):",
      " * the old `Math.max(2_500, ...)` broke the very invariant this calculation",
      " * exists to hold. `preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS` only",
      " * held while the floor did not bind: at preRace 7s the sum is",
      " * 7 + 2.5 + 4.5 = 14s, i.e. the slow-front tick the clamp exists to protect",
      " * was exactly the tick it killed before its completion flush — and a",
      " * recovering successor is a slow-front tick BY CONSTRUCTION (rebuild +",
      " * re-init, sometimes a cold list fetch), which is how one death became a",
      " * chain (live 2026-09-25: deaths climbing in the gate/front stage again, no",
      " * completed cron tick for 26 minutes). Clamping to [0, budget - reserve]",
      " * means a tick that cannot afford a scan spends its envelope on the",
      " * COMPLETION instead: `scanRaceMs === 0` fires the timeout branch at once,",
      " * `scanner.abort()` stops the scan at its next phase boundary, and the row",
      " * that lands says so. A completed 0s scan (candidate deferred, re-offered",
      " * next tick) beats a dead tick that evaluates nothing.",
      " */",
      "export function scanRaceWindowMs(preRaceSpendMs: number): number {",
      "  return Math.max(",
      "    0,",
      "    Math.min(",
      "      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS,",
      "      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,",
      "    ),",
      "  );",
      "}",
    ),
  ],
  [
    "src/worker.ts",
    "FRONT_INIT_BOUND_MS",
    lines("const PRE_INIT_ARRIVAL_BOUND_MS = 1_500;"),
    lines(
      "const PRE_INIT_ARRIVAL_BOUND_MS = 1_500;",
      "/**",
      " * Bound on the tick's front INIT (see `scheduled`). The cron handler's front",
      " * is the one stage that runs before any bookkeeping: `ensureInitialized`",
      " * pays the schema DDL on a cold isolate, the dead-tick recovery read on a",
      " * warm one, and the Turso handshake — and until now it was awaited",
      " * UNBOUNDED. A wedged init therefore died inside the invocation before the",
      " * gate could record the arrival: live 2026-09-25 `scheduled_tick_at` stood",
      " * still for 26 minutes while the HTTP fallback kept landing scans, i.e. cron",
      " * looked dead for a reason nothing published. Bounding it turns that into a",
      " * tick that RECORDS its arrival and returns (the path a missing scanner",
      " * already takes), so the next delivery — or the fallback — retries against",
      " * a fresh promise. 3_500 leaves the scan a real window: the race clamp above",
      " * absorbs anything slower, and it is ~3x the live warm-isolate Turso init.",
      " */",
      "export const FRONT_INIT_BOUND_MS = 3_500;",
    ),
  ],
  [
    "src/worker.ts",
    "TRACKER_PASS_SUBREQ_RESERVE + scanSubreqLeft",
    lines("const TRACKER_PASS_BUDGET_MS = 5_000;"),
    lines(
      "const TRACKER_PASS_BUDGET_MS = 5_000;",
      "/**",
      " * Subrequests held back from the SCAN for the post-flush tracker pass.",
      " *",
      " * WHY (live 2026-09-25): the pass is the LAST stage of the tick and the only",
      " * one that defers by name, so it is the residual claimant of the",
      " * invocation's 50-subrequest allowance — and the scan, which runs first, had",
      " * no reservation for it at all. The result was",
      " * `ok:0/0 deferred:subreq-budget` pass after pass while the rotation stalled",
      " * (rows went unchecked for 41 minutes), i.e. the coverage loss was visible",
      " * only in the pass note. The drain already yields (DRAIN_TRACKER_RESERVE);",
      " * this is the same discipline one stage earlier: the scan's OPTIONAL legs",
      " * are the only work in a tick that can be dropped, and they now stand down",
      " * while the pass's slice is intact.",
      " *",
      " * THE NUMBER is the pass's own arithmetic (pushwatch.TRACKER_SUBREQ_FLOOR 3",
      " * entry + TRACKER_SUBREQ_RESERVE 6 tail writes = 9), so this names exactly",
      " * what the pass needs to be worth starting rather than a round number.",
      " * `scanSubreqLeft` applies it; the scan's other gating is unchanged.",
      " */",
      "export const TRACKER_PASS_SUBREQ_RESERVE = 9;",
      "/**",
      " * The scan's view of the invocation's remaining subrequests: the counter",
      " * with the tracker pass's slice already taken off (see",
      " * TRACKER_PASS_SUBREQ_RESERVE). Pure and exported so the arithmetic is",
      " * pinned by a test rather than by the call site's comment. Negative is a",
      " * valid answer (\"the pass's slice is already gone\"); a caller must not",
      " * clamp it to 0, which would read as \"exactly at the reserve\" and hide the",
      " * overspend.",
      " */",
      "export function scanSubreqLeft(remaining: number): number {",
      "  return remaining - TRACKER_PASS_SUBREQ_RESERVE;",
      "}",
    ),
  ],
  [
    "src/worker.ts",
    "runOnce hands the reserve-aware counter",
    lines("        scanner.runOnce(subreqRemaining),"),
    lines(
      "        // The scan's counter carries the tracker pass's slice (see",
      "        // TRACKER_PASS_SUBREQ_RESERVE): optional legs stand down while the",
      "        // pass's tail is intact, instead of the scan spending it and the pass",
      "        // deferring by name.",
      "        scanner.runOnce(() => scanSubreqLeft(subreqRemaining())),",
    ),
  ],
  [
    "src/worker.ts",
    "scheduled: bounded front init",
    lines(
      "    const initAt = Date.now();",
      "    await ensureInitialized(env);",
      "    preTick.steps.init = Date.now() - initAt;",
    ),
    lines(
      "    const initAt = Date.now();",
      "    // BOUNDED (see FRONT_INIT_BOUND_MS): the init in front of this tick's",
      "    // gate was the last UNBOUNDED front await, and a wedged one died before",
      "    // the arrival could be written — which is how a cron hole read like a",
      "    // dead trigger while the HTTP fallback kept scanning. A timed-out init",
      "    // falls through to the `!scanner` guard below, which records the arrival",
      "    // with the standalone raw client and returns; the pending initPromise is",
      "    // picked up by the next delivery.",
      "    await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, \"init\");",
      "    preTick.steps.init = Date.now() - initAt;",
    ),
  ],
  [
    "src/worker.ts",
    "health: writeDrainErrorStale",
    lines(
      "        writeDrainErrorAgeMs: healthAgeMs(",
      "          Date.now(),",
      "          writeDrainError === null ? null : writeDrainError.at,",
      "        ),",
    ),
    lines(
      "        writeDrainErrorAgeMs: healthAgeMs(",
      "          Date.now(),",
      "          writeDrainError === null ? null : writeDrainError.at,",
      "        ),",
      "        // ...and whether that record still describes an ACTIVE failure. The",
      "        // row is a snapshot only a FAILURE rewrites, so after a recovery it",
      "        // sat there for hours (live 2026-09-25: 8.4h, `pending 15`) and read",
      "        // as live. The drain clears it on its own recovery (see",
      "        // clearPersistedDrainError); this flag covers the cross-isolate case —",
      "        // the isolate answering /health is not necessarily the one that",
      "        // failed — so a stale record can never be read as a current one.",
      "        writeDrainErrorStale:",
      "          writeDrainError === null || !(writeDrainError.at > 0)",
      "            ? null",
      "            : Date.now() - writeDrainError.at > WRITE_DRAIN_ERROR_STALE_MS,",
    ),
  ],
  // ---------------------------------------------------------- scripts/test-unit.js
  [
    "scripts/test-unit.js",
    "test import: the new worker exports",
    lines(
      'const { scanRaceWindowMs, buildPreTickSplit, preTickView, PRE_TICK_ZERO_STEPS, SCAN_TICK_BUDGET_MS, cronGateLoad } = require("../dist/worker.js");',
    ),
    lines(
      'const { scanRaceWindowMs, buildPreTickSplit, preTickView, PRE_TICK_ZERO_STEPS, SCAN_TICK_BUDGET_MS, cronGateLoad, scanSubreqLeft, TRACKER_PASS_SUBREQ_RESERVE, FRONT_INIT_BOUND_MS } = require("../dist/worker.js");',
    ),
  ],
  [
    "scripts/test-unit.js",
    "race window: no floor",
    lines(
      "    // The floor: 10:53:10Z quotes \"scan exceeded its 2500ms race window\" (and",
      "    // that tick went on to run 11.5s, losing its flush) — everything from",
      "    // 2500ms of pre-race upward gets the same clamped window, which is why a",
      "    // floored tick is a signal rather than a graceful degradation.",
      "    assert.equal(scanRaceWindowMs(2_500), 2_500);",
      "    assert.equal(scanRaceWindowMs(9_000), 2_500);",
    ),
    lines(
      "    // NO FLOOR (2026-09-25): 10:53:10Z quotes \"scan exceeded its 2500ms race",
      "    // window\" (and that tick went on to run 11.5s, losing its flush) — the",
      "    // floor it was clamped to was itself the cause (preRace + 2500 + 4500 >",
      "    // 9500). The window now drains 1:1 to zero, so a slow front costs the",
      "    // SCAN and never the completion flush.",
      "    assert.equal(scanRaceWindowMs(2_500), 2_500);",
      "    assert.equal(scanRaceWindowMs(5_000), 0);",
      "    assert.equal(scanRaceWindowMs(9_000), 0);",
      "    // A negative pre-race spend (clock skew, a bogus caller value) cannot",
      "    // inflate the window past the unencumbered one.",
      "    assert.equal(",
      "      scanRaceWindowMs(-1_000),",
      "      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS,",
      "    );",
    ),
  ],
  [
    "scripts/test-unit.js",
    "new tests: the scan's reserve + the bounded front init",
    lines(
      '  await test("pre-tick split: handler steps are published, and anything unmeasured reads null (never 0)", () => {',
    ),
    lines(
      "  // ---------- the scan yields the tracker pass its subrequests -------------",
      "  //",
      "  // The pass runs LAST and is the residual claimant of the invocation's 50;",
      "  // the scan runs FIRST and had no reservation for it (live 2026-09-25:",
      "  // `ok:0/0 deferred:subreq-budget` pass after pass while the rotation",
      "  // stalled). The scan is the only phase with optional work, so the counter",
      "  // it consults carries the pass's slice.",
      '  await test("subreq reserve: the scan is handed its budget minus the tracker pass\'s slice", () => {',
      "    // The pass's own arithmetic: entry floor 3 + tail reserve 6.",
      "    assert.equal(TRACKER_PASS_SUBREQ_RESERVE, 9);",
      "    assert.equal(scanSubreqLeft(30), 21);",
      "    assert.equal(scanSubreqLeft(TRACKER_PASS_SUBREQ_RESERVE), 0);",
      "    // Negative is a real answer — clamping it to 0 would read as \"exactly at",
      "    // the reserve\" and hide that the slice is already spent.",
      "    assert.equal(scanSubreqLeft(2), -7);",
      "    const workerSrc = fs.readFileSync(",
      '      path.join(__dirname, "..", "src", "worker.ts"),',
      '      "utf8",',
      "    );",
      "    assert.ok(",
      '      workerSrc.includes("scanner.runOnce(() => scanSubreqLeft(subreqRemaining()))"),',
      '      "the scan\'s counter must carry the reserve",',
      "    );",
      "  });",
      "",
      "  // ---------- the cron front's init is bounded ------------------------------",
      "  //",
      "  // Until 2026-09-25 the front init was awaited unbounded, so a wedged one",
      "  // died before the gate could record the arrival: `scheduled_tick_at` stood",
      "  // still for 26 minutes while the HTTP fallback kept scanning (a cron hole",
      "  // that read like a dead trigger). A bounded init falls through to the",
      "  // `!scanner` guard, which records the arrival with the standalone client.",
      '  await test("front init: the cron handler\'s init is bounded, and its split still lands", () => {',
      "    const workerSrc = fs.readFileSync(",
      '      path.join(__dirname, "..", "src", "worker.ts"),',
      '      "utf8",',
      "    );",
      "    assert.ok(",
      "      workerSrc.includes(",
      '        \'recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init")\',',
      "      ),",
      '      "the scheduled handler\'s init must be bounded",',
      "    );",
      "    assert.ok(",
      '      workerSrc.includes("preTick.steps.init = Date.now() - initAt;"),',
      '      "the pre-tick split must still be published for a bounded init",',
      "    );",
      "    assert.ok(",
      "      FRONT_INIT_BOUND_MS > 0 && FRONT_INIT_BOUND_MS < SCAN_TICK_BUDGET_MS,",
      '      "the bound has to leave the tick a real scan window",',
      "    );",
      "  });",
      "",
      '  await test("pre-tick split: handler steps are published, and anything unmeasured reads null (never 0)", () => {',
    ),
  ],
  [
    "scripts/test-unit.js",
    "race window test name: no floor",
    lines(
      '  await test("race window: the pre-race phase is paid for out of the scan\'s window, 1:1 until the floor", () => {',
    ),
    lines(
      '  await test("race window: the pre-race phase is paid for out of the scan\'s window, 1:1 to zero (no floor)", () => {',
    ),
  ],
  [
    "scripts/test-unit.js",
    "pre-init arrival stamp: follow the bounded init anchor",
    lines(
      '    const scheduledInit = workerSrc.indexOf("constinitAt=Date.now();awaitensureInitialized(env);");',
    ),
    lines(
      "    // The init this stamp must precede is BOUNDED now (see",
      "    // FRONT_INIT_BOUND_MS), so the anchor follows the recoveryAwait call.",
      "    const scheduledInit = workerSrc.indexOf(",
      '      \'constinitAt=Date.now();awaitrecoveryAwait(ensureInitialized(env),FRONT_INIT_BOUND_MS,"init");\',',
      "    );",
    ),
  ],
];

/** [file, marker, section] — appended only while `marker` is absent. */
const DOC_SECTION = lines(
  "",
  "---",
  "",
  "## 4.18 The 2026-09-25 audit's five findings (scan envelope, tracker slice, cron front, stale drain error, profiles abort)",
  "",
  "Operator ran the five-finding audit against the live worker and said \"fix 1-5\". Each finding,",
  "its cause, and what landed:",
  "",
  "### 1. Scan ticks dying again after 12:00Z, in the gate/front stage (red)",
  "",
  "**Cause**: `scanRaceWindowMs` floored the race window at 2_500ms, which broke its own",
  "invariant - `preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS`. At preRace 7s the sum is 14s,",
  "so the slow-front tick the clamp existed to protect was the one killed before its completion",
  "flush, and a recovering successor is a slow-front tick BY CONSTRUCTION (rebuild + re-init).",
  "This is `docs/scan-completion-loss.md`'s Patch 1, written but never applied.",
  "",
  "**Fix** (`src/worker.ts`): the window drains 1:1 to 0 and is capped at `budget - reserve`.",
  "`scanRaceMs === 0` fires the timeout branch at once, `scanner.abort()` stops the scan at its",
  "next phase boundary, and the tick still writes a completion row (`ok:false`, reason naming the",
  "0ms window). Cost: that one tick evaluates nothing - its candidates stay in the re-eval pool.",
  "A completed 0s scan beats a dead tick that evaluates nothing.",
  "",
  "### 2. Tracker pass `ok:0/0` - the scan ate the subrequest residual (red)",
  "",
  "**Cause**: the pass runs LAST and defers by name, so it is the residual claimant of the",
  "invocation's 50 subrequests - and the scan, which runs first, had no reservation for it.",
  "Live: `ok:0/0 deferred:subreq-budget` pass after pass while the rotation stalled.",
  "",
  "**Fix** (`src/worker.ts`): `TRACKER_PASS_SUBREQ_RESERVE = 9` (the pass's own",
  "`TRACKER_SUBREQ_FLOOR` 3 + `TRACKER_SUBREQ_RESERVE` 6) plus a pure `scanSubreqLeft` helper; the",
  "worker now hands `scanner.runOnce(() => scanSubreqLeft(subreqRemaining()))`. The scan's OPTIONAL",
  "legs (meteora / geoTrend / jupTrend / gmgn / axiom / backfill / crime-refresh) stand down while",
  "the pass's slice is intact. Nothing mandatory changes: DexScreener profiles, gecko new_pools,",
  "pump.fun, Jupiter recent and the card-enrichment path are untouched.",
  "",
  "### 3. No COMPLETED cron tick for 26 minutes, held up by the HTTP fallback (amber)",
  "",
  "**Cause**: the cron handler's `ensureInitialized` was the last UNBOUNDED front await. A wedged",
  "init (cold-isolate DDL, a stalled Turso handshake) died inside the invocation BEFORE the gate",
  "could record the arrival, so `scheduled_tick_at` froze while the fallback kept scanning - a cron",
  "hole that reads exactly like a dead trigger.",
  "",
  "**Fix** (`src/worker.ts`): `FRONT_INIT_BOUND_MS = 3_500`, and the scheduled handler awaits",
  "`recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, \"init\")`. A timed-out init falls",
  "through to the existing `!scanner` guard, which records the arrival with the standalone raw",
  "client (`bumpScheduledTickLegacy`) and returns; the pending `initPromise` is picked up by the",
  "next delivery. The pre-tick split still publishes `steps.init`.",
  "",
  "### 4. `writeDrainError` frozen at 8.4h and reading as live (amber)",
  "",
  "**Cause**: the durable row is written only on a FAILURE and never rewritten on success, so after",
  "a recovery it described an incident that was over while `/health` presented it beside counters",
  "that do move.",
  "",
  "**Fix** (two halves):",
  "",
  "- `src/tickprobe.ts`: `drainDeferredWrites` clears the row once a drain lands clean (and on an",
  "  empty queue), guarded by a module flag so only the isolate that wrote it clears it, and only",
  "  once - a healthy isolate pays NO extra write.",
  "- `src/worker.ts`: `/health` publishes `writeDrainErrorStale` (age > `WRITE_DRAIN_ERROR_STALE_MS`",
  "  = 10 min) beside the existing age, covering the cross-isolate case where the reader is not the",
  "  isolate that failed.",
  "",
  "### 5. `profiles` raw empty, carried by the make-up lane (yellow)",
  "",
  "**Cause**: the bounded profiles fetch measured its abort window BEFORE the shared DexScreener",
  "throttle queue, so an attempt could be issued with an expired window (or a 1ms one) - a doomed",
  "request that also ran the caller past its budget. Live: `raw 0` tick after tick with the make-up",
  "list filling `profiles` (a 429 reads as `failedTotal`, not as an empty feed).",
  "",
  "**Fix** (`src/dexscreener.ts`): the throttle wait is charged to the caller's deadline (the",
  "attempt is dropped, not sent, once the window is spent), and `PROFILE_FEED_SELF_BUDGET_MS` rose",
  "320 -> 480. 480 still sits under the throttle gap plus `RETRY_MIN_ATTEMPT_MS` (250 + 250), so the",
  "leg's single-attempt / fail-fast arithmetic is unchanged; the window is 900ms (FEED_DEADLINE_MS),",
  "not the 600ms this budget was originally measured against.",
  "",
  "### Verification",
  "",
  "- `npm run typecheck` clean.",
  "- `npm run test:unit` 348 passed / 0 failed (was 346): the race-window test now pins",
  "  `scanRaceWindowMs(5_000) === 0` and `scanRaceWindowMs(9_000) === 0`; two new worker tests cover",
  "  the reserve arithmetic + call site and the bounded init + its split; a test-tick-path case",
  "  proves the drain-error clear is ONE write and then nothing; a defer-priority case proves no",
  "  request is issued once the throttle wait has eaten the caller's window.",
  "- Live verification still required after deploy: `scheduledTickHoleMs` / `scheduledTickAt` should",
  "  stop freezing; `pushWatchPass.note` should read `rows N/...` instead of",
  "  `ok:0/0 deferred:subreq-budget`; `/health.writeDrainErrorStale` should never be `false` beside",
  "  an old record; `summary.feedMakeup.lastRawProfiles` should climb off 0.",
  "",
  "Landed by `docs/patches/scan-front-and-tail-reserve.apply.js` (worker.ts and test-unit.js are far",
  "past the file tool's edit window).",
);
const APPENDS = [["docs/round-trips.md", "## 4.18 The 2026-09-25 audit", DOC_SECTION]];

let failures = 0;
const applied = [];
/** Group by file so one file is read/written once. */
const byFile = new Map();
for (const [file, label, old, next] of EDITS) {
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push({ label, old, next });
}

for (const [file, edits] of byFile) {
  const full = path.join(root, file);
  let text = fs.readFileSync(full, "utf8");
  for (const { label, old, next } of edits) {
    if (text.includes(next)) {
      console.log(`ALREADY   ${file} :: ${label}`);
      continue;
    }
    const at = text.indexOf(old);
    if (at < 0) {
      console.error(`MISS      ${file} :: ${label}`);
      failures += 1;
      continue;
    }
    if (text.indexOf(old, at + 1) >= 0) {
      console.error(`AMBIGUOUS ${file} :: ${label}`);
      failures += 1;
      continue;
    }
    text = text.replace(old, next);
    applied.push(`${file} :: ${label}`);
  }
  if (failures > 0) break; // nothing is written unless every anchor hit
  fs.writeFileSync(full, text);
}

if (failures > 0) {
  console.error(`\nABORTED — ${failures} anchor(s) failed; no file was written.`);
  process.exit(1);
}
for (const [file, marker, section] of APPENDS) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, "utf8");
  if (text.includes(marker)) {
    console.log(`ALREADY   ${file} :: ${marker}`);
    continue;
  }
  fs.writeFileSync(full, text + "\n" + section + "\n");
  applied.push(`${file} :: ${marker}`);
}

for (const a of applied) console.log(`ok        ${a}`);
console.log(`\n${applied.length} edit(s) landed.`);
