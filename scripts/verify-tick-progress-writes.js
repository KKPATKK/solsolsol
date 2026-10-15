#!/usr/bin/env node
/*
 * L2 (2026-10-14) ACCEPTANCE READ. The phase ladder is risk-gated
 * (TICK_PHASE_STAMP_MIN_MS, see src/worker.ts), so a healthy tick should write
 * exactly ONE `worker_state.tick_progress` row (the pre-flush record; the
 * ADMISSION stamp rides the claim batch and costs none) instead of the ~3.9
 * measured before. This script answers "is the gate live?" from the Worker's
 * own telemetry, with NO writes of its own.
 *
 * WHAT IT READS
 *   1. `/health` — `heartbeat.summary.dbTickSteps["setWorkerState:tick_progress"]`
 *      is the PER-TICK census (the zero point is snapshotted at the top of every
 *      runOnce, so the tick's tail is included): the row count of ONE tick, the
 *      sharp reading.
 *      `summary.dbSteps[...]` is cumulative since the isolate booted, so it is
 *      read as a RATIO against `dbSteps.claimScanLock` (the per-run marker):
 *      ~3.9 rows/run is the pre-gate shape, ~1.0-1.2 the gated one.
 *   2. `/debug/scan-history?rows=N` — the durable tick rows: the ms histogram
 *      (which says how many ticks are past the 5s bound, i.e. how many are
 *      allowed to buy a phase row) and every `prog` note. A `prog` note is
 *      written by a SUCCESSOR tick for a dead one (see tickProgressNote), so 0
 *      notes means "no tick died in this window", not "the gate ate them" —
 *      the row that would prove the gate kept the death witness only exists
 *      once a tick actually dies.
 *
 * WHY THE RATIO AND NOT THE RAW COUNTER (see scripts/read-heartbeat.js for the
 * full argument): `/health` is itself a Worker invocation on the same isolate
 * and the step counter is module state, so a probe can add — or hide — the very
 * round trips it is counting (it can even run the stale-scan fallback, and a
 * tick it triggers is counted on BOTH sides of this ratio). For a reading that
 * cannot move the number it reports, read the durable row instead:
 * `node scripts/read-heartbeat.js`.
 *
 * READ-ONLY BY CONSTRUCTION: two GETs. No worker_state write, no counter, no
 * state of any kind (the seeded values come from `--worker`/argv only).
 *
 * Run: node scripts/verify-tick-progress-writes.js
 *      node scripts/verify-tick-progress-writes.js --samples 8 --gap 20
 *      node scripts/verify-tick-progress-writes.js --expect-live   (exit 1
 *        unless the census looks gated — for a check that must not pass early)
 */
"use strict";

const DEFAULT_WORKER = "https://solana-meme-bot.cool1999k.workers.dev";
/** The pre-gate shape, measured 2026-10-14/15: 65/17 and 94/24 rows per run. */
const PRE_GATE_ROWS_PER_RUN = 3.9;
/** A gated tick writes the one pre-flush record; slow ticks add a few. */
const GATED_ROWS_PER_RUN_MAX = 2.0;
/** The gate's own bound, restated here so the histogram split needs no import. */
const PHASE_STAMP_MIN_MS = 5_000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : String(process.argv[i + 1] ?? "");
};

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** One `/health` reading, reduced to the two numbers this check is about. */
function census(health) {
  const s = health?.heartbeat?.summary ?? {};
  const steps = s.dbSteps ?? {};
  const tick = s.dbTickSteps ?? {};
  return {
    at: num(health?.heartbeat?.at),
    ms: num(health?.heartbeat?.ms),
    phase: health?.heartbeat?.phase ?? null,
    ok: health?.heartbeat?.ok === true,
    runs: num(steps.claimScanLock?.calls),
    rows: num(steps["setWorkerState:tick_progress"]?.calls),
    // This tick's own count: absent means the tick wrote none at all (the
    // method is omitted from the census when it cost nothing).
    tickRows: num(tick["setWorkerState:tick_progress"]?.calls),
    // Whether the per-tick census exists at all. It must, or a 0 would be
    // "the reading is missing" and read as "the tick wrote nothing".
    hasCensus: Object.keys(tick).length > 0,
  };
}

