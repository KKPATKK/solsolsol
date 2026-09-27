#!/usr/bin/env node
/*
 * APPLY (idempotent): append §4.42 to docs/round-trips.md — the init-boot
 * self-heal (see docs/patches/init-boot-heal-2026-09-27.apply.js).
 *
 * The section text lives in docs/patches/round-trips-4.42-2026-09-27.md rather
 * than inline: it is prose full of BACKTICKS, and a JS template literal here
 * eats them (the first version of this script died on a SyntaxError halfway
 * through a table).
 *
 * Run: node docs/patches/init-boot-heal-doc-2026-09-27.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "round-trips.md");
const SECTION_FILE = path.join(__dirname, "round-trips-4.42-2026-09-27.md");
const HEADING = "## 4.42 ";

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes(HEADING)) {
    console.log("= §4.42: already applied");
    process.exit(0);
  }
  const section = fs.readFileSync(SECTION_FILE, "utf8").replace(/\s*$/, "\n");
  const out = `${original.replace(/\s*$/, "")}\n\n${section}`;
  fs.writeFileSync(FILE, out);
  const written = fs.readFileSync(FILE, "utf8");
  const n = written.split(HEADING).length - 1;
  console.log(`✓ §4.42: applied (${original.length} -> ${out.length} bytes), heading x${n}`);
  process.exit(n === 1 ? 0 : 1);
}

main();
