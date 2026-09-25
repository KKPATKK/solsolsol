#!/usr/bin/env node
/**
 * 逐個 Db method 點名：一個 tick 嘅 Turso round trip 到底由邊幾條 call 組成。
 *
 * WHY（2026-09-25，量度之後）
 *   `subreqView().current.hosts` 只講得出「一個 tick 有 ~29 個 subrequest 去咗
 *   …turso.io」，講唔出係邊幾條；`dbSteps` 淨係包住 3 個 method（而且係開機以
 *   嚟累計）。所以之前每一次「cut round trip」都係靠 stage 分類推出來，唔係靠
 *   census —— 而 live 量度顯示 row loop 其實**已經**係一個 batch（一行一個
 *   claim 嘅年代已經過去：`claimPushWatchChecksMany` 一次 batch 28 行 = 1 個
 *   HTTP request，pass note 讀 `rows 282/1`），大頭散喺 front／tail 十幾條
 *   一次性嘅 statement 度。
 *
 * WHAT
 *   - `wrapDb` 除咗原本嗰 3 個 method，再包住一份 census 清單（37 個 tick 路徑
 *     會行到嘅 Db method）。**只計時，永不 defer**：defer 會改變邊個 tick 埋單，
 *     而只有原本嗰 2 個寫入係證明過閘門唔讀嘅。`setWorkerState` 都包：header 反
 *     對嘅係「defer 佢」（佢係失敗 drain 發表自己原因嘅通道），census 只計時。
 *   - `stepsAtTickStart`：tick 開始時影一份 cumulative map，`dbTickStepView()`
 *     用差額還原**呢一個 scan window** 嘅逐 method calls／ms。
 *   - 掛上 `summary.dbTickSteps`（同 `phases` / `gecko` 同一個位）。
 *
 * Semantics：`marker` = 已應用嘅證據，anchor 必須唯一，refuse to leave the tree
 * half-patched，重跑要 0 file(s) written。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const BASELINE = lines(
  "const steps = new Map<string, DbStepView>();",
  "/**",
  " * Cumulative `steps` as it stood at the START of the tick (see",
  " * dbTickStepView): the per-tick census is the difference. A whole-map copy",
  " * rather than a counter per method, because the map is bounded by the census",
  " * list below and the tick boundary is the one place a snapshot is free.",
  " */",
  "let stepsAtTickStart = new Map<string, DbStepView>();",
);

const STEP_VIEW = lines(
  "/** Per-method DB timing since this isolate booted (see the header). */",
  "export function dbStepView(): Record<string, DbStepView> {",
  "  const out: Record<string, DbStepView> = {};",
  "  for (const [name, s] of steps) out[name] = { ...s };",
  "  return out;",
  "}",
);

const TICK_VIEW = lines(
  "/**",
  " * The DB census of the tick that just finished: per method, the CALLS (and",
  " * ms) it paid inside the probe's tick window — the difference against the",
  " * snapshot taken at tick start.",
  " *",
  " * WHY IT EXISTS (2026-09-25): the invocation's 50 subrequests are shared, and",
  " * the host split can only say that N of them went to `…turso.io`, never which",
  " * calls they were. `dbSteps` times three wrapped methods cumulatively since",
  " * boot — enough to prove a single candidate path, but it cannot answer \"what",
  " * owns the ~20 Turso round trips a tick spends\", so every earlier cut in that",
  " * direction was reasoned from a stage split instead of from a census. This is",
  " * the reading that decides what to batch next (docs/round-trips.md §4.11).",
  " *",
  " * The SCAN's window, not the whole tick: the tracker pass and the write drain",
  " * publish their own `trips` / `calls` counts, and the tail's writes are the",
  " * ones this probe must never defer (the drain's failure channel rides",
  " * `setWorkerState`). Methods that were not called this tick are omitted, so",
  " * the census stays a list of what actually cost something.",
  " */",
  "export function dbTickStepView(): Record<string, DbStepView> {",
  "  const out: Record<string, DbStepView> = {};",
  "  for (const [name, s] of steps) {",
  "    const base = stepsAtTickStart.get(name);",
  "    const calls = s.calls - (base?.calls ?? 0);",
  "    if (calls <= 0) continue;",
  "    out[name] = { calls, ms: s.ms - (base?.ms ?? 0) };",
  "  }",
  "  return out;",
  "}",
);

