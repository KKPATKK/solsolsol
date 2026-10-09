/*
 * How many ROWS-READ the re-eval pool's read actually costs.
 *
 * WHY THIS EXISTS. The pool band query's ORDER BY is an EXPRESSION
 * (COALESCE(max_mcap_observed, 0), COALESCE(first_m5_vol, 0), then the rotation
 * tie break), so no index can satisfy it: SQLite visits the whole candidate set
 * and sorts it in a TEMP B-TREE before the LIMIT can cut anything. `LIMIT 1200`
 * bounds what the query RETURNS, never what it READS — and rows read is what
 * Turso charge for. No other instrument here prints it: pool-window-drift.js
 * and pool-mcap-floor.js both count rows RETURNED.
 *
 * WHAT ONE SWEEP COSTS (measured 2026-10-07). Two independent readings:
 *   • this report's counts — the launch_ms range of the hot band plus ONE
 *     near sub-window plus ONE far sub-window (the rotation slot's own cut,
 *     not whole zones: those are ~4x larger and are what an earlier version
 *     of this file printed by mistake);
 *   • a burst of 60 production reads (mode `burst`) bracketed by the platform
 *     API's rows_read total: +1.19M over 7.5 min against a ~17k/min background
 *     ⇒ ~16-18k rows per sweep.
 * The two agree, which is the point: the bill is set by the CANDIDATE SET
 * (launch_ms range), not by the LIMIT.
 *
 * READ-ONLY BY CONSTRUCTION: COUNT(*), EXPLAIN QUERY PLAN, and
 * Db.listEnabledChats (one SELECT). No `front` is passed, so no gate that
 * WOULD write can move a stamp or a counter. Report mode costs ~150k rows of
 * quota per run; `burst n` costs n × rows/sweep and is a measurement, not a
 * free look.
 *
 * Run: node scripts/pool-read-cost.js [rowsReadPerHour]
 *      node scripts/pool-read-cost.js burst [n]
 *      The rate argument is the MEASURED Turso rate — GET
 *      /v1/organizations/<org>/databases/<db>/usage — and defaults to
 *      1,000,000, the live reading (Oct 6: 24,793,219 rows = 1.03M/hour).
 *      Needs the .env.local Turso creds.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");
const { loadConfig } = require("../dist/config.js");
const {
  Db,
  poolRotationSlot,
  mcapFloorLiteral,
  poolBandIndexName,
  POOL_MCAP_EVIDENCE_GRACE_MS,
} = require("../dist/db.js");
const {
  RE_EVAL_WINDOW_MS,
  RE_EVAL_AGE_MARGIN_MIN,
  POOL_LIQUIDITY_PRUNE_RATIO,
  POOL_MCAP_PRUNE_RATIO,
} = require("../dist/scanner.js");
// Mirrored from src/db.ts (module-private there).
const TOKEN_STATS_PRUNE_INTERVAL_MS = 10 * 60_000;

// Mirrored from src/db.ts, where they are module-private (the same reason
// RE_EVAL_WINDOW_MS moved into scanner.ts's exports): a band boundary restated
// by hand CAN drift from the tick's, so re-check these against src/db.ts before
// trusting a small delta.
const POOL_HOT_BELOW_MS = 0.5 * 3600_000;
const POOL_HOT_ABOVE_MS = 0.5 * 3600_000;
const POOL_HOT_MAX = 460;
const POOL_NEAR_WINDOW_MS = 6 * 3600_000;
const POOL_NEAR_LIMIT_SHARE = 0.7;

const MEASURED_ROWS_PER_HOUR =
  Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 1_000_000;

/** wrangler.toml's [vars] — the deployed knobs, which beat the code defaults. */
function wranglerVars() {
  const text = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
  const out = {};
  let inVars = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      inVars = /^\s*\[vars\]/.test(line);
      continue;
    }
    if (!inVars) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const cfg = loadConfig({ ...process.env, ...wranglerVars() });
const client = createClient({ url: cfg.tursoUrl, authToken: cfg.tursoAuthToken });

/** One scalar COUNT(*) — the only thing this instrument asks for. */
async function count(sql, args = []) {
  const res = await client.execute({ sql, args });
  return Number(res.rows[0][0]);
}