async function main() {
  const base = (argOf("--worker") || DEFAULT_WORKER).replace(/\/+$/, "");
  const samples = Math.max(1, Number(argOf("--samples") ?? 6) || 6);
  const gapSeconds = Math.max(0, Number(argOf("--gap") ?? 15) || 0);

  console.log(`tick_progress write census — ${base}`);
  console.log(
    `expectation: healthy tick (ms < ${PHASE_STAMP_MIN_MS}) = 1 row; ` +
      `pre-gate isolate ratio ≈ ${PRE_GATE_ROWS_PER_RUN} rows/run\n`,
  );

  const ticks = new Map();
  let last = null;
  for (let i = 1; i <= samples; i++) {
    last = census(await getJson(base, "/health"));
    // One row per TICK, not per sample: repeated samples between two ticks
    // would otherwise count the same tick twice.
    if (!ticks.has(last.at)) ticks.set(last.at, last);
    process.stdout.write(
      `  sample ${i}: tick @ ${new Date(last.at).toISOString()} ms=${last.ms} ` +
        `phase=${last.phase} tick_progress=${last.tickRows} row(s) ` +
        `| since boot ${last.rows}/${last.runs} runs\n`,
    );
    if (i < samples && gapSeconds > 0) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  }

  const perTick = [...ticks.values()].sort((a, b) => a.at - b.at);
  const healthy = perTick.filter((t) => t.ms < PHASE_STAMP_MIN_MS);
  const slow = perTick.filter((t) => t.ms >= PHASE_STAMP_MIN_MS);
  console.log(`\nper-tick rows (${perTick.length} distinct tick(s)):`);
  for (const t of perTick)
    console.log(
      `  ${new Date(t.at).toISOString()}  ms ${String(t.ms).padStart(6)}  ` +
        `${t.tickRows} row(s)${t.ms >= PHASE_STAMP_MIN_MS ? "  (past the bound — a phase row is allowed)" : ""}`,
    );
  console.log(
    `  healthy ticks: ${healthy.length} → rows ${healthy.map((t) => t.tickRows).join(", ") || "-"}` +
      ` | slow ticks: ${slow.length}`,
  );

  const ratio = last.runs > 0 ? last.rows / last.runs : null;
  console.log(
    `\nisolate ratio: ${last.rows} rows / ${last.runs} runs = ` +
      `${ratio === null ? "n/a" : ratio.toFixed(2)} rows/run ` +
      `(pre-gate ${PRE_GATE_ROWS_PER_RUN}, gated ≤ ~1.2)`,
  );

  const hist = await getJson(base, `/debug/scan-history?rows=500`);
  const rows = Array.isArray(hist?.rows) ? hist.rows : [];
  const buckets = { "0-3s": 0, "3-5s": 0, "5-8s": 0, "8-12s": 0, "12s+": 0 };
  for (const r of rows) {
    const ms = num(r.ms);
    if (ms < 3_000) buckets["0-3s"]++;
    else if (ms < 5_000) buckets["3-5s"]++;
    else if (ms < 8_000) buckets["5-8s"]++;
    else if (ms < 12_000) buckets["8-12s"]++;
    else buckets["12s+"]++;
  }
  const failed = rows.filter((r) => r.ok === false || r.ok === 0);
  const prog = rows.filter((r) => String(r.err ?? "").includes("prog"));
  const pastBound = buckets["5-8s"] + buckets["8-12s"] + buckets["12s+"];
  console.log(`\nscan-history (${rows.length} tick(s)):`);
  if (rows.length > 0)
    console.log(
      `  ${new Date(rows[rows.length - 1].at).toISOString()} → ${new Date(rows[0].at).toISOString()}`,
    );
  console.log(`  ms histogram: ${JSON.stringify(buckets)}`);
  console.log(
    `  past the ${PHASE_STAMP_MIN_MS}ms bound: ${pastBound} ` +
      `(${rows.length > 0 ? ((pastBound / rows.length) * 100).toFixed(1) : "0.0"}% — these may buy a phase row)`,
  );
  console.log(`  ok=0 rows: ${failed.length}`);
  console.log(
    `  prog notes: ${prog.length}` +
      ` (a note is written by a SUCCESSOR tick for a dead one — 0 means no death, not a lost witness)`,
  );
  for (const r of prog.slice(0, 5))
    console.log(`    ${new Date(r.at).toISOString()} ms=${num(r.ms)} ${String(r.err).slice(0, 160)}`);

  // Live means the readings agree: the isolate ratio is down AND no healthy
  // tick paid more than the one pre-flush record. The census half carries the
  // verdict when the ratio cannot (a fresh isolate with 1-3 runs has no ratio
  // to speak of), but only from ticks that actually published a census — a
  // missing `dbTickSteps` must not read as "wrote nothing".
  const censusTicks = perTick.filter((t) => t.hasCensus);
  const censusHealthy = censusTicks.filter((t) => t.ms < PHASE_STAMP_MIN_MS);
  const censusHealthyMax =
    censusHealthy.length > 0 ? Math.max(...censusHealthy.map((t) => t.tickRows)) : null;
  const censusLive = censusHealthyMax !== null && censusHealthyMax <= 1;
  const ratioReady = ratio !== null && last.runs >= 4;
  let verdict;
  if (censusLive && (!ratioReady || ratio <= GATED_ROWS_PER_RUN_MAX))
    verdict =
      `LIVE — the phase ladder is gated (healthy ticks wrote ${censusHealthyMax} row(s)` +
      `${ratioReady ? `, ratio ${ratio.toFixed(2)}/run` : ", ratio not yet meaningful"})`;
  else if (ratioReady && ratio >= PRE_GATE_ROWS_PER_RUN - 0.5)
    verdict = "PRE-DEPLOY — the gate is not deployed (the pre-gate ~4 rows/run shape)";
  else if (!ratioReady && censusHealthy.length === 0)
    verdict = "ambiguous — no tick with a census and a ratio on this isolate yet";
  else if (!ratioReady) verdict = "ambiguous — not enough runs on this isolate yet";
  else verdict = `ambiguous — ratio ${ratio.toFixed(2)} (gated path with many slow ticks, or a partial rollout)`;
  console.log(
    `\nverdict: ${verdict}` +
      (censusHealthy.length > 0
        ? `\n  (per-tick census: ${censusHealthy.length} healthy tick(s), rows ${censusHealthy.map((t) => t.tickRows).join(", ")})`
        : ""),
  );

  if (process.argv.includes("--expect-live") && !verdict.startsWith("LIVE")) process.exit(1);
}

main().catch((err) => {
  console.error(
    "verify-tick-progress-writes failed:",
    err && err.message ? err.message : err,
  );
  process.exit(1);
});