const CENSUS = lines(
  "/**",
  " * The bounds the census wraps: every Db method a tick's scan is known to call,",
  " * timed (never deferred) so `summary.dbTickSteps` can name what the",
  " * subrequest split only attributes to Turso as a total.",
  " *",
  " * WHY THESE: measured live 2026-09-25 — a cron tick's window read `total 32`",
  " * with `turso 29`, and the tick's DB work is ~20 DISTINCT one-shot calls",
  " * rather than one fat loop (the tracker row loop is already a single batch:",
  " * `claimPushWatchChecksMany` pipelines ~28 CAS statements into one request,",
  " * and the pass note reads `rows 282/1`). A census is the only way to see",
  " * which of them still deserve to be merged into that same shape.",
  " *",
  " * A method that does not exist on the handle is skipped by wrapDbMethod, and",
  " * the three wrapped above are excluded (a second wrap would count every call",
  " * twice in noteStep).",
  " */",
  "const CENSUS_METHODS = [",
  '  "getWorkerState",',
  '  "getWorkerStates",',
  '  "setWorkerState",',
  '  "setWorkerStatesMany",',
  '  "listEnabledChats",',
  '  "listPushWatch",',
  '  "getPushAudit",',
  '  "readPostScanTelemetry",',
  '  "claimScanLock",',
  '  "releaseScanLock",',
  '  "getReevalPool",',
  '  "isTokenSeen",',
  '  "listSeenTokens",',
  '  "getTokenStats",',
  '  "getTokenPushedInfo",',
  '  "resumeLaunchBackfill",',
  '  "pruneOldTokenStats",',
  '  "recordObservedLiquidity",',
  '  "persistScanCompletion",',
  '  "writeScheduledTick",',
  '  "stampScheduledArrival",',
  '  "recordTokenStats",',
  '  "updateTokenSupplyFlow",',
  '  "updateTokenRugcheckData",',
  '  "updateTokenProTraders",',
  '  "updateTokenSniperPct",',
  '  "recordPushDelivery",',
  '  "claimRecapsAndPrune",',
  '  "findUntrackedPushesAndLedger",',
  '  "repairPushWatchBaselines",',
  '  "claimPushWatch",',
  '  "claimPushWatchChecksMany",',
  '  "reservePushWatchAlert",',
  '  "updatePushWatchCheck",',
  '  "upsertPushWatchMany",',
  '  "setPushWatchHoldersMany",',
  '  "rearmPushWatchAlert",',
  "];",
);

const WRAP_OLD = lines(
  "/** Wrap the three DB methods the tick uses around its gates (see the header). */",
  "function wrapDb(db: TickProbeDb, deferWrites: boolean): void {",
  "  if (wrapped.has(db as object)) return;",
  "  wrapped.add(db as object);",
  "  const target = db as Record<string, unknown>;",
  "  // Reads keep their contract (the gates consume the result in this tick).",
  '  wrapDbMethod(target, "getTokenStatsMany", false);',
  "  // Writes: registration + raise-only bookkeeping, neither read by the gates.",
  '  wrapDbMethod(target, "recordTokenStatsMany", deferWrites);',
  '  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites);',
  "  // `setWorkerState` is deliberately NOT wrapped: it is the channel a FAILED",
  "  // drain uses to publish its own reason (see persistDrainError), so deferring",
  "  // it would push that record back onto the very queue that just failed.",
  "}",
);

const WRAP_NEW = lines(
  "/**",
  " * Wrap the tick's DB methods: the three the gates use (one read, two",
  " * deferrable writes — see the header) plus the census list, which is only ever",
  " * TIMED.",
  " */",
  "function wrapDb(db: TickProbeDb, deferWrites: boolean): void {",
  "  if (wrapped.has(db as object)) return;",
  "  wrapped.add(db as object);",
  "  const target = db as Record<string, unknown>;",
  "  // Reads keep their contract (the gates consume the result in this tick).",
  '  wrapDbMethod(target, "getTokenStatsMany", false);',
  "  // Writes: registration + raise-only bookkeeping, neither read by the gates.",
  '  wrapDbMethod(target, "recordTokenStatsMany", deferWrites);',
  '  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites);',
  "  // The census: timed, never deferred (see CENSUS_METHODS). `setWorkerState`",
  "  // is in it on purpose — the header's warning is about DEFERRING it (it is",
  "  // the channel a failed drain publishes its own reason through), and a timed",
  "  // wrapper keeps that record immediate while making the channel visible.",
  "  //",
  "  // `deferWrites` is deliberately NOT consulted here: a deferred write moves",
  "  // the cost to a different tick, which would make the census a lie about the",
  "  // tick it is measuring.",
  "  for (const name of CENSUS_METHODS) {",
  '    if (name === "getTokenStatsMany" || name === "recordTokenStatsMany") {',
  "      continue; // wrapped above — a second wrap would double-count in noteStep",
  "    }",
  '    if (name === "updateTokenMaxMcaps") continue; // wrapped above',
  "    wrapDbMethod(target, name, false);",
  "  }",
  "}",
);

