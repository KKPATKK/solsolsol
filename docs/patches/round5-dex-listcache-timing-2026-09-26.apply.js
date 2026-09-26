#!/usr/bin/env node
/**
 * Round 5f (2026-09-26): two mistakes in Round 5e, both found by reading the
 * durable rows instead of the page — see the live evidence below.
 *
 * THE LIVE EVIDENCE (2026-09-26T15:37Z, `node scripts/read-heartbeat.js --keys
 * dex_list_cache_hits,dex_list_cache_misses,dex_list_cache_last`):
 *
 *     dex_list_cache_hits:    -
 *     dex_list_cache_misses:  "2"
 *     dex_list_cache_last:    -
 *
 * i.e. 8 ticks after the deploy, one row had ever been written.
 *
 * MISTAKE 1 — THE JOURNAL RAN AT THE WRONG END OF THE TICK. It sat at the
 * summary's build, which is BEFORE the profiles result is awaited (the fetch is
 * STARTED at the top of the scan) and BEFORE the boosts fetch — so a cold
 * isolate, which is most ticks, journaled while its own list requests were
 * still in flight. The delta was empty, the isolate was recycled, and the window
 * was lost; the one `misses 2` in the row is the rare WARM isolate reporting the
 * PREVIOUS tick's outcomes. It now runs after this tick's fetches and on the
 * front's own write, which is what makes it both correct and free.
 *
 * MISTAKE 2 — A REFUSAL READ AS A MISS. `cacheTtlByStatus` gives a TTL to
 * 200-299 alone, so a 429/5xx was never a candidate for the edge cache and
 * cannot be evidence that an entry had EXPIRED — the refusal has its own
 * counter (the dex429 ring, live: 4 events in the 12 minutes to 15:37Z). Only a
 * 2xx is now an outcome the ledger counts. A 2xx with no `cf-cache-status`
 * header still counts as a miss (see the ledger): a hit is the one outcome that
 * needs a header to prove itself.
 *
 * The two rows the old logic wrote are left in place and named in §4.30: 2
 * samples against a denominator that runs into the thousands is noise, and a
 * hand-written Turso DELETE is exactly the kind of write the read-only
 * instruments in this repo exist to avoid.
 *
 * Run: node docs/patches/round5-dex-listcache-timing-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new] */
