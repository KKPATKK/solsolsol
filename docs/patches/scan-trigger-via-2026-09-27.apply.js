#!/usr/bin/env node
/*
 * 2026-09-27 — the two cadence gates stop fighting, and every scan says who ran it.
 *
 * MEASURED FIRST (live 05:13-05:30Z, build 811eb44, read-only):
 *   `scheduled_tick_ring` (handler entry, one per minute) vs `scan_history`:
 *   of the 76 completions inside the ring's 90-minute window, 26 (34%) matched
 *   NO cron arrival. Twelve completed BEFORE the minute's tick arrived
 *   (provably the HTTP fallback); fourteen followed the arrival by 12-21s —
 *   a front that long cannot exist, and the 05:27:27 completion carried
 *   `subreqs.current.owner:"http"` (total 21) with the nearest arrival 19s
 *   before its race start. So the fallback is not the rare rescue its 60s
 *   threshold suggests, and the sequence is self-sustaining:
 *
 *     tick completes late (:2x)  ->  next tick's gate skips (age < 50s)
 *     ->  a ping finds a >=60s-old heartbeat and scans (http)
 *     ->  its completion arms the skip for the next tick  ->  ...
 *
 *   (Also measured: `scan_heartbeat.at` is the COMPLETION — the flush
 *   overwrites the claim's start stamp with `flushedAt` — so the earlier
 *   "dedupe uses the scan START" explanation was wrong; the driver is a late
 *   tick plus the fallback's margin-less 60s.)
 *
 * THREE CHANGES:
 *   1. The fallback becomes a real rescue: it may scan only when the last
 *      COMPLETED scan is >= max(120s, 2 x SCAN_INTERVAL_SECONDS) old — two
 *      missed cadences. A tick that is merely late scans for itself.
 *   2. The tick's gate margin becomes scanGateMs(): a 30s jitter budget when
 *      the interval is one cron period (the ring shows arrivals up to :29),
 *      shrinking to the room left above one cron period for longer intervals
 *      so 90s still skips every other tick.
 *   3. Every scan carries `via: "cron" | "http" | "manual"` as a PARAMETER
 *      into both heartbeats and the completion payload, and the completion
 *      batch increments a durable per-trigger counter (zero extra round
 *      trips). The front read publishes the counts to /health — so "how much
 *      of the scanning is actually cron" is a reading, not an inference.
 *
 * Run: node docs/patches/scan-trigger-via-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
let src = fs.readFileSync(path.join(root, "src", "worker.ts"), "utf8");
let db = fs.readFileSync(path.join(root, "src", "db.ts"), "utf8");
const notes = [];

/** Replace one exact anchor in "worker" or "db"; idempotent via a marker. */
function edit(file, name, find, next, marker) {
  const text = file === "worker" ? src : db;
  if (text.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = text.split(find).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  const patched = text.replace(find, next);
  if (file === "worker") src = patched;
  else db = patched;
  notes.push(` ✓ ${name} — patched`);
}

// ---------------------------------------------------------------------------
// 1. db.ts — the ScanTrigger vocabulary, the read-free counter statements and
//    the parser the front read publishes with.
// ---------------------------------------------------------------------------
edit(
  "db",
  "db: ScanTrigger + counter statements + parser",
  `/**
 * The cron-arrival bookkeeping that can ride a tick's claim batch (see
 * Db.scheduledTickStatements): the cron event time plus the ring to store.
 */
export interface ScheduledTickEntry {`,
  `/**
 * WHICH invocation ran a scan (2026-09-27, measured live): the cron tick and
 * the HTTP fallback both write scan_history rows with nothing to tell them
 * apart, and the fallback turned out to drive 26 of 76 completions (34%) in a
 * 90-minute window — so "cron stopped delivering" could not be read off the
 * history at all. The tag travels as a PARAMETER from the handler (never
 * module state: the pass's own delivery shares the isolate and overwrites
 * module-scope readings — a tick's done heartbeat published
 * \`subreqs.current.owner:"pass"\` on 2026-09-27), lands in the heartbeat's
 * \`via\`, and is counted durably by the statements below.
 */
export type ScanTrigger = "cron" | "http" | "manual";

/** The durable counter row per trigger (see scanTriggerStatements). */
export const SCAN_TRIGGER_COUNTER_KEYS: Record<ScanTrigger, string> = {
  cron: "scan_trigger_cron",
  http: "scan_trigger_http",
  manual: "scan_trigger_manual",
};

/** The counters as a key list, for the front read that publishes them. */
export const SCAN_TRIGGER_STATE_KEYS: readonly string[] = [
  SCAN_TRIGGER_COUNTER_KEYS.cron,
  SCAN_TRIGGER_COUNTER_KEYS.http,
  SCAN_TRIGGER_COUNTER_KEYS.manual,
];

/** The fleet-wide per-trigger scan counts (see parseScanTriggerCounts). */
export interface ScanTriggerCounts {
  cron: number;
  http: number;
  manual: number;
}

/**
 * Increment one trigger's counter as READ-FREE statements, on the same
 * discipline as scheduledTickStatements: they ride the completion batch the
 * tick already pays for (see persistScanCompletion), so attribution costs
 * ZERO extra round trips — and the row is durable, so it survives the isolate
 * that produced it.
 */
export function scanTriggerStatements(
  via: ScanTrigger,
): Array<{ sql: string; args: Array<string | number | null> }> {
  const key = SCAN_TRIGGER_COUNTER_KEYS[via];
  return [
    {
      // The row must exist before the UPDATE can increment it.
      sql: \`INSERT OR IGNORE INTO worker_state (key, value) VALUES ('\${key}', '0')\`,
      args: [],
    },
    {
      sql: \`UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = '\${key}'\`,
      args: [],
    },
  ];
}

/**
 * The counters out of a worker_state map (see SCAN_TRIGGER_STATE_KEYS). A
 * missing, unparseable or negative value reads as 0 — telemetry must never
 * make a caller throw (same discipline as parseScheduledTickRing).
 */
export function parseScanTriggerCounts(
  states: Map<string, string> | null | undefined,
): ScanTriggerCounts {
  const read = (key: string): number => {
    const raw = states?.get(key) ?? null;
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  return {
    cron: read(SCAN_TRIGGER_COUNTER_KEYS.cron),
    http: read(SCAN_TRIGGER_COUNTER_KEYS.http),
    manual: read(SCAN_TRIGGER_COUNTER_KEYS.manual),
  };
}

/**
 * The cron-arrival bookkeeping that can ride a tick's claim batch (see
 * Db.scheduledTickStatements): the cron event time plus the ring to store.
 */
export interface ScheduledTickEntry {`,
  "export type ScanTrigger =",
);

edit(
  "db",
  "db: persistScanCompletion counts the trigger",
  `     * ran without a lock (fail-open claim error).
     */
    scanLockValue: string | null = null,
  ): Promise<void> {`,
  `     * ran without a lock (fail-open claim error).
     */
    scanLockValue: string | null = null,
    /**
     * Which invocation ran the scan (see ScanTrigger). When given, the matching
     * counter increments IN THIS BATCH — the attribution rides the round trip
     * the flush already pays, and it commits in the same transaction that
     * publishes the completion, so a completion that lands is a completion that
     * is counted. Null = do not count (heartbeat-only flushes are not scans).
     */
    via: ScanTrigger | null = null,
  ): Promise<void> {`,
  "via: ScanTrigger | null = null,",
);

edit(
  "db",
  "db: the counter statement rides the completion batch",
  `    if (scanLockValue) {
      ops.push({
        sql: "DELETE FROM worker_state WHERE key = 'scan_lock' AND value = ?",
        args: [scanLockValue],
      });
    }
    if (history) {`,
  `    if (scanLockValue) {
      ops.push({
        sql: "DELETE FROM worker_state WHERE key = 'scan_lock' AND value = ?",
        args: [scanLockValue],
      });
    }
    if (via !== null && history !== null) {
      // Attribution rides the flush (see ScanTrigger): zero extra round trips,
      // and only a completion that is being written is counted.
      ops.push(...scanTriggerStatements(via));
    }
    if (history) {`,
  // The retry patch (scan-trigger-via-retry-2026-09-27.apply.js) rewrites the
  // statement to carry the completion's `at`; either shape means this edit is
  // already in place.
  "scanTriggerStatements(via,",
);

// ---------------------------------------------------------------------------
// 2. worker.ts — imports, the trigger vocabulary, and the mirror.
// ---------------------------------------------------------------------------
edit(
  "worker",
  "worker: db imports",
  `import {
  Db,
  parseScheduledTickRing,
  parseTelemetryCounter,
  parseTradeModeOverride,
  telemetryCounterUsable,
  type ScheduledTickEntry,
} from "./db";`,
  `import {
  Db,
  SCAN_TRIGGER_STATE_KEYS,
  parseScanTriggerCounts,
  parseScheduledTickRing,
  parseTelemetryCounter,
  parseTradeModeOverride,
  telemetryCounterUsable,
  type ScanTrigger,
  type ScanTriggerCounts,
  type ScheduledTickEntry,
} from "./db";`,
  "type ScanTriggerCounts,",
);

edit(
  "worker",
  "worker: rescue gap helpers",
  `/** Minimum gap between fallback scans triggered from the fetch path. */
// How often the HTTP-triggered fallback scan may fire. Cron (1/min) is the
// primary driver; 60s keeps the fallback from double-scanning during
// healthy cron delivery while still self-healing within ~1 minute if cron
// stops (observed 2026-08-14: cron dead for 24h+, fallback kept the bot
// alive; observed 2026-09-03: a ~4-min cron delivery pause produced a
// heartbeat freeze + outage alert because no request arrived in the
// window — tightened from 120s so any webhook/monitor request rescues
// sooner. The heartbeat-freshness check below still dedupes against
// healthy cron, so the effective cadence stays 1/min when cron works).
const SCAN_TRIGGER_INTERVAL_MS = 60_000;`,
  `/** Minimum gap between fallback scans triggered from the fetch path. */
// How often the HTTP-triggered fallback may LOOK. Cron (1/min) is the primary
// driver, and since 2026-09-27 the fallback is a RESCUE rather than a cadence
// participant: this 60s still bounds how often a request may check, but the
// scan itself now needs the heartbeat to be scanRescueGapMs stale — two missed
// cadences. The old 60s heartbeat check let the fallback fire into EVERY minute
// whose tick was merely late: measured live 05:13-05:30Z (cron ring vs
// scan_history), 26 of 76 completions in 90 minutes were the fallback's, i.e.
// the "cron tick" a reader sees in scan_history was one in three times an HTTP
// invocation — and each of those scans armed the next tick's gate skip.
//
// WHY NOT SHORTER (the 2026-08-14 dead-cron case, and the 2026-09-03 ~4-min
// delivery pause): a genuinely dead cron is still rescued within ~2 minutes,
// which is the same window the outage alert uses; the cost of waiting one extra
// cadence is bounded, and the cost of firing early is the loop above.
const SCAN_TRIGGER_INTERVAL_MS = 60_000;
/**
 * The cron period both trigger expressions share (\`* * * * *\` /
 * \`*/1 * * * *\` in wrangler.toml). Named because the cadence gate's margin
 * must leave the gate strictly above ONE period for any interval larger than
 * it — that is what keeps 90/120 skipping alternate ticks.
 */
export const SCAN_CRON_PERIOD_MS = 60_000;
/**
 * The fallback's rescue threshold: how stale the last COMPLETED scan must be
 * before an HTTP request may run the scan itself. Two missed cadences, with a
 * 120s floor so the 60s default needs 120s. "Two" is the point: a tick which
 * is merely late (<1 cadence) still scans for itself, and the fallback only
 * engages once that has already failed.
 */
export const SCAN_RESCUE_MIN_GAP_MS = 120_000;
/** The fallback's threshold for a configured scan interval (see above). */
export function scanRescueGapMs(scanGapMs: number): number {
  return Math.max(SCAN_RESCUE_MIN_GAP_MS, scanGapMs * 2);
}`,
  "export const SCAN_RESCUE_MIN_GAP_MS = 120_000;",
);

edit(
  "worker",
  "worker: scanGateMs replaces the flat margin",
  `/**
 * Slack allowed between two scans beyond SCAN_INTERVAL_SECONDS when the
 * cadence gate compares against the previous tick's CLAIM time. The gate is
 * \`now - heartbeat.at >= scanGapMs\`, and \`at\` is written by the claim batch
 * ~1-4s AFTER cron fires — so a strict 60s gate measures ~56-58s on the
 * next tick and systematically skips it (live evidence 2026-09-07:
 * scan_history gaps of 121-122s, heartbeat 86s stale while a tick had
 * fired 28s earlier — every other tick silently did nothing). The margin
 * covers the claim offset + cron delivery jitter; overlap safety is the
 * scan lock's job (CAS claim, 55s TTL), not the gate's. With the margin,
 * SCAN_INTERVAL_SECONDS=60 scans on EVERY tick; 90/120 still gate to
 * every-other / every-third tick (gaps 60 < 80 < 120). Set generously:
 * a margin up to ~20s cannot double-scan (the previous scan releases the
 * lock at claim+~15s and a second trigger loses the CAS claim).
 */
const SCAN_GATE_MARGIN_MS = 10_000;`,
  `/**
 * The cadence gate's jitter budget: slack the configured interval gets before
 * the gate refuses a tick. The gate is \`now - heartbeat.at >= gateMs\`, and
 * \`at\` is the previous scan's COMPLETION (the completion flush overwrites the
 * claim's start stamp with \`flushedAt\`), so what the gate measures is
 * completion-to-entry of the next tick. The old flat 10s margin was sized for
 * the claim offset alone (2026-09-07: a strict comparison skipped every other
 * tick) and cannot absorb dispatch jitter: measured 2026-09-27 from the cron
 * ring, 18 of 90 arrivals landed at :10 or later, up to :29 — and every late
 * completion (:2x) was followed by a ~100s hole, because the next tick read
 * age ~35-45s and skipped.
 *
 * WHY NOT 30s FOR EVERY INTERVAL: for an interval longer than one cron period
 * the gate IS the cadence knob — 90s is implemented by skipping every other
 * 1-minute tick, which needs the gate strictly above 60s (90 - 20 = 70; with a
 * full 30s margin it would land exactly on 60 and the setting would silently
 * become 60s). So the margin shrinks to whatever room is left above one period.
 *
 * Overlap safety is the scan lock's job (CAS claim + TTL), not the gate's: a
 * margin this size can never start a scan on top of a live one.
 */
export const SCAN_GATE_JITTER_MS = 30_000;
/** Never let the gate land right on one cron period (see scanGateMs). */
export const SCAN_GATE_MIN_MARGIN_MS = 10_000;
/**
 * The cadence gate's threshold for a configured scan interval: scan when the
 * last COMPLETION is at least this old. Pure and exported so the two modes this
 * file must keep working — "scan on every tick" at the 60s default and "skip
 * every other tick" at 90s — are asserted in tests instead of watched live.
 */
export function scanGateMs(scanGapMs: number): number {
  const interval = Math.max(SCAN_CRON_PERIOD_MS, scanGapMs);
  if (interval === SCAN_CRON_PERIOD_MS) {
    return interval - SCAN_GATE_JITTER_MS;
  }
  const room = interval - SCAN_CRON_PERIOD_MS - SCAN_GATE_MIN_MARGIN_MS;
  return interval - Math.min(SCAN_GATE_JITTER_MS, Math.max(0, room));
}`,
  "export function scanGateMs(scanGapMs: number): number {",
);

edit(
  "worker",
  "worker: gate uses scanGateMs",
  `    // Gate against the CLAIM time minus the jitter margin (see
    // SCAN_GATE_MARGIN_MS): the heartbeat's \`at\` lands 1-4s after cron
    // fires, so a strict \`scanGapMs\` comparison skips every other tick at
    // the 60s cadence (2026-09-07 live: 121s history gaps). The scan lock,
    // not this gate, prevents overlapping scans.
    const gateMs = scanGapMs - SCAN_GATE_MARGIN_MS;`,
  `    // Gate against the previous COMPLETION minus the jitter budget (see
    // scanGateMs): a strict \`scanGapMs\` comparison skips a tick whenever the
    // previous scan landed late (2026-09-27 live: every :2x completion was
    // followed by a ~100s hole), so the margin exists to let this tick CATCH
    // UP instead of losing its minute. The scan lock, not this gate, prevents
    // overlapping scans.
    const gateMs = scanGateMs(scanGapMs);`,
  "const gateMs = scanGateMs(scanGapMs);",
);

// ---------------------------------------------------------------------------
// 3. worker.ts — the fallback becomes a rescue.
// ---------------------------------------------------------------------------
edit(
  "worker",
  "worker: fallback waits out a late tick",
  `  // Dedupe against a healthy cron: skip when a scan already completed
  // recently (the heartbeat is written at scan completion). The fallback
  // exists to rescue a DEAD cron, not to double the scan rate — every extra
  // scan doubles the Turso rows-read and the upstream API pressure (which
  // is what triggers the gecko 429s). When cron delivers, this makes the
  // effective cadence exactly the configured 60s instead of ~1.5x it.
  // The heartbeat read doubles as the backfill input for runScan (a dead
  // predecessor's stale scanning heartbeat) — pass it down so the tick
  // adds no extra round trip on the wall-clock-critical path.
  let hbRaw: string | null = null;
  try {`,
  `  // Dedupe against a healthy cron: skip unless the last COMPLETED scan is
  // TWO missed cadences old (see scanRescueGapMs). The heartbeat's \`at\` is
  // the completion time (the flush overwrites the claim's start stamp), so a
  // tick that is merely late — the normal shape of a skipped minute — still
  // holds the heartbeat well inside the rescue gap and scans for ITSELF.
  // The fallback exists to rescue a DEAD cron, not to take over a late tick:
  // at the old one-cadence threshold it did exactly that (26 of 76 completions
  // in a measured 90-minute window), and each rescue then armed the next
  // tick's skip.
  // The heartbeat read doubles as the backfill input for runScan (a dead
  // predecessor's stale scanning heartbeat) — pass it down so the tick
  // adds no extra round trip on the wall-clock-critical path.
  let hbRaw: string | null = null;
  // The rescue threshold in the configured cadence (same arithmetic as the
  // cron gate): a 90s deployment needs 180s of silence before a request takes
  // the scan over.
  const scanGapMs = Math.max(
    SCAN_CRON_PERIOD_MS,
    (cfg?.scanIntervalSeconds ?? 60) * 1000,
  );
  const rescueGapMs = scanRescueGapMs(scanGapMs);
  try {`,
  "const rescueGapMs = scanRescueGapMs(scanGapMs);",
);

edit(
  "worker",
  "worker: the rescue threshold is what the dedupe compares",
  `    const at = hbRaw ? ((JSON.parse(hbRaw) as { at?: number } | null)?.at ?? 0) : 0;
    if (typeof at === "number" && now - at < SCAN_TRIGGER_INTERVAL_MS) return;`,
  `    const at = hbRaw ? ((JSON.parse(hbRaw) as { at?: number } | null)?.at ?? 0) : 0;
    if (typeof at === "number" && now - at < rescueGapMs) return;`,
  "now - at < rescueGapMs",
);

edit(
  "worker",
  "worker: the fallback tags itself http",
  `  beginSubreqWindow(now, "http");
  try {
    await runScan(hbRaw, env);`,
  `  beginSubreqWindow(now, "http");
  try {
    await runScan(hbRaw, env, null, "http");`,
  'await runScan(hbRaw, env, null, "http");',
);

// ---------------------------------------------------------------------------
// 4. worker.ts — `via` travels as a parameter into both heartbeats and the
//    completion payload.
// ---------------------------------------------------------------------------
edit(
  "worker",
  "worker: runScan takes the trigger",
  `  cronTick?: ScheduledTickEntry | null,
): Promise<void> {
  if (!scanner) return;`,
  `  cronTick?: ScheduledTickEntry | null,
  /**
   * Which invocation runs this scan (see Db.ScanTrigger): "cron" for the
   * scheduled tick, "http" for the fallback, "manual" for /debug/tick. It is
   * stamped as \`via\` into both heartbeats and the completion payload, and the
   * completion batch counts it durably (Db.scanTriggerStatements) — the ONE
   * reading that answers "how much of the scanning is actually cron".
   *
   * A PARAMETER, never module state: the pass's own delivery lands on this same
   * isolate and overwrites module-scope readings (measured 2026-09-27: a tick's
   * done heartbeat published \`subreqs.current.owner:"pass"\`, the pass
   * invocation's window). Attribution read at flush time would name the wrong
   * owner; a local cannot.
   */
  via: ScanTrigger = "cron",
): Promise<void> {
  if (!scanner) return;
  const scanVia: ScanTrigger = via;`,
  "const scanVia: ScanTrigger = via;",
);

edit(
  "worker",
  "worker: the scanning heartbeat carries via",
  `  const heartbeatJson = JSON.stringify({
    at: startedAt,
    ok: true,
    phase: "scanning",`,
  `  const heartbeatJson = JSON.stringify({
    at: startedAt,
    // Which invocation ran this scan (see runScan's \`via\`): the /health
    // reading that tells a fallback rescue apart from a cron tick.
    via: scanVia,
    ok: true,
    phase: "scanning",`,
  "via: scanVia,\n    ok: true,\n    phase: \"scanning\",",
);

edit(
  "worker",
  "worker: the scanning heartbeat publishes the counters",
  `    pushLedger: pushLedgerMirror,
  });
  preTick.steps.json = Date.now() - heartbeatAt;`,
  `    pushLedger: pushLedgerMirror,
    // Fleet-wide per-trigger scan counts (see Db.scanTriggerStatements), as of
    // this invocation's front read. The completion batch increments them, so
    // this value is one completed scan behind — the same lag the deferral
    // snapshot above documents.
    scanTriggers: scanTriggerMirror,
  });
  preTick.steps.json = Date.now() - heartbeatAt;`,
  "scanTriggers: scanTriggerMirror,\n  });\n  preTick.steps.json",
);

edit(
  "worker",
  "worker: the done heartbeat carries via and the counters",
  `      const buildFlushPayload = () =>
        JSON.stringify({
            at: flushedAt,
            ok: lastScanOk,
            phase: "done",`,
  `      const buildFlushPayload = () =>
        JSON.stringify({
            at: flushedAt,
            // Who ran this scan (see runScan's \`via\`) — the done heartbeat is
            // what /health serves between ticks, so the attribution rides it
            // too, not only the scanning row.
            via: scanVia,
            ok: lastScanOk,
            phase: "done",`,
  'via: scanVia,\n            ok: lastScanOk,\n            phase: "done",',
);

edit(
  "worker",
  "worker: the done heartbeat publishes the counters",
  `            pushLedger: pushLedgerMirror,
            summary,
          });`,
  `            pushLedger: pushLedgerMirror,
            // See the scanning heartbeat above: the counts lag one completed
            // scan behind the row this very flush is about to write.
            scanTriggers: scanTriggerMirror,
            summary,
          });`,
  "scanTriggers: scanTriggerMirror,\n            summary,",
);

edit(
  "worker",
  "worker: the completion batch counts the trigger",
  `          scanLock,
        ) ?? Promise.resolve();`,
  `          scanLock,
          // Durable attribution: the counter increments in the SAME batch (zero
          // extra round trips) and is published by the next invocation's front
          // read — so "cron vs fallback" survives this isolate and never
          // depends on module state (see runScan's \`via\`).
          scanVia,
        ) ?? Promise.resolve();`,
  "scanVia,\n        ) ?? Promise.resolve();",
);

// ---------------------------------------------------------------------------
// 5. worker.ts — the mirror + the front read that feeds it.
// ---------------------------------------------------------------------------
edit(
  "worker",
  "worker: boot keys carry the counters",
  `export const BOOT_STATE_KEYS = [
  "axiom_access_token",
  PUSH_DEFERRAL_STATE_KEY,
  PUSH_LEDGER_STATE_KEY,
  SKIP_CAPTURE_STATE_KEY,
];`,
  `export const BOOT_STATE_KEYS = [
  "axiom_access_token",
  PUSH_DEFERRAL_STATE_KEY,
  PUSH_LEDGER_STATE_KEY,
  SKIP_CAPTURE_STATE_KEY,
  // The per-trigger scan counters ride the front statement (and this list's
  // fallback read) so a recycled isolate can answer "cron vs fallback" before
  // it has any reading of its own — same discipline as the three mirrors above.
  ...SCAN_TRIGGER_STATE_KEYS,
];`,
  "...SCAN_TRIGGER_STATE_KEYS,",
);

edit(
  "worker",
  "worker: the trigger mirror",
  `export function frontModeOverrideRead(): { raw: string | null; at: number } | null {
  const seen = lastCronKeysRead;
  if (seen === null || seen.map === null) return null;
  if (Date.now() - seen.at > HEARTBEAT_REUSE_MS) return null;
  return { raw: seen.map.get("trade_mode_override") ?? null, at: seen.at };
}`,
  `export function frontModeOverrideRead(): { raw: string | null; at: number } | null {
  const seen = lastCronKeysRead;
  if (seen === null || seen.map === null) return null;
  if (Date.now() - seen.at > HEARTBEAT_REUSE_MS) return null;
  return { raw: seen.map.get("trade_mode_override") ?? null, at: seen.at };
}

/**
 * The fleet-wide per-trigger scan counts (see Db.ScanTriggerCounts) as of the
 * last completed scan this isolate knows about. Two writers keep it fresh: the
 * per-invocation front read (\`ensureInitialized\`, which already asks for these
 * keys) and the boot block's mirror prime on a cold isolate. It lags the scan
 * being reported by exactly one completion — the increment commits with that
 * scan's own flush batch — which is the same "as of the last confirmed write"
 * discipline the deferral snapshot documents.
 */
let scanTriggerMirror: ScanTriggerCounts = { cron: 0, http: 0, manual: 0 };`,
  "let scanTriggerMirror: ScanTriggerCounts =",
);

edit(
  "worker",
  "worker: the front read refreshes the mirror",
  `      lastBootKeysRead = { map: kb, at: now };
      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);`,
  `      lastBootKeysRead = { map: kb, at: now };
      // The per-trigger scan counts ride the SAME statement (see
      // SCAN_TRIGGER_STATE_KEYS): /health reads "cron vs fallback" from a read
      // the invocation already paid for, on every invocation, warm or cold.
      if (kb) {
        scanTriggerMirror = parseScanTriggerCounts(kb);
      }
      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);`,
  "scanTriggerMirror = parseScanTriggerCounts(kb);",
);

edit(
  "worker",
  "worker: the boot block primes the mirror on a cold isolate",
  `            try {
              skipCaptureMirror = parseSkipCaptureState(
                bootStates.get(SKIP_CAPTURE_STATE_KEY) ?? null,
              );
            } catch {
              // telemetry only — never fail init over a counter read
            }`,
  `            try {
              skipCaptureMirror = parseSkipCaptureState(
                bootStates.get(SKIP_CAPTURE_STATE_KEY) ?? null,
              );
            } catch {
              // telemetry only — never fail init over a counter read
            }
            // Same for the per-trigger scan counts (see SCAN_TRIGGER_STATE_KEYS
            // / scanTriggerMirror): a recycled isolate answers "how much of the
            // scanning is actually cron" with the durable totals instead of
            // zeros until its front read refreshes them.
            try {
              scanTriggerMirror = parseScanTriggerCounts(bootStates);
            } catch {
              // telemetry only — never fail init over a counter read
            }`,
  "scanTriggerMirror = parseScanTriggerCounts(bootStates);",
);

// ---------------------------------------------------------------------------
// 6. worker.ts — the remaining call sites name their trigger.
// ---------------------------------------------------------------------------
edit(
  "worker",
  "worker: /debug/tick tags its scan manual",
  `      const t0 = Date.now();
      await runScan(undefined, env);`,
  `      const t0 = Date.now();
      await runScan(undefined, env, null, "manual");`,
  'await runScan(undefined, env, null, "manual");',
);

edit(
  "worker",
  "worker: the scheduled tick tags itself cron",
  `      await runScan(hbRaw, env, cronTick);`,
  `      await runScan(hbRaw, env, cronTick, "cron");`,
  'await runScan(hbRaw, env, cronTick, "cron");',
);

fs.writeFileSync(path.join(root, "src", "worker.ts"), src);
fs.writeFileSync(path.join(root, "src", "db.ts"), db);
for (const note of notes) console.log(note);
console.log(`\n${notes.filter((n) => n.startsWith(" ✓")).length} patched, ${notes.filter((n) => n.startsWith(" =")).length} already applied`);
