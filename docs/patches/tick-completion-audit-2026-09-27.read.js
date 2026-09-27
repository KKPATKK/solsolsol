#!/usr/bin/env node
/*
 * READ-ONLY tick-delivery vs scan-completion audit.
 *
 * WHAT IT ANSWERS: "is the scan tick actually running every minute?" The cron
 * ARRIVAL ring (scheduled_tick_ring) and the durable delivery counter
 * (scheduled_tick_total) are written by the scheduled handler on every
 * delivery; the durable per-trigger counters (scan_trigger_cron/_http) and
 * scan_history are written only when a scan COMPLETES. Reading both sides
 * twice, `gapSeconds` apart, gives deliveries/min and completions/min on the
 * SAME clock, so a silent tick (arrival with no completion) is measured
 * rather than inferred.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs on worker_state + scan_history only.
 * Never touches /health or /debug/*, which are Worker invocations.
 *
 * Run: node docs/patches/tick-completion-audit-2026-09-27.read.js [gapSeconds]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db, parseScheduledTickRing } = require("../../dist/db.js");

const KEYS = [
  "scheduled_tick_total",
  "scheduled_tick_at",
  "scheduled_tick_ring",
  "scan_trigger_cron",
  "scan_trigger_http",
  "scan_trigger_manual",
  "scan_trigger_last_at",
  "scan_heartbeat",
  "skip_capture",
  "tick_progress",
  "scan_wedge",
  "push_watch_pass",
];

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");
const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function readSide(db) {
  const st = await db.getWorkerStates(KEYS);
  const hist = (await db.getScanHistory(400)).slice().sort((a, b) => a.at - b.at);
  return { st, hist };
}

async function main() {
  const gapSeconds = Number(process.argv[2] ?? 180);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const a = await readSide(db);
  const stateA = {
    ticks: num(a.st.get("scheduled_tick_total")),
    cron: num(a.st.get("scan_trigger_cron")),
    http: num(a.st.get("scan_trigger_http")),
    manual: num(a.st.get("scan_trigger_manual")),
    newestHistoryAt: a.hist.length ? a.hist[a.hist.length - 1].at : 0,
  };
  console.log(`sample A ${new Date().toISOString()}  ` +
    `deliveries ${stateA.ticks}  completions cron ${stateA.cron} http ${stateA.http} manual ${stateA.manual}`);
  console.log(`  heartbeat ${a.st.get("scan_heartbeat")?.slice(0, 160)}`);
  console.log(`  skip_capture ${a.st.get("skip_capture")}`);
  console.log(`  tick_progress ${a.st.get("tick_progress")}`);
  console.log(`  scan_wedge ${a.st.get("scan_wedge")}`);
  console.log(`  push_watch_pass ${a.st.get("push_watch_pass")?.slice(0, 200)}`);

  // Hourly completion census over everything the history read can see.
  const byHour = new Map();
  for (const r of a.hist) {
    const hour = new Date(r.at).toISOString().slice(11, 13);
    const e = byHour.get(hour) ?? { n: 0, ok: 0, errs: 0 };
    e.n += 1;
    if (r.ok) e.ok += 1;
    if (r.err) e.errs += 1;
    byHour.set(hour, e);
  }
  console.log(`\nHOURLY COMPLETIONS (${a.hist.length} rows, ` +
    `${iso(a.hist[0]?.at)} -> ${iso(a.hist[a.hist.length - 1]?.at)}Z):`);
  for (const [hour, e] of [...byHour.entries()].sort()) {
    console.log(`  ${hour}:00Z  n ${String(e.n).padStart(3)}  ok ${String(e.ok).padStart(3)}  err ${e.errs}`);
  }

  // Per-minute gap histogram inside the window covered by the newest 90 rows.
  const recent = a.hist.filter((r) => r.at >= Date.now() - 3 * 3600_000);
  const gaps = [];
  for (let i = 1; i < recent.length; i += 1) gaps.push((recent[i].at - recent[i - 1].at) / 1000);
  if (gaps.length) {
    const sorted = [...gaps].sort((x, y) => x - y);
    console.log(`\nLAST 3H: ${recent.length} completions, gap p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}s ` +
      `p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)}s max ${sorted[sorted.length - 1].toFixed(1)}s`);
  }

  await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  const b = await readSide(db);
  const dt = gapSeconds;
  const dBytes = {
    ticks: num(b.st.get("scheduled_tick_total")) - stateA.ticks,
    cron: num(b.st.get("scan_trigger_cron")) - stateA.cron,
    http: num(b.st.get("scan_trigger_http")) - stateA.http,
    manual: num(b.st.get("scan_trigger_manual")) - stateA.manual,
  };
  const newRows = b.hist.filter((r) => r.at > stateA.newestHistoryAt).length;
  const ring = parseScheduledTickRing(b.st.get("scheduled_tick_ring"));
  const arrivalsInWindow = ring.filter((t) => t > Date.now() - dt * 1000 - 5000).length;
  console.log(`\nsample B ${new Date().toISOString()}  over ${dt}s:`);
  console.log(`  cron deliveries    ${dBytes.ticks}  (${(dBytes.ticks * 60 / dt).toFixed(2)}/min)`);
  console.log(`  completions        cron ${dBytes.cron}  http ${dBytes.http}  manual ${dBytes.manual}  ` +
    `= ${dBytes.cron + dBytes.http + dBytes.manual} (${((dBytes.cron + dBytes.http + dBytes.manual) * 60 / dt).toFixed(2)}/min)`);
  console.log(`  new scan_history   ${newRows}`);
  console.log(`  ring arrivals in the same window ${arrivalsInWindow}`);
  console.log(`  ring entries ${ring.length}, newest ${iso(ring[ring.length - 1])}`);

  console.log(`\nNEW COMPLETIONS IN THE AUDIT WINDOW:`);
  for (const r of b.hist.filter((x) => x.at > stateA.newestHistoryAt)) {
    console.log(`  ${iso(r.at)}  ok ${r.ok ? 1 : 0} ms ${r.ms} profiles ${r.profiles} pool ${r.pool} ` +
      `pushed ${r.pushed}${r.err ? ` err ${r.err}` : ""}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
