// Verify-then-write: two assertions in the coalescing tests.
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
  "reserve test: pending is a drain snapshot",
  `    // The queue COALESCES (2026-09-27): three calls of one method are ONE round
    // trip carrying three records, so \`pending\` (calls) and \`owedTokens\`
    // (records) are different readings and the backlog is the second one.
    const queued = writeDrainView();
    assert.equal(queued.pending, 1, "one round trip is owed, not one per call");
    assert.equal(queued.owedTokens, 3, "carrying all three records");`,
  `    // The queue COALESCES (2026-09-27): three calls of one method are ONE round
    // trip carrying three records, so the backlog (records) and the cost (calls)
    // are different readings. \`pending\`/\`owedTokens\` are DRAIN-TIME snapshots —
    // the calls half is pinned by the held case below, where a drain reports it.
    assert.equal(deferredWriteCount(), 3, "three records are owed behind one call");`,
);

patch(
  "coalescing test: records across buckets",
  `    assert.equal(deferredWriteCount(), 2, "two distinct tokens, not four records");`,
  `    assert.equal(
      deferredWriteCount(),
      3,
      "three records across two buckets — two registrations and one raise, not the four calls that were made",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
