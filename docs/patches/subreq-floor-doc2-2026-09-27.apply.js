#!/usr/bin/env node
/*
 * APPLY (idempotent): append the §4.43 caveat to docs/round-trips.md.
 *
 * WHY it exists: the §4.43 baseline is a `counted` p50 compared against a line,
 * and the measurement right after that section shipped showed the line is
 * crossed by every tick for the first two ticks after a deploy (cold isolate
 * paying init/boot reads: 33/34 then 21/24 on the same isolate). Without the
 * caveat written down, the next review would read that as the p50 rising past
 * 28 and take the first tuning knob on a false signal.
 *
 * Run: node docs/patches/subreq-floor-doc2-2026-09-27.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "round-trips.md");
const SECTION_FILE = path.join(__dirname, "round-trips-4.43-amendment-2026-09-27.md");
const MARKER = "### 覆檢陷阱：deploy 之後嘅頭 2–3 個 tick 唔可以入基準";

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes(MARKER)) {
    console.log("= §4.43 caveat: already applied");
    process.exit(0);
  }
  const section = fs.readFileSync(SECTION_FILE, "utf8").replace(/\s*$/, "\n");
  const out = `${original.replace(/\s*$/, "")}\n\n${section}`;
  fs.writeFileSync(FILE, out);
  const written = fs.readFileSync(FILE, "utf8");
  const n = written.split(MARKER).length - 1;
  console.log(`✓ §4.43 caveat: applied (${original.length} -> ${out.length} bytes), marker x${n}`);
  process.exit(n === 1 ? 0 : 1);
}

main();
