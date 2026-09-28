#!/usr/bin/env node
/*
 * APPLY (idempotent) — compile fix for drain-reserve-2026-09-28.apply.js.
 *
 * The adaptive yield was introduced with `const reserve = ...` INSIDE the drain's
 * try block, while the view that publishes it is built after the `finally`:
 *
 *   src/tickprobe.ts(1024,5): error TS18004: No value exists in scope for the
 *   shorthand property 'reserve'.
 *
 * The declaration hoists to the other per-drain locals (which is also what the
 * empty-queue branch needs: it reports `reserve: 0` without ever resolving one).
 *
 * Run: node docs/patches/drain-reserve-fix-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "tickprobe.ts");

const DECL_OLD = `  // Entries this drain walked past to keep the tracker pass's slice intact.
  let heldForTracker = 0;
  try {`;
const DECL_NEW = `  // Entries this drain walked past to keep the tracker pass's slice intact.
  let heldForTracker = 0;
  // The subrequests this drain leaves for the pass behind it — resolved once,
  // inside the walk below (see drainTrackerReserve), and published either way.
  // Declared with the other per-drain locals: the view is built after the
  // \`finally\`, so a \`const\` inside the try cannot reach it.
  let reserve = 0;
  try {`;

const ASSIGN_OLD = `    const reserve = drainTrackerReserve();
    const ready = owedBuckets();`;
const ASSIGN_NEW = `    reserve = drainTrackerReserve();
    const ready = owedBuckets();`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  let out = original;
  const report = [];
  const replaceOnce = (label, oldText, newText) => {
    const hits = out.split(oldText).length - 1;
    if (hits === 0) {
      const applied = out.includes(newText);
      report.push(`${applied ? "=" : "✗"} ${label}: ${applied ? "already applied" : "ANCHOR MISSING"}`);
      return applied;
    }
    if (hits > 1) {
      report.push(`✗ ${label}: anchor matched ${hits} times — refusing to guess`);
      return false;
    }
    out = out.replace(oldText, newText);
    report.push(`✓ ${label}: applied`);
    return true;
  };
  replaceOnce("hoist the yield declaration", DECL_OLD, DECL_NEW);
  replaceOnce("assign it inside the walk", ASSIGN_OLD, ASSIGN_NEW);

  for (const line of report) console.log(line);
  if (report.some((line) => line.startsWith("✗"))) {
    console.log("\nsrc/tickprobe.ts left UNCHANGED");
    process.exit(1);
  }
  if (out === original) {
    console.log("\nsrc/tickprobe.ts already carries the fix — nothing written");
    return;
  }
  fs.writeFileSync(FILE, out);
  console.log(`\nsrc/tickprobe.ts written (${original.length} -> ${out.length} bytes)`);
  const written = fs.readFileSync(FILE, "utf8");
  for (const needle of ["  let reserve = 0;", "    reserve = drainTrackerReserve();"]) {
    const n = written.split(needle).length - 1;
    console.log(`  ${n === 1 ? "✓" : "✗"} ${needle} x${n}`);
  }
}

main();
