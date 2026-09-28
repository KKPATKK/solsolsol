/*
 * The dex list-cache suite pins the ORDER "the pool phase is read before the
 * ledger journal" by looking for the call site text `getReevalPoolCached(now`.
 * The Tier 1 overlap moved that call into the early dispatch (it now passes the
 * dispatch-time clock), so the pin's needle has to move with it — the property
 * it guards is unchanged and still holds (the pool read is dispatched even
 * EARLIER now).
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "..", "scripts", "test-dex-list-cache.js");
let src = fs.readFileSync(p, "utf8");

const OLD = `      ["the pool phase", order("getReevalPoolCached(now")],`;
const NEW = `      ["the pool phase", order("getReevalPoolCached(poolNow")],`;

if (src.includes(NEW)) {
  console.log("= already applied");
  process.exit(0);
}
if (!src.includes(OLD)) {
  console.log("✗ anchor not found");
  process.exit(1);
}
src = src.replace(OLD, () => NEW);
fs.writeFileSync(p, src);
console.log("✓ the pool-phase pin follows the dispatch call site");
