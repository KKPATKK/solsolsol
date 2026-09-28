#!/usr/bin/env node
/**
 * Raise the re-eval pool's MARKET-CAP floor prune from 0.6 to 0.8, and put the
 * ratio in one exported constant the way its liquidity sibling already is.
 *
 * Touches four sources + the test pins:
 *   1. src/scanner.ts      the constant + the pool query that reads it
 *   2. src/jupfeeds.ts     the discovery band — deliberately NOT raised (0.6),
 *                          now a named constant with the reason written down
 *   3. src/worker.ts       /debug/pool's probe used `minMcap / 2`, i.e. a
 *                          LOOSER floor than production; it must mirror
 *   4. scripts/cpu-profile.js  the off-platform profiler mirrors the query
 *   5. scripts/test-unit.js    pins the constant + all three call sites
 *
 * Anchored + marker-guarded + idempotent: re-running must print "=" for every
 * edit, never "✓" twice. No regex literals are embedded anywhere (they do not
 * survive a template literal); all substitutions use a function replacer so a
 * "$32K" in the replacement text is never read as a capture reference.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function sub(file, label, anchor, replacement, markers) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) {
    console.error(`✗ ${file}: not found`);
    failures += 1;
    return;
  }
  const src = fs.readFileSync(target, "utf8");
  const markerList = Array.isArray(markers) ? markers : [markers];
  if (markerList.every((m) => src.includes(m))) {
    console.log(`= ${file} :: ${label} (already applied)`);
    return;
  }
  const hits = src.split(anchor).length - 1;
  if (hits === 0) {
    console.error(`✗ ${file} :: ${label} — anchor not found`);
    failures += 1;
    return;
  }
  if (hits > 1) {
    console.error(`✗ ${file} :: ${label} — anchor not unique (${hits})`);
    failures += 1;
    return;
  }
  if (markerList.some((m) => src.includes(m))) {
    console.error(`✗ ${file} :: ${label} — half-applied already (marker present, anchor present)`);
    failures += 1;
    return;
  }
  const next = src.replace(anchor, () => replacement);
  fs.writeFileSync(target, next);
  console.log(`✓ ${file} :: ${label}`);
}

// ---------------------------------------------------------------- scanner.ts
sub(
  "src/scanner.ts",
  "the POOL_MCAP_PRUNE_RATIO constant",
  "export const POOL_LIQUIDITY_PRUNE_RATIO = 0.8;",
  `export const POOL_LIQUIDITY_PRUNE_RATIO = 0.8;

/**
 * The MARKET-CAP floor the re-eval pool prunes on, as a fraction of the widest
 * enabled chat's min-market-cap gate (\`minQualifyMcap\` in the pool query).
 * 0.6 → 0.8 (2026-09-28), the sibling of POOL_LIQUIDITY_PRUNE_RATIO above.
 *
 * The two constants exist to kill ONE confusion: 0.6 used to be the value of
 * BOTH floors, so "the 0.6 prune" named neither. Each is now named for the
 * gate it scales — $40K gate → $32K floor here, $10K gate → $8K there.
 *
 * Same one-way semantics and the same safety argument as its sibling: a coin
 * whose PEAK market cap never reached 0.8 × the gate could never have passed
 * that gate, so no coin that could have been pushed is lost. The COST is
 * larger than the liquidity sibling's, though: a dropped coin stops updating
 * max_mcap_observed, and market cap is the volatile dimension (a $26K coin
 * gapping past a $40K gate is the very shape this bot hunts) while pool depth
 * moves a few percent at a time. Measured on this pool before the raise:
 * scripts/pool-mcap-floor.js.
 *
 * Deliberately NOT propagated to jupfeeds.TREND_BAND_MCAP_FLOOR_RATIO: that
 * band is a DISCOVERY filter and a token it rejects never enters token_stats
 * at all, so it stays LOOSER than this floor on purpose — the safe direction
 * for a filter no later sweep can undo.
 */
export const POOL_MCAP_PRUNE_RATIO = 0.8;`,
  "export const POOL_MCAP_PRUNE_RATIO = 0.8;",
);

sub(
  "src/scanner.ts",
  "the pool query's mcap floor",
  `        // repeatedly seen below 60% of the market-cap gate are dropped, so
        // the sweep budget concentrates on coins that can actually qualify.`,
  `        // repeatedly seen below POOL_MCAP_PRUNE_RATIO of the market-cap gate
        // are dropped, so the sweep budget concentrates on coins that can
        // actually qualify.`,
  "repeatedly seen below POOL_MCAP_PRUNE_RATIO of the market-cap gate",
);

