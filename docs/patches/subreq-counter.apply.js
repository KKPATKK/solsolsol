#!/usr/bin/env node
/**
 * Publish the per-invocation subrequest counter (src/subreqs.ts).
 *
 * src/worker.ts is ~200KB, far past the file tools' edit window, so the deep
 * edits ride the same patch discipline as every earlier one: each replacement
 * must match EXACTLY once or nothing is written (exit 1), and the result is
 * verified afterwards with `git diff` + tsc + the three suites — never by the
 * script's own word.
 *
 * WHAT IS WIRED, AND WHY EACH SITE
 *  - beginPreTick opens the window: both tick handlers (cron and the HTTP
 *    fallback) enter through it, so one window is one scan attempt's spend.
 *  - the CLAIM heartbeat (`phase: "scanning"`) and the COMPLETION heartbeat
 *    (`phase: "done"`) both carry the reading. The completion one is the
 *    interesting one: it carries the tick's own total plus the `recent` ring,
 *    and the ring is where a tick that died on the budget is readable from the
 *    next tick (the one that backfills its history row).
 */
const fs = require("fs");

const W = "src/worker.ts";

const lines = (...xs) => xs.join("\n");

const edits = [
  {
    name: "beginPreTick opens the subrequest window",
    old: lines(
      "function beginPreTick(entryAt: number): void {",
      "  preTickEntryAt = entryAt;",
    ),
    next: lines(
      "function beginPreTick(entryAt: number): void {",
      "  // The subrequest window opens here, with the pre-scan split: both",
      "  // handlers (cron and the HTTP fallback) enter through this seam, so a",
      "  // window is one scan attempt's spend — the unit Cloudflare limits to 50",
      "  // per invocation (see src/subreqs.ts). Anything else this isolate serves",
      "  // inside the same window (a webhook, a /debug probe) is counted too, so",
      "  // the reading is an upper bound on the tick; the phase ring is what",
      "  // localizes it.",
      "  beginSubreqWindow(entryAt);",
      "  preTickEntryAt = entryAt;",
    ),
  },
  {
    name: "the claim heartbeat carries the counter",
    old: lines(
      "    err: null,",
      "    skip: startSkip?.reason ?? null,",
      "    skipAt: startSkip?.at ?? null,",
    ),
    next: lines(
      "    err: null,",
      "    skip: startSkip?.reason ?? null,",
      "    skipAt: startSkip?.at ?? null,",
      "    // Subrequests counted so far in this invocation (see src/subreqs.ts).",
      "    // At claim time this is the pre-scan front (init + gate + claim), which",
      "    // is exactly the slice the tick's OWN budget measurement excludes.",
      "    subreqs: subreqView(),",
    ),
  },
  {
    name: "the completion heartbeat carries the counter",
    old: lines(
      "            // Fleet-wide early-return counters (durable row).",
      "            skipCapture: skipCaptureMirror,",
    ),
    next: lines(
      "            // Fleet-wide early-return counters (durable row).",
      "            skipCapture: skipCaptureMirror,",
      "            // The invocation's subrequest reading (see src/subreqs.ts):",
      "            // `current` is this tick's spend with the phase ring that says",
      "            // WHERE it went, and `recent` is the window before it — which",
      "            // is how a tick that died on the budget is read, since a killed",
      "            // invocation never gets to publish anything itself.",
      "            subreqs: subreqView(),",
    ),
  },
];

let text = fs.readFileSync(W, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      worker: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS worker: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        worker: " + e.name);
}
fs.writeFileSync(W, text);
