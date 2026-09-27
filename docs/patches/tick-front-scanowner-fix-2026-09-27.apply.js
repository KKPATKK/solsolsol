#!/usr/bin/env node
/*
 * Fix for docs/patches/tick-front-scanowner-2026-09-27.apply.js: the capture
 * landed INSIDE the `Promise.race([ ... ])` array literal, where a `const`
 * statement is a syntax error (TS1137). A capture has to precede the array.
 *
 * Run: node docs/patches/tick-front-scanowner-fix-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(file, "utf8");
const before = src;

// 1. Lift the statement out of the array.
const inArray = `        // ONE capture for both halves: the call and the slice probe must be the
        // same scanner, and TS cannot keep this call site's narrowing inside a
        // closure that outlives it (a null scanner is unreachable here — the
        // tick's own guard returned before this point).
        const scanOwner = scanner;
        scanOwner.runOnce(() =>`;
if (src.includes(inArray)) {
  src = src.replace(inArray, "        scanOwner.runOnce(() =>");
}

// 2. Put it in front of the race it belongs to.
const anchor = `      await Promise.race([
        // The scan is handed the invocation's remaining allowance so its`;
const lifted = `      // ONE capture for both halves: the call and the slice probe below must be
      // the same scanner, and TS cannot keep this call site's narrowing inside
      // a closure that outlives it (a null scanner is unreachable here — the
      // tick's own guard returned before this point).
      const scanOwner = scanner;
      await Promise.race([
        // The scan is handed the invocation's remaining allowance so its`;
if (!src.includes("const scanOwner = scanner;\n      await Promise.race([" )) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) throw new Error(`race anchor matched ${count} times (want exactly 1)`);
  src = src.replace(anchor, lifted);
}

if (src === before) {
  console.log(" = already applied");
  process.exit(0);
}
fs.writeFileSync(file, src);
const back = fs.readFileSync(file, "utf8");
if (!back.includes("const scanOwner = scanner;\n      await Promise.race([") || back.includes(inArray)) {
  throw new Error("the write did not verify");
}
console.log(" ✓ worker: the capture moved in front of the race — patched");
