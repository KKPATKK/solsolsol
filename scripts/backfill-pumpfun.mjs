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
 * NOTE (2026-09-30): every INSERT OR IGNORE below is paired with a bump of
 * worker_state.telemetry_token_stats_count, exactly as Db.recordTokenStats
 * does in src/db.ts. Without it the rows are never counted but the prune
 * that later deletes them still DECREMENTS the counter, which is how this
 * script froze a −6,884 gap into /health for weeks (the counter read 6,884
 * below /debug/pool's live COUNT(*) and could never recover: only a negative
 * counter self-heals). Keep the bump if this script is ever rewritten.
 *
 * WHERE THE ROWS GO (2026-10-15): D1, via the Cloudflare API — the Worker's
 * store since the Turso→D1 cutover (docs/d1-migration-2026-10-15.md), named by
 * D1_DATABASE_ID. Turso is a READ-ONLY archive now: a row written there would
 * never be read by the Worker (the pool would silently miss it) and would
 * revive the rows-written overage the migration removed, so writing it takes
 * --allow-archive-write and a TURSO_DATABASE_URL/TURSO_AUTH_TOKEN pair. The
 * statement shapes are D1's: chunkForParamLimit with the real 100-parameter
 * ceiling (src/d1.ts), the same rule every writer in src/db.ts follows.
 *
 * Needs the built Worker for the chunk helper: run `npm run build` first.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/backfill-pumpfun.mjs [--since-hours 42] [--max-pages 1500] [--dry-run]
 */
import { createClient } from "@libsql/client/web";
import * as d1 from "../dist/d1.js";
import d1Rest from "./d1-rest.js";

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

/** The re-eval pool's own statement shapes — kept verbatim from the Turso era. */
const TOKEN_STATS_INSERT_PREFIX =
  "INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, supply_flow, supply_flow_at)";
const TOKEN_STATS_ROW = "(?, ?, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)";
/** Two bindings a row, so D1 takes 50 rows per statement and libsql 200. */
const ARGS_PER_ROW = 2;
const COUNTER_KEY = "telemetry_token_stats_count";
const COUNTER_SQL = `INSERT INTO worker_state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  value = CAST(value AS INTEGER) + excluded.value`;

/**
 * The one INSERT OR IGNORE for a slice of coins, chunked by the transport's own
 * ceiling — see the header. Returns the statements, so the caller sends them in
 * one batch.
 */
function tokenStatsStatements(slice, limit) {
  const statements = [];
  for (const chunk of d1.chunkForParamLimit(slice, ARGS_PER_ROW, limit, 200)) {
    const args = [];
    for (const c of chunk) args.push(c.mint, c.created);
    statements.push({
      sql: `${TOKEN_STATS_INSERT_PREFIX} VALUES ${chunk.map(() => TOKEN_STATS_ROW).join(",")}`,
      args,
    });
  }
  return statements;
}

/** Sum of `rowsAffected` over a batch's answers (libsql and D1 both report it). */
const affected = (results) => results.reduce((n, r) => n + Number(r.rowsAffected ?? 0), 0);

/**
 * Where the rows go. D1 unless this run explicitly opts into the archive, so
 * the default can never be the thing the cutover made stale.
 */
function makeWriteTarget() {
  const databaseId = process.env.D1_DATABASE_ID;
  if (databaseId) {
    const transport = d1.createD1Transport(
      d1Rest.createRestBinding(
        d1Rest.createD1Rest({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
        }),
        databaseId,
      ),
    );
    return {
      kind: `D1 database ${databaseId}`,
      close: () => {},
      insertTokenStats: async (slice) =>
        affected(await transport.batch(tokenStatsStatements(slice, d1.D1_MAX_BOUND_PARAMS))),
      bumpCounter: (n) =>
        transport.execute({ sql: COUNTER_SQL, args: [COUNTER_KEY, String(n)] }),
    };
  }

  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!args.includes("--allow-archive-write")) {
    throw new Error(
      "no D1_DATABASE_ID: refusing to write the Turso ARCHIVE (read-only since the 2026-10-15 cutover — rows here are never read by the Worker)." +
        " Pass D1_DATABASE_ID (and CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) to write D1, or --allow-archive-write for a deliberate one-off.",
    );
  }
  if (!url || !token) {
    throw new Error(
      "--allow-archive-write needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (run with --env-file-if-exists=.env.local)",
    );
  }
  const client = createClient({ url, authToken: token });
  return {
    kind: "the Turso archive (--allow-archive-write)",
    close: () => client.close(),
    insertTokenStats: async (slice) =>
      affected(await client.batch(tokenStatsStatements(slice, 32_766))),
    bumpCounter: (n) => client.execute({ sql: COUNTER_SQL, args: [COUNTER_KEY, String(n)] }),
  };
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
    if (!res.ok) {
      // 403/404/530 — blocked (datacenter IP) or endpoint moved. Log the
      // status so a reachability check is diagnosable at a glance.
      console.warn(`  ⚠️ pump.fun HTTP ${res.status} — blocked or endpoint moved`);
      return null;
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      console.warn(`  ⚠️ pump.fun returned a non-JSON page (challenge/HTML) — blocked`);
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

  const target = makeWriteTarget();
  console.log(`Writing to ${target.kind}.`);
  try {
    // Batch INSERT OR IGNORE. first_seen_at = created timestamp,
    // first_seen_age_min = 0, so the estimated launch equals creation time
    // and the re-eval pool ages the coin correctly.
    const BATCH = 200;
    let inserted = 0;
    for (let i = 0; i < coins.length; i += BATCH) {
      const slice = coins.slice(i, i + BATCH);
      inserted += await target.insertTokenStats(slice);
      if (i % 1000 === 0 || i + BATCH >= coins.length) {
        console.log(
          `  batch ${i / BATCH + 1}: ${inserted} new rows so far`,
        );
      }
    }
    console.log(
      `Done. Inserted ${inserted} new token_stats rows (${coins.length - inserted} already known).`,
    );
    // Pay the /health pool counter for what this run inserted. The SQL is
    // Db.bumpTelemetryCounter's, verbatim (an atomic SQL-side add, so a
    // concurrent tick's bump can never be lost) and the row name is spelled
    // out here rather than imported, so this script never depends on the
    // Worker bundle's internals for its telemetry.
    // Best-effort: telemetry may never fail the backfill —
    // the rows are already stored. The next hourly reconcile
    // (Db.reconcileTelemetryCounts) re-derives the counter from a live
    // COUNT(*) anyway, so a failed bump is bounded by one hour of drift.
    if (inserted > 0) {
      try {
        await target.bumpCounter(inserted);
        console.log(`  bumped telemetry_token_stats_count by ${inserted}`);
      } catch (err) {
        console.warn(
          `  ⚠️ telemetry_token_stats_count bump failed (rows are still stored):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    target.close();
  }
}

main().catch((err) => {
  console.error(
    "backfill failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
