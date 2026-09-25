#!/usr/bin/env node
/**
 * Wire DexScreener's /token-boosts/latest/v1 as a new discovery feed.
 *
 * WHY (measured 2026-09-25 from the clean sandbox and /debug/pool-source from
 * the Worker's own egress): the boosted-token list answers 200 with 30 rows of
 * which 19 are Solana, and its row shape is `{url, chainId, tokenAddress,
 * description, icon, header, openGraph, totalAmount, amount}` — no metrics, no
 * timestamps, exactly like a profile row, so the age comes from the pair the
 * next batch fetches. In the same minute /token-profiles/latest/v1 returned 16
 * Solana mints with ZERO overlap ⇒ +19 net-new mints per tick, from the SAME
 * host as the profiles feed (so no new rate-limit bucket) for one extra
 * subrequest plus one pair batch.
 *
 * The shape is the one every other optional leg already uses
 * (dropOptionalLeg + fetchFeedCapped([], feedDeadline)): the leg is dropped,
 * NAMED in subreqSkip, and answered with [] when the tick's tail is protected.
 * That matters because the tick races the scan against a ~5s window
 * (9,500ms - 4,500ms flush reserve) and the scan's internal feed deadline is
 * 4.2s against a p50 of 2,627ms — the leg fits, but only if it can be dropped.
 *
 * Off by default (DEXSCREENER_BOOSTS_LIMIT = 0): enabling it is a measurement,
 * not a guess. wrangler.toml carries the dial at "0" with the reading that
 * justifies turning it up.
 */
const fs = require("node:fs");

