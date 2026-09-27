#!/usr/bin/env node
/*
 * Two follow-ups to docs/patches/tracker-own-invocation-2026-09-27.apply.js:
 *
 * 1. THE TRACKER SLICE IS CONDITIONAL. `scanSubreqLeft` took the pass's slice
 *    off the scan's allowance unconditionally, which was right while the tick
 *    WAS the pass's owner: the slice existed for a pass this invocation might
 *    run. Now the pass has its own cron delivery and the tick stands down for
 *    it (live 2026-09-27 03:11-03:25Z: every durable pass row reads
 *    `via:"cron-pass"`, zero `via:"tick"` while ticks keep scanning), so on the
 *    healthy shape the scan was still holding 12 of its 38 usable subrequests
 *    for a pass that would not run — its optional legs stood down at
 *    `spent >= usable - 2 x SCAN_SUBREQ_FLOOR` (~14) instead of ~26. The slice
 *    is now ASKED FOR, using the same front row and the same window the pass
 *    stage itself reads (Scanner.peerPassAgeMs), and the question is asked at
 *    `startedAt + SCAN_TICK_BUDGET_MS` — the last moment this invocation could
 *    still start a pass — so "the delivery owns this minute" is an answer the
 *    pass stage is bound to reach too, and the two decisions cannot disagree.
 *
 * 2. THE TICK FRONT'S READS ARE NAMED. Two invocations now share one isolate
 *    (the scan tick and the pass's own delivery land on the same one most
 *    minutes), and the subrequest counter is per-module — so a window that did
 *    not say who opened it could not be attributed: a scan front and a pass
 *    rotation both read as one `turso: N`. `beginSubreqWindow` takes an owner
 *    ("scan" / "pass" / "http") and the published view carries it.
 *
 * 3. THE COLD-INIT BOOT READ RIDES THE FRONT'S ONE STATEMENT. `WEDGE_READ_KEYS`
 *    is already a single `getWorkerStates` on every cold isolate; the init
 *    boot's four rows were a SECOND one ~300ms later in the same invocation
 *    (measured: the front's `getWorkerStates` was 5 calls / 616ms per tick).
 *    They are now keys in that same statement, read back from it through a
 *    same-invocation cache (HEARTBEAT_REUSE_MS), with the original read kept as
 *    the fallback for a front read that timed out.
 *
 * Run: node docs/patches/tick-front-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const EDITS = [];
function edit(name, file, find, replace, verify) {
  EDITS.push({ name, file, find, replace, verify });
}

const WORKER = "src/worker.ts";
const SCANNER = "src/scanner.ts";
const SUBREQS = "src/subreqs.ts";
const TESTS = "scripts/test-unit.js";

// --------------------------------------------------------------- subreqs.ts

edit(
  "subreqs: a window says which invocation opened it",
  SUBREQS,
  `/** One invocation's counter state. */
