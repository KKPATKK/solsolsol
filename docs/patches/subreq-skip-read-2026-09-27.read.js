#!/usr/bin/env node
/*
 * READ-ONLY `subreqSkip` rate + the tick's remaining subrequest count.
 *
 * WHY: the restored 60s cadence (docs/round-trips.md §4.42) immediately showed
 * `subreqSkip ["chain"]` on one tick — the scanner's own name for a leg it had
 * to drop because the invocation was running out of Workers Free's 50
 * subrequests. `scan_history` does NOT carry that field, so the rate can only be
 * measured by sampling the heartbeat per tick.
 *
 * THE ARITHMETIC THIS PRINTS (src/subreqs.ts + src/scanner.ts):
 *   usable  = SUBREQ_BUDGET_FREE(50) - SUBREQ_UNSEEN_ALLOWANCE(12) = 38
 *   left    = max(0, 38 - counted)
 *   drop    = dropOptionalLeg fires while left <= SCAN_SUBREQ_FLOOR(12)
 *           => every tick with counted >= 26 starts dropping optional legs
 *              (and, at the candidate stage, the `chain`)
 * so `counted` against 26 is the reading that says whether the tick is merely
 * near the ceiling or spending past it.
 *
 * The heartbeat is overwritten by every tick (claim = phase "scanning", flush =
 * phase "done"), so each sampling pass dedupes on `at|phase` and prints a line
 * per NEW tick: the flush row is the tick's whole spend, the claim row is its
 * pre-scan front. Run it for a few minutes: one run is ~2-3 ticks.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs on worker_state + scan_history. Never
 * touches /health or /debug/*, which are Worker invocations.
 *
 * Run: node docs/patches/subreq-skip-read-2026-09-27.read.js [samples] [gapSeconds]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const BUDGET = 50;
const UNSEEN = 12;
const FLOOR = 12;
const USABLE = BUDGET - UNSEEN;
/** counted at/above this starts dropping optional legs (see the header). */
const DROP_AT = USABLE - FLOOR;

const KEYS = ["scan_heartbeat", "tick_progress", "scan_trigger_cron", "scan_trigger_http"];

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");

async function main() {
  const samples = Number(process.argv[2] ?? 10);
  const gapSeconds = Number(process.argv[3] ?? 15);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const seen = new Set();
  const rows = [];
  for (let i = 0; i < samples; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
    const st = await db.getWorkerStates(KEYS);
    const raw = st.get("scan_heartbeat");
    if (!raw) continue;
    let hb;
    try {
      hb = JSON.parse(raw);
    } catch {
      continue;
    }
    const key = `${hb.at}|${hb.phase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = hb.summary ?? {};
    const counted = hb.subreqs?.current?.total ?? null;
    const left = counted === null ? null : Math.max(0, USABLE - counted);
    const skip = Array.isArray(s.subreqSkip) && s.subreqSkip.length ? s.subreqSkip.join(",") : "-";
    let progress = null;
    try {
      progress = JSON.parse(st.get("tick_progress") ?? "null");
    } catch {
      /* raw */
    }
    rows.push({ at: hb.at, phase: hb.phase, counted, left, skip, floor: s.subreqFloor ?? null });
    console.log(
      `${iso(hb.at)} ${String(hb.phase).padEnd(8)} via ${String(hb.via ?? "-").padEnd(5)} ` +
        `counted ${String(counted).padStart(2)} left ${String(left).padStart(2)} ` +
        `${left !== null && left <= FLOOR ? "IN-DROP-ZONE" : counted !== null && counted >= DROP_AT ? "at-ceiling" : "ok"}  ` +
        `subreqSkip ${skip}  floor ${s.subreqFloor ?? "-"}  ms ${hb.ms ?? "-"}  profiles ${s.profiles ?? "-"}` +
        (progress ? `  | tick_progress ${progress.stage} subreqs ${progress.subreqs} ms ${progress.ms}` : "") +
        `  | cron ${st.get("scan_trigger_cron")} http ${st.get("scan_trigger_http")}`,
    );
  }

  const done = rows.filter((r) => r.phase === "done" && r.counted !== null);
  const skipped = done.filter((r) => r.skip !== "-");
  console.log(`\ndone rows ${done.length}, with a dropped leg ${skipped.length}`);
  if (done.length) {
    const counts = done.map((r) => r.counted).sort((a, b) => a - b);
    const maybe = (v) => (v === undefined ? "-" : v);
    console.log(
      `counted min ${maybe(counts[0])} p50 ${maybe(counts[Math.floor(counts.length / 2)])} max ${maybe(counts[counts.length - 1])} ` +
        `(drop zone starts at ${DROP_AT}; every tick at/above it loses optional legs)`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
