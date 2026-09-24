#!/usr/bin/env node
/**
 * Pre-init cron-arrival stamp (2026-09-24).
 *
 * WHY: every arrival record the worker keeps is reachable only PAST init — the
 * claim batch carries it (Db.scheduledTickStatements) and each path that cannot
 * reach a claim writes it on its own — so a tick killed inside init records
 * nothing at all, and a stretch of them reads from /health exactly like "the
 * Cron Trigger stopped delivering". The live sample (2026-09-23 21:41-00:07Z)
 * shows what that costs: the durable ring froze for 19 minutes (23:43:26 ->
 * 00:02:26Z) and again for 2h42m (20:21:26 -> 23:03:26Z) while scans kept
 * landing every ~70s (the HTTP monitor's fallback), and the counter moved
 * 54_546 (13:46Z) -> 54_846 (23:56Z) over a 10h window, i.e. about half of the
 * expected beats were never recorded. The successor-tick recovery can prove an
 * arrival reached the heartbeat READ; nothing could prove the delivery itself.
 *
 * WHAT: one read-free batch (counter incremented in SQL + the caller's clock),
 * written BEFORE ensureInitialized, and only for an arrival this isolate has no
 * completed scheduled tick to point at (cold, or whose predecessor never
 * returned). A healthy warm isolate pays nothing; a dying isolate stamps every
 * arrival it receives, because its flag cannot move until a tick returns.
 *
 * An apply script because both files sit past the file-tool window; every
 * anchor must match exactly once or nothing is written.
 */
const fs = require("fs");

const lines = (...xs) => xs.join("\n");

// ---------------------------------------------------------------- src/db.ts --
const DB_ANCHOR = lines(
  "  async writeScheduledTick(entry: ScheduledTickEntry): Promise<void> {",
  '    await this.get().batch(this.scheduledTickStatements(entry), "write");',
  "  }",
  "",
);

const DB_METHOD = lines(
  DB_ANCHOR,
  "  /**",
  "   * The PRE-INIT cron-arrival stamp: one write and NO read, issued BEFORE",
  "   * ensureInitialized, so an arrival still leaves a trace when the tick dies",
  "   * inside init.",
  "   *",
  "   * WHY (2026-09-24, live): the arrival bookkeeping rides the scan-lock claim",
  "   * (see scheduledTickStatements) and every path that cannot reach a claim",
  "   * writes it on its own — but ALL of them are reachable only AFTER init. A",
  "   * tick killed inside init therefore records nothing, and a stretch of them",
  "   * reads exactly like \"the Cron Trigger stopped delivering\": the sampled ring",
  "   * froze for 19 minutes (2026-09-23 23:43:26 -> 00:02:26Z) and again for 2h42m",
  "   * (20:21:26 -> 23:03:26Z) while scans kept landing every ~70s (the HTTP",
  "   * monitor's fallback), and the durable counter moved 54_546 (13:46Z) ->",
  "   * 54_846 (23:56Z) over a 10h window — about HALF of the expected beats were",
  "   * never recorded. The successor-tick recovery can only prove an arrival",
  "   * reached the heartbeat read; nothing could prove the delivery itself.",
  "   *",
  "   * Cost: ONE subrequest (Workers Free counts Turso's HTTP requests) and NO",
  "   * read — the counter increments in SQL and the timestamp is the caller's",
  "   * clock, which is exactly the shape the 2026-09-23 §1 cut removed from the",
  "   * normal path (a fresh raw client's read AND write per tick, `bump",
  "   * 564-2211ms` live). The worker calls it only for an arrival whose",
  "   * predecessor never returned (see shouldStampArrival), so a healthy warm",
  "   * isolate pays nothing for it.",
  "   */",
  "  async stampScheduledArrival(at: number): Promise<void> {",
  "    await this.get().batch(",
  "      [",
  "        {",
  '          sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES (\'scheduled_arrival_total\', \'0\')",',
  "          args: [],",
  "        },",
  "        {",
  '          sql: "UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = \'scheduled_arrival_total\'",',
  "          args: [],",
  "        },",
  "        {",
  '          sql: "INSERT INTO worker_state (key, value) VALUES (\'scheduled_arrival_at\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",',
  "          args: [String(at)],",
  "        },",
  "      ],",
  '      "write",',
  "    );",
  "  }",
  "",
);

// ------------------------------------------------------------ src/worker.ts --
const WORKER_FLAG_ANCHOR = lines(
  "let scheduledTicks = 0;",
  "let scanRunning = false;",
);

