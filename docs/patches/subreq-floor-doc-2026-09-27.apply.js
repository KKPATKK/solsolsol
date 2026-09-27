#!/usr/bin/env node
/*
 * APPLY (idempotent): append §4.43 to docs/round-trips.md — the `subreqSkip`
 * drop-rate baseline (see docs/patches/subreq-skip-read-2026-09-27.read.js).
 *
 * Same shape as the §4.42 applier: the section text lives next to this script
 * (it is prose full of backticks and a SQL-ish block, which a JS template
 * literal here would eat), and the write is skipped when the heading is already
 * there.
 *
 * Run: node docs/patches/subreq-floor-doc-2026-09-27.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "round-trips.md");
const SECTION_FILE = path.join(__dirname, "round-trips-4.43-2026-09-27.md");
const HEADING = "## 4.43 ";

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes(HEADING)) {
    console.log("= §4.43: already applied");
    process.exit(0);
  }
  const section = fs.readFileSync(SECTION_FILE, "utf8").replace(/\s*$/, "\n");
  const out = `${original.replace(/\s*$/, "")}\n\n${section}`;
  fs.writeFileSync(FILE, out);
  const written = fs.readFileSync(FILE, "utf8");
  const n = written.split(HEADING).length - 1;
  console.log(`✓ §4.43: applied (${original.length} -> ${out.length} bytes), heading x${n}`);
  process.exit(n === 1 ? 0 : 1);
}

main();
