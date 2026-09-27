#!/usr/bin/env node
/*
 * Follow-up to tracker-own-invocation-2026-09-27.apply.js: the isTrackerCron
 * doc comment spelled the alternate cron expression literally, and the
 * terminator inside a block comment closed it — worker.ts then failed to parse
 * from that line on (tsc: TS1109 "Expression expected", then a cascade).
 *
 * Two idempotent steps:
 *  1. drop the literal expression from the prose (keeping the point: inner
 *     spacing differences are not this trigger);
 *  2. delete the prose line the first step left duplicated.
 *
 * Run: node docs/patches/tracker-own-invocation-comment-fix-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(file, "utf8");

// 1. The literal that closed the comment, and the sentence carrying it.
src = src
  .split(" * expression exactly, so an expression that differs inside (`*/1  *  *  *  *`)\n")
  .join(" * expression exactly (so an expression whose INNER spacing differs is a\n");
// 2. That sentence sat on the next line too, and step 1's replacement ends with
//    the same words: keep the line that carries the rest of the sentence.
src = src.replace(
  / \* trigger this Worker does not claim\)\n \* is a trigger this Worker does not claim — /,
  " * trigger this Worker does not claim — ",
);

const want =
  " * Trims only the OUTSIDE of the string: the platform matches its configured\n" +
  " * expression exactly (so an expression whose INNER spacing differs is a\n" +
  " * trigger this Worker does not claim — and defaulting those to the pass\n";
if (!src.includes(want)) {
  throw new Error("the comment does not read the way this patch expects — refusing to write");
}
if (src === fs.readFileSync(file, "utf8")) {
  console.log(" = already applied");
  process.exit(0);
}
fs.writeFileSync(file, src);
if (!fs.readFileSync(file, "utf8").includes(want)) {
  throw new Error("the write did not verify");
}
console.log(" ✓ worker: isTrackerCron's comment no longer closes itself — patched");
