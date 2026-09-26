#!/usr/bin/env node
/**
 * Round 5e, first half (2026-09-26): the list-feed edge cache becomes a DURABLE
 * reading, which is what the OPEN QUESTION beside LIST_FEED_CACHE_TTL_S has
 * been waiting for.
 *
 * WHY (live 2026-09-26T14:01Z): `/health`'s dex block read `listCacheHits 0,
 * lastListCacheStatus null, http429 0, budgetDrops 0` on a tick that evaluated
 * `profiles: 2` — the cache was demonstrably working and the reading said
 * nothing, because it is CLIENT module state and the isolate is recycled every
 * tick. The TTL question (is 60s — exactly one tick — leaving the entry expired
 * by the time the next tick asks?) cannot be settled by a counter that resets
 * before it can be read.
 *
 * WHAT THIS SCRIPT DOES (counter only — no TTL change here, on purpose):
 *
 *   - The ledger (hits / misses / last status) moves to MODULE scope, because
 *     it is the accumulator the durable rows are made from and the reporter
 *     (Scanner.stampListCacheDelta) does not own the client's fields. A second
 *     accumulator fed by the same event is the drift this repo keeps paying
 *     for, so there is exactly ONE pair of counters: getStats() reads them and
 *     the delta is a difference against a baseline.
 *   - peek/consume, not a single consume: the caller peeks, writes, then
 *     consumes — so a refused write re-offers the same window instead of
 *     dropping it. Same two-step the Birdeye CU ledger uses (src/birdeye.ts).
 *   - A response with NO cf-cache-status header now counts as a MISS. Before,
 *     such a response was counted as neither: hits was the only counter, so a
 *     list lane that never got a header vanished from the reading entirely.
 *     A hit is the one outcome that needs a header to prove itself.
 *   - The durable key names live here, next to the ledger, exported: the
 *     writer (src/scanner.ts) and the reader (/health in src/worker.ts) import
 *     the same three constants, because a literal in two places is how the two
 *     ends of a counter drift apart.
 *
 * Run: node docs/patches/round5-dex-listcache-client-2026-09-26.apply.js
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
    "src/dexscreener.ts",
    "the OPEN QUESTION: the reading it waited for now exists",
    lines(
      " * OPEN QUESTION (2026-09-26, deliberately NOT changed here). A TTL that equals",
      " * the tick period is a boundary: an entry minted at T is HIT-able to T+60, and",
      " * the next tick arrives at ~T+60 + jitter, so whether the tick's own fetch is a",
      " * HIT or a MISS is decided by that jitter — and the MISS is the one that pays",
      " * origin latency (300-800ms on the shared egress) against FEED_DEADLINE_MS 900,",
      " * which is the shape of the ticks that evaluate no profiles at all. Raising this",
      " * to 180 would keep the entry alive across two ticks and stay inside what the",
      " * client already tolerates (a FAILED fetch serves a list up to",
      " * PROFILE_FEED_REUSE_MS old), i.e. it satisfies the invariant the guard in",
      " * scripts/test-deferred-priority.js pins. It is not done because the reading",
      " * that would settle it — listCacheHits / lastListCacheStatus — is CLIENT",
      " * module state, so an isolate recycled every tick reports `0 / null` however",
      " * well the cache is working (live 2026-09-26T14:01Z: listCacheHits 0,",
      " * lastListCacheStatus null, http429 0, budgetDrops 0 on a tick that read",
      " * `profiles: 2`). Make that reading durable first (the dex429 ring is the",
      " * existing pattern) — then the hit:miss ratio decides this number with data",
      " * instead of a theory.",
    ),
    lines(
      " * OPEN QUESTION (2026-09-26, deliberately NOT changed here — but no longer",
      " * unanswerable). A TTL that equals the tick period is a boundary: an entry",
      " * minted at T is HIT-able to T+60, and the next tick arrives at ~T+60 +",
      " * jitter, so whether the tick's own fetch is a HIT or a MISS is decided by that",
      " * jitter — and the MISS is the one that pays origin latency (300-800ms on the",
      " * shared egress) against FEED_DEADLINE_MS 900, which is the shape of the ticks",
      " * that evaluate no profiles at all. Raising this to 180 would keep the entry",
      " * alive across two ticks and stay inside what the client already tolerates (a",
      " * FAILED fetch serves a list up to PROFILE_FEED_REUSE_MS old), i.e. it",
      " * satisfies the invariant the guard in scripts/test-deferred-priority.js pins.",
      " *",
      " * What it was waiting for is the reading, and the reading was unusable:",
      " * listCacheHits / lastListCacheStatus were CLIENT module state, so an isolate",
      " * recycled every tick reported `0 / null` however well the cache was working",
      " * (live 2026-09-26T14:01Z: listCacheHits 0, lastListCacheStatus null, http429",
      " * 0, budgetDrops 0 on a tick that read `profiles: 2`). As of this build the",
      " * ledger is journaled into worker_state (see the ledger below and",
      " * /health's `dexListCache`), so the number is decided by DATA now: raise this",
      " * only when the durable misses are a real share of the total while http429",
      " * stays flat — that is the origin being asked because the entry expired, not",
      " * because we were refused. Until then 60 stands, and so does the guard that",
      " * pins it (its reason — a HIT is fresher than the 10-minute reuse lane — is",
      " * still true and is not what the data would overturn).",
    ),
  ],
  [
    "src/dexscreener.ts",
    "the ledger itself, beside the TTL it serves",
    lines(
      "export const LIST_FEED_CACHE_TTL_S = 60;",
      "",
      "/**",
      " * The Cloudflare-specific fetch options this client asks for (see",
    ),
    lines(
      "export const LIST_FEED_CACHE_TTL_S = 60;",
      "",
      "/**",
      " * The list-feed edge-cache LEDGER, and the durable key names it is mirrored",
      " * into.",
      " *",
      " * MODULE scope, not instance scope, and that is the point: this is the",
      " * accumulator the durable `dex_list_cache_*` rows are made from, and the tick",
      " * that reports it (Scanner.stampListCacheDelta) does not own the client's",
      " * fields. A second accumulator fed by the same event is exactly the drift this",
      " * repo keeps paying for, so there is ONE pair of counters: getStats() reads",
      " * them and the delta below is a difference against a baseline.",
      " *",
      " * WHAT IT ANSWERS: whether the edge cache actually serves the list feed.",
      " * `hits` climbing with `http429` flat means the origin was never asked; a",
      " * `misses` share that keeps growing means the entry EXPIRED before the next",
      " * tick needed it — which is the whole of the LIST_FEED_CACHE_TTL_S question.",
      " * A response with NO `cf-cache-status` header counts as a MISS: a hit is the",
      " * one outcome that needs a header to prove itself, and a response whose",
      " * provenance is unknown was answered by the origin as far as we can tell.",
      " */",
      "const LIST_CACHE_HIT_RE = /^(HIT|REVALIDATED)$/i;",
      "",
      "const listCacheLedger = {",
      "  hits: 0,",
      "  misses: 0,",
      "  /** The last status seen in this isolate (null = no list fetch yet). */",
      '  status: null as string | null,',
      "  /**",
      "   * The status the durable row already carries, so a replacement is queued",
      "   * only when the label CHANGED (see peekListCacheDelta).",
      "   */",
      '  reported: null as string | null,',
      "};",
      "",
      "/**",
      " * Count one list-feed outcome. Called from getJson — the only place the",
      " * `cf-cache-status` header is visible — so there is exactly one place that",
      " * decides what a hit is; an inline regex at a second call site is how the",
      " * durable ratio would come to disagree with the page's own reading.",
      " */",
      "function noteListCacheOutcome(status: string | null): void {",
      "  listCacheLedger.status = status;",
      "  if (status !== null && LIST_CACHE_HIT_RE.test(status)) {",
      "    listCacheLedger.hits += 1;",
      "    return;",
      "  }",
      "  listCacheLedger.misses += 1;",
      "}",
      "",
      "/** The hit/miss counts as of the last consume (see peekListCacheDelta). */",
      "let listCacheBaseline = { hits: 0, misses: 0 };",
      "",
      "/** What a reporter has to persist, and nothing it does not. */",
      "export interface ListCacheDelta {",
      "  hits: number;",
      "  misses: number;",
      "  /**",
      "   * The status to persist, or null when the durable row already says it —",
      "   * absent and \"no list fetch yet\" are the same row value, so a null status",
      "   * can never be reported and never needs to be.",
      "   */",
      "  status: string | null;",
      "}",
      "",
      "/**",
      " * The counters since the last consume, WITHOUT advancing: the caller peeks,",
      " * writes, and only then commits (consumeListCacheDelta), so a refused write",
      " * re-offers the same window instead of dropping it. The same two-step the",
      " * Birdeye CU ledger uses for the same reason (peekBirdeyeCuDelta /",
      " * consumeBirdeyeCuDelta in src/birdeye.ts).",
      " */",
      "export function peekListCacheDelta(): ListCacheDelta {",
      "  return {",
      "    hits: listCacheLedger.hits - listCacheBaseline.hits,",
      "    misses: listCacheLedger.misses - listCacheBaseline.misses,",
      "    status:",
      "      listCacheLedger.status !== listCacheLedger.reported",
      "        ? listCacheLedger.status",
      "        : null,",
      "  };",
      "}",
      "",
      "/**",
      " * Commit exactly the delta a LANDED write persisted. The baseline is taken",
      " * from the live ledger rather than from the delta, so an outcome that arrived",
      " * while the write was in flight is deferred to the next delta instead of",
      " * being lost or double counted.",
      " */",
      "export function consumeListCacheDelta(delta: ListCacheDelta): void {",
      "  listCacheBaseline = {",
      "    hits: listCacheLedger.hits,",
      "    misses: listCacheLedger.misses,",
      "  };",
      "  if (delta.status !== null) listCacheLedger.reported = delta.status;",
      "}",
      "",
      "/**",
      " * The durable rows the ledger is mirrored into — ONE set of names, imported by",
      " * both the writer (Scanner.stampListCacheDelta) and the reader (/health),",
      " * because a literal in two places is how the two ends of a counter drift apart.",
      " * The first two are ADD counters (Db.bumpTelemetryCounter /",
      " * ScanFrontWrite.add), the third is a replacement (the label, not a count).",
      " */",
      'export const DEX_LIST_CACHE_HITS_KEY = "dex_list_cache_hits";',
      'export const DEX_LIST_CACHE_MISSES_KEY = "dex_list_cache_misses";',
      'export const DEX_LIST_CACHE_LAST_KEY = "dex_list_cache_last";',
      "",
      "/**",
      " * The Cloudflare-specific fetch options this client asks for (see",
    ),
  ],
  [
    "src/dexscreener.ts",
    "the two instance fields become a pointer at the ledger",
    lines(
      "  /**",
      "   * Edge-cache readings for the list feeds (see LIST_FEED_CACHE_TTL_S): how",
      "   * many profile/boost responses came from the colo cache (`cf-cache-status`",
      "   * HIT/REVALIDATED) and what the LAST one said. This is the reading that",
      "   * proves the 429-driven `raw 0` ticks were cured by the cache rather than by",
      "   * the upstream getting kinder: `cacheHits` climbing with `http429` flat means",
      "   * the origin was never asked.",
      "   */",
      "  private listCacheHits = 0;",
      "  private lastListCacheStatus: string | null = null;",
    ),
    lines(
      "  // The list-feed edge-cache ledger is MODULE state (see the ledger beside",
      "  // LIST_FEED_CACHE_TTL_S): it is the accumulator the durable",
      "  // dex_list_cache_* rows mirror, so it cannot be per-instance without the two",
      "  // drifting — and getStats() below reads it from there.",
    ),
  ],
  [
    "src/dexscreener.ts",
    "getStats: the misses are a real reading now",
    lines(
      "    /** List-feed responses served from the colo edge cache (see",
      "     * LIST_FEED_CACHE_TTL_S) — climbing = the origin was never asked. */",
      "    listCacheHits: number;",
    ),
    lines(
      "    /** List-feed responses served from the colo edge cache (see",
      "     * LIST_FEED_CACHE_TTL_S) — climbing = the origin was never asked. */",
      "    listCacheHits: number;",
      "    /** The same lane's responses the cache did NOT serve (`cf-cache-status`",
      "     * MISS / BYPASS / EXPIRED / DYNAMIC, or no header at all): the share of",
      "     * these against the hits is what decides LIST_FEED_CACHE_TTL_S, and hits",
      "     * alone could not tell a working cache from a lane that never ran. */",
      "    listCacheMisses: number;",
    ),
  ],
  [
    "src/dexscreener.ts",
    "getStats: read the ledger",
    lines(
      "      listCacheHits: this.listCacheHits,",
      "      lastListCacheStatus: this.lastListCacheStatus,",
    ),
    lines(
      "      listCacheHits: listCacheLedger.hits,",
      "      listCacheMisses: listCacheLedger.misses,",
      "      lastListCacheStatus: listCacheLedger.status,",
    ),
  ],
  [
    "src/dexscreener.ts",
    "getJson: hand the outcome to the ledger",
    lines(
      "        if (listCacheTtlS !== undefined) {",
      '          const cacheStatus = res.headers.get("cf-cache-status");',
      "          this.lastListCacheStatus = cacheStatus;",
      "          if (cacheStatus !== null && /^(HIT|REVALIDATED)$/i.test(cacheStatus)) {",
      "            this.listCacheHits += 1;",
      "          }",
      "        }",
    ),
    lines(
      "        if (listCacheTtlS !== undefined) {",
      "          // ONE place counts a list outcome and one place decides what a hit",
      "          // is (see the ledger): a second inline regex here is how the durable",
      "          // ratio would come to disagree with the page's own reading.",
      '          noteListCacheOutcome(res.headers.get("cf-cache-status"));',
      "        }",
    ),
  ],
];

