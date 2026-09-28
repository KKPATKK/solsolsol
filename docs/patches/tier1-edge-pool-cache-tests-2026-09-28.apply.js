/*
 * Tests for Tier 1 item 3 (2026-09-28): Db.poolRotationSlot as the one slot
 * computation, the snapshot key's stability (offsets, not absolutes), its
 * slot-scoping, graceful degradation without the Cache API, and the wiring
 * that reads the pool through the cache.
 *
 * Also pins the poolMs metric fix: poolMs must time the READ's promise, not
 * the await at the join (which measured the feed phase under the pool's name).
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const testPath = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(testPath, "utf8");

const MARK = "tier 1 (2026-09-28) — pool edges";
if (src.includes(MARK)) {
  console.log("= already applied");
  process.exit(0);
}

const IMPORT_FROM = `const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS } = require("../dist/db.js");`;
const IMPORT_TO = `const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS, poolRotationSlot } = require("../dist/db.js");`;

const SCAN_IMPORT_FROM = `SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS } = require("../dist/scanner.js");`;
const SCAN_IMPORT_TO = `SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS, poolKeyHash, poolQueryFingerprint, poolCacheView, poolEdgeCache, POOL_EDGE_CACHE_URL, POOL_EDGE_CACHE_MIN_TTL_S } = require("../dist/scanner.js");`;

const ANCHOR = `  console.log("\\n===== UNIT TESTS =====");`;

const BLOCK = `  await test(
    "tier 1 (2026-09-28) — pool edges: one slot computation, a stable key, and a cache that degrades",
    async () => {
      const strip = (text) =>
        text
          .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
          .replace(/\\/\\/[^\\n]*/g, "")
          .replace(/\\s+/g, "");
      const scannerSrc = strip(fs.readFileSync(path.join(__dirname, "..", "src", "scanner.ts"), "utf8"));
      const dbSrc = strip(fs.readFileSync(path.join(__dirname, "..", "src", "db.ts"), "utf8"));

      // ---- one slot computation, used by both queries AND the cache key ----
      assert.equal(poolRotationSlot(1_800_000, 90_000), 20, "slot = floor(now / period)");
      assert.equal(poolRotationSlot(1_800_000), 6, "the default period is POOL_ROTATION_PERIOD_MS (300s)");
      assert.equal(poolRotationSlot(89_999, 90_000), 0, "a slot covers [n*period, (n+1)*period)");
      assert.equal(poolRotationSlot(90_000, 90_000), 1, "and it advances exactly at the boundary");
      assert.equal(
        dbSrc.split("constslot=Math.floor(now/(opts.rotationPeriodMs??POOL_ROTATION_PERIOD_MS));").length - 1,
        0,
        "the inline slot expression is gone from both queries",
      );
      assert.equal(
        dbSrc.split("constslot=poolRotationSlot(now,opts.rotationPeriodMs);").length - 1,
        2,
        "both queries use the shared helper",
      );

      // ---- the fingerprint covers the QUERY, not the clock ----
      const t = 1_700_000_000_000;
      const bounds = (at) => ({
        seenChatIds: ["two", "one"],
        sinceMs: at - 108_000_000,
        minLaunchMs: at - 100_000_000,
        maxLaunchMs: at - 3_000_000,
        windowEntryLaunchMs: at - 18_000_000,
        limit: 1_000,
        nearSlots: 2,
        farSlots: 6,
        minQualifyMcap: 21_000,
        maxQualifyMcap: 5_000_000,
        minQualifyLiquidity: 9_000,
      });
      const fp = poolQueryFingerprint(bounds(t), t);
      assert.equal(
        fp,
        poolQueryFingerprint(bounds(t + 20_000), t + 20_000),
        "the same query 20s later keys the same snapshot (offsets, not absolutes)",
      );
      assert.notEqual(
        fp,
        poolQueryFingerprint(bounds(t) , t + 20_000),
        "…but a window that really moved does not",
      );
      assert.equal(
        fp,
        poolQueryFingerprint({ ...bounds(t), seenChatIds: ["one", "two"] }, t),
        "the chat id order is not part of the key (an IN-list has no order)",
      );
      assert.notEqual(
        fp,
        poolQueryFingerprint({ ...bounds(t), seenChatIds: ["one"] }, t),
        "a chat leaving changes the hidden-token exclusion, so it changes the key",
      );
      assert.notEqual(fp, poolQueryFingerprint({ ...bounds(t), limit: 999 }, t), "limit");
      assert.notEqual(
        fp,
        poolQueryFingerprint({ ...bounds(t), minQualifyLiquidity: 9_001 }, t),
        "a gate that decides which coins are pruned",
      );
      assert.match(fp, /^[0-9a-z]+$/, "the fingerprint is a hash, not a path");
      assert.equal(poolKeyHash(""), "ztntfp", "FNV-1a is pinned: a change re-keys every entry once");
      assert.equal(poolKeyHash("a"), "1r9wi7g");
      assert.notEqual(poolKeyHash("a"), poolKeyHash("b"));

      // ---- the key is slot-scoped, and the slot is the DB's ----
      assert.ok(scannerSrc.includes("POOL_EDGE_CACHE_URL"), "the key's origin is a named constant");
      assert.ok(
        scannerSrc.includes("constslot=poolRotationSlot(now,opts.rotationPeriodMs);"),
        "the key's slot comes from the shared helper",
      );
      assert.ok(
        scannerSrc.includes("returnPOOL_EDGE_CACHE_URL+slot+\\"/\\"+fp;"),
        "the slot is in the key's PATH, so an entry cannot answer a later slot",
      );

      // ---- a runtime without the Cache API must behave exactly as before ----
      assert.equal(
        poolEdgeCache(),
        null,
        "Node (the container entry) has no Cache API — the read is the only answer",
      );
      const view = poolCacheView();
      assert.equal(view.available, false, "and the summary says so instead of pretending");
      for (const key of ["hits", "misses", "puts", "errors", "memory"]) {
        assert.equal(typeof view[key], "number", \`\${key} is published\`);
      }
      assert.equal(
        typeof POOL_EDGE_CACHE_MIN_TTL_S === "number" && POOL_EDGE_CACHE_MIN_TTL_S >= 60,
        true,
        "Cloudflare's own minimum cache TTL is a minute",
      );
      assert.ok(
        scannerSrc.includes("Math.max(POOL_EDGE_CACHE_MIN_TTL_S,Math.round(ttlMs/1000))"),
        "the TTL is the configured period, floored at that minute",
      );

      // ---- the read goes through the cache, and always falls back ----
      assert.ok(
        scannerSrc.indexOf("awaitthis.poolSnapshotFromEdge(key)") <
          scannerSrc.indexOf("awaitthis.db.getReevalPool(opts)"),
        "the snapshot is consulted before the DB read",
      );
      assert.equal(
        scannerSrc.split("this.db.getReevalPool(opts)").length - 1,
        1,
        "one DB read: the cache wraps it instead of adding a second path",
      );
      assert.ok(
        scannerSrc.includes("if(key)this.poolSnapshotToEdge(key,stats,this.config.reevalPoolCacheMs);"),
        "a completed read seeds the slot's snapshot",
      );
      assert.ok(
        scannerSrc.includes("poolCacheCounters.misses+=1;"),
        "and the DB read is the only thing counted as a miss",
      );
      assert.ok(
        scannerSrc.includes("if(!cache)returnnull;"),
        "a cache-less runtime returns null (not an empty pool)",
      );
      assert.ok(
        scannerSrc.includes("if(!Array.isArray(stats))returnnull;"),
        "a malformed entry falls through to the DB read",
      );
      assert.ok(
        scannerSrc.includes("diag.poolCache=poolCacheView();"),
        "the counters are published on the summary",
      );
      assert.ok(
        scannerSrc.includes("now:poolNow,"),
        "the query clock is pinned so the DB's slot IS the key's slot",
      );

      // ---- poolMs times the read's promise, not the await ----
      assert.ok(
        scannerSrc.includes("poolReadMs=Date.now()-poolReadStartedAt;"),
        "the dispatched read records when ITSELF settled",
      );
      assert.equal(
        scannerSrc.split("diag.poolMs=Date.now()-poolReadStartedAt;").length - 1,
        0,
        "the join no longer reads the clock for poolMs (that measured the feed phase)",
      );
      assert.ok(scannerSrc.includes("diag.poolMs=poolReadMs;"), "it reports the recorded duration");
    },
  );

`;

let out = src;
for (const [from, to, name] of [
  [IMPORT_FROM, IMPORT_TO, "imports: poolRotationSlot"],
  [SCAN_IMPORT_FROM, SCAN_IMPORT_TO, "imports: the pool-edge helpers"],
]) {
  if (out.includes(to)) {
    console.log(`= ${name} (already applied)`);
    continue;
  }
  const n = out.split(from).length - 1;
  if (n !== 1) {
    console.log(`✗ ${name} — anchor found ${n} times`);
    process.exit(1);
  }
  out = out.replace(from, () => to);
  console.log(`✓ ${name}`);
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
console.log("✓ added the pool-edge tests");
