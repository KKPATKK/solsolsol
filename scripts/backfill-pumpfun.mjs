#!/usr/bin/env node
/*
 * One-time backfill for the re-eval pool: seed token_stats with pump.fun
 * coins created in the last N hours (default 42), so coins launched before
 * the discovery feed went live are still tracked and can be pushed once
 * they hit the qualifying age window.
 *
 * NOTE: pump.fun blocks datacenter IPs — run this from a residential/home
 * network (the Cloudflare Worker is unaffected, it egresses from
 * Cloudflare's network).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/backfill-pumpfun.mjs [--since-hours 42] [--max-pages 1500] [--dry-run]
 */
import { createClient } from "@libsql/client/web";

const BASE_URL = "https://frontend-api.pump.fun";
const PAGE_SIZE = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const SINCE_HOURS = flag("--since-hours", 42);
const MAX_PAGES = flag("--max-pages", 1500);
const DRY_RUN = args.includes("--dry-run");

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error(
    "Missing TURSO_DATABASE_URL (run with --env-file-if-exists=.env.local)",
  );
  process.exit(1);
}

async function getJson(path, attempt = 1) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`pump.fun HTTP ${res.status}`);
    }
    if (!res.ok) return null; // 403/404 — blocked or endpoint moved
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null; // challenge/HTML page
    }
  } catch (err) {
    if (attempt < 3) {
      await sleep(attempt * 1000);
      return getJson(path, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const cutoff = Date.now() - SINCE_HOURS * 3600_000;
  console.log(
    `Backfilling pump.fun coins created since ${new Date(cutoff).toISOString()} (${SINCE_HOURS}h)...`,
  );
  if (DRY_RUN) console.log("DRY RUN — no rows will be written.");

  const coins = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson(
      `/coins?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=created&order=DESC`,
    );
    if (!Array.isArray(data) || data.length === 0) {
      console.log(
        `  page ${page}: feed ended (${Array.isArray(data) ? "empty" : "unparseable/blocked"}) — stopping`,
      );
      break;
    }
    let added = 0;
    let oldest = Infinity;
    for (const c of data) {
      const mint = typeof c?.mint === "string" ? c.mint.trim() : "";
      const created = typeof c?.created_timestamp === "number" ? c.created_timestamp : 0;
      if (!mint) continue;
      if (created) oldest = Math.min(oldest, created);
      if (created && created < cutoff) continue;
      if (seen.has(mint)) continue;
      seen.add(mint);
      coins.push({ mint, created });
      added++;
    }
    if (added === 0) {
      console.log(
        `  page ${page}: no new coins (offset pagination may be unsupported or swept past cutoff) — stopping`,
      );
      break;
    }
    if (page % 20 === 0 || oldest < cutoff) {
      console.log(
        `  page ${page}: collected ${coins.length} coins, newest ${oldest < Infinity ? new Date(oldest).toISOString() : "?"}`,
      );
    }
    if (oldest < cutoff) break;
    await sleep(250);
  }
  console.log(`Collected ${coins.length} coins.`);

  if (DRY_RUN) {
    console.log("Dry run complete — nothing written.");
    return;
  }
  if (coins.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  const client = createClient({ url, authToken: token });
  try {
    // Batch INSERT OR IGNORE (libsql parameter cap ~32k; 200 rows × 12 cols
    // = 2,400 args is safe). first_seen_at = created timestamp,
    // first_seen_age_min = 0, so the estimated launch equals creation time
    // and the re-eval pool ages the coin correctly.
    const BATCH = 200;
    let inserted = 0;
    for (let i = 0; i < coins.length; i += BATCH) {
      const slice = coins.slice(i, i + BATCH);
      const placeholders = slice
        .map(() => "(?, ?, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")
        .join(",");
      const args = [];
      for (const c of slice) args.push(c.mint, c.created);
      const res = await client.execute({
        sql: `INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, supply_flow, supply_flow_at) VALUES ${placeholders}`,
        args,
      });
      inserted += Number(res.rowsAffected ?? 0);
      if (i % 1000 === 0 || i + BATCH >= coins.length) {
        console.log(
          `  batch ${i / BATCH + 1}: ${inserted} new rows so far`,
        );
      }
    }
    console.log(
      `Done. Inserted ${inserted} new token_stats rows (${coins.length - inserted} already known).`,
    );
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(
    "backfill failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
