#!/usr/bin/env node
/**
 * Make /debug/pool say which floors it applied, and mirror the scanner fully.
 *
 * The probe was pruning at minMcap / 2 with NO liquidity floor and NO ceiling,
 * so its poolQueryCount was an inflated upper bound and no floor change could be
 * read off it. It now applies the same three filters as the scanner's pool query
 * AND echoes them in the response, so a live reading can be checked against
 * src/scanner.ts instead of taken on trust.
 *
 * Anchored + marker-guarded + idempotent.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function sub(file, label, anchor, replacement, marker) {
  const target = path.join(root, file);
  const src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${file} :: ${label} (already applied)`);
    return;
  }
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${file} :: ${label} — anchor hits = ${hits} (want 1)`);
    failures += 1;
    return;
  }
  fs.writeFileSync(target, src.replace(anchor, () => replacement));
  console.log(`✓ ${file} :: ${label}`);
}

sub(
  "src/worker.ts",
  "the liquidity ratio import",
  'import { Scanner, forgetDeferredTokens, POOL_MCAP_PRUNE_RATIO } from "./scanner";',
  'import {\n  Scanner,\n  forgetDeferredTokens,\n  POOL_MCAP_PRUNE_RATIO,\n  POOL_LIQUIDITY_PRUNE_RATIO,\n} from "./scanner";',
  "POOL_LIQUIDITY_PRUNE_RATIO,\n} from \"./scanner\";",
);

sub(
  "src/worker.ts",
  "the floors, computed once",
  `      let poolQueryBuckets: Record<string, number> | null = null;
      let poolQueryCount = 0;`,
  `      let poolQueryBuckets: Record<string, number> | null = null;
      let poolQueryCount = 0;
      // The floors this probe applies — computed once, ECHOED in the response
      // (2026-09-28). Until then the probe pruned at minMcap / 2 (half the
      // scanner's ratio) with no liquidity floor and no ceiling, so its
      // poolQueryCount was an inflated upper bound and no floor change could be
      // read off this endpoint at all. It now mirrors the scanner's pool query
      // and names the floors it used, which is what makes a live reading
      // checkable against src/scanner.ts instead of taken on trust.
      // (Empty chat list → 0 = "no floor", rather than Math.min of nothing.)
      const poolMinMcapUsd = chats.length
        ? Math.min(...chats.map((c) => c.minMarketCapUsd))
        : 0;
      const poolMaxMcapUsd = chats.length
        ? Math.max(...chats.map((c) => c.maxMarketCapUsd))
        : 0;
      const poolMinLiquidityUsd = chats.length
        ? Math.min(...chats.map((c) => c.minLiquidityUsd))
        : 0;`,
  "const poolMinLiquidityUsd = chats.length",
);

sub(
  "src/worker.ts",
  "the probe's filters",
  `        const minMcap = Math.min(...chats.map((c) => c.minMarketCapUsd));`,
  `        const minMcap = poolMinMcapUsd;`,
  "        const minMcap = poolMinMcapUsd;",
);

sub(
  "src/worker.ts",
  "the liquidity floor + ceiling the probe was missing",
  `          minQualifyMcap: minMcap * POOL_MCAP_PRUNE_RATIO,
          seenChatIds,`,
  `          minQualifyMcap: minMcap * POOL_MCAP_PRUNE_RATIO,
          // The scanner's other two pool filters, mirrored so this count is
          // comparable to the tick's: the ceiling (its literal 2, matching
          // src/scanner.ts's maxQualifyMcap) drops the pump-and-dump corpses
          // that rank FIRST under the signal ordering, and the liquidity floor
          // drops the dead-liquidity ones — both otherwise inflate this count.
          maxQualifyMcap: poolMaxMcapUsd * 2,
          minQualifyLiquidity: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,
          seenChatIds,`,
  "minQualifyLiquidity: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,\n          seenChatIds,",
);

sub(
  "src/worker.ts",
  "the echoed floors",
  `        poolLimit: 1000,
        poolQueryCount,
        poolQueryBuckets,
      });`,
  `        poolLimit: 1000,
        poolQueryCount,
        poolQueryBuckets,
        // Which floors produced poolQueryCount (see the comment above them):
        // a live reading shows the ratios the DEPLOYED code is pruning at.
        mcapPruneRatio: POOL_MCAP_PRUNE_RATIO,
        mcapFloorUsd: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,
        mcapCeilingUsd: poolMaxMcapUsd * 2,
        liquidityPruneRatio: POOL_LIQUIDITY_PRUNE_RATIO,
        liquidityFloorUsd: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,
      });`,
  "mcapPruneRatio: POOL_MCAP_PRUNE_RATIO,",
);

sub(
  "scripts/test-unit.js",
  "the probe-mirror pins",
  `    assert.ok(
      !workerSrc.includes("minQualifyMcap:minMcap/2,"),
      "the probe's old minMcap/2 floor (looser than production) must be gone",
    );`,
  `    assert.ok(
      !workerSrc.includes("minQualifyMcap:minMcap/2,"),
      "the probe's old minMcap/2 floor (looser than production) must be gone",
    );
    // The probe's count is only comparable to the tick's if it applies the same
    // three filters the scanner does, and only checkable if it says so.
    assert.ok(
      workerSrc.includes("maxQualifyMcap:poolMaxMcapUsd*2,") &&
        workerSrc.includes(
          "minQualifyLiquidity:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,",
        ),
      "/debug/pool must mirror the ceiling and the liquidity floor too, not just the mcap floor",
    );
    assert.ok(
      workerSrc.includes("mcapPruneRatio:POOL_MCAP_PRUNE_RATIO,") &&
        workerSrc.includes("mcapFloorUsd:poolMinMcapUsd*POOL_MCAP_PRUNE_RATIO,") &&
        workerSrc.includes(
          "liquidityFloorUsd:poolMinLiquidityUsd*POOL_LIQUIDITY_PRUNE_RATIO,",
        ),
      "the endpoint must echo the floors it applied, or a live reading cannot be checked",
    );`,
  "the endpoint must echo the floors it applied",
);

console.log(failures === 0 ? "\nall edits applied" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
