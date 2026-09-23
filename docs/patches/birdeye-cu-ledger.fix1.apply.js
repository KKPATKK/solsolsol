#!/usr/bin/env node
/**
 * Fix 1 for birdeye-cu-ledger.apply.js: the ledger block was inserted AFTER
 * the `recordDex429` doc comment, which left that comment (the "is 250ms
 * spacing safe?" monitor) describing the CU ledger and left recordDex429
 * undocumented. Move the block above the comment so each doc comment sits on
 * the thing it describes.
 *
 * Pure text move, verified by index, no-op if the expected shape is not found.
 */
const fs = require("fs");

const W = "src/worker.ts";
const C429 = [
  "/**",
  " * Cross-isolate 429 bookkeeping: the scan that trips DexScreener's batched",
  " * limit may run in any isolate, so the count lives in Turso while this",
  " * module-local mirror keeps /health from reading it twice per request. This",
  ' * is the "is 250ms spacing safe?" monitor for DEX_REQUEST_INTERVAL_MS —',
  " * fired from the client's hook, never from the scan's critical path.",
  " */",
  "",
].join("\n");

const text = fs.readFileSync(W, "utf8");
const mineStart = text.indexOf("/**\n * Durable Birdeye CU ledger.");
const fnStart = text.indexOf("async function recordDex429");
if (mineStart < 0) {
  console.error("MISS: the ledger block");
  process.exit(1);
}
if (fnStart < 0 || mineStart > fnStart) {
  console.error("MISS: recordDex429 after the ledger block");
  process.exit(1);
}
const before = text.slice(0, mineStart);
if (!before.endsWith(C429)) {
  console.error("MISS: the 429 comment is not immediately before the ledger block");
  process.exit(1);
}
const mine = text.slice(mineStart, fnStart);
if (mine.indexOf("/**\n * Cross-isolate 429 bookkeeping") >= 0) {
  console.error("AMBIGUOUS: the 429 comment is already inside the ledger block");
  process.exit(1);
}

const next =
  before.slice(0, before.length - C429.length) + mine + C429 + text.slice(fnStart);
if (next === text) {
  console.error("MISS: nothing changed");
  process.exit(1);
}
fs.writeFileSync(W, next);
console.log("ok: the ledger block now precedes the 429 comment");
