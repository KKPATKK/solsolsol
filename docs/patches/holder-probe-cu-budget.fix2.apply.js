#!/usr/bin/env node
/**
 * Sibling of docs/patches/holder-probe-cu-budget.apply.js: the CU section it
 * points at is §4.4 in docs/round-trips.md (the doc keeps its sections in
 * numeric order, and "未做" moves to §4.5). Same discipline: exactly one match
 * or nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const old = "        // CU GATE (see docs/round-trips.md §4.5): a probe is BILLED whether or";
const next = "        // CU GATE (see docs/round-trips.md §4.4): a probe is BILLED whether or";

let text = fs.readFileSync(PW, "utf8");
const at = text.indexOf(old);
if (at < 0) {
  console.error("MISS      pw: the CU section reference");
  process.exit(1);
}
if (text.indexOf(old, at + 1) >= 0) {
  console.error("AMBIGUOUS pw: the CU section reference");
  process.exit(1);
}
text = text.slice(0, at) + next + text.slice(at + old.length);
fs.writeFileSync(PW, text);
console.log("ok        pw: the CU section reference");
