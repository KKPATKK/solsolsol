// Verify-then-write: the worker records why a tick did nothing (src/worker.ts).
const fs = require("fs");

const FILE = "src/worker.ts";
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

// (A) Import.
patch(
  "import noteSkipReason",
  `import {
  SKIP_CAPTURE_STATE_KEY,
  emptySkipCaptureState,
  installSkipCapture,
  markSkipCaptureSynced,
  mergeSkipCaptureState,
  parseSkipCaptureState,
  skipCaptureSnapshot,`,
  `import {
  SKIP_CAPTURE_STATE_KEY,
  emptySkipCaptureState,
  installSkipCapture,
  markSkipCaptureSynced,
  mergeSkipCaptureState,
  noteSkipReason,
  parseSkipCaptureState,
  skipCaptureSnapshot,`,
);

// (B) The scheduled handler's no-scanner return: the arrival is recorded, the
// tick does nothing, and until now NOTHING said why (this is the path a
// timed-out init takes — see the comment above it).
patch(
  "handler: init-no-scanner",
  `    if (!scanner) {
      preTick.steps.bump = await bumpScheduledTickLegacy(env);
      scheduledTickFinishedAt = Date.now();
      return;
    }`,
  `    if (!scanner) {
      // WHY THIS TICK DID NOTHING (2026-09-27): the arrival above is recorded,
      // the scan below never starts, and before this line no counter, no
      // heartbeat field and no log said so — a 2-minute cadence then read as if
      // half the arrivals had never been delivered (measured 07:39-08:11 that
      // day). The reason rides the next completion's tail write (see
      // src/skipcapture.ts).
      noteSkipReason("init-no-scanner");
      preTick.steps.bump = await bumpScheduledTickLegacy(env);
      scheduledTickFinishedAt = Date.now();
      return;
    }`,
);

// (C) The cadence gate's skip.
patch(
  "handler: cron-gate",
  `      if (hbAt !== null && Date.now() - hbAt < gateMs) {
        console.log(
          \`[worker] cron tick skipped — last scan claimed \${Math.round((Date.now() - hbAt) / 1000)}s ago (< \${Math.round(gateMs / 1000)}s)\`,
        );`,
  `      if (hbAt !== null && Date.now() - hbAt < gateMs) {
        console.log(
          \`[worker] cron tick skipped — last scan claimed \${Math.round((Date.now() - hbAt) / 1000)}s ago (< \${Math.round(gateMs / 1000)}s)\`,
        );
        // Counted like every other early return (2026-09-27): in the 60s mode
        // this is rare and should read ~0, while in a 90s/120s deployment it is
        // the cadence knob WORKING — either way "how often does the gate skip"
        // belongs in the same reading as the scanner's own reasons.
        noteSkipReason("cron-gate");`,
);

// (D) runScan's own no-scanner guard (the HTTP/manual path).
patch(
  "runScan: init-no-scanner",
  `  via: ScanTrigger = "cron",
): Promise<void> {
  if (!scanner) return;`,
  `  via: ScanTrigger = "cron",
): Promise<void> {
  if (!scanner) {
    // Same silence as the handler's guard above, on the HTTP path: an
    // invocation that meant to scan (a rescue, a manual tick) and could not,
    // with nothing durable to show for it.
    noteSkipReason("init-no-scanner");
    return;
  }`,
);

// (E) The lost cross-isolate lease. It already counts in
// `crossIsolateScanSkips`; the REASON now joins the shared reading so a
// lease that keeps being lost is distinguishable from a tick that never got
// as far as the claim.
patch(
  "lease lost: scan-lock-lost",
  `    console.log("[worker] scan skipped — another isolate holds the scan lock");`,
  `    console.log("[worker] scan skipped — another isolate holds the scan lock");
    // The counter above is module state on THIS isolate and is only published by
    // whichever invocation happens to serve /health; the reason rides the
    // durable row with every other one (2026-09-27).
    noteSkipReason("scan-lock-lost");`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
