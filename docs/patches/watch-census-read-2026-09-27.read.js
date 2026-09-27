#!/usr/bin/env node
/*
 * READ-ONLY push-watch census: the issueCount the /debug census endpoint
 * reports, computed locally so the check costs no Worker invocation (a /debug
 * call is itself a tick-handling invocation).
 *
 * Same rule the endpoint applies: listPushWatch(limit) + terminalRowIssues per
 * row; plus the "oldest unchecked active row" age, which is the pool's health
 * reading.
 *
 * Run: node docs/patches/watch-census-read-2026-09-27.read.js [limit]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");
const { terminalRowIssues } = require("../../dist/pushwatch.js");

const TERMINAL = new Set(["rug", "unwatched", "expired"]);

async function main() {
  const limit = Number(process.argv[2] ?? 120);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const rows = await db.listPushWatch(limit);
  const withIssues = rows.filter((r) => terminalRowIssues(r).length > 0);
  const active = rows.filter((r) => !TERMINAL.has(String(r.lastState)));
  const ages = active.map((r) => Date.now() - Number(r.lastChecked)).sort((a, b) => a - b);
  const q = (p) => (ages.length ? ages[Math.min(ages.length - 1, Math.floor(ages.length * p))] : 0);

  console.log(`now ${new Date().toISOString()}  limit ${limit}`);
  console.log(`rows ${rows.length}  active ${active.length}  terminal ${rows.length - active.length}`);
  console.log(`issueCount ${withIssues.length}${withIssues.length ? ` ${JSON.stringify(withIssues.slice(0, 3))}` : ""}`);
  if (ages.length) {
    console.log(
      `oldest-unchecked (active): median ${Math.round(q(0.5) / 1000)}s  ` +
        `p90 ${Math.round(q(0.9) / 1000)}s  max ${Math.round(ages[ages.length - 1] / 1000)}s`,
    );
  }
  const states = new Map();
  for (const r of rows) states.set(String(r.lastState), (states.get(String(r.lastState)) ?? 0) + 1);
  console.log(`states ${JSON.stringify([...states.entries()].sort((a, b) => b[1] - a[1]))}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
