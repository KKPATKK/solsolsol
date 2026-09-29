/*
 * Anchored patch (2026-09-29, second pass): the LOW side of the mcap/LP band
 * becomes a per-TOKEN gate in the push chain.
 *
 * WHY, in one line: in the eval it counted coins that had cleared the market-cap
 * band (9 hits in 14 sampled ticks, none able to say whether the coin would have
 * passed the age and momentum gates); in the chain it counts coins this tick
 * would actually have DELIVERED, and its reason lands in chainRejects — the ring
 * that can name them.
 *
 * The high side stays an eval rule (it has been one since the Nudaeng lesson,
 * and it is the per-chat reading). The eval's call now passes 0 for the low end
 * so the chain gate is its only judge; the two share one message builder.
 *
 * NOTE ON STYLE: the new code is written without template literals and without
 * backslash escapes. That is deliberate for a patch script — a `\` or a `${`
 * inside this file's template literals is one normalisation away from landing in
 * the source mangled, which is exactly the bug the sibling script's fix-count
 * repair exists to undo.
 *
 * Run: node docs/patches/chain-liq-ratio-gate-2026-09-29.apply.js
 */
const fs = require("fs");
const path = require("path");

function patch(rel, edits) {
  const file = path.join(__dirname, "..", "..", rel);
  let src = fs.readFileSync(file, "utf8");
  let applied = 0;
  let skipped = 0;
  for (const [label, anchor, replacement] of edits) {
    if (src.includes(replacement)) {
      skipped++;
      console.log(`  -- ${label} (already applied)`);
      continue;
    }
    if (!src.includes(anchor)) throw new Error(`[${label}] anchor not found`);
    src = src.split(anchor).join(replacement);
    applied++;
    console.log(`  ok ${label}`);
  }
  fs.writeFileSync(file, src);
  console.log(`${rel}: ${applied} applied, ${skipped} already present`);
}

const LOW_HELPER = `/**
 * The LOW side of the mcap/LP band on its own — the LP-heavy shape added
 * 2026-09-28, judged as a per-TOKEN gate in the push chain rather than as a
 * per-chat eval rule.
 *
 * WHY IT IS ITS OWN ENTRY POINT. \`mcapRatioBlockReason\` below answers "is this
 * pair outside the band" for a caller that owns both ends; the chain gate owns
 * only the low end and has to run by itself, because the eval passes 0 for the
 * low end now (the chain is the only place that knows the coin is about to be
 * delivered). The message is built HERE only, so the card, the log and the
 * reject ring can never describe the same reading two ways.
 */
export function mcapRatioLowBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMin: number,
): string | null {
  if (!(marketCap > 0) || !(liquidityUsd > 0) || !(ratioMin > 0)) return null;
  const ratio = marketCap / liquidityUsd;
  if (ratio >= ratioMin) return null;
  const poolSupplyPct = Math.round(100 / (2 * ratio));
  return (
    "市值/LP 比率 " +
    ratio.toFixed(1) +
    "x < " +
    ratioMin +
    "x（LP/市值 " +
    (1 / ratio).toFixed(2) +
    "：池內仍壓住約 " +
    poolSupplyPct +
    "% 供應，價格只是未賣出的存量）"
  );
}

export function mcapRatioBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMax: number,
  ratioMin = 0,
): string | null {`;

