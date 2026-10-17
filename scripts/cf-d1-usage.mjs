#!/usr/bin/env node
/**
 * D1 rows-written / rows-read usage for solana-meme-bot (2026-10-17).
 *
 * WHY THIS EXISTS. The $5 plan's only scarce resource is D1 rows WRITTEN:
 * measured 30.1M/month against the 50M allowance (60%) while requests sit at
 * 5% and CPU at ~32-38% (docs/efficiency-2026-10-16.md §2). Every cadence or
 * coverage decision (20s vs 30s, a bigger rotation slice) turns on that one
 * number, and until now it was arithmetic from a one-off snapshot rather than
 * a reading. Cloudflare's own analytics has it: the account dataset
 * `d1AnalyticsAdaptiveGroups` carries `sum.rowsRead` / `sum.rowsWritten` per
 * day, and this script reads it with the deploy workflow's existing token.
 *
 * WHAT IT PRINTS: a per-day table, the window totals, and a 30-day projection
 * with the percentage of each D1 allowance — the same shape an operator reads
 * off the dashboard, but available from a run log (`gh run view --log`) and
 * written to the run summary.
 *
 * Exits non-zero only when it could not ask Cloudflare at all (missing
 * credentials, a GraphQL error, no such dataset), so a permissions problem is
 * loud and a quiet month is not.
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (deploy secrets), DAYS.
 */

import { appendFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const DAYS = Math.max(1, Math.min(90, Number(process.env.DAYS || "30")));
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** The paid plan's monthly D1 allowances (developers.cloudflare.com/d1/pricing). */
const ROWS_WRITTEN_ALLOWANCE = 50_000_000;
const ROWS_READ_ALLOWANCE = 25_000_000_000;

if (!TOKEN || !ACCOUNT) {
  console.error(
    "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set. " +
      "They are repository Actions secrets used by deploy.yml.",
  );
  process.exit(2);
}

async function graphql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
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
  return json;
}

function say(line) {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, line + "\n");
    } catch {
      /* the log is the primary channel */
    }
  }
}

/**
 * The dataset's type names differ by account scope (the Workers dataset taught
 * this the hard way: `AccountWorkersInvocationsAdaptive…`). Try the plausible
 * names, then read the real field list — a wrong guess is a hard GraphQL error,
 * not an empty result, so guessing without introspection is not an option.
 */
// Measured against the live schema (2026-10-17): the dataset type carries the
// `Groups` suffix on the group, filter, dimension and sum types — the first
// guess without it resolved to nothing.
const GROUP_TYPES = ["AccountD1AnalyticsAdaptiveGroups", "D1AnalyticsAdaptiveGroups"];
const FILTER_TYPES = [
  "AccountD1AnalyticsAdaptiveGroupsFilter_InputObject",
  "D1AnalyticsAdaptiveGroupsFilter_InputObject",
];

async function findType(names) {
  for (const name of names) {
    const res = await graphql(
      `query ($n: String!) { __type(name: $n) { name fields { name } inputFields { name } } }`,
      { n: name },
    );
    if (res.errors?.length) {
      console.error(`Introspection of ${name} failed:`, JSON.stringify(res.errors).slice(0, 800));
      process.exit(2);
    }
    const type = res?.data?.__type;
    if (type) return type;
  }
  return null;
}

const groupType = await findType(GROUP_TYPES);
const filterType = await findType(FILTER_TYPES);
if (!groupType || !filterType) {
  console.error(
    "Could not find the D1 analytics dataset in the schema. Types tried: " +
      `${GROUP_TYPES.join(", ")} / ${FILTER_TYPES.join(", ")}.`,
  );
  // A renamed dataset type otherwise leaves nothing to act on. List what the
  // schema DOES call a D1 analytics type, so the fix is a rename in the two
  // constants above rather than a search.
  const names = await graphql(`query { __schema { types { name } } }`, {});
  const all = (names?.data?.__schema?.types ?? [])
    .map((t) => t.name)
    .filter((n) => /D1.*Analytics|Analytics.*D1/i.test(n));
  console.error(`schema types matching /D1.*Analytics/: ${all.join(", ") || "(none)"}`);
  process.exit(2);
}

const sumType = await findType([
  `${groupType.name}Sum`,
  "AccountD1AnalyticsAdaptiveGroupsSum",
  "D1AnalyticsAdaptiveGroupsSum",
]);
const dimType = await findType([
  `${groupType.name}Dimensions`,
  "AccountD1AnalyticsAdaptiveGroupsDimensions",
  "D1AnalyticsAdaptiveGroupsDimensions",
]);
const filterFields = (filterType.inputFields ?? []).map((f) => f.name);
const sumFields = (sumType?.fields ?? []).map((f) => f.name);
const dimFields = (dimType?.fields ?? []).map((f) => f.name);

const pickTimeArg = (suffix) =>
  [`date_${suffix}`, `datetime_${suffix}`].find((n) => filterFields.includes(n));
const geArg = filterFields.includes("date_GE")
  ? "date_GE"
  : (pickTimeArg("geq") ?? pickTimeArg("gte") ?? pickTimeArg("gt"));
const leArg = filterFields.includes("date_LE")
  ? "date_LE"
  : (pickTimeArg("leq") ?? pickTimeArg("lte") ?? pickTimeArg("lt"));
