// Verify-then-write: lease pin as a slice, same discipline as the gate pin.
const fs = require("fs");

const FILE = "scripts/test-unit.js";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
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
  console.log(`✓ ${label}: patched`);
  return true;
}

patch(
  "lease pin by slice",
  `    // The lost cross-isolate lease, right after the log that was its only trace.
    assert.ok(
      workerSrc.includes('holdsthescanlock");noteSkipReason("scan-lock-lost");'),
      "a lost lease says so",
    );`,
  `    // The lost cross-isolate lease: pinned from the log line that used to be its
    // only trace (a comment sits between them, see the gate pin).
    const leaseAt = workerSrc.indexOf("anotherisolateholdsthescanlock");
    assert.ok(leaseAt >= 0, "the lease-lost branch is there to pin");
    assert.ok(
      workerSrc.slice(leaseAt, leaseAt + 400).includes('noteSkipReason("scan-lock-lost");'),
      "a lost lease says so",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
