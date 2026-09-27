#!/usr/bin/env node
/*
 * The owner tag (docs/patches/tick-front-2026-09-27.apply.js) showed what the
 * shared counter had been doing all along: `maybeRunScanIfStale` — the path the
 * uptime monitor drives once a minute — opened a subrequest window on EVERY
 * request, at its top, and only THEN ran the cadence check and the dedupe read
 * that usually make it return without scanning.
 *
 * Measured live 2026-09-27 03:56-03:57Z (first deploy with the tag): the scan
 * tick's own window read `[http] 38 {turso:26 …}` — a ping had ROLLED it
 * mid-scan and returned — and the `recent` ring held 3-subrequest ping windows
 * (`[http] 3 {turso:3}`) instead of a pass's rotation. src/subreqs.ts counts
 * other work inside the tick's window as an upper bound; opening a window first
 * and bailing out after inverts that: it wipes the tick's reading and hands its
 * remaining counts to a stranger.
 *
 * So the window opens only where a request COMMITS to scanning, while the
 * pre-scan slice measurement (preTickEntryAt + the step split) still starts at
 * the request's entry: the two jobs are split into markPreTickEntry (a stamp)
 * and beginSubreqWindow (a counter reset), which beginPreTick does together for
 * the paths whose window really is their own.
 *
 * Run: node docs/patches/http-window-clash-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
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

// 1. Lift the window reset out of the entry stamp. The comment block between
//    them moves to beginPreTick, which is what it describes.
const head = /function beginPreTick\(entryAt: number, owner: SubreqOwner = "unknown"\): void \{\n([\s\S]*?)\n  beginSubreqWindow\(entryAt, owner\);\n  preTickEntryAt = entryAt;\n/;
let windowComment = null;
if (head.test(src)) {
  src = src.replace(head, (_m, comment) => {
    windowComment = comment;
    return `/**
 * Start the PRE-SCAN SLICE at \`entryAt\`: the entry stamp the split is measured
 * from (see PreTickView), with the step split reset.
 *
 * WHY IT IS APART FROM beginPreTick (2026-09-27): a caller that only wants the
 * slice MEASURED must not reset this isolate's subrequest counter — the HTTP
 * fallback used to do exactly that on every request, including the uptime
 * monitor's /health ping, which then returned without scanning. The reset rolled
 * the scan tick's own window mid-scan: its remaining counts landed in a
 * stranger's window and, once windows carried owners, the tick's own reading
 * came back \`owner:"http"\` (live 03:56-03:57Z).
 */
function markPreTickEntry(entryAt: number): void {
  preTickEntryAt = entryAt;
`;
  });
  notes.push(" ✓ worker: the slice stamp is its own function — patched");
} else if (src.includes("function markPreTickEntry(entryAt: number): void {")) {
  notes.push(" = worker: the slice stamp is its own function — already applied");
} else {
  throw new Error("worker: beginPreTick's head did not match");
}

// 2. beginPreTick keeps doing both, for the callers whose window is their own.
swap(
  "worker: beginPreTick composes stamp + window",
  `  preTick = {
    at: entryAt,
    steps: { ...PRE_TICK_ZERO_STEPS },
    preStartMs: null,
    preRaceMs: null,
    raceMs: null,
  };
}`,
  `  preTick = {
    at: entryAt,
    steps: { ...PRE_TICK_ZERO_STEPS },
    preStartMs: null,
    preRaceMs: null,
    raceMs: null,
  };
}

/**
 * The seam the SCHEDULED handler and the HTTP fallback's scanning path enter:
 * the slice stamp, plus THIS invocation's subrequest window — the unit
 * Cloudflare limits to 50 per invocation (see src/subreqs.ts). Anything else
 * this isolate serves inside the same window (a webhook, a /debug probe) is
 * counted into it as an upper bound; the phase ring localizes the spend.
 */