patch("src/scanner.ts", [
  [
    "mcapRatioLowBlockReason",
    `export function mcapRatioBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMax: number,
  ratioMin = 0,
): string | null {`,
    LOW_HELPER,
  ],
  [
    "one message builder",
    `  // The OTHER side of the band (2026-09-28, MCAP_LIQ_RATIO_MIN). For a
  // constant-product pool the two sides are the same quantity read from
  // opposite ends: LP/mcap = 2 × (tokens in the pool ÷ total supply), so a
  // LOW mcap/LP means the supply is still (mostly) unsold INSIDE the pool and
  // its SOL side is the exit one or two wallets can take.
  //
  // Why a LOW ratio is the danger, from the ring that found it: on 2026-09-28
  // the pushed QNT (LP/mcap 0.70 = ~35% of supply still pooled, dev + one
  // wallet holding 45%) had its pool sold empty within 1h34m; across the
  // 48-token push ring the shape separated cleanly — the four pushes below
  // 2.0x all had their liquidity pulled, none of the 35 above 2.9x did. See
  // docs/suspicious-token-gates.md.
  if (ratioMin > 0 && ratio < ratioMin) {
    const poolSupplyPct = Math.round(100 / (2 * ratio));
    return \`市值/LP 比率 \${ratio.toFixed(1)}x < \${ratioMin}x（LP/市值 \${(1 / ratio).toFixed(2)}：池內仍壓住約 \${poolSupplyPct}% 供應，價格只是未賣出的存量）\`;
  }
  return null;
}`,
    `  // The OTHER side of the band (2026-09-28, MCAP_LIQ_RATIO_MIN) — see
  // mcapRatioLowBlockReason above for the calibrated shape and the message.
  // This branch survives for a caller that hands both ends (the eval passes 0
  // for the low end now). For a constant-product pool the two sides are the
  // same quantity read from opposite ends: LP/mcap = 2 × (tokens in the pool ÷
  // total supply), so a LOW mcap/LP means the supply is still (mostly) unsold
  // INSIDE the pool and its SOL side is the exit one or two wallets can take.
  //
  // Why a LOW ratio is the danger, from the ring that found it: on 2026-09-28
  // the pushed QNT (LP/mcap 0.70 = ~35% of supply still pooled, dev + one
  // wallet holding 45%) had its pool sold empty within 1h34m; across the
  // 48-token push ring the shape separated cleanly — the four pushes below
  // 2.0x all had their liquidity pulled, none of the 35 above 2.9x did. See
  // docs/suspicious-token-gates.md.
  if (ratioMin > 0 && ratio < ratioMin) {
    return mcapRatioLowBlockReason(marketCap, liquidityUsd, ratioMin);
  }
  return null;
}`,
  ],
  [
    "eval: high side only",
    `          const ratioReason = mcapRatioBlockReason(
            pair.marketCap,
            liquidityUsd,
            this.config.mcapLiqRatioMax,
            this.config.mcapLiqRatioMin,
          );
          if (ratioReason) {
            // Route the counter to the side that fired. The decision itself
            // stays the helper's (one source of truth); this extra division
            // only picks the reading, because the two floors are tuned
            // independently — the HIGH side is the Nudaeng shape this gate has
            // always had, the LOW side is the LP-heavy shape added 2026-09-28.
            if (
              this.config.mcapLiqRatioMin > 0 &&
              pair.marketCap / liquidityUsd < this.config.mcapLiqRatioMin
            ) {
              fails.liqRatio++;
            } else {
              fails.other++;
            }
            reject(ratioReason);
            continue;
          }`,
    `          const ratioReason = mcapRatioBlockReason(
            pair.marketCap,
            liquidityUsd,
            this.config.mcapLiqRatioMax,
            // 0 = the LOW side is OFF here, and judged once per TOKEN in the
            // push chain instead (see mcapRatioLowBlockReason's call site).
            // Measured 2026-09-29, the reason it moved: judged HERE it counted
            // coins that had cleared this band and nothing else — 9 hits in 14
            // sampled ticks, none of which could be called "a coin that would
            // have been pushed", because the age, momentum, seen and chain
            // gates all still lay in front of it.
            0,
          );
          if (ratioReason) {
            // The high side (the Nudaeng shape this gate has always had) is
            // the one counter left here: \`other\` means "over-valued against
            // its own pool depth after passing momentum".
            fails.other++;
            reject(ratioReason);
            continue;
          }`,
  ],
  [
    "chain: the low-side gate",
    `        if (unseen.length === 0) continue;
        const coin = unseen[0];`,
    `        if (unseen.length === 0) continue;
        const coin = unseen[0];
        // MCAP/LP LOW-SIDE GATE (MCAP_LIQ_RATIO_MIN): a pool still holding most
        // of the supply is an exit one or two wallets can take (see the
        // helper's calibration notes). It is the FIRST thing the chain does
        // with a coin, because it is a pure computation on a pair the chain
        // already holds: \`unseen.length === 0\` above has already established
        // that this tick would DELIVER the coin to somebody, and nothing behind
        // this line has to be spent on one the ratio rejects. A leg that cannot
        // judge the pair (see gateLiquidityUsd) hands it 0 and fails open, like
        // every other gate here.
        //
        // WHY IT LIVES HERE AND NOT IN THE EVAL — the whole reason it moved
        // twice in one day (measured 2026-09-29): the eval runs per CHAT and
        // before the age and momentum gates, so a hit there said only "cleared
        // the market-cap band". Here it runs after the per-chat dedupe and after
        // every eval gate, so a hit means the coin would have been delivered,
        // and the reason reaches addReject — the ring that can NAME it, which
        // the eval's ring never had room to do.
        const liqRatioLow = mcapRatioLowBlockReason(
          coin.pair.marketCap,
          gateLiquidityUsd(coin.pair) ?? 0,
          this.config.mcapLiqRatioMin,
        );
        if (liqRatioLow) {
          diag.fails.liqRatio++;
          this.addReject(diag, coin, liqRatioLow);
          console.log(
            "[scanner] blocked " +
              (coin.profile.symbol ?? coin.pair.baseToken.symbol) +
              " (市值/LP 低於 " +
              this.config.mcapLiqRatioMin +
              "x)",
          );
          continue;
        }`,
  ],
]);

