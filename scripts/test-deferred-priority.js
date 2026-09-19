/*
 * Deferred-card make-up tests: the registry shared by the scanner and the
 * discovery feed, the pool-rotation priority it drives, the feed pull that
 * makes a make-up send happen on the NEXT tick, and the durable snapshot the
 * worker writes after the completion flush.
 *
 * Run by `npm run test:unit` (after the build), or on its own:
 *   node scripts/test-deferred-priority.js
 */
const assert = require("node:assert/strict");
const { DeferredPushLedger, deferredPushTokens, slicePoolRotation } = require("../dist/scanner.js");
const { loadPushDeferralSnapshot, nextPushDeferralSnapshot } = require("../dist/deferrallog.js");
const { DexScreenerClient } = require("../dist/dexscreener.js");
const { isDeferredToken, missingDeferredTokens, DEFERRED_MAKEUP_MAX } =
  require("../dist/deferredmakeup.js");
const { loadConfig } = require("../dist/config.js");

// ---------- the pool's rotation priority (a deferred coin in the query) ----
const ledger = new DeferredPushLedger();
ledger.defer("PRIORITY", 1);
assert.deepEqual(ledger.pendingTokens(), ["PRIORITY"]);
assert.equal(isDeferredToken("PRIORITY"), true, "the feed-side registry sees the same obligation");

const result = slicePoolRotation(
  [
    { tokenAddress: "ordinary-1" },
    { tokenAddress: "PRIORITY" },
    { tokenAddress: "ordinary-2" },
  ],
  0,
  2,
);
assert.deepEqual(result.slice.map((item) => item.tokenAddress), ["PRIORITY", "ordinary-1"]);
assert.equal(ledger.recover("PRIORITY"), true);
assert.equal(ledger.pendingCount, 0);
assert.equal(isDeferredToken("PRIORITY"), false, "a make-up push clears the registry too");

// ---------- the shared registry: one list, bounded, oldest first ----------
const reg = new DeferredPushLedger();
reg.defer("REG_A", 1);
reg.defer("REG_B", 2);
reg.defer("REG_A", 3); // same coin deferred again: one slot, one place
assert.deepEqual(
  deferredPushTokens().filter((t) => t.startsWith("REG_")),
  ["REG_A", "REG_B"],
  "oldest first, and the worker's durable snapshot reads the same list",
);
assert.deepEqual(
  missingDeferredTokens(["REG_A"]).filter((t) => t.startsWith("REG_")),
  ["REG_B"],
  "a coin the pool response already carries rides the rotation priority instead",
);
for (let i = 0; i < DEFERRED_MAKEUP_MAX + 4; i++) reg.defer(`REG_M${i}`, 10 + i);
assert.equal(
  missingDeferredTokens([]).filter((t) => t.startsWith("REG_")).length,
  DEFERRED_MAKEUP_MAX,
  "the per-tick make-up list is capped — a stuck backlog cannot grow the tick",
);
// Clean up before the feed test, or the cap would fill with these first
// (oldest-first) and hide the coin that test defers.
for (const token of [...deferredPushTokens()]) {
  if (token.startsWith("REG_")) reg.recover(token);
}
assert.deepEqual(deferredPushTokens().filter((t) => t.startsWith("REG_")), []);

// ---------- the feed pull: make-up coins ride the profiles list ----------
const origFetch = globalThis.fetch;
const feedBody = [
  { chainId: "solana", tokenAddress: "FEED_A", symbol: "A" },
  { chainId: "base", tokenAddress: "WRONGCHAIN" },
];
const stub = (body) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
};

async function feedTests() {
  const dex = new DexScreenerClient(loadConfig({}));
  reg.defer("PAID_LATE", 100);
  stub(feedBody);
  const out = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    out.map((p) => p.tokenAddress),
    ["FEED_A", "PAID_LATE"],
    "the deferred coin is appended past the feed's own coins",
  );
  assert.equal(out[1].symbol, undefined, "a make-up entry invents no metadata");

  // A coin the feed already returned is not duplicated.
  reg.recover("PAID_LATE");
  reg.defer("FEED_A", 101);
  const out2 = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    out2.map((p) => p.tokenAddress),
    ["FEED_A"],
    "a coin the feed already carries is never pulled in twice",
  );

  // An EMPTY feed stays empty: a 429-backoff tick must keep reading as an
  // outage (the `empty-feed-and-pool` skip, `profiles: 0` in /health) instead
  // of being masked by make-up coins.
  stub([]);
  assert.deepEqual(await dex.fetchLatestSolanaProfiles(), [], "an empty feed is never masked");
}

// ---------- the durable snapshot the worker writes after the flush ----------
const durable = nextPushDeferralSnapshot(
  null,
  { deferred: 1, recovered: 0, pending: 1 },
  100,
  { owner: "iso-a", deferred: 1, recovered: 0 },
  ["DURABLE_TOKEN"],
);
const reloaded = loadPushDeferralSnapshot(JSON.stringify(durable));
assert.deepEqual(reloaded.pendingTokens, ["DURABLE_TOKEN"]);

feedTests()
  .then(() => {
    // Cleanup: the registry is module state; leave nothing behind for the
    // next suite that loads this build.
    for (const token of [...deferredPushTokens()]) {
      if (token === "PAID_LATE" || token === "FEED_A") reg.recover(token);
    }
    assert.deepEqual(deferredPushTokens(), [], "the registry is empty after the run");
    console.log("deferred priority + feed make-up: pass");
  })
  .catch((err) => {
    globalThis.fetch = origFetch;
    console.error("deferred make-up tests failed:", err);
    process.exit(1);
  })
  .finally(() => {
    globalThis.fetch = origFetch;
  });
