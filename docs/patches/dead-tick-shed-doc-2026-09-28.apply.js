#!/usr/bin/env node
/**
 * 2026-09-28 — append §4.45 (the death-driven drain ceiling + the drain moving
 * behind the completion flush) to docs/round-trips.md.
 *
 * The section text lives in round-trips-4.45-2026-09-28.md next to this script:
 * the write tools cannot patch this 3000-line doc in place, and an append is all
 * this needs. Idempotent: the marker is the section's own heading, and a second
 * run only re-checks the blank line in front of it.
 *
 * Run: node docs/patches/dead-tick-shed-doc-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const doc = path.join(__dirname, "..", "round-trips.md");
const fragment = path.join(__dirname, "round-trips-4.45-2026-09-28.md");
const heading = "## 4.45 死亡之後嗰個 tick";

let text = fs.readFileSync(doc, "utf8");
if (!text.includes(heading)) {
  const add = fs.readFileSync(fragment, "utf8").replace(/^\s*\n/, "");
  text = text.replace(/\s*$/, "\n\n") + add.replace(/\s*$/, "\n");
  console.log("✓ appended §4.45 to docs/round-trips.md");
}
// The heading has to start a block of its own (every other section in the doc
// does): a run that appended with no blank line in front gets it here.
const at = text.indexOf("\n" + heading);
if (at !== -1 && text[at - 1] !== "\n") {
  text = text.slice(0, at) + "\n" + text.slice(at);
  console.log("✓ separated §4.45 from the section above it");
}
fs.writeFileSync(doc, text);
console.log("done — docs/round-trips.md has", text.split("\n").length, "lines");
