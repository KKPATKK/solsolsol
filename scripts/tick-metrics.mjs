#!/usr/bin/env node
/*
 * Tick metrics — the SAME yardstick before and after a tick-cost change.
 *
 * Two halves, because they answer different questions and live in different
 * places:
 *
 *   1. LIVE SAMPLE (this script's `sample` mode): polls /health and records one
 *      row per DISTINCT completed tick (deduped on heartbeat.at), keeping the
 *      per-tick diag the durable tables do not carry — feedsMs, the feed legs,
 *      pairs / pairsJup / pairsMissing, organicNoLine / organicWaited /
 *      organicRetried, jupReserved — plus the feedMakeup and dex counters so a
 *      window can be read as deltas rather than as one isolate's lifetime.
 *   2. FEED ATTRIBUTION: /debug/feed-stats snapshots at the start and the end of
 *      the sample, so "new coins per feed" is a delta over the window (the
 *      endpoint itself is all-time and cached).
 *
 * The durable 240-tick window (ms / profiles / pool / candidates / pushed) is
 * /debug/scan-history &rows=240 — read it with `durable` so the comparison uses
 * one command for both sides.
 *
 * Read-only: GET /health, /debug/feed-stats, /debug/scan-history. No writes, no
 * debug knobs flipped.
 *
 *   node scripts/tick-metrics.mjs sample --out /tmp/before.jsonl --minutes 20
 *   node scripts/tick-metrics.mjs report --in /tmp/before.jsonl
 *   node scripts/tick-metrics.mjs durable --label before
 *
 * --base defaults to the production worker; --interval is the poll spacing in
 * seconds (10s is well under the ~32s tick cadence, so no tick is missed).
 */
import fs from "node:fs";

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > 0 ? process.argv[i + 1] : "https://solana-meme-bot.cool1999k.workers.dev";
})();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const MODE = process.argv[2] ?? "report";

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The per-tick row this script keeps: only fields that are per-TICK readings. */
function tickRow(health) {
  const sm = health.summary ?? {};
  const hb = health.heartbeat ?? {};
  const at = num(hb.at);
  if (at === null) return null;
  const legOf = (name) => num((sm.feedLegMs ?? {})[name]);
  const dex = sm.dex ?? {};
  return {
    at,
    ok: hb.ok === true,
    via: typeof hb.via === "string" ? hb.via : null,
    ms: num(hb.ms),
    feedsMs: num(sm.feedsMs),
    feedJoinMs: num(sm.feedJoinMs),
    feedLegs: {
      profiles: legOf("profiles"),
      pump: legOf("pump"),
      jup: legOf("jup"),
      raydium: legOf("raydium"),
      meteora: legOf("meteora"),
      jupTrend: legOf("jupTrend"),
      gecko: legOf("gecko"),
    },
    profiles: num(sm.profiles),
    boosts: num(sm.boosts),
    jupTrend: num(sm.jupTrend),
    pool: num(sm.pool),
    pairs: num(sm.pairs),
    pairsJup: num(sm.pairsJup),
    pairsMissing: num(sm.pairsMissing),
    organicNoLine: num(sm.organicNoLine),
    organicWaited: num(sm.organicWaited),
    organicRetried: num(sm.organicRetried),
    jupReserved: num(sm.jupReserved),
    candidates: num(sm.candidates),
    pushed: num(sm.pushed),
    feedMakeup: {
      feedRequests: num(sm.feedMakeup?.feedRequests),
      cadenceSkips: num(sm.feedMakeup?.cadenceSkips),
      failedTotal: num(sm.feedMakeup?.failedTotal),
      injectedTotal: num(sm.feedMakeup?.injectedTotal),
      lastRawProfiles: num(sm.feedMakeup?.lastRawProfiles),
    },
    dex: {
      pairCacheHits: num(dex.pairCacheHits),
      pairCacheMisses: num(dex.pairCacheMisses),
      pairCacheRefused: num(dex.pairCacheRefused),
      listCacheHits: num(dex.listCacheHits),
      listCacheMisses: num(dex.listCacheMisses),
      http429: num(dex.http429),
      probeDeferrals: num(dex.probeDeferrals),
      episodeDeferrals: num(dex.episodeDeferrals),
    },
  };
}

const feedsSnapshot = (stats) => ({
  kind: "feeds",
  at: Date.now(),
  byFeed: (stats.byFeed ?? []).map((r) => ({
    feed: String(r.feed),
    coins: Number(r.coins ?? 0),
    pushed: Number(r.pushed ?? 0),
  })),
});