const patches = [
  {
    file: "src/scanner.ts",
    what: "ScanSummary.boosts",
    anchor: "export interface ScanSummary {\n  profiles: number;\n",
    replacement: [
      "export interface ScanSummary {",
      "  profiles: number;",
      "  /**",
      "   * DexScreener boosted-token feed size this scan (paid promotion slots,",
      "   * 0 when disabled/blocked). Optional leg — a drop is named in",
      "   * `subreqSkip`.",
      "   */",
      "  boosts: number;",
      "",
    ].join("\n"),
  },
  {
    file: "src/scanner.ts",
    what: "subreqSkip doc mentions boosts",
    anchor:
      "   * (`meteora`, `geoTrend`, `gmgn`, `axiom`, `jupTrend`, `backfill`,\n   * `crime-refresh`). Present only alongside `subreqFloor`.\n",
    replacement:
      "   * (`meteora`, `geoTrend`, `boosts`, `gmgn`, `axiom`, `jupTrend`,\n   * `backfill`, `crime-refresh`). Present only alongside `subreqFloor`.\n",
  },
  {
    file: "src/scanner.ts",
    what: "diag.boosts = 0",
    anchor: "      profiles: 0,\n      pump: 0,\n",
    replacement: "      profiles: 0,\n      boosts: 0,\n      pump: 0,\n",
  },
  {
    file: "src/scanner.ts",
    what: "boosts optional leg",
    anchor:
      "      // GMGN trending discovery — momentum-ranked candidates with GMGN's\n",
    replacement: [
      "      // DexScreener boosted tokens — the newest PAID promotion slots. The",
      "      // one discovery list that is keyless AND disjoint from the profiles",
      "      // feed (2026-09-25: 19 Solana rows, zero overlap with the profiles",
      "      // feed's 16 in the same minute), on the same host so it shares that",
      "      // rate-limit bucket instead of opening a new one. Rows carry no",
      "      // metrics and no timestamps: the age comes from the pair.",
      "      // Sized by DEXSCREENER_BOOSTS_LIMIT (0 = disabled); best-effort — a",
      "      // failure is [] and the tick continues.",
      "      let boostProfiles: TokenProfile[] = [];",
      "      if (",
      "        this.dex &&",
      "        this.config.dexscreenerBoostsLimit > 0 &&",
      "        !dropOptionalLeg(\"boosts\")",
      "      ) {",
      "        feedJobs.push(",
      "          this.fetchFeedCapped(",
      "            async () => this.dex!.fetchBoostedTokens(this.config.dexscreenerBoostsLimit),",
      "            [],",
      "            feedDeadline,",
      "          )",
      "            .then((p) => {",
      "              boostProfiles = p;",
      "              diag.boosts = p.length;",
      "            })",
      "            .catch((err: unknown) => {",
      "              console.error(",
      "                \"[scanner] dexscreener boosts feed failed:\",",
      "                err instanceof Error ? err.message : err,",
      "              );",
      "            }),",
      "        );",
      "      }",
      "      // GMGN trending discovery — momentum-ranked candidates with GMGN's",
      "",
    ].join("\n"),
  },
  {
    file: "src/scanner.ts",
    what: "boostMints dedupe set",
    anchor: "      const geoTrendMints = new Set(geoTrendProfiles.map((p) => p.tokenAddress));\n",
    replacement:
      "      const geoTrendMints = new Set(geoTrendProfiles.map((p) => p.tokenAddress));\n" +
      "      const boostMints = new Set(boostProfiles.map((p) => p.tokenAddress));\n",
  },
  {
    file: "src/scanner.ts",
    what: "discoveredVia attribution",
    anchor: "        ...geoTrendProfiles.map((p) => [p.tokenAddress, \"geoTrend\"] as const),\n",
    replacement:
      "        ...geoTrendProfiles.map((p) => [p.tokenAddress, \"geoTrend\"] as const),\n" +
      "        ...boostProfiles.map((p) => [p.tokenAddress, \"boosts\"] as const),\n",
  },
  {
    file: "src/scanner.ts",
    what: "feedProfiles merge (boosts after geoTrend, before gmgn)",
    anchor: [
      "        ...gmgnProfiles.filter(",
      "          (p) =>",
      "            !dexMints.has(p.tokenAddress) &&",
      "            !pumpMints.has(p.tokenAddress) &&",
      "            !geckoMints.has(p.tokenAddress) &&",
      "            !geoTrendMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
    replacement: [
      "        ...boostProfiles.filter(",
      "          (p) =>",
      "            !dexMints.has(p.tokenAddress) &&",
      "            !pumpMints.has(p.tokenAddress) &&",
      "            !geckoMints.has(p.tokenAddress) &&",
      "            !geoTrendMints.has(p.tokenAddress),",
      "        ),",
      "        ...gmgnProfiles.filter(",
      "          (p) =>",
      "            !dexMints.has(p.tokenAddress) &&",
      "            !pumpMints.has(p.tokenAddress) &&",
      "            !geckoMints.has(p.tokenAddress) &&",
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !boostMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
  },
  {
    file: "src/scanner.ts",
    what: "jup filter also drops boost mints",
    anchor: [
      "        ...jupProfiles.filter(",
      "          (p) =>",
      "            !dexMints.has(p.tokenAddress) &&",
      "            !pumpMints.has(p.tokenAddress) &&",
      "            !geckoMints.has(p.tokenAddress) &&",
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
    replacement: [
      "        ...jupProfiles.filter(",
      "          (p) =>",
      "            !dexMints.has(p.tokenAddress) &&",
      "            !pumpMints.has(p.tokenAddress) &&",
      "            !geckoMints.has(p.tokenAddress) &&",
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !boostMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
  },
  {
    file: "src/scanner.ts",
    what: "jupTrend filter also drops boost mints",
    anchor: [
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress) &&",
      "            !jupMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
    replacement: [
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !boostMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress) &&",
      "            !jupMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
  },
  {
    file: "src/scanner.ts",
    what: "meteora filter also drops boost mints",
    anchor: [
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress) &&",
      "            !jupMints.has(p.tokenAddress) &&",
      "            !jupTrendMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
    replacement: [
      "            !geoTrendMints.has(p.tokenAddress) &&",
      "            !boostMints.has(p.tokenAddress) &&",
      "            !gmgnMints.has(p.tokenAddress) &&",
      "            !axiomMints.has(p.tokenAddress) &&",
      "            !jupMints.has(p.tokenAddress) &&",
      "            !jupTrendMints.has(p.tokenAddress),",
      "        ),",
      "",
    ].join("\n"),
  },
];

let failed = false;
for (const patch of patches) {
  const text = fs.readFileSync(patch.file, "utf8");
  const hits = text.split(patch.anchor).length - 1;
  if (hits !== 1) {
    console.error(
      `${hits === 0 ? "MISS" : "AMBIGUOUS"} ${patch.file}: ${patch.what} (${hits} hits)`,
    );
    failed = true;
    continue;
  }
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
