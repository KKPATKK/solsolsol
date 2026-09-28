/*
 * How much pool does a window change actually admit? Read-only, against the
 * live Turso database.
 *
 *   node scripts/pool-window-drift.js [windowHours] [marginMin]
 *
 * args are the ALTERNATIVE window to compare against the tick's own; default
 * 43h / 30min, which is what scripts/cpu-profile.js restated by hand until
 * 2026-09-28 (the tick runs 30h / 180min). The tick's numbers are imported
 * from dist/scanner.js, so this instrument cannot drift from it.
 *
 * Why it exists: the pool query is LIMIT-bound, so a wider window does not
 * return more rows — it changes WHICH rows the sweep re-measures. With 43h of
 * `first_seen_at` lookback, coins first seen 30–43h ago compete for the same
 * slots as the tick's coins, and a 30min age margin lets launch boundaries
 * 2.5h tighter than the tick's. That is a composition difference, so this
 * prints set differences, not counts.
 *
 * Usage needs the .env.local Turso creds.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../dist/config.js");
const { Db } = require("../dist/db.js");
const {
  RE_EVAL_WINDOW_MS,
  RE_EVAL_AGE_MARGIN_MIN,
  POOL_MCAP_PRUNE_RATIO,
  POOL_LIQUIDITY_PRUNE_RATIO,
} = require("../dist/scanner.js");
const { fmtUsd } = require("../dist/format.js");

const ALT_WINDOW_MS = (Number(process.argv[2]) || 43) * 3600_000;
const ALT_MARGIN_MIN = Number.isFinite(Number(process.argv[3]))
  ? Number(process.argv[3])
  : 30;

/** wrangler.toml's [vars] — the deployed knobs, which beat the code defaults. */
function wranglerVars() {
  const text = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
  const out = {};
  let inVars = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      inVars = /^\s*\[vars\]/.test(line);
      continue;
    }
    if (!inVars) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const cfg = loadConfig({ ...process.env, ...wranglerVars() });

/** The scanner's pool query shape, with a swappable window/margin. */
function poolArgs(now, chats, windowMs, marginMin) {
  const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
  const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
  return {
    sinceMs: now - windowMs,
    minLaunchMs: now - (maxAge + marginMin) * 60_000,
    maxLaunchMs: now - (minAge - marginMin) * 60_000,
    windowEntryLaunchMs: now - minAge * 60_000,
    limit: cfg.reevalPoolSize,
    nearSlots: cfg.reevalNearSlots,
    farSlots: cfg.reevalFarSlots,
    rotationPeriodMs: cfg.reevalPoolCacheMs,
    minQualifyMcap: Math.min(...chats.map((c) => c.minMarketCapUsd)) * POOL_MCAP_PRUNE_RATIO,
    maxQualifyMcap: Math.max(...chats.map((c) => c.maxMarketCapUsd)) * 2,
    minQualifyLiquidity:
      Math.min(...chats.map((c) => c.minLiquidityUsd)) * POOL_LIQUIDITY_PRUNE_RATIO,
    // seenChatIds is deliberately NOT passed, matching the scanner's own call
    // site (src/db.ts accepts it; only /debug/pool supplies it).
  };
}

const hours = (ms) => (ms / 3600_000).toFixed(1) + "h";

