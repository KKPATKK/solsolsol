/*
 * What the re-eval pool's MARKET-CAP floor prune actually costs.
 *
 * WHY THIS EXISTS: on 2026-09-28 the mcap floor went 0.6 → 0.8 × the widest
 * chat's min-market-cap gate (scanner.POOL_MCAP_PRUNE_RATIO). The safety
 * argument is arithmetic — a coin whose PEAK market cap never reached
 * 0.8 × the gate could never have passed that gate — but the COST is not: a
 * pruned coin stops updating max_mcap_observed, and market cap is exactly the
 * dimension that gaps upward, so the coins this drops are the ones likeliest to
 * have crossed the gate later. That cost is only knowable by counting rows.
 *
 * WHAT IT RUNS: the scanner's own pool read (Db.getReevalPool — the same call
 * cpu-profile.js and /debug/pool make), against the production Turso database,
 * at a LADDER of ratios. The difference between two rungs IS the slice the
 * raise removed from every band's sweep.
 *
 * SLOT SAMPLING: the pool query reads ONE near sub-window and ONE far
 * sub-window per rotation slot (see Db.getReevalPool), so a single reading is a
 * property of that slot, not of the pool — measured 2026-09-28: 555 rows in one
 * slot, 927 in another. Every rung of the ladder is therefore read at the SAME
 * `now` (apples to apples within a slot), and the whole ladder is repeated
 * across several slots spaced by the rotation period.
 *
 * PRODUCTION SHAPE: the knobs that decide WHICH bands are read (nearSlots,
 * farSlots, rotationPeriodMs, limit) come from wrangler.toml's [vars], not from
 * loadConfig's code defaults, because production is deployed WITH those vars.
 * They are overlaid here for the same reason — measuring the code defaults
 * instead would read a different pool than the tick does. (cpu-profile.js does
 * not overlay them; its pool phase reads a slightly different pool for that
 * reason.)
 *
 * READ-ONLY, and it has to stay that way (same discipline as cpu-profile.js,
 * which this mirrors): Db.init is the idempotent CREATE ... IF NOT EXISTS batch
 * a cold isolate runs anyway, listEnabledChats and getReevalPool are SELECTs,
 * and no `front` is passed — the pool gates that WOULD write ride the caller's
 * tick front, so a caller without one cannot move a stamp or a counter. The one
 * cost is rows-read: each rung is a full pool query, so ladder × slots of them.
 * Run it deliberately, not in a loop.
 *
 * Run: node scripts/pool-mcap-floor.js [slots] [ratio,ratio,...]
 *      (needs the .env.local Turso creds)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../dist/config.js");
const { Db } = require("../dist/db.js");
const {
  POOL_MCAP_PRUNE_RATIO,
  POOL_LIQUIDITY_PRUNE_RATIO,
} = require("../dist/scanner.js");
const { fmtUsd } = require("../dist/format.js");

// The scanner's own window constants (src/scanner.ts — RE_EVAL_WINDOW_MS and
// RE_EVAL_AGE_MARGIN_MIN; not exported, so restated here).
const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;
const RE_EVAL_AGE_MARGIN_MIN = 180;

/** The two history points plus a ladder either side of them. */
const LADDER = (process.argv[3] || "0.5,0.6,0.7,0.8,0.9")
  .split(",")
  .map(Number)
  .filter((r) => Number.isFinite(r) && r > 0);
const SLOTS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;