// --- tests -----------------------------------------------------------------

const TEST_FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
const oldMarker = '  await test("liqRatio gate: read AFTER momentum';

const NEW_TESTS = `  await test("mcapRatioLowBlockReason: the low side on its own, one message with the band", () => {
    // The chain gate owns only the low end (the eval passes 0 for it), so it
    // needs its own entry point — and it has to say exactly what the band says,
    // or the card, the log and the reject ring describe one reading three ways.
    const { mcapRatioLowBlockReason, mcapRatioBlockReason } = require("../dist/scanner.js");
    assert.equal(mcapRatioLowBlockReason(81_566, 57_144, 0), null, "0 disables the low side");
    assert.equal(mcapRatioLowBlockReason(81_566, 57_144, -1), null);
    assert.equal(
      mcapRatioLowBlockReason(100_000, 50_000, 2),
      null,
      "2.0x is AT the floor, not below it",
    );
    assert.equal(mcapRatioLowBlockReason(100_001, 50_000, 2), null, "and just above it");
    const low = mcapRatioLowBlockReason(100_000, 60_000, 2);
    assert.ok(low.includes("1.7x < 2x"), "the ratio is printed to one decimal, like the band");
    assert.ok(low.includes("LP/市值 0.60"));
    assert.ok(low.includes("約 30% 供應"), "and the pooled-supply share is derived, not stored");
    assert.equal(
      low,
      mcapRatioBlockReason(100_000, 60_000, 10, 2),
      "one message, whichever entry point is asked",
    );
    // Fail-open on anything it cannot judge — the same discipline as every
    // other gate, and the reason the chain hands it 0 for an unjudgeable leg.
    assert.equal(mcapRatioLowBlockReason(0, 60_000, 2), null);
    assert.equal(mcapRatioLowBlockReason(100_000, 0, 2), null);
    assert.equal(mcapRatioLowBlockReason(NaN, 60_000, 2), null);
    assert.equal(mcapRatioLowBlockReason(100_000, NaN, 2), null);
    // It must NEVER fire on the high side: that is still the eval's rule.
    assert.equal(mcapRatioLowBlockReason(297_569, 16_510, 2), null);
    // ... and the band still reports the high side first, with the low end off
    // or on, exactly as before this change.
    assert.ok(mcapRatioBlockReason(297_569, 16_510, 10, 2).includes("> 10x"));
  });

  await test("liqRatio gate: a per-TOKEN chain gate now, and the eval judges only the high side", () => {
    // Live 2026-09-29 (14 sampled ticks): in the eval the counter read "cleared
    // the market-cap band" — 9 hits, none able to say whether the coin would
    // have passed the age and momentum gates. It is a chain gate now: it runs
    // only for a coin this tick would deliver, and its reason lands in
    // chainRejects, which can name it. The slot IS the meaning, so pin the slot.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "scanner.ts"), "utf8");
    // One declaration and one call site each; the eval's call switches the low
    // side off (0) so the chain gate is its only judge.
    assert.equal(src.split("mcapRatioBlockReason(").length - 1, 2, "one declaration, one eval call");
    assert.equal(
      src.split("mcapRatioLowBlockReason(").length - 1,
      2,
      "one declaration, one chain call",
    );
    assert.ok(
      src.includes("this.config.mcapLiqRatioMax,\\n            // 0 = the LOW side is OFF here"),
      "the eval must pass 0 for the low side, or the chain gate is unreachable",
    );
    assert.ok(
      !src.includes("this.config.mcapLiqRatioMax,\\n            this.config.mcapLiqRatioMin,"),
      "and must not judge the low side twice",
    );
    // The slot in the chain: after the per-token seen-dedupe (so the coin is one
    // this tick would deliver) and before the first leg that costs a request.
    const seen = src.indexOf("if (unseen.length === 0) continue;");
    const gate = src.indexOf("mcapRatioLowBlockReason(\\n          coin.pair.marketCap,");
    const flow = src.indexOf("await this.resolveSupplyFlow(coin, chainDeadline);");
    const named = src.indexOf("this.addReject(diag, coin, liqRatioLow);");
    assert.ok(seen > 0, "the chain's per-token dedupe anchor must exist");
    assert.ok(gate > seen, "the gate runs per TOKEN, after the dedupe");
    assert.ok(flow > gate, "and before the supply-flow leg, and everything behind it");
    assert.ok(named > gate, "and names the coin through the push-stage ring");
    assert.equal(src.split("fails.liqRatio++").length - 1, 1, "one writer for the counter");
  });

`;

