#!/usr/bin/env node
/**
 * Unit tests for the subrequest counter (see subreq-counter.apply.js).
 *
 * scripts/test-unit.js is ~466KB, past the file tools' window, so these ride
 * the same patch discipline as the source edit: each replacement must match
 * EXACTLY once or nothing is written.
 *
 * What is pinned, and why:
 *  - the BUDGET the readings are spent against (50 = Workers Free) and the two
 *    ring sizes: they are what makes a reading interpretable at all;
 *  - the counting unit (one increment per call, calls accumulate);
 *  - the PHASE POINTS: the total at each phase stamp, window-relative ms, and
 *    a ring that keeps the NEWEST — because the window worth reading is the one
 *    that died, and its tail is where the budget went;
 *  - the ROLL: a finished window moves to `recent` newest-first, capped, and an
 *    idle window (nothing counted, no phase) is not stored — a killed
 *    invocation never publishes anything, so this roll is the ONLY way its
 *    spend is readable.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";

const lines = (...xs) => xs.join("\n");

const tests = lines(
  "",
  "  // ---------- Subrequest counter (src/subreqs.ts) ----------",
  "",
  '  await test("subreqs: the budget and the ring sizes are the platform facts", async () => {',
  "    // 50 subrequests per invocation is Workers Free's documented cap and the",
  "    // number every reading in /health.heartbeat.subreqs is spent against; the",
  "    // runtime's throw is what kills a tick before its completion flush.",
  "    assert.equal(SUBREQ_BUDGET_FREE, 50);",
  "    // The ring keeps the NEWEST phase points (the dead window's tail).",
  "    assert.equal(SUBREQ_PHASE_RING, 8);",
  "    // Two finished windows: the window right before a tick can be a plain",
  "    // HTTP request, and the reader is after the tick-sized one.",
  "    assert.equal(SUBREQ_RECENT_WINDOWS, 2);",
  "  });",
  "",
  '  await test("subreqs: calls accumulate into the open window", async () => {',
  "    resetSubreqWindows();",
  "    beginSubreqWindow(1_000);",
  "    let view = subreqView();",
  "    assert.equal(view.current.at, 1_000);",
  "    assert.equal(view.current.total, 0);",
  "    assert.deepEqual(view.recent, []);",
  "    assert.equal(view.windows, 1);",
  "    countSubreq();",
  "    countSubreq();",
  "    countSubreq();",
  "    view = subreqView();",
  "    assert.equal(view.current.total, 3);",
  "    assert.equal(view.windows, 1, \"counting never opens a window\");",
  "  });",
  "",
  '  await test("subreqs: a phase point is the running total at that stamp", async () => {',
  "    resetSubreqWindows();",
  "    beginSubreqWindow(1_000);",
  "    countSubreq();",
  "    countSubreq();",
  "    markSubreqPhase(\"pool\", 1_250);",
  "    countSubreq();",
  "    markSubreqPhase(\"pairs\", 1_900);",
  "    const view = subreqView();",
  "    assert.deepEqual(view.current.phases, [",
  '      { phase: "pool", total: 2, ms: 250 },',
  '      { phase: "pairs", total: 3, ms: 900 },',
  "    ]);",
  "  });",
  "",
  '  await test("subreqs: the phase ring keeps the newest stamps, not the first", async () => {',
  "    resetSubreqWindows();",
  "    beginSubreqWindow(0);",
  "    for (let i = 0; i < SUBREQ_PHASE_RING + 2; i += 1) {",
  "      countSubreq();",
  '      markSubreqPhase("p" + i, i);',
  "    }",
  "    const phases = subreqView().current.phases;",
  "    assert.equal(phases.length, SUBREQ_PHASE_RING);",
  '    assert.equal(phases[0].phase, "p2", "the oldest two fell off");',
  '    assert.equal(phases[phases.length - 1].phase, "p9");',
  "  });",
  "",
  '  await test("subreqs: a finished window rolls into recent, newest first", async () => {',
  "    resetSubreqWindows();",
  "    beginSubreqWindow(1_000);",
  "    countSubreq();",
  "    beginSubreqWindow(2_000);",
  "    countSubreq();",
  "    countSubreq();",
  "    // An idle window (nothing counted, no phase) must not take a slot: HTTP",
  "    // requests that return before their first call are the common case.",
  "    beginSubreqWindow(3_000);",
  "    const view = subreqView();",
  "    assert.equal(view.windows, 3);",
  "    assert.equal(view.recent.length, 1);",
  "    assert.equal(view.recent[0].at, 2_000);",
  "    assert.equal(view.recent[0].total, 2);",
  "    // Capped at SUBREQ_RECENT_WINDOWS, newest first.",
  "    countSubreq();",
  "    beginSubreqWindow(4_000);",
  "    countSubreq();",
  "    beginSubreqWindow(5_000);",
  "    countSubreq();",
  "    beginSubreqWindow(6_000);",
  "    const capped = subreqView();",
  "    assert.equal(capped.recent.length, SUBREQ_RECENT_WINDOWS);",
  "    assert.equal(capped.recent[0].at, 5_000);",
  "    assert.equal(capped.recent[1].at, 4_000);",
  "  });",
  "",
  '  await test("subreqs: a window killed at the budget is read from the next one", async () => {',
  "    // The whole point: a tick killed by `Too many subrequests` publishes",
  "    // nothing, so its spend and its last phase have to survive the roll.",
  "    resetSubreqWindows();",
  "    beginSubreqWindow(10_000);",
  "    for (let i = 0; i < SUBREQ_BUDGET_FREE; i += 1) countSubreq();",
  '    markSubreqPhase("gate", 12_000);',
  "    beginSubreqWindow(20_000);",
  "    const killed = subreqView().recent[0];",
  "    assert.equal(killed.total, SUBREQ_BUDGET_FREE);",
  "    assert.equal(killed.at, 10_000);",
  '    assert.equal(killed.phases[killed.phases.length - 1].phase, "gate");',
  "    assert.equal(",
  "      killed.phases[killed.phases.length - 1].total,",
  "      SUBREQ_BUDGET_FREE,",
  '      "the last phase reports the total the window died with",',
  "    );",
  "  });",
  "",
);

const edits = [
  {
    name: "the subreqs import line",
    old: 'require("../dist/skipcapture.js");',
    next:
      'require("../dist/skipcapture.js");\n' +
      "const { beginSubreqWindow, countSubreq, markSubreqPhase, subreqView, resetSubreqWindows, SUBREQ_BUDGET_FREE, SUBREQ_PHASE_RING, SUBREQ_RECENT_WINDOWS } = require(\"../dist/subreqs.js\");",
  },
  {
    name: "the tests themselves",
    old: lines(
      '  console.log("\\n===== UNIT TESTS =====");',
      "  for (const line of results) console.log(line);",
    ),
    next:
      tests +
      lines(
        '  console.log("\\n===== UNIT TESTS =====");',
        "  for (const line of results) console.log(line);",
      ),
  },
];

let text = fs.readFileSync(T, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      test-unit: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS test-unit: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        test-unit: " + e.name);
}
fs.writeFileSync(T, text);
