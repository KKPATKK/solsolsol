#!/usr/bin/env node
/**
 * The tracker pass needs a second budget: the invocation's subrequest ceiling.
 *
 * WHY — the live reading that sent me here. Verifying the previous deploy
 * (252b720) showed three `/debug/tick` calls in a row whose coverage note read
 *
 *     pushWatch err:Too many subrequests by single Worker invocation
 *
 * and the two calls after them were fine. `src/subreqs.ts` already counts the
 * thing Cloudflare limits (every `fetch`, Turso round trips included) and
 * publishes it, but NOTHING read the count. The tick's front pays that budget
 * before the pass is even offered one, and the pass was bounded on its clock
 * alone. Measured on the live worker at the heartbeat write — i.e. after init,
 * the scan and the completion flush, with the pass still ahead:
 *
 *     front 18, 20, 20, 21, 28, 31  -> pass `ok:29-30/… trips 5-8`
 *     front 47 (ring ending `send:autobuy 46`, turso 32) -> pass dead
 *
 * A pass costs `trips 5`-`8` plus one pair batch (5-13), so 47 + ~10 overruns
 * the 50 Workers Free allows, and the pass's first Turso call is what the
 * platform refuses. The harm is bigger than the note: the pass's own writes
 * stop mid-rotation, its durable note is left at `phase:"running"` or carries
 * the raw `err:`, and the two stages behind it — the deferral-counter sync and
 * the write drain — never run at all. The 47s are the COLD-isolate ticks: init
 * (schema DDL, config hydrate, backfill chunks) is spent inside the same window
 * (`beginPreTick` runs before `ensureInitialized` on both handlers), which is
 * why the failures clustered in the minutes after a deploy — the same minutes
 * the zero-baseline repair is trying to run its one shot per isolate.
 *
 * So the two ceilings are now spent in a known order, the tail's reserve
 * first: the pass gets TRACKER_SUBREQ_FLOOR to start the rotation at all, and
 * refuses a multi-round-trip alerting row while TRACKER_SUBREQ_RESERVE is still
 * intact for the writes that follow it. The clock keeps its existing shape and
 * its existing first-row exemption (2026-09-17); this only adds the missing
 * axis, and a tick with room reads neither.
 *
 * An apply script because src/pushwatch.ts, src/scanner.ts, src/worker.ts and
 * the test at the end of scripts/test-unit.js all sit past the file-tool
 * window; every anchor must match exactly once or nothing is written.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ------------------------------------------------------------- subreqs.ts --
  {
    file: "src/subreqs.ts",
    what: "the pre-flight half of the counter",
    marker: "export function subreqRemaining(",
    anchor: lines(
      "/** Test seam: forget the boot's windows (never called on the tick path). */",
    ),
    replacement: lines(
      "/**",
      " * Subrequests still spendable in this window, never below 0.",
      " *",
      " * WHY IT EXISTS (2026-09-24): `subreqView()` above answers \"who spent the",
      " * budget\" AFTER the fact, which is a post-mortem. This is the pre-flight",
      " * half — what a LATE stage of a tick must consult BEFORE it starts a spend",
      " * that costs several subrequests, so a starved tick defers its tail by name",
      " * instead of spending the invocation's last call on a `Too many subrequests",
      " * by single Worker invocation` throw. Measured on the live worker: the scan",
      " * + completion flush reach 47 of 50 on a cold isolate (its phase ring ending",
      " * `send:autobuy 46`), and the tracker pass behind it needs 5-13 more (its own",
      " * `trips` counter), so on exactly those ticks the pass died mid-flight and",
      " * took the deferral sync and the write drain with it.",
      " *",
      " * The tail's own reserve is the CALLER's business — this only reports the",
      " * room that is left, so the two ceilings can be spent in a known order",
      " * instead of by whichever stage happened to run last. A window that has",
      " * counted nothing yet reports the full budget, so a caller ahead of its",
      " * first fetch (and any test that installs no probe) sees room, never a false",
      " * zero.",
      " *",
      " * The optional `budget` override exists for the probe seam only; the tick",
      " * path spends against SUBREQ_BUDGET_FREE, which is a platform fact.",
      " */",
      "export function subreqRemaining(budget: number = SUBREQ_BUDGET_FREE): number {",
      "  if (!Number.isFinite(budget)) return Number.POSITIVE_INFINITY;",
      "  return Math.max(0, budget - current.total);",
      "}",
      "",
      "/** Test seam: forget the boot's windows (never called on the tick path). */",
    ),
  },

  // ----------------------------------------------------------- pushwatch.ts --
  {
    file: "src/pushwatch.ts",
    what: "the pass's share of the two-ceiling order",
    marker: "const TRACKER_SUBREQ_FLOOR = 3;",
    anchor: lines("const TRACKER_TICK_BUDGET_MS = 5_000;"),
    replacement: lines(
      "const TRACKER_TICK_BUDGET_MS = 5_000;",
      "/**",
      " * The invocation has a SECOND ceiling, and until now this pass was bounded",
      " * on only one of them.",
      " *",
      " * WHY (2026-09-24): Workers Free allows 50 subrequests per INVOCATION",
      " * (src/subreqs.ts counts every one of them, Turso round trips included) and",
      " * the tick's front pays most of that BEFORE the pass is offered one — live",
      " * `heartbeat.subreqs.current` at the heartbeat write reads 18-31 on a warm",
      " * tick and 47 on a cold one, whose phase ring ended `send:autobuy 46`. A pass",
      " * costs `trips 5`-`8` plus one pair batch, i.e. 5-13. So on exactly the ticks",
      " * where the front was fat, the pass's first Turso call threw `Too many",
      " * subrequests by single Worker invocation`: the row loop died mid-flight, the",
      " * durable note was left at `phase:\"running\"` (or carried the raw `err:`), and",
      " * the two stages behind it — the deferral-counter sync and the write drain —",
      " * never ran at all. Nothing warned the pass: it checked its CLOCK",
      " * (TRACKER_TICK_BUDGET_MS) and never asked what was left of the invocation.",
      " *",
      " * The two budgets are now spent in a known order, the tail's reserve first.",
      " * These two numbers are the pass's share of that order:",
      " *",
      " *   - FLOOR: the cheapest pass that is still a pass. Reaching the rotation",
      " *     costs the cut-card proof read, the head pair batch and the ONE batched",
      " *     silent-row claim (3). Below that the loop cannot start, so the pass",
      " *     defers BY NAME (`deferred:subreq-budget`) instead of dying on its",
      " *     first round trip.",
      " *   - RESERVE: what the stages AFTER this pass must still find. The tail is",
      " *     the pass's own note persist (1), the deferral-counter sync (1-2), the",
      " *     write drain (2) and the observed-liquidity flush (0-1) — 5-6 subrequests",
      " *     of writes a tick cannot afford to lose, since a tick that misses its",
      " *     completion flush or its drain leaves a permanent hole in the",
      " *     bookkeeping. A row that needs 3+ of its own (claim + send + write) is",
      " *     therefore refused while that reserve is intact, and the next tick walks",
      " *     the rotation again.",
      " *",
      " * Both are free when there is room: a healthy tick (front 18-31) reads",
      " * neither, so its pass behaves exactly as it did before.",
      " */",
      "const TRACKER_SUBREQ_FLOOR = 3;",
      "const TRACKER_SUBREQ_RESERVE = 6;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "runTick takes the invocation probe",
    marker: "subreqLeft?: () => number,",
    anchor: lines(
      "  async runTick(",
      "    deadlineMs?: number,",
      "    keepAlive?: (promise: Promise<unknown>) => void,",
      "  ): Promise<{",
    ),
    replacement: lines(
      "  async runTick(",
      "    deadlineMs?: number,",
      "    keepAlive?: (promise: Promise<unknown>) => void,",
      "    subreqLeft?: () => number,",
      "  ): Promise<{",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the pass's documented second budget",
    marker: "* `subreqLeft` (optional) is the invocation's OTHER ceiling",
    anchor: lines(
      "   * `keepAlive` is the tick's `waitUntil` hand-off, when the caller has one",
    ),
    replacement: lines(
      "   * `subreqLeft` (optional) is the invocation's OTHER ceiling, taken as a",
      "   * function so this module never imports the counter — the caller owns the",
      "   * window, and a test owns a fake one. It is the same discipline as",
      "   * `deadlineMs`, checked at the same boundaries: between stages the pass",
      "   * defers by name (`deferred:subreq-budget`) once less than",
      "   * TRACKER_SUBREQ_FLOOR remains, and the row loop refuses a",
      "   * multi-round-trip row while the tail's TRACKER_SUBREQ_RESERVE is still",
      "   * intact (`subreq-cut N`). Omitted — the default — the pass is unbounded by",
      "   * subrequests, which is what every existing caller and test gets.",
      "   *",
      "   * `keepAlive` is the tick's `waitUntil` hand-off, when the caller has one",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the second bound, and which ceiling fired",
    marker: "const outOfBudget = (): boolean => {",
    anchor: lines("    const past = () => Date.now() > deadline;"),
    replacement: lines(
      "    const past = () => Date.now() > deadline;",
      "    // The invocation's second ceiling (see TRACKER_SUBREQ_FLOOR / _RESERVE).",
      "    // No probe = unbounded, so a caller that owns no window — and every test",
      "    // that installs none — behaves exactly as it did before.",
      "    const subreqsLeft = (): number =>",
      '      typeof subreqLeft === "function" ? subreqLeft() : Number.POSITIVE_INFINITY;',
      "    const outOfSubreqs = (): boolean => subreqsLeft() < TRACKER_SUBREQ_FLOOR;",
      "    // WHICH ceiling stopped the pass: the note's first token, so a starved",
      "    // invocation never reads like a starved pass.",
      '    let deferReason = "tick-budget";',
      "    const outOfBudget = (): boolean => {",
      "      if (past()) return true;",
      "      if (outOfSubreqs()) {",
      '        deferReason = "subreq-budget";',
      "        return true;",
      "      }",
      "      return false;",
      "    };",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the deferral note names the ceiling",
    marker: "return `deferred:${deferReason} ${stageNote()} trips ${trips}`;",
    anchor: lines(
      "        return `deferred:tick-budget ${stageNote()} trips ${trips}`;",
    ),
    replacement: lines(
      "        return `deferred:${deferReason} ${stageNote()} trips ${trips}`;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage gate: ask both ceilings (setup -> settle)",
    marker: "if (outOfBudget()) return deferred;",
    anchor: lines(
      "    // the remaining stages run on the next tick with fresh rows.",
      "    if (past()) return deferred;",
    ),
    replacement: lines(
      "    // the remaining stages run on the next tick with fresh rows.",
      "    if (outOfBudget()) return deferred;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage gate: ask both ceilings (heal -> rotation)",
    // Its own marker, NOT the shared `if (outOfBudget())` line: the gate above
    // already writes that string into the file, and a shared marker would make
    // this one look applied when it has not (verified 2026-09-24 — the first
    // run skipped it for exactly that reason).
    marker: lines(
      "    spent.heal.trips = trips - healTrips;",
      "    if (outOfBudget()) return deferred;",
    ),
    anchor: lines(
      "    spent.heal.trips = trips - healTrips;",
      "    if (past()) return deferred;",
    ),
    replacement: lines(
      "    spent.heal.trips = trips - healTrips;",
      "    if (outOfBudget()) return deferred;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the row-level cut counter",
    marker: "let subreqCut = 0;",
    anchor: lines(
      "    let claimLost = 0;",
      "    let budgetCut = false;",
    ),
    replacement: lines(
      "    let claimLost = 0;",
      "    let budgetCut = false;",
      "    /**",
      "     * Rows the loop refused because the tail's subrequest reserve was still",
      "     * intact (see TRACKER_SUBREQ_RESERVE). Reported as `subreq-cut N` beside",
      "     * the clock's `budget-cut` so the two ceilings can never read alike.",
      "     */",
      "    let subreqCut = 0;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the row loop's subrequest gate, first row exempt",
    marker: "const subreqShort =",
    anchor: lines(
      "    const rowReserveMs = (): number =>",
      "      Math.min(TRACKER_ROW_LEASH_MS, tripMs());",
      "    for (const row of head) {",
    ),
    replacement: lines(
      "    const rowReserveMs = (): number =>",
      "      Math.min(TRACKER_ROW_LEASH_MS, tripMs());",
      "    /**",
      "     * The subrequest gate BETWEEN rows — the second half of the pair with",
      "     * overBudget. It gates the row's SPEND, never the row itself: a silent",
      "     * row rides the ONE batched claim the pass was already paying for, and",
      "     * the loop's FIRST row is exempt outright, the same progress-floor rule",
      "     * the clock keeps, because a pass that refuses its own head has measured",
      "     * nothing at all (the 2026-09-17 shape). Only an ALERTING row — claim +",
      "     * sends + write — consults it, and refusing one is free: the row is left",
      "     * completely untouched, exactly as the send-slice gate leaves it, so the",
      "     * next tick re-derives it against a fresh budget.",
      "     */",
      "    let rowIndex = 0;",
      "    for (const row of head) {",
      "      const subreqShort =",
      "        rowIndex > 0 && subreqsLeft() <= TRACKER_SUBREQ_RESERVE;",
      "      rowIndex += 1;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "an alerting row is refused, not attempted",
    marker: "subreqCut += 1;",
    anchor: lines(
      "      trips += 1;",
      "      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now))) {",
    ),
    replacement: lines(
      "      if (subreqShort) {",
      "        // `continue`, not `break`, for the reason the send-slice gate gives:",
      "        // this row is left untouched and the quiet rows behind it still ride",
      "        // this pass's ONE batch. The pass then publishes `subreq-cut N` rather",
      "        // than spending the invocation's last subrequest on a claim with",
      "        // nothing left behind it.",
      "        subreqCut += 1;",
      "        sendDeferred += 1;",
      "        continue;",
      "      }",
      "      trips += 1;",
      "      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now))) {",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the note reports the row-level cut",
    marker: "`${subreqCut > 0 ? ` subreq-cut ${subreqCut}` : \"\"} ` +",
    anchor: lines(
      '      `${budgetCut ? " budget-cut" : ""} ${stageNote()} trips ${trips}`;',
    ),
    replacement: lines(
      '      `${budgetCut ? " budget-cut" : ""}` +',
      '      `${subreqCut > 0 ? ` subreq-cut ${subreqCut}` : ""} ` +',
      "      `${stageNote()} trips ${trips}`;",
    ),
  },

  // -------------------------------------------------------------- scanner.ts --
  {
    file: "src/scanner.ts",
    what: "the pass hands the probe on",
    marker: "subreqLeft?: () => number,",
    anchor: lines(
      "  async runTrackerPass(",
      "    deadlineMs: number,",
      "    keepAlive?: (promise: Promise<unknown>) => void,",
      "  ): Promise<string | null> {",
    ),
    replacement: lines(
      "  async runTrackerPass(",
      "    deadlineMs: number,",
      "    keepAlive?: (promise: Promise<unknown>) => void,",
      "    subreqLeft?: () => number,",
      "  ): Promise<string | null> {",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "runTrackerPass forwards the probe to runTick",
    marker: "this.pushWatcher.runTick(deadlineMs, keepAlive, subreqLeft),",
    anchor: lines(
      "        this.pushWatcher.runTick(deadlineMs, keepAlive),",
    ),
    replacement: lines(
      "        this.pushWatcher.runTick(deadlineMs, keepAlive, subreqLeft),",
    ),
  },

  // --------------------------------------------------------------- worker.ts --
  {
    file: "src/worker.ts",
    what: "import the invocation probe",
    marker: "  subreqRemaining,",
    anchor: lines(
      "import {",
      "  beginSubreqWindow,",
      "  countSubreq,",
      "  subreqView,",
      '} from "./subreqs";',
    ),
    replacement: lines(
      "import {",
      "  beginSubreqWindow,",
      "  countSubreq,",
      "  subreqRemaining,",
      "  subreqView,",
      '} from "./subreqs";',
    ),
  },
  {
    file: "src/worker.ts",
    what: "the tick hands the pass what is left of the invocation",
    // Indented to the call site, NOT the two-space import line, and not the two
    // adjacent lines either — the comment block the replacement writes sits
    // between them, so a marker spanning them can never match a patched tree.
    marker: "            subreqRemaining,",
    anchor: lines(
      "          await scanner.runTrackerPass(",
      "            Date.now() + trackerBudgetMs,",
      "            holdTick ? (p: Promise<unknown>) => holdTick(p) : undefined,",
      "          );",
    ),
    replacement: lines(
      "          await scanner.runTrackerPass(",
      "            Date.now() + trackerBudgetMs,",
      "            holdTick ? (p: Promise<unknown>) => holdTick(p) : undefined,",
      "            // The invocation's OTHER ceiling (see src/subreqs.ts). The pass",
      "            // runs last, so it is the residual claimant: measured on a cold",
      "            // isolate the front (init + scan + completion flush) had already",
      "            // spent 47 of the 50 Workers Free allows, and the pass's first",
      "            // Turso call is what the runtime then refused — killing the row loop",
      "            // and the deferral sync and write drain behind it. Handing the",
      "            // counter in lets the pass defer by name instead, and keeps its",
      "            // own reserve for those tail writes.",
      "            subreqRemaining,",
      "          );",
    ),
  },

  // ------------------------------------------------------- scripts/test-unit --
  // The two corrections below are kept as their own steps so a tree that
  // already carries the first version of each test converges instead of
  // silently keeping a test that asserts the wrong thing.
  {
    file: "scripts/test-unit.js",
    what: "the reserve test asserts the loop's own prefix, not the stage's ms/trips",
    // The POST-fix line is the marker: a pre-fix string is present in an
    // unpatched file, so using it here makes the patch look applied and skips
    // the very correction it carries.
    marker: 'assert.match(String(out.note), /^rows 1\\/2 /, "the loop measured its head and refused the rest',
    // `rows 0/1` ALSO appears inside stageNote()'s `spend[...]` (the row stage's
    // ms/trips), so a bare /rows 0/ match says nothing about the loop. The
    // loop's reading is the note's FIRST token pair, so that is what is pinned.
    anchor: lines(
      "    assert.doesNotMatch(String(out.note), /rows 0\\//, \"never the silent `rows 0/` shape the 2026-09-17 fix was written against\");",
    ),
    replacement: lines(
      "    // The loop's own prefix, not `rows 0/` anywhere: stageNote()'s `spend[...]`",
      "    // carries the row stage's OWN ms/trips as `rows 0/1`, so a loose match",
      "    // would read the stage and not the rotation.",
      '    assert.match(String(out.note), /^rows 1\\/2 /, "the loop measured its head and refused the rest — never the silent 2026-09-17 `rows 0/` shape");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard compares against whitespace-stripped source",
    marker: 'pushwatchSrc.includes("subreq-cut${subreqCut}"),',
    // strip() removes ALL whitespace, template-literal content included, so the
    // expected string has to be written the same way or the check can never
    // pass on a correctly patched tree.
    anchor: lines(
      '        pushwatchSrc.includes("subreq-cut ${subreqCut}"),',
    ),
    replacement: lines(
      '        pushwatchSrc.includes("subreq-cut${subreqCut}"),',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard: the two ceilings land all together or not at all",
    marker: "partial paste of docs/patches/tracker-subreq-budget.apply.js",
    anchor: lines('  console.log("\\n===== UNIT TESTS =====");'),
    replacement: lines(
      '  await test("out-of-window patch: the pass\'s subrequest ceiling is wired end to end (docs/patches/tracker-subreq-budget.apply.js)", () => {',
      '    // Comments and whitespace stripped, so a mention of the rule in a',
      '    // comment can never satisfy a check: only the CODE has to carry it.',
      '    const strip = (text) =>',
      '      text',
      '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
      '        .replace(/\\/\\/[^\\n]*/g, "")',
      '        .replace(/\\s+/g, "");',
      '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
      '    const subreqsSrc = read("src/subreqs.ts");',
      '    const pushwatchSrc = read("src/pushwatch.ts");',
      '    const scannerSrc = read("src/scanner.ts");',
      '    const workerSrc = read("src/worker.ts");',
      '    const applied = {',
      '      "subreqs (the probe exists)": subreqsSrc.includes(',
      '        "exportfunctionsubreqRemaining(budget:number=SUBREQ_BUDGET_FREE):number{",',
      '      ),',
      '      "pushwatch (both ceilings are named)":',
      '        pushwatchSrc.includes("constTRACKER_SUBREQ_FLOOR=3;") &&',
      '        pushwatchSrc.includes("constTRACKER_SUBREQ_RESERVE=6;"),',
      '      "pushwatch (runTick takes the probe)":',
      '        pushwatchSrc.includes("keepAlive?:(promise:Promise<unknown>)=>void,subreqLeft?:()=>number,"),',
      '      "pushwatch (both stage gates ask both ceilings)":',
      '        (pushwatchSrc.split("if(outOfBudget())returndeferred;").length - 1) === 2 &&',
      '        !pushwatchSrc.includes("if(past())returndeferred;"),',
      '      "pushwatch (the note names the ceiling)":',
      '        pushwatchSrc.includes("deferred:${deferReason}${stageNote()}trips${trips}"),',
      '      "pushwatch (the row loop keeps the tail reserve)":',
      '        pushwatchSrc.includes("rowIndex>0&&subreqsLeft()<=TRACKER_SUBREQ_RESERVE;") &&',
      '        pushwatchSrc.includes("subreqCut+=1;"),',
      '      "pushwatch (the cut is in the note)":',
      '        pushwatchSrc.includes("subreq-cut ${subreqCut}"),',
      '      "scanner (the probe is forwarded)":',
      '        scannerSrc.includes("this.pushWatcher.runTick(deadlineMs,keepAlive,subreqLeft)"),',
      '      "worker (the tick supplies the counter)": workerSrc.includes(',
      '        "awaitscanner.runTrackerPass(Date.now()+trackerBudgetMs,holdTick?(p:Promise<unknown>)=>holdTick(p):undefined,subreqRemaining,);",',
      '      ),',
      '    };',
      '    const done = Object.entries(applied).filter(([, v]) => v);',
      '    if (done.length === 0) {',
      '      console.log(',
      '        "  ℹ pass subrequest ceiling missing - apply docs/patches/tracker-subreq-budget.apply.js",',
      '      );',
      '      return;',
      '    }',
      '    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);',
      '    // A half-wired ceiling is the state this change must never be shipped in:',
      '    // a probe nobody supplies is dead code, while a gate whose reserve is',
      '    // unreachable cannot name why a pass stopped. Both directions are',
      '    // silent at runtime, so they are caught here instead.',
      '    assert.equal(',
      '      missing.length,',
      '      0,',
      '      `partial paste of docs/patches/tracker-subreq-budget.apply.js — missing: ${missing.join(", ")}`,',
      '    );',
      '  });',
      '',
      '  console.log("\\n===== UNIT TESTS =====");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the pass's subrequest ceiling, its name, and the first-row floor",
    marker: "deferred:subreq-budget",
    // Rides this script because this test sits at the end of a 10.8K-line file,
    // past what the file tool will edit.
    anchor: lines(
      '  await test("PushWatcher: a REJECTED terminal card still rolls back (a fact, not an absence)", async () => {',
    ),
    replacement: lines(
      '  // The invocation\'s subrequest ceiling, threaded into the pass (2026-09-24).',
      '  // Live: the front spent 47 of the 50 Workers Free allows on a cold isolate,',
      '  // and the pass behind it — which needs `trips 5`-`8` plus its pair batch —',
      '  // died on the runtime\'s `Too many subrequests by single Worker invocation`',
      '  // throw, taking the deferral sync and the write drain with it.',
      '  await test("PushWatcher: a starved INVOCATION defers the pass by name (not a starved tick)", async () => {',
      '    const db = termDb([termRow()]);',
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    // 2 left: below TRACKER_SUBREQ_FLOOR, so the rotation cannot even start —',
      '    // but the pass must say WHICH ceiling stopped it, because "deferred:" alone',
      '    // used to mean the clock.',
      '    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 2);',
      '    assert.match(String(out.note), /^deferred:subreq-budget /, "the note names the ceiling, not just that it deferred");',
      '    assert.equal(out.checked, 0, "no row was touched — the pass could not pay for one");',
      '    assert.equal(db.updated.length, 0, "and nothing was written on the way out");',
      '  });',
      '',
      '  await test("PushWatcher: a healthy invocation is unbounded by the probe (room reads no gate)", async () => {',
      '    const db = termDb([termRow()]);',
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    // 50 left = the whole Workers Free allowance: the pass runs as it always did.',
      '    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 50);',
      '    assert.equal(out.checked, 1, "the row is measured when there is room");',
      '    assert.equal(out.alerted, 1, "and its card is sent");',
      '    assert.doesNotMatch(String(out.note), /subreq/, "a healthy pass never mentions the subrequest gate");',
      '  });',
      '',
      '  await test("PushWatcher: the row loop keeps the tail\'s RESERVE, and still runs its first row", async () => {',
      '    // Two alerting rows, six subrequests left: above TRACKER_SUBREQ_FLOOR (the',
      '    // rotation can start) and at TRACKER_SUBREQ_RESERVE (nothing may be spent',
      '    // past it, because the deferral sync and the write drain come next).',
      '    const db = termDb([termRow(), termRow({ token: "SECOND", symbol: "SECOND" })]);',
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 6);',
      '    assert.equal(out.checked, 1, "the FIRST row runs regardless — the 2026-09-17 progress floor, on this ceiling too");',
      '    assert.equal(out.alerted, 1, "and its card still goes out");',
      '    assert.equal(db.updated.length, 1, "only that row was written");',
      '    assert.match(String(out.note), /subreq-cut 1/, "the refused row is named in the note");',
      '    assert.match(String(out.note), /defer-send 1/, "and counted as a card this pass could not deliver");',
      '    assert.doesNotMatch(String(out.note), /rows 0\\//, "never the silent `rows 0/` shape the 2026-09-17 fix was written against");',
      '  });',
      '',
      '  await test("PushWatcher: a REJECTED terminal card still rolls back (a fact, not an absence)", async () => {',
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
