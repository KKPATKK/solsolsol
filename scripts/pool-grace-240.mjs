#!/usr/bin/env node
/*
 * 240-tick before/after for the no-evidence grace (2026-10-27, 6h → 3h).
 *
 * WHAT THIS ANSWERS. The cut is supposed to move the FILLER lane, not the
 * evidenced pool: a no-evidence row older than 3h leaves the re-eval pool, so
 * `filler served / tick` and the pool read should fall while the evidenced
 * cohort, candidates and pushes stay put. A cut that starts evicting rows the
 * pair lane could still reach shows the opposite signature — the evidenced
 * cohort falls with the filler, and agedEval follows it down. This script
 * keeps the SAME yardstick on both sides of the deploy.
 *
 * 240 ticks is 2 hours at the live 30s cadence (120 ticks/hour). The durable
 * `tick_legs` table keeps 72h, so the window can be read after the fact; the
 * per-tick slice/agedEval readings are NOT durable, so a short live sample is
 * taken on top (deduped on heartbeat.at, one row per completed tick).
 *
 * READ-ONLY: GET /health, /debug/tick-legs, /debug/pool, /debug/chats, and
 * SELECT-only D1 through scripts/open-store.js. No writes, no knobs flipped.
 *
 *   node scripts/pool-grace-240.mjs snapshot --label before --out /tmp/pool-grace-before.json
 *   # deploy the 3h bound, wait >= 2h (240 ticks)
 *   node scripts/pool-grace-240.mjs snapshot --label after --out /tmp/pool-grace-after.json
 *   node scripts/pool-grace-240.mjs compare --before /tmp/pool-grace-before.json --after /tmp/pool-grace-after.json
 *
 * --samples 0 skips the live half; --interval is the poll spacing in seconds.
 * --base defaults to the production worker; --no-db skips the D1 cohort half.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const MODE = process.argv[2] ?? "snapshot";
const BASE = arg("base", "https://solana-meme-bot.cool1999k.workers.dev");

const H = 3600e3;
const M = 60e3;
const GRACE_3H = 3 * H;
/** The bound this change replaced — only used to size the cohort it removes. */
const GRACE_6H = 6 * H;
/** The pool query's own clock (db.RE_EVAL_WINDOW_MS). */
const POOL_WINDOW_MS = 30 * H;
/** db.RE_EVAL_AGE_MARGIN_MIN — the pre-qualification margin either side. */
const AGE_MARGIN_MIN = 180;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const median = (xs) => {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const pct = (a, p) => {
  const xs = a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
};
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One row per DISTINCT completed tick (heartbeat.at), the live half. */
async function liveSamples(count, intervalSec) {
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    try {
      const h = await getJson("/health");
      const at = num(h.heartbeat?.at);
      const sm = h.heartbeat?.summary;
      if (at !== null && sm && !seen.has(at)) {
        seen.add(at);
        rows.push({
          at,
          ok: h.heartbeat?.ok === true,
          ms: num(h.heartbeat?.ms),
          pool: num(sm.pool),
          sliced: num(sm.poolSliced),
          served: sm.poolServed
            ? {
                hot: num(sm.poolServed.hot),
                near: num(sm.poolServed.near),
                far: num(sm.poolServed.far),
                filler: num(sm.poolServed.filler),
              }
            : null,
          agedEval: num(sm.agedEval),
          fails: sm.fails
            ? { mcap: num(sm.fails.mcap), other: num(sm.fails.other), age: num(sm.fails.age) }
            : null,
          candidates: num(sm.candidates),
          pushed: num(sm.pushed),
          pairsMissing: num(sm.pairsMissing),
          pairsMissingPool: num(sm.pairsMissingPool),
          dex429: num(sm.dex?.http429),
        });
      }
    } catch (err) {
      // The live half is best-effort: a refused sample must not lose the
      // durable half. The count printed records how many answered.
      console.error(`sample ${i + 1}: ${err instanceof Error ? err.message : err}`);
    }
    if (i < count - 1) await sleep(intervalSec * 1000);
  }
  return rows;
}

