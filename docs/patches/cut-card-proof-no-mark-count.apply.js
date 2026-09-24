#!/usr/bin/env node
/**
 * Bump the recorded unit-test count for the no-mark dedupe change.
 *
 * Kept in its own script because docs/round-trips.md is edited through node:
 * the file tool mangles some CJK in MATCH strings (observed: 嗰 came back as
 * 嚹, so the anchor never matched) while fs.readFile/writeFile round-trips the
 * bytes exactly. Same verify-then-write discipline as the others.
 *
 * Run: node docs/patches/cut-card-proof-no-mark-count.apply.js
 */
const fs = require("fs");
const path = require("path");

const T = path.join(__dirname, "..", "round-trips.md");
const lines = (...xs) => xs.join("\n");

const OLD = lines(
  "* `node scripts/test-unit.js` → **300 passed, 0 failed** ✅（§4.5.3.1 新增 1 條 cold-handle test；",
  "  再之前 299 —— §4.5.3 嗰 3 條 pre-init arrival test；296 —— §17.6 嗰 3 條 row-span-hold test；",
  "  295 ＝ §4.7 嗰 1 條 grouped-telemetry test；",
);
const NEW = lines(
  "* `node scripts/test-unit.js` → **302 passed, 0 failed** ✅（§十九（duplicate-cards）新增 2 條 no-mark",
  "  dedupe test；再之前 300 —— §4.5.3.1 嗰 1 條 cold-handle test；299 —— §4.5.3 嗰 3 條 pre-init arrival",
  "  test；296 —— §17.6 嗰 3 條 row-span-hold test；295 ＝ §4.7 嗰 1 條 grouped-telemetry test；",
);

const text = fs.readFileSync(T, "utf8");
if (text.includes("**302 passed, 0 failed** ✅（§十九")) {
  console.log("ALREADY   §5 test count");
  process.exit(0);
}
const at = text.indexOf(OLD);
if (at < 0) {
  console.error("MISS      §5 test count");
  process.exit(1);
}
if (text.indexOf(OLD, at + 1) >= 0) {
  console.error("AMBIGUOUS §5 test count");
  process.exit(1);
}
fs.writeFileSync(T, text.replace(OLD, NEW));
console.log("ok        §5 test count → 302");
