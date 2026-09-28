#!/usr/bin/env node
/**
 * Fix the one stale comment the 2026-09-28 liquidity-prune raise left behind.
 *
 * `Db.getReevalPool`'s `minQualifyLiquidity` docstring still said the scanner
 * passes "0.6× the widest chat's minLiquidityUsd". That is the LIQUIDITY floor,
 * which is now 0.8 (POOL_LIQUIDITY_PRUNE_RATIO); the still-0.6 floor the reader
 * may be thinking of is the separate MARKET-CAP one (`minQualifyMcap`), two
 * docstrings up. The new text names the constant and disambiguates the two so
 * neither can drift again.
 *
 * Anchored + marker-guarded + idempotent: re-running must print "=", not "✓".
 */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "..", "src", "db.ts");

const ANCHOR = `     * passes 0.6× the widest chat's minLiquidityUsd. Dead-liquidity`;
const MARKER = `Passes POOL_LIQUIDITY_PRUNE_RATIO`;

const REPLACEMENT = `     * Passes POOL_LIQUIDITY_PRUNE_RATIO × the widest chat's
     * minLiquidityUsd (0.8 since 2026-09-28, up from 0.6 — the ratio lives in
     * that one exported constant in src/scanner.ts so this note cannot drift
     * from the value again). This is the LIQUIDITY floor; the MARKET-CAP
     * floor two docstrings up is a separate ratio and is unchanged by that
     * raise. Dead-liquidity`;

if (!fs.existsSync(target)) {
  console.error("✗ src/db.ts not found");
  process.exit(1);
}

const src = fs.readFileSync(target, "utf8");

if (src.includes(MARKER)) {
  console.log("= already applied (marker present) — no change");
  process.exit(0);
}

const hits = src.split(ANCHOR).length - 1;
if (hits === 0) {
  console.error("✗ anchor not found — file drifted, inspect by hand");
  process.exit(1);
}
if (hits > 1) {
  console.error(`✗ anchor is not unique (${hits} hits) — refusing to guess`);
  process.exit(1);
}

fs.writeFileSync(target, src.replace(ANCHOR, REPLACEMENT));
console.log("✓ applied: minQualifyLiquidity docstring now names the constant");
