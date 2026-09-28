/*
 * Tier 2 items 6+7 (2026-09-28): two feeds were paying for rows they threw
 * away.
 *
 *  6. JUPITER_RECENT_LIMIT 20 → 30 (the config DEFAULT). /recent answers ≥30
 *     rows in ONE request regardless of the limit param, and the client slices
 *     the result to the configured cap — so the cap was the only thing deciding
 *     how many of the rows already in hand got used. +10 seconds-old launches
 *     per tick for zero extra subrequests.
 *  7. DEXSCREENER_BOOSTS_LIMIT 20 → 30 in wrangler.toml. /token-boosts/latest/v1
 *     answers 30 rows, same host and same request count: the 20 discarded 10
 *     paid-promotion rows per tick. 30 is also the config's clamp, so the value
 *     is the upstream's own ceiling.
 *
 * Neither adds a request, a host or a rate-limit bucket — the tick already
 * fetched both lists. What they do add is ~20 coins per tick walking the pair +
 * gate path, which is why the doc comments record the measurement that has to
 * be checked on the live counters (tick ms, dex.http429/budgetDrops, pairs).
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const configPath = path.join(ROOT, "src", "config.ts");
const tomlPath = path.join(ROOT, "wrangler.toml");
const jupPath = path.join(ROOT, "src", "jupfeeds.ts");

const log = [];
let failed = 0;

function edit(name, file, from, to) {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(to) && !src.includes(from)) {
    log.push(["=", `${name} (already applied)`]);
    return;
  }
  const n = src.split(from).length - 1;
  if (n !== 1) {
    log.push(["✗", `${name} — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = src.replace(from, () => to);
  fs.writeFileSync(file, src);
  log.push(["✓", name]);
}

// ------------------------------------------------ 6. the recent-launches dial
edit(
  "config: JUPITER_RECENT_LIMIT default 20 → 30",
  configPath,
  `  /**
   * Jupiter Token v2 recent-launches feed size per scan (JUPITER_RECENT_LIMIT,
   * default 20, max 100, 0 = disabled). Seconds-old launchpad launches — the
   * free no-key replacement for the blocked pump.fun frontend-api feed.
   * Keep modest while Turso's rows-read quota recovers: every net-new coin
   * grows token_stats and with it the re-eval pool band scans.
   */
  jupiterRecentLimit: number;`,
  `  /**
   * Jupiter Token v2 recent-launches feed size per scan (JUPITER_RECENT_LIMIT,
   * default 30, max 100, 0 = disabled). Seconds-old launchpad launches — the
   * free no-key replacement for the blocked pump.fun frontend-api feed.
   *
   * 2026-09-28: default 20 → 30, and the reason is that the 20 was FREE to
   * raise. /recent answers ≥30 rows in ONE request whatever limit is asked for
   * (measured 2026-08-21), and the client slices the parsed rows to this cap —
   * so the cap was deciding how many rows it already held got used, not how
   * much the upstream was asked for. Same one subrequest, same host: +10
   * seconds-old launches per tick. The cost side is Turso (every net-new coin
   * grows token_stats and with it the re-eval pool band scans), which is what
   * the rows-read quota and RE_EVAL_POOL_SIZE bound — so this is the number to
   * lower first if the pool ever outweighs the launches it finds.
   */
  jupiterRecentLimit: number;`,
);

edit(
  "config: the recent-launches default value",
  configPath,
  `    jupiterRecentLimit: Number.isFinite(Number(env.JUPITER_RECENT_LIMIT ?? 20))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_RECENT_LIMIT ?? 20)), 100))
      : 20,`,
  `    jupiterRecentLimit: Number.isFinite(Number(env.JUPITER_RECENT_LIMIT ?? 30))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_RECENT_LIMIT ?? 30)), 100))
      : 30,`,
);

// --------------------------------------------------- 7. the boosts dial (prod)
edit(
  "wrangler: DEXSCREENER_BOOSTS_LIMIT 20 → 30",
  tomlPath,
  `DEXSCREENER_BOOSTS_LIMIT = "20"`,
  `DEXSCREENER_BOOSTS_LIMIT = "30"`,
);

edit(
  "config: the boosts doc records the deployed value",
  configPath,
  `   * Rows carry no metrics
   * and no timestamps — the age comes from the pair the next batch fetches.
   */
  dexscreenerBoostsLimit: number;`,
  `   * Rows carry no metrics
   * and no timestamps — the age comes from the pair the next batch fetches.
   *
   * 2026-09-28: production runs the upstream's own ceiling (DEXSCREENER_BOOSTS_LIMIT
   * = "30" in wrangler.toml). /token-boosts/latest/v1 answers 30 rows, so the
   * previous 20 discarded 10 paid-promotion rows per tick — same host, same
   * single request. The clamp below (30) IS that ceiling: a bigger number is a
   * typo, not a request for more.
   */
  dexscreenerBoostsLimit: number;`,
);

// ------------------------------------------------- the client-side reason
edit(
  "jupfeeds: the slice comment records the new cap",
  jupPath,
  `    // Slice client-side: measured 2026-08-21 the lite-api returns ≥30 rows
    // regardless of the limit param, and the configured cap IS the Turso
    // rows-read budget guard (every extra row can become a token_stats one).`,
  `    // Slice client-side: measured 2026-08-21 the lite-api returns ≥30 rows
    // regardless of the limit param, and the configured cap IS the Turso
    // rows-read budget guard (every extra row can become a token_stats one).
    // 2026-09-28: the cap moved 20 → 30 because of exactly that measurement —
    // the rows were already in the response, so the cap was choosing how many
    // of them to use, not how many to ask for.`,
);

for (const [m, n] of log) console.log(`${m} ${n}`);
if (failed === 0) {
  const config = fs.readFileSync(configPath, "utf8");
  const toml = fs.readFileSync(tomlPath, "utf8");
  const ok =
    config.includes("env.JUPITER_RECENT_LIMIT ?? 30") &&
    toml.includes('DEXSCREENER_BOOSTS_LIMIT = "30"');
  if (!ok) {
    console.log("✗ refused: the dials are not both in place");
    process.exit(1);
  }
} else {
  console.log("✗ an anchor failed");
}
console.log(`\n${failed === 0 ? "OK" : "FAILED"} (${log.length} steps)`);
process.exit(failed === 0 ? 0 : 1);
