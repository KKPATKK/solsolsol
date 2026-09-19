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
const {
  isDeferredToken,
  missingDeferredTokens,
  DEFERRED_MAKEUP_MAX,
  feedMakeupView,
  resetFeedMakeup,
} = require("../dist/deferredmakeup.js");
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

  // An EMPTY feed is no longer left alone (2026-09-19). The skip existed to
  // keep `profiles: 0` readable as an outage, but the ticks it cost the
  // backlog were exactly the ones a cold isolate serves (5 of the 7
  // `profiles 0` ticks in one 118-tick window fell within two minutes of a
  // deploy) — so the outage signal is now recorded per request instead:
  // rawProfiles stays 0 and emptyFeedTotal counts it, while the deferred coin
  // rides the list like on any other tick.
  resetFeedMakeup();
  stub([]);
  const out3 = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    out3.map((p) => p.tokenAddress),
    ["FEED_A"],
    "an empty feed still carries the make-up",
  );
  const emptyView = feedMakeupView();
  assert.equal(emptyView.lastRawProfiles, 0, "the RAW size is still 0 — that IS the outage signal");
  assert.equal(emptyView.emptyFeedTotal, 1, "and it is counted fleet-wide");
  assert.equal(emptyView.lastInjected, 1, "the make-up is what filled the list");
  assert.equal(emptyView.injectedTotal, 1, "the injected count accumulates per request");
  assert.equal(emptyView.feedRequests, 1);
  assert.equal(emptyView.lastEmptyFeedAt !== null, true, "the empty feed is stamped");
  reg.recover("FEED_A");
}

// ---------- the whole tick: the make-up coin is EVALUATED, not just listed ----
// The feed test above proves the profiles list carries the deferred coin. This
// one proves the tick then acts on it: the coin reaches the pair phase (and
// therefore the gates and the candidate chain) on that same tick, without
// waiting for its pool rotation band.
async function tickMakeupTest() {
  const { Db } = require("../dist/db.js");
  const { Scanner } = require("../dist/scanner.js");
  const { createClient } = require("@libsql/client");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const p = path.join(os.tmpdir(), `defer-makeup-${process.pid}-${Date.now()}.db`);
  const client = createClient({ url: `file:${p}` });
  const stubFeed = (body) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  };
  try {
    const db = new Db(p, undefined, client);
    await db.init();
    const cfg = loadConfig({});
    await db.saveChatSettings({
      chatId: "chat-on",
      minLiquidityUsd: 0, minVolume24hUsd: 0, minMarketCapUsd: 0,
      maxMarketCapUsd: 10_000_000, minAgeMinutes: 0, maxAgeMinutes: 100_000,
      min5mVolUsd: 0, min1hVolUsd: 0, min5mChgPct: 0, min1hChgPct: 0,
      enabled: true,
    });
    const dex = new DexScreenerClient(cfg);
    let asked = null;
    dex.fetchPairsForTokens = async (addrs) => {
      asked = addrs.slice();
      return new Map();
    };
    const scanner = new Scanner(
      db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
      null, null, null, null, null, null, null,
    );
    // A coin deferred on an earlier tick, hydrated exactly as the worker does
    // it from the durable snapshot.
    scanner.seedDeferredTokens(["DEFERRED_COIN"]);
    stubFeed([{ chainId: "solana", tokenAddress: "FEEDCOIN", symbol: "F" }]);
    await scanner.runOnce();
    assert.ok(asked, "the tick reached its pair phase");
    assert.deepEqual(
      [...asked].sort(),
      ["DEFERRED_COIN", "FEEDCOIN"],
      "the feed's own coin AND the deferred one reach the pair phase on this tick",
    );
    // An empty feed is no longer left alone either: the deferred coin reaches
    // the pair phase on those ticks too. That is the fix — the `profiles 0`
    // ticks (429 backoff, a cold isolate's first fetch) were the ones whose
    // make-up chance was being thrown away, and they are exactly the ticks
    // where the backlog is most likely to sit. The outage stays visible in
    // feedMakeupView(): rawProfiles 0 + emptyFeedTotal.
    stubFeed([]);
    asked = null;
    const scanner2 = new Scanner(
      db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
      null, null, null, null, null, null, null,
    );
    scanner2.seedDeferredTokens(["DEFERRED_COIN"]);
    await scanner2.runOnce();
    assert.ok(
      (asked ?? []).includes("DEFERRED_COIN"),
      "an empty feed still pulls the deferred coin into the tick",
    );
  } finally {
    await client.close();
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort */
    }
    reg.recover("DEFERRED_COIN");
  }
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
  .then(tickMakeupTest)
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
