/*
 * The list-feed edge-cache ledger, and the journal that makes it readable
 * (2026-09-26).
 *
 * WHY THIS IS A FILE OF ITS OWN: the failure this change exists to remove is a
 * reading that LOOKS fine and means nothing — `listCacheHits 0 /
 * lastListCacheStatus null` on an isolate recycled every tick, while the cache
 * was in fact serving the feed. Round 5e's whole point is that the durable
 * rows answer the LIST_FEED_CACHE_TTL_S question with data, so the things that
 * could quietly break that are asserted here instead of watched for live:
 *
 *   1. What a hit is (and that a header-less response is NOT one — before this
 *      change such a response was counted as neither hit nor miss).
 *   2. peek does not advance, and consume commits ONLY the rows that landed —
 *      the difference between "a failed write is re-offered" and "a landed
 *      write is written twice".
 *   3. The journal really writes ADDs through the real Db.writeScanFront: a
 *      replacement would silently reset a running counter, and no live reading
 *      would say so until the ratio drifted.
 *   4. The zero ADD is a no-op on both paths (a zero row must not appear).
 *   5. /health imports the key names and reads them on the batch it already
 *      pays for — a literal retyped there is how the two ends drift apart.
 *
 * Run: node scripts/test-dex-list-cache.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { loadConfig } = require("../dist/config.js");
const {
  DexScreenerClient,
  peekListCacheDelta,
  consumeListCacheDelta,
  DEX_LIST_CACHE_HITS_KEY,
  DEX_LIST_CACHE_MISSES_KEY,
  DEX_LIST_CACHE_LAST_KEY,
} = require("../dist/dexscreener.js");
const { Db } = require("../dist/db.js");
const { Scanner } = require("../dist/scanner.js");

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

/** One list-feed response with a chosen `cf-cache-status` (or none at all). */
const listResponse = (header) =>
  new Response(JSON.stringify([{ chainId: "solana", tokenAddress: "CACHE_A" }]), {
    status: 200,
    headers: header === undefined ? {} : { "cf-cache-status": header },
  });

/** Fetch a list leg once, so the ledger counts exactly one outcome. */
async function oneListFetch(header) {
  globalThis.fetch = async () => listResponse(header);
  const dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }));
  const out = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(out.map((p) => p.tokenAddress), ["CACHE_A"], "the stub answered a list");
  return dex;
}

/**
 * Drain whatever an earlier case left pending, so each case asserts its own
 * window. Committing the pending label is deliberate: a case that wants to see
 * a label reported again starts from "already reported".
 */
function drain() {
  consumeListCacheDelta(peekListCacheDelta());
  return peekListCacheDelta();
}