/**
 * The band SELECT, byte-identical to Db.queryReevalBand for the scanner's own
 * call shape (no seenChatIds ⇒ the legacy NOT EXISTS probe). Kept as one
 * template so the EXPLAIN runs against the real statement, not a paraphrase.
 */
function bandSql(orderSql) {
  return `SELECT * FROM token_stats
            WHERE launch_ms BETWEEN ? AND ?
              AND first_seen_at > ?
              AND ${DEAD_POOL_CLAUSE}
              AND ${POOL_MCAP_EVIDENCE_CLAUSE}
              AND (max_mcap_observed IS NULL OR max_mcap_observed >= ?)
              AND (max_mcap_observed IS NULL OR max_mcap_observed <= ?)
              AND (max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)
              AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)
            ${orderSql}
            LIMIT ?`;
}

// Mirrored from src/db.ts (2026-10-08): constant-only, so it is literal text
// in the SQL — which is exactly why a partial index on it needs no dynamic
// DDL. The freshness half is the mark the scanner advances on an empty sweep
// (a HEALTHY batch only) and clears on a reading, so the pool this instrument
// counts is the one the tick reads, corpses included.
const DEAD_LIQUIDITY_USD = 1_000;
const DEAD_POOL_MISS_MAX = 3;
const DEAD_POOL_MARK = `(last_liquidity_usd IS NOT NULL AND (last_liquidity_usd < ${DEAD_LIQUIDITY_USD} OR sweeps_since_reading >= ${DEAD_POOL_MISS_MAX}))`;
const DEAD_POOL_CLAUSE = `(last_liquidity_usd IS NULL OR NOT (${DEAD_POOL_MARK}))`;
// Mirrored from src/db.ts (2026-10-09): the no-evidence clause. A BOUND
// argument, not literal text — its cutoff moves with the clock — so every
// caller below binds it (see POOL_MCAP_EVIDENCE_GRACE_MS, imported, never
// restated: this script and the tick must cut at the same instant).
const POOL_MCAP_EVIDENCE_CLAUSE = `(max_mcap_observed IS NOT NULL OR first_seen_at > ?)`;

const PRUNES = `AND (last_liquidity_usd IS NULL OR last_liquidity_usd >= ?)
          AND (max_mcap_observed IS NULL OR max_mcap_observed >= ?)
          AND (max_mcap_observed IS NULL OR max_mcap_observed <= ?)
          AND (max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)
          AND (max_mcap_observed IS NOT NULL OR first_seen_at > ?)`;

const fmt = (n) => Number(n).toLocaleString("en-US");
const iso = (ms) => new Date(ms).toISOString().slice(11, 19);

/**
 * The tick's own read args — shared by report and burst so both measure the
 * production shape (same source as pool-mcap-floor.js: live chat gates +
 * wrangler [vars]; seenChatIds is NOT passed because the scanner does not).
 */
function poolArgs(db, now, chats) {
  const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
  const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
  return {
    now,
    sinceMs: now - RE_EVAL_WINDOW_MS,
    minLaunchMs: now - (maxAge + RE_EVAL_AGE_MARGIN_MIN) * 60_000,
    maxLaunchMs: now - (minAge - RE_EVAL_AGE_MARGIN_MIN) * 60_000,
    windowEntryLaunchMs: now - minAge * 60_000,
    limit: cfg.reevalPoolSize,
    nearSlots: cfg.reevalNearSlots,
    farSlots: cfg.reevalFarSlots,
    rotationPeriodMs: cfg.reevalPoolCacheMs,
    // The RATIO matters: the partial index is pinned to the value this item
    // computes, and a floor without it (60,000 vs 48,000) matches no index and
    // silently measures the pre-2026-10-07 walk — the bug this comment fixes.
    minQualifyMcap:
      Math.min(...chats.map((c) => c.minMarketCapUsd)) * POOL_MCAP_PRUNE_RATIO,
    maxQualifyMcap: Math.max(...chats.map((c) => c.maxMarketCapUsd)) * 2,
    minQualifyLiquidity:
      Math.min(...chats.map((c) => c.minLiquidityUsd)) * POOL_LIQUIDITY_PRUNE_RATIO,
  };
}

/**
 * BURST MODE — fires the PRODUCTION read (PoolFallbackDb.getReevalPool ⇒ the
 * batched statement, one request) n times so the Turso usage delta across the
 * burst can be read off the platform API: the report above brackets what a
 * sweep costs by predicate, and only a delta says what Turso actually bill and
 * lets the two be cross-checked. Read-only, but a REAL quota cost.
 */
