/*
 * 2026-09-28 — tests for the gecko key + launch-slot chain + pool prune ratio.
 *
 * Same reason as its sibling: `str_replace` cannot see (parts of) the file it
 * has to edit, so the anchors are checked and applied here instead. Idempotent.
 *
 * Usage: node docs/patches/gecko-key-launch-chain-tests-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function applyTo(rel, edits) {
  const abs = path.join(root, rel);
  let text = fs.readFileSync(abs, "utf8");
  let changed = false;
  for (const e of edits) {
    if (e.done && text.includes(e.done)) {
      console.log(`= ${rel} :: ${e.name} (already applied)`);
      continue;
    }
    const first = text.indexOf(e.old);
    if (first === -1) {
      console.log(`\u2717 ${rel} :: ${e.name} — anchor not found`);
      failures++;
      continue;
    }
    if (text.indexOf(e.old, first + 1) !== -1) {
      console.log(`\u2717 ${rel} :: ${e.name} — anchor is not unique`);
      failures++;
      continue;
    }
    text = text.slice(0, first) + e.new + text.slice(first + e.old.length);
    changed = true;
    console.log(`\u2713 ${rel} :: ${e.name}`);
  }
  if (changed) fs.writeFileSync(abs, text);
}

const HELPER_OLD = `    // PUMPFUN_PROFILE_LIMIT=0 is what production runs (wrangler.toml): the
    // launch feed is a FALLBACK, not an always-on feed. Left unset, the knob's
    // code default (100) switches the pump layer to always-on mode, which skips
    // gecko's verdict entirely — the exact behaviour these tests exist to pin.
    const cfg = loadConfig({ PUMPFUN_PROFILE_LIMIT: "0", ...cfgEnv });`;

const HELPER_NEW = `    // PUMPFUN_PROFILE_LIMIT=20 is what production runs (wrangler.toml) since
    // 2026-09-28: the launch feed is ALWAYS ON, and the chain order that used
    // to hang off it is gone — Meteora now covers the ticks GECKO's 5-minute
    // cadence skips, not a tick pump.fun left empty. The legacy shape (always-on
    // limit 0, so pump.fun really is gecko's fallback) is still reachable by
    // passing PUMPFUN_PROFILE_LIMIT: "0" in cfgEnv.
    const cfg = loadConfig({ PUMPFUN_PROFILE_LIMIT: "20", ...cfgEnv });`;

const CHAIN_OLD = `  await test("Scanner: the launch-slot chain stops at the first layer that delivers", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { PUMPFUN_FALLBACK_LIMIT: "20", METEORA_FALLBACK_LIMIT: "20" },
        {
          t,
          geckoPools: () => [{ tokenAddress: mint("GECkxCxN"), createdAtMs: Date.now() - 60_000 }],
          pumpCoins: () => [{ tokenAddress: mint("PUMPCxxN1") }],
          meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() - 60_000 }],
        },
      );
      await scanner.runOnce();
      assert.equal(calls.gecko, 1);
      assert.equal(calls.pump, 0, "gecko delivered — pump.fun must not be paid for");
      assert.equal(calls.meteora, 0, "gecko delivered — Meteora must not be paid for");
      assert.equal(scanner.lastSummary.geo, 1);
      assert.equal(scanner.lastSummary.pump, 0);
      assert.equal(scanner.lastSummary.meteora, 0);
      // The reading that used to lie: with the chain built above the gecko job,
      // the pump layer read \`geckoJob === null\` and always ran + always claimed
      // \`pumpFallback\`, even on ticks where gecko had delivered.
      assert.notEqual(scanner.lastSummary.pumpFallback, true);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: a tick where gecko and pump.fun are both empty reaches Meteora", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const opts = {
        t,
        geckoPools: () => [],
        pumpCoins: () => [],
        meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() - 60_000 }],
      };
      const { scanner, calls } = await chainScanner(
        { PUMPFUN_FALLBACK_LIMIT: "20", METEORA_FALLBACK_LIMIT: "20" },
        opts,
      );
      await scanner.runOnce();
      assert.equal(calls.gecko, 1);
      assert.equal(calls.pump, 1, "gecko delivered nothing — pump.fun is the next layer");
      assert.equal(calls.meteora, 1, "pump.fun delivered nothing — Meteora is the last resort");
      assert.equal(opts.meteoraLimitSeen, 20);
      assert.equal(scanner.lastSummary.geo, 0);
      assert.equal(scanner.lastSummary.pump, 0);
      assert.equal(scanner.lastSummary.pumpFallback, true);
      assert.equal(scanner.lastSummary.meteora, 1);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: Meteora stays off the tick when its knob is 0", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { PUMPFUN_FALLBACK_LIMIT: "20", METEORA_FALLBACK_LIMIT: "0" },
        {
          t,
          geckoPools: () => [],
          pumpCoins: () => [],
          meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() }],
        },
      );
      await scanner.runOnce();
      assert.equal(calls.meteora, 0, "METEORA_FALLBACK_LIMIT=0 must mean no request at all");
      assert.equal(scanner.lastSummary.meteora, 0);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });`;

// The replacement block lives in a sibling .txt file and is read LITERALLY: it
// contains regex literals, and embedding it in a template literal here eats
// their backslashes (\/ -> /, \s -> s, [^\n] -> a real newline) — which is
// exactly how the first run of this script corrupted scripts/test-unit.js and
// broke it with a SyntaxError. The template literal below is that first,
// broken draft, kept only as the record of the bug: CHAIN_NEW_DEAD is never
// read (see gecko-key-launch-chain-tests-2026-09-28.repair.js).
const CHAIN_NEW = fs.readFileSync(
  path.join(__dirname, "gecko-key-launch-chain-tests-2026-09-28.block.txt"),
  "utf8",
);
const CHAIN_NEW_DEAD = `  await test("Scanner: pump.fun fetches every tick and Meteora yields to a gecko tick", async () => {
    // The 2026-09-28 shape: pump.fun is ALWAYS ON (PUMPFUN_PROFILE_LIMIT=20), so
    // it is no longer gated by gecko's verdict — it runs on every tick, in the
    // same fan-out, and only METEORA steps aside when gecko delivered.
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { METEORA_FALLBACK_LIMIT: "20" },
        {
          t,
          geckoPools: () => [{ tokenAddress: mint("GECkxCxN"), createdAtMs: Date.now() - 60_000 }],
          pumpCoins: () => [{ tokenAddress: mint("PUMPCxxN1") }],
          meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() - 60_000 }],
        },
      );
      await scanner.runOnce();
      assert.equal(calls.gecko, 1, "the first tick has no stamp row, so it is due");
      assert.equal(calls.pump, 1, "an always-on feed is not gated by gecko's verdict any more");
      assert.equal(calls.meteora, 0, "gecko delivered — Meteora must not be paid for");
      assert.equal(scanner.lastSummary.geoDue, true);
      assert.equal(scanner.lastSummary.geo, 1);
      assert.equal(scanner.lastSummary.pump, 1);
      assert.equal(scanner.lastSummary.meteora, 0);
      // \`pumpFallback\` belongs to the LEGACY shape only (always-on limit 0).
      assert.notEqual(scanner.lastSummary.pumpFallback, true);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: a tick where gecko and pump.fun are both empty reaches Meteora", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const opts = {
        t,
        geckoPools: () => [],
        pumpCoins: () => [],
        meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() - 60_000 }],
      };
      const { scanner, calls } = await chainScanner({ METEORA_FALLBACK_LIMIT: "20" }, opts);
      await scanner.runOnce();
      assert.equal(calls.gecko, 1);
      assert.equal(calls.pump, 1, "the always-on feed ran too — it is not a fallback any more");
      assert.equal(calls.meteora, 1, "gecko delivered nothing — Meteora is its cover");
      assert.equal(opts.meteoraLimitSeen, 20);
      assert.equal(scanner.lastSummary.geo, 0);
      assert.equal(scanner.lastSummary.pump, 0);
      assert.equal(scanner.lastSummary.meteora, 1);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: gecko's cadence skips the fetch and Meteora covers the tick", async () => {
    // The quota gate, end to end: tick 1 spends a gecko attempt and stamps the
    // durable row; tick 2 is inside the window, so gecko costs nothing at all —
    // and the launch slot is still filled, by Meteora. This is also what proves
    // the stamp LANDS (it rides the scan front's single write): a stamp that
    // never persisted would refetch every tick and spend the key's quota ~12x
    // over, which is the whole reason the row exists.
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { METEORA_FALLBACK_LIMIT: "20" },
        {
          t,
          geckoPools: () => [],
          pumpCoins: () => [],
          meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() - 60_000 }],
        },
      );
      await scanner.runOnce();
      assert.equal(calls.gecko, 1, "tick 1 has no stamp row — due");
      assert.equal(scanner.lastSummary.geoDue, true);
      await scanner.runOnce();
      assert.equal(calls.gecko, 1, "tick 2 is inside the window — no second fetch");
      assert.equal(scanner.lastSummary.geoDue, false);
      assert.equal(scanner.lastSummary.geo, 0);
      assert.equal(calls.meteora, 2, "Meteora covers the skipped tick");
      assert.equal(calls.pump, 2);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS=0 removes the gate", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { METEORA_FALLBACK_LIMIT: "20", GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS: "0" },
        { t, geckoPools: () => [], pumpCoins: () => [], meteoraPools: () => [] },
      );
      await scanner.runOnce();
      await scanner.runOnce();
      assert.equal(calls.gecko, 2, "0 = the leg is fetched on every tick again");
      assert.equal(scanner.lastSummary.geoDue, true);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner: Meteora stays off the tick when its knob is 0", async () => {
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const { scanner, calls } = await chainScanner(
        { METEORA_FALLBACK_LIMIT: "0" },
        {
          t,
          geckoPools: () => [],
          pumpCoins: () => [],
          meteoraPools: () => [{ tokenAddress: mint("METExRxxN"), openTimestamp: Date.now() }],
        },
      );
      await scanner.runOnce();
      assert.equal(calls.meteora, 0, "METEORA_FALLBACK_LIMIT=0 must mean no request at all");
      assert.equal(scanner.lastSummary.meteora, 0);
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("geckoDiscoveryDue: fail-open on every reading it cannot trust", () => {
    const { geckoDiscoveryDue, POOL_LIQUIDITY_PRUNE_RATIO } = require("../dist/scanner.js");
    const MIN = 60_000;
    const now = 1_800_000_000_000;
    assert.equal(geckoDiscoveryDue(0, now, 5 * MIN), true, "no stamp row -> due");
    assert.equal(geckoDiscoveryDue(Number.NaN, now, 5 * MIN), true, "a junk row -> due");
    assert.equal(geckoDiscoveryDue(now - 299_000, now, 5 * MIN), false, "inside the window -> skipped");
    assert.equal(geckoDiscoveryDue(now - 300_000, now, 5 * MIN), true, "the window boundary is inclusive");
    assert.equal(geckoDiscoveryDue(now + 60_000, now, 5 * MIN), true, "a FUTURE stamp -> due, never parked");
    assert.equal(geckoDiscoveryDue(now - 60_000, now, 0), true, "0 interval = no gate");
    assert.equal(geckoDiscoveryDue(now - 60_000, now, Number.NaN), true, "a junk interval = no gate");
    assert.equal(POOL_LIQUIDITY_PRUNE_RATIO, 0.8, "the pool's liquidity prune ratio (0.6 -> 0.8)");
  });

  await test("loadConfig: the gecko discovery interval defaults to 5 minutes", () => {
    assert.equal(loadConfig({}).geckoterminalDiscoveryIntervalMs, 300_000);
    assert.equal(
      loadConfig({ GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS: "60" })
        .geckoterminalDiscoveryIntervalMs,
      60_000,
    );
    assert.equal(
      loadConfig({ GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS: "0" })
        .geckoterminalDiscoveryIntervalMs,
      0,
      "0 is the explicit no-gate value",
    );
    assert.equal(
      loadConfig({ GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS: "nope" })
        .geckoterminalDiscoveryIntervalMs,
      300_000,
      "junk fails CLOSED to the default, never open to a fetch every tick",
    );
  });

  await test("out-of-window patch: the launch slot's knobs, the prune ratio and the gecko key (gecko-key-launch-chain-2026-09-28.apply.js)", () => {
    // The wiring, cross-file and past the file tool's edit window: the ratio is
    // a CONSTANT (never a copied 0.6), the pool query uses it, the cadence gate
    // reads + writes the durable row on the scan front, Meteora yields to gecko
    // alone, and the three deployed knobs + the secret write match the code.
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
    const raw = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
    const scannerSrc = read("src/scanner.ts");
    const profileSrc = read("scripts/cpu-profile.js");
    const dbSrc = strip(raw("src/db.ts"));
    const toml = raw("wrangler.toml");
    const deploy = raw(".github/workflows/deploy.yml");
    assert.ok(
      scannerSrc.includes("minQualifyLiquidity:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,"),
      "the pool query must prune on the constant, not on a literal ratio",
    );
    assert.ok(
      !scannerSrc.includes("minQualifyLiquidity:poolMinLiquidityUsd*0.6,"),
      "the 0.6 ratio must be gone — raising that prune is the point of the change",
    );
    assert.ok(
      profileSrc.includes("minQualifyLiquidity:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,"),
      "cpu-profile.js must measure the same pool the tick reads",
    );
    assert.ok(
      scannerSrc.includes(
        "geckoDiscoveryDue(geckoLastAt,Date.now(),this.config.geckoterminalDiscoveryIntervalMs,)",
      ),
      "the cadence gate must consult the durable stamp AND the configured interval",
    );
    assert.ok(
      scannerSrc.includes("awaitthis.stampFront(GECKO_DISCOVERY_AT_KEY,String(Date.now()))"),
      "an attempt must be stamped on the scan front's single write",
    );
    assert.ok(
      dbSrc.includes('GECKO_DISCOVERY_AT_KEY="gecko_discovery_at"') &&
        dbSrc.includes("GECKO_DISCOVERY_AT_KEY,"),
      "the row must be declared AND riding SCAN_FRONT_GATE_KEYS (or it costs a read of its own)",
    );
    assert.ok(
      scannerSrc.includes("if(diag.geo>0)return;") &&
        !scannerSrc.includes("if(diag.geo>0||diag.pump>0)return;"),
      "Meteora must yield to GECKO only — pump.fun is an always-on feed now",
    );
    assert.ok(
      !scannerSrc.includes("pumpJob"),
      "the pump job variable is gone: nothing downstream waits on it",
    );
    assert.ok(toml.includes('PUMPFUN_PROFILE_LIMIT = "20"'), "wrangler: pump.fun is the always-on feed");
    assert.ok(toml.includes('PUMPFUN_FALLBACK_LIMIT = "0"'), "wrangler: the legacy gecko fallback is off");
    assert.ok(
      toml.includes('METEORA_FALLBACK_LIMIT = "20"'),
      "wrangler: Meteora stays on — it is gecko's cover",
    );
    assert.ok(
      toml.includes('GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = "300"'),
      "wrangler: the keyed leg is spent once per 5 minutes",
    );
    assert.ok(
      deploy.includes("Set COINGECKO_API_KEY worker secret") &&
        deploy.includes("secrets.COINGECKO_API_KEY") &&
        deploy.includes("wrangler secret put COINGECKO_API_KEY"),
      "the deploy must be able to write the CoinGecko key as a Worker secret",
    );
  });`;

applyTo("scripts/test-unit.js", [
  {
    name: "chainScanner: production now runs the always-on pump feed",
    old: HELPER_OLD,
    new: HELPER_NEW,
    done: 'loadConfig({ PUMPFUN_PROFILE_LIMIT: "20", ...cfgEnv });',
  },
  {
    name: "launch-slot chain tests: new shape + cadence + pure/config/source pins",
    old: CHAIN_OLD,
    new: CHAIN_NEW,
    done: 'assert.equal(geckoDiscoveryDue(now - 299_000, now, 5 * MIN), false, "inside the window -> skipped");',
  },
]);

console.log(
  failures === 0
    ? "\n\u2713 all edits applied (re-run to prove idempotence)"
    : `\n\u2717 ${failures} edit(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
