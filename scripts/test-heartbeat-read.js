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
 *   1. The probe delegates the store decision to scripts/open-store.js (the
 *      seam every off-body tool reads through — D1 live by default, the frozen
 *      archive only behind `--archive`, `source:` printed, no silent fallback).
 *   2. It still runs no `Db.init()`: that is a DDL batch, and a read-only probe
 *      must not run DDL against production — which is also why its statements
 *      are copies of Db.getWorkerState's / getWorkerStates' SQL (pinned here
 *      against src/db.ts).
 *   3. It still prints the readings it exists for.
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

const read = (p) =>
  fs.readFileSync(path.join(__dirname, "..", ...p.split("/")), "utf8");

const probeSrc = read("scripts/read-heartbeat.js");
const storeSrc = read("scripts/open-store.js");
const dbSrc = read("src/db.ts");

/** Code without comments — a sentence in a header is not a call in the body. */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
const probeCode = stripComments(probeSrc);

// ---------- 1. one seam decides the store, and names it on every run --------

test("the probe delegates to open-store.js instead of picking a store itself", () => {
  assert.ok(
    probeSrc.includes('const { openTarget } = require("./open-store.js");'),
    "the store comes from the shared seam",
  );
  for (const leftover of ["new Db(", "createClient(", "d1Rest.", "loadConfig("]) {
    assert.equal(
      probeCode.includes(leftover),
      false,
      `the probe must not build its own client (${leftover})`,
    );
  }
  assert.ok(
    probeSrc.includes("console.log(`source: ${target.kind}`);") &&
      probeSrc.includes('await target.select(ROW_SQL, ["scan_heartbeat"])'),
    "the source is printed before the first reading, and the rows come through it",
  );
});

test("the seam defaults to D1 and reaches it through the transport the Worker uses", () => {
  assert.ok(
    storeSrc.includes("process.env.D1_DATABASE_ID ||") &&
      storeSrc.includes("db.name === named)?.uuid"),
    "the database is an explicit id or the account's named one",
  );
  assert.ok(
    storeSrc.includes("binding: d1Rest.createRestBinding(api, id)") &&
      storeSrc.includes("d1.createD1Transport(target.binding)"),
    "the rows come over the REST binding + src/d1.ts transport",
  );
  assert.ok(
    storeSrc.includes("— LIVE"),
    "the live label exists, so a stale reading cannot hide behind a bare id",
  );
});

test("the Turso copy only exists behind --archive and is labelled NOT live", () => {
  assert.ok(
    storeSrc.includes('argv.includes("--archive")'),
    "the archive is an explicit choice, never the default",
  );
  assert.ok(
    storeSrc.includes("NOT live; the pre-2026-10-15-cutover copy"),
    "and the label says what it is",
  );
});

test("an unreachable D1 fails the run instead of falling back", () => {
  assert.ok(
    storeSrc.includes("throw new Error(") &&
      storeSrc.includes("Pass --archive to read the frozen"),
    "a missing credential is an error naming both ways to proceed",
  );
  assert.equal(
    /falling back to the frozen Turso archive/.test(storeSrc + probeSrc),
    false,
    "no silent store switch (that is the bug this suite guards)",
  );
});

// ---------- 2. read-only: SELECTs, and the SQL matches the Db's own --------

test("the probe never runs Db.init() (the DDL batch) against production", () => {
  assert.equal(probeSrc.split("await db.init()").length - 1, 0, "no init() call");
  assert.ok(
    probeSrc.includes("SCHEMA_DDL_FINGERPRINT_KEY"),
    "the fingerprint constant still comes from src/db.ts",
  );
});

test("the copied statements are Db.getWorkerState's / getWorkerStates' own SQL", () => {
  assert.ok(
    dbSrc.includes('sql: "SELECT value FROM worker_state WHERE key = ?"'),
    "src/db.ts reads one row with this statement",
  );
  assert.ok(
    dbSrc.includes("`SELECT key, value FROM worker_state WHERE key IN (${keys"),
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

test("openDb() runs init() once, on the chosen store, and says which", () => {
  assert.ok(
    storeSrc.includes("await db.init();"),
    "Db.get() refuses an uninitialised client, so the seam does it once",
  );
  assert.ok(
    storeSrc.includes('new Db("", undefined, undefined, target.binding)'),
    "the live Db rides the binding (the url/authToken are unused on that path)",
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