const timeDim = ["date", "datetime"].find((n) => dimFields.includes(n));
const sumSelection = ["rowsRead", "rowsWritten", "readQueries", "writeQueries"].filter((n) =>
  sumFields.includes(n),
);

if (!geArg || !leArg || !timeDim || sumSelection.length === 0) {
  console.error("Could not find the dataset's time filter/dimension/sum fields.");
  console.error(`filter inputFields: ${filterFields.join(", ")}`);
  console.error(`dimension fields:   ${dimFields.join(", ")}`);
  console.error(`sum fields:         ${sumFields.join(", ")}`);
  process.exit(2);
}

const end = new Date();
const start = new Date(Date.now() - DAYS * 24 * 3600_000);
const fmt = (d) => (timeDim === "date" ? d.toISOString().slice(0, 10) : d.toISOString());

// The GraphQL variable type is the filter type's own name, which is why the
// query is built from the introspection result rather than hard-coded.
const QUERY = `
query ($accountTag: String!, $filter: ${filterType.name}) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: $filter) {
        count
        sum { ${sumSelection.join(" ")} }
        dimensions { ${timeDim} }
      }
    }
  }
}`;

const json = await graphql(QUERY, {
  accountTag: ACCOUNT,
  filter: { [geArg]: fmt(start), [leArg]: fmt(end) },
});

if (json.errors?.length) {
  console.error("Cloudflare GraphQL errors:");
  console.error(JSON.stringify(json.errors, null, 2).slice(0, 2000));
  process.exit(2);
}

const groups = json?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
if (!Array.isArray(groups) || groups.length === 0) {
  say(`No d1AnalyticsAdaptiveGroups rows for ${fmt(start)} .. ${fmt(end)}.`);
  process.exit(0);
}

const rows = groups
  .map((g) => ({
    day: String(g?.dimensions?.[timeDim] ?? "?"),
    rowsRead: Number(g?.sum?.rowsRead ?? 0),
    rowsWritten: Number(g?.sum?.rowsWritten ?? 0),
  }))
  .filter((r) => r.day !== "?")
  .sort((a, b) => a.day.localeCompare(b.day));

const n = (v) => v.toLocaleString("en-US");
const totalRead = rows.reduce((a, r) => a + r.rowsRead, 0);
const totalWritten = rows.reduce((a, r) => a + r.rowsWritten, 0);
// Project from COMPLETE days only: today is still accumulating, and including
// a partial day in the average understates the month (the first version of
// this script did exactly that). Falls back to all rows if today is the only
// day in the window.
const today = new Date().toISOString().slice(0, 10);
const completeDays = rows.filter((r) => r.day !== today);
const basis = completeDays.length > 0 ? completeDays : rows;
const daysSpanned = Math.max(1, basis.length);
const perDayWritten = basis.reduce((a, r) => a + r.rowsWritten, 0) / daysSpanned;
const perDayRead = basis.reduce((a, r) => a + r.rowsRead, 0) / daysSpanned;
const projectionNote =
  completeDays.length > 0 && completeDays.length !== rows.length
    ? " (today excluded from the projection)"
    : "";
const monthWritten = perDayWritten * 30;
const monthRead = perDayRead * 30;
const pct = (v, cap) => ((v / cap) * 100).toFixed(1);

say(
  `D1 usage ${rows[0].day} .. ${rows[rows.length - 1].day} ` +
    `(${daysSpanned} day${daysSpanned === 1 ? "" : "s"}; schema: ${timeDim}, ` +
    `filter ${geArg}/${leArg}, sum ${sumSelection.join("/")})`,
);
say("");
say("| day | rows written | rows read |");
say("|---|---:|---:|");
for (const r of rows) say(`| ${r.day} | ${n(r.rowsWritten)} | ${n(r.rowsRead)} |`);
say("");
say(
  `Rows written: ${n(totalWritten)} total → ${n(Math.round(perDayWritten))}/day` +
    ` → projected ${n(Math.round(monthWritten))}/month = ` +
    `${pct(monthWritten, ROWS_WRITTEN_ALLOWANCE)}% of ${n(ROWS_WRITTEN_ALLOWANCE)}` +
    projectionNote,
);
const lastComplete = completeDays[completeDays.length - 1];
if (lastComplete) {
  say(
    `Last complete day (${lastComplete.day}): ${n(lastComplete.rowsWritten)} written → ` +
      `${pct(lastComplete.rowsWritten * 30, ROWS_WRITTEN_ALLOWANCE)}%/month; ` +
      `${n(lastComplete.rowsRead)} read → ` +
      `${pct(lastComplete.rowsRead * 30, ROWS_READ_ALLOWANCE)}%/month`,
  );
}
say(
  `Rows read:    ${n(totalRead)} total → ${n(Math.round(perDayRead))}/day` +
    ` → projected ${n(Math.round(monthRead))}/month = ` +
    `${pct(monthRead, ROWS_READ_ALLOWANCE)}% of ${n(ROWS_READ_ALLOWANCE)}` +
    projectionNote,
);
say("");
say(
  "Read against the cadence question: rows written scale with COVERAGE x FREQUENCY " +
    "(docs/efficiency-2026-10-16.md §5), so a 20s clock is only affordable while " +
    "this projection stays below the allowance.",
);
