// Verify-then-write: tests for the tick-level skip reasons (scripts/test-unit.js).
const fs = require("fs");

const FILE = "scripts/test-unit.js";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

// The import line has to carry the new API for the test to call it.
patch(
  "test import",
  `const { installSkipCapture, skipCaptureSnapshot, takeSkipCaptureDelta, markSkipCaptureSynced, emptySkipCaptureState, mergeSkipCaptureState, parseSkipCaptureState, pruneSkipCounts, resetSkipCapture, SKIP_CAPTURE_MAX_REASONS } = require("../dist/skipcapture.js");`,
  `const { installSkipCapture, noteSkipReason, skipCaptureSnapshot, takeSkipCaptureDelta, markSkipCaptureSynced, emptySkipCaptureState, mergeSkipCaptureState, parseSkipCaptureState, pruneSkipCounts, resetSkipCapture, SKIP_CAPTURE_MAX_REASONS } = require("../dist/skipcapture.js");`,
);

const anchor = `  await test("skipCapture: the nulling write is not counted as a skip", () => {`;

const body = `  await test("skipCapture: a tick-level reason survives the install its own path precedes", () => {
    // WHY (2026-09-27): the scanner is not the only layer that returns without
    // scanning. The handler's \`!scanner\` return and the gate skip are the two
    // that produced NO trace at all — measured live, 07:39-08:11 had a
    // 2-minute cadence with every counter flat, so half the arrivals looked as
    // if they had never been delivered. Both now record here, and the harder
    // half is the \`!scanner\` one: it fires in an isolate that has not built a
    // scanner, so the reason is recorded with nothing installed — and the next
    // tick's install is exactly what would have thrown it away.
    resetSkipCapture();
    noteSkipReason("init-no-scanner");
    assert.equal(skipCaptureSnapshot().reason, "init-no-scanner");
    assert.equal(skipCaptureSnapshot().total, 1, "recorded with no scanner in existence");
    const scanner = { lastSkip: null };
    installSkipCapture(scanner, () => 7);
    assert.equal(
      skipCaptureSnapshot().reason,
      "init-no-scanner",
      "the install preserves what the tick recorded before it",
    );
    assert.equal(takeSkipCaptureDelta().total, 1, "and the reason is still owed to the durable row");
    // A scanner reason joins the same counters, and the two layers stay
    // separable by name.
    scanner.lastSkip = "previous-scan-still-running";
    const delta = takeSkipCaptureDelta();
    assert.equal(delta.total, 2);
    assert.deepEqual(delta.counts, {
      "init-no-scanner": 1,
      "previous-scan-still-running": 1,
    });
    markSkipCaptureSynced();
    assert.equal(takeSkipCaptureDelta(), null, "a landed write clears it");
    // A rebuilt scanner re-offers nothing it already persisted…
    installSkipCapture(scanner, () => 8);
    assert.equal(takeSkipCaptureDelta(), null);
    // …and still reports what comes after it.
    noteSkipReason("cron-gate");
    assert.equal(takeSkipCaptureDelta().total, 1);
    assert.equal(takeSkipCaptureDelta().counts["cron-gate"], 1);
    // A blank reason is not a reason.
    noteSkipReason("");
    assert.equal(takeSkipCaptureDelta().total, 1, "empty input is ignored");
    // The durable merge treats it as one more key.
    const merged = mergeSkipCaptureState(
      emptySkipCaptureState(),
      { total: 1, counts: { "cron-gate": 1 }, reason: "cron-gate", at: 8 },
      8,
    );
    assert.equal(merged.lastReason, "cron-gate");
    assert.equal(merged.counts["cron-gate"], 1);
  });

  await test("skipCapture: every layer that can return without scanning records why", () => {
    // Whitespace-only squash, regex-free (same discipline as the prune pins).
    const WS = new Set([9, 10, 13, 32]);
    const strip = (text) => [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");
    const workerSrc = strip(fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8"));
    // The scheduled handler's no-scanner return: reason, then the arrival
    // bookkeeping that was the ONLY thing it did before this round.
    assert.ok(
      workerSrc.includes(
        'if(!scanner){noteSkipReason("init-no-scanner");preTick.steps.bump=awaitbumpScheduledTickLegacy(env);',
      ),
      "the handler's no-scanner return says so",
    );
    // The cadence gate: the reason sits with the log line it already printed.
    assert.ok(
      workerSrc.includes('s)\`);noteSkipReason("cron-gate");'),
      "the gate skip says so",
    );
    // runScan's own guard (the HTTP/manual path).
    assert.ok(
      workerSrc.includes('via:ScanTrigger="cron",):Promise<void>{if(!scanner){noteSkipReason("init-no-scanner");return;}'),
      "runScan's guard says so",
    );
    // The lost cross-isolate lease, right after the log that was its only trace.
    assert.ok(
      workerSrc.includes('holdsthescanlock");noteSkipReason("scan-lock-lost");'),
      "a lost lease says so",
    );
    // The capture itself: the install must keep an existing capture instead of
    // replacing it (that replacement is what dropped the tick-level reason).
    const skipSrc = strip(fs.readFileSync(path.join(__dirname, "..", "src", "skipcapture.ts"), "utf8"));
    assert.ok(
      skipSrc.includes("constcapture:InstalledCapture=installed??{reason:null,at:null,total:0,counts:{}};"),
      "install preserves the capture",
    );
    assert.ok(
      skipSrc.includes("exportfunctionnoteSkipReason(reason:string):void{"),
      "the tick-level API is exported",
    );
  });

`;

patch("skip-reason tests", anchor, body + anchor);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