/**
 * The D1 cohort half — the pool query's OWN clauses, minus the grace, so the
 * two cutoffs can be read from one snapshot. The clause order and the seen
 * exclusion mirror db.getReevalPoolBatched (mcap floor/ceiling, peak-liquidity
 * floor, dead clause); the launch window mirrors the scanner's call
 * (`now - (maxAge + margin) … now - (minAge - margin)`).
 */
async function dbCohorts() {
  const { openTarget } = require("./open-store.js");
  const t = await openTarget([]);
  const chats = await getJson("/debug/chats");
  const pool = await getJson("/debug/pool");
  const now = Date.now();
  const minAge = chats.poolWindow?.minAgeMin ?? 80;
  const maxAge = chats.poolWindow?.maxAgeMin ?? 1560;
  const mcapFloor = pool.mcapFloorUsd ?? 48000;
  const mcapCeiling = pool.mcapCeilingUsd ?? 460000;
  const liqFloor = pool.liquidityFloorUsd ?? 8000;
  const enabled = (chats.chats ?? []).filter((c) => c.enabled).map((c) => c.chatId);
  const since = now - POOL_WINDOW_MS;
  const launchLo = now - (maxAge + AGE_MARGIN_MIN) * M;
  const launchHi = now - (minAge - AGE_MARGIN_MIN) * M;
  const seenClause = enabled.length
    ? ` AND token NOT IN (${enabled.map(() => "?").join(",")})`
    : "";
  const baseArgs = [since, launchLo, launchHi, mcapFloor, mcapCeiling, liqFloor, ...enabled];
  const where = `first_seen_at > ? AND launch_ms BETWEEN ? AND ?
      AND (max_mcap_observed IS NULL OR (max_mcap_observed >= ? AND max_mcap_observed <= ?))
      AND (max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)
      AND (last_liquidity_usd IS NULL OR NOT (last_liquidity_usd < 1000 OR sweeps_since_reading >= 3))${seenClause}`;

  const funnel = (
    await t.select(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN max_mcap_observed IS NOT NULL THEN 1 ELSE 0 END) evidenced,
              SUM(CASE WHEN max_mcap_observed IS NULL AND first_seen_at > ? THEN 1 ELSE 0 END) filler3h,
              SUM(CASE WHEN max_mcap_observed IS NULL AND first_seen_at > ? THEN 1 ELSE 0 END) filler6h,
              SUM(CASE WHEN max_mcap_observed IS NULL AND first_seen_at > ? AND first_seen_at <= ? THEN 1 ELSE 0 END) filler3to6h
       FROM token_stats WHERE ${where}`,
      [now - GRACE_3H, now - GRACE_6H, now - GRACE_6H, now - GRACE_3H, ...baseArgs],
    )
  ).rows[0];

  const age = (
    await t.select(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN first_seen_at > ? THEN 1 ELSE 0 END) lt1h,
              SUM(CASE WHEN first_seen_at > ? AND first_seen_at <= ? THEN 1 ELSE 0 END) h1to3,
              SUM(CASE WHEN first_seen_at > ? AND first_seen_at <= ? THEN 1 ELSE 0 END) h3to6,
              SUM(CASE WHEN first_seen_at <= ? THEN 1 ELSE 0 END) gt6h,
              SUM(CASE WHEN last_liquidity_usd IS NOT NULL THEN 1 ELSE 0 END) withLiq
       FROM token_stats WHERE max_mcap_observed IS NULL`,
      [now - H, now - 3 * H, now - H, now - 6 * H, now - 3 * H, now - 6 * H],
    )
  ).rows[0];

  return {
    source: String(t.kind),
    now,
    chats: { enabled: enabled.length, minAgeMin: minAge, maxAgeMin: maxAge },
    floors: { mcapFloor, mcapCeiling, liqFloor },
    /** Eligible pool with the OLD bound, the NEW bound, and the delta. */
    eligible: {
      withoutGrace: Number(funnel.total ?? 0),
      evidenced: Number(funnel.evidenced ?? 0),
      fillerUnder3h: Number(funnel.filler3h ?? 0),
      fillerUnder6h: Number(funnel.filler6h ?? 0),
      filler3to6h: Number(funnel.filler3to6h ?? 0),
    },
    noEvidence: {
      total: Number(age.total ?? 0),
      lt1h: Number(age.lt1h ?? 0),
      h1to3: Number(age.h1to3 ?? 0),
      h3to6: Number(age.h3to6 ?? 0),
      gt6h: Number(age.gt6h ?? 0),
      withLiquidity: Number(age.withLiq ?? 0),
    },
  };
}

