#!/usr/bin/env node
/*
 * READ-ONLY: why is ONE deferred obligation still owed?
 *
 * The durable row says a token is pending; the registry says whether the
 * make-up lane judged it. What neither can say from the outside is whether the
 * coin can still be PUSHED at all — and the three state rows that decide it are
 * tables, not worker_state:
 *
 *   seen_tokens  — a claim that WON. `claimTokenPush` inserts here before the
 *                  send, so a row means "this chat has this coin"; the gate
 *                  that filters seen coins is what a stalled obligation would
 *                  be stuck behind.
 *   push_watch   — the tracker's row (a pushed coin is tracked).
 *   push_audit   — the delivery proof; an initial card that really landed is
 *                  in the ring with its message id.
 *
 * A pending token with NO seen_tokens row and NO audit entry is a coin that was
 * never claimed and never delivered — i.e. the make-up lane has to re-qualify
 * it, and the debt is waiting on the GATES, not on a lost claim.
 *
 * Run: node docs/patches/deferral-token-read-2026-09-27.read.js <MINT>
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

async function main() {
  const mint = (process.argv[2] ?? "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    console.error("usage: … <mint>");
    process.exit(1);
  }
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();
  const c = db.get();

  const seen = await c.execute({
    sql: "SELECT chat_id, token, first_seen_at FROM seen_tokens WHERE token = ?",
    args: [mint],
  });
  console.log(`seen_tokens rows: ${seen.rows.length}`);
  for (const r of seen.rows) {
    console.log(`  chat ${r.chat_id} first_seen ${new Date(Number(r.first_seen_at)).toISOString()}`);
  }

  const watch = await c.execute({
    sql: "SELECT token, chat_id, symbol, pushed_at, last_state, last_checked, last_alert_at FROM push_watch WHERE token = ?",
    args: [mint],
  });
  console.log(`push_watch rows: ${watch.rows.length}`);
  for (const r of watch.rows) console.log(`  ${JSON.stringify(r)}`);

  const audit = await db.getPushAudit();
  const hits = (audit ?? []).filter((r) => r.token === mint);
  console.log(`push_audit entries: ${hits.length}`);
  for (const r of hits) console.log(`  ${JSON.stringify(r)}`);

  const stats = (await db.getTokenStatsMany([mint])).get(mint) ?? null;
  console.log(`token_stats: ${stats ? JSON.stringify(stats) : "-"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("probe failed:", err?.message ?? err);
  process.exit(1);
});
