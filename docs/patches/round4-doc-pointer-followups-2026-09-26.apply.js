#!/usr/bin/env node
/**
 * Round 4 doc pointer, second half (2026-09-26): the landing record lists the
 * cosmetic follow-up too.
 *
 * §4.25's landing record names the main patch, the test patch, the strip fix
 * and the guard re-point. The last edit of the round (the guard's info glyph)
 * is a landing script of its own, so it belongs on the same line — the point of
 * that line is that every patch written into the repo is accounted for.
 *
 * Run: node docs/patches/round4-doc-pointer-followups-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const hits = (src, needle) => src.split(needle).length - 1;

const OLD =
  '`docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js`。';
const NEW =
  '`docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js` ＋ `docs/patches/round4-mode-giffy-fix-2026-09-26.apply.js`。';

const problems = [];
const out = new Map();
const src = read("docs/round-trips.md");
if (src.includes("round4-mode-giffy-fix-2026-09-26.apply.js")) {
  console.log("skip docs/round-trips.md: the follow-up is already on the line");
} else {
  const n = hits(src, OLD);
  if (n !== 1) {
    problems.push(`docs/round-trips.md: the landing-record anchor matched ${n} times (want exactly 1)`);
  } else {
    out.set("docs/round-trips.md", src.replace(OLD, NEW));
    console.log("ok   docs/round-trips.md: the landing record lists the last follow-up");
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