export interface SubreqWindowView {
  /** Window entry (epoch ms) — the tick's start, not its end. */
  at: number;`,
  `/**
 * WHO opened a window (see beginSubreqWindow).
 *
 * WHY IT IS NEEDED (2026-09-27): since the tracker pass got its own cron
 * delivery, TWO invocations share most isolates — Cloudflare dispatches both
 * triggers at the same minute, and the isolate that served the scan tick is
 * the one the pass's delivery lands on — while this counter is per MODULE, not
 * per invocation. A window therefore mixes the two: a scan front and a pass
 * rotation both read as one \`turso: N\`, and the reader cannot say which owner
 * to fix. Tagging the window is what makes "the tick's front spent X" a
 * question with an answer.
 *
 * "unknown" is the honest default: an isolate's first request, a probe, or any
 * caller that does not say. Nothing is guessed.
 */
export type SubreqOwner = "scan" | "pass" | "http" | "unknown";

/** One invocation's counter state. */
export interface SubreqWindowView {
  /** Window entry (epoch ms) — the tick's start, not its end. */
  at: number;
  /** Which invocation opened it (see SubreqOwner). */
  owner: SubreqOwner;`,
  (src) => src.includes('export type SubreqOwner = "scan" | "pass" | "http" | "unknown";'),
);

edit(
  "subreqs: the state and the roll carry the owner",
  SUBREQS,
  `/** Internally the host split is a map; the view flattens it to sorted rows. */
interface SubreqWindowState {
  at: number;
  total: number;
  phases: SubreqPhasePoint[];
  hosts: Map<string, number>;
}

/** The window being spent, and the finished ones behind it (newest first). */
let current: SubreqWindowState = { at: 0, total: 0, phases: [], hosts: new Map() };`,
  `/** Internally the host split is a map; the view flattens it to sorted rows. */
interface SubreqWindowState {
  at: number;
  owner: SubreqOwner;
  total: number;
  phases: SubreqPhasePoint[];
  hosts: Map<string, number>;
}

/** The window being spent, and the finished ones behind it (newest first). */
let current: SubreqWindowState = {
  at: 0,
  owner: "unknown",
  total: 0,
  phases: [],
  hosts: new Map(),
};`,
  (src) => src.includes('let current: SubreqWindowState = {\n  at: 0,\n  owner: "unknown",'),
);

edit(
  "subreqs: beginSubreqWindow takes the owner, and the view publishes it",
  SUBREQS,
  `export function beginSubreqWindow(at = Date.now()): void {
  // A window that never counted anything (a module load, a route that returned
  // before its first call) is not worth a slot in the ring.
  if (current.total > 0 || current.phases.length > 0) {
    recent = [current, ...recent].slice(0, SUBREQ_RECENT_WINDOWS);
  }
  current = { at, total: 0, phases: [], hosts: new Map() };
  windows += 1;
}`,
  `export function beginSubreqWindow(
  at = Date.now(),
  owner: SubreqOwner = "unknown",
): void {
  // A window that never counted anything (a module load, a route that returned
  // before its first call) is not worth a slot in the ring.
  if (current.total > 0 || current.phases.length > 0) {
    recent = [current, ...recent].slice(0, SUBREQ_RECENT_WINDOWS);
  }
  current = { at, owner, total: 0, phases: [], hosts: new Map() };
  windows += 1;
}`,
  (src) => src.includes("  current = { at, owner, total: 0, phases: [], hosts: new Map() };"),
);

edit(
  "subreqs: the flattened view carries the owner too",
  SUBREQS,
  `  const flat = (w: SubreqWindowState): SubreqWindowView => ({
    at: w.at,
    total: w.total,`,
  `  const flat = (w: SubreqWindowState): SubreqWindowView => ({
    at: w.at,
    owner: w.owner,
    total: w.total,`,
  (src) => src.includes("    owner: w.owner,\n    total: w.total,"),
);

edit(
  "subreqs: the test seam resets to an unknown window",
  SUBREQS,
  `export function resetSubreqWindows(): void {
  current = { at: 0, total: 0, phases: [], hosts: new Map() };`,
  `export function resetSubreqWindows(): void {
  current = { at: 0, owner: "unknown", total: 0, phases: [], hosts: new Map() };`,
  (src) => src.includes('current = { at: 0, owner: "unknown", total: 0, phases: [], hosts: new Map() };\n  recent = [];'),
);

// ---------------------------------------------------------------- worker.ts

edit(
  "worker: the subreq owner type comes in from subreqs",
  WORKER,
  `import {
  beginSubreqWindow,
  countSubreq,
  subreqRemaining,
  subreqView,
} from "./subreqs";`,
  `import {
  beginSubreqWindow,
  countSubreq,
  subreqRemaining,
  subreqView,
  type SubreqOwner,
} from "./subreqs";`,
  (src) => src.includes('  type SubreqOwner,\n} from "./subreqs";'),
);

edit(
  "worker: scanSubreqLeft takes the slice as a parameter",
  WORKER,
  `export function scanSubreqLeft(remaining: number): number {
  return remaining - TRACKER_PASS_SUBREQ_RESERVE;
}`,
  `export function scanSubreqLeft(
  remaining: number,
  /**
   * The slice to hold back, defaulting to the pass's full one. It is a
   * PARAMETER because the reservation is conditional since 2026-09-27: a tick
   * whose own pass stage will stand down for the pass's own cron delivery
   * (see Scanner.trackerPassSlice) hands the scan the whole allowance — the
   * slice exists for a pass THIS invocation might run, and a tick that runs
   * none would be holding subrequests it can never spend while its optional
   * legs stand down ~12 early.
   */
  reserve: number = TRACKER_PASS_SUBREQ_RESERVE,
): number {
  return remaining - reserve;
}`,
  (src) => src.includes("  reserve: number = TRACKER_PASS_SUBREQ_RESERVE,\n): number {"),
);

edit(
  "worker: the front carries the boot rows, and caches the map for init",
  WORKER,
  `export const WEDGE_READ_KEYS = [
  "scan_heartbeat",
  "scheduled_tick_total",
  "scheduled_tick_ring",
  TICK_PROGRESS_KEY,
  // Round 4: the tick prefetch's row (TradeService.primeModeOverride).
  "trade_mode_override",
];`,
  `/**
 * The rows the cold-init boot block needs (see ensureInitialized's
 * initPromise): the stored Axiom token, and the three telemetry mirrors a
 * recycled isolate answers /health with before it has any numbers of its own.
 *
 * Named as its own list because they ride the FRONT's statement (below) and
 * the boot block's own read is now only the fallback — one list, so the two
 * cannot drift.
 */
export const BOOT_STATE_KEYS = [
  "axiom_access_token",
  PUSH_DEFERRAL_STATE_KEY,
  PUSH_LEDGER_STATE_KEY,
  SKIP_CAPTURE_STATE_KEY,
];

export const WEDGE_READ_KEYS = [
  "scan_heartbeat",
  "scheduled_tick_total",
  "scheduled_tick_ring",
  TICK_PROGRESS_KEY,
  // Round 4: the tick prefetch's row (TradeService.primeModeOverride).
  "trade_mode_override",
  // 2026-09-27: the boot rows ride it too. This statement is the cold
  // isolate's FIRST read, and the boot block runs ~300ms later in the SAME
  // invocation reading four more keys — a second round trip for values this
  // one already had in hand. Measured live: a census window read
  // \`getWorkerStates 5 calls / 616ms\`, the front's largest single item, and
  // the boot read was one of them on every cold isolate. A read that TIMED OUT
  // leaves lastBootKeysRead's map null and the boot block fetches its own copy,
  // so the failure mode of the merge is the old shape, not a missing row.
  ...BOOT_STATE_KEYS,
];

/**
 * The front statement's map, as the boot block consumes it (see
 * BOOT_STATE_KEYS / WEDGE_READ_KEYS). Same discipline as lastCronKeysRead and
 * lastProgressRead: \`map: null\` means NO READING — the read timed out — and
 * must never be read as "no rows", because one of these keys decides whether
 * the Axiom client is built. The boot block falls back to its own read when
 * this is null or older than HEARTBEAT_REUSE_MS.
 */
let lastBootKeysRead: { map: Map<string, string> | null; at: number } | null = null;`,
  (src) => src.includes("export const BOOT_STATE_KEYS = ["),
);

edit(
  "worker: the front read is recorded for the boot block",
  WORKER,
  `      if (kb) {
        lastProgressRead = { raw: kb.get(TICK_PROGRESS_KEY) ?? null, at: now };
      }`,
  `      if (kb) {
        lastProgressRead = { raw: kb.get(TICK_PROGRESS_KEY) ?? null, at: now };
      }
      // The same statement now carries the boot rows (see BOOT_STATE_KEYS), so
      // init's block below reads them from here instead of paying a second
      // round trip for four keys it already has. Recorded ONLY when the read
      // landed: a timed-out front read must not be dressed up as boot rows.
      lastBootKeysRead = { map: kb, at: now };`,
  (src) => src.includes("lastBootKeysRead = { map: kb, at: now };"),
);

edit(
  "worker: the cold-init block prefers the front's map, keeping its own read as the fallback",
  WORKER,
  `          let bootStates: Map<string, string> | null = null;
          try {
            bootStates = (await db?.getWorkerStates([
              "axiom_access_token",
              PUSH_DEFERRAL_STATE_KEY,
              PUSH_LEDGER_STATE_KEY,
              SKIP_CAPTURE_STATE_KEY,
            ])) ?? null;
          } catch {
            // telemetry only — never fail init over a counter read
          }`,
  `          // ...and they are already in hand on the healthy path (2026-09-27):
          // the front statement ABOVE read them (see BOOT_STATE_KEYS), in this
          // same invocation, ~300ms ago. So this block pays ZERO subrequests
          // and keeps its old shape only as the fallback — a front read that
          // timed out (null map) or one older than the reuse window.
          let bootStates: Map<string, string> | null =
            lastBootKeysRead !== null &&
            Date.now() - lastBootKeysRead.at <= HEARTBEAT_REUSE_MS
              ? lastBootKeysRead.map
              : null;
          if (bootStates === null) {
            try {
              bootStates =
                (await db?.getWorkerStates([...BOOT_STATE_KEYS])) ?? null;
            } catch {
              // telemetry only — never fail init over a counter read
            }
          }`,
  (src) => src.includes("lastBootKeysRead !== null &&"),
);

edit(
  "worker: the cold-init comment names the ride",
  WORKER,
  `          // ONE read for the four rows this boot needs (2026-09-26).`,
  `          // ONE read for the four rows this boot needs (2026-09-26) — and
          // since 2026-09-27 the FRONT statement carries them, so the healthy
          // path is zero reads (see BOOT_STATE_KEYS / lastBootKeysRead).`,
  (src) => src.includes("since 2026-09-27 the FRONT statement carries them"),
);

edit(
  "worker: beginPreTick records which owner opened the window",
  WORKER,
  `function beginPreTick(entryAt: number): void {
  // The subrequest window opens here, with the pre-scan split: both
  // handlers (cron and the HTTP fallback) enter through this seam, so a
  // window is one scan attempt's spend — the unit Cloudflare limits to 50
  // per invocation (see src/subreqs.ts). Anything else this isolate serves
  // inside the same window (a webhook, a /debug probe) is counted too, so
  // the reading is an upper bound on the tick; the phase ring is what
  // localizes it.
  beginSubreqWindow(entryAt);`,
  `function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {
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
  beginSubreqWindow(entryAt, owner);`,
  (src) => src.includes("beginSubreqWindow(entryAt, owner);"),
);

edit(
  "worker: the HTTP fallback's window says so",
  WORKER,
  `  beginPreTick(now);`,
  `  beginPreTick(now, "http");`,
  (src) => src.includes('beginPreTick(now, "http");'),
);

edit(
  "worker: the scheduled handler tags the window by trigger",
  WORKER,
  `    beginPreTick(Date.now());`,
  `    // ...tagged by trigger BEFORE the routing below (a pure string compare,
    // so the tag cannot change the routing it describes): the pass's own
    // delivery is a window of its own, and everything a reader concludes about
    // "the tick front's spend" depends on the two not being mixed.
    beginPreTick(Date.now(), isTrackerCron(event.cron) ? "pass" : "scan");`,
  (src) => src.includes('beginPreTick(Date.now(), isTrackerCron(event.cron) ? "pass" : "scan");'),
);

edit(
  "worker: the tick's scan asks which slice it actually needs",
  WORKER,
  `        // The scan's counter carries the tracker pass's slice (see
        // TRACKER_PASS_SUBREQ_RESERVE): optional legs stand down while the
        // pass's tail is intact, instead of the scan spending it and the pass
        // deferring by name.
        scanner.runOnce(() => scanSubreqLeft(subreqRemaining())),`,
  `        // The scan's counter carries the tracker pass's slice (see
        // TRACKER_PASS_SUBREQ_RESERVE): optional legs stand down while the
        // pass's tail is intact, instead of the scan spending it and the pass
        // deferring by name.
        //
        // ...AND THE SLICE IS CONDITIONAL (2026-09-27): when the pass's own
        // cron delivery already owns this minute, the tick's pass stage stands
        // down (see Scanner.runTrackerPass) and there is nothing left to hold
        // back — so the slice goes to the scan, whose optional legs then stand
        // down at the invocation's real floor instead of ~12 early. The
        // question is asked AT THE LAST MOMENT a pass could start
        // (\`startedAt + SCAN_TICK_BUDGET_MS\`, the tick's whole envelope), and
        // it reads the same front row and the same window the pass stage reads:
        // a row that will still be inside the window then is one the pass stage
        // is bound to stand down for, which is what keeps the two decisions from
        // disagreeing about a row that crosses the window in between.
        scanner.runOnce(() =>
          scanSubreqLeft(
            subreqRemaining(),
            scanner.trackerPassSlice(
              TRACKER_PASS_FALLBACK_FRESH_MS,
              TRACKER_PASS_SUBREQ_RESERVE,
              startedAt + SCAN_TICK_BUDGET_MS,
            ),
          ),
        ),`,
  (src) => src.includes("scanner.trackerPassSlice("),
);

// --------------------------------------------------------------- scanner.ts

edit(
  "scanner: ONE ownership reading, shared by the scan's slice and the pass's stand-down",
  SCANNER,
  `  async runTrackerPass(
    deadlineMs: number,
    keepAlive?: (promise: Promise<unknown>) => void,
    subreqLeft?: () => number,
    options?: TrackerPassRunOptions,
  ): Promise<string | null> {`,
  `  /**
   * The pass's row age when the row says a pass ran inside \`windowMs\`, or
   * null when it does not — ONE reading behind both decisions about this
   * minute: the scan's slice (trackerPassSlice) and the pass stage's own
   * stand-down (below).
   *
   * \`at\` is WHEN the answer is needed, and callers differ on purpose: the
   * pass stage asks at its own start, while the scan asks at the END of the
   * tick's envelope, because the slice it releases must still be free when
   * the pass stage runs. Both read the same row, so a row crossing the window
   * between the two cannot make the scan release a slice the pass then needs.
   */
  private peerPassAgeMs(at: number, windowMs: number): number | null {
    if (!(windowMs > 0)) return null;
    const ageMs = passRowAgeMs(this.peerPassRow, at);
    return ageMs !== null && ageMs < windowMs ? ageMs : null;
  }

  /**
   * The subrequest slice this tick's pass stage still needs — what the scan's
   * low-water gate takes off its allowance (see worker.scanSubreqLeft /
   * TRACKER_PASS_SUBREQ_RESERVE).
   *
   * ZERO when the pass's own cron delivery owns this minute: the slice exists
   * for a pass THIS invocation might run, and the pass stage will stand down,
   * so holding it back would starve the scan's optional legs for nothing
   * (measured: they stood down after ~14 of the 38 usable subrequests while
   * every durable pass row read \`via:"cron-pass"\`).
   */
  trackerPassSlice(windowMs: number, slice: number, atMs: number): number {
    return this.peerPassAgeMs(atMs, windowMs) !== null ? 0 : slice;
  }

  async runTrackerPass(
    deadlineMs: number,
    keepAlive?: (promise: Promise<unknown>) => void,
    subreqLeft?: () => number,
    options?: TrackerPassRunOptions,
  ): Promise<string | null> {`,
  (src) => src.includes("  trackerPassSlice(windowMs: number, slice: number, atMs: number): number {"),
);

edit(
  "scanner: the stand-down uses that same reading",
  SCANNER,
  `    const peerPassFreshMs = options?.peerPassFreshMs ?? 0;
    if (peerPassFreshMs > 0) {
      const ageMs = passRowAgeMs(this.peerPassRow, startedAt);
      if (ageMs !== null && ageMs < peerPassFreshMs) {
        const note = \`yield:peer-pass \${Math.round(ageMs / 1000)}s\`;`,
  `    const peerPassFreshMs = options?.peerPassFreshMs ?? 0;
    // The reading is SHARED (see peerPassAgeMs): the scan's slice was released
    // against this very row earlier in the tick — asked at the last moment a
    // pass could start — so this stage and that one agree by construction, not
    // by both happening to look at the same row.
    const ageMs = this.peerPassAgeMs(startedAt, peerPassFreshMs);
    if (peerPassFreshMs > 0) {
      if (ageMs !== null) {
        const note = \`yield:peer-pass \${Math.round(ageMs / 1000)}s\`;`,
  (src) => src.includes("this.peerPassAgeMs(startedAt, peerPassFreshMs);"),
);

// ------------------------------------------------------------- test-unit.js

edit(
  "tests: the reserve pin follows the call, and the slice is pinned as conditional",
  TESTS,
  `    assert.equal(scanSubreqLeft(30), 18);
    assert.equal(scanSubreqLeft(TRACKER_PASS_SUBREQ_RESERVE), 0);
    // Negative is a real answer — clamping it to 0 would read as "exactly at
    // the reserve" and hide that the slice is already spent.
    assert.equal(scanSubreqLeft(2), -10);
    const workerSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "worker.ts"),
      "utf8",
    );
    assert.ok(
      workerSrc.includes("scanner.runOnce(() => scanSubreqLeft(subreqRemaining()))"),
      "the scan's counter must carry the reserve",
    );`,
  `    assert.equal(scanSubreqLeft(30), 18);
    assert.equal(scanSubreqLeft(TRACKER_PASS_SUBREQ_RESERVE), 0);
    // Negative is a real answer — clamping it to 0 would read as "exactly at
    // the reserve" and hide that the slice is already spent.
    assert.equal(scanSubreqLeft(2), -10);
    // THE SLICE IS CONDITIONAL (2026-09-27): a tick whose pass stands down for
    // the pass's own cron delivery hands the scan the whole allowance. Same
    // arithmetic, one fewer reservation — and it is the DEFAULT that keeps
    // every other caller (and every earlier reading) exactly as it was.
    assert.equal(scanSubreqLeft(30, 0), 30);
    assert.equal(scanSubreqLeft(2, 0), 2);
    assert.equal(scanSubreqLeft(30, 4), 26);
    const workerSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "worker.ts"),
      "utf8",
    );
    // The CALL is pinned, whitespace-flattened, because its shape is the whole
    // point: the slice is not a constant any more, it is ASKED FOR — from the
    // scanner, with the window and the slice, at the last moment this
    // invocation could start a pass.
    const flatWorker = workerSrc.replace(/\\s+/g, "");
    assert.ok(
      flatWorker.includes(
        "scanner.runOnce(()=>scanSubreqLeft(subreqRemaining(),scanner.trackerPassSlice(TRACKER_PASS_FALLBACK_FRESH_MS,TRACKER_PASS_SUBREQ_RESERVE,startedAt+SCAN_TICK_BUDGET_MS,),),)",
      ),
      "the scan's counter must carry the slice the tick will actually need",
    );`,
  (src) => src.includes("the scan's counter must carry the slice the tick will actually need"),
);

edit(
  "tests: the boot rows ride the front statement",
  TESTS,
  `      "worker (the four boot rows ride ONE getWorkerStates)":
        workerSrc.includes(
          'bootStates=(awaitdb?.getWorkerStates(["axiom_access_token",PUSH_DEFERRAL_STATE_KEY,PUSH_LEDGER_STATE_KEY,SKIP_CAPTURE_STATE_KEY,]))??null;',
        ),`,
  `      "worker (the four boot rows ride the front's ONE statement)":
        workerSrc.includes(
          'exportconstBOOT_STATE_KEYS=["axiom_access_token",PUSH_DEFERRAL_STATE_KEY,PUSH_LEDGER_STATE_KEY,SKIP_CAPTURE_STATE_KEY,];',
        ) &&
        workerSrc.includes("...BOOT_STATE_KEYS,];"),
      "worker (and the boot block reads them from that statement, its own read kept as the fallback)":
        workerSrc.includes(
          "letbootStates:Map<string,string>|null=lastBootKeysRead!==null&&Date.now()-lastBootKeysRead.at<=HEARTBEAT_REUSE_MS?lastBootKeysRead.map:null;",
        ) &&
        workerSrc.includes("if(bootStates===null){try{bootStates=(awaitdb?.getWorkerStates([...BOOT_STATE_KEYS]))??null;"),`,
  (src) => src.includes("the four boot rows ride the front's ONE statement"),
);

// -------------------------------------------------------------------- apply

let applied = 0;
let skipped = 0;
for (const e of EDITS) {
  const file = path.join(root, e.file);
  const src = fs.readFileSync(file, "utf8");
  if (e.verify(src)) {
    console.log(` = ${e.name} — already applied`);
    skipped += 1;
    continue;
  }
  const count = src.split(e.find).length - 1;
  if (count !== 1) {
    throw new Error(`${e.name}: anchor matched ${count} times in ${e.file} (want exactly 1)`);
  }
  fs.writeFileSync(file, src.replace(e.find, e.replace));
  if (!e.verify(fs.readFileSync(file, "utf8"))) {
    throw new Error(`${e.name}: the write did not verify in ${e.file}`);
  }
  console.log(` ✓ ${e.name} — patched`);
  applied += 1;
}
console.log(`\n${applied} patched, ${skipped} already applied, ${EDITS.length} edits total`);
