#!/usr/bin/env node
/*
 * Tests for docs/patches/tick-front-2026-09-27.apply.js:
 *  - the reserve pin follows the call (the slice is asked for through the
 *    call site's own `scanOwner` capture now);
 *  - a subrequest window names the invocation that opened it;
 *  - Scanner.trackerPassSlice releases the slice only when the pass will
 *    stand down, asked at the moment the pass stage would ask.
 *
 * Run: node docs/patches/tick-front-tests-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");
const before = src;
const notes = [];

function swap(name, find, replace, marker) {
  if (src.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  src = src.replace(find, replace);
  notes.push(` ✓ ${name} — patched`);
}

swap(
  "tests: the reserve pin follows the call through the scanOwner capture",
  '        "scanner.runOnce(()=>scanSubreqLeft(subreqRemaining(),scanner.trackerPassSlice(TRACKER_PASS_FALLBACK_FRESH_MS,TRACKER_PASS_SUBREQ_RESERVE,startedAt+SCAN_TICK_BUDGET_MS,),),)",',
  '        "scanOwner.runOnce(()=>scanSubreqLeft(subreqRemaining(),scanOwner.trackerPassSlice(TRACKER_PASS_FALLBACK_FRESH_MS,TRACKER_PASS_SUBREQ_RESERVE,startedAt+SCAN_TICK_BUDGET_MS,),),)",',
  'scanOwner.runOnce(()=>scanSubreqLeft(subreqRemaining(),scanOwner.trackerPassSlice(',
);

swap(
  "tests: the owned window and the conditional slice get their own tests",
  `  console.log("\\n===== UNIT TESTS =====");`,
  `  await test("subreqs: a window names which invocation opened it (two owners share one isolate)", () => {
    const { beginSubreqWindow, countSubreq, subreqView, resetSubreqWindows } =
      require("../dist/subreqs.js");
    resetSubreqWindows();
    // The scan tick opens one...
    beginSubreqWindow(1_000, "scan");
    countSubreq("https://x.turso.io");
    assert.equal(subreqView().current.owner, "scan");
    // ...and the pass's own cron delivery lands on the SAME isolate, rolling
    // the scan's window in behind it. Without the tag the two are one
    // indistinguishable reading — which is what made "what did the tick front
    // spend?" unanswerable while both owners shared this counter.
    beginSubreqWindow(2_000, "pass");
    countSubreq("https://api.telegram.org");
    const view = subreqView();
    assert.equal(view.current.owner, "pass", "the newest window says who opened it");
    assert.equal(view.current.total, 1);
    assert.equal(view.recent[0].owner, "scan", "and so does the rolled one");
    assert.equal(view.recent[0].total, 1);
    // A caller that does not say is not guessed at.
    beginSubreqWindow(3_000);
    assert.equal(subreqView().current.owner, "unknown");
    resetSubreqWindows();
    assert.equal(subreqView().current.owner, "unknown");
  });

  await test("Scanner.trackerPassSlice: the slice is released only when the pass WILL stand down", () => {
    const { Scanner } = require("../dist/scanner.js");
    const cfg = loadConfig({});
    const scanner = new Scanner(
      {}, { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,
    );
    const now = Date.now();
    const WINDOW = 120_000;
    const SLICE = 12;
    // No front read this tick (a standalone scanner, or a front read that
    // failed): FAIL SAFE — the slice stays, because a pass might still run.
    assert.equal(scanner.peerPassRow, null);
    assert.equal(scanner.trackerPassSlice(WINDOW, SLICE, now), SLICE);
    // The pass's own delivery wrote the row 40s ago: it owns this minute.
    scanner.peerPassRow = JSON.stringify({
      at: now - 40_000,
      phase: "done",
      via: "cron-pass",
    });
    assert.equal(scanner.trackerPassSlice(WINDOW, SLICE, now), 0);
    // ...but the tick asks about the END of its envelope, and a row that will
    // be stale by then is one its pass stage will NOT stand down for — so the
    // slice stays. That difference is what keeps the scan's release and the
    // pass's decision from disagreeing about a row crossing the window in
    // between.
    assert.equal(
      scanner.trackerPassSlice(WINDOW, SLICE, now + 200_000),
      SLICE,
      "asked at the pass stage's own arrival, the same row reserves again",
    );
    // A skipped row is not an owner: the tick that ran no pass wrote it, and
    // counting it would hold the slice for a card nobody announced.
    scanner.peerPassRow = JSON.stringify({ at: now - 5_000, phase: "skip", via: "tick" });
    assert.equal(scanner.trackerPassSlice(WINDOW, SLICE, now), SLICE);
    // No window at all (the pass's own delivery, every pre-split caller): the
    // slice is moot and the answer is the old, unconditional one.
    assert.equal(scanner.trackerPassSlice(0, SLICE, now), SLICE);
  });

  console.log("\\n===== UNIT TESTS =====");`,
  "Scanner.trackerPassSlice: the slice is released only when the pass WILL stand down",
);

if (src !== before) fs.writeFileSync(file, src);
for (const line of notes) console.log(line);
