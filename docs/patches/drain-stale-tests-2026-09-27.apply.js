// Verify-then-write: tests for the stale-drain retirement.
const fs = require("fs");

let src = fs.readFileSync("scripts/test-unit.js", "utf8");
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
  "the retire test",
  `  await test("tickprobe: the census names what a tick's scan paid, per method", async () => {`,
  `  await test("tickprobe: a drain record is retired once it is history", () => {
    // WHY (2026-09-27): the row is only cleared by the isolate that WROTE it
    // (see clearPersistedDrainError), so an isolate recycled before its own
    // recovery leaves it standing forever — live that day a poll read a record
    // from 2026-09-25 (2.2 days old, \`pending 30\`) while every drain behind it
    // had landed. /health renders that field from ANY isolate, so it retires
    // what its own stale flag already calls history, with ONE write.
    const { drainErrorIsStale, WRITE_DRAIN_ERROR_STALE_MS } = require("../dist/tickprobe.js");
    const now = 1_800_000_000_000;
    assert.equal(drainErrorIsStale(null, now), false, "no record is not a stale record");
    assert.equal(drainErrorIsStale(undefined, now), false);
    assert.equal(drainErrorIsStale({}, now), false, "a record with no usable at never licenses a write");
    assert.equal(drainErrorIsStale({ at: 0 }, now), false);
    assert.equal(drainErrorIsStale({ at: "not-a-number" }, now), false);
    assert.equal(
      drainErrorIsStale({ at: now - 60_000 }, now),
      false,
      "a fresh failure stays the writer's own to clear",
    );
    assert.equal(
      drainErrorIsStale({ at: now - WRITE_DRAIN_ERROR_STALE_MS }, now),
      false,
      "the boundary itself is still live",
    );
    assert.equal(
      drainErrorIsStale({ at: now - WRITE_DRAIN_ERROR_STALE_MS - 1 }, now),
      true,
      "one ms past it is history",
    );

    // The wiring, whitespace-squashed (the same discipline the prune pins use):
    // ONE write under the key the row lives in, kept alive by the invocation,
    // and the published flag reading the SAME threshold so the two can never
    // disagree about which rows are history.
    const WS = new Set([9, 10, 13, 32]);
    const strip = (text) => [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");
    const workerSrc = strip(fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8"));
    assert.ok(
      workerSrc.includes("if(db&&drainErrorIsStale(writeDrainError,Date.now())){"),
      "the retire fires on the shared rule",
    );
    assert.ok(
      workerSrc.includes('db.setWorkerState(WRITE_DRAIN_ERROR_KEY,"")'),
      "and clears the row it read, under the same key",
    );
    assert.ok(
      workerSrc.includes("ctx.waitUntil(retiring)"),
      "awaited by the invocation instead of floating (an un-awaited write is cancelled on return)",
    );
    assert.ok(
      workerSrc.includes(
        "writeDrainErrorStale:writeDrainError===null||!(Number(writeDrainError.at)>0)?null:drainErrorIsStale(writeDrainError,Date.now())",
      ),
      "the published flag is the same rule",
    );
  });

  await test("tickprobe: the census names what a tick's scan paid, per method", async () => {`,
);

if (patched > 0) {
  fs.writeFileSync("scripts/test-unit.js", src);
  console.log(`wrote scripts/test-unit.js (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write (test-unit)");
}

// The threshold now lives behind drainErrorIsStale: the worker no longer names
// it, so the import goes.
let worker = fs.readFileSync("src/worker.ts", "utf8");
const importLine = `  WRITE_DRAIN_ERROR_KEY,
  WRITE_DRAIN_ERROR_STALE_MS,
  drainErrorIsStale,`;
const importFixed = `  WRITE_DRAIN_ERROR_KEY,
  drainErrorIsStale,`;
if (worker.includes(importFixed)) {
  console.log("= worker import: already trimmed");
} else if (worker.includes(importLine)) {
  worker = worker.replace(importLine, importFixed);
  fs.writeFileSync("src/worker.ts", worker);
  console.log("✓ worker import: trimmed");
} else {
  console.log("✗ worker import: anchor NOT found");
  process.exitCode = 1;
}
