#!/usr/bin/env node
/*
 * WHO ACTUALLY MISSES THE NO-EVIDENCE ROWS — the 64-bucket page or the grace?
 *
 * WHAT THIS ANSWERS. `Db.poolBandPageSql` returns a no-evidence row only in the
 * phase its bucket names: hot advances every rotation slot (90s), near every
 * `nearSlots` slots (3 min), far every `farSlots` (12 min). The row is carried
 * only inside `POOL_MCAP_EVIDENCE_GRACE_MS` of its first sighting (3h). Those
 * two clocks are different lengths, and "how much of the cohort is never
 * returned even once before it is evicted" is arithmetic, not a guess: the
 * bucket is deterministic from the token, the phase from the clock.
 *
 * So this replays the real rules over the real cohort (the pool query's own
 * clauses, read from D1) and reports, per candidate bucket count K and per
 * candidate grace:
 *
 *   - how many rows get ZERO page appearances before they leave the pool
 *   - how many get one, and the median looks for the rest
 *   - the page size each appearance implies (the filler lane takes 18/tick,
 *     3 ticks per appearance = 54 rows a page can clear)
 *   - the current slot's page, against the live `poolServed.filler` reading
 *
 * It also counts what the sweeps have actually produced: a no-evidence row
 * with `sweeps_since_reading > 0` was served and came back without a reading,
 * which is the only direct measure of whether sweeping these rows can ever
 * turn one into evidence.
 *
 * READ-ONLY: GET /health, /debug/chats, /debug/pool, and SELECT-only D1 via
 * scripts/open-store.js. No writes, no knobs flipped.
 *
 *   node scripts/noevidence-page-audit.mjs
 *   node scripts/noevidence-page-audit.mjs --json
 *   node scripts/noevidence-page-audit.mjs --buckets 64,48,32,24,16 --grace 3,2,1.5
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "https://solana-meme-bot.cool1999k.workers.dev");
const H = 3_600_000;
const M = 60_000;
/** The pool query's slot period (REEVAL_POOL_CACHE_SECONDS = 90). */
const SLOT_MS = 90_000;
/** The scan cadence the filler lane is sized against. */
const TICK_MS = 30_000;
const TICKS_PER_SLOT = Math.round(SLOT_MS / TICK_MS);
/** db.POOL_* — the band geometry the query builds every tick. */
const HOT_SIDE_MS = 30 * M;
const NEAR_WINDOW_MS = 6 * H;
const AGE_MARGIN_MS = 180 * M;
const NEAR_SLOTS = 2;
const FAR_SLOTS = 8;
/** scanner.POOL_SLICE_FILLER_SHARE x RE_EVAL_PER_TICK_MAX = 0.12 x 150. */
const FILLER_PER_TICK = 18;
/** K = db.POOL_BAND_ROTATE_BUCKETS. */
const DEFAULT_BUCKETS = 64;
const DEFAULT_GRACE_H = 3;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * The page bucket the SQL's expression names, for a given K:
 *   (UNICODE(SUBSTR(token,1)) + UNICODE(SUBSTR(token,-1)) * 17 + phase) % K == 0
 * solved for the phase that returns the row.
 */
function pageBucket(token, K) {
  const first = token.codePointAt(0) ?? 0;
  const last = token.codePointAt(token.length - 1) ?? 0;
  return (((-(first + last * 17)) % K) + K) % K;
}

/** The band geometry at one instant, mirroring Db.getReevalPoolBatched. */
function bandsAt(t, win) {
  const center = t - win.minAgeMs;
  const spanLo = t - (win.maxAgeMs + AGE_MARGIN_MS);
  const hotLo = Math.max(spanLo, center - HOT_SIDE_MS);
  const hotHi = Math.min(t - (win.minAgeMs - AGE_MARGIN_MS), center + HOT_SIDE_MS);
  const nearLo = Math.max(spanLo, center - NEAR_WINDOW_MS);
  return { spanLo, hotLo, hotHi, nearLo, rotHi: hotLo };
}