async function snapshot() {
  const label = arg("label", "snapshot");
  const out = arg("out", `/tmp/pool-grace-${label}.json`);
  const rows = Number(arg("rows", 240));
  const hours = Number(arg("hours", 8));
  const samples = Number(arg("samples", 6));
  const interval = Number(arg("interval", 10));

  const legs = await getJson(`/debug/tick-legs?hours=${hours}&dbRows=${rows}`);
  const all = (legs.db ?? []).slice().sort((a, b) => a.at - b.at);
  const scanned = all.filter((r) => num(r.pool) !== null && r.pool > 0);
  const poolRows = scanned.map((r) => r.pool);
  const msRows = scanned.map((r) => r.ms);
  const ticks = {
    n: all.length,
    from: all[0]?.at ?? null,
    to: all[all.length - 1]?.at ?? null,
    spanMin:
      all.length > 1 ? Number(((all[all.length - 1].at - all[0].at) / 60e3).toFixed(1)) : null,
    scanned: scanned.length,
    empty: all.length - scanned.length,
    poolAvg: poolRows.length ? Number((sum(poolRows) / poolRows.length).toFixed(1)) : null,
    poolMin: poolRows.length ? Math.min(...poolRows) : null,
    poolMax: poolRows.length ? Math.max(...poolRows) : null,
    pairsAvg: scanned.length
      ? Number((sum(scanned.map((r) => r.pairs ?? 0)) / scanned.length).toFixed(1))
      : null,
    candidates: sum(all.map((r) => r.candidates)),
    pushed: sum(all.map((r) => r.pushed)),
    msP50: pct(msRows, 0.5),
    msP90: pct(msRows, 0.9),
  };

  const pool = await getJson("/debug/pool");
  const live = samples > 0 ? await liveSamples(samples, interval) : [];
  const sliced = live.map((r) => r.sliced).filter((v) => v !== null);
  const filler = live.map((r) => r.served?.filler).filter((v) => v !== null);
  const aged = live.map((r) => r.agedEval).filter((v) => v !== null);
  const liveSummary = {
    samples: live.length,
    agedEvalMedian: median(aged),
    agedEvalMax: aged.length ? Math.max(...aged) : null,
    slicedMedian: median(sliced),
    fillerServedMedian: median(filler),
    failsMcapMedian: median(live.map((r) => r.fails?.mcap).filter((v) => v !== null)),
    pairsMissingMax: live.length ? Math.max(...live.map((r) => r.pairsMissing ?? 0)) : null,
    dex429Max: live.length ? Math.max(...live.map((r) => r.dex429 ?? 0)) : null,
    rows: live,
  };

  let db = null;
  if (!flag("no-db")) {
    try {
      db = await dbCohorts();
    } catch (err) {
      // A refused D1 read still leaves the durable + live halves usable; the
      // comparison prints "n/a" rather than a fabricated cohort.
      console.error(`D1 cohorts: ${err instanceof Error ? err.message : err}`);
    }
  }

  const doc = {
    kind: "pool-grace-snapshot",
    version: 1,
    label,
    at: Date.now(),
    base: BASE,
    ticks,
    pool: {
      total: num(pool.total),
      eligibleInWindow: num(pool.eligibleInWindow),
      deadMarked: num(pool.deadMarked),
      deadPending: num(pool.deadPending),
      poolQueryCount: num(pool.poolQueryCount),
      buckets: pool.buckets ?? null,
    },
    live: liveSummary,
    db,
  };
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`wrote ${out} (${label}: ${ticks.n} ticks, ${liveSummary.samples} live samples)`);
  return doc;
}