function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {${windowComment === null ? "" : `\n${windowComment}`}
  beginSubreqWindow(entryAt, owner);
  markPreTickEntry(entryAt);
}`,
  'function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {\n  beginSubreqWindow(entryAt, owner);\n  markPreTickEntry(entryAt);',
);

// 3. The fallback stamps at entry...
swap(
  "worker: the fallback's early returns stop rolling the tick's window",
  `  // The HTTP fallback's own pre-scan slice: measured from here, because this
  // is where a request's work before the scan starts (see PreTickView).
  beginPreTick(now, "http");
  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;`,
  `  // The HTTP fallback's own pre-scan slice: measured from here, because this
  // is where a request's work before the scan starts (see PreTickView) — but
  // ONLY the stamp. The subrequest window is opened below, where this request
  // actually commits to scanning: opening it here (the pre-2026-09-27 shape)
  // reset the counter on every request, and this path is driven once a minute by
  // the uptime monitor, which then returned at the dedupe below — rolling the
  // scan tick's window mid-scan and handing the tick's remaining counts to a
  // window that never scanned.
  markPreTickEntry(now);
  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;`,
  "markPreTickEntry(now);\n  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;",
);

// 4. ...and opens its window where it commits.
swap(
  "worker: the fallback opens its window where it commits",
  `  try {
    await runScan(hbRaw, env);
  } catch (err) {
    console.error(
      "[worker] fallback scan failed:",
      err instanceof Error ? err.message : err,
    );
  }
}`,
  `  // COMMITTED (see markPreTickEntry above): this request is the scan's owner,
  // so the window it opens is a scan's window — and every path that returned
  // above left the open window alone.
  beginSubreqWindow(now, "http");
  try {
    await runScan(hbRaw, env);
  } catch (err) {
    console.error(
      "[worker] fallback scan failed:",
      err instanceof Error ? err.message : err,
    );
  }
}`,
  'beginSubreqWindow(now, "http");\n  try {\n    await runScan(hbRaw, env);',
);

// 5. Pin the shape (a source pin, like the file's other wiring pins).
const tests = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let testSrc = fs.readFileSync(tests, "utf8");
if (testSrc.includes("the fallback opens its window only where it commits")) {
  notes.push(" = tests: the fallback's window shape — already applied");
} else {
  const find = `  await test("subreqs: a window names which invocation opened it (two owners share one isolate)", () => {`;
  const count = testSrc.split(find).length - 1;
  if (count !== 1) throw new Error(`tests anchor matched ${count} times (want exactly 1)`);
  const pin = `  await test("subreqs: the fallback opens its window only where it commits (a ping that bails out must not roll the tick's)", () => {
    // Live 2026-09-27 03:56-03:57Z, first deploy with the owner tag: the scan
    // tick's own window read [http] 38 — the uptime monitor's /health ping had
    // opened a window at maybeRunScanIfStale's top and then returned at the
    // dedupe, rolling the tick's reading mid-scan and leaving 3-subrequest ping
    // windows in the recent ring instead of a pass's rotation. The window has to
    // open where the request COMMITS, so the pin is an ORDER: the entry stamp
    // first, the window reset only after the returns.
    const src = fs
      .readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8")
      .replace(/\\s+/g, "");
    const from = src.indexOf("asyncfunctionmaybeRunScanIfStale(");
    const to = src.indexOf("exportdefault{", from);
    assert.ok(from >= 0 && to > from, "the fallback path must exist");
    const fallback = src.slice(from, to);
    const stamp = fallback.indexOf("markPreTickEntry(now);");
    const cadence = fallback.indexOf("if(now-lastScanTriggerAt<SCAN_TRIGGER_INTERVAL_MS)return;");
    const dedupe = fallback.indexOf('if(typeofat==="number"&&now-at<SCAN_TRIGGER_INTERVAL_MS)return;');
    const open = fallback.indexOf('beginSubreqWindow(now,"http");');
    assert.ok(stamp >= 0 && cadence > stamp, "the request's pre-scan slice is still measured from its entry");
    assert.ok(dedupe > cadence, "both early returns come first");
    assert.ok(open > dedupe, "the window opens only after them, i.e. only when this request really scans");
    assert.ok(
      src.includes('functionbeginPreTick(entryAt:number,owner:SubreqOwner="unknown"):void{beginSubreqWindow(entryAt,owner);markPreTickEntry(entryAt);}'),
      "the scheduled seam keeps the pair together",
    );
  });

`;
  testSrc = testSrc.replace(find, pin + find);
  fs.writeFileSync(tests, testSrc);
  notes.push(" ✓ tests: the fallback's window shape — patched");
}

if (src !== before) fs.writeFileSync(file, src);
for (const line of notes) console.log(line);