/** wrangler.toml's [vars] — the deployed knobs, which beat the code defaults. */
function wranglerVars() {
  const text = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
  const lines = text.split("\n");
  const out = {};
  let inVars = false;
  for (const line of lines) {
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

const env = { ...process.env, ...wranglerVars() };
const cfg = loadConfig(env);

function poolArgs(now, chats, ratio) {
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
    minQualifyMcap: Math.min(...chats.map((c) => c.minMarketCapUsd)) * ratio,
    maxQualifyMcap: Math.max(...chats.map((c) => c.maxMarketCapUsd)) * 2,
    minQualifyLiquidity:
      Math.min(...chats.map((c) => c.minLiquidityUsd)) * POOL_LIQUIDITY_PRUNE_RATIO,
    // seenChatIds is NOT passed: the scanner's own call site does not pass it,
    // so this is production's shape. (src/db.ts accepts it and documents the
    // chat-aware exclusion; /debug/pool supplies it, the scanner does not.)
  };
}

function peakOf(row) {
  const m = row.maxMcapObserved;
  return m === null || m === undefined || !Number.isFinite(m) ? null : m;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

/** The composition numbers of one rung. */
function composition(rows, gate) {
  const peaks = rows.map(peakOf);
  return {
    count: rows.length,
    nullPeak: peaks.filter((p) => p === null).length,
    atOrAboveGate: peaks.filter((p) => p !== null && p >= gate).length,
    belowOldFloor: peaks.filter((p) => p !== null && p < gate * 0.6).length,
  };
}

async function main() {
  const db = new Db(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();

  const chats = await db.listEnabledChats();
  if (chats.length === 0) {
    console.log("no enabled chats — nothing to measure (the pool is chat-derived)");
    return 1;
  }

  const gate = Math.min(...chats.map((c) => c.minMarketCapUsd));
  const oldFloor = gate * 0.6;
  const newFloor = gate * POOL_MCAP_PRUNE_RATIO;
  const period = cfg.reevalPoolCacheMs;

  console.log(`enabled chats         ${chats.length}`);
  console.log(`min-mcap gate         ${fmtUsd(gate)} (widest chat)`);
  console.log(
    `mcap floor            ${fmtUsd(oldFloor)} -> ${fmtUsd(newFloor)}  (0.6 -> ${POOL_MCAP_PRUNE_RATIO})`,
  );
  console.log(
    `liquidity floor       ${fmtUsd(Math.min(...chats.map((c) => c.minLiquidityUsd)) * POOL_LIQUIDITY_PRUNE_RATIO)}  (ratio ${POOL_LIQUIDITY_PRUNE_RATIO})`,
  );
  console.log(
    `pool knobs            limit ${cfg.reevalPoolSize}, near ${cfg.reevalNearSlots} / far ${cfg.reevalFarSlots} slots, rotation ${Math.round(period / 1000)}s (wrangler [vars])`,
  );
  console.log(`sampling              ${SLOTS} slots x ${LADDER.length} rungs`);

  const perSlot = [];
  const now0 = Date.now();
  for (let s = 0; s < SLOTS; s += 1) {
    // Step by the rotation period so each sample is a different slot, and read
    // every rung at the same `now` so the rungs share a slot.
    const now = now0 + s * period;
    const byRatio = {};
    for (const ratio of LADDER) {
      // Progress to stderr: a run killed by a wall clock must not hide where it
      // got to (stdout to a pipe is block-buffered and dies with the process).
      process.stderr.write(`[slot ${s + 1}/${SLOTS}] rung ${ratio}… `);
      const list = await db.getReevalPool(poolArgs(now, chats, ratio));
      byRatio[ratio] = { list, ...composition(list, gate) };
      process.stderr.write(`${list.length} rows\n`);
    }
    const baseR = byRatio[0.6] ? 0.6 : LADDER[0];
    const liveR = byRatio[POOL_MCAP_PRUNE_RATIO]
      ? POOL_MCAP_PRUNE_RATIO
      : LADDER[LADDER.length - 1];
    const base = byRatio[baseR];
    const live = byRatio[liveR];
    const baseSet = new Set(base.list.map((r) => r.token));
    const liveSet = new Set(live.list.map((r) => r.token));
    perSlot.push({
      now,
      baseR,
      liveR,
      byRatio,
      dropped: base.list.filter((r) => !liveSet.has(r.token)),
      admitted: live.list.filter((r) => !baseSet.has(r.token)),
    });
  }

  const padL = (v, n) => String(v).padEnd(n);
  const padR = (v, n) => String(v).padStart(n);

  console.log("");
  console.log(`per slot (all rungs in a row share that slot's now):`);
  console.log(
    `  ${padL("slot", 6)}${LADDER.map((r) => padR(r, 7)).join("")}${padR("dropped", 9)}${padR("backfill", 10)}${padR("net", 6)}${padR("nullPeak", 10)}${padR(">=gate", 8)}`,
  );
  perSlot.forEach((s, i) => {
    const live = s.byRatio[s.liveR];
    console.log(
      `  ${padL(`#${i + 1}`, 6)}${LADDER.map((r) => padR(s.byRatio[r].count, 7)).join("")}${padR(s.dropped.length, 9)}${padR(s.admitted.length, 10)}${padR(live.count - s.byRatio[s.baseR].count, 6)}${padR(live.nullPeak, 10)}${padR(live.atOrAboveGate, 8)}`,
    );
  });

  const meanCount = (r) => mean(perSlot.map((s) => s.byRatio[r].count));
  console.log("");
  console.log("mean rows returned per rung:");
  for (const r of LADDER) {
    console.log(
      `  ${padL(`${r} (${fmtUsd(gate * r)})`, 18)}${padR(meanCount(r).toFixed(0), 5)}${r === liveR0(perSlot) ? "  <- live" : ""}`,
    );
  }

  const meanBase = meanCount(perSlot[0].baseR);
  const meanLive = meanCount(perSlot[0].liveR);
  const meanDropped = mean(perSlot.map((s) => s.dropped.length));
  console.log("");
  console.log(
    `the ${perSlot[0].baseR} -> ${perSlot[0].liveR} raise stops re-measuring ${meanDropped.toFixed(1)} rows per sweep (${(((meanBase - meanLive) / (meanBase || 1)) * 100).toFixed(1)}% of what ${perSlot[0].baseR} returned; floor ${fmtUsd(oldFloor)} -> ${fmtUsd(newFloor)} at this gate):`,
  );
  const droppedPeaks = perSlot
    .flatMap((s) => s.dropped.map(peakOf))
    .filter((p) => p !== null)
    .sort((a, b) => b - a);
  if (droppedPeaks.length) {
    console.log(`  their peaks: ${droppedPeaks.map((p) => fmtUsd(p)).join(", ")}`);
    const lo = droppedPeaks[droppedPeaks.length - 1];
    const hi = droppedPeaks[0];
    console.log(
      `  i.e. ${((lo / gate) * 100).toFixed(0)}-${((hi / gate) * 100).toFixed(0)}% of the ${fmtUsd(gate)} gate — each needed to rise ${((gate / hi - 1) * 100).toFixed(0)}-${((gate / lo - 1) * 100).toFixed(0)}% to qualify`,
    );
  } else {
    console.log(`  none: no sampled slot held a row with a peak in that band`);
  }
  console.log(
    `  a dropped coin is not gone for good — any feed appearance re-measures it and re-raises its peak —`,
  );
  console.log(
    `  but nothing in the pool re-measures it while its peak stays under ${fmtUsd(newFloor)}.`,
  );

  const liveAgg = perSlot.map((s) => s.byRatio[s.liveR]);
  const meanNull = mean(liveAgg.map((a) => a.nullPeak));
  console.log("");
  console.log(
    `composition of what the pool returns at the live floor (${fmtUsd(newFloor)}):`,
  );
  console.log(
    `  ${meanNull.toFixed(0)} of ${meanLive.toFixed(0)} rows have NO peak mcap at all (${((meanNull / (meanLive || 1)) * 100).toFixed(0)}%) — NULL is KEPT by the prune (fail-open), so no ratio can reach them`,
  );
  console.log(
    `  ${mean(liveAgg.map((a) => a.atOrAboveGate)).toFixed(0)} rows already peak at/above the ${fmtUsd(gate)} gate`,
  );
  console.log(
    "  ⇒ the ratio is not what spreads this sweep thin: the unmeasured majority is. Backfilling",
  );
  console.log(
    "    max_mcap_observed at registration, or pruning NULL rows after a grace, is that lever.",
  );
  return 0;
}

function liveR0(perSlot) {
  return perSlot[0].liveR;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
