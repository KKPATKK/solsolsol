// Verify-then-write: test for the owed coin's reserved reject slot.
const fs = require("fs");

const FILE = "scripts/test-unit.js";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

const anchor =
  `  await test("Scanner.runTrackerPass: the tick tail's pass publishes its note on the last summary", async () => {`;

const body = `  await test("Scanner: an owed coin's blocking gate survives the reject-log budget", async () => {
    // WHY (2026-09-27): one deferred obligation sat pending for 95 minutes with
    // every counter healthy — \`deferObserved 1\` on every tick, no prune, and
    // \`seen_tokens\`/\`push_audit\` empty (never claimed, never delivered) — and
    // the ONE reading that could name the refusing gate was missing, because the
    // make-up lane appends owed coins to the END of the feed list and the
    // bounded reject log fills up before them. The log now reserves them a share
    // and marks the entry, so this test pins both halves: the debt LOGS, and the
    // feed coin the budget cuts stays out.
    const { Scanner } = require("../dist/scanner.js");
    const { DexScreenerClient } = require("../dist/dexscreener.js");
    const {
      addDeferredToken,
      DEFERRED_MAKEUP_MAX,
      isDeferredToken,
      resetDeferredRegistry,
    } = require("../dist/deferredmakeup.js");
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      // One chat that refuses EVERY coin on market cap, so the reason string
      // cannot be what tells the entries apart — the budget is.
      await db.saveChatSettings({
        chatId: "chat-owed",
        minLiquidityUsd: 0,
        minVolume24hUsd: 0,
        minMarketCapUsd: 10_000_000,
        maxMarketCapUsd: 1_000_000_000,
        minAgeMinutes: 0,
        maxAgeMinutes: 100_000,
        min5mVolUsd: 0,
        min1hVolUsd: 0,
        min5mChgPct: 0,
        min1hChgPct: 0,
        enabled: true,
      });
      const dex = new DexScreenerClient(cfg);
      const FEED = 30;
      const feed = [];
      for (let i = 0; i < FEED; i++) feed.push({ tokenAddress: \`FEED\${i}\` });
      // The make-up lane's coin rides the TAIL — the exact position the budget
      // cut, which is why the live debt read as "not rejected at all".
      feed.push({ tokenAddress: "OWEDCOIN" });
      dex.fetchLatestSolanaProfiles = async () => feed.slice();
      dex.fetchPairsForTokens = async (addrs) =>
        new Map(
          addrs.map((a) => [
            a,
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: \`pair-\${a}\`,
              baseToken: { address: a, symbol: a === "OWEDCOIN" ? "OWED" : a },
              quoteToken: {
                address: "So11111111111111111111111111111111111111112",
                symbol: "SOL",
              },
              priceUsd: "0.001",
              marketCap: 1000,
              liquidity: { usd: 5000 },
              volume: { m5: 0, h1: 0, h24: 0 },
              priceChange: { m5: 0, h1: 0, h24: 0 },
              pairCreatedAt: Date.now() - 3_600_000,
            },
          ]),
        );
      resetDeferredRegistry();
      addDeferredToken("OWEDCOIN", Date.now());
      assert.ok(isDeferredToken("OWEDCOIN"), "the obligation is registered");
      const scanner = new Scanner(
        db, { api: { sendMessage: async () => ({}) } }, dex, cfg, null, null, null,
      );
      scanner.pushWatcher = {
        headTokens: () => [],
        runTick: async () => ({ checked: 0, alerted: 0, trips: 0 }),
        onPush: async () => {},
      };
      await scanner.runOnce();
      const rejects = scanner.lastSummary?.rejects ?? [];
      assert.ok(rejects.length > 0, "the tick logged rejections");
      assert.ok(rejects.length <= 20, "the log stays bounded (REJECT_LOG_MAX)");
      const owed = rejects.filter((r) => r.owed === true);
      assert.equal(owed.length, 1, "the owed coin's rejection is in the log");
      assert.equal(owed[0].symbol, "OWED", "the entry names the debt");
      assert.match(owed[0].reason, /市值/, "and the gate refusing it");
      // The reserve is what bought that slot — the log is not simply bigger.
      assert.ok(
        !rejects.some((r) => r.symbol === \`FEED\${FEED - 1}\`),
        "the feed coin past the budget is still cut",
      );
      // The reserve can never exceed what the make-up lane can inject.
      assert.ok(
        DEFERRED_MAKEUP_MAX <= 20,
        "the lane's cap is the bound the reserve is clamped to",
      );
    } finally {
      resetDeferredRegistry();
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

`;

patch("Scanner owed-reject test", anchor, body + anchor);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