const WORKER_FLAG = lines(
  "let scheduledTicks = 0;",
  "/**",
  " * Wall-clock of the last scheduled tick that RETURNED in this isolate (0 =",
  " * none since it booted). The witness behind the pre-init arrival stamp (see",
  " * shouldStampArrival): a tick killed inside init never reaches its own tail,",
  " * so this isolate's memory is the cheap signal that says \"the arrival I am",
  " * looking at follows a delivery that never returned\" — the one shape the",
  " * claim-riding arrival bookkeeping (Db.scheduledTickStatements) cannot record,",
  " * because recording it needs a claim. Only the scheduled handler moves it: the",
  " * HTTP fallback drives ticks too, but a CRON arrival is what this stamp is a",
  " * witness of.",
  " */",
  "let scheduledTickFinishedAt = 0;",
  "let scanRunning = false;",
);

const RULE_ANCHOR = lines(
  "/**",
  " * Cron-arrival bookkeeping through a standalone raw client — the pre-2026-09-23",
);

const RULE = lines(
  "/**",
  " * How stale `scheduledTickFinishedAt` may be before the next arrival is stamped",
  " * before init. Every scheduled tick returns within ~5-10s of its arrival (scan",
  " * + flush + tracker pass, or one cadence-gate skip) and the trigger fires every",
  " * 60s, so 90s is one cadence of slack for jitter: a healthy warm isolate stamps",
  " * nothing, while an isolate whose last tick died stamps EVERY arrival it then",
  " * receives — the flag cannot move again until a tick returns, which is what",
  " * makes a wedge's deliveries countable instead of invisible.",
  " */",
  "export const SCHEDULED_ARRIVAL_SUSPECT_GAP_MS = 90_000;",
  "/**",
  " * Bound on the pre-init stamp (see recoveryAwait). The stamp sits in FRONT of",
  " * init on exactly the ticks whose front is already suspect, so it may never be",
  " * allowed to spend the envelope it exists to observe: a bounded-away stamp is",
  " * left running (the write is idempotent) and costs the tick nothing.",
  " */",
  "const PRE_INIT_ARRIVAL_BOUND_MS = 1_500;",
  "",
  "/**",
  " * Whether this arrival must be stamped before init: true when this isolate has",
  " * no completed scheduled tick to point at (cold, or one that never returned).",
  " * Pure and exported so the rule is unit-tested (scripts/test-unit.js) instead of",
  " * only observed live — a 0 flag means \"never finished here\", NOT \"finished at",
  " * the epoch\", and the export exists for the same reason",
  " * deadTickRebuildDecision's does.",
  " */",
  "export function shouldStampArrival(",
  "  lastFinishedAt: number,",
  "  now: number,",
  "  gapMs: number = SCHEDULED_ARRIVAL_SUSPECT_GAP_MS,",
  "): boolean {",
  "  if (!Number.isFinite(lastFinishedAt) || lastFinishedAt <= 0) return true;",
  "  return now - lastFinishedAt > gapMs;",
  "}",
  "",
  "/**",
  " * Cron-arrival bookkeeping through a standalone raw client — the pre-2026-09-23",
);

const STAMP_ANCHOR = lines(
  "    const cronAt = Date.now();",
  "    const initAt = Date.now();",
  "    await ensureInitialized(env);",
);

const STAMP = lines(
  "    const cronAt = Date.now();",
  "    // PRE-INIT ARRIVAL STAMP (see shouldStampArrival / Db.stampScheduledArrival).",
  "    // Every other arrival record is reachable only past init — the claim batch",
  "    // carries it, and each path that cannot reach a claim writes it on its own —",
  "    // so a tick killed inside init leaves no trace and reads from /health",
  "    // exactly like \"cron stopped delivering\" (measured 2026-09-23: a 19-minute",
  "    // ring hole and a 2h42m one, with scans still landing from the HTTP monitor).",
  "    // This stamp is written BEFORE init, on the arrivals whose predecessor never",
  "    // returned, so the two causes can be told apart afterwards.",
  "    if (shouldStampArrival(scheduledTickFinishedAt, cronAt)) {",
  "      try {",
  "        // The module handle is null on a cold isolate (init has not built it",
  "        // yet), which is why the fallback builds one the same way",
  "        // bumpScheduledTickLegacy does. Either way: one write, no read.",
  "        const stamp =",
  "          db !== null",
  "            ? db.stampScheduledArrival(cronAt)",
  "            : env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN",
  "              ? new Db(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN).stampScheduledArrival(",
  "                  cronAt,",
  "                )",
  "              : null;",
  "        if (stamp) {",
  '          await recoveryAwait(stamp, PRE_INIT_ARRIVAL_BOUND_MS, "cron arrival stamp");',
  "        }",
  "      } catch (err) {",
  "        // The stamp must never cost the tick: this is the path a dying tick",
  "        // takes, and the stamp is the only thing it is here to leave behind.",
  "        console.error(",
  '          "[worker] pre-init cron arrival stamp failed:",',
  "          err instanceof Error ? err.message : err,",
  "        );",
  "      }",
  "    }",
  "    const initAt = Date.now();",
  "    await ensureInitialized(env);",
);

