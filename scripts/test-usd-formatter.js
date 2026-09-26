/*
 * fmtUsd: the same strings, without a formatter per call (2026-09-26).
 *
 * WHY THIS IS A FILE OF ITS OWN. The change is invisible by construction — the
 * strings are supposed to be identical, and the only thing that moved is how
 * many Intl.NumberFormat objects get built. That makes two failures possible,
 * and neither shows up in a live reading:
 *
 *   1. A STRING CHANGES. The cache is keyed by the option set, so a key
 *      collision (two different shapes sharing a key) would silently format one
 *      branch with the other's options. The table below pins the output of every
 *      branch, and the cross-checks pin that the branches really differ.
 *   2. THE CACHE STOPS CACHING. This is the whole point of the change, and it
 *      is invisible: the strings stay correct while the construction count goes
 *      back up. Counted here by replacing the global constructor before the
 *      module is loaded, so "N calls → at most 4 constructions" is asserted
 *      rather than assumed.
 *
 * Run: node scripts/test-usd-formatter.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

// Counted BEFORE the module is loaded (fmtUsd resolves Intl.NumberFormat at call
// time, so either order works — this one keeps the counting honest).
let constructed = 0;
const RealNumberFormat = Intl.NumberFormat;
Intl.NumberFormat = function CountingNumberFormat(...args) {
  constructed += 1;
  return new RealNumberFormat(...args);
};
const { fmtUsd } = require("../dist/format.js");

/** The branch table: (value, expected string) — every path through fmtUsd. */
const TABLE = [
  [0, "—"],
  [-5, "—"],
  [Number.NaN, "—"],
  [Number.POSITIVE_INFINITY, "—"],
  [0.5, "$0.500000"],
  [1.5, "$1.50"],
  [999.99, "$999.99"],
  [0.00042, "$0.000420"],
  [0.000042, "$0.00004200"],
  [1000, "$1.00K"],
  [1234, "$1.23K"],
  [1234567.89, "$1.23M"],
];

async function main() {
  // FIRST, before anything else has warmed the cache: "one per shape per
  // process" is only observable while the cache is still empty.
  await test("N calls construct at most four formatters, ever", () => {
    constructed = 0;
    for (let round = 1; round <= 20; round++) {
      for (const [value] of TABLE) fmtUsd(value);
    }
    assert.equal(
      constructed,
      4,
      `20 rounds over ${TABLE.length} values (4 shapes) must construct 4 formatters, not ${constructed}: one per shape per process, which is the whole change`,
    );
    // And the count must not move again: a cache that resets, or a call site
    // that bypasses it, shows up here.
    for (let i = 0; i < 50; i++) fmtUsd(i * 7919);
    assert.equal(constructed, 4, "and nothing after it constructs another one");
  });

  await test("every branch keeps its exact string", () => {
    for (const [value, expected] of TABLE) {
      assert.equal(fmtUsd(value), expected, `fmtUsd(${value})`);
    }
  });

  await test("the branches are actually different shapes (no key collision)", () => {
    // If the compact shape and the fixed shape shared a key, these pairs would
    // come back identical — the fix would be wrong and the table above might
    // still pass, depending on which branch built the formatter first.
    assert.notEqual(fmtUsd(1234), fmtUsd(12.34), "compact 4-digit vs fixed 2-decimal");
    assert.notEqual(fmtUsd(0.5), fmtUsd(0.5 * 1000), "fixed 6-decimal vs compact");
    assert.notEqual(fmtUsd(1.5), fmtUsd(0.00000015), "fixed 2 vs fixed 8");
  });

  await test("src/format.ts: no bare `new Intl.NumberFormat` outside the two makers", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "format.ts"), "utf8");
    assert.equal(
      src.split("new Intl.NumberFormat(").length - 1,
      2,
      "the two maker closures are the only constructions — a third one is an uncached call site",
    );
    assert.equal(
      src.split("cachedNumberFormat(").length - 1,
      3,
      "one definition plus exactly two call sites",
    );
    // The keys must be distinct literals, or two shapes share one formatter.
    assert.ok(src.includes('"compact"'), "the compact shape keeps its own key");
    assert.ok(src.includes("`fixed${decimals}`"), "and the three widths are keyed by width");
  });

  console.log(results.join("\n"));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("usd formatter suite crashed:", err);
  process.exit(1);
});
