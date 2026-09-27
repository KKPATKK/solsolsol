#!/usr/bin/env node
/*
 * Follow-up to docs/patches/http-window-clash-2026-09-27.apply.js: the split
 * left TWO comment blocks on beginPreTick, and the older one still claimed that
 * "both handlers (cron and the HTTP fallback) enter through this seam" — no
 * longer true, and exactly the sentence that would send the next reader back
 * down the path this change closed.
 *
 * Run: node docs/patches/http-window-clash-comment-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
const src = fs.readFileSync(file, "utf8");

const find = `/**
 * The seam the SCHEDULED handler and the HTTP fallback's scanning path enter:
 * the slice stamp, plus THIS invocation's subrequest window — the unit
 * Cloudflare limits to 50 per invocation (see src/subreqs.ts). Anything else
 * this isolate serves inside the same window (a webhook, a /debug probe) is
 * counted into it as an upper bound; the phase ring localizes the spend.
 */
function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {
  // The subrequest window opens here, with the pre-scan split: both
  // handlers (cron and the HTTP fallback) enter through this seam, so a
  // window is one scan attempt's spend — the unit Cloudflare limits to 50
  // per invocation (see src/subreqs.ts). Anything else this isolate serves
  // inside the same window (a webhook, a /debug probe) is counted too, so
  // the reading is an upper bound on the tick; the phase ring is what
  // localizes it.
  //
  // The OWNER rides along (2026-09-27): the pass's own cron delivery is a
  // separate invocation that lands on this same isolate most minutes, so
  // without it a scan front and a pass rotation are one indistinguishable
  // \`turso: N\` — and every question about the front's cost is unanswerable.
  beginSubreqWindow(entryAt, owner);
  markPreTickEntry(entryAt);
}`;

const replace = `/**
 * The seam for the paths whose window IS their own: the slice stamp PLUS the
 * subrequest window — the unit Cloudflare limits to 50 per invocation (see
 * src/subreqs.ts). Anything else this isolate serves inside the same window (a
 * webhook, a /debug probe) is counted into it as an upper bound, and the phase
 * ring localizes the spend.
 *
 * The HTTP fallback does NOT enter here: it stamps with markPreTickEntry at the
 * request's entry and opens its window only where it commits to scanning, so a
 * ping that then returns cannot roll the scan tick's window mid-scan (see
 * markPreTickEntry, measured 2026-09-27 03:56-03:57Z).
 *
 * The OWNER rides along (2026-09-27): the pass's own cron delivery is a
 * separate invocation that lands on this same isolate most minutes, so without
 * it a scan front and a pass rotation are one indistinguishable \`turso: N\` —
 * and every question about the front's cost is unanswerable.
 */
function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {
  beginSubreqWindow(entryAt, owner);
  markPreTickEntry(entryAt);
}`;

if (!src.includes(find)) {
  console.log(" = already applied");
  process.exit(0);
}
fs.writeFileSync(file, src.replace(find, replace));
if (!fs.readFileSync(file, "utf8").includes("The HTTP fallback does NOT enter here")) {
  throw new Error("the write did not verify");
}
console.log(" ✓ worker: one accurate comment on beginPreTick — patched");