const NO_SCANNER_ANCHOR = lines(
  "    if (!scanner) {",
  "      preTick.steps.bump = await bumpScheduledTickLegacy(env);",
  "      return;",
  "    }",
);

const NO_SCANNER = lines(
  "    if (!scanner) {",
  "      preTick.steps.bump = await bumpScheduledTickLegacy(env);",
  "      scheduledTickFinishedAt = Date.now();",
  "      return;",
  "    }",
);

const SKIP_ANCHOR = lines(
  "        // A skipped tick still ARRIVED — record it (ONE write, no read).",
  "        try {",
  "          await db?.writeScheduledTick(cronTick);",
  "        } catch (err) {",
  '          console.error("[worker] skipped-tick cron bookkeeping failed:", err);',
  "        }",
  "        return;",
);

const SKIP = lines(
  "        // A skipped tick still ARRIVED — record it (ONE write, no read).",
  "        try {",
  "          await db?.writeScheduledTick(cronTick);",
  "        } catch (err) {",
  '          console.error("[worker] skipped-tick cron bookkeeping failed:", err);',
  "        }",
  "        // A SKIP is a return: this arrival is accounted for (its own write",
  "        // went out above), so the next arrival needs no pre-init stamp.",
  "        scheduledTickFinishedAt = Date.now();",
  "        return;",
);

const TAIL_ANCHOR = lines(
  "    scanRunning = true;",
  "    try {",
  "      await runScan(hbRaw, env, cronTick);",
  "    } finally {",
  "      scanRunning = false;",
  "    }",
  "  },",
  "};",
);

const TAIL = lines(
  "    scanRunning = true;",
  "    try {",
  "      await runScan(hbRaw, env, cronTick);",
  "    } finally {",
  "      scanRunning = false;",
  "    }",
  "    // The tick RETURNED: this isolate's newest scheduled arrival is accounted",
  "    // for, which is the flag that keeps the pre-init stamp off the next one",
  "    // (see shouldStampArrival). Set LAST on purpose — a tick that dies anywhere",
  "    // above leaves the flag where it was, and that stale flag IS the witness.",
  "    scheduledTickFinishedAt = Date.now();",
  "  },",
  "};",
);

const HEALTH_VARS_ANCHOR = lines(
  "      let scheduledTickTotal: number | null = null;",
  "      let scheduledTickAt: number | null = null;",
  "      let enabledChats: number | null = null;",
);

const HEALTH_VARS = lines(
  "      let scheduledTickTotal: number | null = null;",
  "      let scheduledTickAt: number | null = null;",
  "      let scheduledArrivalTotal: number | null = null;",
  "      let scheduledArrivalAt: number | null = null;",
  "      let enabledChats: number | null = null;",
);

const HEALTH_READ_ANCHOR = lines(
  '        const rawTotal = await db?.getWorkerState("scheduled_tick_total");',
  '        const rawAt = await db?.getWorkerState("scheduled_tick_at");',
  "        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
  "        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
  "        enabledChats = (await db?.listEnabledChats())?.length ?? null;",
);

const HEALTH_READ = lines(
  "        // The two arrival records in ONE read (was two): the claim-riding",
  "        // counter/timestamp, plus the PRE-INIT stamp (see the scheduled",
  "        // handler). Reading them together is what makes the pair comparable —",
  "        // `scheduledArrivalAt > scheduledTickAt` means the newest cron delivery",
  "        // never accounted for itself, i.e. the tick died in front of its claim.",
  "        const tickState = await db?.getWorkerStates([",
  '          "scheduled_tick_total",',
  '          "scheduled_tick_at",',
  '          "scheduled_arrival_total",',
  '          "scheduled_arrival_at",',
  "        ]);",
  '        const rawTotal = tickState?.get("scheduled_tick_total") ?? null;',
  '        const rawAt = tickState?.get("scheduled_tick_at") ?? null;',
  '        const rawArrivalTotal = tickState?.get("scheduled_arrival_total") ?? null;',
  '        const rawArrivalAt = tickState?.get("scheduled_arrival_at") ?? null;',
  "        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
  "        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
  "        scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;",
  "        scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;",
  "        enabledChats = (await db?.listEnabledChats())?.length ?? null;",
);

