/*
 * Anchored patch (2026-09-29): make the two gates' counters mean what they are
 * read for.
 *
 * WHY. The live reading that prompted this (`/debug/tick`, 14 sampled ticks
 * 01:55-02:03Z) showed the two gates are instrumented in a way that cannot
 * answer the question they exist for:
 *
 *   1. `fails.liqRatio` counted a gate that sits BEFORE the age and momentum
 *      gates, so its 9 hits in 14 ticks were coins that had cleared the market
 *      cap band and nothing else — not coins that would have been pushed. It
 *      moves after the momentum gate, immediately before `out.push`, where the
 *      counter reads "the ratio gate is the ONLY thing that stopped this coin
 *      from becoming a candidate". Behaviour is unchanged: the same coins are
 *      blocked either way, only which counter they land in changes.
 *
 *   2. `fails.sus` counted push-stage blocks that could never be NAMED: the
 *      summary's `rejects` ring is capped at REJECT_LOG_MAX (20) and the eval
 *      phase fills every slot with market-cap rejects (100+ per tick, measured),
 *      so `addReject` — every chain gate's only voice — always returned early.
 *      The push stage now has its own 5-slot ring, published on the summary as
 *      `chainRejects` beside `rejects`.
 *
 * Run: node docs/patches/chain-reject-ring-2026-09-29.apply.js
 *
 * SUPERSEDED IN PART (2026-09-29, same day). The low-side ratio gate this
 * script parked after the momentum gate moved AGAIN, into the push chain as a
 * per-token gate (docs/patches/chain-liq-ratio-gate-2026-09-29.apply.js), and
 * that script also replaced the order test written below. Re-running THIS one
 * against the new shape would put the eval-side gate back a second time and
 * duplicate two tests, so it refuses as soon as the newer shape is present.
 */
const fs = require("fs");
const path = require("path");

if (
  fs
    .readFileSync(path.join(__dirname, "..", "..", "src", "scanner.ts"), "utf8")
    .includes("mcapRatioLowBlockReason")
) {
  console.log(
    "superseded by docs/patches/chain-liq-ratio-gate-2026-09-29.apply.js — nothing to do",
  );
  process.exit(0);
}

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

const RATIO_BLOCK = `        // Valuation vs pool depth sanity: a price that ran up far beyond its
        // pooled liquidity is manipulable and nearly un-exitable (see the
        // helper's calibration notes). Global knob, 0 = off.
        // null = the coin came from a leg this ratio cannot judge (see
        // gateLiquidityUsd); stay fail-open rather than block a healthy coin
        // on a number that is a different metric of the same pool.
        if (liquidityUsd !== null) {
          const ratioReason = mcapRatioBlockReason(
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
          }
        }
`;

patch("src/scanner.ts", [
  [
    "CHAIN_REJECT_LOG_MAX",
    `const REJECT_LOG_MAX = 20;`,
    `const REJECT_LOG_MAX = 20;

/**
 * Slots for the PUSH-STAGE rejections, in their OWN ring (ScanSummary.
 * chainRejects). Five, one per chain gate that can block a coin — RugCheck's
 * bot flag, GMGN wash trading, the Jupiter suspicion flag, the brand-new-wallet
 * rule and the top-10 concentration rule — plus flurry; the point is to be able
 * to NAME the coins a gate stopped, and one slot per gate is enough to see
 * which gate is doing the blocking.
 *
 * WHY IT IS NOT THE 20-SLOT RING ABOVE (measured 2026-09-29). That ring is
 * filled by the EVAL phase, which runs first and rejects 100+ coins a tick on
 * the market-cap band alone, so every \`addReject\` from the chain hit the cap
 * and returned: a coin blocked by the Jupiter audit flag was COUNTED
 * (\`fails.sus\`) and never named, in every sampled tick. The two phases now
 * have a ring each, so the chain's five slots survive whatever the eval does.
 *
 * SIZE: five entries serialize to ~0.5KB (the reasons differ in length — the
 * flurry line is the long one) on a completion batch that is already ~2KB of
 * rejects and 12.4KB in total, so this is the cheapest reading in the batch.
 */
export const CHAIN_REJECT_LOG_MAX = 5;`,
  ],
  [
    "ScanSummary.chainRejects",
    `  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];
}`,
    `  /** Per-coin rejection trace for the last scan, EVAL stage (bounded — see
   * REJECT_LOG_MAX). Filled first, so the push-stage reasons are in their own
   * ring below rather than competing with it. */
  rejects: RejectionEntry[];
  /**
   * The PUSH-STAGE rejections (see CHAIN_REJECT_LOG_MAX): the coins that got
   * as far as the push chain — past the per-chat dedupe and the tick's gates —
   * and were stopped there. Separate from \`rejects\` on purpose, and the reason
   * a gate that now blocks nothing cannot be told apart from a gate that is
   * never reached is exactly what this ring answers.
   */
  chainRejects: RejectionEntry[];
}`,
  ],
  [
    "init chainRejects",
    `      rejects: [],
    };`,
    `      rejects: [],
      chainRejects: [],
    };`,
  ],
  [
    "addReject -> chainRejects",
    `  /** Append a post-match rejection to the scan summary (bounded). */
  private addReject(
    diag: ScanSummary,
    coin: QualifyingCoin,
    reason: string,
  ): void {
    if (diag.rejects.length >= REJECT_LOG_MAX) return;`,
    `  /**
   * Append a PUSH-STAGE rejection to the scan summary (bounded — see
   * CHAIN_REJECT_LOG_MAX). Never the eval ring: that one is full by the time
   * the chain runs, which is how every gate here became countable but
   * nameless.
   */
  private addReject(
    diag: ScanSummary,
    coin: QualifyingCoin,
    reason: string,
  ): void {
    if (diag.chainRejects.length >= CHAIN_REJECT_LOG_MAX) return;`,
  ],
  [
    "addReject push target",
    `    diag.rejects.push({
      symbol: pair.baseToken.symbol || coin.profile.symbol || "?",`,
    `    diag.chainRejects.push({
      symbol: pair.baseToken.symbol || coin.profile.symbol || "?",`,
  ],
  [
    "remove the ratio gate from its old slot",
    RATIO_BLOCK + `        if (ageMs < chat.minAgeMinutes * 60_000) {`,
    `        // The valuation-vs-pool-depth gate USED to sit here, between the
        // market-cap band and the age gate. It is below now, past the momentum
        // gate, so \`fails.liqRatio\` counts coins this gate ALONE stopped
        // instead of coins that had merely cleared the mcap band — see the
        // block before out.push. Nothing about which coins are blocked changed.
        if (ageMs < chat.minAgeMinutes * 60_000) {`,
  ],
  [
    "re-insert the ratio gate after the momentum gate",
    `            \`1h路徑[量\${mark(vol1hOk)} \${fmtUsd(pair.volume.h1)} 漲\${mark(chg1hOk)} \${pair.priceChange.h1.toFixed(0)}%]\`,
          );
          continue;
        }
        out.push({`,
    `            \`1h路徑[量\${mark(vol1hOk)} \${fmtUsd(pair.volume.h1)} 漲\${mark(chg1hOk)} \${pair.priceChange.h1.toFixed(0)}%]\`,
          );
          continue;
        }
` +
      RATIO_BLOCK +
      `        out.push({`,
  ],
]);

