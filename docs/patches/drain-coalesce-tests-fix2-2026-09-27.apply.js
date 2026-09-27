// Verify-then-write: the backlog assertions must read the LIVE count (the view
// is a drain-time snapshot).
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
  "coalescing test: live counts",
  `    assert.equal(
      writeDrainView().owedTokens,
      DEFERRED_COALESCE_MAX_PER_CALL + 3,
      "every record is owed",
    );
    const first = await drainDeferredWrites(() => 50);
    assert.equal(first.calls, 1, "one call");
    assert.equal(
      calls[0].tokens.length,
      DEFERRED_COALESCE_MAX_PER_CALL,
      "capped at what one statement may carry",
    );
    assert.equal(writeDrainView().owedTokens, 3, "the rest stays owed");
    await drainDeferredWrites(() => 50);
    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(writeDrainView().owedTokens, 0);`,
  `    assert.equal(
      deferredWriteCount(),
      DEFERRED_COALESCE_MAX_PER_CALL + 3,
      "every record is owed",
    );
    const first = await drainDeferredWrites(() => 50);
    assert.equal(first.calls, 1, "one call");
    assert.equal(
      calls[0].tokens.length,
      DEFERRED_COALESCE_MAX_PER_CALL,
      "capped at what one statement may carry",
    );
    assert.equal(deferredWriteCount(), 3, "the rest stays owed");
    const second = await drainDeferredWrites(() => 50);
    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(second.owedTokens, 0, "and the backlog is empty");`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