const HEALTH_JSON_ANCHOR = lines(
  "        scheduledTicks,",
  "        scheduledTickTotal,",
  "        scheduledTickAt: scheduledTickAt",
  "          ? new Date(scheduledTickAt).toISOString()",
  "          : null,",
  "        enabledChats,",
);

const HEALTH_JSON = lines(
  "        scheduledTicks,",
  "        scheduledTickTotal,",
  "        scheduledTickAt: scheduledTickAt",
  "          ? new Date(scheduledTickAt).toISOString()",
  "          : null,",
  "        // Pre-init arrival stamps (see Db.stampScheduledArrival): the counter",
  "        // only moves for an arrival whose predecessor never returned, so a",
  "        // rising total WHILE scheduledTickAt stands still is the \"cron is",
  "        // delivering and the ticks die in front of their claim\" reading.",
  "        scheduledArrivalTotal,",
  "        scheduledArrivalAt: scheduledArrivalAt",
  "          ? new Date(scheduledArrivalAt).toISOString()",
  "          : null,",
  "        scheduledArrivalUnaccounted:",
  "          scheduledArrivalAt !== null &&",
  "          (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),",
  "        enabledChats,",
);

const HISTORY_VARS_ANCHOR = lines(
  "        let ring: number[] = [];",
  "        let scheduledTickTotal: number | null = null;",
  "        let scheduledTickAt: number | null = null;",
  "        let outageAlertAt: number | null = null;",
);

const HISTORY_VARS = lines(
  "        let ring: number[] = [];",
  "        let scheduledTickTotal: number | null = null;",
  "        let scheduledTickAt: number | null = null;",
  "        let scheduledArrivalTotal: number | null = null;",
  "        let scheduledArrivalAt: number | null = null;",
  "        let outageAlertAt: number | null = null;",
);

const HISTORY_READ_ANCHOR = lines(
  '          const rawRing = await db?.getWorkerState("scheduled_tick_ring");',
  "          if (rawRing) {",
  "            const parsed = JSON.parse(rawRing) as unknown;",
  "            if (Array.isArray(parsed)) {",
  '              ring = parsed.filter((v): v is number => typeof v === "number");',
  "            }",
  "          }",
  '          const rawTotal = await db?.getWorkerState("scheduled_tick_total");',
  '          const rawAt = await db?.getWorkerState("scheduled_tick_at");',
  '          const rawAlert = await db?.getWorkerState("outage_alert_at");',
  '          const rawPass = await db?.getWorkerState("push_watch_pass");',
  "          scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
  "          scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
  "          outageAlertAt = rawAlert ? Number(rawAlert) : null;",
  "          pushWatchPass = rawPass ? JSON.parse(rawPass) : null;",
);

const HISTORY_READ = lines(
  "          // ONE read for all of these (was five subrequests): this page is the",
  "          // forensics tool for the arrival question below, so the pre-init stamp",
  "          // belongs here next to the ring it explains.",
  "          const state = await db?.getWorkerStates([",
  '            "scheduled_tick_ring",',
  '            "scheduled_tick_total",',
  '            "scheduled_tick_at",',
  '            "scheduled_arrival_total",',
  '            "scheduled_arrival_at",',
  '            "outage_alert_at",',
  '            "push_watch_pass",',
  "          ]);",
  '          const rawRing = state?.get("scheduled_tick_ring") ?? null;',
  "          if (rawRing) {",
  "            const parsed = JSON.parse(rawRing) as unknown;",
  "            if (Array.isArray(parsed)) {",
  '              ring = parsed.filter((v): v is number => typeof v === "number");',
  "            }",
  "          }",
  '          const rawTotal = state?.get("scheduled_tick_total") ?? null;',
  '          const rawAt = state?.get("scheduled_tick_at") ?? null;',
  '          const rawArrivalTotal = state?.get("scheduled_arrival_total") ?? null;',
  '          const rawArrivalAt = state?.get("scheduled_arrival_at") ?? null;',
  '          const rawAlert = state?.get("outage_alert_at") ?? null;',
  '          const rawPass = state?.get("push_watch_pass") ?? null;',
  "          scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
  "          scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
  "          scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;",
  "          scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;",
  "          outageAlertAt = rawAlert ? Number(rawAlert) : null;",
  "          pushWatchPass = rawPass ? JSON.parse(rawPass) : null;",
);