async function burst(n) {
  const { PoolFallbackDb } = require("../dist/poolfallback.js");
  const db = new PoolFallbackDb(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();
  const chats = await db.listEnabledChats();
  const opts = poolArgs(db, Date.now(), chats);
  console.log(
    `burst   ${n} production pool reads (PoolFallbackDb.getReevalPool) floor=${mcapFloorLiteral(opts.minQualifyMcap)}`,
  );
  console.log(`started ${new Date().toISOString()}`);
  let rows = 0;
  let ms = 0;
  for (let i = 1; i <= n; i += 1) {
    const now = Date.now();
    const t0 = Date.now();
    const res = await db.getReevalPool({ ...opts, now, sinceMs: now - RE_EVAL_WINDOW_MS });
    const dt = Date.now() - t0;
    rows += res.length;
    ms += dt;
    if (i <= 3 || i % 20 === 0) console.log(`  ${i}/${n}  rows returned ${res.length}  ${dt}ms`);
  }
  console.log(`finished ${new Date().toISOString()}`);
  console.log(`  rows returned total ${fmt(rows)} (${Math.round(rows / n)}/call), ${fmt(ms)}ms`);
  return 0;
}

async function main() {
  const db = new Db(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();
  const chats = await db.listEnabledChats();
  if (chats.length === 0) {
    console.log("no enabled chats — the pool is chat-derived, nothing to measure");
    return 1;
  }

  const now = Date.now();
  const evidenceCutoff = now - POOL_MCAP_EVIDENCE_GRACE_MS;
  const opts = poolArgs(db, now, chats);
  const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
  const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
  const center = opts.windowEntryLaunchMs;
  const spanLo = opts.sinceMs;
  const spanHi = opts.maxLaunchMs;
  const rotLo = opts.minLaunchMs;
  const hotLo = Math.max(rotLo, center - POOL_HOT_BELOW_MS);
  const hotHi = Math.min(spanHi, center + POOL_HOT_ABOVE_MS);
  const rotHi = hotLo;
  const nearLo = Math.max(rotLo, center - POOL_NEAR_WINDOW_MS);
  const pruneArgs = [
    opts.minQualifyLiquidity,
    opts.minQualifyMcap,
    opts.maxQualifyMcap,
    opts.minQualifyLiquidity,
    // PRUNES' last placeholder: the no-evidence cutoff, appended there for
    // this script's report ladder only — the tick's own clause sits right
    // after `first_seen_at > ?` and binds before the floors (see db.ts).
    evidenceCutoff,
  ];
  const minQualifyMcap = opts.minQualifyMcap;
  const minQualifyLiquidity = opts.minQualifyLiquidity;

  const hotLimit = Math.min(cfg.reevalPoolSize, POOL_HOT_MAX);
  const rotLimit = Math.max(0, cfg.reevalPoolSize - hotLimit);
  const nearLimit = Math.min(rotLimit, Math.round(rotLimit * POOL_NEAR_LIMIT_SHARE));
  const farLimit = Math.max(0, rotLimit - nearLimit);

  console.log(`now                  ${new Date(now).toISOString()}`);
  console.log(`enabled chats        ${chats.length}  age ${minAge}-${maxAge}min`);
  console.log(`launch window        ${iso(rotLo)}Z .. ${iso(spanHi)}Z  (window entry ${iso(center)}Z)`);
  console.log(
    `pool knobs           limit ${cfg.reevalPoolSize}, hot ${POOL_HOT_MAX}, near ${cfg.reevalNearSlots}/far ${cfg.reevalFarSlots} slots, ` +
      `rotation ${Math.round(cfg.reevalPoolCacheMs / 1000)}s (wrangler [vars])`,
  );
  console.log(
    `gates                mcap ${fmt(Math.round(opts.minQualifyMcap))}..${fmt(Math.round(opts.maxQualifyMcap))}, ` +
      `liquidity floor ${fmt(Math.round(opts.minQualifyLiquidity))}, dead pool >= ${fmt(1000)}`,
  );

  // ONE sub-window per zone per sweep, cut exactly as Db.getReevalPool cuts
  // them (slot s counted from the OLD end of each zone): the sweep's bill is
  // the hot band plus one near slot plus one far slot.
  const slot = poolRotationSlot(now, cfg.reevalPoolCacheMs);
  const nearW = (rotHi - nearLo) / Math.max(1, cfg.reevalNearSlots);
  const farW = (nearLo - rotLo) / Math.max(1, cfg.reevalFarSlots);
  const nearS = slot % Math.max(1, cfg.reevalNearSlots);
  const farS = slot % Math.max(1, cfg.reevalFarSlots);
  const nearSlotLo = nearLo + Math.max(0, cfg.reevalNearSlots - nearS - 1) * nearW;
  const farSlotLo = rotLo + Math.max(0, cfg.reevalFarSlots - farS - 1) * farW;
  console.log(
    `rotation             slot ${slot} ⇒ near ${nearS}/${cfg.reevalNearSlots} (${Math.round(nearW / 60_000)}min), ` +
      `far ${farS}/${cfg.reevalFarSlots} (${Math.round(farW / 60_000)}min)`,
  );
  console.log("");
  console.log("bands at this now — rows read per band is the candidate set the sort must see:");

  const band = async (label, lo, hi, limit) => {
    if (hi <= lo) {
      console.log(`  ${label.padEnd(6)} empty at this slot`);
      return null;
    }
    const launch = await count(
      "SELECT COUNT(*) FROM token_stats WHERE launch_ms BETWEEN ? AND ?",
      [lo, hi],
    );
    const since = await count(
      "SELECT COUNT(*) FROM token_stats WHERE launch_ms BETWEEN ? AND ? AND first_seen_at > ?",
      [lo, hi, spanLo],
    );
    const prunes = await count(
      `SELECT COUNT(*) FROM token_stats WHERE launch_ms BETWEEN ? AND ? AND first_seen_at > ? ${PRUNES}`,
      [lo, hi, spanLo, ...pruneArgs],
    );
    // Which prune carries the selectivity — the ladder a partial index would
    // encode. DEAD_POOL alone is a CONSTANT predicate (DEAD_LIQUIDITY_USD), so
    // an index on it needs no dynamic DDL and no change to the query text.
    const band0 = "launch_ms BETWEEN ? AND ? AND first_seen_at > ?";
    const dead = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0} AND ${DEAD_POOL_CLAUSE}`,
      [lo, hi, spanLo],
    );
    const deadMcap = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0} AND ${DEAD_POOL_CLAUSE}
        AND (max_mcap_observed IS NULL OR max_mcap_observed >= ?)`,
      [lo, hi, spanLo, minQualifyMcap],
    );
    const deadMcapLiq = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0} AND ${DEAD_POOL_CLAUSE}
        AND (max_mcap_observed IS NULL OR max_mcap_observed >= ?)
        AND (max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)`,
      [lo, hi, spanLo, minQualifyMcap, minQualifyLiquidity],
    );
    // How much of the mcap floor's selectivity a STATIC bound keeps: an index
    // whose predicate is a constant (>= 1000) stays valid forever, while one
    // pinned to the live floor (>= 48000) has to be rebuilt whenever a chat's
    // gate moves. `nulls` is the fail-open mass the floor keeps by design.
    const nulls = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0} AND max_mcap_observed IS NULL`,
      [lo, hi, spanLo],
    );
    const staticFloor = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0}
        AND (max_mcap_observed IS NULL OR max_mcap_observed >= 1000)`,
      [lo, hi, spanLo],
    );
    const midFloor = await count(
      `SELECT COUNT(*) FROM token_stats WHERE ${band0}
        AND (max_mcap_observed IS NULL OR max_mcap_observed >= 10000)`,
      [lo, hi, spanLo],
    );
    console.log(
      `  ${label.padEnd(6)} age ${String(Math.max(0, Math.round((now - hi) / 60_000))).padStart(4)}-${String(Math.round((now - lo) / 60_000)).padStart(4)}min` +
        `  limit ${String(limit).padStart(4)}` +
        `  launch ${fmt(launch).padStart(8)}  +since ${fmt(since).padStart(8)}  +prunes ${fmt(prunes).padStart(8)}` +
        `  [mcap null ${fmt(nulls).padStart(7)} | >=1e3 ${fmt(staticFloor).padStart(7)} | >=1e4 ${fmt(midFloor).padStart(7)} | >=live ${fmt(deadMcap).padStart(7)}]`,
    );
    return { launch, since, prunes };
  };

  const bands = [
    await band("hot", hotLo, hotHi, hotLimit),
    await band(`near${nearS}`, nearSlotLo, nearSlotLo + nearW, nearLimit),
    await band(`far${farS}`, farSlotLo, farSlotLo + farW, farLimit),
  ].filter(Boolean);
  const total = await count("SELECT COUNT(*) FROM token_stats");
  const windowRows = await count("SELECT COUNT(*) FROM token_stats WHERE first_seen_at > ?", [spanLo]);
  const perDay = await client.execute({
    sql: `SELECT CAST(first_seen_at / 86400000 AS INTEGER) * 86400000 AS day, COUNT(*)
          FROM token_stats GROUP BY day ORDER BY day DESC LIMIT 7`,
    args: [],
  });

  const plan = await client.execute({
    sql: `EXPLAIN QUERY PLAN ${bandSql("ORDER BY COALESCE(max_mcap_observed, 0) DESC, COALESCE(first_m5_vol, 0) DESC, ((UNICODE(SUBSTR(token, -1)) + ?) % 8)")}`,
    // pruneArgs[0] is the dead-liquidity floor this statement no longer binds
    // (see DEAD_POOL_CLAUSE): the clause is literal text, so the arg list skips
    // it rather than shifting every floor behind it by one.
    args: [hotLo, hotHi, spanLo, evidenceCutoff, ...pruneArgs.slice(1, -1), 0, hotLimit],
  });
  const details = plan.rows.map((r) => String(r.detail ?? r.DETAIL ?? JSON.stringify(r)));
  console.log("");
  console.log("planner path (EXPLAIN QUERY PLAN, hot band, signal order):");
  for (const d of details) console.log(`  ${d}`);

  const usesLaunch = details.some((d) => /USING (COVERING )?INDEX idx_token_stats_launch/.test(d));
  const usesFirstSeen = details.some((d) => /USING (COVERING )?INDEX idx_token_stats_first_seen/.test(d));
  const rung = usesLaunch ? "launch" : usesFirstSeen ? "since" : "scan";
  const perSweepPlan =
    rung === "scan" ? total * bands.length : rung === "launch" ? bands.reduce((a, b) => a + b.launch, 0) : bands.reduce((a, b) => a + b.since, 0);
  const perSweepPruned = bands.reduce((a, b) => a + b.prunes, 0);

  console.log("");
  console.log(`token_stats          ${fmt(total)} rows total, ${fmt(windowRows)} inside the ${Math.round(RE_EVAL_WINDOW_MS / 3600_000)}h window`);
  for (const row of perDay.rows) {
    console.log(`  first seen ${new Date(Number(row[0])).toISOString().slice(0, 10)}   ${fmt(row[1]).padStart(8)} rows`);
  }
  const perMin = MEASURED_ROWS_PER_HOUR / 60;
  console.log("");
  console.log(`rows read per sweep  ${fmt(perSweepPlan)} (plan: ${rung})  ..  ${fmt(perSweepPruned)} (post-prune)`);
  console.log(`measured Turso rate  ${fmt(Math.round(MEASURED_ROWS_PER_HOUR))} rows/hour = ${fmt(Math.round(perMin))} rows/min`);
  console.log(
    `implied sweeps/min   ${(perMin / (perSweepPlan || 1)).toFixed(2)} at the plan figure, ` +
      `${(perMin / (perSweepPruned || 1)).toFixed(2)} at the post-prune figure  ` +
      `(the snapshot is shared by rotation slot, ${Math.round(cfg.reevalPoolCacheMs / 1000)}s ⇒ at most ` +
      `${(3600 / (cfg.reevalPoolCacheMs / 1000)).toFixed(0)} DB reads/hour per colo)`,
  );
  return 0;
}

/**
 * OTHERS MODE — `node scripts/pool-read-cost.js others`.
 *
 * The rest of the bill. Report mode prices the re-eval pool's read (the single
 * largest consumer); this prices the two suspects the pool does NOT explain,
 * READ-ONLY and without mutating anything:
 *
 *   • Db.pruneOldTokenStats — its DELETE's own subquery is re-run here as a
 *     COUNT(*) (the same indexed range: first_seen_at < cutoff, minus seen
 *     rows), because running the real DELETE out of band would remove rows the
 *     tick still owns. Cadence comes from the durable stamp's interval gate
 *     (TOKEN_STATS_PRUNE_INTERVAL_MS), so passes/hour is a fact, not a guess.
 *   • the launch_ms migration (Db.resumeLaunchBackfill) — off once
 *     `schema_alter_v2_done` is stamped; the NULL rows it would scan are
 *     counted here, and its per-tick cost collapses to one row when it is.
 *   • the one-shot pump.fun backfill (scripts/backfill-pumpfun.mjs) — a manual
 *     GitHub workflow, not a recurring reader, but its INSERTs are what the
 *     pool then has to sweep: that legacy is visible in the table sizes below.
 */
async function others() {
  const db = new Db(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();
  const chats = await db.listEnabledChats();
  if (chats.length === 0) {
    console.log("no enabled chats — the pool is chat-derived, nothing to measure");
    return 1;
  }
  const now = Date.now();
  const cutoff = now - RE_EVAL_WINDOW_MS; // what the tick passes as olderThanMs

  const flags = await db.getWorkerStates([
    "schema_alter_v2_done",
    "token_stats_last_prune",
    "telemetry_token_stats_count",
  ]);
  console.log(`now                  ${new Date(now).toISOString()}`);
  console.log(`prune cutoff         first_seen_at < ${new Date(cutoff).toISOString()} (now - RE_EVAL_WINDOW_MS)`);
  for (const [k, v] of flags) {
    console.log(`worker_state         ${k} = ${v === undefined ? "-" : JSON.stringify(v).slice(0, 40)}`);
  }
  const passesPerHour = 3_600_000 / TOKEN_STATS_PRUNE_INTERVAL_MS;
  console.log(
    `prune cadence        every ${Math.round(TOKEN_STATS_PRUNE_INTERVAL_MS / 60_000)}min (durable stamp) ⇒ <=${passesPerHour.toFixed(1)} passes/hour, each <=3 chunks of 5000`,
  );

  const pruneCandidates = await count(
    "SELECT COUNT(*) FROM token_stats WHERE first_seen_at < ?",
    [cutoff],
  );
  const pruneEligible = await count(
    `SELECT COUNT(*) FROM token_stats
      WHERE first_seen_at < ?
        AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)`,
    [cutoff],
  );
  // The DELETE's subquery walks the first_seen_at range (every row past the
  // cutoff, seen or not) and probes idx_seen_tokens_token once per row; the
  // outer DELETE then probes the table's PK once per eligible token.
  const perPass = pruneCandidates * 2 + pruneEligible;
  console.log("");
  console.log(`prune candidates     ${fmt(pruneCandidates)} rows past the cutoff`);
  console.log(`  eligible (minus seen)  ${fmt(pruneEligible)}`);
  console.log(
    `  rows read / pass       ~${fmt(perPass)} (index range + one idx_seen_tokens_token probe each) ` +
      `⇒ <=${fmt(Math.round(perPass * passesPerHour))} rows/hour`,
  );

  // The rows the DELETE's subquery VISITS is not the same question as what the
  // statement pays: `token IN (SELECT …)` can be planned as a full scan of the
  // outer table (81k rows) or as a keyed probe per collected token. EXPLAIN
  // QUERY PLAN answers it without running the DELETE.
  const prunePlan = await client.execute({
    sql: `EXPLAIN QUERY PLAN
            DELETE FROM token_stats WHERE token IN (
              SELECT token FROM token_stats
              WHERE first_seen_at < ?
                AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)
              LIMIT 5000)`,
    args: [cutoff],
  });
  console.log("prune DELETE plan:");
  for (const r of prunePlan.rows) console.log(`  ${String(r.detail ?? JSON.stringify(r))}`);

  const nullLaunch = await count("SELECT COUNT(*) FROM token_stats WHERE launch_ms IS NULL");
  const tracked = await count("SELECT COUNT(*) FROM token_stats");
  console.log("");
  console.log(`launch_ms migration  ${fmt(nullLaunch)} rows still NULL of ${fmt(tracked)}`);

  // The one-shot pump.fun backfill's own INSERT omits `discovered_via` (the
  // scanner's two writers always set it), so a NULL there plus a first_seen_at
  // on the day it ran identifies its rows. It is not a recurring reader — the
  // workflow is workflow_dispatch / on-script-change only — but its rows are
  // what the pool then has to sweep, which is the legacy worth pricing.
  const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
  const backfillAt = Date.parse("2026-10-06T00:00:00Z");
  const legacy = await count(
    "SELECT COUNT(*) FROM token_stats WHERE discovered_via IS NULL AND first_seen_at >= ?",
    [backfillAt],
  );
  const legacyInWindow = await count(
    "SELECT COUNT(*) FROM token_stats WHERE discovered_via IS NULL AND first_seen_at >= ? AND launch_ms > ?",
    [backfillAt, now - maxAge * 60_000],
  );
  const inWindow = await count("SELECT COUNT(*) FROM token_stats WHERE launch_ms > ?", [
    now - maxAge * 60_000,
  ]);
  console.log(
    `one-shot backfill    ${fmt(legacy)} rows inserted on/after 2026-10-06 (discovered_via IS NULL), ` +
      `${fmt(legacyInWindow)} of them still inside the ${Math.round(maxAge / 60)}h age window of ${fmt(inWindow)}`,
  );

  const tables = (
    await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      args: [],
    })
  ).rows.map((r) => String(r.name));
  console.log("");
  console.log(`table sizes          (each COUNT(*) costs its own rows read — this is the whole bill's map)`);
  const sizes = [];
  for (const t of tables) {
    if (t.startsWith("sqlite_")) continue;
    // Progress to stderr: a run killed by a wall clock must not hide where it
    // got to (stdout to a pipe is block-buffered and dies with the process).
    process.stderr.write(`  counting ${t}… `);
    const n = await count(`SELECT COUNT(*) FROM ${t}`);
    process.stderr.write(`${fmt(n)}\n`);
    sizes.push({ t, n });
  }
  sizes.sort((a, b) => b.n - a.n);
  for (const s of sizes) console.log(`  ${s.t.padEnd(28)} ${fmt(s.n).padStart(10)}`);
  return 0;
}

