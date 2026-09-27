#!/usr/bin/env node
/*
 * READ-ONLY DexScreener pressure + profiles trend.
 *
 * WHY: right after the 60s cron cadence came back (2026-09-27 23:07Z, see
 * docs/round-trips.md §4.42) two completions reported `profiles 3` where the
 * whole evening had read 24-26, and the same ticks showed `dex http429 6` with
 * `blockedForMs 30514`. Those are the documented signals for the 250ms dispatch
 * spacing / DEXSCREENER_BOOSTS_LIMIT knobs (wrangler.toml), so the question is
 * whether the feed is being rate-limited (transient) or actually thin — and the
 * answer needs a TREND, not one sample:
 *
 *   - `scan_history` carries `profiles` per completion, so the last N rows are
 *     the trend, with `ms` next to it (a 429 block shows up as a longer tick);
 *   - the heartbeat's `summary.dex` is the client's own account
 *     (`http429` / `blockedForMs` / `dropsByLeg`), `summary.subreqSkip` names
 *     any leg the tick had to drop for budget, and `dex429Total` is this
 *     isolate's 429 count;
 *   - `dex_profiles_last` (head written with the completion batch) dates the
 *     feed itself, `dex_list_cache_*` is the shared list cache's hit rate;
 *   - `dex_429_total` / `dex_429_at` / `dex_429_ring` is the FLEET-wide episode
 *     counter (`db.bumpDex429`), which is the only reading that covers 429s
 *     taken by other isolates — its ring is printed as a per-minute histogram
 *     so "a few now" and "sustained" can be told apart.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs on worker_state + scan_history only. Never
 * touches /health or /debug/*, which are Worker invocations.
 *
 * Run: node docs/patches/dex-pressure-read-2026-09-27.read.js [samples] [gapSeconds]
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
  "tick_progress",
  "dex_429_total",
  "dex_429_at",
  "dex_429_ring",
];

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");

async function sample(db) {
  const st = await db.getWorkerStates(KEYS);
  const hist = (await db.getScanHistory(24)).slice().sort((a, b) => a.at - b.at);
  console.log(`--- ${new Date().toISOString()} ---`);

  console.log("completions (oldest first):");
  for (const r of hist) {
    console.log(
      `  ${iso(r.at)}  ms ${String(r.ms).padStart(5)}  profiles ${String(r.profiles ?? "-").padStart(3)}  ` +
        `pool ${String(r.pool ?? "-").padStart(4)}  pushed ${r.pushed ?? "-"}${r.err ? `  err ${r.err}` : ""}`,
    );
  }

  const raw = st.get("scan_heartbeat");
  if (!raw) {
    console.log("scan_heartbeat: (absent)");
    return;
  }
  const hb = JSON.parse(raw);
  const s = hb.summary ?? {};
  console.log(
    `heartbeat ${iso(hb.at)} via ${hb.via ?? "-"} ok ${hb.ok} ms ${hb.ms} | ` +
      `profiles ${s.profiles ?? "-"} (settled ${s.profilesSettled ?? "-"}) boosts ${s.boosts ?? "-"} ` +
      `pump ${s.pump ?? "-"}${s.pumpFallback ? " (fallback)" : ""} jup ${s.jup ?? "-"} geo ${s.geo ?? "-"}`,
  );
  console.log(`  subreqSkip ${JSON.stringify(s.subreqSkip ?? null)}  dex429Total ${hb.dex429Total ?? "-"}`);
  console.log(`  dex   ${JSON.stringify(s.dex ?? null)}`);
  console.log(
    `  feedMs ${s.feedsMs ?? "-"}  preFeedMs ${s.preFeedMs ?? "-"}  poolMs ${s.poolMs ?? "-"}  ` +
      `evalMs ${s.evalMs ?? "-"}  subreqs ${JSON.stringify(hb.subreqs?.current?.total ?? null)}`,
  );
  const list = st.get("dex_profiles_last");
  let listAt = "-";
  let listN = "-";
  try {
    const parsed = JSON.parse(list ?? "null");
    listAt = iso(parsed?.at);
    listN = Array.isArray(parsed?.tokens) ? parsed.tokens.length : "-";
  } catch {
    /* raw */
  }
  console.log(
    `  dex_profiles_last at ${listAt} tokens ${listN}  list cache ` +
      `${st.get("dex_list_cache_hits") ?? "-"}/${st.get("dex_list_cache_misses") ?? "-"}/${st.get("dex_list_cache_last") ?? "-"}`,
  );
  const ring = (() => {
    try {
      const parsed = JSON.parse(st.get("dex_429_ring") ?? "null");
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "number") : [];
    } catch {
      return [];
    }
  })();
  const byMinute = new Map();
  for (const at of ring) {
    const minute = new Date(at).toISOString().slice(11, 16);
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + 1);
  }
  console.log(
    `  dex_429 fleet total ${st.get("dex_429_total") ?? "-"} at ${iso(Number(st.get("dex_429_at") ?? 0))} ` +
      `| ring ${ring.length} entries, per minute: ${[...byMinute.entries()]
        .slice(-12)
        .map(([m, n]) => `${m}=${n}`)
        .join(" ")}`,
  );
  console.log(`  tick_progress ${st.get("tick_progress")}`);
  console.log(`  skip_capture ${st.get("skip_capture")}`);
}

async function main() {
  const samples = Number(process.argv[2] ?? 1);
  const gapSeconds = Number(process.argv[3] ?? 60);
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
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
