/*
 * Unit tests for B1 (one-round-trip claim) + B4 (/debug/db-latency probe).
 *
 * Anchored + idempotent (scripts/test-unit.js is 17k lines and goes through
 * the same Vly Daytona sync as src/worker.ts):
 *
 *   1. two require() lines,
 *   2. a test block inserted just before the results printer.
 *
 *   node docs/patches/db-latency-2026-09-29.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("DB_LATENCY_OPS")) {
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
  "require: SEEN_TOKENS_COUNT_KEY",
  `const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS, poolRotationSlot } = require("../dist/db.js");`,
  `const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS, poolRotationSlot, SEEN_TOKENS_COUNT_KEY } = require("../dist/db.js");
const { DB_LATENCY_PROBE_KEY, DB_LATENCY_PROBE_COUNT_KEY, DB_LATENCY_SAMPLES, DB_LATENCY_SAMPLES_MAX, DB_LATENCY_OPS, clampLatencySamples, summarizeLatency, summarizeLatencyOps, claimShapeSavingMs, dbRegionFromUrl } = require("../dist/dblatency.js");`,
);

const block = `  // ---------- Turso round trips: the claim's one-request shape + the probe ----------
  //
  // B1: the push claim used to be TWO sequential Turso requests (the
  // seen_tokens INSERT OR IGNORE, then an awaited telemetry-counter upsert)
  // while the push path gives the claim a 400ms slice — and the Worker does
  // not run next to the database (live 2026-09-29: ATL/DFW/MIA/DUB/SYD
  // isolates against an aws-ap-northeast-1 database, one \`poolMs\` batch
  // request measuring 0-812ms). The second round trip was enough to push a
  // healthy claim past its bound and DEFER the card. B4 (/debug/db-latency)
  // is the probe that measures both shapes on the live path.

  await test("clampLatencySamples: ?samples defaults, clamps, and refuses nonsense", () => {
    assert.equal(clampLatencySamples(undefined), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples(null), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples(""), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples("abc"), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples(0), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples(-3), DB_LATENCY_SAMPLES);
    assert.equal(clampLatencySamples("2"), 2);
    assert.equal(clampLatencySamples(999), DB_LATENCY_SAMPLES_MAX);
  });

  await test("summarizeLatency: median of odd/even sets, junk dropped, empty never throws", () => {
    assert.deepEqual(summarizeLatency([30, 10, 20]), { n: 3, min: 10, p50: 20, max: 30 });
    assert.deepEqual(summarizeLatency([10, 20, 30, 40]), { n: 4, min: 10, p50: 25, max: 40 });
    assert.deepEqual(summarizeLatency([5, NaN, -1, Infinity]), { n: 1, min: 5, p50: 5, max: 5 });
    assert.deepEqual(summarizeLatency([]), { n: 0, min: 0, p50: 0, max: 0 });
    assert.equal(summarizeLatency([900, 120, 130]).p50, 130, "sample order must not matter");
  });

  await test("dbRegionFromUrl: only the region token; null for a local db", () => {
    assert.equal(dbRegionFromUrl("libsql://org-kkpatkk.aws-ap-northeast-1.turso.io"), "aws-ap-northeast-1");
    assert.equal(dbRegionFromUrl("https://db.aws-eu-west-1.turso.io"), "aws-eu-west-1");
    assert.equal(dbRegionFromUrl("file:/tmp/x.db"), null);
    assert.equal(dbRegionFromUrl(undefined), null);
    assert.equal(dbRegionFromUrl(""), null);
  });

  await test("claimShapeSavingMs: two-trip minus one-trip, null when either is missing", () => {
    const two = { n: 1, min: 0, p50: 640, max: 0 };
    const one = { n: 1, min: 0, p50: 250, max: 0 };
    assert.equal(claimShapeSavingMs({ claimShapeTwoTrip: two, claimShapeOneTrip: one }), 390);
    assert.equal(claimShapeSavingMs({ claimShapeTwoTrip: two }), null);
    assert.equal(claimShapeSavingMs({}), null);
  });

  await test("Db.claimTokenPush: ONE batch round trip, and the counter moves only on a win", async () => {
    const t = tmpDb();
    try {
      let executes = 0;
      let batches = 0;
      const counting = {
        execute: (a) => { executes++; return t.client.execute(a); },
        batch: (a, m) => { batches++; return t.client.batch(a, m); },
        close: () => t.client.close(),
      };
      const db = new Db("file:injected", undefined, counting);
      await db.init();
      executes = 0;
      batches = 0;
      assert.equal(await db.claimTokenPush("chat-1", "TOKEN-A"), true, "a fresh claim wins");
      assert.equal(batches, 1, "the claim is ONE batch request");
      assert.equal(executes, 0, "and no separate execute — the counter rode the batch");
      const afterFirst = Number((await db.getWorkerState(SEEN_TOKENS_COUNT_KEY)) ?? 0);
      assert.equal(afterFirst, 1, "a won claim bumps the cached count exactly once");
      assert.equal(await db.claimTokenPush("chat-1", "TOKEN-A"), false, "the same (chat, token) loses the INSERT OR IGNORE");
      assert.equal(
        Number((await db.getWorkerState(SEEN_TOKENS_COUNT_KEY)) ?? 0),
        afterFirst,
        "a LOST claim must not move the counter (changes() = 0)",
      );
      await db.unclaimTokenPush("chat-1", "TOKEN-A");
      assert.equal(
        Number((await db.getWorkerState(SEEN_TOKENS_COUNT_KEY)) ?? 0),
        afterFirst - 1,
        "releasing an existing claim gives the count back",
      );
      await db.unclaimTokenPush("chat-1", "NEVER-CLAIMED");
      assert.equal(
        Number((await db.getWorkerState(SEEN_TOKENS_COUNT_KEY)) ?? 0),
        afterFirst - 1,
        "releasing a row that never existed must NOT decrement (the old unconditional -1 did)",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("Db.measureLatency: every op sampled, probe rows only, push path untouched", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const raw = await db.measureLatency(2);
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
      assert.equal(Number(seen.rows[0].n), 0, "the probe never writes a seen_tokens row");
    } finally {
      await t.cleanup();
    }
  });

  await test("the probe cannot claim a coin, and /debug/db-latency is wired to it", () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
    const probe = read("src/dblatency.ts");
    assert.ok(!probe.includes("seen_tokens"), "a diagnostic must not be able to claim a coin");
    const worker = read("src/worker.ts");
    assert.ok(worker.includes('url.pathname === "/debug/db-latency"'), "the route is registered");
    assert.ok(worker.includes("dbRegionFromUrl(env.TURSO_DATABASE_URL)"), "the report carries the db region");
    assert.ok(worker.includes("await db.measureLatency(samples)"), "…and the measurement comes from the Db");
    assert.ok(
      worker.includes('clampLatencySamples(url.searchParams.get("samples"))'),
      "?samples is clamped, not trusted",
    );
    // Every op the report names must be one measureLatency really runs, and
    // the claim must not have drifted back into two requests.
    const compiled = read("dist/db.js");
    for (const op of DB_LATENCY_OPS) {
      assert.ok(compiled.includes(\`"\${op}"\`), \`\${op} is measured in dist/db.js\`);
    }
    const claim = compiled.slice(compiled.indexOf("claimTokenPush"));
    assert.ok(claim.includes("changes()"), "the counter delta comes from SQL, not a second request");
    assert.ok(claim.includes("batch"), "…and it rides one batch");
  });

  console.log("\\n===== UNIT TESTS =====");`;

swap("test block", `  console.log("\\n===== UNIT TESTS =====");`, block);

fs.writeFileSync(file, src);
console.log("wrote scripts/test-unit.js");
