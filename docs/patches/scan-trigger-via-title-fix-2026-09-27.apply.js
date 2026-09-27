#!/usr/bin/env node
/*
 * Cosmetic fix for the test title introduced by
 * docs/patches/scan-trigger-via-tests-2026-09-27.apply.js: the escaping needed
 * to embed a template literal inside that apply script's own template literal
 * left a literal backslash before each backtick in the emitted title. The
 * string still evaluates to the right text (JS collapses the escape), but the
 * source should read like every other title in this file.
 *
 * Both characters are built from char codes on purpose: a backtick or a
 * backslash inside this file's own string literals is what caused the escaping
 * in the first place.
 *
 * Run: node docs/patches/scan-trigger-via-title-fix-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

const BT = String.fromCharCode(96); // `
const BS = String.fromCharCode(92); // \
const tail = " is a parameter, and every call site names its trigger";
const good = "scan trigger attribution: " + BT + "via" + BT + tail;
if (src.includes(good)) {
  console.log(" = title — already applied");
  process.exit(0);
}
// The emitted shape is backslash-before-each-backtick: \`via\`
const bad = "scan trigger attribution: " + BS + BT + "via" + BS + BT + tail;
const count = src.split(bad).length - 1;
if (count !== 1) throw new Error(`title anchor matched ${count} times (want exactly 1)`);
src = src.replace(bad, good);
fs.writeFileSync(file, src);
console.log(" ✓ title — patched");