patch("scripts/test-unit.js", [
  [
    "tests: chain reject ring + the ratio gate's order",
    `  await test("boosts dial: off by default, clamped to the 30-row upstream", () => {`,
    `  await test("chain reject ring: the push-stage gates get their own 5 slots", () => {
    // WHY: the eval phase fills the 20-slot \`rejects\` ring (100+ market-cap
    // rejects per tick, measured 2026-09-29), so every push-stage addReject hit
    // the cap and returned — \`fails.sus\` could count a blocked coin and never
    // name it, in every sampled tick.
    const { Scanner, CHAIN_REJECT_LOG_MAX } = require("../dist/scanner.js");
    assert.equal(CHAIN_REJECT_LOG_MAX, 5, "one slot per chain gate");
    const cfg = loadConfig({});
    const scanner = new Scanner(
      { setWorkerState: async () => {} },
      { api: { sendMessage: async () => ({}) } },
      null,
      cfg,
      null,
      null,
      null,
    );
    const diag = { rejects: [], chainRejects: [] };
    const coin = {
      profile: { symbol: "AAA", tokenAddress: "T" },
      pair: {
        baseToken: { symbol: "AAA" },
        pairCreatedAt: Date.now() - 90_000,
        marketCap: 12_345,
        volume: { m5: 999 },
        priceChange: { m5: 1.5 },
      },
    };
    for (let i = 0; i < CHAIN_REJECT_LOG_MAX + 4; i++) {
      scanner.addReject(diag, coin, \`r\${i}\`);
    }
    assert.equal(diag.chainRejects.length, CHAIN_REJECT_LOG_MAX, "bounded at its own cap");
    assert.deepEqual(
      diag.chainRejects.map((r) => r.reason),
      ["r0", "r1", "r2", "r3", "r4"],
      "and it keeps the FIRST ones, so the earliest gate to fire is the one that survives",
    );
    assert.equal(diag.rejects.length, 0, "the eval ring is untouched — that is the whole point");
    assert.equal(diag.chainRejects[0].symbol, "AAA");
    assert.equal(diag.chainRejects[0].mcapUsd, 12_345);
    assert.equal(diag.chainRejects[0].ageMin, 2, "1.5 minutes rounds to 2");
    // The ring only exists if the tick's summary carries it.
    const scannerSrc = fs.readFileSync(path.join(__dirname, "..", "src", "scanner.ts"), "utf8");
    assert.ok(scannerSrc.includes("chainRejects: [],"), "the summary must initialise the ring");
    assert.ok(
      scannerSrc.includes("diag.chainRejects.length >= CHAIN_REJECT_LOG_MAX"),
      "addReject must be the ring's only writer, at its own cap",
    );
  });

  await test("liqRatio gate: read AFTER momentum, so the counter means 'this gate alone stopped it'", () => {
    // Live 2026-09-29 (14 sampled ticks): \`fails.liqRatio\` fired 9 times while
    // sitting BETWEEN the market-cap band and the age gate, so its hits were
    // coins that had cleared the band and nothing else — not coins that would
    // have been pushed. The order is the measurement here, so pin the order.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "scanner.ts"), "utf8");
    const mcap = src.indexOf("fails.mcap++");
    const age = src.indexOf("fails.age++");
    const momentum = src.indexOf("fails.chg++");
    const ratio = src.indexOf("fails.liqRatio++");
    const candidate = src.indexOf("out.push({", ratio);
    assert.ok(mcap > 0 && age > 0 && momentum > 0 && ratio > 0);
    assert.ok(candidate > ratio, "the candidate push must still come last");
    assert.ok(mcap < ratio, "the coin has still cleared the market-cap band");
    assert.ok(ratio > age, "the age window is faced first (where the gate used to sit)");
    assert.ok(
      ratio > momentum,
      "and the momentum gate before it — that is what makes the count mean 'only this gate stopped it'",
    );
    // One call site: the helper stays the single decision point for both sides.
    assert.equal(
      src.split("mcapRatioBlockReason(").length - 1,
      2,
      "one declaration and one call site",
    );
  });

  await test("boosts dial: off by default, clamped to the 30-row upstream", () => {`,
  ],
]);
