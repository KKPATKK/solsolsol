/*
 * End-to-end test for the pool snapshot cache: the write path and the READ
 * path (put -> match -> JSON -> TokenStats), through a fake Cache API injected
 * on globalThis — which is also how the production hit path gets verified,
 * since the live colo has been serving every slot from one warm isolate whose
 * in-memory cache answers first (hits 0).
 *
 * The two private methods use no instance state, so they are called through
 * the prototype: no Scanner construction (and no bot/db/config mocks) needed.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const testPath = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(testPath, "utf8");

const MARK = "tier 1 (2026-09-28) — pool snapshot round trip through a fake Cache API";
if (src.includes(MARK)) {
  console.log("= already applied");
  process.exit(0);
}

const ANCHOR = `  console.log("\\n===== UNIT TESTS =====");`;

const IMPORT_FROM = `, poolKeyHash, poolQueryFingerprint, poolCacheView, poolEdgeCache, POOL_EDGE_CACHE_URL, POOL_EDGE_CACHE_MIN_TTL_S } = require("../dist/scanner.js");`;
const IMPORT_TO = `, poolKeyHash, poolQueryFingerprint, poolCacheView, poolEdgeCache, POOL_EDGE_CACHE_URL, POOL_EDGE_CACHE_MIN_TTL_S, Scanner } = require("../dist/scanner.js");`;

const BLOCK = `  await test(
    "tier 1 (2026-09-28) — pool snapshot round trip through a fake Cache API",
    async () => {
      // A realistic pool row: EVERY field populated, because the row the gates
      // see after a cache hit must be the row the DB returned. JSON is the
      // carrier, so a non-primitive field would be the way this breaks.
      const row = {
        token: "So11111111111111111111111111111111111111112",
        firstSeenAt: 1_790_000_000_000,
        firstM5Vol: 12_345.67,
        firstSeenAgeMin: 61.5,
        launchMs: 1_789_996_310_000,
        birdeye1mVol: 4_321.5,
        rugcheckBundlerPct: 12.5,
        rugcheckTop10Pct: 33.25,
        birdeyeProTraders: 3,
        birdeyeSniperPct: 9.75,
        holderCount: 812,
        holderCountAt: 1_790_000_100_000,
        minMcapObserved: 41_000.5,
        maxMcapObserved: 173_500,
        maxLiquidityObserved: 22_400,
        supplyFlowJson: '{"verdict":"ok"}',
        supplyFlowAt: 1_790_000_050_000,
        discoveredVia: "pump",
      };
      const store = new Map();
      const fakeCache = {
        async match(request) {
          const body = store.get(request.url);
          return body === undefined ? null : new Response(body);
        },
        async put(request, response) {
          store.set(request.url, await response.text());
        },
      };
      const before = poolCacheView();
      globalThis.caches = { default: fakeCache };
      try {
        assert.notEqual(poolEdgeCache(), null, "the injected colo cache is what the module reads");
        assert.equal(poolCacheView().available, true, "and the summary stops saying unavailable");

        const get = Scanner.prototype.poolSnapshotFromEdge;
        const put = Scanner.prototype.poolSnapshotToEdge;
        const key = Scanner.prototype.poolSnapshotKey.call(
          {},
          1_790_000_000_000,
          {
            seenChatIds: ["c1"],
            sinceMs: 1_790_000_000_000 - 108_000_000,
            minLaunchMs: 1_790_000_000_000 - 100_000_000,
            maxLaunchMs: 1_790_000_000_000 - 3_000_000,
            windowEntryLaunchMs: 1_790_000_000_000 - 18_000_000,
            limit: 1_000,
            rotationPeriodMs: 90_000,
          },
        );
        assert.equal(typeof key, "string", "a runtime WITH the Cache API gets a key");
        assert.ok(key.startsWith(POOL_EDGE_CACHE_URL), "under the cache's own origin");
        assert.ok(
          key.includes("/" + Math.floor(1_790_000_000_000 / 90_000) + "/"),
          "whose path is the rotation slot",
        );

        assert.equal(await get.call({}, key), null, "a cold key is a miss, not an error");

        put.call({}, key, [row], 90_000);
        await new Promise((resolve) => setImmediate(resolve));
        const after = poolCacheView();
        assert.equal(after.puts - before.puts, 1, "the write lands");

        const hit = await get.call({}, key);
        assert.deepEqual(
          hit,
          [row],
          "the snapshot survives JSON exactly — a dropped field would change what the gates see",
        );
        assert.equal(poolCacheView().hits - before.hits, 1, "and the read counts as a hit");

        // A different slot must never answer for this one: the key changes, so
        // the next slot starts cold instead of serving the old window.
        const nextKey = Scanner.prototype.poolSnapshotKey.call(
          {},
          1_790_000_000_000 + 90_000,
          {
            seenChatIds: ["c1"],
            sinceMs: 1_790_000_000_000 + 90_000 - 108_000_000,
            minLaunchMs: 1_790_000_000_000 + 90_000 - 100_000_000,
            maxLaunchMs: 1_790_000_000_000 + 90_000 - 3_000_000,
            windowEntryLaunchMs: 1_790_000_000_000 + 90_000 - 18_000_000,
            limit: 1_000,
            rotationPeriodMs: 90_000,
          },
        );
        assert.notEqual(nextKey, key, "the slot is in the key");
        assert.equal(await get.call({}, nextKey), null, "so the next slot cannot read this one");

        // A corrupt entry must not become a pool: it falls through to the DB.
        const corrupt = key + "corrupt";
        store.set(corrupt, "not json");
        assert.equal(await get.call({}, corrupt), null, "a malformed body is a miss");
        store.set(corrupt, '{"not":"an array"}');
        assert.equal(await get.call({}, corrupt), null, "and so is a non-array body");
      } finally {
        delete globalThis.caches;
      }
      const rest = poolCacheView();
      assert.equal(rest.available, false, "the runtime is back to having no Cache API");
      assert.equal(rest.errors - before.errors, 1, "the malformed body was counted, not thrown");
    },
  );

`;

let out = src;
if (out.includes(IMPORT_TO)) {
  console.log("= imports: Scanner (already applied)");
} else {
  const n = out.split(IMPORT_FROM).length - 1;
  if (n !== 1) {
    console.log(`✗ imports: Scanner — anchor found ${n} times`);
    process.exit(1);
  }
  out = out.replace(IMPORT_FROM, () => IMPORT_TO);
  console.log("✓ imports: Scanner");
}

const at = out.indexOf(ANCHOR);
if (at < 0) {
  console.log("✗ tail anchor not found");
  process.exit(1);
}
out = out.slice(0, at) + BLOCK + out.slice(at);
if (out.split(MARK).length - 1 !== 1) {
  console.log("✗ expected exactly one copy of the new test — not writing");
  process.exit(1);
}
fs.writeFileSync(testPath, out);
console.log("✓ added the pool snapshot round-trip test");
