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

const QUERY = `
query ($accountTag: String!, $filter: WorkersInvocationsAdaptiveGroupsFilter!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        filter: $filter
        limit: 10000
        orderBy: [datetime_DESC]
      ) {
        sum { requests errors subrequests }
        dimensions { status datetime scriptName }
        quantiles0 { durationP50 durationP95 durationP99 cpuTimeP99 }
      }
    }
  }
}`;

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

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    query: QUERY,
    variables: {
      accountTag: ACCOUNT,
      filter: {
        datetime_GE: datetimeGE,
        datetime_LE: datetimeLE,
        scriptName: WORKER,
      },
    },
  }),
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
  const minute = String(dims.datetime ?? "").slice(0, 16);
  const status = String(dims.status ?? "?");
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
  const q0 = g?.quantiles0 ?? {};
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

const header = "| minute (UTC) | invocations | by status | subreq/inv | durP99 ms |";
say(header);
say("|---|---|---|---|---|");

let flagged = 0;
let worst = { avg: -1, minute: "" };
for (const row of minutes) {
  const invocations = row.requests || 1;
  const avg = row.subrequests / invocations;
  const statuses = [...row.byStatus.entries()]
    .map(([status, n]) => `${status}:${n}`)
    .join(" ");
  const notOk = [...row.byStatus.entries()].filter(([s]) => s !== "ok");
  const p99 = row.p99.length ? Math.max(...row.p99) : 0;
  const mark = notOk.length > 0 ? " **FAIL**" : "";
  if (notOk.length > 0) flagged++;
  if (avg > worst.avg) worst = { avg, minute: row.minute };
  say(
    `| ${row.minute} | ${invocations} | ${statuses}${mark} | ${avg.toFixed(1)} | ${p99} |`,
  );
}

say("");
if (flagged === 0) {
  say(
    "**No minute in this window carries a non-`ok` invocation status.** That " +
      "argues against the invocation-cap reading: check that the window covers " +
      "the alert (HKT = UTC+8, so a 17:38 HKT alert is 09:38 UTC).",
  );
} else {
  say(`**${flagged} minute(s) carry a non-\`ok\` status.**`);
}
say(
  `Busiest minute on subrequests: ${worst.minute} at ${worst.avg.toFixed(1)} ` +
    `per invocation (cap ${FREE_CAP}).`,
);
say("");
say(
  "Read: a FAIL minute whose subreq/inv sits in the high 40s is the cap being " +
    "grazed then missed (Turso latency → libsql retries → more fetches). A FAIL " +
    "minute in the low 20s is a different mechanism — a wall-clock kill, an " +
    "eviction, or a deploy — and `npx wrangler tail` during the next burst, or " +
    "the deploy timestamps, would be the next witness.",
);