// ---------------------------------------------------------------- verify ----
let failed = 0;
for (const [file, label, old, next] of EDITS) {
  const src = read(file);
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
}
if (failed > 0) {
  console.error(`\n${failed} edit(s) refused — nothing written.`);
  process.exit(1);
}

// ---------------------------------------------------------------- write ----
for (const [file, label, old, next] of EDITS) {
  const src = read(file);
  fs.writeFileSync(path.join(root, file), src.replace(old, next));
  console.log(`✓ ${file}: ${label}`);
}

// ----------------------------------------------------------- post-conditions -
const dex = read("src/dexscreener.ts");
const checks = [
  [
    "no instance fields left for the ledger",
    dex.includes("private listCacheHits") === false &&
      dex.includes("private lastListCacheStatus") === false,
  ],
  ["the ledger owns the counters", hits(dex, "listCacheLedger.hits += 1") === 1],
  ["the misses are counted too", hits(dex, "listCacheLedger.misses += 1") === 1],
  ["one place records an outcome", hits(dex, "noteListCacheOutcome(") === 2],
  [
    "the hit test is not duplicated",
    hits(dex, "/^(HIT|REVALIDATED)$/i") === 1,
  ],
  ["getStats reports the misses", hits(dex, "listCacheMisses: listCacheLedger.misses") === 1],
  [
    "peek does not advance the baseline",
    dex.includes("export function peekListCacheDelta") &&
      dex.includes("export function consumeListCacheDelta"),
  ],
  [
    "the durable keys are exported from one place",
    hits(dex, "DEX_LIST_CACHE_HITS_KEY") === 1 &&
      hits(dex, "DEX_LIST_CACHE_MISSES_KEY") === 1 &&
      hits(dex, "DEX_LIST_CACHE_LAST_KEY") === 1,
  ],
];
let bad = 0;
for (const [what, ok] of checks) {
  if (!ok) {
    console.error(`✗ post-condition failed: ${what}`);
    bad += 1;
  }
}
if (bad > 0) process.exit(1);
console.log("\nall post-conditions hold.");
