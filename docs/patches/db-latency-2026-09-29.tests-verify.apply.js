/*
 * Test updates for the counter self-verification (2026-09-29).
 *
 *   node docs/patches/db-latency-2026-09-29.tests-verify.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("changesVerdict")) {
  console.log("already applied — scripts/test-unit.js untouched");
  process.exit(0);
}

function swap(label, old, neu) {
  const parts = src.split(old);
  if (parts.length !== 2) {
    console.error(`ANCHOR MISS (${parts.length - 1} matches): ${label}`);
    process.exit(1);
  }
  src = parts.join(neu);
  console.log(`ok: ${label}`);
}

swap(
  "require: verdict helpers",
  `claimShapeSavingMs, dbRegionFromUrl } = require("../dist/dblatency.js");`,
  `claimShapeSavingMs, dbRegionFromUrl, changesVerdict, DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE } = require("../dist/dblatency.js");`,
);

swap(
  "changesVerdict test",
  `  await test("Db.claimTokenPush: ONE batch round trip, and the counter moves only on a win", async () => {`,
  `  await test("changesVerdict: two increments per sample, or the batched claim is not safe", () => {
    assert.equal(DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE, 2);
    assert.equal(changesVerdict(0, 6, 3), "verified");
    assert.equal(changesVerdict(10, 14, 2), "verified");
    // changes() stuck at 1 (never sees the skipped insert) or at 0 (never sees
    // the winning one) must NOT read as verified.
    assert.equal(changesVerdict(0, 3, 3), "mismatch");
    assert.equal(changesVerdict(0, 1, 3), "mismatch");
    assert.equal(changesVerdict(null, 4, 2), "unavailable");
    assert.equal(changesVerdict(4, null, 2), "unavailable");
  });

  await test("Db.claimTokenPush: ONE batch round trip, and the counter moves only on a win", async () => {`,
);

swap(
  "measureLatency test",
  `      const raw = await db.measureLatency(2);
      for (const op of DB_LATENCY_OPS) {
        assert.ok(Array.isArray(raw[op]), \`\${op} must be measured\`);
        assert.equal(raw[op].length, 2, \`\${op} keeps every sample\`);
        for (const ms of raw[op]) {
          assert.ok(Number.isFinite(ms) && ms >= 0, \`\${op} sample must be a duration\`);
        }
      }
      assert.deepEqual(
        Object.keys(summarizeLatencyOps(raw)).sort(),
        [...DB_LATENCY_OPS].sort(),
        "the report names exactly the probed ops",
      );
      assert.notEqual(await db.getWorkerState(DB_LATENCY_PROBE_KEY), null, "the insert-shape probe row landed");
      assert.notEqual(await db.getWorkerState(DB_LATENCY_PROBE_COUNT_KEY), null, "the counter-shape probe row landed");
      const seen = await t.client.execute("SELECT COUNT(*) AS n FROM seen_tokens");
      assert.equal(Number(seen.rows[0].n), 0, "the probe never writes a seen_tokens row");`,
  `      const m = await db.measureLatency(2);
      assert.equal(m.samples, 2);
      for (const op of DB_LATENCY_OPS) {
        assert.ok(Array.isArray(m.raw[op]), \`\${op} must be measured\`);
        assert.equal(m.raw[op].length, 2, \`\${op} keeps every sample\`);
        for (const ms of m.raw[op]) {
          assert.ok(Number.isFinite(ms) && ms >= 0, \`\${op} sample must be a duration\`);
        }
      }
      assert.deepEqual(
        Object.keys(summarizeLatencyOps(m.raw)).sort(),
        [...DB_LATENCY_OPS].sort(),
        "the report names exactly the probed ops",
      );
      // THE point of the check: the batched claim's counter rides on
      // changes() seeing the INSERT before it inside the same batch. Each
      // sample must move the probe counter exactly twice — the plain upsert
      // plus the two-trip insert winning, with the one-trip insert on that
      // same key adding nothing. A stuck-at-1 or stuck-at-0 changes() shows up
      // here as 3 or 1 per sample.
      assert.equal(
        m.counterAfter - m.counterBefore,
        2 * DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE,
        "each sample must move the probe counter exactly twice",
      );
      assert.equal(changesVerdict(m.counterBefore, m.counterAfter, 2), "verified");
      // The per-call probe rows are retired; the counter row is the reading
      // and stays.
      const leftovers = await t.client.execute(
        "SELECT COUNT(*) AS n FROM worker_state WHERE key LIKE 'db_latency_probe:%'",
      );
      assert.equal(Number(leftovers.rows[0].n), 0, "per-call probe rows are cleaned up");
      assert.notEqual(
        await db.getWorkerState(DB_LATENCY_PROBE_COUNT_KEY),
        null,
        "the counter row stays — the check needs it",
      );
      const seen = await t.client.execute("SELECT COUNT(*) AS n FROM seen_tokens");
      assert.equal(Number(seen.rows[0].n), 0, "the probe never writes a seen_tokens row");`,
);

swap(
  "wiring pins",
  `    assert.ok(worker.includes("await db.measureLatency(samples)"), "…and the measurement comes from the Db");`,
  `    assert.ok(worker.includes("await db.measureLatency(requested)"), "…and the measurement comes from the Db");
    assert.ok(worker.includes("verdict: changesVerdict("), "the report carries the changes() verdict");`,
);

swap(
  "shared-statement pin",
  `    const claim = compiled.slice(compiled.indexOf("claimTokenPush"));
    assert.ok(claim.includes("changes()"), "the counter delta comes from SQL, not a second request");
    assert.ok(claim.includes("batch"), "…and it rides one batch");`,
  `    const claim = compiled.slice(compiled.indexOf("claimTokenPush"));
    assert.ok(claim.includes("batch"), "the claim rides one batch");
    // The probe must run the CLAIM's counter statement, not a copy of it: two
    // call sites (claim + probe) sharing one constant is what keeps the
    // probe's verdict about the claim rather than about a look-alike.
    const shared = compiled.split("sql: CLAIM_COUNTER_UPSERT_SQL").length - 1;
    assert.ok(shared >= 2, \`the claim and the probe share the counter statement (found \${shared})\`);
    assert.ok(
      compiled.includes("sql: CLAIM_COUNTER_RELEASE_SQL"),
      "…and the release path uses its own shared statement",
    );`,
);

fs.writeFileSync(file, src);
console.log("wrote scripts/test-unit.js");
