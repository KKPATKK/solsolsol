#!/usr/bin/env node
/**
 * Unit tests for the DexScreener boosts leg (docs/patches/dexscreener-boosts-leg.apply.js).
 *
 * What is worth pinning down here, and nothing else:
 *  - the dial is OFF by default, so a deploy that forgets the binding cannot
 *    turn a new upstream into a per-tick cost by accident;
 *  - the leg costs ZERO requests while disabled (a guard that returned [] only
 *    after fetching would still be a per-tick request);
 *  - the Solana filter and the limit are applied to the parsed rows;
 *  - a failure (429 / non-array body) is [], never a throw — the leg is
 *    optional, so it must not be able to fail a tick.
 */
const fs = require("node:fs");

const FILE = "scripts/test-unit.js";

const ANCHOR = '  await test("Scanner.abort publishes the in-flight summary so timeout rows carry diagnostics"';

const TESTS = `  await test("boosts dial: off by default, clamped to the 30-row upstream", () => {
    // The leg ships at DEXSCREENER_BOOSTS_LIMIT = "0" in wrangler.toml: the
    // tick races the scan against a ~5s window and the extra pair batch is
    // ~0.5s, so turning it on is a measurement, not a default.
    assert.equal(loadConfig({}).dexscreenerBoostsLimit, 0, "off when unset");
    assert.equal(loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "0" }).dexscreenerBoostsLimit, 0);
    assert.equal(loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "19" }).dexscreenerBoostsLimit, 19);
    // /token-boosts/latest/v1 answers 30 rows; anything above that is a typo,
    // not a request for more.
    assert.equal(loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "99" }).dexscreenerBoostsLimit, 30);
    assert.equal(loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "-5" }).dexscreenerBoostsLimit, 0);
    assert.equal(loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "abc" }).dexscreenerBoostsLimit, 0);
  });

  await test("fetchBoostedTokens: disabled dial makes no request at all", async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("[]", { status: 200 });
    };
    try {
      const dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }));
      assert.deepEqual(await dex.fetchBoostedTokens(0), []);
      assert.equal(calls, 0, "a disabled leg must not touch the wire");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("fetchBoostedTokens: Solana rows only, limited, failures are []", async () => {
    // Row shape measured 2026-09-25: 30 rows, 19 solana, no metrics and no
    // timestamps (the age comes from the pair the next batch fetches).
    const body = [
      { chainId: "solana", tokenAddress: "SOL1", totalAmount: 5000, amount: 100 },
      { chainId: "ethereum", tokenAddress: "ETH1" },
      { chainId: "base", tokenAddress: "BASE1" },
      { chainId: "solana", tokenAddress: "SOL2" },
      { chainId: "solana", tokenAddress: "" },
      { chainId: "solana", tokenAddress: "SOL3" },
    ];
    const origFetch = globalThis.fetch;
    let mode = "ok";
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (mode === "429") return new Response("rate limited", { status: 429 });
      if (mode === "junk") return new Response("not json", { status: 200 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }));
      const rows = await dex.fetchBoostedTokens(30);
      assert.deepEqual(
        rows.map((r) => r.tokenAddress),
        ["SOL1", "SOL2", "SOL3"],
        "other chains and blank addresses are dropped",
      );
      assert.equal(seen[0].includes("/token-boosts/latest/v1"), true, "the latest feed, not /top/");
      assert.equal(seen[0].includes("/token-boosts/top/"), false);

      // The limit is applied to the FILTERED list (3 Solana rows, limit 2).
      const capped = await dex.fetchBoostedTokens(2);
      assert.equal(capped.length, 2);

      // Optional leg: a 429 and a junk body are [], never a throw.
      mode = "429";
      assert.deepEqual(await dex.fetchBoostedTokens(30), [], "a 429 is []");
      mode = "junk";
      assert.deepEqual(await dex.fetchBoostedTokens(30), [], "a non-array body is []");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

`;

const text = fs.readFileSync(FILE, "utf8");
const hits = text.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.error(`${hits === 0 ? "MISS" : "AMBIGUOUS"} ${FILE}: boosts tests (${hits} hits)`);
  process.exit(1);
}
fs.writeFileSync(FILE, text.replace(ANCHOR, TESTS + ANCHOR));
console.log(`ok        ${FILE}: boosts dial + fetchBoostedTokens tests`);
