#!/usr/bin/env node
/*
 * READ-ONLY. The approved SQL: scan_history aggregated per day (and per hour
 * for the last ten days), so a falling push count can be attributed to the
 * market (discovery shrinking) or to the gates (discovery steady, judgments
 * collapsing) instead of guessed at.
 *
 * This is the read /debug/scan-history cannot make: that route serves the
 * newest 500 rows (~4.5h at a 1-minute tick), while the drop spans weeks —
 * scan_history is retained for 30 days (see the prune in Db.writeHeartbeat).
 *
 * No writes at all: one SELECT each, through the same libsql client the
 * Worker uses, with credentials taken from the process environment.
 *
 * Run: node scripts/scan-history-daily.js
 *      node scripts/scan-history-daily.js 14   (hourly rows covering N days)
 *      node scripts/scan-history-daily.js --since 2026-10-12T04:00:00Z \
 *          --until 2026-10-12T04:30:00Z        (one window's totals + ticks —
 *          the A/B reading: same database, same columns, a bounded interval)
 */
"use strict";

const { createClient } = require("@libsql/client");

const QUERIES = {
  coverage: `SELECT COUNT(*) AS rows_total,
       datetime(MIN(at)/1000,'unixepoch') AS first_at,
       datetime(MAX(at)/1000,'unixepoch') AS last_at,
       SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed_ticks
FROM scan_history`,
  daily: `SELECT date(at/1000,'unixepoch') AS day,
       COUNT(*) AS ticks,
       SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok_ticks,
       SUM(profiles) AS profiles,
       ROUND(AVG(profiles),1) AS avg_profiles,
       SUM(pool) AS pool,
       SUM(candidates) AS candidates,
       SUM(pushed) AS pushed
FROM scan_history GROUP BY day ORDER BY day`,
  hourly: `SELECT strftime('%Y-%m-%d %H', at/1000,'unixepoch') AS hour,
       COUNT(*) AS ticks,
       ROUND(AVG(profiles),1) AS avg_profiles,
       SUM(pool) AS pool,
       SUM(candidates) AS candidates,
       SUM(pushed) AS pushed
FROM scan_history
WHERE at > (CAST(strftime('%s','now') AS INTEGER) - ?*86400) * 1000
GROUP BY hour ORDER BY hour`,
};

const WINDOW_TOTALS = `SELECT COUNT(*) AS ticks,
       ROUND(AVG(profiles),1) AS avg_profiles,
       ROUND(AVG(pool),0) AS avg_pool,
       SUM(candidates) AS candidates,
       SUM(pushed) AS pushed,
       datetime(MIN(at)/1000,'unixepoch') AS first_at,
       datetime(MAX(at)/1000,'unixepoch') AS last_at
FROM scan_history WHERE at >= ? AND at <= ?`;

const WINDOW_TICKS = `SELECT datetime(at/1000,'unixepoch') AS t, ok, profiles, pool, candidates, pushed
FROM scan_history WHERE at >= ? AND at <= ? ORDER BY at`;

/**
 * The DELIVERY side of the same window: a seen_tokens row IS the push claim
 * (claimTokenPush inserts it before the card is sent), so `new_claims` counts
 * the coins a card was actually attempted for, and `tokens` names them — the
 * reading that separates "the gates found nothing new" (0) from "the gates
 * found coins and the send path dropped them" (>0).
 */
const WINDOW_SEEN = `SELECT COUNT(*) AS new_claims,
       datetime(MIN(first_seen_at)/1000,'unixepoch') AS first_at,
       datetime(MAX(first_seen_at)/1000,'unixepoch') AS last_at
FROM seen_tokens WHERE first_seen_at >= ? AND first_seen_at <= ?`;

const WINDOW_SEEN_ROWS = `SELECT datetime(first_seen_at/1000,'unixepoch') AS t, token
FROM seen_tokens WHERE first_seen_at >= ? AND first_seen_at <= ? ORDER BY first_seen_at`;

/** --since/--until: one bounded window, the shape an A/B compares. */
async function window(client, since, until) {
  const args = [since, until];
  for (const [name, sql] of [
    ["window-totals", WINDOW_TOTALS],
    ["window-claims", WINDOW_SEEN],
    ["window-claim-rows", WINDOW_SEEN_ROWS],
    ["window-ticks", WINDOW_TICKS],
  ]) {
    const res = await client.execute({ sql, args });
    console.log(`### ${name}`);
    for (const row of res.rows) console.log(JSON.stringify(row));
    console.log("");
  }
}

async function main() {
  const sinceArg = process.argv.indexOf("--since");
  const untilArg = process.argv.indexOf("--until");
  if (sinceArg !== -1) {
    const since = Date.parse(String(process.argv[sinceArg + 1] ?? ""));
    const until = untilArg !== -1 ? Date.parse(String(process.argv[untilArg + 1] ?? "")) : Date.now();
    if (!Number.isFinite(since) || !Number.isFinite(until)) {
      console.error("--since/--until need ISO timestamps");
      process.exit(1);
    }
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      console.error("TURSO_DATABASE_URL is not set in this shell's environment");
      process.exit(1);
    }
    const client = createClient({ url, authToken });
    try {
      await window(client, since, until);
    } finally {
      client.close();
    }
    return;
  }

  const days = Number(process.argv[2] ?? 10);
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    console.error("TURSO_DATABASE_URL is not set in this shell's environment");
    process.exit(1);
  }
  const client = createClient({ url, authToken });
  try {
    for (const [name, sql] of Object.entries(QUERIES)) {
      const res = await client.execute(
        name === "hourly" ? { sql, args: [days] } : sql,
      );
      console.log(`### ${name}`);
      for (const row of res.rows) console.log(JSON.stringify(row));
      console.log("");
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("scan-history-daily failed:", err && err.message ? err.message : err);
  process.exit(1);
});
