/*
 * Anchored patch for the maintenance-cron split (2026-09-29) — the worker.ts
 * half. Same reason as the scanner script beside it: `str_replace` is stale on
 * this file. Every edit is guarded: a replacement already present is skipped,
 * a missing anchor throws, so re-running the script is safe and a partial
 * application can never pass silently.
 *
 * Run: node docs/patches/maintenance-cron-2026-09-29.worker.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(FILE, "utf8");
const before = src;

let applied = 0;
let skipped = 0;
function edit(label, anchor, replacement) {
  if (src.includes(replacement)) {
    skipped++;
    console.log(`  -- ${label} (already applied)`);
    return;
  }
  if (!src.includes(anchor)) throw new Error(`[${label}] anchor not found`);
  src = src.split(anchor).join(replacement);
  applied++;
  console.log(`  ok ${label}`);
}

edit(
  "MAINTENANCE_BUDGET_MS",
  `const TRACKER_PASS_BUDGET_MS = 5_000;`,
  `const TRACKER_PASS_BUDGET_MS = 5_000;
/**
 * Wall-clock budget for the maintenance invocation's whole job (see
 * MAINTENANCE_CRON and runMaintenanceInvocation).
 *
 * Its two legs are interval-gated (the Birdeye backfill hourly, the crime list
 * by its own TTL) and both are no-ops on almost every delivery, so the number
 * only has to cover the passes that DO work: the backfill walks up to ~4
 * six-hour Birdeye chunks and then writes one batch of token rows; the crime
 * refresh downloads and persists ~4.8K addresses. Neither is close to this,
 * and each leg is additionally raced against this deadline by its caller (see
 * Scanner.runMaintenanceJobs), so an upstream that hangs costs the pass its
 * remaining work and never the invocation.
 *
 * SIZED AGAINST THE ENVELOPE, not against the work: the cron invocation that
 * carries the scan is measured at ~9.6s before the runtime kills it, and this
 * delivery owns nothing else in that envelope. There is no reason to spend
 * more of it than a leg needs — a cut maintenance pass costs one interval of
 * freshness (the next delivery is 5 minutes away and every leg is idempotent).
 */
const MAINTENANCE_BUDGET_MS = 6_000;`,
);

edit(
  "MAINTENANCE_CRON + isMaintenanceCron",
  `export function isTrackerCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === TRACKER_CRON;
}`,
  `export function isTrackerCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === TRACKER_CRON;
}
/**
 * The MAINTENANCE delivery's own expression (see wrangler.toml and
 * runMaintenanceInvocation): the interval-gated, side-effect-only legs — the
 * Birdeye backfill and the crime-wallet refresh — moved out of the scan tick's
 * front phase and into an invocation of their own.
 *
 * WHY \`*/5\` AND NOT EVERY MINUTE: neither job wants a per-minute cadence (the
 * backfill's own gate is hourly, the crime list's TTL is longer), and the tick
 * pays for the legs it carries — the backfill spends up to its share of the
 * front phase on the hour it is due, inside the same window the pair fetch and
 * the gates need. Five minutes keeps both jobs' freshness identical to what
 * the tick delivered (their own gates, not the cron period, decide when they
 * run) while removing them from the minute the tick is trying to spend on
 * coins.
 *
 * WHY IT STILL NEEDS A FALLBACK, like the pass: this platform has silently
 * stopped delivering cron events to this Worker before (docs/uptime-monitor.md)
 * and this expression is new. The leg decision is therefore not the cron at
 * all — it is the row this invocation writes (scanner.
 * MAINTENANCE_PASS_STATE_KEY, riding the scan front's ONE read): a tick runs
 * the legs itself the moment that row is older than
 * scanner.MAINTENANCE_PASS_FALLBACK_FRESH_MS. A dead trigger costs freshness,
 * never a leg.
 *
 * \`event.cron\` carries the trigger's expression CHARACTER FOR CHARACTER (see
 * Cloudflare's scheduled-handler docs), so the comparison below is exact — and
 * with three triggers configured, a string neither predicate matches is a scan
 * tick, never a silently dropped delivery.
 */
export const MAINTENANCE_CRON = "*/5 * * * *";
/**
 * Pure: is this scheduled delivery the maintenance invocation's own?
 *
 * Same trim-only-the-outside rule as isTrackerCron, and for the same reason:
 * an expression whose INNER spacing differs is a trigger this Worker does not
 * claim, and defaulting it here would hand a stranger's delivery this budget
 * while its own routing stopped matching.
 */
export function isMaintenanceCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === MAINTENANCE_CRON;
}`,
);

