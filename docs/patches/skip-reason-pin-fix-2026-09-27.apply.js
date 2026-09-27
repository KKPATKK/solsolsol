// Verify-then-write: fix the handler pin (comments are not whitespace).
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
  "handler pin",
  `    assert.ok(
      workerSrc.includes(
        'if(!scanner){noteSkipReason("init-no-scanner");preTick.steps.bump=awaitbumpScheduledTickLegacy(env);',
      ),
      "the handler's no-scanner return says so",
    );`,
  `    // (The splice is pinned comment-inclusive: the strip removes whitespace
    // only, so the pinned pair is the reason immediately before the arrival
    // bookkeeping that was the branch's only visible act.)
    assert.ok(
      workerSrc.includes(
        'noteSkipReason("init-no-scanner");preTick.steps.bump=awaitbumpScheduledTickLegacy(env);',
      ),
      "the handler's no-scanner return says so",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
