/*
 * The schema-fingerprint gate in Db.init (2026-09-26).
 *
 * WHY THIS IS A FILE OF ITS OWN: the gate is the one change whose failure mode
 * is silent — a wrongly-skipped DDL batch means a table or column never gets
 * created, and the first symptom is a query error somewhere else entirely,
 * hours later. scripts/test-unit.js is past the editing window, so the guard
 * lives beside the other standalone suites (test-deferred-priority.js,
 * test-tick-path.js) and runs from `npm run test:unit`.
 *
 * WHAT IS PINNED:
 *   1. `schemaFingerprint` changes for ANY edit to the statement list —
 *      including edits that move text across a statement boundary, which a
 *      naive concatenation-hash would call identical. This is the property the
 *      gate's safety rests on: a hand-kept version number would eventually be
 *      forgotten, a fingerprint of the statements themselves cannot be.
 *   2. A second `init()` on the same database — a recycled isolate, which is
 *      what the gate exists for — runs NO DDL batch at all.
 *   3. A marker that disagrees with the current statements still runs the DDL,
 *      and an unreadable marker (a database that has never been initialized)
 *      still runs it and still comes up usable.
 *
 * Run: node scripts/test-schema-gate.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db, schemaFingerprint, SCHEMA_DDL_FINGERPRINT_KEY } = require("../dist/db.js");

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

function tmpDb() {
  const p = path.join(
    os.tmpdir(),
    `schema-gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${p}` });
  return {
    p,
    client,
    cleanup: async () => {
      await client.close();
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    },
  };
}

/** A client that reports what init asked for, then forwards to the real one. */
function countingClient(client) {
  const seen = { batches: 0, statements: 0, executes: 0, maxBatchSize: 0, sql: [] };
  return {
    seen,
    execute: (a) => {
      seen.executes++;
      // Keep the statement text: when this count is not what the test expects,
      // the ONLY useful question is which statement was paid for, and guessing
      // it from the source is how a wrong answer gets baked into a comment.
      seen.sql.push(String(a.sql).replace(/\s+/g, " ").slice(0, 90));
      return client.execute(a);
    },
    batch: (a, m) => {
      seen.batches++;
      seen.statements += a.length;
      seen.maxBatchSize = Math.max(seen.maxBatchSize, a.length);
      return client.batch(a, m);
    },
    close: () => client.close(),
  };
}

