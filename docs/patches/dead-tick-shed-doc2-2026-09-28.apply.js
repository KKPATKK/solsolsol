#!/usr/bin/env node
/**
 * 2026-09-28 — append §4.45a (the measured rollback of change A) to
 * docs/round-trips.md, from the fragment next to this script.
 *
 * Run: node docs/patches/dead-tick-shed-doc2-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const doc = path.join(__dirname, "..", "round-trips.md");
const fragment = path.join(__dirname, "round-trips-4.45a-2026-09-28.md");
const marker = "### 4.45a 補正";

let text = fs.readFileSync(doc, "utf8");
if (!text.includes(marker)) {
  const add = fs.readFileSync(fragment, "utf8").replace(/^\s*\n/, "");
  text = text.replace(/\s*$/, "\n\n") + add.replace(/\s*$/, "\n");
  console.log("✓ appended §4.45a to docs/round-trips.md");
  fs.writeFileSync(doc, text);
}
console.log("done — docs/round-trips.md has", text.split("\n").length, "lines");
