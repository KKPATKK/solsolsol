#!/usr/bin/env node
/*
 * READ-ONLY drain health: what the deferred-write tail has been doing, and
 * whether the durable failure row (write_drain_error) is live or history.
 *
 * WHY: the deferred writes (recordTokenStatsMany / updateTokenMaxMcaps) ride
 * the invocation tail, so their failures are invisible in scan_history. The
 * scan summary carries `writeDrain` (calls/ms/failures/totals) and the durable
 * worker_state row carries the LAST failure with its `pending`; together they
 * separate "a stalled write right now" from "a row nobody could clear".
 *
 * READ-ONLY: one SELECT of worker_state. Never touches /health or /debug/*.
 *
 * Run: node docs/patches/drain-read-2026-09-27.read.js
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const STALE_MS = 10 * 60_000; // WRITE_DRAIN_ERROR_STALE_MS

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");

async function main() {
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const now = Date.now();
  const states = await db.getWorkerStates([
    "scan_heartbeat",
    "write_drain_error",
    "push_watch_pass",
  ]);

  console.log(`now ${new Date(now).toISOString()}`);

  const raw = states.get("write_drain_error");
  if (raw === undefined) {
    console.log("write_drain_error: (absent)");
  } else if (raw === "") {
    console.log("write_drain_error: (cleared — empty string)");
  } else {
    try {
      const err = JSON.parse(raw);
      const age = now - Number(err.at);
      console.log(
        `write_drain_error: ${err.method} — ${err.name}: ${err.message}\n` +
          `  at ${iso(err.at)} (${Math.round(age / 60000)} min old)  pending ${err.pending}  ` +
          `${age > STALE_MS ? "STALE (history)" : "LIVE"}`,
      );
    } catch {
      console.log(`write_drain_error: unparseable ${String(raw).slice(0, 200)}`);
    }
  }

  for (const key of ["scan_heartbeat", "push_watch_pass"]) {
    const row = states.get(key);
    if (!row) {
      console.log(`${key}: (absent)`);
      continue;
    }
    let hb;
    try {
      hb = JSON.parse(row);
    } catch {
      console.log(`${key}: unparseable`);
      continue;
    }
    console.log(`${key}: at ${iso(hb.at)} phase ${hb.phase ?? "-"} via ${hb.via ?? "-"}`);
    const s = hb.summary ?? null;
    if (s) {
      console.log(`  summary: dbMs ${s.dbMs ?? "-"} dbDegraded ${s.dbDegraded ?? "-"} ms ${s.ms ?? "-"}`);
      console.log(`  writeDrain: ${JSON.stringify(s.writeDrain ?? null)}`);
      if (s.dbTickSteps) {
        const top = Object.entries(s.dbTickSteps)
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 6)
          .map(([k, v]) => `${k} ${v.calls}/${v.ms}ms`);
        console.log(`  dbTickSteps top: ${top.join(", ")}`);
      }
      if (s.deferral) console.log(`  deferral: ${JSON.stringify(s.deferral)}`);
      if (s.subreqs) console.log(`  subreqs: ${JSON.stringify(s.subreqs)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