function tmpDb() {
  const p = path.join(
    os.tmpdir(),
    `dex-listcache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return { p, client: createClient({ url: `file:${p}` }) };
}

/** A scanner that journals into `db` and has NO front (the standalone path). */
function scannerWith(db) {
  return new Scanner(
    db,
    { api: { sendMessage: async () => ({}) } },
    null,
    loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }),
    null,
    null,
    null,
  );
}

async function main() {
  // ---------- what an outcome is ----------
  await test("the rule: HIT counts as a hit, MISS and a missing header do not", async () => {
    drain();
    const dex = await oneListFetch("HIT");
    let delta = peekListCacheDelta();
    assert.deepEqual(delta, { hits: 1, misses: 0, status: "HIT" }, "a HIT is a hit, and the label is news");

    await oneListFetch("MISS");
    delta = peekListCacheDelta();
    assert.deepEqual(
      delta,
      { hits: 1, misses: 1, status: "MISS" },
      "a MISS is a miss — the delta is a difference, so the hit from before is still in it",
    );

    // The case the old counter could not see at all: a list response with no
    // `cf-cache-status` header. It was counted as neither, so a lane that never
    // got a header vanished from the reading instead of reading as a miss.
    await oneListFetch(undefined);
    delta = peekListCacheDelta();
    assert.deepEqual(
      delta,
      { hits: 1, misses: 2, status: null },
      "no header = the origin answered as far as we can tell; the label is unchanged, so it is not news",
    );

    // REVALIDATED is the other way the edge says "served from cache".
    await oneListFetch("REVALIDATED");
    assert.deepEqual(
      peekListCacheDelta(),
      { hits: 2, misses: 2, status: "REVALIDATED" },
      "REVALIDATED is a hit",
    );
  });

  await test("getStats reads the same ledger, and peeking never consumes it", async () => {
    drain();
    const dex = await oneListFetch("HIT");
    const before = dex.getStats();
    const seen = peekListCacheDelta();
    const after = dex.getStats();
    assert.equal(after.listCacheHits - before.listCacheHits, 0, "a peek does not touch the counters");
    assert.equal(after.listCacheMisses, before.listCacheMisses);
    assert.equal(seen.hits, 1, "the delta is exactly the one outcome");
    assert.equal(
      typeof after.listCacheMisses,
      "number",
      "the page's own reading carries the misses too — hits alone could not tell a working cache from a lane that never ran",
    );
  });

  // ---------- commit only what landed ----------
  await test("consume commits the rows that landed, and nothing else", async () => {
    drain();
    await oneListFetch("BYPASS");
    const delta = peekListCacheDelta();
    assert.deepEqual(delta, { hits: 0, misses: 1, status: "BYPASS" });

    consumeListCacheDelta(delta, { hits: true });
    const afterHitsOnly = peekListCacheDelta();
    assert.deepEqual(
      afterHitsOnly,
      { hits: 0, misses: 1, status: "BYPASS" },
      "the misses row and the label were NOT written, so they are re-offered",
    );

    consumeListCacheDelta(afterHitsOnly, { misses: true });
    assert.deepEqual(
      peekListCacheDelta(),
      { hits: 0, misses: 0, status: "BYPASS" },
      "the label is still pending: its own write is the one that failed",
    );

    consumeListCacheDelta(peekListCacheDelta(), { status: true });
    assert.deepEqual(
      peekListCacheDelta(),
      { hits: 0, misses: 0, status: null },
      "an already-reported label is not news, so nothing is re-offered forever",
    );
  });

  // ---------- the journal (no front: one request per row) ----------
  await test("the scanner journals the window, then has nothing left to offer", async () => {
    drain();
    await oneListFetch("MISS");
    await oneListFetch("HIT");
    const bumps = [];
    const replaces = [];
    const scanner = scannerWith({
      bumpTelemetryCounter: async (key, value) => bumps.push([key, value]),
      setWorkerState: async (key, value) => replaces.push([key, value]),
    });
    await scanner.stampListCacheDelta();
    assert.deepEqual(
      bumps.slice().sort((a, b) => a[0].localeCompare(b[0])),
      [
        [DEX_LIST_CACHE_HITS_KEY, 1],
        [DEX_LIST_CACHE_MISSES_KEY, 1],
      ],
      "both counters are ADDs of this window's counts",
    );
    assert.deepEqual(
      replaces,
      [[DEX_LIST_CACHE_LAST_KEY, "HIT"]],
      "and the label is a replacement, written only because it changed (the case before left it reading BYPASS)",
    );

    bumps.length = 0;
    replaces.length = 0;
    await scanner.stampListCacheDelta();
    assert.deepEqual(bumps, [], "a consumed window is not written twice");
    assert.deepEqual(replaces, [], "and the label is not rewritten for nothing");
  });

  await test("a row that failed is re-offered; a row that landed is not", async () => {
    drain();
    // The label is only written when it CHANGED, so this case needs one that
    // is news: the case above left the durable label reading HIT.
    await oneListFetch("MISS");
    const bumps = [];
    const scanner = scannerWith({
      bumpTelemetryCounter: async (key, value) => bumps.push([key, value]),
      setWorkerState: async () => {
        throw new Error("Turso refused the write");
      },
    });
    await scanner.stampListCacheDelta();
    assert.deepEqual(bumps, [[DEX_LIST_CACHE_MISSES_KEY, 1]], "the counted row landed");
    assert.deepEqual(
      peekListCacheDelta(),
      { hits: 0, misses: 0, status: "MISS" },
      "the counted row is committed, and the label — whose write threw — is still pending",
    );
    await scanner.stampListCacheDelta();
    assert.deepEqual(bumps, [[DEX_LIST_CACHE_MISSES_KEY, 1]], "and it is not counted twice on the retry");
  });

  // ---------- the real write path: an ADD, not a replacement ----------
  await test("through Db.writeScanFront the row ACCUMULATES (a replacement would reset it)", async () => {
    const t = tmpDb();
    try {
      const db = new Db("file:injected", undefined, t.client);
      await db.init();
      const scanner = scannerWith(db);
      // A real front already exists in production; this one is the tick's
      // single write, so the journal rides it exactly as it does live.
      scanner.scanFront = { writes: [], gates: new Map() };

      drain();
      await oneListFetch("HIT");
      await scanner.stampListCacheDelta();
      await db.writeScanFront(scanner.scanFront.writes);
      scanner.scanFront.writes = [];
      assert.equal(
        await db.getWorkerState(DEX_LIST_CACHE_HITS_KEY),
        "1",
        "the first window lands as a value",
      );
      assert.equal(
        await db.getWorkerState(DEX_LIST_CACHE_MISSES_KEY),
        null,
        "a zero ADD is never written — an absent row means the window has not reported, not that nothing was counted",
      );

      // A miss, then two hits: the label ends the window where it started (the
      // first window persisted HIT), so this window is the two counters and
      // NOT a third row — the shapes have to be told apart.
      await oneListFetch("MISS");
      await oneListFetch("HIT");
      await oneListFetch("HIT");
      await scanner.stampListCacheDelta();
      assert.equal(scanner.scanFront.writes.length, 2, "the second window is TWO queued rows");
      await db.writeScanFront(scanner.scanFront.writes);
      assert.equal(
        await db.getWorkerState(DEX_LIST_CACHE_HITS_KEY),
        "3",
        "1 + 2: the front's statement must ADD — a replacement would read 2 here and quietly under-count the ratio forever",
      );
      assert.equal(
        await db.getWorkerState(DEX_LIST_CACHE_MISSES_KEY),
        "1",
        "and the other counter accumulates on its own row",
      );
      assert.equal(
        await db.getWorkerState(DEX_LIST_CACHE_LAST_KEY),
        "HIT",
        "the label is a replacement and it did not change, so it was not written again",
      );
    } finally {
      await t.client.close();
      try {
        fs.unlinkSync(t.p);
      } catch {
        /* best-effort */
      }
    }
  });

  // ---------- the reader ----------
  await test("src/worker.ts: /health reads them off the batch it already pays for", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8");
    assert.equal(
      src.includes('"dex_list_cache'),
      false,
      "the names are imported, never retyped — a literal here and a literal in the scanner is how the two ends drift apart",
    );
    const open = src.indexOf("readHealthFront([");
    assert.ok(open > 0, "the handler must still call readHealthFront");
    const call = src.slice(open, open + src.slice(open).indexOf("]);"));
    for (const [name, key] of [
      ["DEX_LIST_CACHE_HITS_KEY", DEX_LIST_CACHE_HITS_KEY],
      ["DEX_LIST_CACHE_MISSES_KEY", DEX_LIST_CACHE_MISSES_KEY],
      ["DEX_LIST_CACHE_LAST_KEY", DEX_LIST_CACHE_LAST_KEY],
    ]) {
      assert.ok(call.includes(name), `${name} must ride the front's key list`);
      assert.ok(key.startsWith("dex_list_cache_"), `${name} names a durable row`);
    }
    assert.equal(
      src.includes("        dexListCache,\n"),
      true,
      "and the block must be published — a read nobody sees is not a reading",
    );
    const dex = fs.readFileSync(path.join(__dirname, "..", "src", "dexscreener.ts"), "utf8");
    assert.equal(
      dex.includes("private listCacheHits"),
      false,
      "the ledger is module state now: a per-instance counter is the thing that read 0 on every recycled isolate",
    );
  });

  console.log(results.join("\n"));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("dex list-cache suite crashed:", err);
  process.exit(1);
});