sub(
  "src/scanner.ts",
  "the minQualifyMcap argument",
  "        minQualifyMcap: poolMinMcapUsd * 0.6,",
  `        // 2026-09-28: 0.6 → 0.8 ($24K → $32K at the default $40K gate) — the
        // same raise the liquidity floor above got. POOL_MCAP_PRUNE_RATIO
        // documents why an mcap drop costs more per coin than a liquidity
        // drop; scripts/pool-mcap-floor.js is the measurement behind it.
        minQualifyMcap: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,`,
  "minQualifyMcap: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,",
);

// ---------------------------------------------------------------- jupfeeds.ts
sub(
  "src/jupfeeds.ts",
  "the trending band's deliberate 0.6",
  `/**
 * Build the trending leg's band from the enabled chats' qualifying windows,
 * using the re-eval pool's own lenient margins (floor × 0.6, ceiling × 2,
 * age ± margin): a coin slightly below the floor now can rise into it, and the
 * pool would keep it for exactly that reason — so the discovery filter must
 * not be tighter than the pool's own prune bounds.
 */`,
  `/**
 * The trending band's own market-cap floor, as a fraction of the widest chat's
 * min-market-cap gate.
 *
 * STAYS 0.6 while the pool's floor (scanner.POOL_MCAP_PRUNE_RATIO) went to 0.8
 * on 2026-09-28 — on purpose, and the divergence is the safe direction:
 *
 *   - the pool's floor is a PRUNE. A coin it drops is already in token_stats;
 *     it stops being re-measured, but a later feed appearance re-registers it.
 *   - this is a DISCOVERY filter. A trending token it rejects is never
 *     inserted at all, so nothing downstream can recover it.
 *
 * Tightening discovery to match the pool would therefore make the band the
 * binding constraint on coverage, which is exactly what the pool's own
 * docstring forbids ("the discovery filter must not be tighter than the
 * pool's own prune bounds"). Keeping a WIDER net than the pool costs a few
 * registrations the pool will not sweep and nothing else.
 */
const TREND_BAND_MCAP_FLOOR_RATIO = 0.6;

/**
 * Build the trending leg's band from the enabled chats' qualifying windows,
 * using the re-eval pool's lenient margins (floor × TREND_BAND_MCAP_FLOOR_RATIO,
 * ceiling × 2, age ± margin): a coin slightly below the floor now can rise into
 * it, and the pool would keep it for exactly that reason — so the discovery
 * filter must not be tighter than the pool's own prune bounds.
 */`,
  "const TREND_BAND_MCAP_FLOOR_RATIO = 0.6;",
);

sub(
  "src/jupfeeds.ts",
  "the band's min-mcap argument",
  "    minMcapUsd: Math.min(...chats.map((c) => c.minMarketCapUsd)) * 0.6,",
  "    minMcapUsd: Math.min(...chats.map((c) => c.minMarketCapUsd)) * TREND_BAND_MCAP_FLOOR_RATIO,",
  "Math.min(...chats.map((c) => c.minMarketCapUsd)) * TREND_BAND_MCAP_FLOOR_RATIO,",
);

// ----------------------------------------------------------------- worker.ts
sub(
  "src/worker.ts",
  "the import",
  'import { Scanner, forgetDeferredTokens } from "./scanner";',
  'import { Scanner, forgetDeferredTokens, POOL_MCAP_PRUNE_RATIO } from "./scanner";',
  "forgetDeferredTokens, POOL_MCAP_PRUNE_RATIO } from",
);

sub(
  "src/worker.ts",
  "the /debug/pool probe's floor",
  "          minQualifyMcap: minMcap / 2,",
  `          // The scanner's OWN ratio (2026-09-28). This probe used
          // minMcap / 2 — a LOOSER floor than production's, so its
          // poolQueryCount over-reported the rows the tick could reach and no
          // floor change could be read off this endpoint. It mirrors now.
          minQualifyMcap: minMcap * POOL_MCAP_PRUNE_RATIO,`,
  "minQualifyMcap: minMcap * POOL_MCAP_PRUNE_RATIO,",
);