const EDITS = [
  [
    "src/scanner.ts",
    "the journal moves out of the summary's build",
    lines(
      "    // The list-feed edge cache is JOURNALED here (see stampListCacheDelta):",
      "    // the client's own counters are isolate memory, so the question they exist",
      "    // to answer — is LIST_FEED_CACHE_TTL_S leaving the entry expired by the",
      "    // time the next tick asks? — could not be answered from /health at all.",
      "    // Same point as the `dex:` snapshot below, so the durable rows and that",
      "    // snapshot cover one window.",
      "    await this.stampListCacheDelta();",
      "    const diag: ScanSummary = {",
    ),
    lines(
      "    const diag: ScanSummary = {",
    ),
  ],
  [
    "src/scanner.ts",
    "and lands after this tick's fetches, on the front's one write",
    lines(
      "      // ...and the front's ONE write (see Db.writeScanFront): the launch_ms",
      "      // migration flag, the Birdeye backfill stamp and the prune's counter +",
      "      // stamp, in one request instead of up to four. Idempotent — the scan's",
      "      // `finally` calls this again for the paths that return earlier.",
      "      await this.flushScanFront();",
    ),
    lines(
      "      // The list-feed edge cache is JOURNALED here, and the position is the",
      "      // whole point: it must be after THIS tick's own list fetches (the",
      "      // profiles result is awaited in the feed phase, the boosts fetch is",
      "      // there too) and before the front's ONE write, so its rows ride a",
      "      // request that is already going out and the window it reports is the",
      "      // one the tick just produced.",
      "      //",
      "      // Journaling at the summary's build — the obvious place, since the",
      "      // page's `dex:` snapshot is taken there — was a live mistake",
      "      // (2026-09-26T15:37Z: 8 ticks after the deploy, the only row written",
      "      // was a rare warm isolate's `misses 2`). That build runs BEFORE the",
      "      // fetches answer, so every COLD isolate — which is most ticks —",
      "      // journaled an empty delta and lost its window with the isolate.",
      "      await this.stampListCacheDelta();",
      "      // ...and the front's ONE write (see Db.writeScanFront): the launch_ms",
      "      // migration flag, the Birdeye backfill stamp, the prune's counter +",
      "      // stamp and now the cache ledger, in one request instead of up to",
      "      // four. Idempotent — the scan's `finally` calls this again for the",
      "      // paths that return earlier.",
      "      await this.flushScanFront();",
    ),
  ],
  [
    "src/scanner.ts",
    "the helper's own doc names the window it now covers",
    lines(
      "  /**",
      "   * Journal the list-feed edge cache (see src/dexscreener.ts). Called once per",
      "   * scan, immediately before the summary's `dex:` snapshot is taken, so the",
      "   * durable rows and that snapshot describe the same window.",
      "   *",
    ),
    lines(
      "  /**",
      "   * Journal the list-feed edge cache (see src/dexscreener.ts). Called once per",
      "   * scan, after this tick's own list fetches and just before the front's",
      "   * write (see the call site), so the window is the one the tick produced and",
      "   * the rows cost no request of their own. The summary's `dex:` snapshot is a",
      "   * separate reading and stays where it was: it is the isolate's own view and",
      "   * carries the previous tick's fetches by design.",
      "   *",
    ),
  ],
  [
    "src/dexscreener.ts",
    "only a 2xx is an outcome about the entry",
    lines(
      "        if (listCacheTtlS !== undefined) {",
      "          // ONE place counts a list outcome and one place decides what a hit",
      "          // is (see the ledger): a second inline regex here is how the durable",
      "          // ratio would come to disagree with the page's own reading.",
      '          noteListCacheOutcome(res.headers.get("cf-cache-status"));',
      "        }",
    ),
    lines(
      "        if (listCacheTtlS !== undefined && res.ok) {",
      "          // ONE place counts a list outcome and one place decides what a hit",
      "          // is (see the ledger): a second inline regex here is how the durable",
      "          // ratio would come to disagree with the page's own reading.",
      "          //",
      "          // 2xx ONLY, and it is the ratio's meaning that requires it:",
      "          // `cacheTtlByStatus` gives an entry a TTL for 200-299 alone, so a",
      "          // 429/5xx was never a candidate for the edge cache and cannot read",
      "          // as an entry that had EXPIRED — a refusal is its own reading (see",
      "          // note429), and live 2026-09-26 they arrive every few minutes.",
      '          noteListCacheOutcome(res.headers.get("cf-cache-status"));',
      "        }",
    ),
  ],
  [
    "src/dexscreener.ts",
    "the ledger's doc states the same boundary",
    lines(
      " * `misses` share that keeps growing means the entry EXPIRED before the next",
      " * tick needed it — which is the whole of the LIST_FEED_CACHE_TTL_S question.",
      " * A response with NO `cf-cache-status` header counts as a MISS: a hit is the",
      " * one outcome that needs a header to prove itself, and a response whose",
      " * provenance is unknown was answered by the origin as far as we can tell.",
      " */",
    ),
    lines(
      " * `misses` share that keeps growing means the entry EXPIRED before the next",
      " * tick needed it — which is the whole of the LIST_FEED_CACHE_TTL_S question.",
      " * A 2xx response with NO `cf-cache-status` header counts as a MISS: a hit is",
      " * the one outcome that needs a header to prove itself, and a response whose",
      " * provenance is unknown was answered by the origin as far as we can tell.",
      " * A non-2xx response is not counted at all (see getJson): it was never a",
      " * candidate for the cache, and the refusals have their own counters.",
      " */",
    ),
  ],
  [
    "docs/round-trips.md",
    "§4.30: name the two mistakes the first deploy exposed",
    lines(
      "落線紀錄：`docs/patches/round5-dex-listcache-client-2026-09-26.apply.js`、`docs/patches/round5-dex-listcache-wire-2026-09-26.apply.js`、",
      "`docs/patches/round5-dex-listcache-health-2026-09-26.apply.js`。",
      "",
    ),
    lines(
      "**落線後修正（同日，§4.31）：兩個錯都由 durable row 揭出嚟，唔係由頁面。**",
      "",
      "落線紀錄：`docs/patches/round5-dex-listcache-client-2026-09-26.apply.js`、`docs/patches/round5-dex-listcache-wire-2026-09-26.apply.js`、",
      "`docs/patches/round5-dex-listcache-health-2026-09-26.apply.js`。",
      "",
    ),
  ],
];

