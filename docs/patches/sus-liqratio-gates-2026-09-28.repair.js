/**
 * Repair for src/scanner.ts after docs/patches/sus-liqratio-gates-2026-09-28.apply.js
 * (2026-09-28).
 *
 * Two defects, both caught by `npm run typecheck`, neither shipped:
 *
 *  1. The apply script inserted the Jupiter-suspicion gate TWICE. Its
 *     "already applied" test required the ANCHOR to have disappeared, but
 *     every replacement in that script is anchor+addition, so the anchor was
 *     still present on the second run and the edit re-applied. (The script's
 *     test is fixed in the same commit so a third run cannot repeat it.)
 *  2. The ratio counter's extra division sits inside `if (ratioReason)`, and a
 *     truthy reason does not narrow `liquidityUsd` — TS18047 "possibly null".
 *     Fixed by guarding the whole block on `liquidityUsd !== null` instead of
 *     threading a null through a ternary.
 *
 * Both edits assert their own preconditions and refuse to write otherwise.
 * Idempotent: re-running a repaired file reports "already repaired".
 *
 * Usage: node docs/patches/sus-liqratio-gates-2026-09-28.repair.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(FILE, "utf8");
const before = src;

// ---------------------------------------------------------------- 1. dedupe
const GATE_MARK = "        // Jupiter suspicion gate (audit.isSus) — the only vendor-supplied";
const first = src.indexOf(GATE_MARK);
const second = src.indexOf(GATE_MARK, first + 1);
if (first === -1) {
  console.error("REFUSING: the Jupiter-suspicion gate is missing entirely");
  process.exit(1);
}
if (second !== -1) {
  const span = second - first;
  const a = src.slice(first, second);
  const b = src.slice(second, second + span);
  if (a !== b) {
    console.error("REFUSING: the two gate copies are not identical spans");
    process.exit(1);
  }
  // A third copy would mean the last one is not a trailing duplicate.
  if (src.indexOf(GATE_MARK, second + 1) !== -1) {
    console.error("REFUSING: more than two gate copies");
    process.exit(1);
  }
  src = src.slice(0, second) + src.slice(second + span);
  console.log(`removed a duplicate gate block (${span} bytes)`);
}

// ------------------------------------------------- 2. liquidityUsd narrowing
const OLD = `        const ratioReason =
          liquidityUsd === null
            ? null
            : mcapRatioBlockReason(
                pair.marketCap,
                liquidityUsd,
                this.config.mcapLiqRatioMax,
                this.config.mcapLiqRatioMin,
              );
        if (ratioReason) {
          // Route the counter to the side that fired. The decision itself
          // stays the helper's (one source of truth); this extra division only
          // picks the reading, because the two floors are tuned independently —
          // the HIGH side is the Nudaeng shape this gate has always had, the
          // LOW side is the LP-heavy shape added 2026-09-28.
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
        }`;

const NEW = `        if (liquidityUsd !== null) {
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
        }`;

if (src.includes(OLD)) {
  const parts = src.split(OLD);
  if (parts.length !== 2) {
    console.error(`REFUSING: the ratio block matched ${parts.length - 1} times`);
    process.exit(1);
  }
  src = parts.join(NEW);
  console.log("guarded the ratio block on liquidityUsd !== null");
} else if (!src.includes(NEW)) {
  console.error("REFUSING: neither the old nor the new ratio block is present");
  process.exit(1);
} else {
  console.log("ratio block already guarded");
}

// ------------------------------------------- 3. blank line after the helper
// Cosmetic: the inserted helper ran straight into gateLiquidityUsd's doc
// comment. Top-level declarations in this file are separated by one blank line.
const TIGHT = `  return \`Jupiter 標記可疑（audit.isSus\${dev}）\`;\n}\n/**\n * The liquidity reading a USD-level rule HERE may judge`;
const LOOSE = `  return \`Jupiter 標記可疑（audit.isSus\${dev}）\`;\n}\n\n/**\n * The liquidity reading a USD-level rule HERE may judge`;
if (src.includes(TIGHT)) {
  if (src.split(TIGHT).length !== 2) {
    console.error("REFUSING: the tight helper/comment seam matched more than once");
    process.exit(1);
  }
  src = src.split(TIGHT).join(LOOSE);
  console.log("added the blank line after jupSusBlockReason");
} else {
  console.log("blank line already present");
}

if (src === before) {
  console.log("no change needed (already repaired)");
  process.exit(0);
}
fs.writeFileSync(FILE, src);
console.log("repaired src/scanner.ts");