// --------------------------------------------------------- cpu-profile.js
sub(
  "scripts/cpu-profile.js",
  "the import",
  'const { Scanner, POOL_LIQUIDITY_PRUNE_RATIO } = require("../dist/scanner.js");',
  'const {\n  Scanner,\n  POOL_LIQUIDITY_PRUNE_RATIO,\n  POOL_MCAP_PRUNE_RATIO,\n} = require("../dist/scanner.js");',
  "POOL_MCAP_PRUNE_RATIO,\n} = require(\"../dist/scanner.js\");",
);

sub(
  "scripts/cpu-profile.js",
  "the profiler's mcap floor",
  "      minQualifyMcap: poolMinMcapUsd * 0.6,",
  `      // The scanner's own constants, so this profile can never measure a
      // pool the tick would not have read (2026-09-28: both floors went to
      // 0.8 — POOL_LIQUIDITY_PRUNE_RATIO below, POOL_MCAP_PRUNE_RATIO here).
      minQualifyMcap: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,`,
  "minQualifyMcap: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,",
);

// ---------------------------------------------------------- test-unit.js
sub(
  "scripts/test-unit.js",
  "the cross-file pins",
  `    assert.ok(
      profileSrc.includes("minQualifyLiquidity:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,"),
      "cpu-profile.js must measure the same pool the tick reads",
    );`,
  `    assert.ok(
      profileSrc.includes("minQualifyLiquidity:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,"),
      "cpu-profile.js must measure the same pool the tick reads",
    );
    // The MARKET-CAP floor is the sibling of the liquidity one, and 0.6 used
    // to be the value of BOTH: these pin that each floor now names its own
    // constant, that the bare 0.6 is gone from both places that read it, and
    // that the two worlds that quote it (the probe's endpoint and the offline
    // profiler) cannot drift back to a literal.
    assert.equal(
      require("../dist/scanner.js").POOL_MCAP_PRUNE_RATIO,
      0.8,
      "the pool's market-cap prune ratio (0.6 -> 0.8)",
    );
    assert.ok(
      scannerSrc.includes("minQualifyMcap:poolMinMcapUsd*POOL_MCAP_PRUNE_RATIO,"),
      "the pool query must prune on the mcap constant, not on a literal ratio",
    );
    assert.ok(
      !scannerSrc.includes("minQualifyMcap:poolMinMcapUsd*0.6,"),
      "the 0.6 mcap ratio must be gone — raising that prune is the point",
    );
    assert.ok(
      profileSrc.includes("minQualifyMcap:poolMinMcapUsd*POOL_MCAP_PRUNE_RATIO,"),
      "cpu-profile.js must mirror the mcap floor too, or it measures a wider pool",
    );
    const workerSrc = read("src/worker.ts");
    assert.ok(
      workerSrc.includes("minQualifyMcap:minMcap*POOL_MCAP_PRUNE_RATIO,"),
      "/debug/pool must report the pool the tick reads, not a looser one",
    );
    assert.ok(
      !workerSrc.includes("minQualifyMcap:minMcap/2,"),
      "the probe's old minMcap/2 floor (looser than production) must be gone",
    );
    assert.ok(
      profileSrc.includes("POOL_MCAP_PRUNE_RATIO,"),
      "cpu-profile.js must import the mcap ratio, not restate it",
    );
    // The trending band is a DISCOVERY filter, so it deliberately stays at the
    // pre-raise floor: tighter than the pool's prune would drop tokens before
    // they are ever registered, which no later sweep can undo.
    const jupSrc = read("src/jupfeeds.ts");
    assert.ok(
      jupSrc.includes("constTREND_BAND_MCAP_FLOOR_RATIO=0.6;") &&
        jupSrc.includes("minMcapUsd:Math.min(...chats.map((c)=>c.minMarketCapUsd))*TREND_BAND_MCAP_FLOOR_RATIO,"),
      "the trending band stays looser than the pool floor, and says so in a named constant",
    );`,
  // A marker that survives the edit: the added assert's own message. (The
  // anchor block is re-emitted inside the replacement, so it stays present
  // afterwards and cannot serve as its own guard.)
  "market-cap prune ratio (0.6 -> 0.8)",
);

console.log(
  failures === 0
    ? "\nall edits applied (or already applied)"
    : `\n${failures} edit(s) FAILED — fix the anchors before trusting the tree`,
);
process.exit(failures === 0 ? 0 : 1);
