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
 * No writes at all: one SELECT each, through scripts/open-store.js — the seam
 * every off-body tool reads the store through — so this report now reads the
 * LIVE D1 rows (the rows it aggregates are the Worker's own completions, and
 * on the frozen Turso copy they stop at the 2026-10-15 cutover, which makes a
 * "daily" report over recent days answer from a month-old snapshot). `source:`
 * is printed before the first line, and `--archive` asks for the frozen copy on
 * purpose.
 *
 * Run: node scripts/scan-history-daily.js
 *      node scripts/scan-history-daily.js 14   (hourly rows covering N days)
 *      node scripts/scan-history-daily.js --since 2026-10-12T04:00:00Z \
 *          --until 2026-10-12T04:30:00Z        (one window's totals + ticks —
 *          the A/B reading: same database, same columns, a bounded interval)
 *      node scripts/scan-history-daily.js --archive  (the pre-cutover copy)
 */
"use strict";

const { openTarget } = require("./open-store.js");

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
async function window(target, since, until) {
  const args = [since, until];
  for (const [name, sql] of [
    ["window-totals", WINDOW_TOTALS],
    ["window-claims", WINDOW_SEEN],
    ["window-claim-rows", WINDOW_SEEN_ROWS],
    ["window-ticks", WINDOW_TICKS],
  ]) {
    const res = await target.select(sql, args);
    console.log(`### ${name}`);
    for (const row of res.rows) console.log(JSON.stringify(row));
    console.log("");
  }
}

async function main() {
  const sinceArg = process.argv.indexOf("--since");
  const untilArg = process.argv.indexOf("--until");
  // The store is decided ONCE, before any reading — `source:` is what makes a
  // frozen row impossible to mistake for a fresh one (see open-store.js).
  const target = await openTarget(process.argv.slice(2));
  console.log(`source: ${target.kind}`);

  if (sinceArg !== -1) {
    const since = Date.parse(String(process.argv[sinceArg + 1] ?? ""));
    const until = untilArg !== -1 ? Date.parse(String(process.argv[untilArg + 1] ?? "")) : Date.now();
    if (!Number.isFinite(since) || !Number.isFinite(until)) {
      console.error("--since/--until need ISO timestamps");
      process.exit(1);
    }
    await window(target, since, until);
    return;
  }

  const n2 = Number(process.argv[2]);
  // A flag in argv[2] (`--archive`) is not a day count: NaN would bind a
  // non-number into the hourly window instead of defaulting to ten days.
  const days = Number.isFinite(n2) && n2 > 0 ? Math.floor(n2) : 10;
  for (const [name, sql] of Object.entries(QUERIES)) {
    const res = await target.select(sql, name === "hourly" ? [days] : []);
    console.log(`### ${name}`);
    for (const row of res.rows) console.log(JSON.stringify(row));
    console.log("");
  }
}

main().catch((err) => {
  console.error("scan-history-daily failed:", err && err.message ? err.message : err);
  process.exit(1);
});
