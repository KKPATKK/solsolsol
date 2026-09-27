// MUTATION CHECK (2026-09-27): delete the stale-row retire in worker.ts and
// prove the wiring pin in scripts/test-unit.js fails — i.e. the pin really
// guards the statement, not a coincidence. Restore with:
//   cp /tmp/worker.mut.bak src/worker.ts
// (the backup taken before this run; this script never restores on its own, so
// a failed expectation leaves the mutation visibly in place).
const fs = require("fs");

const FILE = "src/worker.ts";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (!from) {
    console.log(`✗ ${label}: empty anchor`);
    process.exitCode = 1;
    return false;
  }
  if (src.includes(to) && to.length > 0) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: mutated`);
  return true;
}

patch(
  "retire block deleted",
  `        if (db && drainErrorIsStale(writeDrainError, Date.now())) {
          const retiring = db
            .setWorkerState(WRITE_DRAIN_ERROR_KEY, "")
            .catch(() => undefined);
          try {
            ctx.waitUntil(retiring);
          } catch {
            // A caller without a live context (tests) must not see a rejection.
            void retiring;
          }
        }
`,
  "",
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE}`);
}
