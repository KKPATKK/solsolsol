// Verify-then-write: tick-level skip reasons (src/skipcapture.ts).
const fs = require("fs");

const FILE = "src/skipcapture.ts";
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

// (A) The header names the second class of reasons.
patch(
  "header: tick-level reasons",
  ` * 2026-09-19 every scan_history row and both heartbeats carried \`skip: null\` —
 * including the ticks where the sweep had in fact stopped dead (60-100% of
 * ticks per 10 minutes had profiles=0/pool=0), so the only trace was a shape.
`,
  ` * 2026-09-19 every scan_history row and both heartbeats carried \`skip: null\` —
 * including the ticks where the sweep had in fact stopped dead (60-100% of
 * ticks per 10 minutes had profiles=0/pool=0), so the only trace was a shape.
 *
 * TICK-LEVEL REASONS (2026-09-27, see noteSkipReason): the scanner is not the
 * only layer that can return without scanning. The scheduled handler records
 * the arrival, checks its cadence gate and returns; runScan refuses to start
 * with no scanner; the cross-isolate lease can be lost. Every one of those is
 * a tick that ARRIVED and did nothing, and none of them reached lastSkip — so
 * a 2-minute cadence (measured that day: 07:39-08:11, every other cron tick
 * with no scan, no counter moved anywhere) read as if the arrivals had never
 * happened. Those paths now record here, through the same counters, snapshot
 * and durable row, so "why did this tick do nothing" has one answer wherever
 * the tick stopped.
`,
);

// (B) installSkipCapture: a re-created scanner must not drop the tick-level
// reasons recorded before it existed.
patch(
  "install preserves the capture",
  `  clock = now;
  const capture: InstalledCapture = { reason: null, at: null, total: 0, counts: {} };
  installed = capture;
  // A re-created scanner restarts the isolate interval, so the persist baseline
  // must follow it — otherwise every delta would be negative and silent.
  synced = { total: 0, counts: {} };`,
  `  clock = now;
  // PRESERVED, not re-created (2026-09-27): a tick-level reason can be recorded
  // in an isolate that has not built a scanner yet (the \`init-no-scanner\` path
  // IS that case — the handler records why it returned before any scanner
  // exists), and the next tick's install is exactly what would have thrown the
  // reason away. The counters and the persist baseline therefore both survive
  // an install: the baseline already tracks what landed in the durable row, so
  // keeping it cannot re-offer a persisted count (the reason the reset existed
  // — a fresh capture against an old baseline going silently negative — only
  // applied while the capture was re-created here).
  const capture: InstalledCapture =
    installed ?? { reason: null, at: null, total: 0, counts: {} };
  installed = capture;`,
);

// (C) The API itself.
patch(
  "noteSkipReason",
  `/** Newest reason this isolate recorded, or null when it never recorded one. */
export function skipCaptureSnapshot(): SkipCaptureView | null {`,
  `/**
 * Record a reason the SCANNER never saw (see the header's tick-level note).
 *
 * Same counters, same snapshot, same durable row as the interceptor's reasons —
 * one list, because the reader's question is the same ("why did this tick do
 * nothing") whichever layer stopped the tick. The reason string is the layer's
 * own, so the counts stay separable.
 *
 * Lazy capture: the paths that call this include the one where no scanner could
 * be built, so there is nothing to install onto yet. A later install PRESERVES
 * what was recorded here (see installSkipCapture).
 *
 * Costs nothing on the tick that records it: the delta rides the next
 * completion's tail write, the same one read + one write the scanner's own
 * reasons already use.
 */
export function noteSkipReason(reason: string): void {
  if (typeof reason !== "string" || reason.length === 0) return;
  const capture: InstalledCapture =
    installed ?? (installed = { reason: null, at: null, total: 0, counts: {} });
  capture.reason = reason;
  capture.at = clock();
  capture.total += 1;
  capture.counts[reason] = (capture.counts[reason] ?? 0) + 1;
}

/** Newest reason this isolate recorded, or null when it never recorded one. */
export function skipCaptureSnapshot(): SkipCaptureView | null {`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
