#!/usr/bin/env node
/**
 * Workers Logs PER-INVOCATION CPU for solana-meme-bot.
 *
 * WHY THIS EXISTS (see .github/workflows/cf-worker-logs.yml): every CPU reading
 * this repo had before 2026-10-16 was wall clock. `ms` on the tick row, `dbMs`,
 * `poolLegMs` — a tick waits on DexScreener/Jupiter/D1 far more than it
 * computes, so none of them can say whether CPU is a ceiling. Two readings close
 * that gap, and they answer DIFFERENT questions:
 *
 *   scripts/cf-invocations.mjs — the BUDGET question ("is CPU a ceiling?"), off
 *     the GraphQL `workersInvocationsAdaptive` quantiles. Works with no
 *     observability setting at all.
 *   this script — the INVOCATION question ("which invocation spent it?"), off
 *     Workers Logs, whose records carry `$workers.cpuTimeMs` and
 *     `$workers.wallTimeMs` per invocation. It only has data once
 *     `[observability] enabled = true` (wrangler.toml) has been DEPLOYED.
 *
 * Both come from Cloudflare's own API on the deploy workflow's token, so
 * neither needs the dashboard and neither needs hardware.
 *
 * WHAT IT ASKS: Cloudflare's Workers Observability query API
 * (`POST /accounts/{id}/workers/observability/telemetry/query`) twice —
 *   view: "invocations"     one row per invocation, so the expensive tick can
 *                           be named (eventType, trigger, outcome, wall time).
 *   view: "calculations"    count/min/median/max/p90/p99 OF `$workers.cpuTimeMs`
 *                           over the whole window. This half is what makes the
 *                           answer more than a page: the invocation view is
 *                           limit-capped, a percentile is not.
 *
 * Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment,
 * WORKER / MINUTES / LIMIT / SHOW as optional knobs. Exits non-zero only when
 * it could not ask Cloudflare at all — an empty result is a reading too (it is
 * what "not enabled yet" and "no invocations" look like), so it is printed
 * rather than treated as a failure.
 */

import { appendFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const WORKER = process.env.WORKER || "solana-meme-bot";
const MINUTES = Number(process.env.MINUTES || "60");
const LIMIT = Number(process.env.LIMIT || "200");
const SHOW = Number(process.env.SHOW || "15");

/** The Workers Logs dataset name (the one the dashboard's query builder uses). */
const DATASET = "cloudflare-workers";
/** This script's own ad-hoc query id; parameters travel inline with the call. */
const QUERY_ID = "solana-meme-bot-per-invocation-cpu";

if (!TOKEN || !ACCOUNT) {
  console.error(
    "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set. " +
      "They are repository Actions secrets used by deploy.yml.",
  );
  process.exit(2);
}

if (!(MINUTES > 0) || MINUTES > 24 * 60) {
  console.error(`MINUTES must be 1..1440 (got ${process.env.MINUTES})`);
  process.exit(2);
}

const to = Date.now();
const from = to - MINUTES * 60_000;

function say(line) {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, line + "\n");
    } catch {
      /* the log is the primary channel; the summary is a convenience */
    }
  }
}

const URL =
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
  `/workers/observability/telemetry/query`;

async function query(body) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`Cloudflare returned non-JSON (HTTP ${res.status}):`);
    console.error(text.slice(0, 800));
    process.exit(2);
  }
  return { status: res.status, json };
}

/**
 * The filter that scopes every dataset row to this Worker. `$metadata.service`
 * is the documented key (the query builder's own examples use it), and the
 * value is the wrangler.toml `name`.
 */
const workerFilter = {
  key: "$metadata.service",
  operation: "eq",
  type: "string",
  value: WORKER,
};

const baseParameters = {
  datasets: [DATASET],
  filterCombination: "and",
  filters: [workerFilter],
};