/**
 * Would this row be returned in the page of slot `slot`? Same three tests as
 * the query: its band must be the one being queried, its sub-window must be
 * the selected one (near/far), and its bucket must equal that band's phase.
 */
/** Which band a row sits in at one instant (the page's clock key). */
function bandOfAt(row, t, win) {
  const b = bandsAt(t, win);
  if (row.launch > b.hotHi) return "young";
  if (row.launch >= b.hotLo) return "hot";
  if (b.rotHi > b.nearLo && row.launch >= b.nearLo) {
    const w = (b.rotHi - b.nearLo) / NEAR_SLOTS;
    return Math.floor((b.rotHi - row.launch) / w) <= 0 ? "near0" : "near1";
  }
  return "far";
}

function appearsAt(row, slot, K, graceMs, win) {
  const t = slot * SLOT_MS + SLOT_MS / 2;
  if (t >= row.firstSeen + graceMs) return false;
  const b = bandsAt(t, win);
  if (row.launch >= b.hotLo && row.launch <= b.hotHi) {
    return pageBucket(row.token, K) === slot % K;
  }
  if (b.rotHi > b.nearLo && row.launch >= b.nearLo && row.launch < b.rotHi) {
    const w = (b.rotHi - b.nearLo) / NEAR_SLOTS;
    const s = slot % NEAR_SLOTS;
    const lo = b.rotHi - (s + 1) * w;
    const hi = b.rotHi - s * w;
    if (row.launch < lo || row.launch >= hi) return false;
    return pageBucket(row.token, K) === Math.floor(slot / NEAR_SLOTS) % K;
  }
  if (b.nearLo > b.spanLo && row.launch >= b.spanLo && row.launch < b.nearLo) {
    const w = (b.nearLo - b.spanLo) / FAR_SLOTS;
    const s = slot % FAR_SLOTS;
    const lo = b.nearLo - (s + 1) * w;
    const hi = b.nearLo - s * w;
    if (row.launch < lo || row.launch >= hi) return false;
    return pageBucket(row.token, K) === Math.floor(slot / FAR_SLOTS) % K;
  }
  return false;
}

/** Replay the slots until the last row's grace runs out. */
function simulate(rows, K, graceMs, win) {
  const now = Date.now();
  const slot0 = Math.floor(now / SLOT_MS);
  const horizon = Math.max(...rows.map((r) => r.firstSeen + graceMs), now);
  const slots = Math.ceil((horizon - now) / SLOT_MS) + 1;
  const looks = new Map();
  const pages = [];
  for (let i = 0; i <= slots; i += 1) {
    const slot = slot0 + i;
    let page = 0;
    for (const row of rows) {
      if (appearsAt(row, slot, K, graceMs, win)) {
        page += 1;
        looks.set(row.token, (looks.get(row.token) ?? 0) + 1);
      }
    }
    if (page > 0) pages.push(page);
  }
  const counts = rows.map((r) => looks.get(r.token) ?? 0);
  const sorted = counts.slice().sort((a, b) => a - b);
  const median = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]
    : null;
  const byBand = {};
  for (const row of rows) {
    const b = row.bandNow ?? "?";
    byBand[b] ??= { n: 0, never: 0 };
    byBand[b].n += 1;
    if ((looks.get(row.token) ?? 0) === 0) byBand[b].never += 1;
  }
  return {
    byBand,
    never: counts.filter((n) => n === 0).length,
    once: counts.filter((n) => n === 1).length,
    twicePlus: counts.filter((n) => n >= 2).length,
    medianLooks: median,
    meanLooks: counts.length
      ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2))
      : null,
    pages: pages.length,
    pageMean: pages.length
      ? Number((pages.reduce((a, b) => a + b, 0) / pages.length).toFixed(1))
      : null,
    pageMax: pages.length ? Math.max(...pages) : null,
    pageOver54: pages.filter((p) => p > FILLER_PER_TICK * TICKS_PER_SLOT).length,
    pageOver18: pages.filter((p) => p > FILLER_PER_TICK).length,
  };
}

