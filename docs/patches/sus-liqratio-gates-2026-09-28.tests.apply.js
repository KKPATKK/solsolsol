/**
 * Unit-test edits for the 2026-09-28 gates (Jupiter audit.isSus + the LP-heavy
 * ratio floor + the honest bundler line).
 *
 * Why a script: the direct file-edit path does not persist changes to these
 * regions of scripts/test-unit.js (the require-line edit at the top of the
 * file applied, these did not). Each edit asserts an EXACT-ONE-OCCURRENCE
 * anchor and a one-or-zero-occurrence replacement, so a partial patch is
 * impossible and re-running is a no-op.
 *
 * New tests:
 *  1. the pinned shape of fetchOrganicScore gains the audit fields it now
 *     returns (sus / devBalancePct),
 *  2. fetchOrganicScore's presence-only audit parsing (a flagged token with no
 *     organic data must still produce a reading, or the gate fails open),
 *  3. jupSusBlockReason,
 *  4. mcapRatioBlockReason's LOW side against the 2026-09-28 ring numbers,
 *  5. RugCheck: a real 0% bundler reading ≠ no reading,
 *  6. render: a missing bundler reading does not print as an all-clear.
 *
 * Usage: node docs/patches/sus-liqratio-gates-2026-09-28.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(FILE, "utf8");

const NEW_TESTS = `  await test("fetchOrganicScore: audit.isSus is presence-only and never fails open", async () => {
    const mint = "EnQbyi2fgEwjzopWfm4f7v15pW7weZkcrfFQNiBEMXBi";
    const make = (entry) =>
      new JupTokensClient(
        { jupiterRequestIntervalMs: 0 },
        async () =>
          new Response(JSON.stringify([{ id: mint, ...entry }]), { status: 200 }),
      );
    // The live QNT payload shape (2026-09-28) the gate was calibrated on.
    const qnt = await make({
      organicScore: 0,
      organicScoreLabel: "low",
      stats1h: { numTraders: 50 },
      audit: {
        isSus: true,
        devBalancePercentage: 25.0801770032764,
        devMints: 16,
        devMigrations: 2,
      },
    }).fetchOrganicScore(mint);
    assert.equal(qnt.sus, true);
    assert.equal(qnt.devBalancePct.toFixed(2), "25.08");
    // ABSENT is not "safe" — it reads false/null so the card stays silent.
    const clean = await make({ organicScore: 55 }).fetchOrganicScore(mint);
    assert.equal(clean.sus, false);
    assert.equal(clean.devBalancePct, null);
    // A flagged token with NO organic data must still return a reading, or the
    // gate would fail open exactly where it matters most.
    const flaggedOnly = await make({ audit: { isSus: true } }).fetchOrganicScore(mint);
    assert.equal(flaggedOnly.sus, true);
    assert.equal(flaggedOnly.score, null);
    assert.equal(flaggedOnly.tradersH1, null);
    // Explicit false is the same reading as absent (Jupiter sets it only when
    // it has flagged the token).
    const explicit = await make({ organicScore: 40, audit: { isSus: false } }).fetchOrganicScore(mint);
    assert.equal(explicit.sus, false);
    // A non-numeric dev balance is not a number the reject reason may print.
    const junk = await make({
      organicScore: 1,
      audit: { isSus: true, devBalancePercentage: "25%" },
    }).fetchOrganicScore(mint);
    assert.equal(junk.devBalancePct, null);
    assert.equal(junk.sus, true);
    // Nothing at all → null, and the card hides the line entirely.
    assert.equal(await make({}).fetchOrganicScore(mint), null);
  });

  await test("jupSusBlockReason: only a Jupiter flag blocks, and the flag alone is enough", () => {
    assert.equal(jupSusBlockReason(false, 25), null);
    assert.equal(jupSusBlockReason(false, null), null);
    const flagged = jupSusBlockReason(true, 25.0801770032764);
    assert.match(flagged, /audit\\.isSus/);
    assert.match(flagged, /dev 持倉 25\\.1%/);
    // The dev balance is decoration, not a condition.
    const bare = jupSusBlockReason(true, null);
    assert.match(bare, /audit\\.isSus/);
    assert.equal(bare.includes("%"), false, "no number is invented when there is none");
    assert.equal(jupSusBlockReason(true, NaN).includes("NaN"), false);
  });

  await test("mcapRatioBlockReason: the LOW side is the LP-heavy shape (2026-09-28 ring)", () => {
    const max = 10;
    const min = 2;
    // QNT at push ($81,566 mcap on $57,144.55 LP = 1.43x, LP/mcap 0.70): the
    // reason reports the pool's share of supply, 100 ÷ (2 × 1.427) = 35%.
    const qnt = mcapRatioBlockReason(81_566, 57_144.55, max, min);
    assert.match(qnt, /1\\.4x < 2x/);
    assert.match(qnt, /約 35% 供應/);
    // The healthy side of that ring is untouched: the highest non-drained push
    // measured 3.46x (KOG — 90,304 mcap / 26,111.83 LP).
    assert.equal(mcapRatioBlockReason(90_304, 26_111.83, max, min), null);
    // The two knobs are independent: the ceiling keeps its own behaviour with
    // the floor off (the pre-2026-09-28 contract).
    assert.equal(mcapRatioBlockReason(150_000, 7_950, 0, 0), null, "both sides off");
    assert.equal(
      mcapRatioBlockReason(150_000, 7_950, max, min),
      mcapRatioBlockReason(150_000, 7_950, max),
      "the floor never changes the ceiling's verdict",
    );
    assert.match(mcapRatioBlockReason(150_000, 7_950, 0, 100), /< 100x/, "the floor judges with the ceiling off");
    assert.match(mcapRatioBlockReason(81_566, 57_144.55, 0, min), /1\\.4x < 2x/, "and the ceiling off does not disarm it");
    // Strictly below the floor blocks; exactly at it passes (no off-by-one).
    assert.match(mcapRatioBlockReason(100_000, 52_632, max, min), /< 2x/);
    assert.equal(mcapRatioBlockReason(100_000, 50_000, max, min), null);
    // Fail-open: a missing/zero reading never judges, on either side.
    assert.equal(mcapRatioBlockReason(0, 57_144, max, min), null);
    assert.equal(mcapRatioBlockReason(81_566, 0, max, min), null);
    assert.equal(mcapRatioBlockReason(NaN, 57_144, max, min), null);
    assert.equal(mcapRatioBlockReason(81_566, NaN, max, min), null);
  });

  await test("RugCheck: a real 0% bundler reading is not the same value as no reading", async () => {
    const { RugcheckClient } = require(path.join(__dirname, "..", "dist", "rugcheck.js"));
    const origFetch = globalThis.fetch;
    const report = (over) => ({
      token: { supply: 1_000_000 },
      insiderNetworks: [],
      topHolders: [{ address: "pool", pct: 50 }, { address: "h1", pct: 20 }],
      creator: "4v5fwW5NAAjtZisb8WynFWSQtKdgEqVzHkRqAo1HfxcM",
      ...over,
    });
    let body = report();
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const rc = new RugcheckClient(loadConfig({ RUGCHECK_REQUEST_INTERVAL_MS: "0" }));
      // An EMPTY array IS an answer: the analysis ran and found nothing, so
      // this is a real 0 the card may quote as "0.0%（未检测到捆绑网络）".
      const zero = await rc.getReport("mint", "pool");
      assert.equal(zero.bundlerPct, 0, "an answered-empty analysis is a real 0");
      assert.equal(zero.top10HolderPct, 20, "the pool address is still excluded from Top10");
      // An ABSENT field is NOT an answer → null, so the card says 未检测
      // instead of inventing the all-clear (live QNT, 2026-09-28: the pushed
      // card printed the all-clear while the report had insiderNetworks null).
      body = report({ insiderNetworks: null });
      assert.equal((await rc.getReport("mint", "pool")).bundlerPct, null);
      body = report({ insiderNetworks: undefined });
      assert.equal((await rc.getReport("mint", "pool")).bundlerPct, null);
      // A real finding still reports its percentage.
      body = report({ insiderNetworks: [{ tokenAmount: 100_000 }] });
      assert.equal((await rc.getReport("mint", "pool")).bundlerPct, 10);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("render: a missing RugCheck bundler reading does not print as an all-clear", () => {
    const { renderMessage } = require(path.join(__dirname, "..", "dist", "render.js"));
    const coin = {
      chatId: "c",
      profile: { tokenAddress: "QNT", name: "Quant", symbol: "QNT" },
      pair: {
        chainId: "solana",
        url: "",
        pairAddress: "p-QNT",
        baseToken: { address: "QNT", name: "Quant", symbol: "QNT" },
        priceUsd: "0.00008156",
        marketCap: 81_566,
        volume: { h24: 455_900, h1: 0, m5: 25_960 },
        priceChange: { m5: 14.47, h1: 0 },
        liquidity: { usd: 57_144.55 },
        pairCreatedAt: Date.now() - 93 * 60_000,
      },
      stats: { token: "QNT" },
    };
    const crime = {
      hit: false,
      creatorHit: false,
      holderHits: [],
      checkedHolders: 0,
      loaded: false,
      holders: [],
    };
    const card = (bundler, top10) =>
      renderMessage(coin, bundler, top10, null, null, null, null, crime, null, null, null, null);
    const missing = card(null, null);
    assert.match(missing, /🛡 Bundler: —（未检测）/);
    assert.equal(
      missing.includes("未检测到捆绑网络"),
      false,
      "missing data must not assert an all-clear",
    );
    assert.match(missing, /👥 Top10 持仓: —（未检测）/, "the Top10 line already took this stance");
    // A REAL 0 keeps the reassuring wording — the two states are different
    // readings of the same report and must stay distinct on the card.
    assert.match(card(0, 37.2), /🛡 Bundler: 0\\.0%（未检测到捆绑网络）/);
    assert.match(card(12.5, 30), /🛡 Bundler: 12\\.5%/);
  });
`;

const edits = [
  {
    name: "1. pinned fetchOrganicScore shape gains the audit fields",
    anchor: `    assert.deepEqual(await client.fetchOrganicScore(mint), {
      score: 0,
      label: "low",
      tradersH1: 1,
      tradersWindow: "1h",
    });`,
    replacement: `    assert.deepEqual(await client.fetchOrganicScore(mint), {
      score: 0,
      label: "low",
      tradersH1: 1,
      tradersWindow: "1h",
      // Audit block (2026-09-28): absent in this payload, so the gate reads
      // "not flagged" and the reject reason has no dev balance to print.
      sus: false,
      devBalancePct: null,
    });`,
  },
  {
    name: "7. liquidity-provenance witness follows the guarded block",
    // The witness test strips comments+whitespace and asserts on source text,
    // so it has to be updated with the code it pins. The ternary became a
    // guarded block because the LP-heavy floor's counter reads liquidityUsd a
    // second time and a truthy reason narrows nothing (TS18047). The RULE is
    // unchanged: both sides of the band are still only reached through
    // gateLiquidityUsd's provenance guard.
    anchor: `    assert.equal(
      scannerSrc.includes("liquidityUsd===null?null:mcapRatioBlockReason("),
      true,
      "and neither may the mcap/LP ratio",
    );`,
    replacement: `    assert.equal(
      scannerSrc.includes("if(liquidityUsd!==null){constratioReason=mcapRatioBlockReason("),
      true,
      "and neither may the mcap/LP ratio",
    );
    assert.equal(
      scannerSrc.includes("mcapLiqRatioMin,"),
      true,
      "the band's LOW side reads the same guarded liquidity number",
    );`,
  },
  {
    name: "2-6. new tests after the trader-window fallback test",
    anchor: `    const rNone = await make({ organicScore: 5 }).fetchOrganicScore(mint);
    assert.equal(rNone.tradersH1, null);
    assert.equal(rNone.tradersWindow, null);
    assert.equal(rNone.score, 5);
  });
`,
    replacement: `    const rNone = await make({ organicScore: 5 }).fetchOrganicScore(mint);
    assert.equal(rNone.tradersH1, null);
    assert.equal(rNone.tradersWindow, null);
    assert.equal(rNone.score, 5);
  });

${NEW_TESTS}`,
  },
];

let applied = 0;
let already = 0;
const problems = [];

for (const edit of edits) {
  const substituted = src.split(edit.replacement).length - 1;
  if (substituted === 1) {
    already++;
    continue;
  }
  if (substituted > 1) {
    problems.push(`${edit.name}: replacement present ${substituted} times (corrupt)`);
    continue;
  }
  const parts = src.split(edit.anchor);
  if (parts.length === 1) {
    problems.push(`${edit.name}: anchor NOT FOUND`);
    continue;
  }
  if (parts.length > 2) {
    problems.push(`${edit.name}: anchor is AMBIGUOUS (${parts.length - 1} hits)`);
    continue;
  }
  src = parts.join(edit.replacement);
  applied++;
}

if (problems.length > 0) {
  console.error("REFUSING TO WRITE:\n - " + problems.join("\n - "));
  process.exit(1);
}
if (applied === 0) {
  console.log(`no change needed (already applied: ${already})`);
  process.exit(0);
}
fs.writeFileSync(FILE, src);
console.log(`applied ${applied} edit(s), skipped ${already} already-applied`);