/** A short clock for the window edges — the date is in the header. */
const clock = (ms) =>
  typeof ms === "number" ? `${new Date(ms).toISOString().slice(11, 19)}Z` : null;

const fmt = (v, digits = 0) => {
  if (v === null || v === undefined) return "n/a";
  if (typeof v === "number") {
    return Number.isInteger(v) && digits === 0
      ? v.toLocaleString("en-US")
      : v.toFixed(digits);
  }
  return String(v);
};

function compare() {
  const beforePath = arg("before", null);
  const afterPath = arg("after", null);
  if (!beforePath || !afterPath) {
    console.error("compare needs --before <file> and --after <file>");
    process.exit(2);
  }
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

  const rows = [
    ["window rows (ticks)", (d) => d.ticks.n],
    ["window from (UTC)", (d) => clock(d.ticks.from)],
    ["window to (UTC)", (d) => clock(d.ticks.to)],
    ["empty (gate-skip) ticks", (d) => d.ticks.empty],
    ["-- D1 cohort (grace-independent) --", () => null],
    ["eligible pool (no grace)", (d) => d.db?.eligible.withoutGrace],
    ["  evidenced", (d) => d.db?.eligible.evidenced],
    ["  no-evidence < 3h", (d) => d.db?.eligible.fillerUnder3h],
    ["  no-evidence 3-6h", (d) => d.db?.eligible.filler3to6h],
    ["  no-evidence < 6h (old bound)", (d) => d.db?.eligible.fillerUnder6h],
    ["no-evidence rows (all)", (d) => d.db?.noEvidence.total],
    ["  with a liquidity reading", (d) => d.db?.noEvidence.withLiquidity],
    ["-- actual tick readings --", () => null],
    ["pool rows / tick (avg)", (d) => d.ticks.poolAvg],
    ["slice median (live)", (d) => d.live.slicedMedian],
    ["filler served median (live)", (d) => d.live.fillerServedMedian],
    ["agedEval median (live)", (d) => d.live.agedEvalMedian],
    ["fails.mcap median (live)", (d) => d.live.failsMcapMedian],
    ["candidates / window", (d) => d.ticks.candidates],
    ["pushed / window", (d) => d.ticks.pushed],
    ["ms p50", (d) => d.ticks.msP50],
    ["deadMarked (/debug/pool)", (d) => d.pool.deadMarked],
    ["poolQueryCount (/debug/pool)", (d) => d.pool.poolQueryCount],
  ];

  console.log(`before: ${beforePath}  (${before.label}, ${iso(before.at)})`);
  console.log(`after:  ${afterPath}  (${after.label}, ${iso(after.at)})`);
  console.log(
    "\nreading                              before        after        delta",
  );
  console.log("-".repeat(78));
  for (const [label, get] of rows) {
    if (label.startsWith("--")) {
      console.log(label);
      continue;
    }
    const a = get(before);
    const b = get(after);
    const bothNumbers = typeof a === "number" && typeof b === "number";
    const delta = bothNumbers ? b - a : null;
    const pctText =
      bothNumbers && a !== 0 ? ` (${((delta / Math.abs(a)) * 100).toFixed(1)}%)` : "";
    console.log(
      label.padEnd(36) +
        fmt(a).padStart(12) +
        fmt(b).padStart(13) +
        (delta === null
          ? "".padStart(12)
          : `${delta > 0 ? "+" : ""}${fmt(delta)}${pctText}`.padStart(17)),
    );
  }
  console.log(
    "\nwatch: filler served and pool rows should fall; evidenced pool, agedEval,\n" +
      "candidates and pushed should hold. Evidenced falling WITH the filler is the\n" +
      "signature of a 3h bound that is evicting rows the pair lane still reaches.",
  );
}

try {
  if (MODE === "compare") compare();
  else if (MODE === "snapshot") await snapshot();
  else {
    console.error(`unknown mode "${MODE}" — use snapshot or compare`);
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
}
