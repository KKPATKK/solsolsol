/*
 * The Dex pair lane's SECOND EGRESS (2026-11-03).
 *
 * WHY THIS FILE EXISTS: the fallback runs only on the path that was hardest to
 * test before — a 429 mid-rotation — and its failure mode is quiet (the tick
 * simply keeps its old behaviour). So the things that could silently go wrong
 * are asserted here instead of watched for live:
 *
 *   1. The relay object's target allowlist. It fetches a URL handed to it in a
 *      header, so the allowlist IS the security boundary: exactly
 *      https://api.dexscreener.com, nothing else, no credentials.
 *   2. A relayed 2xx is SERVED: the pair lands, `relayServed` moves, and — the
 *      point of the whole change — the 90s block is NOT armed, so the next
 *      batch is not discouraged.
 *   3. A relay that fails changes NOTHING: the 429 branch arms the block and
 *      the caller sees the pre-2026-11-03 shape.
 *   4. No headroom = no attempt: a caller whose window is nearly spent must
 *      not pay a DO hop for an answer it cannot use.
 *   5. A caller with no hook (the Node container, old deployments) never
 *      reaches the relay at all.
 *
 * Run: node scripts/test-dex-egress-relay.js   (after `npm run build`)
 */
const assert = require("node:assert/strict");

const { loadConfig } = require("../dist/config.js");
const { DexScreenerClient } = require("../dist/dexscreener.js");
const {
  DexEgressRelay,
  dexEgressTarget,
  dexEgressTimeoutMs,
  DEX_EGRESS_MAX_TIMEOUT_MS,
  DEX_EGRESS_MIN_TIMEOUT_MS,
} = require("../dist/dexegress.js");

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

const PAIR_BODY = {
  pairs: [
    {
      chainId: "solana",
      pairAddress: "POOL_RELAY",
      baseToken: { address: "MINT_RELAY", name: "Relay", symbol: "RLY" },
      priceUsd: "0.01",
      marketCap: 120_000,
      liquidity: { usd: 40_000 },
    },
  ],
};

const okBody = (body = PAIR_BODY) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const refused = () =>
  new Response(JSON.stringify({ error: "rate limited" }), {
    status: 429,
    headers: { "retry-after": "40" },
  });

/** A client with the relay hook the worker builds, plus a call log. */
function relayedClient(hook) {
  const cfg = loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" });
  const calls = [];
  const dex = new DexScreenerClient(cfg, {
    relayPairBatch: async (url, timeoutMs, signal) => {
      calls.push({ url, timeoutMs, hasSignal: signal instanceof AbortSignal });
      return hook(url, timeoutMs);
    },
  });
  return { dex, calls };
}

