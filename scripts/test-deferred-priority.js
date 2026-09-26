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
const { DeferredPushLedger, slicePoolRotation } = require("../dist/scanner.js");
const { loadPushDeferralSnapshot, nextPushDeferralSnapshot } = require("../dist/deferrallog.js");
const {
  DexScreenerClient,
  PROFILE_FEED_SELF_BUDGET_MS,
} = require("../dist/dexscreener.js");
const {
  deferredPushTokens,
  hydrateDeferredTokens,
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
// …and it is only fit to stand in for the durable row once a tick has READ
// that row into it (see deferredPushTokens): the write path must be able to
// tell "nothing is owed" (an authoritative list, empty included) from "no
// list at all". The suite hydrates the way Scanner.seedDeferredTokens does.
hydrateDeferredTokens([], 0);
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
  // A fresh client per case: the profiles call is self-budgeted (it must answer
  // inside the tick's 600ms feed window), and the throttle's 250ms spacing
  // between two calls of the SAME client would eat that budget in a way the
  // scan never sees — the feed call is the first DexScreener request of a tick.
  const freshDex = () => new DexScreenerClient(loadConfig({}));
  reg.defer("PAID_LATE", 100);
  stub(feedBody);
  let dex = freshDex();
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
  dex = freshDex();
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
  dex = freshDex();
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

  // A FAILED fetch is a different outage from a feed that answers with
  // nothing, and it is the one that used to cost the backlog its lane. The
  // profiles call was made with no deadline, so a 429 spent ~6s in a 3-attempt
  // retry chain and the scanner's 600ms feed race threw the result away —
  // make-up list included. Live 2026-09-19: 9 of 40 ticks went `profiles 0`
  // with every feed empty, and the 429 stamps sit inside those very ticks.
  resetFeedMakeup();
  reg.recover("FEED_A");
  reg.defer("FEED_A", 102);
  let rateLimitCalls = 0;
  globalThis.fetch = async () => {
    rateLimitCalls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "Content-Type": "text/plain" },
    });
  };
  dex = freshDex();
  const t0 = Date.now();
  const out4 = await dex.fetchLatestSolanaProfiles();
  const elapsed = Date.now() - t0;
  assert.deepEqual(
    out4.map((p) => p.tokenAddress),
    ["FEED_A"],
    "a rate-limited feed still carries the make-up — the coin is evaluated instead of skipped",
  );
  assert.ok(
    elapsed < PROFILE_FEED_SELF_BUDGET_MS * 3,
    `the call answers inside its own budget (took ${elapsed}ms) — no 6s retry chain`,
  );
  const failView = feedMakeupView();
  assert.equal(failView.failedTotal, 1, "the outage is counted as a FAILED fetch");
  assert.equal(
    failView.emptyFeedTotal,
    0,
    "and NOT as an empty feed — 'never answered' and 'answered with nothing' are different outages",
  );
  assert.equal(failView.lastFailedAt !== null, true, "the failure is stamped");
  assert.equal(failView.lastRawProfiles, 0, "rawProfiles still reads 0 — the outage signal is intact");
  assert.equal(failView.lastInjected, 1, "the make-up is what filled the list");
  // ... and it gives the window BACK instead of burning it. The old chain slept
  // `left` (314ms of a 320ms budget), waited out the 250ms throttle and then
  // started an attempt whose own abort had already fired — measured live
  // 2026-09-19 18:11:11Z: the profiles call held the tick until +674ms, the
  // feed fan-out was dispatched with 226ms left, `fetchFeedCapped`'s 250ms
  // floor short-circuited EVERY fan-out feed and Jupiter came back 0 for that
  // minute. A budgeted caller never retries a 429 now (the client has just
  // armed a 90s backoff, so no second attempt can win).
  assert.ok(
    elapsed < 150,
    `a 429 answers immediately so the fan-out keeps its window (took ${elapsed}ms)`,
  );
  assert.equal(rateLimitCalls, 1, "no doomed second request is sent");

  // A 5xx is NOT a 429 — it keeps its retry while the budget can hold one, so
  // fail-fast does not quietly delete the retry path for transient outages.
  // (The profiles budget cannot hold one either: PROFILE_FEED_SELF_BUDGET_MS
  // 480 is still below the throttle gap + attempt floor, 250 + 250, so a 5xx
  // on the profiles call also fails fast — the pair path, with its 1000ms
  // budget, is where the retry still fits.)
  let serverErrorCalls = 0;
  globalThis.fetch = async () => {
    serverErrorCalls += 1;
    return new Response("boom", { status: 500 });
  };
  dex = freshDex();
  const emptyPairs = await dex.fetchPairsForTokens(["PAIRTOKEN"], Date.now() + 2_000);
  assert.ok(
    serverErrorCalls >= 2,
    `a 5xx still retries when the budget can hold it (saw ${serverErrorCalls} request(s))`,
  );
  assert.equal(emptyPairs.size, 0, "a failing endpoint contributes no pair data");

  // ---------- the caller's deadline is measured AT DISPATCH ----------------
  // A bounded call used to compute its abort window BEFORE the shared throttle
  // queue, so an attempt could be issued with a window that had already
  // expired (or a 1ms one): a doomed request that ALSO ran the caller past the
  // budget it was given. Live shape: the profiles feed read `raw 0` tick after
  // tick with the make-up lane filling the list — the fetch was being aborted,
  // not refused. The wait is now paid out of the same window, so a spent
  // budget ends the attempt instead of sending it.
  let deadlineFetchCalls = 0;
  globalThis.fetch = async () => {
    deadlineFetchCalls += 1;
    return new Response(JSON.stringify({ pairs: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const slowDex = new DexScreenerClient(
    loadConfig({ DEX_REQUEST_INTERVAL_MS: "400" }),
  );
  // Warm the throttle: this call owns the wire for the next `interval` ms.
  await slowDex.fetchPairsForTokens(["WARM"], Date.now() + 5_000);
  const warmCalls = deadlineFetchCalls;
  assert.ok(warmCalls >= 1, "the warm-up call owns the throttle");
  // A 60ms budget cannot survive the 400ms spacing. Charged for the wait, the
  // attempt is dropped; before the fix it queued a request with a 1ms abort.
  const spent = await slowDex.fetchPairsForTokens(["SPENT"], Date.now() + 60);
  assert.equal(spent.size, 0, "a spent budget yields no pairs");
  assert.equal(
    deadlineFetchCalls,
    warmCalls,
    "no doomed request is issued once the wait has eaten the caller's window",
  );

  // A deterministic client error (404/HTML) is the same story.
  resetFeedMakeup();
  globalThis.fetch = async () =>
    new Response("<html>nope</html>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  dex = freshDex();
  const out5 = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    out5.map((p) => p.tokenAddress),
    ["FEED_A"],
    "a 404 feed still carries the make-up",
  );
  const bodyView = feedMakeupView();
  assert.equal(bodyView.failedTotal, 1, "a body that is not the profile array is a failed feed");
  assert.equal(bodyView.emptyFeedTotal, 0);
  assert.equal(bodyView.lastRawProfiles, 0);
  reg.recover("FEED_A");

  // A fetch that NEVER answers — the completely hung upstream (no 429, no 5xx,
  // no body). The retry-chain fix alone could not reach this one: the call's
  // abort floor was 1000ms, LONGER than the 600ms feed window the tick hands
  // it, so the scanner's race kept its own `[]` and the make-up list — built
  // after the fetch settles — went with it (`profiles 0`, no make-up). Now
  // attempt 1 is clamped to the feed's own budget, so the call abandons the
  // fetch itself, inside the window, and the make-up still rides the list.
  resetFeedMakeup();
  reg.recover("FEED_A");
  reg.defer("FEED_A", 103);
  // A hung fetch that settles only when its AbortSignal fires, which is what
  // an unresponsive upstream looks like from inside the client.
  globalThis.fetch = (_url, opts = {}) =>
    new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (!signal) return; // no signal: hang forever, like the old bug
      if (signal.aborted) return reject(new Error("The operation was aborted"));
      signal.addEventListener("abort", () =>
        reject(new Error("The operation was aborted")),
      );
    });
  dex = freshDex();
  // The ONLY pending work during this call is the client's own AbortSignal
  // timer, and Node's timers from AbortSignal.timeout() are UNREF'd — so
  // without something holding the event loop open the process would just exit
  // (code 0, no output) instead of waiting for the abort. Every earlier case
  // here answers immediately and never needs this; a hung upstream is the
  // first case that only ever settles on a timer.
  const keepAlive = setTimeout(() => {}, PROFILE_FEED_SELF_BUDGET_MS * 6);
  const hungAt = Date.now();
  const out6 = await dex.fetchLatestSolanaProfiles();
  const hungElapsed = Date.now() - hungAt;
  clearTimeout(keepAlive);
  assert.deepEqual(
    out6.map((p) => p.tokenAddress),
    ["FEED_A"],
    "a hung upstream still carries the make-up — the tick evaluates the coin instead of going dark",
  );
  assert.ok(
    hungElapsed < PROFILE_FEED_SELF_BUDGET_MS * 2,
    `the hang is abandoned inside the feed budget, not by the caller's race (took ${hungElapsed}ms)`,
  );
  const hungView = feedMakeupView();
  assert.equal(hungView.failedTotal, 1, "a hang is a FAILED fetch");
  assert.equal(hungView.emptyFeedTotal, 0, "and not an empty feed");
  assert.equal(hungView.lastRawProfiles, 0, "rawProfiles reads 0 — the outage signal is intact");
  assert.equal(hungView.lastInjected, 1, "the make-up is what filled the list");
  assert.equal(hungView.feedRequests, 1);
  reg.recover("FEED_A");

  // ---------- last-good reuse: a 429 stops costing the tick its coins ------ 
  // Measured live 2026-09-19: DexScreener 429s this endpoint once per ~5 minutes
  // on the shared egress (18/18 ticks at minute%5==1 read `lastRawProfiles 0`
  // with `http429` +1 inside the tick), so one tick in five evaluated only the
  // make-up list. More self-budget cannot help — a 429 answers in ~350ms — the
  // scarce resource is the LIST, so the previous one is evaluated again.
  const { shouldReuseProfileList, PROFILE_FEED_REUSE_MS } = require("../dist/dexscreener.js");
  const refNow = 1_800_000_000_000;
  assert.equal(
    shouldReuseProfileList(0, true, refNow, refNow, PROFILE_FEED_REUSE_MS),
    true,
    "a failed fetch reuses a fresh list",
  );
  assert.equal(
    shouldReuseProfileList(20, false, refNow, refNow, PROFILE_FEED_REUSE_MS),
    false,
    "a non-empty live fetch always wins",
  );
  assert.equal(
    shouldReuseProfileList(0, false, refNow, refNow, PROFILE_FEED_REUSE_MS),
    true,
    "an empty answer reuses it too — evaluating nothing helps nobody",
  );
  assert.equal(
    shouldReuseProfileList(0, true, refNow - PROFILE_FEED_REUSE_MS - 1, refNow, PROFILE_FEED_REUSE_MS),
    false,
    "a list older than the window is never resurrected — a dead feed must show up",
  );
  assert.equal(
    shouldReuseProfileList(0, true, null, refNow, PROFILE_FEED_REUSE_MS),
    false,
    "nothing cached (fresh isolate), nothing to reuse",
  );
  assert.equal(
    shouldReuseProfileList(0, false, refNow + 5_000, refNow, PROFILE_FEED_REUSE_MS),
    false,
    "a clock that moved backwards is not a fresh cache",
  );

  // The real client path: one successful tick, then the rate-limited one.
  resetFeedMakeup();
  reg.recover("FEED_A");
  stub(feedBody);
  dex = freshDex();
  const live = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    live.map((p) => p.tokenAddress),
    ["FEED_A"],
    "the first fetch is the live list",
  );
  resetFeedMakeup();
  globalThis.fetch = async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "Content-Type": "text/plain" },
    });
  const reused = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    reused.map((p) => p.tokenAddress),
    ["FEED_A"],
    "the rate-limited tick evaluates the last good list instead of nothing",
  );
  const reuseView = feedMakeupView();
  assert.equal(reuseView.lastRawProfiles, 0, "the outage is STILL reported as 0 raw profiles");
  assert.equal(reuseView.failedTotal, 1, "and still counted as a failed fetch");
  assert.equal(reuseView.lastFailedAt !== null, true, "and still stamped");
  assert.equal(
    reuseView.injectedTotal,
    0,
    "nothing was deferred, so the reused list needs no make-up",
  );
  assert.equal(reuseView.feedRequests, 1, "one feed request per tick, however it resolves");

  // A brand-new client has no cached list, so it degrades to the old behaviour
  // (make-up only) rather than inventing one.
  resetFeedMakeup();
  reg.defer("FEED_A", 104);
  dex = freshDex();
  const cold = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(
    cold.map((p) => p.tokenAddress),
    ["FEED_A"],
    "a cold isolate still falls back to the make-up alone",
  );
  assert.equal(feedMakeupView().lastRawProfiles, 0);
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
    // And the live case (23% of ticks): the feed never answers at all. The
    // deferred coin is still in the evaluated set, so the make-up lane is no
    // longer lost exactly when the tick is otherwise blind.
    globalThis.fetch = async () =>
      new Response("rate limited", { status: 429, headers: { "Content-Type": "text/plain" } });
    asked = null;
    const scanner3 = new Scanner(
      db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
      null, null, null, null, null, null, null,
    );
    scanner3.seedDeferredTokens(["DEFERRED_COIN"]);
    await scanner3.runOnce();
    assert.ok(
      (asked ?? []).includes("DEFERRED_COIN"),
      "a rate-limited feed still pulls the deferred coin into the tick",
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

// ---------- the scan-side subrequest floor (see SCAN_SUBREQ_FLOOR) --------
// The invocation's 50 subrequests are SHARED, and the tracker pass runs LAST:
// it carries its own reserve but it cannot claw back what the scan already
// spent (live 2026-09-25: a cron tick's window read `total 32 | turso 29`).
// The scan is the only phase with optional work, so this drives a real tick
// twice — room, then at the floor — and asserts WHICH legs were asked.
async function subreqFloorTest() {
  const { Db } = require("../dist/db.js");
  const { Scanner, SCAN_SUBREQ_FLOOR, CHAIN_SUBREQ_FLOOR } = require("../dist/scanner.js");
  const { createClient } = require("@libsql/client");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const p = path.join(os.tmpdir(), `subreq-floor-${process.pid}-${Date.now()}.db`);
  const client = createClient({ url: `file:${p}` });
  const stubFeed = (body) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  };
  try {
    assert.equal(
      SCAN_SUBREQ_FLOOR,
      12,
      "the floor is the tail's arithmetic as one movable constant (pass reserve 6 + grouped telemetry + flush + drain slice)",
    );
    const db = new Db(p, undefined, client);
    await db.init();
    // Every OPTIONAL leg armed (the live worker sets the same vars in
    // wrangler.toml), and the pump.fun fallback off so the launch chain is
    // exactly gecko → meteora in this test.
    const cfg = loadConfig({
      METEORA_FALLBACK_LIMIT: "20",
      GECKOTERMINAL_TRENDING_LIMIT: "20",
      JUPITER_TRENDING_LIMIT: "100",
      PUMPFUN_PROFILE_LIMIT: "0",
      PUMPFUN_FALLBACK_LIMIT: "0",
    });
    await db.saveChatSettings({
      chatId: "chat-floor",
      minLiquidityUsd: 0, minVolume24hUsd: 0, minMarketCapUsd: 0,
      maxMarketCapUsd: 10_000_000, minAgeMinutes: 0, maxAgeMinutes: 100_000,
      min5mVolUsd: 0, min1hVolUsd: 0, min5mChgPct: 0, min1hChgPct: 0,
      enabled: true,
    });
    const dex = new DexScreenerClient(cfg);
    dex.fetchPairsForTokens = async () => new Map();
    // The tick driver: fresh fakes per tick, so the asked-legs list cannot
    // leak between the two runs.
    const runTick = async (probe) => {
      const asked = [];
      const gecko = {
        fetchNewPools: async () => { asked.push("geo"); return []; },
        fetchTrendingPools: async () => { asked.push("geoTrend"); return []; },
      };
      const jupiter = {
        fetchRecentTokens: async () => { asked.push("jup"); return []; },
        fetchTrendingTokens: async () => { asked.push("jupTrend"); return []; },
      };
      const meteora = {
        fetchNewestPools: async () => { asked.push("meteora"); return []; },
      };
      const crimeWallets = {
        refreshIfStale: async () => { asked.push("crime-refresh"); },
      };
      const scanner = new Scanner(
        db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
        null, null, null, null, null,
        gecko, jupiter, null, null, null, crimeWallets, null, null, meteora,
      );
      await scanner.runOnce(probe);
      return { scanner, asked: [...new Set(asked)].sort() };
    };

    // ROOM: every optional leg is asked, exactly as before this change.
    stubFeed([{ chainId: "solana", tokenAddress: "FLOOR_ROOM", symbol: "R" }]);
    const room = await runTick(() => 30);
    assert.deepEqual(
      room.asked,
      ["crime-refresh", "geo", "geoTrend", "jup", "jupTrend", "meteora"],
      "with room, every optional leg still runs",
    );
    assert.equal(room.scanner.lastSummary.subreqFloor, undefined, "and the summary claims no floor it did not apply");
    assert.equal(room.scanner.lastSummary.subreqSkip, undefined);

    // THE FLOOR: the optional legs yield, the PRIMARY feeds do not.
    stubFeed([{ chainId: "solana", tokenAddress: "FLOOR_LOW", symbol: "L" }]);
    const low = await runTick(() => SCAN_SUBREQ_FLOOR - 8);
    assert.deepEqual(
      low.asked,
      ["geo", "jup"],
      "the floor yields the optional legs and nothing else — DexScreener profiles, gecko new_pools and Jupiter recent launches still run",
    );
    assert.equal(low.scanner.lastSummary.subreqFloor, SCAN_SUBREQ_FLOOR);
    assert.deepEqual(
      low.scanner.lastSummary.subreqSkip.slice().sort(),
      ["crime-refresh", "geoTrend", "jupTrend", "meteora"],
      "and every dropped leg is NAMED, so a quiet momentum feed cannot be read as an upstream outage",
    );

    // NO PROBE = no floor: a scanner driven without the worker (every test
    // that predates this, and the local runner) owns no invocation window and
    // must behave exactly as it did before.
    stubFeed([]);
    const unbounded = await runTick(undefined);
    assert.ok(unbounded.asked.includes("meteora"), "an unbounded caller drops nothing at all");
    assert.equal(unbounded.scanner.lastSummary.subreqFloor, undefined);

    // ---------- the CANDIDATE CHAIN's own fence (CHAIN_SUBREQ_FLOOR) --------
    // Live 2026-09-25: 15 of 32 dead ticks had the phase ladder frozen at
    // `gate` — the chain's entrance — with a LOW count (10-30 of the usable
    // 38), i.e. the chain spent the tail on upstream work and the runtime
    // refused the completion batch behind it. The chain is the only unfenced
    // spend in the scan (the optional front legs stand down at
    // SCAN_SUBREQ_FLOOR, the tracker pass carries its own reserve), so this
    // drives a real candidate through it twice: fenced, then with room.
    assert.equal(
      CHAIN_SUBREQ_FLOOR,
      3,
      "the chain's floor is the completion flush's whole retry ladder (attempt + racing retry + backoff retry)",
    );
    const coinPair = {
      chainId: "solana",
      url: "https://dexscreener.com/solana/CHAINPAIR",
      pairAddress: "CHAINPAIR",
      baseToken: { address: "CHAIN_COIN", name: "Chain Coin", symbol: "CHAIN" },
      priceUsd: "0.001",
      marketCap: 100_000,
      volume: { h24: 500_000, h1: 60_000, m5: 9_000 },
      priceChange: { m5: 40, h1: 60 },
      txns: { m5Buys: 80, m5Sells: 60, h1Buys: 900, h1Sells: 700 },
      liquidity: { usd: 20_000 },
      pairCreatedAt: Date.now() - 60 * 60_000,
    };
    dex.fetchPairsForTokens = async () => new Map([["CHAIN_COIN", coinPair]]);
    const chainFeed = [{ chainId: "solana", tokenAddress: "CHAIN_COIN", symbol: "CHAIN" }];

    // FENCED FIRST (nothing is pushed, so the room run below starts clean):
    // one subrequest below the flush's ladder, a real candidate in hand — the
    // chain defers the COIN instead of spending the completion write.
    stubFeed(chainFeed);
    const chainLow = await runTick(() => CHAIN_SUBREQ_FLOOR);
    const lowSummary = chainLow.scanner.lastSummary;
    assert.equal(lowSummary.chainFloor, CHAIN_SUBREQ_FLOOR, "the fence names the allowance it refused to spend");
    assert.ok(lowSummary.subreqSkip.includes("chain"), "and the summary points at the CHAIN, not at a quiet feed");
    assert.equal(lowSummary.chainDeferred, 1, "the coin it refused to start is counted");
    assert.equal(lowSummary.candidates, 1, "...and it WAS a candidate — the fence only ever fires on real work");
    assert.equal(lowSummary.pushed, 0, "nothing was sent, so nothing can be lost: the re-eval pool re-offers it");

    // ROOM: the same coin, the same tick, and the chain runs it end to end.
    stubFeed(chainFeed);
    const chainRoom = await runTick(() => 30);
    const roomSummary = chainRoom.scanner.lastSummary;
    assert.equal(roomSummary.chainFloor, undefined, "with room the fence claims nothing");
    assert.ok(
      !(roomSummary.subreqSkip ?? []).includes("chain"),
      "and the chain is never named as skipped when it ran",
    );
    assert.equal(roomSummary.chainDeferred, undefined, "no candidate was deferred");
    assert.equal(roomSummary.candidates, 1, "the candidate still reached the chain");
    dex.fetchPairsForTokens = async () => new Map();
  } finally {
    await client.close();
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
}

// ---------- the list feeds ride the colo edge cache (LIST_FEED_CACHE_TTL_S) --
// The profiles lane is the tick's biggest discovery lane and it came back EMPTY
// on 133 of 464 live ticks (27%). The cause is not this client's arithmetic:
// the endpoint is rate-limited per SOURCE IP and a Worker's egress IP is shared
// fleet-wide, so our one request per tick is what strangers' traffic 429s (the
// durable ring measured 17 429s/hour — one per tick-failure). What this client
// CAN decide is whether the request reaches the origin at all, which is what
// the GeckoTerminal leg has done since 2026-09-21. These cases pin both halves:
// the two LIST feeds are asked through the cache, the pair batch never is, and
// an attempt the throttle queue holds past the caller's window is COUNTED as a
// drop rather than read as an upstream refusal.
async function dexListCacheTest() {
  const {
    DexScreenerClient,
    LIST_FEED_CACHE_TTL_S,
    PROFILE_FEED_SELF_BUDGET_MS,
  } = require("../dist/dexscreener.js");
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });
  assert.equal(
    LIST_FEED_CACHE_TTL_S,
    60,
    "the list TTL is one tick's cadence — a HIT is always fresher than the 10-minute reuse lane it backstops",
  );

  // (a) The profiles list asks THROUGH the edge cache, and a HIT is published.
  let init = null;
  globalThis.fetch = async (_url, opts = {}) => {
    init = opts;
    return json([{ chainId: "solana", tokenAddress: "EDGE_A" }], {
      "cf-cache-status": "HIT",
    });
  };
  let dex = new DexScreenerClient(loadConfig({}));
  const out = await dex.fetchLatestSolanaProfiles();
  assert.deepEqual(out.map((p) => p.tokenAddress), ["EDGE_A"]);
  assert.equal(init.cf && init.cf.cacheEverything, true, "the profiles list is asked through the colo cache");
  assert.equal(init.cf.cacheTtl, LIST_FEED_CACHE_TTL_S);
  assert.deepEqual(
    init.cf.cacheTtlByStatus,
    { "200-299": LIST_FEED_CACHE_TTL_S, "300-399": 0, "400-599": 0 },
    "a 429/5xx is kept OUT of the cache — a refused minute can never be served to the next tick as a fresh feed",
  );
  const hitStats = dex.getStats();
  assert.equal(hitStats.listCacheHits, 1, "the HIT is counted — this is the reading that proves the fix worked");
  assert.equal(hitStats.lastListCacheStatus, "HIT");
  assert.equal(hitStats.budgetDrops, 0, "and a dispatched attempt is never counted as a drop");

  // (b) The boosts list rides the same cache (same host, same bucket).
  init = null;
  dex = new DexScreenerClient(loadConfig({}));
  await dex.fetchBoostedTokens(20);
  assert.equal(init.cf && init.cf.cacheEverything, true, "the boosts list rides the same cache");

  // (c) The PAIR batch must NOT be cached: those are the metrics the gates and
  // the tracker judge (5m volume/change, liquidity), keyed by this tick's
  // address set, and the client already has its own pair cache for them.
  let pairInit = null;
  globalThis.fetch = async (_url, opts = {}) => {
    pairInit = opts;
    return json({ pairs: [] });
  };
  dex = new DexScreenerClient(loadConfig({}));
  await dex.fetchPairsForTokens(["EDGE_A"]);
  assert.equal(pairInit.cf, undefined, "the pair batch is never edge-cached");

  // (d) A dropped attempt is its own reading. The throttle gap is set wider
  // than the profiles self-budget, which is exactly the live shape the counters
  // could not name before: the request is never dispatched, so nothing arrives
  // and the tick reads `raw 0` with `http429` flat — "never asked" and
  // "refused" looked identical.
  globalThis.fetch = async () => json([{ chainId: "solana", tokenAddress: "EDGE_B" }]);
  dex = new DexScreenerClient(
    loadConfig({ DEX_REQUEST_INTERVAL_MS: String(PROFILE_FEED_SELF_BUDGET_MS * 2) }),
  );
  await dex.fetchLatestSolanaProfiles();
  const second = await dex.fetchLatestSolanaProfiles();
  const dropStats = dex.getStats();
  assert.equal(
    dropStats.budgetDrops,
    1,
    "an attempt the throttle queue holds past the caller's window is a DROP, counted apart from a 429",
  );
  assert.ok(dropStats.lastDroppedAt !== null, "and it is stamped");
  assert.equal(dropStats.http429, 0, "no 429 was ever seen — the two outages are not the same outage");
  assert.deepEqual(
    second.map((p) => p.tokenAddress),
    ["EDGE_B"],
    "a dropped fetch still evaluates the list the tick already had (the reuse lane), never nothing",
  );
  // ...and the LEG that wanted it is named. The total alone could not be acted
  // on: the profiles list is the tick's biggest discovery lane, the boosts list
  // is optional by construction and the pair batches are a rotation whose
  // leftovers stay in the pool — three legs, three different fixes.
  assert.deepEqual(
    dropStats.dropsByLeg,
    { profiles: 1, boosts: 0, pairs: 0, other: 0 },
    "every leg has a number, zero included: 'never dropped' must not read like 'never ran'",
  );
  assert.equal(dropStats.lastDropLeg, "profiles", "and the newest drop names its leg");
  const { dexFeedLeg } = require("../dist/dexscreener.js");
  assert.equal(dexFeedLeg("/token-profiles/latest/v1"), "profiles");
  assert.equal(dexFeedLeg("/token-boosts/latest/v1"), "boosts");
  assert.equal(dexFeedLeg("/latest/dex/tokens/A,B"), "pairs");
  assert.equal(dexFeedLeg("/something/else"), "other");

  // ---------- a dropped attempt costs NO dispatch slot ----------------------
  // The throttle's chain is global across callers and spaces request STARTS
  // `intervalMs` apart, so an attempt that can never be answered used to take a
  // full gap from the legs behind it — which is how one drop became two (live
  // 2026-09-26: 2-3 drops per tick, request never sent). This drives the exact
  // shape with numbers instead of a stopwatch: gap 700ms against the list
  // feeds' own 480ms budget, so the SECOND profiles call can only be dropped,
  // then a THIRD call is issued late enough that it fits the NEXT free slot
  // (t0+700) but not the phantom one (t0+1400) the drop used to consume.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return json([{ chainId: "solana", tokenAddress: "EDGE_D" }]);
  };
  dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "700" }));
  await dex.fetchLatestSolanaProfiles(); // #1 takes the only slot (t0)
  await dex.fetchLatestSolanaProfiles(); // #2: next slot t0+700 > t0+480 → DROPPED
  await sleep(400); // ...and its phantom slot is now in the past either way
  const boosted = await dex.fetchBoostedTokens(20); // #3: deadline ~t0+880
  const slotStats = dex.getStats();
  assert.equal(slotStats.budgetDrops, 1, "only the attempt with no window left is a drop");
  assert.deepEqual(
    slotStats.dropsByLeg,
    { profiles: 1, boosts: 0, pairs: 0, other: 0 },
    "the request AFTER the drop still fit — the drop never took the boosts leg's slot",
  );
  assert.deepEqual(boosted.map((p) => p.tokenAddress), ["EDGE_D"], "and it was answered");
  assert.deepEqual(
    urls.map((u) => (u.includes("token-profiles") ? "profiles" : u.includes("token-boosts") ? "boosts" : u)),
    ["profiles", "boosts"],
    "exactly two requests reached the network: the dropped attempt was never sent",
  );

  // ---------- the PAIR phase stops at the window, not at a drop -------------
  // Its tail batches used to be enqueued only for the queue to hold them past
  // PAIRS_FETCH_BUDGET_MS: each consumed a 250ms slot (delaying the legs behind
  // it) and then answered nothing. A batch that cannot START is pure latency —
  // skipped tokens keep their pool slot and are re-read on the next rotation —
  // so the phase ends instead, and the drop counter stays reserved for a
  // request a leg genuinely wanted.
  globalThis.fetch = async () => json({ pairs: [] });
  dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "700" }));
  const addresses = Array.from({ length: 90 }, (_, i) => `PAIR_${i}`);
  await dex.fetchPairsForTokens(addresses);
  const pairStats = dex.getStats();
  assert.equal(
    pairStats.budgetDrops,
    0,
    "a batch the phase's window cannot hold is not attempted at all — never counted as a drop",
  );
  assert.deepEqual(
    pairStats.dropsByLeg,
    { profiles: 0, boosts: 0, pairs: 0, other: 0 },
    "...so no leg is blamed for it",
  );
  assert.equal(pairStats.cacheSize, 0, "the stub answered an empty pair list");
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
  .then(subreqFloorTest)
  .then(dexListCacheTest)
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
