#!/usr/bin/env node
/**
 * Workers Logs PER-INVOCATION CPU for solana-meme-bot — and the same window's
 * GraphQL reading beside it.
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
 * (`POST /accounts/{id}/workers/observability/telemetry/query`) —
 *   view: "invocations"     one row per invocation, so the expensive tick can
 *                           be named (eventType, trigger, outcome, wall time).
 *                           PAGED (see below).
 *   view: "calculations"    count/min/median/max/p90/p99 OF `$workers.cpuTimeMs`
 *                           over the whole window. This half is what makes the
 *                           answer more than a page: the invocation view is
 *                           limit-capped per page, a percentile is not capped at
 *                           all.
 * and then the SAME window from GraphQL, because the two sources disagreed by
 * ~2.2x and that has to be attributed rather than averaged away.
 *
 * Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment,
 * WORKER / MINUTES / LIMIT / MAX_PAGES / SHOW as optional knobs. Exits non-zero
 * only when it could not ask Cloudflare at all — an empty result is a reading
 * too (it is what "not enabled yet" and "no invocations" look like), so it is
 * printed rather than treated as a failure.
 */

import { appendFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const WORKER = process.env.WORKER || "solana-meme-bot";
const MINUTES = Number(process.env.MINUTES || "60");
const LIMIT = Number(process.env.LIMIT || "2000");
const MAX_PAGES = Number(process.env.MAX_PAGES || "20");
const SHOW = Number(process.env.SHOW || "15");

/** The Workers Logs dataset name (the one the dashboard's query builder uses). */
const DATASET = "cloudflare-workers";
/** This script's own ad-hoc query id; parameters travel inline with the call. */
const QUERY_ID = "solana-meme-bot-per-invocation-cpu";
/** Cloudflare's own ceiling on one page of this view — a bigger `limit` is a hard error. */
const API_PAGE_MAX = 2000;

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

if (!(LIMIT >= 1) || LIMIT > API_PAGE_MAX) {
  console.error(
    `LIMIT must be 1..${API_PAGE_MAX} (got ${process.env.LIMIT}). This is the ` +
      `PAGE size, not a window cap: asking for 4000 was rejected by Cloudflare ` +
      `itself as "too_big, maximum 2000". The window is covered by paging ` +
      `(MAX_PAGES=${MAX_PAGES}) instead.`,
  );
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

/** Nearest-rank percentile of an already-sorted array. */
function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * The median as a reader means it (average of the two middle values for an even
 * count), which is NOT the nearest-rank `pct(xs, 50)` once the sample is small:
 * with ~12 invocations a minute and a heavy tail the two differ by a whole order
 * statistic, and the answer to "why do the two readings disagree?" turns on
 * exactly that distinction.
 */
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs) {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function ms(v) {
  return v === null || v === undefined ? "?" : Math.round(v * 100) / 100;
}

/** "2026-10-16T07:41:06.489Z" → "2026-10-16T07:41" — the bucket both sources share. */
function minuteOf(ts) {
  return typeof ts === "number" ? new Date(ts).toISOString().slice(0, 16) : "";
}

say(`# Workers Logs · per-invocation CPU · ${WORKER}`);
say("");
say(`window: ${stamp(from)} → ${stamp(to)} (${MINUTES} min)`);
say(`dataset: ${DATASET} · filter: $metadata.service = ${WORKER}`);
say("");

/* -------------------------------------------------------------- the pages */

/**
 * PAGED, not capped. One page of this view holds at most 2000 events (the API
 * answers a larger `limit` with ZodError `too_big, maximum 2000`), and an
 * invocation contributes its own record PLUS its log lines, so a 60-minute
 * window is several pages. Stopping after one page would silently turn the
 * reading into "the newest 2000 events" — the exact truncation that makes a
 * per-minute comparison lie by omission. The cursor for this view is the
 * `$metadata.id` of the LAST event on the page; a short page means the window
 * is exhausted.
 */
const collected = new Map();
let pages = 0;
let cursor = "";
let exhausted = false;
let pageStats = null;
let firstRequestId = "";

for (;;) {
  const body = {
    queryId: QUERY_ID,
    timeframe: { from, to },
    view: "invocations",
    limit: LIMIT,
    parameters: baseParameters,
  };
  if (cursor) {
    body.offset = cursor;
    body.offsetDirection = "next";
  }

  const res = await query(body);

  if (!res.json?.success) {
    console.error(`observability query failed (HTTP ${res.status}, page ${pages + 1}):`);
    console.error(JSON.stringify(res.json?.errors ?? res.json, null, 2).slice(0, 2000));
    if (res.status === 403 || res.status === 401) {
      console.error(
        "\nA 403 here is the TOKEN, not the Worker: reading Workers Logs needs " +
          "the account token to carry Workers Observability Read (Metadata " +
          "Read-Only) alongside the deploy permissions it already has.",
      );
    }
    process.exit(2);
  }

  const result = res.json.result ?? {};
  if (!pageStats) pageStats = result.statistics ?? {};
  const pageGroups = result.invocations ?? {};
  const entries = Object.entries(pageGroups);
  let eventsOnPage = 0;
  let lastEventId = "";

  for (const [requestId, events] of entries) {
    const list = Array.isArray(events) ? events : [events];
    eventsOnPage += list.length;
    if (!firstRequestId) firstRequestId = requestId;
    if (!collected.has(requestId)) collected.set(requestId, list);
    const last = list[list.length - 1];
    if (last?.$metadata?.id) lastEventId = String(last.$metadata.id);
  }

  pages++;

  if (entries.length === 0) {
    exhausted = true;
    break;
  }
  // A page that came back short of the requested limit is the last one.
  if (eventsOnPage < LIMIT) {
    exhausted = true;
    break;
  }
  if (!lastEventId) {
    // Full page but no cursor to follow: stop, and say so below rather than
    // pretending the window was covered.
    break;
  }
  if (pages >= MAX_PAGES) break;
  cursor = lastEventId;
}

const rowEntries = [...collected.entries()];

say(
  `invocation groups collected: ${rowEntries.length}` +
    ` · pages: ${pages}${exhausted ? " (window exhausted)" : " — STOPPED BEFORE THE END (raise MAX_PAGES)"}`,
);
say(
  `query statistics: rows_read ${pageStats?.rows_read ?? "?"} · bytes_read ${pageStats?.bytes_read ?? "?"}` +
    ` · abr_level ${pageStats?.abr_level ?? 1}` +
    (pageStats?.abr_level && pageStats.abr_level > 1
      ? "  <- ABR sampling is on: counts below are estimates"
      : ""),
);
say("");

/**
 * Each key is a request id; each value is every event Workers Logs stored for
 * that invocation. The invocation's OWN record is the one carrying
 * `$workers.cpuTimeMs` — log lines next to it are message rows with no
 * `$workers` (or the timing-free variant), which is why the search for the
 * timing record is explicit rather than "take element 0".
 */
const rows = [];
let groupsWithoutTiming = 0;
for (const [requestId, list] of rowEntries) {
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
  `carrying $workers.cpuTimeMs: ${rows.length}` +
    (groupsWithoutTiming ? ` · groups with no timing record: ${groupsWithoutTiming}` : ""),
);
say("");

if (rows.length > 0) {
  const cpu = rows.map((r) => r.cpuTimeMs).slice().sort((a, b) => a - b);
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
    `this window: n=${rows.length} · mean ${ms(mean(cpu))}ms · ` +
      `median ${ms(median(cpu))}ms · p90 ${pct(cpu, 90)}ms · max ${cpu[cpu.length - 1]}ms`,
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
  say("### by event type (this window)");
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
say("## whole window (the calculations view is not page-capped)");
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
  }
}

/* ------------------------------------------------- the same minutes, GraphQL */

/**
 * WHY A SECOND SOURCE FOR THE SAME MINUTES: the two CPU readings for this
 * Worker disagreed by ~2.2x — the GraphQL per-minute `cpuTimeP50` that
 * docs/efficiency-2026-10-16.md §4a turned into a monthly figure, against the
 * per-invocation records above. A disagreement between two datasets can only be
 * attributed if both answer for the SAME minutes, because they are different
 * STATISTICS of the same population:
 *
 *   GraphQL  quantiles.cpuTimeP50  the median CPU of the invocations in ONE
 *                                  minute bucket — a series of per-minute
 *                                  medians, itself possibly sampled.
 *   Logs     $workers.cpuTimeMs    the CPU of ONE invocation, so the mean over
 *                                  these is a per-invocation mean and the
 *                                  median over these is a per-invocation
 *                                  median.
 *
 * Comparing a per-minute median SERIES with a per-invocation MEAN of a
 * heavy-tailed distribution mixes two differences at once (minute-bucket vs
 * invocation, and median vs mean). This half prints both per minute so the
 * like-for-like pairs are separable.
 *
 * Field names are NOT guessed: scripts/cf-invocations.mjs introspects this
 * schema, and its own run log (2026-10-16T04:23Z) reads `datetime_geq` /
 * `datetime_leq`, dimension `datetime`, status dimension present, quantiles
 * field `quantiles` holding cpuTimeP50/cpuTimeP99, `max.cpuTime` present. A
 * rename therefore shows up as the GraphQL error printed below, not as a
 * silent zero. UNIT: cpuTime here is MICROSECONDS (the Free plan's 10ms CPU
 * limit reads as 10,000 in this field), while Workers Logs reports milliseconds.
 */
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GRAPHQL_QUERY = `
query ($accountTag: String!, $filter: WorkersInvocationsAdaptiveGroupsFilter!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(filter: $filter, limit: 10000) {
        sum { requests }
        max { cpuTime wallTime }
        dimensions { datetime status }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

const gqlRes = await fetch(GRAPHQL_ENDPOINT, {
  method: "POST",
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    query: GRAPHQL_QUERY,
    variables: {
      accountTag: ACCOUNT,
      filter: {
        datetime_geq: new Date(from).toISOString(),
        datetime_leq: new Date(to).toISOString(),
        scriptName: WORKER,
      },
    },
  }),
});

const gqlText = await gqlRes.text();
let gql = null;
try {
  gql = JSON.parse(gqlText);
} catch {
  gql = null;
}

say("");
say("## the same window from GraphQL (`workersInvocationsAdaptive`)");
say("");

const gqlByMinute = new Map();
let gqlNote = "";
if (!gql) {
  gqlNote = `GraphQL returned non-JSON (HTTP ${gqlRes.status}): ${gqlText.slice(0, 400)}`;
} else if (gql.errors?.length) {
  gqlNote = `GraphQL errors: ${JSON.stringify(gql.errors).slice(0, 600)}`;
} else {
  const gqlGroups = gql?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  for (const g of gqlGroups) {
    const dims = g?.dimensions ?? {};
    const minute = String(dims.datetime ?? "").slice(0, 16);
    if (!minute) continue;
    const row = gqlByMinute.get(minute) ?? { requests: 0, p50: 0, p99: 0, cpuMax: 0, wallMax: 0 };
    row.requests += Number(g?.sum?.requests ?? 0);
    // One row per (minute, status). A percentile does not add, so a minute that
    // splits by status keeps the MAX of the P50s rather than their sum.
    row.p50 = Math.max(row.p50, Number(g?.quantiles?.cpuTimeP50 ?? 0));
    row.p99 = Math.max(row.p99, Number(g?.quantiles?.cpuTimeP99 ?? 0));
    row.cpuMax = Math.max(row.cpuMax, Number(g?.max?.cpuTime ?? 0));
    row.wallMax = Math.max(row.wallMax, Number(g?.max?.wallTime ?? 0));
    gqlByMinute.set(minute, row);
  }
  if (gqlByMinute.size === 0) {
    gqlNote =
      "GraphQL returned no rows for this window (retention, or a token without Analytics read).";
  }
}

if (gqlNote) {
  say(gqlNote);
  say("");
  say("The Workers Logs half above stands on its own; this half is the comparison.");
} else {
  const gqlP50s = [...gqlByMinute.values()].map((r) => r.p50 / 1000);
  const gqlRequests = [...gqlByMinute.values()].reduce((n, r) => n + r.requests, 0);

  // The Workers Logs side, bucketed the same way, so "per minute" means the
  // same thing on both sides of the join.
  const logByMinute = new Map();
  for (const r of rows) {
    const minute = minuteOf(r.at);
    if (!minute) continue;
    const acc = logByMinute.get(minute) ?? { cpu: [], wall: [] };
    acc.cpu.push(r.cpuTimeMs);
    if (r.wallTimeMs !== null) acc.wall.push(r.wallTimeMs);
    logByMinute.set(minute, acc);
  }

  const bothMinutes = [...gqlByMinute.keys()].filter((m) => logByMinute.has(m)).sort();
  const logOnly = [...logByMinute.keys()].filter((m) => !gqlByMinute.has(m));
  const gqlOnly = [...gqlByMinute.keys()].filter((m) => !logByMinute.has(m));

  say(
    `minutes in both sources: ${bothMinutes.length}` +
      (logOnly.length ? ` · Logs-only: ${logOnly.length}` : "") +
      (gqlOnly.length ? ` · GraphQL-only: ${gqlOnly.length}` : "") +
      " (Logs-only minutes are the pre-deploy minutes the switch could not store, " +
      "or minutes whose events fell off the page).",
  );
  say("");
  // Where does Cloudflare's per-minute "P50" land inside that minute's REAL
  // per-invocation CPU values? Rank 0.5 would mean the two sources report the
  // same statistic and merely disagree by noise; a rank near 1.0 means the
  // "P50" is the minute's MAXIMUM wearing a median's name. The rank is the
  // reading that answers "why 2.2x" without appealing to either API's
  // internals, so it is computed per minute and summarised across minutes.
  const ranks = [];
  let p50EqualsMax = 0;
  say("| minute (UTC) | gql requests | gql cpuP50 ms | gql cpuP99 ms | gql cpuMax ms | logs n | logs median ms | logs p75 ms | logs p90 ms | logs mean ms | logs max ms | gqlP50 rank in logs |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of bothMinutes) {
    const g = gqlByMinute.get(m);
    const l = logByMinute.get(m);
    const sorted = [...l.cpu].sort((a, b) => a - b);
    const p50 = g.p50 / 1000;
    const rank = sorted.filter((v) => v <= p50).length / sorted.length;
    ranks.push(rank);
    if (Math.abs(p50 - sorted[sorted.length - 1]) < 1) p50EqualsMax++;
    say(
      `| ${m} | ${g.requests} | **${ms(p50)}** | ${ms(g.p99 / 1000)} | ${ms(g.cpuMax / 1000)} | ` +
        `${sorted.length} | ${ms(median(sorted))} | ${ms(pct(sorted, 75))} | ${ms(pct(sorted, 90))} | ` +
        `${ms(mean(sorted))} | ${sorted[sorted.length - 1]} | ${(rank * 100).toFixed(0)}% |`,
    );
  }

  const logCpu = rows.map((r) => r.cpuTimeMs);
  /**
   * The JOINED set, not the whole window. The two sources cover different
   * minutes here (Workers Logs only starts at the deploy), so "median across
   * minutes" over every GraphQL bucket is a statistic about a different set of
   * minutes than the Logs mean — which is the exact mistake that produced the
   * original 21% figure: two numbers that were never the same measurement,
   * compared anyway. Anything quoted as a ratio is therefore computed on the
   * minutes BOTH sources have, and the whole-window figure is printed beside it
   * only so the difference is visible.
   */
  const joinedP50s = bothMinutes.map((m) => gqlByMinute.get(m).p50 / 1000);
  const joinedLogCpu = bothMinutes.flatMap((m) => logByMinute.get(m).cpu);

  say("");
  say("### the two statistics, side by side");
  say("");
  say("| statistic | value |");
  say("|---|---|");
  say(
    `| GraphQL minute buckets in the window | ${gqlByMinute.size}` +
      ` (${bothMinutes.length} of them shared with Workers Logs) |`,
  );
  say(`| GraphQL requests summed over those buckets | ${gqlRequests} |`);
  say(`| GraphQL cpuP50 — median across ALL buckets | ${ms(median(gqlP50s))} ms |`);
  say(`| GraphQL cpuP50 — mean across ALL buckets | ${ms(mean(gqlP50s))} ms |`);
  say(`| GraphQL cpuP50 — **median across the JOINED minutes** | ${ms(median(joinedP50s))} ms |`);
  say(`| GraphQL cpuP50 — **mean across the JOINED minutes** | ${ms(mean(joinedP50s))} ms |`);
  say(`| Logs per-invocation **median** (joined minutes) | ${ms(median(joinedLogCpu))} ms |`);
  say(`| Logs per-invocation **mean** (joined minutes) | ${ms(mean(joinedLogCpu))} ms |`);
  say(`| Logs per-invocation median (whole window, for reference) | ${ms(median(logCpu))} ms |`);
  say(`| Logs per-invocation mean (whole window, for reference) | ${ms(mean(logCpu))} ms |`);
  say(
    `| Logs records in the joined minutes | ${joinedLogCpu.length} of ${rows.length} |`,
  );
  say(
    `| GraphQL per-minute P50's **rank inside the same minute's records** ` +
      `(median across minutes; 50% would mean both report the median) | ` +
      `${ms(median(ranks) * 100)}% (min ${ms(Math.min(...ranks) * 100)}%, max ${ms(Math.max(...ranks) * 100)}%) |`,
  );
  say(
    `| minutes where that P50 equals the minute's MAX | ${p50EqualsMax} of ${bothMinutes.length} |`,
  );
  say("");
  say(
    `LIKE FOR LIKE, joined minutes only — GraphQL's per-minute P50 series: ` +
      `${ms(median(joinedP50s))} ms median / ${ms(mean(joinedP50s))} ms mean; ` +
      `the Workers Logs records in those same minutes: ` +
      `${ms(median(joinedLogCpu))} ms median / ${ms(mean(joinedLogCpu))} ms mean. ` +
      `So GraphQL's per-minute P50 sits at ` +
      `${ms((median(joinedP50s) ?? 0) / (median(joinedLogCpu) || 1))}x the ` +
      `per-invocation MEDIAN and ` +
      `${ms((median(joinedP50s) ?? 0) / (mean(joinedLogCpu) || 1))}x the ` +
      `per-invocation MEAN. ` +
      `Those are different questions: one is whether the datasets agree, the ` +
      `other is why a monthly figure built from a median-like series and a ` +
      `per-invocation mean land ~2x apart.`,
  );
  say(
    `THE RANK IS THE ANSWER TO \"WHY DO THEY DISAGREE\": GraphQL's per-minute ` +
      `P50 typically sits at the ${ms(median(ranks) * 100)}th percentile of that ` +
      `minute's own per-invocation CPU values (and IS the minute's max in ` +
      `${p50EqualsMax} of ${bothMinutes.length} minutes), not at the 50th. A ` +
      `statistic at the 80th percentile is not a "typical invocation" figure, ` +
      `so multiplying it by an invocation count cannot measure a monthly CPU ` +
      `total — which is what the retired 21% did.`,
  );
}

say("");
say(
  `the invocation view is paged at LIMIT=${LIMIT} events/page ` +
    `(${pages} page(s), ${exhausted ? "all pages" : "NOT all pages"}), so a ` +
    `per-minute join is complete only when the window was exhausted; the ` +
    `calculations view above is uncapped either way.`,
);
