#!/usr/bin/env node
/*
 * READ-ONLY: dump `scan_history` rows for a time window, WITH the failure text.
 *
 * WHY: the no-completion alert (worker.ts ~2940) fires on the OK completions —
 * a tick that COMPLETES but throws records `ok 0` + `err`, so from the alert's
 * point of view nothing landed for as long as the errors lasted (live
 * 2026-09-28 00:33-00:53Z: 12 `err` rows, alert at 00:43Z). `scan_history` is
 * the only place that keeps the message, and the audit probe prints `err` only
 * for rows newer than its first sample.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs on scan_history + worker_state only. Never
 * touches /health or /debug/*, which are Worker invocations.
 *
 * Run: node docs/patches/scan-err-read-2026-09-28.read.js [hoursBack=2] [maxRows=60]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const iso = (ms) => (ms ? new Date(ms).toISOString() : "-");

async function main() {
  const hoursBack = Number(process.argv[2] ?? 2);
  const maxRows = Number(process.argv[3] ?? 60);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();
  const since = Date.now() - hoursBack * 3600_000;
  const hist = await db.getScanHistory(400);
  const rows = hist
    .filter((r) => Number(r.at) >= since)
    .sort((a, b) => a.at - b.at);

  console.log(`now ${new Date().toISOString()}  rows ${rows.length} in the last ${hoursBack}h`);
  const errs = rows.filter((r) => !r.ok || r.err);
  console.log(`\nFAILED completions (ok 0 / err set): ${errs.length}`);
  for (const r of errs.slice(-maxRows)) {
    console.log(`  ${iso(r.at)}  ms ${r.ms}  profiles ${r.profiles}  pool ${r.pool}  ` +
      `candidates ${r.candidates}  pushed ${r.pushed}  err ${r.err}`);
  }
  if (process.argv[4] === "all") {
    console.log(`\nALL rows (oldest first):`);
    for (const r of rows) {
      console.log(`  ${iso(r.at).slice(11, 19)}  ${r.ok && !r.err ? "OK " : "ERR"}  ms ${r.ms}  ` +
        `profiles ${r.profiles}  pool ${r.pool}`);
    }
  }
  const gapBefore = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].at - rows[i - 1].at;
    if (gap > 150_000) gapBefore.push({ at: rows[i].at, gap });
  }
  console.log(`\nGAPS > 150s in the window: ${gapBefore.length}`);
  for (const g of gapBefore.slice(-10)) {
    console.log(`  ${iso(g.at)}  +${(g.gap / 1000).toFixed(1)}s`);
  }
  const lastOk = [...rows].reverse().find((r) => r.ok && !r.err);
  console.log(`\nnewest OK completion: ${lastOk ? iso(lastOk.at) : "(none in window)"}`);
  console.log(`newest row: ${rows.length ? iso(rows[rows.length - 1].at) : "(none)"}`);
  if (errs.length) {
    const uniq = [...new Set(errs.map((r) => String(r.err)))];
    console.log(`\nDISTINCT error messages: ${uniq.length}`);
    for (const m of uniq) console.log(`  - ${m}`);
  }
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
