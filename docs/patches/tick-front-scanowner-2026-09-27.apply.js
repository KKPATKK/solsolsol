#!/usr/bin/env node
/*
 * Follow-up to docs/patches/tick-front-2026-09-27.apply.js.
 *
 * The conditional slice asks the SCANNER for its answer inside the closure the
 * scan is handed, and `scanner` is a module-level `let` — TS cannot keep the
 * call site's narrowing inside a closure that may run later
 * (TS18047: 'scanner' is possibly 'null'), which is exactly why the original
 * one-liner never touched it. The fix is the call site's own local: one
 * capture, taken where the narrowing holds, so the call and the probe are
 * demonstrably the same scanner.
 *
 * (A null scanner here is unreachable anyway — the tick returned before this
 * point — but a non-null assertion would hide a future change in that guard.)
 *
 * Run: node docs/patches/tick-front-scanowner-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
const src = fs.readFileSync(file, "utf8");

if (src.includes("const scanOwner = scanner;")) {
  console.log(" = already applied");
  process.exit(0);
}

const find = `        scanner.runOnce(() =>
          scanSubreqLeft(
            subreqRemaining(),
            scanner.trackerPassSlice(`;
const replace = `        // ONE capture for both halves: the call and the slice probe must be the
        // same scanner, and TS cannot keep this call site's narrowing inside a
        // closure that outlives it (a null scanner is unreachable here — the
        // tick's own guard returned before this point).
        const scanOwner = scanner;
        scanOwner.runOnce(() =>
          scanSubreqLeft(
            subreqRemaining(),
            scanOwner.trackerPassSlice(`;

const count = src.split(find).length - 1;
if (count !== 1) {
  throw new Error(`anchor matched ${count} times in src/worker.ts (want exactly 1)`);
}
fs.writeFileSync(file, src.replace(find, replace));
if (!fs.readFileSync(file, "utf8").includes("const scanOwner = scanner;")) {
  throw new Error("the write did not verify");
}
console.log(" ✓ worker: the slice probe reaches the scanner through a local — patched");