// ---------------------------------------------------------------- verify ----
let failed = 0;
const prospective = new Map();
for (const [file, label, old, next] of EDITS) {
  const src = prospective.get(file) ?? read(file);
  const n = hits(src, old);
  if (n !== 1) {
    console.error(`✗ ${file}: ${label} — anchor matched ${n} times, need exactly 1`);
    failed += 1;
    continue;
  }
  prospective.set(file, src.replace(old, next));
}

const after = {
  sc: prospective.get("src/scanner.ts") ?? read("src/scanner.ts"),
  dex: prospective.get("src/dexscreener.ts") ?? read("src/dexscreener.ts"),
  doc: prospective.get("docs/round-trips.md") ?? read("docs/round-trips.md"),
};
const CHECKS = [
  [
    "exactly one journal call",
    ({ sc }) => hits(sc, "await this.stampListCacheDelta();") === 1,
  ],
  [
    "it is after this tick's profiles await",
    ({ sc }) => {
      const journal = sc.indexOf("await this.stampListCacheDelta();");
      const profiles = sc.indexOf("() => profilesCall");
      const boosts = sc.indexOf("fetchBoostedTokens(this.config.dexscreenerBoostsLimit)");
      return journal > profiles && journal > boosts;
    },
  ],
  [
    "it is after the pool phase (the last thing before the front's write)",
    ({ sc }) => {
      const journal = sc.indexOf("await this.stampListCacheDelta();");
      const pool = sc.indexOf("getReevalPoolCached(now");
      return pool > 0 && journal > pool;
    },
  ],
  [
    "it is before the front's normal-path write, and rides it",
    ({ sc }) => {
      const journal = sc.indexOf("await this.stampListCacheDelta();");
      const flush = sc.indexOf("await this.flushScanFront();");
      return flush > journal && flush - journal < 1200;
    },
  ],
  [
    "and it is NOT at the summary's build",
    ({ sc }) => {
      const journal = sc.indexOf("await this.stampListCacheDelta();");
      return journal > sc.indexOf("const diag: ScanSummary = {");
    },
  ],
  ["only 2xx outcomes are counted", ({ dex }) => dex.includes("listCacheTtlS !== undefined && res.ok")],
];
for (const [what, fn] of CHECKS) {
  let ok = false;
  try {
    ok = fn(after);
  } catch (err) {
    console.error(`✗ post-condition threw: ${what}: ${err.message}`);
    failed += 1;
    continue;
  }
  if (!ok) {
    console.error(`✗ post-condition failed: ${what}`);
    failed += 1;
  }
}
if (failed > 0) {
  console.error(`\n${failed} problem(s) — nothing written.`);
  process.exit(1);
}

// ---------------------------------------------------------------- write ----
for (const file of prospective.keys()) {
  fs.writeFileSync(path.join(root, file), prospective.get(file));
}
for (const [file, label] of EDITS) console.log(`✓ ${file}: ${label}`);
console.log("\nall post-conditions hold (checked BEFORE the write).");