async function main() {
  const db = new Db(cfg.tursoUrl, cfg.tursoAuthToken);
  await db.init();

  const chats = await db.listEnabledChats();
  if (chats.length === 0) {
    console.log("no enabled chats — nothing to measure (the pool is chat-derived)");
    return 1;
  }

  const now = Date.now();
  const tick = await db.getReevalPool(
    poolArgs(now, chats, RE_EVAL_WINDOW_MS, RE_EVAL_AGE_MARGIN_MIN),
  );
  const alt = await db.getReevalPool(poolArgs(now, chats, ALT_WINDOW_MS, ALT_MARGIN_MIN));
  const tickSet = new Set(tick.map((r) => r.token));
  const altSet = new Set(alt.map((r) => r.token));

  const altOnly = alt.filter((r) => !tickSet.has(r.token));
  const tickOnly = tick.filter((r) => !altSet.has(r.token));

  console.log(`enabled chats         ${chats.length}`);
  console.log(
    `age band              ${Math.min(...chats.map((c) => c.minAgeMinutes))}-${Math.max(...chats.map((c) => c.maxAgeMinutes))}min, gate ${fmtUsd(Math.min(...chats.map((c) => c.minMarketCapUsd)))}`,
  );
  console.log(
    `tick window           ${hours(RE_EVAL_WINDOW_MS)} / ${RE_EVAL_AGE_MARGIN_MIN}min margin  (imported from dist/scanner.js)`,
  );
  console.log(`alternative           ${hours(ALT_WINDOW_MS)} / ${ALT_MARGIN_MIN}min margin`);
  console.log(`pool knobs            limit ${cfg.reevalPoolSize}, near ${cfg.reevalNearSlots} / far ${cfg.reevalFarSlots} slots`);
  console.log("");
  console.log(`rows returned         tick ${tick.length}, alternative ${alt.length}`);
  console.log(
    `distinct tokens       tick ${tickSet.size}, alternative ${altSet.size}, shared ${tickSet.size - tickOnly.length}`,
  );
  console.log("");
  console.log(`the alternative re-measures ${altOnly.length} coin(s) the tick's window excludes:`);
  for (const r of altOnly.slice(0, 12)) {
    console.log(
      `  ${String(r.symbol || r.token).slice(0, 12).padEnd(13)}launch ${hours(now - r.launchMs).padStart(6)} old, first seen ${hours(now - (r.firstSeenAt || 0)).padStart(6)} old`,
    );
  }
  if (altOnly.length > 12) console.log(`  … and ${altOnly.length - 12} more`);
  // Classify by where the coin sits relative to the TICK's own launch band.
  // Only the third bucket is subtle, and it is the biggest one: a coin inside
  // both bands can still be excluded, because moving either constant moves the
  // band's absolute edges and therefore every rotation slot's window.
  const tickMinLaunch = now - (Math.max(...chats.map((c) => c.maxAgeMinutes)) + RE_EVAL_AGE_MARGIN_MIN) * 60_000;
  const tickMaxLaunch = now - (Math.min(...chats.map((c) => c.minAgeMinutes)) - RE_EVAL_AGE_MARGIN_MIN) * 60_000;
  const olderTail = altOnly.filter((r) => r.launchMs < tickMinLaunch).length;
  const youngTail = altOnly.filter((r) => r.launchMs > tickMaxLaunch).length;
  console.log(
    `  older than the tick's band: ${olderTail} | younger than it: ${youngTail} | inside it, excluded by the slot windows: ${altOnly.length - olderTail - youngTail}`,
  );
  console.log(
    `  (the 20-22h coins above are that third bucket: same band, the band's edges moved, so the rotation slots landed elsewhere)`,
  );
  console.log("");
  console.log(`the tick re-measures ${tickOnly.length} coin(s) the alternative never saw:`);
  for (const r of tickOnly.slice(0, 12)) {
    console.log(
      `  ${String(r.symbol || r.token).slice(0, 12).padEnd(13)}launch ${hours(now - r.launchMs).padStart(6)} old`,
    );
  }
  if (tickOnly.length > 12) console.log(`  … and ${tickOnly.length - 12} more`);
  console.log("");
  const union = new Set([...tickSet, ...altSet]).size;
  console.log(
    tickOnly.length || altOnly.length
      ? `⇒ not interchangeable: ${tickOnly.length + altOnly.length} of the ${union} distinct tokens (${(((tickOnly.length + altOnly.length) / (union || 1)) * 100).toFixed(0)}%) appear in only one of the two sweeps.`
      : "⇒ no measured difference in this slot (a window change can still differ in another slot).",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