async function main() {
  console.log("\nDex egress relay (second egress for refused pair batches)\n");

  await test("the relay object fetches ONLY https://api.dexscreener.com", async () => {
    assert.equal(
      dexEgressTarget("https://api.dexscreener.com/latest/dex/tokens/A,B"),
      "https://api.dexscreener.com/latest/dex/tokens/A,B",
    );
    for (const bad of [
      null,
      "",
      "http://api.dexscreener.com/latest/dex/tokens/A",
      "https://evil.example/latest/dex/tokens/A",
      "https://api.dexscreener.com.evil.example/x",
      "https://user:pw@api.dexscreener.com/x",
      "file:///etc/passwd",
    ]) {
      assert.equal(dexEgressTarget(bad), null, `rejected: ${bad}`);
    }
  });

  await test("the relay timeout is clamped, never absent", async () => {
    assert.equal(dexEgressTimeoutMs("900"), 900);
    assert.equal(dexEgressTimeoutMs("10"), DEX_EGRESS_MIN_TIMEOUT_MS);
    assert.equal(dexEgressTimeoutMs("999999"), DEX_EGRESS_MAX_TIMEOUT_MS);
    assert.equal(dexEgressTimeoutMs(null), DEX_EGRESS_MAX_TIMEOUT_MS);
    assert.equal(dexEgressTimeoutMs("junk"), DEX_EGRESS_MAX_TIMEOUT_MS);
  });

  await test("the object passes a 2xx body through and validates its target", async () => {
    const origFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url) => {
      seen = String(url);
      return okBody();
    };
    try {
      const relay = new DexEgressRelay();
      const ok = await relay.fetch(
        new Request("https://dex-egress/fetch", {
          headers: { "x-dex-url": "https://api.dexscreener.com/latest/dex/tokens/A" },
        }),
      );
      assert.equal(ok.status, 200);
      assert.equal(seen, "https://api.dexscreener.com/latest/dex/tokens/A");
      assert.equal((await ok.json()).pairs[0].pairAddress, "POOL_RELAY");

      const bad = await relay.fetch(
        new Request("https://dex-egress/fetch", {
          headers: { "x-dex-url": "https://evil.example/x" },
        }),
      );
      assert.equal(bad.status, 400, "a foreign host is refused without a fetch");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("a relayed 2xx serves the batch and does NOT arm the block", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => refused();
    try {
      const { dex, calls } = relayedClient(async () => ({ response: okBody(), arm: "weur" }));
      const pairs = await dex.fetchPairsForTokens(["MINT_RELAY"], Date.now() + 1_500);
      assert.equal(pairs.get("MINT_RELAY")?.pairAddress, "POOL_RELAY");
      assert.equal(calls.length, 1, "one relay attempt");
      assert.equal(calls[0].url, "https://api.dexscreener.com/latest/dex/tokens/MINT_RELAY");
      assert.ok(calls[0].timeoutMs >= DEX_EGRESS_MIN_TIMEOUT_MS);
      assert.ok(calls[0].timeoutMs <= DEX_EGRESS_MAX_TIMEOUT_MS);
      assert.equal(calls[0].hasSignal, true, "the attempt is bounded");
      const stats = dex.getStats();
      assert.equal(stats.relayAttempts, 1);
      assert.equal(stats.relayServed, 1);
      assert.equal(stats.relayFailed, 0);
      assert.deepEqual(stats.relayServedByArm, { weur: 1 });
      assert.equal(stats.lastRelayArm, "weur");
      assert.equal(
        stats.http429,
        1,
        "the direct refusal is still recorded: the relay absorbed it, it did not un-happen",
      );
      assert.equal(
        stats.blockedForMs,
        0,
        "the lane was served, so no cache-only block is armed",
      );
      assert.equal(stats.pairCacheMisses, 0, "a relayed response stays out of the edge ratio");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("a failed relay changes nothing: the 429 branch still arms the block", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => refused();
    try {
      const { dex, calls } = relayedClient(async () => null);
      const pairs = await dex.fetchPairsForTokens(["MINT_RELAY"], Date.now() + 1_500);
      assert.equal(pairs.size, 0);
      assert.equal(calls.length, 1);
      const stats = dex.getStats();
      assert.equal(stats.relayAttempts, 1);
      assert.equal(stats.relayServed, 0);
      assert.equal(stats.relayFailed, 1);
      assert.ok(stats.blockedForMs > 0, "the pre-2026-11-03 block is what runs");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("no headroom = no relay attempt at all", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => refused();
    try {
      const { dex, calls } = relayedClient(async () => ({ response: okBody(), arm: "apac" }));
      const pairs = await dex.fetchPairsForTokens(["MINT_RELAY"], Date.now() + 400);
      assert.equal(pairs.size, 0);
      assert.equal(calls.length, 0, "a window under the headroom rule is not spent on a hop");
      assert.equal(dex.getStats().relayAttempts, 0);
      assert.ok(dex.getStats().blockedForMs > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("a client with no hook never relays (Node container / old deploy)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => refused();
    try {
      const dex = new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }));
      const pairs = await dex.fetchPairsForTokens(["MINT_RELAY"], Date.now() + 1_500);
      assert.equal(pairs.size, 0);
      assert.equal(dex.getStats().relayAttempts, 0);
      assert.equal(dex.getStats().relayServed, 0);
      assert.ok(dex.getStats().blockedForMs > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  console.log(results.join("\n"));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("dex egress relay suite crashed:", err);
  process.exit(1);
});