const HISTORY_JSON_ANCHOR = lines(
  "          pushWatchPass,",
  "          scheduledTickTotal,",
  "          scheduledTickAt: scheduledTickAt",
  "            ? new Date(scheduledTickAt).toISOString()",
  "            : null,",
  "          // Newest first; a missing minute here while scan rows exist is",
  '          // the cross-check for "cron delivered but ticks died".',
);

const HISTORY_JSON = lines(
  "          pushWatchPass,",
  "          scheduledTickTotal,",
  "          scheduledTickAt: scheduledTickAt",
  "            ? new Date(scheduledTickAt).toISOString()",
  "            : null,",
  "          // The pre-init arrival stamps: the ring can only record an arrival",
  "          // that reached a claim, so a ring hole is ambiguous on its own —",
  "          // `scheduledArrivalTotal` rising while the ring stands still is the",
  "          // half that says the delivery happened (see",
  "          // Db.stampScheduledArrival).",
  "          scheduledArrivalTotal,",
  "          scheduledArrivalAt: scheduledArrivalAt",
  "            ? new Date(scheduledArrivalAt).toISOString()",
  "            : null,",
  "          scheduledArrivalUnaccounted:",
  "            scheduledArrivalAt !== null &&",
  "            (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),",
  "          // Newest first; a missing minute here while scan rows exist is",
  '          // the cross-check for "cron delivered but ticks died".',
);

const PATCHES = [
  ["src/db.ts", DB_ANCHOR, DB_METHOD, "Db.stampScheduledArrival"],
  ["src/worker.ts", WORKER_FLAG_ANCHOR, WORKER_FLAG, "scheduledTickFinishedAt flag"],
  ["src/worker.ts", RULE_ANCHOR, RULE, "shouldStampArrival + bounds"],
  ["src/worker.ts", STAMP_ANCHOR, STAMP, "pre-init stamp call"],
  ["src/worker.ts", NO_SCANNER_ANCHOR, NO_SCANNER, "flag on the !scanner return"],
  ["src/worker.ts", SKIP_ANCHOR, SKIP, "flag on the cadence-gate skip return"],
  ["src/worker.ts", TAIL_ANCHOR, TAIL, "flag at the tick's end"],
  ["src/worker.ts", HEALTH_VARS_ANCHOR, HEALTH_VARS, "/health arrival vars"],
  ["src/worker.ts", HEALTH_READ_ANCHOR, HEALTH_READ, "/health grouped read"],
  ["src/worker.ts", HEALTH_JSON_ANCHOR, HEALTH_JSON, "/health arrival pair"],
  ["src/worker.ts", HISTORY_VARS_ANCHOR, HISTORY_VARS, "/debug/scan-history vars"],
  ["src/worker.ts", HISTORY_READ_ANCHOR, HISTORY_READ, "/debug/scan-history grouped read"],
  ["src/worker.ts", HISTORY_JSON_ANCHOR, HISTORY_JSON, "/debug/scan-history arrival pair"],
];

// Every file is loaded once, all anchors are verified against the CURRENT text
// before anything is written: a partial patch is the one state that must not
// exist (a stamp with no reader, or a counter with no writer).
const files = new Map();
for (const file of new Set(PATCHES.map((p) => p[0]))) {
  files.set(file, fs.readFileSync(file, "utf8"));
}

if (files.get("src/db.ts").includes("stampScheduledArrival")) {
  console.error("ALREADY   the pre-init arrival stamp is applied");
  process.exit(1);
}

let failed = false;
for (const [file, anchor, , what] of PATCHES) {
  const text = files.get(file);
  const at = text.indexOf(anchor);
  if (at < 0) {
    console.error(`MISS      ${file}: ${what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${file}: ${what}`);
    failed = true;
  }
}
if (failed) process.exit(1);

for (const [file, anchor, replacement] of PATCHES) {
  const text = files.get(file);
  files.set(file, text.replace(anchor, replacement));
}
for (const [file, text] of files) fs.writeFileSync(file, text);
console.log(`ok        ${PATCHES.length} anchors applied across ${files.size} files`);
