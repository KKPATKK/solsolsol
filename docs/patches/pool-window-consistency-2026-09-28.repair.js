#!/usr/bin/env node
/*
 * One-off repair for pool-window-consistency-2026-09-28.apply.js:
 * its test-unit.js anchor kept the anchor line, so a second run inserted the
 * pinned test twice, and a str_replace left a mangled comment in it.
 *
 * Deletes the duplicate copy and rewrites the comment. Idempotent.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let text = fs.readFileSync(file, "utf8");

const startMarker = '  await test(\n    "pool window (2026-09-28)';
const endMarker = '  console.log("\\n===== UNIT TESTS =====");';

const positions = [];
for (let i = text.indexOf(startMarker); i !== -1; i = text.indexOf(startMarker, i + 1)) {
  positions.push(i);
}
console.log(`copies of the pinned test: ${positions.length}`);

if (positions.length > 1) {
  const end = text.indexOf(endMarker);
  if (end < 0) throw new Error("end marker not found");
  text = text.slice(0, positions[1]) + text.slice(end);
  console.log(`removed ${positions.length - 1} duplicate copy/copies`);
}

const bad =
  "      // ...and no instrument restates them any more. A local const X = ... is\n" +
  "      // the exact shape of the drift this pin prevents (cpu-profile.js ran\n" +
  "      // 43h/30min for as long as it existed:\n" +
  "      // a wider pool than the tick, silently, for as long as it existed).";
const good =
  "      // ...and no instrument restates them any more. A local const X = ... is\n" +
  "      // the exact shape of the drift this pin prevents: cpu-profile.js measured\n" +
  "      // a wider pool than the tick, silently, for as long as it existed.";

if (text.includes(bad)) {
  text = text.split(bad).join(good);
  console.log("rewrote the mangled comment");
} else {
  console.log("comment already clean");
}

fs.writeFileSync(file, text);

const after = fs.readFileSync(file, "utf8");
const copies = after.split(startMarker).length - 1;
console.log(copies === 1 ? "\nOK: exactly one copy" : `\nFAILED: ${copies} copies`);
process.exit(copies === 1 ? 0 : 1);
