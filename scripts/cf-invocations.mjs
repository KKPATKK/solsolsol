#!/usr/bin/env node
/**
 * Cloudflare invocation forensics for solana-meme-bot.
 *
 * WHY THIS EXISTS (see .github/workflows/cf-invocations.yml): a tick that runs
 * out of subrequests cannot report that it did. The Turso writes that would
 * have carried the number are themselves fetches, so they throw too — the peak
 * subrequest count of a dead tick is, by construction, unobservable from
 * inside the Worker. Cloudflare's own analytics is the only witness.
 *
 * WHAT IT ANSWERS, for the window a "no scan completion" alert names:
 *   1. do the invocations in that window carry a status other than `ok`?
 *   2. does subrequests/requests climb toward the Workers Free cap of 50?
 * A minute whose average sits in the high 40s, next to minutes of failures, is
 * the cap being grazed then missed. A minute of failures with the average in
 * the low 20s is a different mechanism entirely (a wall-clock kill, an
 * eviction, a deploy) — the two are told apart by this one number.
 *
 * Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment
 * (the deploy workflow's own secrets), HOURS and WORKER as optional knobs.
 * Exits non-zero only when it could not ask Cloudflare at all, so a
 * permissions problem is loud and an empty result is not.
 */

import { appendFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const WORKER = process.env.WORKER || "solana-meme-bot";
const HOURS = Number(process.env.HOURS || "6");
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Workers Free caps an invocation at 50 subrequests; the Worker's own mirror of
 * that is SUBREQ_BUDGET_FREE (src/subreqs.ts) minus the 12 it keeps unseen for
 * itself, so 38 usable. Printed as the reference line the table is read
 * against — the average a healthy tick sits at is ~21-24.
 */
const FREE_CAP = 50;
const HEALTHY_TICK = "21-24";

if (!TOKEN || !ACCOUNT) {
  console.error(
    "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set. " +
      "They are repository Actions secrets used by deploy.yml.",
  );
  process.exit(2);
}

if (!(HOURS > 0) || HOURS > 24) {
  console.error(`HOURS must be 1..24 (got ${process.env.HOURS})`);
  process.exit(2);
}

const datetimeLE = new Date().toISOString();
const datetimeGE = new Date(Date.now() - HOURS * 3600_000).toISOString();

async function graphql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    console.error(`Cloudflare returned non-JSON (HTTP ${res.status}):`);
    console.error(body.slice(0, 800));
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
      /* the log is the primary channel; the summary is a convenience */
    }
  }
}

/**
 * The dataset's argument and dimension names are NOT guessable: this API has
 * used both `datetime_geq`/`date_geq` and both `quantiles0`/`quantiles` across
 * its datasets, and a wrong guess is a hard error rather than an empty result
 * (the first version of this script learned that the expensive way). So ask
 * the schema instead of assuming, and print what it said — a future rename
 * then reads as a name list, not as silence.
 */
// The account-scoped dataset is spelled with the `Account` prefix in the
// schema (`AccountWorkersInvocationsAdaptive…`), which is why the bare name
// resolved to nothing and the first lookup printed an empty field list.
const TYPE_FILTER = "AccountWorkersInvocationsAdaptiveFilter_InputObject";
const TYPE_GROUP = "AccountWorkersInvocationsAdaptive";
const TYPE_DIMS = "AccountWorkersInvocationsAdaptiveDimensions";

const INTROSPECTION = `
query ($f: String!, $g: String!, $d: String!) {
  filterType: __type(name: $f) { inputFields { name } }
  groupType: __type(name: $g) { fields { name } }
  dimType: __type(name: $d) { fields { name } }
}`;

const intro = await graphql(INTROSPECTION, {
  f: TYPE_FILTER,
  g: TYPE_GROUP,
  d: TYPE_DIMS,
});
if (intro.errors?.length) {
  console.error("Introspection failed — the token likely cannot read this schema:");
  console.error(JSON.stringify(intro.errors, null, 2).slice(0, 1500));
  process.exit(2);
}
const introData = intro?.data ?? {};
const filterArgs = (introData.filterType?.inputFields ?? []).map((f) => f.name);
const dimFields = (introData.dimType?.fields ?? []).map((f) => f.name);
const groupFields = introData.groupType?.fields ?? [];

