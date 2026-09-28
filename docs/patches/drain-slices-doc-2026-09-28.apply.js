#!/usr/bin/env node
/*
 * APPLY (idempotent): append §4.44a (the multi-slice drain) to
 * docs/round-trips.md from docs/patches/round-trips-4.44a-2026-09-28.md.
 *
 * Run: node docs/patches/drain-slices-doc-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const DOC = path.join(__dirname, "..", "round-trips.md");
const FRAGMENT = path.join(__dirname, "round-trips-4.44a-2026-09-28.md");
const MARKER = "### 4.44a 補正：落地要";

const doc = fs.readFileSync(DOC, "utf8");
if (doc.includes(MARKER)) {
  console.log("= docs/round-trips.md: §4.44a already applied");
  process.exit(0);
}
const fragment = fs.readFileSync(FRAGMENT, "utf8");
const out = `${doc.replace(/\s*$/, "")}\n${fragment.replace(/\s*$/, "")}\n`;
fs.writeFileSync(DOC, out);
console.log(`✓ docs/round-trips.md: §4.44a appended (${doc.length} -> ${out.length} bytes)`);
const written = fs.readFileSync(DOC, "utf8");
for (const needle of [MARKER, "DEFERRED_MAX_CALLS_PER_DRAIN = 10"]) {
  const n = written.split(needle).length - 1;
  console.log(`  ${n === 1 ? "✓" : "✗"} ${needle} x${n}`);
}
