#!/usr/bin/env node
/**
 * Round 4 follow-up (2026-09-26): the guard's "patch missing" line prints a
 * real info glyph.
 *
 * The other guards end with `console.log("  ℹ …")`. Round 4's first cut wrote
 * the escape through the patch script, so what landed was the ESCAPE TEXT
 * (`\u2139`) rather than the character — invisible until the day someone
 * reverts the patch and reads the hint. Cosmetic, fixed the same way the strip
 * was: the anchor is built from String.fromCharCode(92), not typed.
 *
 * Run: node docs/patches/round4-mode-giffy-fix-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const hits = (src, needle) => src.split(needle).length - 1;

const BS = String.fromCharCode(92);
const BROKEN = '"  ' + BS + BS + 'u2139 the tick-front mode ride is missing';
const FIXED = '"  ' + BS + 'u2139 the tick-front mode ride is missing';

const problems = [];
const out = new Map();
const src = read("scripts/test-unit.js");
if (src.includes(FIXED + " ")) {
  console.log("skip scripts/test-unit.js: the info glyph is already real");
} else {
  const n = hits(src, BROKEN);
  if (n !== 1) {
    problems.push(`scripts/test-unit.js: the info-glyph anchor matched ${n} times (want exactly 1)`);
  } else {
    out.set("scripts/test-unit.js", src.replace(BROKEN, FIXED));
    console.log("ok   scripts/test-unit.js: the guard's info line prints ℹ, not its escape");
  }
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