function stamp(ms) {
  return new Date(ms).toISOString();
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

say(`# Workers Logs · per-invocation CPU · ${WORKER}`);
say("");
say(`window: ${stamp(from)} → ${stamp(to)} (${MINUTES} min)`);
say(`dataset: ${DATASET} · filter: $metadata.service = ${WORKER}`);
say("");

/* ---------------------------------------------------------------- the page */

const page = await query({
  queryId: QUERY_ID,
  timeframe: { from, to },
  view: "invocations",
  limit: LIMIT,
  parameters: baseParameters,
});

if (!page.json?.success) {
  console.error(`observability query failed (HTTP ${page.status}):`);
  console.error(JSON.stringify(page.json?.errors ?? page.json, null, 2).slice(0, 2000));
  if (page.status === 403 || page.status === 401) {
    console.error(
      "\nA 403 here is the TOKEN, not the Worker: reading Workers Logs needs " +
        "the account token to carry Workers Observability Read (Metadata " +
        "Read-Only) alongside the deploy permissions it already has.",
    );
  }
  process.exit(2);
}

const groups = page.json.result?.invocations ?? {};
const stats = page.json.result?.statistics ?? {};

/**
 * Each key is a request id; each value is every event Workers Logs stored for
 * that invocation. The invocation's OWN record is the one carrying
 * `$workers.cpuTimeMs` — log lines next to it are message rows with no
 * `$workers` (or the timing-free variant), which is why the search for the
 * timing record is explicit rather than "take element 0".
 */
const rows = [];
let groupsWithoutTiming = 0;
for (const [requestId, events] of Object.entries(groups)) {
  const list = Array.isArray(events) ? events : [events];
  const timed = list.find((e) => num(e?.$workers?.cpuTimeMs) !== null);
  if (!timed) {
    groupsWithoutTiming++;
    continue;
  }
  const w = timed.$workers;
  const meta = timed.$metadata ?? {};
  rows.push({
    requestId: w.requestId || meta.requestId || requestId,
    cpuTimeMs: w.cpuTimeMs,
    wallTimeMs: num(w.wallTimeMs),
    outcome: w.outcome ?? "?",
    eventType: w.eventType ?? "?",
    trigger: meta.trigger ?? "",
    origin: meta.origin ?? "",
    at: typeof timed.timestamp === "number" ? timed.timestamp : null,
  });
}

rows.sort((a, b) => b.cpuTimeMs - a.cpuTimeMs);

say(
  `invocation groups returned: ${Object.keys(groups).length}` +
    ` · carrying $workers.cpuTimeMs: ${rows.length}` +
    (groupsWithoutTiming ? ` · groups with no timing record: ${groupsWithoutTiming}` : ""),
);
say(
  `query statistics: rows_read ${stats.rows_read ?? "?"} · bytes_read ${stats.bytes_read ?? "?"}` +
    ` · abr_level ${stats.abr_level ?? 1}` +
    (stats.abr_level && stats.abr_level > 1
      ? "  <- ABR sampling is on: counts below are estimates"
      : ""),
);
say("");

if (rows.length > 0) {
  const cpu = rows.map((r) => r.cpuTimeMs).slice().sort((a, b) => a - b);
  const sum = cpu.reduce((a, b) => a + b, 0);
  say(`## the most expensive invocations in this page (top ${Math.min(SHOW, rows.length)})`);
  say("");
  say("| at | event | outcome | cpuMs | wallMs | trigger | requestId |");
  say("|---|---|---|---|---|---|---|");
  for (const r of rows.slice(0, SHOW)) {
    say(
      `| ${r.at ? stamp(r.at) : "?"} | ${r.eventType} | ${r.outcome} | ` +
        `**${r.cpuTimeMs}** | ${r.wallTimeMs ?? "?"} | ${r.trigger || r.origin || "-"} | ` +
        `${String(r.requestId).slice(0, 12)} |`,
    );
  }
  say("");
  say(
    `this page: n=${rows.length} · mean ${(sum / rows.length).toFixed(1)}ms · ` +
      `p50 ${pct(cpu, 50)}ms · p90 ${pct(cpu, 90)}ms · max ${cpu[cpu.length - 1]}ms`,
  );

  // Per-invocation CPU is only interesting BY EVENT TYPE: the cron tick is the
  // suspected ceiling and a /health poll is not, so summing them together
  // would hide the one reading this script exists for.
  const byType = new Map();
  for (const r of rows) {
    const k = r.eventType;
    const acc = byType.get(k) ?? { n: 0, sum: 0, max: 0 };
    acc.n++;
    acc.sum += r.cpuTimeMs;
    acc.max = Math.max(acc.max, r.cpuTimeMs);
    byType.set(k, acc);
  }
  say("");
  say("### by event type (this page)");
  say("");
  say("| eventType | n | mean cpuMs | max cpuMs |");
  say("|---|---|---|---|");
  for (const [k, v] of [...byType].sort((a, b) => b[1].sum - a[1].sum)) {
    say(`| ${k} | ${v.n} | ${(v.sum / v.n).toFixed(1)} | ${v.max} |`);
  }
} else {
  say(
    "No invocation carried $workers.cpuTimeMs in this window. That is the " +
      "shape of \"Workers Logs is not ingesting yet\", not of an error: the " +
      "setting only applies from the deploy that carried it, and the window " +
      "may simply predate it. Widen MINUTES to include the deploy, or confirm " +
      "that [observability] enabled = true reached the live Worker.",
  );
  const sample = JSON.stringify(page.json.result ?? {}).slice(0, 600);
  say("");
  say("raw result (truncated): " + sample);
}

/* --------------------------------------------------------- the percentiles */

const calcs = [
  { key: "$workers.cpuTimeMs", operator: "count", alias: "n" },
  { key: "$workers.cpuTimeMs", operator: "min", alias: "min" },
  { key: "$workers.cpuTimeMs", operator: "median", alias: "median" },
  { key: "$workers.cpuTimeMs", operator: "avg", alias: "avg" },
  { key: "$workers.cpuTimeMs", operator: "max", alias: "max" },
  { key: "$workers.cpuTimeMs", operator: "p90", alias: "p90" },
  { key: "$workers.cpuTimeMs", operator: "p99", alias: "p99" },
];

const agg = await query({
  queryId: QUERY_ID + "-agg",
  timeframe: { from, to },
  view: "calculations",
  chartType: "aggregate",
  ignoreSeries: true,
  parameters: { ...baseParameters, calculations: calcs },
});

say("");
say("## whole window (percentiles are NOT limit-capped)");
say("");

if (!agg.json?.success) {
  // Worth saying out loud, not worth failing the run: the page above is still
  // a valid (if truncated) reading, and a calculation key Cloudflare renames
  // should read as "this half is missing", not as silence.
  say(
    "calculations view unavailable: " +
      JSON.stringify(agg.json?.errors ?? agg.json).slice(0, 600),
  );
} else {
  const found = new Map();
  for (const c of agg.json.result?.calculations ?? []) {
    // Aliases are echoed on the calculation when the API keeps them; the
    // operator name survives either way, so key by whichever is present.
    const label = c.alias || c.calculation || "?";
    for (const a of c.aggregates ?? []) {
      found.set(label, a.value);
      if (a.sampleInterval && a.sampleInterval > 1) {
        found.set(label + " (sampleInterval)", a.sampleInterval);
      }
    }
  }
  if (found.size === 0) {
    say("calculations returned nothing for $workers.cpuTimeMs in this window.");
  } else {
    say("| calculation | value |");
    say("|---|---|");
    for (const [k, v] of found) {
      say(`| ${k} | ${typeof v === "number" ? Math.round(v * 100) / 100 : v} |`);
    }
    say("");
    say(
      "Read against the allowance: cpuMs/invocation is the number to compare " +
        "with 30,000,000 / (invocations per month) — 533,760/month (the " +
        "measured 17,792/day, docs/efficiency-2026-10-16.md section 4) puts " +
        "break-even at 56ms. `max` is the invocation the BUDGET reading cannot " +
        "show: a monthly average can sit at 21% while single ticks spike.",
    );
  }
}

say("");
say(
  `the invocations view is capped at LIMIT=${LIMIT} events, so naming the ` +
    `most expensive invocation in the window is only exact when the page held ` +
    `the whole window; the calculations view above is the uncapped statement ` +
    `about it.`,
);
