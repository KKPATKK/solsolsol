#!/usr/bin/env node
/*
 * The production tick's own telemetry, read WITHOUT the Worker's help.
 *
 * WHY THIS EXISTS. The tick's per-step readings (`dbSteps`, `modeRead`,
 * `preTick`) are published in the completion summary, which is durable — it
 * lands in worker_state.scan_heartbeat with the flush batch. The obvious way to
 * read them is /health, and that is exactly the way that lies: /health and
 * /debug/* are Worker invocations on the SAME isolate, they read the same
 * worker_state keys (`scan_heartbeat`, `trade_mode_override`, ...) through the
 * same per-isolate step counter, and `dbSteps` is MODULE state — so a probe
 * request can add the very round trips it is trying to count (or hide them, by
 * warming the override's cache before the tick's prefetch runs). Reading the
 * row from outside the Worker is the only reading that cannot move the number
 * it reports, which is the same reason scripts/cpu-profile.js refuses to write.
 *
 * READ-ONLY BY CONSTRUCTION: one SELECT of one row. No worker_state write, no
 * counter, no rotation slot, no uptime.
 *
 * Run: node scripts/read-heartbeat.js        (needs the .env.local Turso creds)
 *      node scripts/read-heartbeat.js 3 70   (3 samples, 70s apart)
 */
"use strict";

const { loadConfig } = require("../dist/config.js");
const { Db, SCHEMA_DDL_FINGERPRINT_KEY } = require("../dist/db.js");

/** Print one field, or a dash when the tick predates that reading. */
const show = (label, value) =>
  console.log(`  ${label}: ${value === undefined || value === null ? "-" : JSON.stringify(value)}`);

async function main() {
  const samples = Number(process.argv[2] ?? 1);
  const gapSeconds = Number(process.argv[3] ?? 70);
  const config = loadConfig(process.env);

  for (let i = 1; i <= samples; i++) {
    const db = new Db(config.tursoUrl, config.tursoAuthToken);
    // init() is required: Db.get() refuses to serve a read before it, so that a
    // query cannot run against a database the schema has not been checked
    // against. It is idempotent DDL plus, since the fingerprint gate on the
    // DDL is in place, one ~46-byte read on any database this Worker has
    // already initialized — the same cost one ordinary tick pays.
    await db.init();
    const raw = await db.getWorkerState("scan_heartbeat");
    if (!raw) {
      console.log(`sample ${i}: no heartbeat row yet`);
    } else {
      let hb;
      try {
        hb = JSON.parse(raw);
      } catch (err) {
        console.log(`sample ${i}: heartbeat unparseable — ${err.message}`);
        hb = null;
      }
      if (hb) {
        const s = hb.summary ?? {};
        console.log(
          `sample ${i} @ ${new Date(hb.at ?? 0).toISOString()}  ` +
            `ok=${hb.ok} phase=${hb.phase} ms=${hb.ms} ageS=${Math.round((Date.now() - (hb.at ?? 0)) / 1000)}`,
        );
        show("preTick.steps", s.preTick?.steps);
        show("preTick.preStartMs/preRaceMs/raceMs", [
          s.preTick?.preStartMs,
          s.preTick?.preRaceMs,
          s.preTick?.raceMs,
        ]);
        show("dbSteps", s.dbSteps);
        show("modeRead", s.modeRead);
        show("dbMs", s.dbMs);
      }
      if (hb) {
        // The DDL gate's own evidence (see SCHEMA_DDL_FINGERPRINT_KEY in
        // src/db.ts): this row is what lets the NEXT cold isolate skip the
        // 18-statement batch, and its value identifies the exact statement
        // list that database is stamped with. Absent = the gate is unarmed and
        // every isolate is still paying the batch; present = a recycled
        // isolate's init is one ~46-byte read instead.
        const fp = await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY);
        show("schema_ddl_fingerprint", fp);
      }
    }
    if (i < samples) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read-heartbeat failed:", err);
  process.exit(1);
});
