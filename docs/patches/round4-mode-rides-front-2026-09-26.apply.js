#!/usr/bin/env node
/**
 * Round 4 (2026-09-26): `trade_mode_override` rides the tick-front batch.
 *
 * WHY THIS ITEM. The labelled census (`summary.dbTickSteps`) named the two
 * candidates, and three consecutive live ticks separated them:
 *
 *   - `getWorkerState:trade_mode_override  1 call / 86-117ms` on EVERY tick
 *     (modeRead `reads 1 reuses 0`): the worker's prefetch re-reads the row at
 *     each tick's start, and with a 60s tick against MODE_OVERRIDE_TTL_MS =
 *     15s the cache is always cold when the next tick arrives.
 *   - `getWorkerState:scan_heartbeat` 0 calls on a cron tick. Its consumers
 *     already share ONE statement (`WEDGE_READ_KEYS`, plus lastHeartbeatRead's
 *     2s reuse), and the ticks that DO show the single-key read are the
 *     diagnostic/fallback paths by design (/debug/tick passes no heartbeat,
 *     checkOutageAndAlert only reads without one). Nothing left to win there.
 *
 * THE MERGE. The tick front already reads `worker_state` in ONE batch before
 * the scan (ensureInitialized -> WEDGE_READ_KEYS). Adding a key to a statement
 * that is going out anyway costs NO subrequest, so:
 *
 *   1. `trade_mode_override` joins WEDGE_READ_KEYS (and the list is exported,
 *      so the ride is unit-testable);
 *   2. `frontModeOverrideRead()` hands that row's value + reading time to the
 *      tick's `onTickStart` hook, which primes TradeService's cache BEFORE the
 *      prefetch — the prefetch is then a no-op (cache fresh) and the tick pays
 *      no read for the mode at all. `null` = a real reading ("no override");
 *      "no reading" (no front read, a timed-out batch, or one older than
 *      HEARTBEAT_REUSE_MS) does NOT prime — the prefetch pays its own round
 *      trip exactly as before, the fail-safe direction;
 *   3. /health stops paying a SECOND read of the same row: the key joins its
 *      existing getWorkerStates batch, the validated value comes from that
 *      read, and the row primes the service so `effectiveMode` costs nothing
 *      either.
 *
 * One rule everywhere: `parseTradeModeOverride` (src/db.ts) is the validation
 * `Db.getTradeModeOverride` always used, now shared by the batch readers.
 *
 * Staleness is unchanged in kind: a primed value ages like one of our own
 * reads (MODE_OVERRIDE_TTL_MS), and the worker only primes from a read that is
 * younger than HEARTBEAT_REUSE_MS — the same window the heartbeat/progress
 * rides have used since §4.1.
 *
 * src/db.ts and src/worker.ts are both far past the file tool's edit window,
 * so this is a verify-then-write patch.
 *
 * Run: node docs/patches/round4-mode-rides-front-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  // ------------------------------------------------------------------ db.ts --
  [
    "src/db.ts",
    "the override's validation becomes ONE exported rule",
    lines(
      `export interface ScheduledTickEntry {`,
      `  /** Cron event time (epoch ms) — \`scheduled_tick_at\` and the ring's tail. */`,
      `  at: number;`,
      `  /** The ring to store (the caller appends and caps, see the parser above). */`,
      `  ring: number[];`,
      `}`,
    ),
    lines(
      `export interface ScheduledTickEntry {`,
      `  /** Cron event time (epoch ms) — \`scheduled_tick_at\` and the ring's tail. */`,
      `  at: number;`,
      `  /** The ring to store (the caller appends and caps, see the parser above). */`,
      `  ring: number[];`,
      `}`,
      ``,
      `/**`,
      ` * Validate a raw \`trade_mode_override\` row value — the ONE rule, shared by`,
      ` * every reader of that row: Db.getTradeModeOverride (the single-row read),`,
      ` * /health (which gets the row out of its own batch) and TradeService's`,
      ` * primed cache (round 4, docs/round-trips.md §4.25).`,
      ` *`,
      ` * Anything else — a junk value from a hand edit, an empty row, a row that`,
      ` * was never written — is null, i.e. "no override, use the env config".`,
      ` * Collapsing "could not read" into this null is why the batch readers must`,
      ` * only call it when their read LANDED (see worker.ts's frontModeOverrideRead`,
      ` * and the /health handler's \`modeLanded\`).`,
      ` */`,
      `export function parseTradeModeOverride(`,
      `  raw: string | null | undefined,`,
      `): "off" | "manual" | "auto" | null {`,
      `  return raw === "off" || raw === "manual" || raw === "auto" ? raw : null;`,
      `}`,
    ),
    (src) => src.includes("export function parseTradeModeOverride("),
  ],
  [
    "src/db.ts",
    "the single-row read goes through that rule",
    lines(
      `  /**`,
      `   * Telegram-set trade-mode override (worker_state key trade_mode_override).`,
      `   * Takes precedence over the env TRADE_MODE var in every money-moving path;`,
      `   * null means "no override — use the env config". Invalid stored values`,
      `   * (e.g. a stale hand edit) are ignored and treated as no override.`,
      `   */`,
      `  async getTradeModeOverride(): Promise<"off" | "manual" | "auto" | null> {`,
      `    const v = await this.getWorkerState("trade_mode_override");`,
      `    if (v === "off" || v === "manual" || v === "auto") return v;`,
      `    return null;`,
      `  }`,
    ),
    lines(
      `  /**`,
      `   * Telegram-set trade-mode override (worker_state key trade_mode_override).`,
      `   * Takes precedence over the env TRADE_MODE var in every money-moving path;`,
      `   * null means "no override — use the env config". Invalid stored values`,
      `   * (e.g. a stale hand edit) are ignored and treated as no override — the`,
      `   * rule itself lives in parseTradeModeOverride, so a reader that already`,
      `   * holds the raw row (a batch, see docs/round-trips.md §4.25) applies`,
      `   * exactly the same one instead of re-reading this row.`,
      `   */`,
      `  async getTradeModeOverride(): Promise<"off" | "manual" | "auto" | null> {`,
      `    return parseTradeModeOverride(await this.getWorkerState("trade_mode_override"));`,
      `  }`,
    ),
    (src) => src.includes("exactly the same one instead of re-reading this row"),
  ],
  // --------------------------------------------------------------- worker.ts --
  [
    "src/worker.ts",
    "the front's batch carries the mode row (and the list is exported for the guard)",
    lines(
      ` * What ensureInitialized fetches in its one read: the heartbeat (three`,
      ` * consumers share it) plus the cron-arrival pair the cadence gate needs, so`,
      ` * a cron tick's front path needs no second read at all. The tick's pre-flush`,
      ` * progress record rides the SAME statement — one more key in a statement that`,
      ` * was already going out costs no subrequest, and the successor tick is the`,
      ` * only witness a killed tick can have.`,
      ` */`,
      `const WEDGE_READ_KEYS = [`,
      `  "scan_heartbeat",`,
      `  "scheduled_tick_total",`,
      `  "scheduled_tick_ring",`,
      `  TICK_PROGRESS_KEY,`,
      `];`,
    ),
    lines(
      ` * What ensureInitialized fetches in its one read: the heartbeat (three`,
      ` * consumers share it) plus the cron-arrival pair the cadence gate needs, so`,
      ` * a cron tick's front path needs no second read at all. The tick's pre-flush`,
      ` * progress record rides the SAME statement — one more key in a statement that`,
      ` * was already going out costs no subrequest, and the successor tick is the`,
      ` * only witness a killed tick can have.`,
      ` *`,
      ` * ROUND 4 (2026-09-26, docs/round-trips.md §4.25): the trade-mode override`,
      ` * rides it too. Measured live across three consecutive ticks, that row was`,
      ` * the last EVERY-TICK single-key read in the census`,
      ` * (\`getWorkerState:trade_mode_override 1\` / 86-117ms, \`modeRead reads 1`,
      ` * reuses 0\`) — while \`scan_heartbeat\` showed ZERO on the same ticks, its`,
      ` * readers already sharing this very statement. The tick's prefetch finds the`,
      ` * value primed from here (see frontModeOverrideRead) and pays nothing.`,
      ` *`,
      ` * EXPORTED for the same reason cronGateLoad is: the merge's whole promise is`,
      ` * a round-trip count, so what the statement carries has to be assertable`,
      ` * offline instead of only observed live.`,
      ` */`,
      `export const WEDGE_READ_KEYS = [`,
      `  "scan_heartbeat",`,
      `  "scheduled_tick_total",`,
      `  "scheduled_tick_ring",`,
      `  TICK_PROGRESS_KEY,`,
      `  // Round 4: the tick prefetch's row (TradeService.primeModeOverride).`,
      `  "trade_mode_override",`,
      `];`,
      ``,
      `/**`,
      ` * The trade-mode row as the tick-front's ONE batch read it (see`,
      ` * WEDGE_READ_KEYS), or null when there is no READING to trust: no front read`,
      ` * this invocation, one that TIMED OUT (its \`map\` is null), or one older than`,
      ` * HEARTBEAT_REUSE_MS.`,
      ` *`,
      ` * The three-state contract is the point. \`{ raw: null }\` is a real reading —`,
      ` * the row is absent, i.e. no override — and must prime the cache as such.`,
      ` * \`null\` (no reading) must NOT prime: the prefetch then pays its own round`,
      ` * trip, the pre-round-4 shape, which is strictly safer than inventing a mode.`,
      ` * Same discipline as lastHeartbeatRead / lastProgressRead, and the reason`,
      ` * the caller reads \`if (ride !== null)\` rather than testing the value.`,
      ` */`,
      `export function frontModeOverrideRead(): { raw: string | null; at: number } | null {`,
      `  const seen = lastCronKeysRead;`,
      `  if (seen === null || seen.map === null) return null;`,
      `  if (Date.now() - seen.at > HEARTBEAT_REUSE_MS) return null;`,
      `  return { raw: seen.map.get("trade_mode_override") ?? null, at: seen.at };`,
      `}`,
    ),
    (src) => src.includes("export function frontModeOverrideRead()"),
  ],
  [
    "src/worker.ts",
    "the tick primes the mode cache from that read BEFORE the prefetch",
    lines(
      `        installTickProbe(scanner, {`,
      `          onTickStart: () => trade?.prefetchMode(),`,
    ),
    lines(
      `        installTickProbe(scanner, {`,
      `          onTickStart: () => {`,
      `            // ROUND 4 (§4.25): the override row already rode the tick-front`,
      `            // batch, so the cache is primed from it BEFORE the prefetch —`,
      `            // which is then a no-op, leaving this tick no mode read at all.`,
      `            // A front read that timed out, never happened, or is too old`,
      `            // leaves the ride null and the prefetch reads for itself (the`,
      `            // pre-round-4 shape: slower, never wrong).`,
      `            const ride = frontModeOverrideRead();`,
      `            if (ride !== null) trade?.primeModeOverride(ride.raw, ride.at);`,
      `            trade?.prefetchMode();`,
      `          },`,
    ),
    (src) => src.includes("trade?.primeModeOverride(ride.raw, ride.at)"),
  ],
  [
    "src/worker.ts",
    "/health's batch takes over the mode row (and hoists the reading)",
    lines(
      `      let lastScanGapMs: number | null = null;`,
      `      let tickProgress: unknown = null;`,
      `      try {`,
      `        // Both rows in ONE statement (see Db.getWorkerStates): the progress`,
      `        // record is the tick's own account of how far it got before its flush,`,
      `        // so a stale phase=scanning heartbeat can be READ together with the`,
      `        // reason it is stale (see TICK_PROGRESS_KEY).`,
      `        const rows = await db?.getWorkerStates(["scan_heartbeat", TICK_PROGRESS_KEY]);`,
      `        const raw = rows?.get("scan_heartbeat") ?? null;`,
      `        heartbeat = raw ? JSON.parse(raw) : null;`,
      `        const progressRaw = rows?.get(TICK_PROGRESS_KEY) ?? null;`,
      `        tickProgress = progressRaw ? JSON.parse(progressRaw) : null;`,
      `        const at = (heartbeat as { at?: number } | null)?.at;`,
      `        if (typeof at === "number") lastScanGapMs = Date.now() - at;`,
      `      } catch {`,
      `        heartbeat = null;`,
      `      }`,
    ),
    lines(
      `      let lastScanGapMs: number | null = null;`,
      `      let tickProgress: unknown = null;`,
      `      // The mode row rides the SAME statement (round 4, §4.25): /health used`,
      `      // to read it a SECOND time (Db.getTradeModeOverride) for a value this`,
      `      // request had already paid for. \`modeLanded\` is the reading-vs-missing`,
      `      // split the prime below needs: "read, row absent" is a real reading`,
      `      // (no override), "no reading at all" must not become one.`,
      `      let modeRaw: string | null = null;`,
      `      let modeReadAt = 0;`,
      `      let modeLanded = false;`,
      `      try {`,
      `        // All three rows in ONE statement (see Db.getWorkerStates): the`,
      `        // progress record is the tick's own account of how far it got before`,
      `        // its flush, so a stale phase=scanning heartbeat can be READ together`,
      `        // with the reason it is stale (see TICK_PROGRESS_KEY).`,
      `        const rows = await db?.getWorkerStates([`,
      `          "scan_heartbeat",`,
      `          TICK_PROGRESS_KEY,`,
      `          "trade_mode_override",`,
      `        ]);`,
      `        const raw = rows?.get("scan_heartbeat") ?? null;`,
      `        heartbeat = raw ? JSON.parse(raw) : null;`,
      `        const progressRaw = rows?.get(TICK_PROGRESS_KEY) ?? null;`,
      `        tickProgress = progressRaw ? JSON.parse(progressRaw) : null;`,
      `        const at = (heartbeat as { at?: number } | null)?.at;`,
      `        if (typeof at === "number") lastScanGapMs = Date.now() - at;`,
      `        if (rows) {`,
      `          modeRaw = rows.get("trade_mode_override") ?? null;`,
      `          modeReadAt = Date.now();`,
      `          modeLanded = true;`,
      `        }`,
      `      } catch {`,
      `        heartbeat = null;`,
      `      }`,
    ),
    (src) => src.includes('rows.get("trade_mode_override") ?? null;'),
  ],
  [
    "src/worker.ts",
    "/health's effective mode is answered from that same row",
    lines(
      `      // Effective trade mode: Telegram /setmode override wins over env.`,
      `      let effectiveTradeMode: string = cfg?.trade.mode ?? "off";`,
      `      let tradeModeOverride: string | null = null;`,
      `      try {`,
      `        effectiveTradeMode = (await trade?.effectiveMode()) ?? effectiveTradeMode;`,
      `        tradeModeOverride = (await db?.getTradeModeOverride()) ?? null;`,
      `      } catch {`,
      `        // telemetry only — never fail /health over the mode read`,
      `      }`,
    ),
    lines(
      `      // Effective trade mode: Telegram /setmode override wins over env. Both`,
      `      // numbers now come from the ONE row read above (round 4, §4.25):`,
      `      // \`tradeModeOverride\` is that raw value through the shared validation`,
      `      // (parseTradeModeOverride — the rule Db.getTradeModeOverride applies),`,
      `      // and a row this request actually read primes the service, so`,
      `      // effectiveMode is answered from it instead of paying a second round`,
      `      // trip for the very same row.`,
      `      let effectiveTradeMode: string = cfg?.trade.mode ?? "off";`,
      `      let tradeModeOverride: string | null = null;`,
      `      try {`,
      `        if (modeLanded) {`,
      `          trade?.primeModeOverride(modeRaw, modeReadAt);`,
      `          tradeModeOverride = parseTradeModeOverride(modeRaw);`,
      `        }`,
      `        effectiveTradeMode = (await trade?.effectiveMode()) ?? effectiveTradeMode;`,
      `      } catch {`,
      `        // telemetry only — never fail /health over the mode read`,
      `      }`,
    ),
    (src) => src.includes("tradeModeOverride = parseTradeModeOverride(modeRaw);"),
  ],
  [
    "src/worker.ts",
    "the db import carries the shared parser",
    `import { Db, parseScheduledTickRing, type ScheduledTickEntry } from "./db";`,
    `import {\n  Db,\n  parseScheduledTickRing,\n  parseTradeModeOverride,\n  type ScheduledTickEntry,\n} from "./db";`,
    (src) => src.includes("parseTradeModeOverride,\n  type ScheduledTickEntry,"),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