const PATCHES = [
  {
    file: "src/tickprobe.ts",
    what: "the tick start keeps the census' baseline",
    marker: "let stepsAtTickStart = new Map<string, DbStepView>();",
    anchor: "const steps = new Map<string, DbStepView>();",
    replacement: BASELINE,
  },
  {
    file: "src/tickprobe.ts",
    what: "a per-tick census can be read",
    marker: "export function dbTickStepView(): Record<string, DbStepView> {",
    anchor: STEP_VIEW,
    replacement: lines(STEP_VIEW, "", TICK_VIEW),
  },
  {
    file: "src/tickprobe.ts",
    what: "the census list exists",
    marker: "const CENSUS_METHODS = [",
    anchor: WRAP_OLD,
    replacement: lines(CENSUS, "", WRAP_NEW),
  },
  {
    file: "src/tickprobe.ts",
    what: "the baseline is taken at the tick boundary",
    marker: "stepsAtTickStart = new Map([...steps]",
    anchor: lines(
      "    tickStartedAt = now();",
      "    stamps = [];",
      "    view = null;",
      "    tickActive = true;",
    ),
    replacement: lines(
      "    tickStartedAt = now();",
      "    stamps = [];",
      "    view = null;",
      "    tickActive = true;",
      "    // The census' zero point: everything the scan pays from here is THIS",
      "    // tick's (see dbTickStepView).",
      "    stepsAtTickStart = new Map([...steps].map(([name, s]) => [name, { ...s }]));",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the census rides the summary the heartbeat already serializes",
    marker: "summary.dbTickSteps = dbTickStepView();",
    anchor: "        summary.gmgnFeed = gmgnFeedStats();",
    replacement: lines(
      "        summary.gmgnFeed = gmgnFeedStats();",
      "        // The census of THIS tick's scan window (see dbTickStepView). The",
      "        // subrequest host split says how much went to Turso; this says which",
      "        // calls it was, which is what a batching decision needs.",
      "        summary.dbTickSteps = dbTickStepView();",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "a reset forgets the baseline too",
    marker: "  stepsAtTickStart = new Map();",
    anchor: lines("  queue = [];", "  steps.clear();"),
    replacement: lines(
      "  queue = [];",
      "  steps.clear();",
      "  // The census baseline goes with the cumulative map it was copied from:",
      "  // a stale snapshot would subtract another run's calls from this one's.",
      "  stepsAtTickStart = new Map();",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the census is per tick AND per method, and pinned by a test",
    marker: "the census names what a tick's scan paid, per method",
    anchor:
      '  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {',
    replacement: lines(
      '  await test("tickprobe: the census names what a tick\'s scan paid, per method", async () => {',
      "    // WHY (2026-09-25): a tick's window reads `turso 29` and nothing in the",
      "    // repo could say WHICH calls those were — `dbSteps` covers three methods",
      "    // cumulatively since boot. The census is the whole map's difference against",
      "    // the snapshot taken at tick start, i.e. per-tick AND per-method.",
      '    const { installTickProbe, resetTickProbe, dbTickStepView, dbStepView } = require("../dist/tickprobe.js");',
      "    let clock = 1_000;",
      "    const db = {",
      "      getWorkerState: async () => { clock += 7; return null; },",
      "      setWorkerState: async () => { clock += 3; },",
      "      getTokenStatsMany: async () => { clock += 1; return []; },",
      "    };",
      "    resetTickProbe();",
      "    const seam = {",
      "      runOnce: async () => {",
      '        await db.getWorkerState("k");',
      '        await db.setWorkerState("k", "v");',
      "      },",
      "    };",
      "    installTickProbe(seam, { db }, () => clock);",
      "    // A call OUTSIDE the tick belongs to no tick's census: the worker's",
      "    // /health handlers share this same handle.",
      '    await db.getWorkerState("outside");',
      "    await seam.runOnce();",
      "    const census = dbTickStepView();",
      '    assert.deepEqual(Object.keys(census).sort(), ["getWorkerState", "setWorkerState"], "exactly the methods the tick called");',
      '    assert.equal(census.getWorkerState.calls, 1, "a delta, not a cumulative — the call before the tick is not this tick\'s");',
      '    assert.equal(census.getWorkerState.ms, 7, "and the ms are the tick\'s own");',
      "    assert.equal(census.setWorkerState.calls, 1);",
      "    assert.equal(census.setWorkerState.ms, 3);",
      '    assert.equal(census.getTokenStatsMany, undefined, "a method the tick never touched is omitted, so the census is a list of what cost something");',
      "    // The cumulative view is still the whole isolate's: together the two",
      "    // readings say \"this tick\" AND \"since boot\".",
      "    const cumulative = dbStepView();",
      '    assert.equal(cumulative.getWorkerState.calls, 2, "the outside call is still in the isolate view");',
      "    resetTickProbe();",
      "  });",
      "",
      '  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {',
    ),
  },
  {
    file: "src/scanner.ts",
    what: "the summary declares the census field",
    marker: "dbTickSteps?: Record<string, { calls: number; ms: number }>;",
    anchor: "  subreqSkip?: string[];",
    replacement: lines(
      "  subreqSkip?: string[];",
      "  /**",
      "   * The per-method DB census of this scan's window (see tickprobe.ts:",
      "   * dbTickStepView) — calls + ms per Db method, as a delta of the isolate's",
      "   * cumulative `dbSteps`. This is the reading that says what a tick's ~20",
      "   * Turso round trips are actually made of, since the subrequest host split",
      "   * can only attribute them to `…turso.io` as a total.",
      "   */",
      "  dbTickSteps?: Record<string, { calls: number; ms: number }>;",
    ),
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
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
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
