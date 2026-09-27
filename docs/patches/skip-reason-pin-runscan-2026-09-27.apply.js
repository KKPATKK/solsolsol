// Verify-then-write: runScan pin (the comment before the reason broke the splice).
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
  "runScan pin",
  `    // runScan's own guard (the HTTP/manual path).
    assert.ok(
      workerSrc.includes('via:ScanTrigger="cron",):Promise<void>{if(!scanner){noteSkipReason("init-no-scanner");return;}'),
      "runScan's guard says so",
    );`,
  `    // runScan's own guard (the HTTP/manual path). Pinned by the pair that only
    // that branch has — reason immediately before the bare return (the
    // handler's copy of the reason is followed by its arrival bookkeeping).
    assert.ok(
      workerSrc.includes('noteSkipReason("init-no-scanner");return;'),
      "runScan's guard says so",
    );
    assert.ok(
      workerSrc.split('noteSkipReason("init-no-scanner");').length - 1 === 2,
      "both no-scanner returns record it (handler and runScan)",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