async function main() {
  // ---------- the fingerprint itself ----------
  await test("schemaFingerprint: stable for the same list, 8 hex digits", () => {
    const list = ["CREATE TABLE a (x INT);", "CREATE INDEX i ON a(x);"];
    const first = schemaFingerprint(list);
    assert.equal(first, schemaFingerprint([...list]), "the same list must hash the same");
    assert.match(first, /^[0-9a-f]{8}$/, `expected 8 hex digits, got ${first}`);
  });

  await test("schemaFingerprint: ANY edit changes it (the gate's whole safety)", () => {
    const base = ["CREATE TABLE a (x INT);", "CREATE INDEX i ON a(x);"];
    const h = schemaFingerprint(base);
    assert.notEqual(
      schemaFingerprint(["CREATE TABLE a (x INT);", "CREATE INDEX i ON a(x, y);"]),
      h,
      "editing a statement must bust the gate",
    );
    assert.notEqual(
      schemaFingerprint(["CREATE TABLE a (x INT, z INT);", ...base.slice(1)]),
      h,
      "adding a column must bust the gate",
    );
    assert.notEqual(
      schemaFingerprint([...base, "CREATE TABLE b (y INT);"]),
      h,
      "adding a statement must bust the gate",
    );
    assert.notEqual(
      schemaFingerprint([base[1], base[0]]),
      h,
      "reordering must bust the gate",
    );
    // The boundary case the separator exists for: concatenated, these two
    // lists are the same byte string, so a hash without a separator would
    // hand back the same fingerprint for a genuinely different schema.
    assert.notEqual(
      schemaFingerprint(["ab", "c"]),
      schemaFingerprint(["a", "bc"]),
      "moving text across a statement boundary must bust the gate",
    );
  });

  await test("COLUMN_PROBE_TABLES: covers every table init migrates", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "db.ts"), "utf8");
    // Call sites, in both shapes the file uses: one line, and the wrapped
    // multi-argument form.
    const called = new Set(
      [...src.matchAll(/addColumnIfMissing\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    assert.ok(called.size >= 3, `expected real call sites, found ${called.size}`);
    const listed = new Set(
      [...src.matchAll(/export const COLUMN_PROBE_TABLES = \[([^\]]*)\]/g)].flatMap((m) =>
        [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]),
      ),
    );
    const missing = [...called].filter((t) => !listed.has(t));
    assert.deepEqual(
      missing,
      [],
      `these tables are migrated but not probed, so their columns keep paying ` +
        `one round trip each: ${missing.join(", ")} — add them to ` +
        `COLUMN_PROBE_TABLES in src/db.ts`,
    );
  });

  // ---------- the gate against a real database ----------
  await test("init: the second init (a recycled isolate) runs NO DDL batch", async () => {
    const t = tmpDb();
    const first = countingClient(t.client);
    const db = new Db("file:injected", undefined, first);
    await db.init();
    const ddlStatements = first.seen.maxBatchSize;
    assert.ok(
      ddlStatements > 10,
      `expected the DDL batch on the first init (largest batch ${ddlStatements})`,
    );

    // A SECOND handle over the same database is exactly what a recycled isolate
    // is: a fresh module scope that knows nothing and has to ask the database.
    const second = countingClient(t.client);
    const again = new Db("file:injected", undefined, second);
    await again.init();
    // THREE batches, and that is the whole cost of a recycled isolate: the
    // DDL fingerprint, the flag reads, and ONE batched column probe. The probe
    // is a batch rather than N executes on purpose — see the round5b note on
    // addColumnIfMissing: it used to be one ALTER per column (~12 reached of
    // 26 call sites), each a full round trip at the 2.4-5.8ms of client CPU
    // scripts/cpu-profile.js measured.
    assert.equal(
      second.seen.maxBatchSize < 10 && second.seen.batches === 3,
      true,
      `the second init must be the marker read, the flags read and the ONE ` +
        `column probe, got ${second.seen.batches} batch(es), largest ` +
        `${second.seen.maxBatchSize}`,
    );
    // ZERO `ALTER TABLE` on the second init: every column question is answered
    // from the probe above, so no ALTER has to be ATTEMPTED to ask it. This is
    // the assertion that pins the merge — it fails the moment a call site is
    // added for a table the probe's list does not cover, which is the one way
    // this change could quietly hand the round trips back.
    const alters = second.seen.sql.filter((sql) => /^ALTER TABLE/i.test(sql));
    assert.deepEqual(
      alters,
      [],
      `a recycled isolate must not attempt a per-column ALTER, each of which ` +
        `is a round trip that exists only to be told "duplicate column name"`,
    );
    // And the remaining single-statement traffic stays bounded: at this commit
    // it is exactly one read, the telemetry-seed marker in init
    // (`SELECT value FROM worker_state WHERE key = ?`), which is a real question
    // rather than a probe. A ceiling rather than an equality, so adding an
    // unrelated one-key read does not fail the suite that guards THIS change.
    assert.ok(
      second.seen.executes <= 2,
      `the second init should be batches plus at most a couple of real reads, ` +
        `got ${second.seen.executes}: ${second.seen.sql.join(" | ")}`,
    );
    assert.ok(
      second.seen.statements < first.seen.statements / 2,
      `the second init must move far fewer statements than the first ` +
        `(${second.seen.statements} vs ${first.seen.statements})`,
    );

    const marker = await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY);
    assert.match(
      String(marker),
      /^[0-9a-f]{8}$/,
      "init must leave the fingerprint behind for the next isolate",
    );
    await t.cleanup();
  });

  await test("init: a marker that disagrees still runs the DDL", async () => {
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    await db.setWorkerState(SCHEMA_DDL_FINGERPRINT_KEY, "deadbeef");

    const second = countingClient(t.client);
    const again = new Db("file:injected", undefined, second);
    await again.init();
    assert.ok(
      second.seen.maxBatchSize >= ddlStatementFloor(),
      `a stale fingerprint must run the DDL again (largest batch ` +
        `${second.seen.maxBatchSize})`,
    );
    const rewritten = await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY);
    assert.notEqual(
      String(rewritten),
      "deadbeef",
      "and the marker must be stamped with the current statements",
    );
    await t.cleanup();
  });

  await test("init: an unreadable marker (never-initialized database) still works", async () => {
    const t = tmpDb();
    // Nothing has run init yet, so worker_state does not exist: the marker read
    // throws, which the gate must treat as "unknown schema" rather than as an
    // error — this is the one database init has never seen.
    const cold = countingClient(t.client);
    const db = new Db("file:injected", undefined, cold);
    await db.init();
    assert.ok(
      cold.seen.maxBatchSize > 10,
      "the DDL must still run on a database with no worker_state",
    );
    assert.match(
      String(await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY)),
      /^[0-9a-f]{8}$/,
      "and the gate must be armed for the next isolate",
    );
    await t.cleanup();
  });

  console.log(results.join("\n"));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/**
 * The DDL batch's statement count, taken from the one place both sides agree
 * on: the first init creates the schema, so whatever that batch was, a stale
 * marker must reproduce a batch at least that big. Kept as a floor rather than
 * an exact count so adding a statement to the schema does not fail a test that
 * is about the GATE, not about the schema's size.
 */
function ddlStatementFloor() {
  return 10;
}

main().catch((err) => {
  console.error("schema-gate suite crashed:", err);
  process.exit(1);
});
