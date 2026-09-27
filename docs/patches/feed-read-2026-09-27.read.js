#!/usr/bin/env node
/*
 * READ-ONLY per-feed + tick health: what the last completed scan's feed legs
 * actually did, straight from worker_state — no /health, no /debug (both are
 * Worker invocations that pay a tick's front reads).
 *
 * The heartbeat's summary carries one number per leg (`pump`, `geo`, …), the
 * makeup lane's counters (`feedMakeup`), the two clients' own state (`gecko`,
 * `gmgnFeed`) and DexScreener's cache counters (`dex`), all written with the
 * completion batch. Sampling it a few times shows which legs are answering.
 *
 * Run: node docs/patches/feed-read-2026-09-27.read.js        (one sample)
 *      node docs/patches/feed-read-2026-09-27.read.js 3 70   (3 samples, 70s apart)
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const KEYS = [
  "scan_heartbeat",
  "dex_profiles_last",
  "dex_list_cache_hits",
  "dex_list_cache_misses",
  "dex_list_cache_last",
  "skip_capture",
];

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");

async function sample(db) {
  const st = await db.getWorkerStates(KEYS);
  const raw = st.get("scan_heartbeat");
  if (!raw) {
    console.log("scan_heartbeat: (absent)");
    return;
  }
  const hb = JSON.parse(raw);
  const s = hb.summary ?? {};
  console.log(`--- ${new Date().toISOString()} ---`);
  console.log(
    `tick at ${iso(hb.at)} via ${hb.via ?? "-"} ok ${hb.ok ?? "-"} ms ${hb.ms ?? "-"} phase ${hb.phase ?? "-"}`,
  );
  console.log(
    `feeds  profiles ${s.profiles ?? "-"} (settled ${s.profilesSettled ?? "-"})  pump ${s.pump ?? "-"}` +
      `${s.pumpFallback ? " (fallback)" : ""}  boosts ${s.boosts ?? "-"}  jup ${s.jup ?? "-"}  jupTrend ${s.jupTrend ?? "-"}`,
  );
  console.log(
    `       geo ${s.geo ?? "-"}  geoTrend ${s.geoTrend ?? "-"}  gmgn ${s.gmgn ?? "-"}  meteora ${s.meteora ?? "-"}  axiom ${s.axiom ?? "-"}`,
  );
  console.log(`makeup ${JSON.stringify(s.feedMakeup ?? null)}`);
  console.log(`dex    ${JSON.stringify(s.dex ?? null)}`);
  console.log(`gecko  ${JSON.stringify(s.gecko ?? null)}`);
  console.log(`gmgn   ${JSON.stringify(s.gmgnFeed ?? null)}`);
  console.log(
    `rows   dex_profiles_last ${st.get("dex_profiles_last") ?? "-"}  cache hits/misses/last ` +
      `${st.get("dex_list_cache_hits") ?? "-"}/${st.get("dex_list_cache_misses") ?? "-"}/${st.get("dex_list_cache_last") ?? "-"}`,
  );
  console.log(`pool   ${s.pool ?? "-"}  candidates ${s.candidates ?? "-"}  pushed ${s.pushed ?? "-"}`);
  console.log(`skip   ${st.get("skip_capture") ?? "-"}`);
}

async function main() {
  const samples = Number(process.argv[2] ?? 1);
  const gapSeconds = Number(process.argv[3] ?? 70);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();
  for (let i = 0; i < samples; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
    await sample(db);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
