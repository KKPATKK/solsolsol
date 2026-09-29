/*
 * Repairs for the chain-reject-ring patch (2026-09-29), applied AFTER
 * docs/patches/chain-reject-ring-2026-09-29.apply.js. Both are idempotent.
 *
 * 1. The call-site count in the liqRatio order test lost its backslash on the
 *    way through the patch script's template literal, so the test file carried
 *    `/mcapRatioBlockReason(/g` — an unterminated group, which threw before any
 *    assertion ran. It is a split-based count now: nothing to escape, and a
 *    template literal cannot mangle it again. Both the test file and the patch
 *    script that produced it are fixed, so the script's "already applied" guard
 *    still matches the file it wrote.
 *
 * 2. The ring's size note shipped with a byte estimate that was too precise for
 *    a number nobody measured (the reasons vary in length). Corrected in
 *    src/scanner.ts AND in the patch script, for the same guard reason.
 *
 * Run: node docs/patches/chain-reject-ring-2026-09-29.fix-count.js
 */
const fs = require("fs");
const path = require("path");

const TEST_LINE = `      src.split("mcapRatioBlockReason(").length - 1,`;

for (const rel of [
  "scripts/test-unit.js",
  "docs/patches/chain-reject-ring-2026-09-29.apply.js",
]) {
  const file = path.join(__dirname, "..", "..", rel);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let fixed = 0;
  const out = lines.map((line) => {
    if (line.includes("src.match(/mcapRatioBlockReason")) {
      fixed++;
      return TEST_LINE;
    }
    return line;
  });
  if (fixed === 0) {
    console.log(`  -- ${rel} (count already repaired)`);
    continue;
  }
  fs.writeFileSync(file, out.join("\n"));
  console.log(`  ok ${rel}: ${fixed} line(s) repaired`);
}

const OLD_SIZE =
  " * SIZE: five entries serialize to ~400 bytes on a completion batch that is\n" +
  " * already ~2KB of rejects, so they cost nothing worth measuring.\n";
const NEW_SIZE =
  " * SIZE: five entries serialize to ~0.5KB (the reasons differ in length — the\n" +
  " * flurry line is the long one) on a completion batch that is already ~2KB of\n" +
  " * rejects and 12.4KB in total, so this is the cheapest reading in the batch.\n";

for (const rel of ["src/scanner.ts", "docs/patches/chain-reject-ring-2026-09-29.apply.js"]) {
  const file = path.join(__dirname, "..", "..", rel);
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(OLD_SIZE)) {
    console.log(`  -- ${rel} (size note already corrected)`);
    continue;
  }
  fs.writeFileSync(file, src.split(OLD_SIZE).join(NEW_SIZE));
  console.log(`  ok ${rel}: size note corrected`);
}