const testsSrc = fs.readFileSync(TEST_FILE, "utf8");
if (!testsSrc.includes(oldMarker)) {
  console.log("  -- tests (already applied)");
} else {
  const start = testsSrc.indexOf(oldMarker);
  const closeAt = testsSrc.indexOf("\n  });\n", start);
  if (closeAt < 0) throw new Error("[tests] could not find the end of the old test block");
  const end = closeAt + "\n  });\n\n".length;
  fs.writeFileSync(TEST_FILE, testsSrc.slice(0, start) + NEW_TESTS + testsSrc.slice(end));
  console.log("  ok tests: the momentum-order test replaced by the chain-slot test + helper semantics");
}

// The count of `mcapRatioLowBlockReason(` call sites is THREE, not two: the
// declaration, the band's own delegation inside mcapRatioBlockReason, and the
// chain's call. Fixed by line content (no backslash escapes to lose) so the
// assertion says what it counts.
{
  const lines = fs.readFileSync(TEST_FILE, "utf8").split("\n");
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].trim() === "2," &&
      (lines[i - 1] || "").includes("mcapRatioLowBlockReason(") &&
      (lines[i + 1] || "").includes("one declaration, one chain call")
    ) {
      lines[i] = "      3,";
      lines[i + 1] =
        `      "one declaration, the band's delegation, and the chain's call",`;
      changed++;
    }
  }
  if (changed === 0) {
    console.log("  -- call-site count (already corrected)");
  } else {
    fs.writeFileSync(TEST_FILE, lines.join("\n"));
    console.log(`  ok call-site count corrected (${changed} site)`);
  }
}

// The pointer comment the PREVIOUS patch left in the eval is now wrong: it says
// the ratio gate sits below, past the momentum gate. Only the HIGH side does.
{
  const file = path.join(__dirname, "..", "..", "src", "scanner.ts");
  const src = fs.readFileSync(file, "utf8");
  const OLD = `        // The valuation-vs-pool-depth gate USED to sit here, between the
        // market-cap band and the age gate. It is below now, past the momentum
        // gate, so \`fails.liqRatio\` counts coins this gate ALONE stopped
        // instead of coins that had merely cleared the mcap band — see the
        // block before out.push. Nothing about which coins are blocked changed.`;
  const NEW = `        // The valuation-vs-pool-depth gate is not judged here: the HIGH side is
        // checked below (past the momentum gate, before out.push) and the LOW
        // side is a per-TOKEN gate at the head of the push chain, where a hit
        // means the coin was about to be DELIVERED rather than merely clearing
        // this band. See mcapRatioLowBlockReason and fails.liqRatio.`;
  if (!src.includes(OLD)) {
    console.log("  -- eval pointer comment (already corrected)");
  } else {
    fs.writeFileSync(file, src.split(OLD).join(NEW));
    console.log("  ok eval pointer comment corrected");
  }
}