/**
 * INDEX MODE — `node scripts/pool-read-cost.js index [floor]`.
 *
 * Creates the band query's partial index (the DDL Db.ensurePoolBandIndex runs
 * from the scanner on the first tick after a deploy) and prints the plans it
 * produces, so the "after" side of the measurement can be taken WITHOUT
 * shipping the Worker: the index is inert until a query's predicate matches it
 * (a bound parameter only matches when the planner sees that same value), and
 * the burst mode below drives the new literal-floor shape through dist/.
 *
 * The row the index excludes is the ~86% of each band whose known market-cap
 * peak sits under the floor — the same rows the query filtered AFTER walking
 * them (16,156 candidates/sweep → ~2,330 that can qualify, 2026-10-07).
 */
async function indexMode(floorArg) {
  const { PoolFallbackDb } = require("../dist/poolfallback.js");
  const db = new PoolFallbackDb(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();
  const chats = await db.listEnabledChats();
  const floor =
    Number(floorArg) > 0
      ? Number(floorArg)
      : Math.min(...chats.map((c) => c.minMarketCapUsd)) * POOL_MCAP_PRUNE_RATIO;
  const name = poolBandIndexName(floor);
  const literal = mcapFloorLiteral(floor);
  console.log(`floor                ${literal} (${chats.length} enabled chats x POOL_MCAP_PRUNE_RATIO)`);
  console.log(`index                ${name}`);
  await client.execute({
    sql: `CREATE INDEX IF NOT EXISTS ${name} ON token_stats(launch_ms)
          WHERE (max_mcap_observed IS NULL OR max_mcap_observed >= ${literal})`,
    args: [],
  });
  const rows = (
    await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pool_band%'",
      args: [],
    })
  ).rows.map((r) => String(r.name));
  console.log(`present              ${rows.join(", ") || "-"}`);
  // EXPLAIN with every value inlined: a plan depends on the predicate TEXT,
  // not on the values, and an unbound `?` cannot be executed at all.
  const now = Date.now();
  const lo = now - 440 * 60_000;
  const hi = now - 275 * 60_000;
  const spanLo = now - 30 * 3600_000;
  const order = `ORDER BY COALESCE(max_mcap_observed, 0) DESC, COALESCE(first_m5_vol, 0) DESC, ((UNICODE(SUBSTR(token, -1)) + 0) % 8)`;
  const shape = (floorText) =>
    `SELECT * FROM token_stats
      WHERE launch_ms BETWEEN ${lo} AND ${hi}
        AND first_seen_at > ${spanLo}
        AND (max_mcap_observed IS NULL OR max_mcap_observed >= ${floorText})
        AND ${DEAD_POOL_CLAUSE}
        AND (max_mcap_observed IS NOT NULL OR first_seen_at > ${now - POOL_MCAP_EVIDENCE_GRACE_MS})
        ${order} LIMIT 518`;
  const show = async (tag, sql, args) => {
    const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args ?? [] });
    console.log(`${tag}:`);
    for (const r of plan.rows) console.log(`  ${String(r.detail ?? JSON.stringify(r))}`);
  };
  await show("new shape (literal floor, as the deployed code will send)", shape(literal));
  await show("live shape (bound floor = today's value)", shape("?"), [Number(literal)]);
  await show("live shape (bound floor = a different value)", shape("?"), [Number(literal) - 1000]);
  await show(
    "hot band (entry order, ABS(launch_ms - center))",
    shape(literal)
      .replace(order, `ORDER BY ABS(launch_ms - ${now - 80 * 60_000})`)
      .replace("LIMIT 518", "LIMIT 460"),
  );

  // CORRECTNESS, on the LIVE rows: a partial index is only a bonus if it
  // returns exactly what the full index returned. Both statements are the near
  // band's own SQL, differing only in which index the planner is allowed to use
  // (INDEXED BY forces the pre-2026-10-07 path), so a token-set or ordering
  // difference would be the index dropping or reordering rows.
  const nearSql = shape(literal).replace("SELECT *", "SELECT token");
  const viaPartial = (await client.execute({ sql: nearSql, args: [] })).rows.map((r) => String(r.token));
  const viaFull = (
    await client.execute({
      sql: nearSql.replace("FROM token_stats", "FROM token_stats INDEXED BY idx_token_stats_launch"),
      args: [],
    })
  ).rows.map((r) => String(r.token));
  const same = viaPartial.length === viaFull.length && viaPartial.every((t, i) => t === viaFull[i]);
  console.log(
    `A/B identity        partial ${viaPartial.length} rows vs full ${viaFull.length} rows — ${same ? "IDENTICAL (token-for-token)" : "DIFFERENT — DO NOT SHIP"}`,
  );
  console.log(`
next                 node scripts/pool-read-cost.js burst 60   (the after measurement)`);
  return 0;
}