// The filter's time bounds: the dataset carries whichever pair its vintage
// uses. Both are accepted here, named first so the schema's own spelling wins.
const pickTimeArg = (suffix) =>
  [`datetime_${suffix}`, `date_${suffix}`].find((n) => filterArgs.includes(n));
const geArg = filterArgs.includes("datetime_GE")
  ? "datetime_GE"
  : (pickTimeArg("geq") ?? pickTimeArg("gte") ?? pickTimeArg("gt"));
const leArg = filterArgs.includes("datetime_LE")
  ? "datetime_LE"
  : (pickTimeArg("leq") ?? pickTimeArg("lte") ?? pickTimeArg("lt"));
const timeDim = ["datetime", "date"].find((n) => dimFields.includes(n));
const hasStatus = dimFields.includes("status");
// Quantile fields live in their own group field, named either way.
const quantFieldName = groupFields.some((f) => f.name === "quantiles0")
  ? "quantiles0"
  : groupFields.some((f) => f.name === "quantiles")
    ? "quantiles"
    : null;

if (!geArg || !leArg || !timeDim) {
  console.error("Could not find the dataset's time filter/dimension in the schema.");
  console.error(`filter inputFields: ${filterArgs.join(", ")}`);
  console.error(`dimension fields:   ${dimFields.join(", ")}`);
  // A renamed dataset type reads as "no such type" and would otherwise leave
  // nothing to act on. List what the schema does call a Workers invocation
  // type, so the fix is a rename rather than a search.
  const names = await graphql(
    `query { __schema { types { name } } }`,
    {},
  );
  const all = (names?.data?.__schema?.types ?? [])
    .map((t) => t.name)
    .filter((n) => /Worker.*Invoc/i.test(n));
  console.error(`schema types matching /Worker.*Invoc/: ${all.join(", ") || "(none)"}`);
  process.exit(2);
}

const dimSelection = [timeDim, hasStatus ? "status" : null, "scriptName"]
  .filter(Boolean)
  .join(" ");
const quantSelection = quantFieldName
  ? `${quantFieldName} { durationP50 durationP95 durationP99 }`
  : "";

const QUERY = `
query ($accountTag: String!, $filter: WorkersInvocationsAdaptiveGroupsFilter!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(filter: $filter, limit: 10000) {
        sum { requests errors subrequests }
        dimensions { ${dimSelection} }
        ${quantSelection}
      }
    }
  }
}`;

const json = await graphql(QUERY, {
  accountTag: ACCOUNT,
  filter: {
    [geArg]: datetimeGE,
    [leArg]: datetimeLE,
    scriptName: WORKER,
  },
});

say(
  `Schema read: time filter \`${geArg}\`/\`${leArg}\`, time dimension ` +
    `\`${timeDim}\`, status dimension ${hasStatus ? "present" : "ABSENT"}, ` +
    `quantiles field ${quantFieldName ?? "absent"}.`,
);
say("");

if (json.errors?.length) {
  console.error("Cloudflare GraphQL errors:");
  console.error(JSON.stringify(json.errors, null, 2).slice(0, 2000));
  process.exit(2);
}

const groups =
  json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

if (!Array.isArray(groups) || groups.length === 0) {
  say(
    `No \`workersInvocationsAdaptive\` rows for ${WORKER} in ` +
      `${datetimeGE} .. ${datetimeLE}.`,
  );
  say(
    "Either the window predates Cloudflare's Free-plan retention, or the " +
      "token's account cannot see this Worker. Widen HOURS and re-run; if it " +
      "stays empty, the token lacks the Workers Analytics read.",
  );
  process.exit(0);
}

/**
 * One group is one (status, minute) bucket. Roll them up into per-minute rows
 * so the table reads like the Worker's own /debug/tick ring: left = UTC minute
 * the alert names, right = what Cloudflare saw.
 */
const byMinute = new Map();
for (const g of groups) {
  const dims = g?.dimensions ?? {};
  const sum = g?.sum ?? {};
  const minute = String(dims[timeDim] ?? "").slice(0, 16);
  const status = hasStatus ? String(dims.status ?? "?") : "ok*";
  if (!minute) continue;
  let row = byMinute.get(minute);
  if (!row) {
    row = { minute, byStatus: new Map(), requests: 0, errors: 0, subrequests: 0, p99: [] };
    byMinute.set(minute, row);
  }
  const prev = row.byStatus.get(status) ?? 0;
  row.byStatus.set(status, prev + 1);
  row.requests += Number(sum.requests ?? 0);
  row.errors += Number(sum.errors ?? 0);
  row.subrequests += Number(sum.subrequests ?? 0);
  const q0 = (quantFieldName ? g?.[quantFieldName] : null) ?? {};
  row.p99.push(Number(q0.durationP99 ?? 0));
}