edit(
  "runMaintenanceInvocation",
  `    console.error(
      "[worker] tracker delivery pass failed:",
      err instanceof Error ? err.message : err,
    );
  }
}`,
  `    console.error(
      "[worker] tracker delivery pass failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The maintenance delivery's own invocation (see MAINTENANCE_CRON and
 * wrangler.toml).
 *
 * WHAT IT DOES: init, then Scanner.runMaintenanceJobs with
 * MAINTENANCE_BUDGET_MS — the Birdeye periodic backfill and the crime-wallet
 * list refresh, both interval-gated, both side effects. Nothing the scan tick
 * owns is touched here: no scan lock, no cadence gate, no cron-arrival counter,
 * no heartbeat, no tick telemetry. That is deliberate and load-bearing — the
 * arrival counters and the cadence gate both compare SCAN arrivals, so a
 * delivery that never scans must not move them (the rule runTrackerInvocation
 * documents for the same reason).
 *
 * WHY THIS IS SAFE TO SPLIT AT ALL: neither leg's result is consumed by the
 * invocation that produced it. The backfill seeds unseen coins into token_stats
 * and the crime refresh persists the blocklist for the fleet to hydrate, so the
 * only thing that changes is WHICH invocation pays their wall clock — and the
 * scan tick, the one whose latency a reader can see, stops paying it.
 *
 * FAILURE SHAPE: logged, never rethrown, and the row goes unwritten — which is
 * exactly the signal the tick's fallback reads (scanner.
 * MAINTENANCE_PASS_FALLBACK_FRESH_MS), so a failing invocation ends with the
 * tick running the legs again rather than with the legs quietly stopping.
 */
async function runMaintenanceInvocation(env: Env): Promise<void> {
  const initAt = Date.now();
  await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init");
  preTick.steps.init = Date.now() - initAt;
  // No scanner = init failed or was cut. Nothing to do and nothing to record:
  // this delivery is not a scan arrival, and the row it would have written is
  // what tells the tick to fall back — which it will, on the next tick.
  if (!scanner) return;
  try {
    await scanner.runMaintenanceJobs(Date.now() + MAINTENANCE_BUDGET_MS);
  } catch (err) {
    console.error(
      "[worker] maintenance invocation failed:",
      err instanceof Error ? err.message : err,
    );
  }
}`,
);

edit(
  "pre-tick owner tag",
  `    beginPreTick(Date.now(), isTrackerCron(event.cron) ? "pass" : "scan");`,
  `    beginPreTick(
      Date.now(),
      isTrackerCron(event.cron)
        ? "pass"
        : isMaintenanceCron(event.cron)
          ? "maint"
          : "scan",
    );`,
);

edit(
  "scheduled routing",
  `    if (isTrackerCron(event.cron)) {
      await runTrackerInvocation(env);
      return;
    }`,
  `    if (isTrackerCron(event.cron)) {
      await runTrackerInvocation(env);
      return;
    }
    // THE MAINTENANCE DELIVERY (see MAINTENANCE_CRON): same shape and the same
    // reason as the pass above — it returns BEFORE scheduledTicks, the
    // cron-arrival stamp and the cadence gate, because all three count SCAN
    // arrivals. Its own liveness is the row it writes, and the tick's fallback
    // is what makes a missed delivery cost freshness instead of a leg.
    if (isMaintenanceCron(event.cron)) {
      await runMaintenanceInvocation(env);
      return;
    }`,
);

fs.writeFileSync(FILE, src);
console.log(
  `\nworker.ts: ${applied} applied, ${skipped} already present, ${src.length - before.length} bytes added`,
);