/**
 * AB MODE — `node scripts/pool-read-cost.js ab [n]`.
 *
 * Does Turso's rows_read track the INDEX WALK? Two COUNT(*)s over the SAME
 * launch_ms range: A walks the full range (idx_token_stats_launch), B carries
 * the floor literal the partial index is pinned to, so the planner may walk
 * only the rows that pass it. No sort, no seen-probe, no table fetch — the one
 * thing that differs is how many index entries the range visits, and the
 * platform's own counters say what that cost. Read-only.
 */
async function abMode(n) {
  const now = Date.now();
  const hi = now - 275 * 60_000;
  const lo = now - 440 * 60_000;
  const spanLo = now - 30 * 3600_000;
  const floor = 48000;
  const full = `SELECT COUNT(*) FROM token_stats WHERE launch_ms BETWEEN ${lo} AND ${hi}`;
  const partial = `${full} AND (max_mcap_observed IS NULL OR max_mcap_observed >= ${floor})`;
  for (const [tag, sql] of [
    ["full-range walk", full],
    ["partial-index walk", partial],
  ]) {
    const c0 = await count(sql);
    const t0 = Date.now();
    for (let i = 0; i < n; i += 1) await count(sql);
    process.stderr.write(
      `@@ ${tag}: rows=${fmt(c0)} x${n} in ${Date.now() - t0}ms (${new Date().toISOString()})\n`,
    );
  }
  // The plan each COUNT gets, so the walk claim is not just asserted.
  for (const [tag, sql] of [
    ["full-range plan", full],
    ["partial plan", partial],
  ]) {
    const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: [] });
    process.stderr.write(`@@ ${tag}: ${plan.rows.map((r) => String(r.detail)).join(" | ")}\n`);
  }
  return 0;
}

const mode = process.argv[2];
(mode === "burst"
  ? burst(Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 24)
  : mode === "others"
    ? others()
    : mode === "index"
      ? indexMode(Number(process.argv[3]))
      : mode === "ab"
        ? abMode(Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 200)
        : main()).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
