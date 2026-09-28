/*
 * Fix-ups:
 *
 * 1) The slot replace only matched getReevalPoolBatched: getReevalPool's copy of
 *    the same expression sits at 4-space indentation, so the 6-space anchor
 *    never saw it. Both sites use Db.poolRotationSlot now.
 * 2) The earlier tier-1 test still pinned the OLD poolMs expression
 *    (Date.now() at the join), which tier1-poolms-metric-fix replaced with the
 *    promise's own timing.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const dbPath = path.join(ROOT, "src", "db.ts");
const testPath = path.join(ROOT, "scripts", "test-unit.js");

const edits = [];
let failed = 0;

function edit(file, name, from, to) {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(to) && !src.includes(from)) {
    edits.push(["=", `${name} (already applied)`]);
    return;
  }
  const n = src.split(from).length - 1;
  if (n !== 1) {
    edits.push(["✗", `${name} — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = src.replace(from, () => to);
  fs.writeFileSync(file, src);
  edits.push(["✓", name]);
}

edit(
  dbPath,
  "db: getReevalPool's slot site (4-space indent)",
  `    const slot = Math.floor(now / (opts.rotationPeriodMs ?? POOL_ROTATION_PERIOD_MS));`,
  `    const slot = poolRotationSlot(now, opts.rotationPeriodMs);`,
);

edit(
  testPath,
  "tests: the poolMs pin follows the promise timing",
  `      assert.ok(
        scannerSrc.includes("diag.poolMs=Date.now()-poolReadStartedAt;"),
        "poolMs still reports the read's own duration",
      );`,
  `      assert.ok(
        scannerSrc.includes("diag.poolMs=poolReadMs;"),
        "poolMs reports the read's own duration (timed on the promise, not the await)",
      );`,
);

for (const [m, n] of edits) console.log(`${m} ${n}`);
if (failed === 0) {
  const db = fs.readFileSync(dbPath, "utf8");
  if (db.split("Math.floor(now / (opts.rotationPeriodMs ?? POOL_ROTATION_PERIOD_MS))").length - 1 !== 0) {
    console.log("✗ refused: the inline slot expression is still in db.ts");
    process.exit(1);
  }
} else {
  console.log("✗ an anchor failed");
}
console.log(`\n${failed === 0 ? "OK" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
