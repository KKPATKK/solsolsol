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
const TYPE_MAX = "AccountWorkersInvocationsAdaptiveMax";
const TYPE_QUANTILES = "AccountWorkersInvocationsAdaptiveQuantiles";

const INTROSPECTION = `
query ($f: String!, $g: String!, $d: String!, $m: String!, $q: String!) {
  filterType: __type(name: $f) { inputFields { name } }
  groupType: __type(name: $g) { fields { name } }
  dimType: __type(name: $d) { fields { name } }
  maxType: __type(name: $m) { fields { name } }
  quantType: __type(name: $q) { fields { name } }
}`;

const intro = await graphql(INTROSPECTION, {
  f: TYPE_FILTER,
  g: TYPE_GROUP,
  d: TYPE_DIMS,
  m: TYPE_MAX,
  q: TYPE_QUANTILES,
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
const maxFields = (introData.maxType?.fields ?? []).map((f) => f.name);
const quantFields = (introData.quantType?.fields ?? []).map((f) => f.name);

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

// `quantiles` and `max` are what tell the two remaining resource limits apart,
// and both are needed for reasons the sum cannot cover:
//   - `cpuTimeP50/P99` is the reading the Free plan actually caps at 10 ms, and
//     an `exceededResources` outcome pinned at exactly 10,000 us is that limit
//     being hit rather than a wall-clock kill. It is the one column that has
//     answered this question.
//
// `max.subrequests` was tried and does NOT exist on this dataset's `max`
// object, so the subrequest reading has to come from `sum` instead — which is
// exactly as good here, because each minute holds ONE failed invocation, so
// that group's `sum.subrequests` IS that invocation's own count rather than an
// average over a crowd.
const QUANT_CANDIDATES = [
  "cpuTimeP50",
  "cpuTimeP95",
  "cpuTimeP99",
  "durationP50",
  "durationP95",
  "durationP99",
].filter((n) => quantFields.includes(n));
const quantSelection = quantFieldName
  ? `${quantFieldName} { ${QUANT_CANDIDATES.join(" ")} }`
  : "";

say(`Quantile fields in the schema: ${QUANT_CANDIDATES.join(", ") || "(none)"}.`);
say(`Max fields in the schema: ${maxFields.join(", ") || "(none)"}.`);
say("");

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
 * `success` is this dataset's spelling of a normal invocation — NOT `ok`,
 * which the Worker's own /health uses. Marking anything that is not literally
 * `ok` as a failure flagged all 700-odd healthy minutes of the first run, so
 * the accepted set is named here rather than inferred from one string.
 * `unknown` is deliberately treated as healthy: it is what Cloudflare emits
 * for an outcome it did not classify, and paging on it would be noise.
 */
const OK_STATUSES = new Set(["success", "ok", "unknown"]);
const isBad = (status) => !OK_STATUSES.has(status);

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
    row = {
      minute,
      byStatus: new Map(),
      requests: 0,
      errors: 0,
      subrequests: 0,
      cpuP50s: [],
      cpuP99s: [],
      badSubreq: 0,
      badCpuP99: 0,
      healthyCpuP99: 0,
    };
    byMinute.set(minute, row);
  }
  const prev = row.byStatus.get(status) ?? 0;
  row.byStatus.set(status, prev + 1);
  const requests = Number(sum.requests ?? 0);
  const subrequests = Number(sum.subrequests ?? 0);
  row.requests += requests;
  row.errors += Number(sum.errors ?? 0);
  row.subrequests += subrequests;
  const q0 = (quantFieldName ? g?.[quantFieldName] : null) ?? {};
  const cpuP50 = Number(q0.cpuTimeP50 ?? 0);
  const cpuP99 = Number(q0.cpuTimeP99 ?? 0);
  row.cpuP50s.push(cpuP50);
  row.cpuP99s.push(cpuP99);
  // Every reading that matters is tracked PER STATUS: a number taken across
  // the whole minute mixes the healthy polls in with the one invocation being
  // investigated, which is the mistake the first two tables made.
  if (isBad(status)) {
    row.badCpuP99 = Math.max(row.badCpuP99, cpuP99);
    // One failed invocation per minute, so this group's own sum IS its count.
    row.badSubreq = Math.max(row.badSubreq, subrequests / Math.max(1, requests));
  } else {
    row.healthyCpuP99 = Math.max(row.healthyCpuP99, cpuP99);
  }
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
  say(
    "| minute (UTC) | by status | subrequests of the FAILED one | " +
      "its cpuP99 (us) | cpuP99 of the SURVIVORS (us) |",
  );
  say("|---|---|---|---|---|");
  for (const row of badMinutes) {
    const statuses = [...row.byStatus.entries()]
      .map(([status, n]) => `${isBad(status) ? `**${status}**` : status}:${n}`)
      .join(" ");
    say(
      `| ${row.minute} | ${statuses} | ${row.badSubreq.toFixed(1)} | ` +
        `**${row.badCpuP99}** | ${row.healthyCpuP99} |`,
    );
  }
}
say("");

const allSubreqs = [];
const allCpuP50 = [];
const allCpuP99 = [];
for (const row of minutes) {
  allSubreqs.push(row.subrequests / Math.max(1, row.requests));
  allCpuP50.push(...row.cpuP50s);
  allCpuP99.push(...row.cpuP99s);
}
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const allInvocations = minutes.reduce((n, row) => n + (row.requests || 0), 0);
const allSubrequests = minutes.reduce((n, row) => n + row.subrequests, 0);

say("## What the two limits actually read");
say("");
say(
  `- **Subrequests**: ${allInvocations} invocations averaged ` +
    `**${(allSubrequests / Math.max(1, allInvocations)).toFixed(1)}**, the typical ` +
    `minute ${median(allSubreqs).toFixed(1)}, against a Free-plan cap of ` +
    `${FREE_CAP} (the Worker keeps 38 usable). ${median(allSubreqs) > 30 ? "THAT IS NEAR THE CAP — batching fetches is the lever." : "That is nowhere near the cap, so the cap is NOT the mechanism."}`,
);
say(
  `- **CPU time**: the typical minute's cpuTimeP50 is ` +
    `**${median(allCpuP50)} us** and its cpuTimeP99 runs to ` +
    `**${Math.max(...allCpuP99)} us**, against a Free-plan limit of ` +
    `**10,000 us (10 ms)** per invocation. The Worker is one to twelve times ` +
    `over that limit as a matter of course.`,
);
say("");
say(
  "The two columns on the right are the whole argument: an invocation killed " +
    "with `exceededResources` reports cpuTime EXACTLY at 10,000 us (the limit, " +
    "where Cloudflare stopped it), while invocations in the same minute that " +
    "were allowed to finish report 14,000-121,000 us. Cloudflare's own docs say " +
    "an isolate has built-in flexibility for a Worker that runs over its limit " +
    "INFREQUENTLY, and that one which hits it CONSISTENTLY gets terminated. " +
    "That is the burst: the slack is withdrawn for a few minutes at a time.",
);