async function main() {
  const chats = await getJson("/debug/chats");
  const pool = await getJson("/debug/pool");
  // /health can answer without its summary while the isolate is still booting
  // (ok:false / initError); retry once before treating the pair lane as unread.
  let live = {};
  for (let attempt = 0; attempt < 2 && !live.pairs; attempt += 1) {
    const health = await getJson("/health");
    live = health.summary ?? {};
    if (!live.pairs) await new Promise((r) => setTimeout(r, 5_000));
  }
  const win = {
    minAgeMs: (chats.poolWindow?.minAgeMin ?? 80) * M,
    maxAgeMs: (chats.poolWindow?.maxAgeMin ?? 1560) * M,
  };
  const enabled = (chats.chats ?? []).filter((c) => c.enabled).map((c) => c.chatId);
  const mcapFloor = pool.mcapFloorUsd ?? 48000;
  const mcapCeiling = pool.mcapCeilingUsd ?? 460000;
  const liqFloor = pool.liquidityFloorUsd ?? 8000;
  const now = Date.now();
  const grace3 = DEFAULT_GRACE_H * H;
  const seenClause = enabled.length
    ? ` AND token NOT IN (${enabled.map(() => "?").join(",")})`
    : "";

  const { openTarget } = require("./open-store.js");
  const t = await openTarget([]);
  console.log(`source: ${t.kind}`);

  // The pool query's own clauses, narrowed to the no-evidence population that
  // is inside its grace right now — the cohort the page filter has to sweep.
  const where = `first_seen_at > ? AND launch_ms BETWEEN ? AND ?
      AND max_mcap_observed IS NULL
      AND (max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)
      AND (last_liquidity_usd IS NULL OR NOT (last_liquidity_usd < 1000 OR sweeps_since_reading >= 3))${seenClause}`;
  const baseArgs = [
    now - grace3,
    now - (win.maxAgeMs + AGE_MARGIN_MS),
    now - (win.minAgeMs - AGE_MARGIN_MS),
    liqFloor,
    ...enabled,
  ];
  const countRow = (
    await t.select(`SELECT COUNT(*) n FROM token_stats WHERE ${where}`, baseArgs)
  ).rows[0];
  const total = Number(countRow?.n ?? 0);
  const raw = (
    await t.select(
      `SELECT token, launch_ms, first_seen_at, sweeps_since_reading, last_liquidity_usd
         FROM token_stats WHERE ${where} LIMIT 20000`,
      baseArgs,
    )
  ).rows;
  if (raw.length !== total) {
    console.log(`WARN: D1 returned ${raw.length} of ${total} rows (truncated read)`);
  }
  const rows = raw.map((r) => ({
    token: String(r.token),
    launch: Number(r.launch_ms),
    firstSeen: Number(r.first_seen_at),
    sweeps: Number(r.sweeps_since_reading ?? 0),
    liquidity: r.last_liquidity_usd === null ? null : Number(r.last_liquidity_usd),
  }));
  for (const r of rows) r.bandNow = bandOfAt(r, now, win);
  if (rows.length === 0) {
    console.log("no no-evidence rows inside the grace — nothing to measure");
    return;
  }

  // The sweep's actual yield: `sweeps_since_reading` advances when the sweep
  // produced no liquidity reading for the coin — either the answer left it out
  // (poolSweepMisses) or it named the token with no level
  // (poolSweepNoReading, 2026-10-29). Both are under the healthy-batch guard
  // (db.noteSweptWithoutReading), so a row with sweeps > 0 was served and
  // produced nothing.
  // BEFORE 2026-10-29 this column was NOT a served counter for this
  // population: a Jupiter entry counted as answered, so poolSweepMisses never
  // listed the coin and the mark never advanced (0 of 50,755 rows at >= 3).
  // That is what poolSweepNoReading closed; a Jupiter answer that NAMES a
  // level still keeps the coin out of both lists. `last_liquidity_usd` remains
  // the direct witness: if a sweep had produced a usable reading, it would be
  // non-null.
  const dist = {
    zero: rows.filter((r) => r.sweeps === 0).length,
    one: rows.filter((r) => r.sweeps === 1).length,
    two: rows.filter((r) => r.sweeps === 2).length,
    threePlus: rows.filter((r) => r.sweeps >= 3).length,
  };
  const anyReading = rows.filter((r) => r.liquidity !== null);
  const allNoEvidence = (
    await t.select(
      `SELECT COUNT(*) n, SUM(CASE WHEN last_liquidity_usd IS NOT NULL THEN 1 ELSE 0 END) liq
         FROM token_stats WHERE max_mcap_observed IS NULL`,
      [],
    )
  ).rows[0];

  // Where the cohort sits NOW: a row already past the near band can only be
  // returned by the far page (8 sub-windows x K buckets), which is a different
  // clock from the hot/near lanes the 3h grace was sized against.
  const nowBands = (() => {
    const b = bandsAt(now, win);
    const out = { hot: 0, near0: 0, near1: 0, far: 0, young: 0 };
    for (const r of rows) {
      if (r.launch > b.hotHi) out.young += 1;
      else if (r.launch >= b.hotLo) out.hot += 1;
      else if (r.launch >= b.nearLo) {
        const w = (b.rotHi - b.nearLo) / NEAR_SLOTS;
        const s = Math.floor((b.rotHi - r.launch) / w);
        if (s <= 0) out.near0 += 1;
        else out.near1 += 1;
      } else out.far += 1;
    }
    return out;
  })();
  const firstSightAge = (r) => (r.firstSeen - r.launch) / M;
  const sight = {
    sameSighting: rows.filter((r) => firstSightAge(r) < 10).length,
    within80: rows.filter((r) => firstSightAge(r) >= 10 && firstSightAge(r) < 80).length,
    late80to440: rows.filter((r) => firstSightAge(r) >= 80 && firstSightAge(r) < 440).length,
    lateOver440: rows.filter((r) => firstSightAge(r) >= 440).length,
  };

  console.log(
    `cohort: ${rows.length} no-evidence rows inside ${DEFAULT_GRACE_H}h grace` +
      ` (launch window ${(win.minAgeMs / M).toFixed(0)}–${(win.maxAgeMs / M).toFixed(0)} min, floors ${mcapFloor}/${mcapCeiling}/${liqFloor})`,
  );
  console.log(
    `bands now: hot ${nowBands.hot}, near-s0 ${nowBands.near0}, near-s1 ${nowBands.near1}, far ${nowBands.far}, younger-than-hot ${nowBands.young}`,
  );
  console.log(
    `first sighting: same-as-launch ${sight.sameSighting}, <80m ${sight.within80}, 80m-440m ${sight.late80to440}, >440m ${sight.lateOver440}`,
  );
  console.log(
    `yield: any liquidity reading ${anyReading.length}/${rows.length};` +
      ` ALL no-evidence rows with a liquidity reading ${Number(allNoEvidence.liq ?? 0)}/${Number(allNoEvidence.n ?? 0)};` +
      ` sweeps 0/1/2/3+ = ${dist.zero}/${dist.one}/${dist.two}/${dist.threePlus}` +
      ` (a Jupiter answer never advances the mark — sweeps is not a served counter here)`,
  );
  console.log(
    `pair lane: pairs ${num(live.pairs) ?? "n/a"}, pairsJup ${num(live.pairsJup) ?? "n/a"},` +
      ` fails.mcap ${num(live.fails?.mcap) ?? "n/a"}, poolSliced ${num(live.poolSliced) ?? "n/a"},` +
      ` filler served ${num(live.poolServed?.filler) ?? "n/a"}`,
  );
  // THE SHIP GATE (2026-10-29). K=24 is only worth its ~13 extra pair reads a
  // tick once a sweep can leave evidence behind. `anyReading` is that test: it
  // needs a comparable (Dex) answer, which is exactly what the page sweep is
  // starved of while the pair lane is 100% Jupiter fallback. A recovered Dex can
  // also show up as this cohort collapsing (coins would earn mcap at discovery
  // and never enter it), so the cohort size is printed beside the gate.
  const gate = anyReading.length > 0;
  console.log(
    `gate: cohort readings ${anyReading.length}/${rows.length} -> K=24 ${gate ? "ALLOWED" : "BLOCKED (stay at 64)"}`,
  );

  const buckets = String(arg("buckets", "64,48,32,24,16"))
    .split(",")
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 1);
  const graces = String(arg("grace", "3,2,1.5"))
    .split(",")
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);

  const table = [];
  for (const K of buckets) {
    const res = simulate(rows, K, grace3, win);
    table.push({ graceH: DEFAULT_GRACE_H, K, ...res });
  }
  const graceRows = [];
  for (const gh of graces) {
    if (gh === DEFAULT_GRACE_H) continue;
    const res = simulate(rows, DEFAULT_BUCKETS, gh * H, win);
    graceRows.push({ K: DEFAULT_BUCKETS, graceH: gh, ...res });
  }

  const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;
  console.log(
    `\npage cycle (grace ${DEFAULT_GRACE_H}h):  K   never      one     2+    median looks  page mean/max  pages>18/tick  pages>54`,
  );
  for (const r of table) {
    console.log(
      `  K=${String(r.K).padEnd(3)} ${pct(r.never).padStart(7)} ${pct(r.once).padStart(7)} ${pct(r.twicePlus).padStart(7)}` +
        `   ${String(r.medianLooks).padStart(10)}   ${String(r.pageMean).padStart(4)}/${String(r.pageMax).padEnd(4)}` +
        `   ${String(r.pageOver18).padStart(13)}   ${String(r.pageOver54).padStart(7)}`,
    );
    const band = (k) => {
      const v = r.byBand[k];
      return v ? `${k} ${v.never}/${v.n}` : `${k} 0/0`;
    };
    console.log(
      `        never by band now: ${band("hot")}, ${band("near0")}, ${band("near1")}, ${band("far")}, ${band("young")}`,
    );
  }
  console.log(`\ngrace (K=${DEFAULT_BUCKETS}):`);
  for (const r of graceRows) {
    console.log(
      `  grace ${String(r.graceH).padEnd(4)}h  never ${pct(r.never).padStart(7)}  one ${pct(r.once).padStart(7)}` +
        `  2+ ${pct(r.twicePlus).padStart(7)}  median looks ${String(r.medianLooks).padStart(3)}`,
    );
  }

  // Model check: the current slot's page should be in the same range as the
  // live tick's filler reading. A wide divergence means the model (not the
  // page) is wrong, and the table above should not be trusted.
  const slotNow = Math.floor(now / SLOT_MS);
  const pageNow = rows.filter((r) => appearsAt(r, slotNow, DEFAULT_BUCKETS, grace3, win)).length;
  console.log(
    `\nmodel check: current slot page ${pageNow} no-evidence rows vs live filler served ${num(live.poolServed?.filler) ?? "n/a"}/tick` +
      ` (page is shared by ${TICKS_PER_SLOT} ticks; a page of <= ${FILLER_PER_TICK * TICKS_PER_SLOT} clears inside its appearance)`,
  );
  console.log(
    `note: the model replays the page/sub-window/phase rules; it does not apply band LIMITs (hot 460 / near 518 / far 222),` +
      ` which only clip the evidenced cohort at today's sizes.`,
  );

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          at: new Date(now).toISOString(),
          cohort: rows.length,
          gate: { k24Allowed: anyReading.length > 0 },
          yield: {
            withLiquidityReading: anyReading.length,
            allNoEvidenceWithLiquidity: Number(allNoEvidence.liq ?? 0),
            allNoEvidenceRows: Number(allNoEvidence.n ?? 0),
            distribution: dist,
            pairs: num(live.pairs),
            pairsJup: num(live.pairsJup),
            failsMcap: num(live.fails?.mcap),
          },
          byBuckets: table,
          byGrace: graceRows,
          modelCheck: { slotPage: pageNow, liveFiller: num(live.poolServed?.filler) },
        },
        null,
        1,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
