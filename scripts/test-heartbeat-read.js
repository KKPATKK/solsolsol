/*
 * THE OFF-BODY PROBE MUST READ THE LIVE STORE (2026-10-22).
 *
 * WHY THIS FILE EXISTS. `scripts/read-heartbeat.js` exists so the tick's own
 * `dbSteps` / `modeRead` / `preTick` readings can be read WITHOUT adding round
 * trips to the isolate being measured — the one property that makes it an
 * instrument. It built `new Db(config.tursoUrl, ...)`, i.e. the READ-ONLY
 * Turso archive frozen at the 2026-10-15 D1 cutover, and its output never said
 * which store answered. Run live 2026-10-22 01:47:53Z it printed a heartbeat
 * `@ 2026-10-22T01:20:45Z ageS=88097` while /health's D1 row read
 * `at 2026-10-23T01:41:40Z` — a probe one day behind production, reporting
 * `ok=true`. A lying instrument is worse than no instrument, so the pins here
 * are about WHERE THE ROWS COME FROM:
 *
 *   1. D1 is the default (REST binding + src/d1.ts transport — the same pair
 *      the migration and scripts/raydium-attribution.js use) and the run names
 *      its source before it prints a single reading.
 *   2. The Turso copy exists only behind `--archive` and is labelled NOT live.
 *   3. No `Db.init()`: that is a DDL batch, and a read-only probe must not run
 *      DDL against production (which is also why the SQL is copied instead of
 *      going through Db.getWorkerState — pin the copy against the source).
 *   4. No silent fallback: an unreachable D1 fails the run rather than
 *      answering from the older store.
 *
 * Run: node scripts/test-heartbeat-read.js (npm run test:unit runs it after the
 * build, beside the other standalone suites).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

const probeSrc = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "read-heartbeat.js"),
  "utf8",
);
const dbSrc = fs.readFileSync(path.join(__dirname, "..", "src", "db.ts"), "utf8");

// ---------- 1. D1 by default, and the source is named on every run ----------

test("the probe defaults to D1 and names its source before its first reading", () => {
  assert.ok(
    probeSrc.includes('const id =\n    process.env.D1_DATABASE_ID ||') &&
      probeSrc.includes('db.name === named)?.uuid'),
    "the database is an explicit id or the account's named one",
  );
  assert.ok(
    probeSrc.includes("d1.createD1Transport(d1Rest.createRestBinding(api, id))"),
    "the rows come over the REST binding + src/d1.ts transport",
  );
  assert.ok(
    probeSrc.includes("console.log(`source: ${target.kind}`);") &&
      probeSrc.includes("— LIVE"),
    "the store that answered is printed, so a stale reading cannot hide",
  );
});

test("the Turso copy only exists behind --archive and is labelled NOT live", () => {
  assert.ok(
    probeSrc.includes('if (argv.includes("--archive")) {'),
    "the archive is an explicit choice, never the default",
  );
  assert.ok(
    probeSrc.includes("NOT live; the pre-2026-10-15-cutover copy"),
    "and the label says what it is",
  );
});

test("an unreachable D1 fails the run instead of falling back", () => {
  assert.ok(
    probeSrc.includes("throw new Error(") &&
      probeSrc.includes("Pass --archive only to read the"),
    "a missing credential is an error naming both ways to proceed",
  );
  assert.equal(
    /falling back to the frozen Turso archive/.test(probeSrc),
    false,
    "no silent store switch (that is the bug this test guards)",
  );
});

// ---------- 2. read-only: SELECTs, and the SQL matches the Db's own ----------

test("the probe never runs Db.init() (the DDL batch) against production", () => {
  const calls = probeSrc.split("await db.init()").length - 1;
  assert.equal(calls, 0, "no init() call");
  assert.equal(
    probeSrc.includes('require("../dist/db.js")') &&
      probeSrc.includes("SCHEMA_DDL_FINGERPRINT_KEY"),
    true,
    "the fingerprint constant still comes from src/db.ts",
  );
});

test("the copied statements are Db.getWorkerState's / getWorkerStates' own SQL", () => {
  assert.ok(
    dbSrc.includes('sql: "SELECT value FROM worker_state WHERE key = ?"'),
    "src/db.ts reads one row with this statement",
  );
  assert.ok(
    dbSrc.includes(
      "`SELECT key, value FROM worker_state WHERE key IN (${keys",
    ),
    "and many rows with this one",
  );
  assert.ok(
    probeSrc.includes('const ROW_SQL = "SELECT value FROM worker_state WHERE key = ?";'),
    "the probe's single-row statement matches",
  );
  assert.ok(
    probeSrc.includes("`SELECT key, value FROM worker_state WHERE key IN (${Array(n)") &&
      probeSrc.includes('.join(",")})`;'),
    "and the probe's batch statement matches (same IN list, same columns)",
  );
});

// ---------- 3. the run still answers the questions it exists for ------------

test("the sample still publishes the readings the archive read used to", () => {
  for (const field of [
    "preTick?.steps",
    "s.dbSteps",
    "s.modeRead",
    "s.dbMs",
    "schema_ddl_fingerprint",
  ]) {
    assert.ok(
      probeSrc.includes(field),
      `${field} is still printed — the store changed, the instrument did not`,
    );
  }
});

console.log(`\nread-heartbeat → D1: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
