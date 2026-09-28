/*
 * Tests for the Tier 1 overlap (items 1+2, 2026-09-28): the re-eval pool read
 * and the token_stats prune must be DISPATCHED with the feed fan-out and
 * awaited at the join, with the pool opts literal moved verbatim (never
 * duplicated) and the old in-series timer retired.
 *
 * Source pins, because the property is structural: a later edit that "tidies"
 * the dispatch back next to its await silently restores the serial round trip
 * this change removed, and nothing in a runtime reading would say so.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const testPath = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(testPath, "utf8");

const ANCHOR = `  console.log("\\n===== UNIT TESTS =====");`;
const MARK = `tier 1 (2026-09-28) — the pool read and the prune are dispatched with the feeds`;

if (src.includes(MARK)) {
  console.log("= already applied");
  process.exit(0);
}

const at = src.indexOf(ANCHOR);
if (at < 0) {
  console.log("✗ tail anchor not found");
  process.exit(1);
}

const BLOCK = `  await test(
    "tier 1 (2026-09-28) — the pool read and the prune are dispatched with the feeds",
    async () => {
      const strip = (text) =>
        [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");
      const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
      const scannerSrc = read("src/scanner.ts");
      const dispatch = scannerSrc.indexOf("constpoolRead=this.fetchFeedCapped(");
      const pruneDispatch = scannerSrc.indexOf("constpruneRun=this.fetchFeedCapped(");
      const firstFeedJoin = scannerSrc.indexOf("awaitPromise.all(feedJobs)");
      const join = scannerSrc.indexOf("constpoolJoinStart=Date.now();");
      // Both must exist, and the dispatch must precede the feed phase's join.
      assert.ok(dispatch >= 0, "the pool read is dispatched as a named promise");
      assert.ok(pruneDispatch >= 0, "the prune is dispatched as a named promise");
      assert.ok(join >= 0, "the join exists");
      assert.ok(
        dispatch < firstFeedJoin && dispatch < join,
        "the pool read is dispatched BEFORE the feed phase is awaited",
      );
      assert.ok(
        pruneDispatch < join,
        "the prune is dispatched before the join too",
      );
      // The read is awaited exactly once, at the join — never in series.
      assert.equal(
        scannerSrc.split("awaitpoolRead;").length - 1,
        1,
        "one await for the dispatched read",
      );
      assert.equal(
        scannerSrc.split("awaitpruneRun;").length - 1,
        1,
        "one await for the dispatched prune",
      );
      // An unawaited rejection would be a worker-level error on the early
      // returns between the dispatch and the join.
      assert.equal(
        scannerSrc.split("poolRead.catch(()=>undefined);").length - 1,
        1,
        "the dispatched read carries a no-op catch",
      );
      assert.equal(
        scannerSrc.split("pruneRun.catch(()=>undefined);").length - 1,
        1,
        "the dispatched prune carries a no-op catch",
      );
      // The opts literal MOVED (one call site, on the dispatched promise).
      assert.equal(
        scannerSrc.split("getReevalPoolCached(").length - 1,
        2, // the dispatch site + the method definition
        "one call site for the cached pool read",
      );
      assert.ok(
        scannerSrc.includes("getReevalPoolCached(poolNow,{"),
        "the call site uses the dispatch-time clock",
      );
      // The old in-series timers must be gone with it.
      assert.equal(
        /\\bpoolStart\\b/.test(scannerSrc),
        false,
        "the retired poolStart timer is gone",
      );
      assert.ok(
        scannerSrc.includes("diag.poolMs=Date.now()-poolReadStartedAt;"),
        "poolMs still reports the read's own duration",
      );
      assert.ok(
        scannerSrc.includes("diag.poolWaitMs=Date.now()-poolJoinStart;"),
        "poolWaitMs reports the residual wait at the join",
      );
      assert.ok(
        scannerSrc.includes("poolWaitMs?:number;"),
        "the summary publishes poolWaitMs",
      );
    },
  );

`;

const out = src.slice(0, at) + BLOCK + src.slice(at);
if (out.split(MARK).length - 1 !== 1) {
  console.log("✗ expected exactly one copy after insertion — not writing");
  process.exit(1);
}
fs.writeFileSync(testPath, out);
console.log("✓ added the tier 1 overlap pins");