async function sample() {
  const out = arg("out", "/tmp/ticks.jsonl");
  const minutes = Number(arg("minutes", 20));
  const intervalMs = Number(arg("interval", 10)) * 1000;
  const endAt = Date.now() + minutes * 60_000;
  const seen = new Set();
  // Resume an earlier run's file: dedupe against what is already there.
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.kind !== "feeds") seen.add(row.at);
      } catch {
        /* a torn line is not a tick */
      }
    }
  }
  const write = (row) => fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
  try {
    write(feedsSnapshot(await getJson("/debug/feed-stats")));
  } catch (err) {
    console.error(`[metrics] feed-stats at start failed: ${err.message}`);
  }
  let polls = 0;
  let added = 0;
  let consecutiveErrors = 0;
  while (Date.now() < endAt) {
    try {
      const row = tickRow(await getJson("/health"));
      polls += 1;
      consecutiveErrors = 0;
      if (row && !seen.has(row.at)) {
        seen.add(row.at);
        write(row);
        added += 1;
      }
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[metrics] poll failed (${consecutiveErrors}): ${err.message}`);
    }
    if (consecutiveErrors >= 5) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  try {
    write(feedsSnapshot(await getJson("/debug/feed-stats")));
  } catch (err) {
    console.error(`[metrics] feed-stats at end failed: ${err.message}`);
  }
  console.log(
    `[metrics] sampled ${added} new tick(s) over ${polls} poll(s) -> ${out} (${seen.size} total)`,
  );
}

const pct = (sorted, p) => {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const stats = (values) => {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    p50: round(pct(v, 0.5)),
    p90: round(pct(v, 0.9)),
    max: round(v[v.length - 1]),
    mean: round(sum / v.length),
  };
};
const sum = (values) =>
  values.reduce((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);

function report() {
  const file = arg("in", "/tmp/ticks.jsonl");
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ticks = rows.filter((r) => r.kind !== "feeds").sort((a, b) => a.at - b.at);
  const feeds = rows.filter((r) => r.kind === "feeds").sort((a, b) => a.at - b.at);
  if (ticks.length === 0) {
    console.log(`no ticks in ${file}`);
    return;
  }
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const spanMin = (last.at - first.at) / 60_000;
  const line = (k, v) => console.log(`| ${k} | ${v} |`);
  console.log(`## ${file}`);
  console.log(
    `\nwindow: ${new Date(first.at).toISOString()} → ${new Date(last.at).toISOString()} ` +
      `(${ticks.length} ticks, ${spanMin.toFixed(0)} min)`,
  );
  console.log("\n| reading | value |");
  console.log("|---|---|");
  line("ticks", ticks.length);
  line("failed ticks", ticks.filter((t) => !t.ok).length);
  for (const key of ["ms", "feedsMs", "feedJoinMs", "pool", "evalMs"].filter((k) => k in first)) {
    const s = stats(ticks.map((t) => t[key]));
    if (s.n) line(`${key} p50 / p90 / max`, `${s.p50} / ${s.p90} / ${s.max} ms`);
  }
  const legs = ["profiles", "pump", "jup", "raydium", "meteora", "jupTrend", "gecko"];
  for (const leg of legs) {
    const s = stats(ticks.map((t) => t.feedLegs?.[leg]));
    if (s.n) line(`feedLeg ${leg} p50 / p90`, `${s.p50} / ${s.p90} ms`);
  }
  const pair = stats(ticks.map((t) => t.pairs));
  const pairJup = stats(ticks.map((t) => t.pairsJup));
  const missing = stats(ticks.map((t) => t.pairsMissing));
  if (pair.n) line("pairs p50 / p90", `${pair.p50} / ${pair.p90}`);
  if (pairJup.n) line("pairsJup p50 / p90", `${pairJup.p50} / ${pairJup.p90}`);
  if (missing.n) line("pairsMissing p50 / p90 / max", `${missing.p50} / ${missing.p90} / ${missing.max}`);
  const pairSum = sum(ticks.map((t) => t.pairs));
  const missingSum = sum(ticks.map((t) => t.pairsMissing));
  if (pairSum > 0) line("pairsMissing share", `${((missingSum / pairSum) * 100).toFixed(1)}%`);
  line("organicNoLine total", sum(ticks.map((t) => t.organicNoLine)));
  line("organicWaited total", sum(ticks.map((t) => t.organicWaited)));
  line("organicRetried total", sum(ticks.map((t) => t.organicRetried)));
  const reserved = ticks.map((t) => t.jupReserved).filter((v) => typeof v === "number");
  if (reserved.length) {
    line("jupReserved total", sum(reserved));
    line("jupReserved mean / ticks>0", `${round(sum(reserved) / reserved.length)} / ${reserved.filter((v) => v > 0).length}`);
  }
  const profiles = stats(ticks.map((t) => t.profiles));
  if (profiles.n) line("profiles p50 / min / max", `${profiles.p50} / ${Math.min(...ticks.map((t) => t.profiles ?? 0))} / ${profiles.max}`);
  line("candidates total", sum(ticks.map((t) => t.candidates)));
  line("pushed total", sum(ticks.map((t) => t.pushed)));

  // Counters: the FIRST and LAST reading of the window, as a delta. A cold
  // isolate restarts them, so a negative delta is reported as a restart rather
  // than silently printed as a decrease.
  const delta = (pick) => {
    const a = pick(first);
    const b = pick(last);
    if (typeof a !== "number" || typeof b !== "number") return null;
    return b - a;
  };
  const fmRequests = delta((t) => t.feedMakeup?.feedRequests);
  const fmSkips = delta((t) => t.feedMakeup?.cadenceSkips);
  const fmFailed = delta((t) => t.feedMakeup?.failedTotal);
  const fmInjected = delta((t) => t.feedMakeup?.injectedTotal);
  const fmt = (v) => (v === null ? "n/a" : v >= 0 ? `+${v}` : `${v} (isolate restart)`);
  console.log("\n| counter delta (first → last tick) | value |");
  console.log("|---|---|");
  line("feedMakeup.feedRequests", fmt(fmRequests));
  line("feedMakeup.cadenceSkips", fmt(fmSkips));
  line("feedMakeup.failedTotal", fmt(fmFailed));
  line("feedMakeup.injectedTotal", fmt(fmInjected));
  line("dex.pairCacheHits", fmt(delta((t) => t.dex?.pairCacheHits)));
  line("dex.pairCacheMisses", fmt(delta((t) => t.dex?.pairCacheMisses)));
  line("dex.listCacheHits", fmt(delta((t) => t.dex?.listCacheHits)));
  line("dex.http429", fmt(delta((t) => t.dex?.http429)));
  line("dex.probeDeferrals", fmt(delta((t) => t.dex?.probeDeferrals)));
  line("dex.episodeDeferrals", fmt(delta((t) => t.dex?.episodeDeferrals)));

  if (feeds.length >= 2) {
    const a = feeds[0];
    const b = feeds[feeds.length - 1];
    const minutes = (b.at - a.at) / 60_000;
    const before = new Map(a.byFeed.map((r) => [r.feed, r.coins]));
    console.log(`\n### new coins per feed (${minutes.toFixed(0)} min, from /debug/feed-stats)`);
    console.log("\n| feed | coins | pushed | coins/240t |");
    console.log("|---|---|---|---|");
    for (const row of b.byFeed) {
      const gained = row.coins - (before.get(row.feed) ?? row.coins);
      console.log(
        `| ${row.feed} | +${gained} | ${row.pushed} | ${((gained / minutes) * 128).toFixed(2)} |`,
      );
    }
    console.log("\n(coins/240t = the window's rate projected onto 240 ticks at ~32s each)");
  }
}

/**
 * The durable 240-tick window. Every metric here is written by the tick itself,
 * so it survives isolate recycling — the half a live sample cannot reconstruct
 * after the fact.
 */
async function durable() {
  const rows = Number(arg("rows", 240));
  const label = arg("label", "window");
  const data = await getJson(`/debug/scan-history?rows=${rows}`);
  const hist = data.rows ?? [];
  const at = hist.map((r) => Date.parse(r.at)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < at.length; i++) gaps.push((at[i] - at[i - 1]) / 1000);
  gaps.sort((a, b) => a - b);
  const ms = stats(hist.map((r) => r.ms));
  const profiles = stats(hist.map((r) => r.profiles));
  const pool = stats(hist.map((r) => r.pool));
  console.log(`\n### durable window — ${label}`);
  console.log(`\n| reading | value |`);
  console.log(`|---|---|`);
  console.log(`| ticks | ${hist.length} |`);
  console.log(
    `| span | ${at.length ? `${((at[at.length - 1] - at[0]) / 3_600_000).toFixed(2)} h` : "n/a"} |`,
  );
  console.log(`| tick gap p50 / p90 | ${pct(gaps, 0.5)}s / ${pct(gaps, 0.9)}s |`);
  console.log(`| scan ms p50 / p90 / max | ${ms.p50} / ${ms.p90} / ${ms.max} |`);
  console.log(`| profiles p50 / min / max | ${profiles.p50} / ${profiles.min ?? Math.min(...hist.map((r) => r.profiles ?? 0))} / ${profiles.max} |`);
  console.log(`| pool p50 | ${pool.p50} |`);
  console.log(`| candidates total | ${sum(hist.map((r) => r.candidates))} |`);
  console.log(`| pushed total | ${sum(hist.map((r) => r.pushed))} |`);
  console.log(`| gaps > 120s | ${data.gaps?.length ?? 0} |`);
}

if (MODE === "sample") await sample();
else if (MODE === "durable") await durable();
else report();
