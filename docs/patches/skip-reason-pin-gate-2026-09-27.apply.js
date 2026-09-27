// Verify-then-write: gate pin as a slice (comments are not whitespace).
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
  "gate pin by slice",
  `    // The cadence gate: the reason sits with the log line it already printed.
    assert.ok(
      workerSrc.includes('s)\`);noteSkipReason("cron-gate");'),
      "the gate skip says so",
    );`,
  `    // The cadence gate: pinned as a SLICE between the branch's own log line and
    // the arrival write it ends with — comments sit inside that window, so an
    // adjacency pin would be measuring the comments instead of the code.
    const gateAt = workerSrc.indexOf("crontickskipped—lastscanclaimed");
    const gateEnd = workerSrc.indexOf("writeScheduledTick(cronTick)", gateAt);
    assert.ok(gateAt >= 0 && gateEnd > gateAt, "the gate branch is there to pin");
    assert.ok(
      workerSrc.slice(gateAt, gateEnd).includes('noteSkipReason("cron-gate");'),
      "the gate skip says so",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
