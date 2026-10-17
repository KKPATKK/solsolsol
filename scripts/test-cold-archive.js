/*
 * Cold archive + Analytics Engine metrics (2026-10-17).
 *
 * WHAT IS PINNED, and why each half matters:
 *   1. The R2 key is a function of the batch's own `at` range, so a retried
 *      prune overwrites its object instead of duplicating rows.
 *   2. NDJSON is one record per line with a trailing newline — the format a
 *      reader (DuckDB, jq, a shell) can consume without a loader.
 *   3. `Db.archiveColdRows` writes FIRST and deletes only what it wrote. A
 *      failed put must leave the rows in D1 — the whole reason this path exists
 *      is that the old prune deleted the only copy.
 *   4. No archive binding = the old behavior: nothing is exported, nothing is
 *      deleted by this method (the caller's bulk DELETE still runs).
 *   5. The Analytics Engine point has one index, the documented blob set, and
 *      exactly the doubles a reader charts — with a missing feed leg as 0
 *      ("not measured"), never as an instant leg.
 *
 * Run: node scripts/test-cold-archive.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db } = require("../dist/db.js");
const {
  COLD_ARCHIVE_BATCH_ROWS,
  COLD_SCAN_HISTORY_RETAIN_MS,
  COLD_TICK_LEGS_RETAIN_MS,
  coldArchiveKey,
  rowsToNdjson,
} = require("../dist/coldarchive.js");
const { buildScanDataPoint, SCAN_METRIC_INDEX } = require("../dist/scanmetrics.js");

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
    `cold-archive-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${p}` });
  return {
    p,
    client,
    cleanup: async () => {
      await client.close();
      try {
        fs.unlinkSync(p);
      } catch {}
    },
  };
}

async function insertScan(client, at, ok = 1, ms = 1000) {
  await client.execute({
    sql: "INSERT INTO scan_history (at, ok, ms) VALUES (?, ?, ?)",
    args: [at, ok, ms],
  });
}

async function insertLeg(client, at, via = "clock") {
  await client.execute({
    sql: "INSERT INTO tick_legs (at, via, ms) VALUES (?, ?, ?)",
    args: [at, via, 1000],
  });
}

async function main() {
  await test("coldArchiveKey: day + batch range, and stable across retries", () => {
    const first = Date.UTC(2026, 9, 17, 9, 30, 0);
    const last = first + 2 * 3600_000;
    const key = coldArchiveKey("tick_legs", first, last);
    assert.equal(key, `cold/tick_legs/2026-10-17/${first}-${last}.ndjson`);
    assert.equal(coldArchiveKey("tick_legs", first, last), key);
  });

  await test("rowsToNdjson: one record per line, trailing newline, empty in/out", () => {
    assert.equal(rowsToNdjson([]), "");
    const text = rowsToNdjson([{ at: 1, via: "clock" }, { at: 2, via: "cron" }]);
    assert.equal(text, '{"at":1,"via":"clock"}\n{"at":2,"via":"cron"}\n');
    assert.deepEqual(
      text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).at),
      [1, 2],
    );
  });

  await test("Db.archiveColdRows: archives then deletes ONLY what it wrote", async () => {
    const t = tmpDb();
    try {
      const writes = [];
      const db = new Db("file:injected", undefined, t.client, undefined, {
        put: async (key, body, opts) => {
          writes.push({ key, body, opts });
        },
      });
      await db.init();
      const now = Date.now();
      const oldScan = now - COLD_SCAN_HISTORY_RETAIN_MS - 3600_000;
      const freshScan = now - 3600_000;
      const oldLeg = now - COLD_TICK_LEGS_RETAIN_MS - 3600_000;
      const freshLeg = now - 3600_000;
      await insertScan(t.client, oldScan);
      await insertScan(t.client, freshScan);
      await insertLeg(t.client, oldLeg);
      await insertLeg(t.client, freshLeg);

      const out = await db.archiveColdRows(now);
      assert.deepEqual(out.failed, []);
      assert.equal(out.archived, 2, "one cold scan row + one cold tick row");
      assert.equal(writes.length, 2);
      const scanWrite = writes.find((w) => w.key.includes("/scan_history/"));
      const legWrite = writes.find((w) => w.key.includes("/tick_legs/"));
      assert.ok(scanWrite && legWrite, "one object per table");
      assert.equal(scanWrite.opts.httpMetadata.contentType, "application/x-ndjson");
      assert.equal(JSON.parse(scanWrite.body.trim()).at, oldScan);
      assert.equal(JSON.parse(legWrite.body.trim()).at, oldLeg);

      const left = await t.client.execute("SELECT at FROM scan_history ORDER BY at");
      assert.deepEqual(
        left.rows.map((r) => Number(r.at)),
        [freshScan],
        "the fresh row must survive",
      );
      const leftLegs = await t.client.execute("SELECT at FROM tick_legs ORDER BY at");
      assert.deepEqual(leftLegs.rows.map((r) => Number(r.at)), [freshLeg]);
    } finally {
      await t.cleanup();
    }
  });

  await test("Db.archiveColdRows: a failed put leaves the rows in D1", async () => {
    const t = tmpDb();
    try {
      const db = new Db("file:injected", undefined, t.client, undefined, {
        put: async () => {
          throw new Error("R2 unavailable");
        },
      });
      await db.init();
      const now = Date.now();
      const oldScan = now - COLD_SCAN_HISTORY_RETAIN_MS - 3600_000;
      await insertScan(t.client, oldScan);
      const out = await db.archiveColdRows(now);
      assert.deepEqual(out.failed, ["scan_history"]);
      assert.equal(out.archived, 0);
      const left = await t.client.execute("SELECT COUNT(*) AS n FROM scan_history");
      assert.equal(Number(left.rows[0].n), 1, "nothing may be deleted without an export");
    } finally {
      await t.cleanup();
    }
  });

  await test("Db.archiveColdRows: without a binding it exports and deletes nothing", async () => {
    const t = tmpDb();
    try {
      const db = new Db("file:injected", undefined, t.client);
      await db.init();
      const now = Date.now();
      await insertScan(t.client, now - COLD_SCAN_HISTORY_RETAIN_MS - 3600_000);
      const out = await db.archiveColdRows(now);
      assert.deepEqual(out, { archived: 0, failed: [] });
      const left = await t.client.execute("SELECT COUNT(*) AS n FROM scan_history");
      assert.equal(Number(left.rows[0].n), 1, "the caller's bulk prune owns this path");
    } finally {
      await t.cleanup();
    }
  });

  await test("archive batch size covers a day of ticks at the 30s cadence", () => {
    // 2,880 ticks/day must not outgrow the per-run cap (passes * batch), or the
    // table would grow without bound after the first prune.
    assert.ok(COLD_ARCHIVE_BATCH_ROWS * 3 >= 2_880);
  });

  await test("buildScanDataPoint: one index, tick counters, and a 0 for a missing leg", () => {
    const point = buildScanDataPoint({
      via: "clock",
      ok: true,
      err: null,
      skip: null,
      ms: 1234,
      summary: {
        profiles: 25,
        pool: 1200,
        pairs: 200,
        pairsJup: 190,
        jup: 30,
        pump: 20,
        meteora: 19,
        raydium: 20,
        geo: 0,
        boosts: 0,
        candidates: 1,
        pushed: 0,
        feedLegMs: { profiles: 8, jup: 126, pump: 76, meteora: 296 },
      },
    });
    assert.deepEqual(point.indexes, [SCAN_METRIC_INDEX]);
    assert.deepEqual(point.blobs, ["clock", "ok", "", ""]);
    assert.equal(point.doubles[0], 1234);
    // The five per-leg doubles start after the 13 tick numbers.
    assert.deepEqual(point.doubles.slice(13), [8, 126, 76, 296, 0]);
    assert.equal(point.doubles.length, 18);
  });

  await test("buildScanDataPoint: a failed tick carries its reason, capped", () => {
    const point = buildScanDataPoint({
      via: "cron",
      ok: false,
      err: "x".repeat(400),
      skip: "clock-gate",
      ms: 10,
      summary: null,
    });
    assert.deepEqual(point.blobs.slice(0, 2), ["cron", "fail"]);
    assert.equal(point.blobs[2].length, 120);
    assert.equal(point.blobs[3], "clock-gate");
    assert.equal(point.doubles.length, 18);
    assert.ok(point.doubles.every((v) => Number.isFinite(v)));
  });

  for (const line of results) console.log(line);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
