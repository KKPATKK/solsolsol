#!/usr/bin/env node
/**
 * §4.30 had one stray open parenthesis (the sentence read
 * "所以 guard（... 釘死 60。"). The file tool refuses CJK anchors of this shape,
 * so the fix goes through node's own replace, with the count asserted first.
 *
 * Run: node docs/patches/round5-dex-listcache-docs-fix-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "docs", "round-trips.md");
const src = fs.readFileSync(file, "utf8");
const old = "所以 guard（`scripts/test-deferred-priority.js` 釘死 60。";
const next = "所以個 guard（`scripts/test-deferred-priority.js`）照樣釘死 60：";

const n = src.split(old).length - 1;
if (n !== 1) {
  console.error(`✗ anchor matched ${n} times, need exactly 1 — nothing written`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(old, next));
console.log("✓ docs/round-trips.md: §4.30 parenthesis fixed");
