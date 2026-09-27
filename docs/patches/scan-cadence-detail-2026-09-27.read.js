#!/usr/bin/env node
/*
 * READ-ONLY cadence detail for the 2026-09-27 anomaly (07:39-08:11: a 2-minute
 * cadence where every other cron tick left no trace at all).
 *
 * The summary probe answers "how many"; this one prints the per-event detail so
 * a gap can be attributed by hand:
 *   - the cron arrival ring (scheduled_tick_ring), one entry per handler entry
 *   - every scan_history completion with ok/ms/profiles/pool
 *   - the durable skip_capture row (which layer returned, and how often)
 *   - the two heartbeats that carry `via`
 *
 * READ-ONLY BY CONSTRUCTION: two SELECTs (worker_state, scan_history). Never
 * touches /health or /debug/*, which are Worker invocations.
 *
 * Run: node docs/patches/scan-cadence-detail-2026-09-27.read.js [minutes]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db, parseScheduledTickRing } = require("../../dist/db.js");

const iso = (ms) => (ms === null || ms === undefined ? "-" : new Date(ms).toISOString().slice(11, 19));

async function main() {
  const minutes = Number(process.argv[2] ?? 45);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const now = Date.now();
  const from = now - minutes * 60_000;
  const states = await db.getWorkerStates([
    "scan_trigger_cron",
    "scan_trigger_http",
    "scan_trigger_manual",
    "scan_trigger_last_at",
    "scheduled_tick_ring",
    "scan_heartbeat",
    "skip_capture",
    "push_watch_pass",
    "tick_progress",
    "scan_wedge",
    "write_drain_error",
  ]);

  const ring = parseScheduledTickRing(states.get("scheduled_tick_ring") ?? null).filter((t) => t >= from);
  const hist = (await db.getScanHistory(240))
    .filter((r) => r.at >= from)
    .sort((a, b) => a.at - b.at);

  console.log(`now ${new Date(now).toISOString()}  window last ${minutes}m (from ${iso(from)})`);
  console.log(
    `counters: cron ${states.get("scan_trigger_cron")}  http ${states.get("scan_trigger_http")}  ` +
      `manual ${states.get("scan_trigger_manual")}  last ${iso(Number(states.get("scan_trigger_last_at") ?? 0))}`,
  );
  for (const key of ["scan_heartbeat", "push_watch_pass"]) {
    try {
      const hb = JSON.parse(states.get(key) ?? "null");
      if (!hb) continue;
      console.log(
        `${key}: at ${iso(hb.at)} phase ${hb.phase ?? "-"} via ${hb.via ?? "-"} ok ${hb.ok ?? "-"} ` +
          `scanTriggers ${JSON.stringify(hb.scanTriggers ?? null)}`,
      );
    } catch {
      console.log(`${key}: unparseable`);
    }
  }
  for (const key of ["skip_capture", "tick_progress", "scan_wedge", "write_drain_error"]) {
    const raw = states.get(key);
    if (raw === undefined) {
      console.log(`${key}: (absent)`);
      continue;
    }
    try {
      console.log(`${key}: ${JSON.stringify(JSON.parse(raw))}`);
    } catch {
      console.log(`${key}: raw ${String(raw).slice(0, 300)}`);
    }
  }

  console.log(`\nARRIVALS (${ring.length}):`);
  for (let i = 0; i < ring.length; i += 1) {
    const gap = i === 0 ? "" : ` (+${((ring[i] - ring[i - 1]) / 1000).toFixed(1)}s)`;
    console.log(`  ${iso(ring[i])}${gap}`);
  }

  console.log(`\nCOMPLETIONS (${hist.length}):`);
  let prev = null;
  for (const r of hist) {
    const gap = prev === null ? "" : `  gap ${((r.at - prev) / 1000).toFixed(1)}s`;
    // "arrival in the 50s before it" is the cron signature measured in data.
    const cron = ring.some((a) => a <= r.at && r.at - a <= 50_000);
    console.log(
      `  ${iso(r.at)}${gap}  ok ${r.ok ? 1 : 0} ms ${r.ms} profiles ${r.profiles ?? "-"} ` +
        `pool ${r.pool ?? "-"} pushed ${r.pushed ?? "-"} ${cron ? "cron?" : "NO ARRIVAL"}` +
        (r.err ? `  err ${r.err}` : ""),
    );
    prev = r.at;
  }

  const arrivalsWithNoCompletion = ring.filter(
    (a) => !hist.some((r) => r.at >= a && r.at - a <= 50_000) && now - a > 60_000,
  );
  console.log(
    `\narrivals older than 60s with no completion within 50s: ${arrivalsWithNoCompletion.length}` +
      (arrivalsWithNoCompletion.length ? `\n  ${arrivalsWithNoCompletion.map(iso).join(", ")}` : ""),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