const minutes = [...byMinute.values()].sort((a, b) => (a.minute < b.minute ? -1 : 1));

say(`# Cloudflare invocation forensics — ${WORKER}`);
say("");
say(`Window (UTC): ${datetimeGE} .. ${datetimeLE}  (${HOURS}h)`);
say(
  `Reference: Workers Free cap = ${FREE_CAP} subrequests/invocation; a healthy ` +
    `tick of this Worker spends ${HEALTHY_TICK}.`,
);
say("");

/**
 * `success` is this dataset's spelling of a normal invocation — NOT `ok`,
 * which the Worker's own /health uses. Marking anything that is not literally
 * `ok` as a failure flagged all 700-odd healthy minutes of the first run, so
 * the accepted set is named here rather than inferred from one string.
 * `unknown` is deliberately treated as healthy: it is what Cloudflare emits
 * for an outcome it did not classify, and paging on it would be noise.
 */
const OK_STATUSES = new Set(["success", "ok", "unknown"]);
const isBad = (status) => !OK_STATUSES.has(status);

const statusTotals = new Map();
for (const row of minutes) {
  for (const [status, n] of row.byStatus) {
    statusTotals.set(status, (statusTotals.get(status) ?? 0) + n);
  }
}

say("## Every invocation status Cloudflare recorded in the window");
say("");
say("| status | invocations |  |");
say("|---|---|---|");
for (const [status, n] of [...statusTotals.entries()].sort((a, b) => b[1] - a[1])) {
  say(
    `| ${isBad(status) ? `**${status}**` : status} | ${n} | ` +
      `${isBad(status) ? "non-`success` — the alert's shape" : "normal"} |`,
  );
}
say("");

const badMinutes = minutes.filter((row) =>
  [...row.byStatus.keys()].some(isBad),
);

say("## Minutes carrying a non-`success` outcome");
say("");
if (badMinutes.length === 0) {
  say(
    "None. If the window covers the alert and this is empty, the loss was not " +
      "an invocation-level failure at all — check the window first (HKT = UTC+8, " +
      "so a 17:38 HKT alert is 09:38 UTC) before reading anything into it.",
  );
} else {
  say("| minute (UTC) | invocations | by status | subreq/inv |");
  say("|---|---|---|---|");
  for (const row of badMinutes) {
    const invocations = row.requests || 1;
    const statuses = [...row.byStatus.entries()]
      .map(([status, n]) => `${isBad(status) ? `**${status}**` : status}:${n}`)
      .join(" ");
    say(
      `| ${row.minute} | ${invocations} | ${statuses} | ` +
        `${(row.subrequests / invocations).toFixed(1)} |`,
    );
  }
}
say("");

let worst = { avg: -1, minute: "" };
for (const row of minutes) {
  const avg = row.subrequests / (row.requests || 1);
  if (avg > worst.avg) worst = { avg, minute: row.minute };
}
const allInvocations = minutes.reduce((n, row) => n + (row.requests || 0), 0);
const allSubrequests = minutes.reduce((n, row) => n + row.subrequests, 0);

say("## The subrequest question, answered");
say("");
say(
  `${allInvocations} invocations over ${minutes.length} minutes averaged ` +
    `**${(allSubrequests / Math.max(1, allInvocations)).toFixed(1)} subrequests**, ` +
    `peaking at **${worst.avg.toFixed(1)}** in ${worst.minute} — against a Free-plan ` +
    `cap of ${FREE_CAP} (the Worker's own budget arithmetic keeps 38 usable).`,
);
say("");
say(
  "If that peak is far below the cap, the cap is NOT the mechanism: a blown " +
    "subrequest budget would show a minute at or above it, and this table would " +
    "have to explain where 50 fetches went. What is left for an " +
    "`exceededResources` outcome, once subrequests are ruled out by arithmetic, " +
    "is CPU time (10 ms/invocation on Free, `exceededCpu` in the docs) or memory " +
    "(`exceededMemory`) — neither of which the Worker's own telemetry can see, " +
    "and both of which are fixed by doing less work per tick or raising the limit " +
    "on the Paid plan.",
);
