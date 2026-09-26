#!/usr/bin/env node
/**
 * Round 5e, third half (2026-09-26): /health READS the journaled list-cache
 * ledger — on the request it is already paying for.
 *
 * The three rows ride Db.readHealthFront, the batch the page was moved onto
 * earlier today (see docs/patches/round5-health-front*.apply.js), so the
 * reading costs no round trip: a key in a statement that is already going out
 * is free, and the counts arrive through the SAME rule every other counter on
 * this page uses (parseTelemetryCounter / telemetryCounterUsable) rather than a
 * second interpretation of "what an integer row is".
 *
 * WHY THE PAGE NEEDS IT: `dex.listCacheHits` in the scan summary is isolate
 * memory and the isolate is recycled every tick, so the LIST_FEED_CACHE_TTL_S
 * question (does a 60s entry expire before the next tick asks?) had no answer
 * on any public surface. `dexListCache` is the answer as data:
 *
 *   - `hits` / `misses` — the fleet's totals since the counters were added;
 *   - `hitPct` — the share the cache served. Flat-low with `http429` flat is
 *     the origin being asked because the entry expired;
 *   - `lastStatus` — the most recent label, for the "what does the edge say
 *     about us right now" question;
 *   - null — no tick has reported yet, which is NOT the same reading as 0/0
 *     (an ADD of zero is never written, see ScanFrontWrite.add).
 *
 * Run: node docs/patches/round5-dex-listcache-health-2026-09-26.apply.js
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
    "src/worker.ts",
    "import the durable key names with the client they belong to",
    lines(
      'import { DexScreenerClient } from "./dexscreener";',
    ),
    lines(
      "import {",
      "  DexScreenerClient,",
      "  DEX_LIST_CACHE_HITS_KEY,",
      "  DEX_LIST_CACHE_LAST_KEY,",
      "  DEX_LIST_CACHE_MISSES_KEY,",
      '} from "./dexscreener";',
    ),
  ],
  [
    "src/worker.ts",
    "the three rows ride the front's one read",
    lines(
      '          "push_watch_pass",',
      '          "telemetry_token_stats_count",',
      '          "telemetry_seen_tokens_count",',
      "        ]);",
    ),
    lines(
      '          "push_watch_pass",',
      '          "telemetry_token_stats_count",',
      '          "telemetry_seen_tokens_count",',
      "          // The list-feed edge-cache ledger the scanner journals",
      "          // (2026-09-26): the answer to LIST_FEED_CACHE_TTL_S rides THIS",
      "          // request for the same reason the two counters above do. The",
      "          // names are imported, never retyped — a literal here and a",
      "          // literal in the scanner is how the two ends drift apart.",
      "          DEX_LIST_CACHE_HITS_KEY,",
      "          DEX_LIST_CACHE_MISSES_KEY,",
      "          DEX_LIST_CACHE_LAST_KEY,",
      "        ]);",
    ),
  ],
  [
    "src/worker.ts",
    "declare the block beside the CU ledger it sits next to",
    lines(
      "        byEndpoint: { today: BirdeyeCuCounts; month: BirdeyeCuCounts };",
      "      } | null = null;",
    ),
    lines(
      "        byEndpoint: { today: BirdeyeCuCounts; month: BirdeyeCuCounts };",
      "      } | null = null;",
      "      // The list-feed edge cache, as the SCANNER journaled it (see",
      "      // src/dexscreener.ts). Read from Turso for the reason above: the",
      "      // counters move on the tick, and /health is answered by whichever",
      "      // isolate the request lands on. null = no tick has reported yet,",
      "      // which is a different reading from 0/0.",
      "      let dexListCache: {",
      "        hits: number;",
      "        misses: number;",
      "        /** hits / (hits + misses) as a percentage, or null while nothing",
      "         * was answered. THIS is the LIST_FEED_CACHE_TTL_S reading. */",
      "        hitPct: number | null;",
      "        /** The last list-feed `cf-cache-status` the durable row carries. */",
      "        lastStatus: string | null;",
      "      } | null = null;",
    ),
  ],
  [
    "src/worker.ts",
    "build it from the rows the batch carried",
    lines(
      "          byEndpoint: birdeyeCuByStats(",
      '            parseBirdeyeCuByLedger(tickState?.get(BIRDEYE_CU_BY_STATE_KEY) ?? null),',
      "          ),",
      "        };",
    ),
    lines(
      "          byEndpoint: birdeyeCuByStats(",
      '            parseBirdeyeCuByLedger(tickState?.get(BIRDEYE_CU_BY_STATE_KEY) ?? null),',
      "          ),",
      "        };",
      "        // Same batch, same rule: a row that is absent or drifted is not a",
      "        // number, and the pair is reported only when at least one of them",
      "        // IS one — a zero ADD is never written, so an absent row means the",
      "        // window has not reported yet rather than \"nothing was answered\".",
      "        const listCacheHits = parseTelemetryCounter(",
      "          tickState?.get(DEX_LIST_CACHE_HITS_KEY),",
      "        );",
      "        const listCacheMisses = parseTelemetryCounter(",
      "          tickState?.get(DEX_LIST_CACHE_MISSES_KEY),",
      "        );",
      "        if (",
      "          telemetryCounterUsable(listCacheHits) ||",
      "          telemetryCounterUsable(listCacheMisses)",
      "        ) {",
      "          const hits = telemetryCounterUsable(listCacheHits) ? listCacheHits : 0;",
      "          const misses = telemetryCounterUsable(listCacheMisses)",
      "            ? listCacheMisses",
      "            : 0;",
      "          const answered = hits + misses;",
      "          dexListCache = {",
      "            hits,",
      "            misses,",
      "            hitPct:",
      "              answered > 0 ? +((hits / answered) * 100).toFixed(1) : null,",
      "            lastStatus: tickState?.get(DEX_LIST_CACHE_LAST_KEY) ?? null,",
      "          };",
      "        }",
    ),
  ],
  [
    "src/worker.ts",
    "publish it",
    lines(
      "        birdeyeCu,",
    ),
    lines(
      "        birdeyeCu,",
      "        dexListCache,",
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
  if (src.includes(next) && next !== old) {
    console.error(`✗ ${file}: ${label} — already applied`);
    failed += 1;
    continue;
  }
  prospective.set(file, src.replace(old, next));
}

const w = prospective.get("src/worker.ts") ?? read("src/worker.ts");
const CHECKS = [
  ["no literal key names in the page", hits(w, '"dex_list_cache') === 0],
  [
    "the three constants are in the front's key list",
    hits(w, "DEX_LIST_CACHE_HITS_KEY,") === 2 &&
      hits(w, "DEX_LIST_CACHE_MISSES_KEY,") === 2 &&
      hits(w, "DEX_LIST_CACHE_LAST_KEY,") === 2,
  ],
  ["the counts go through the shared rule", hits(w, "telemetryCounterUsable(listCacheHits)") === 2],
  ["the block is published", hits(w, "        dexListCache,\n") === 1],
];
for (const [what, ok] of CHECKS) {
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
