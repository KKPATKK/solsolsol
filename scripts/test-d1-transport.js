/*
 * Cloudflare D1 as the store for Db (2026-10-15).
 *
 * WHY THIS SUITE EXISTS. The Turso → D1 move is not a new state machine: it is
 * the SAME one (single-flight scan lock, batched registration, the tracker's
 * per-row CAS, the deferred drain, the write census) talking to a different
 * store. Two things can therefore break silently, and both are pinned here:
 *
 *   1. THE SHAPE TRANSLATION. libsql answers `{rows, rowsAffected}`, D1 answers
 *      `{results, meta:{changes}}`. Every call site in src/db.ts reads the
 *      libsql shape, and the write census (noteWriteCensus) reads
 *      `rowsAffected` — translate `meta.rows_written` instead of `meta.changes`
 *      and the census silently doubles (D1 counts index entries there).
 *   2. THE 100-BOUND-PARAMETER CEILING. D1 REJECTS any statement with more than
 *      100 bound parameters — a hard error, not a slow path. Five writers build
 *      row-count-sized statements: recordObservedLiquidity (3 a row, 600 at its
 *      120-row form), noteSweptWithoutReading (1, 120), updateTokenMaxMcaps
 *      (7 a entry, unchunked), recordTokenStatsMany (12 a row, unchunked) and
 *      upsertPushWatchMany (9 a row, unchunked). This suite runs those writers
 *      through a D1-shaped binding backed by the REAL SQLite engine, and asserts
 *      that no statement the module issues ever exceeded the ceiling — and that
 *      the same calls on libsql keep their original, fewer-statement shape (a
 *      chunking fix that also re-chunked Turso would quietly buy extra round
 *      trips, i.e. extra subrequests, on every tick).
 *
 * The fake binding is deliberate: D1 does not exist outside Workers, and a mock
 * that only records calls would not prove the SQL still runs. Every statement
 * here is executed by @libsql/client against a temp file, with D1's own
 * rejection rule enforced on top.
 *
 * Run: node scripts/test-d1-transport.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db, writeCensusView } = require("../dist/db.js");
const {
  D1_MAX_BOUND_PARAMS,
  chunkForParamLimit,
  createD1Transport,
  normalizeD1Result,
} = require("../dist/d1.js");

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

function tmpClient() {
  const p = path.join(
    os.tmpdir(),
    `d1-transport-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return { client: createClient({ url: `file:${p}` }), path: p };
}

/**
 * A D1 binding backed by a real SQLite engine, enforcing D1's own rules:
 *  - more than 100 bound parameters is an error (the documented limit);
 *  - `all()`/`run()` both answer `{results, meta:{changes, rows_written}}`;
 *  - `batch()` answers one result per statement.
 */
class FakeD1 {
  constructor(client, limit = D1_MAX_BOUND_PARAMS) {
    this.client = client;
    this.limit = limit;
    this.log = [];
    this.maxArgs = 0;
    /** The heaviest statement seen, so a ceiling failure names its own SQL. */
    this.worst = null;
  }

  prepare(sql) {
    const self = this;
    const build = (args) => ({
      _sql: sql,
      _args: args,
      bind: (...more) => build(more),
      all: () => self.exec(sql, args),
      run: () => self.exec(sql, args),
    });
    return build([]);
  }

  async exec(sql, args) {
    if (args.length > this.maxArgs) this.worst = { sql, args: [...args] };
    this.maxArgs = Math.max(this.maxArgs, args.length);
    this.log.push({ sql, args: [...args] });
    if (args.length > this.limit) {
      throw new Error(
        `D1_ERROR: too many bound parameters (${args.length} > ${this.limit})` +
          `\n      SQL: ${sql.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
    const res = await this.client.execute({ sql, args: [...args] });
    const rows = res.rows.map((row) => ({ ...row }));
    const changes = Number(res.rowsAffected ?? 0);
    return { results: rows, success: true, meta: { changes, rows_written: changes } };
  }

  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await this.exec(s._sql, s._args));
    return out;
  }
}

const bigStatsList = (n) =>
  Array.from({ length: n }, (_, i) => ({
    token: `tok${i}`,
    firstSeenAt: 1_700_000_000_000 + i,
    firstM5Vol: 1000 + i,
    firstSeenAgeMin: 90,
    launchMs: 1_699_000_000_000 + i,
    birdeye1mVol: null,
    rugcheckBundlerPct: null,
    rugcheckTop10Pct: null,
    birdeyeProTraders: null,
    birdeyeSniperPct: null,
    minMcapObserved: 50_000,
    discoveredVia: "test",
  }));

const liquidityRows = (n) =>
  Array.from({ length: n }, (_, i) => ({ token: `tok${i}`, liquidityUsd: 20_000 + i }));

const mcapEntries = (n) =>
  Array.from({ length: n }, (_, i) => ({
    token: `tok${i}`,
    mcapUsd: 80_000 + i,
    liquidityUsd: 25_000 + i,
  }));

async function main() {
  // ---- the shape translation, in isolation ---------------------------------
  await test("normalizeD1Result: results→rows and meta.changes→rowsAffected", () => {
    const out = normalizeD1Result({
      results: [{ token: "a", n: 2 }],
      // rows_written is deliberately different: index entries are counted there,
      // and reading it instead of `changes` would double the write census.
      meta: { changes: 3, rows_written: 9 },
    });
    assert.equal(out.rowsAffected, 3);
    assert.equal(out.rows.length, 1);
    assert.equal(String(out.rows[0].token), "a");
  });

  await test("normalizeD1Result: a missing meta is 0 rows, not a crash", () => {
    assert.deepEqual(normalizeD1Result(null), { rows: [], rowsAffected: 0 });
    assert.deepEqual(normalizeD1Result({}), { rows: [], rowsAffected: 0 });
  });

  // ---- the transport, against a real engine --------------------------------
  await test("execute: rows come back as plain objects the call sites can read", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    await client.execute("CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT)");
    await client.execute("INSERT INTO t (key, value) VALUES ('k', 'v')");
    const transport = createD1Transport(fake);
    const res = await transport.execute({ sql: "SELECT key, value FROM t WHERE key = ?", args: ["k"] });
    assert.equal(res.rows.length, 1);
    assert.equal(String(res.rows[0].value), "v");
    client.close();
  });

  await test("execute: a write reads rowsAffected off meta.changes", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    await client.execute("CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT)");
    await client.execute("INSERT INTO t (key, value) VALUES ('a', '1'), ('b', '2')");
    const transport = createD1Transport(fake);
    const res = await transport.execute({
      sql: "UPDATE t SET value = ? WHERE key IN (?, ?)",
      args: ["9", "a", "b"],
    });
    assert.equal(res.rowsAffected, 2);
    client.close();
  });

  await test("batch: one result per statement, in order", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    await client.execute("CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT)");
    const transport = createD1Transport(fake);
    const out = await transport.batch([
      { sql: "INSERT OR IGNORE INTO t (key, value) VALUES (?, ?)", args: ["a", "1"] },
      { sql: "INSERT OR IGNORE INTO t (key, value) VALUES (?, ?)", args: ["b", "2"] },
      "SELECT COUNT(*) AS n FROM t",
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].rowsAffected, 1);
    assert.equal(out[1].rowsAffected, 1);
    assert.equal(Number(out[2].rows[0].n), 2);
    client.close();
  });

  await test("the binding's own 100-parameter rule is enforced by the fake", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    await client.execute("CREATE TABLE t (a TEXT)");
    const transport = createD1Transport(fake);
    await assert.rejects(
      () =>
        transport.execute({
          sql: `INSERT INTO t (a) VALUES ${Array.from({ length: 101 }, () => "(?)").join(",")}`,
          args: Array.from({ length: 101 }, (_, i) => `v${i}`),
        }),
      /too many bound parameters/,
    );
    client.close();
  });

  // ---- the chunk sizing itself --------------------------------------------
  await test("chunkForParamLimit: the ceiling and the caller's cap both bind", () => {
    const rows = Array.from({ length: 200 }, (_, i) => i);
    // 3 bindings a row: 33 fits D1's 100, 120 stays the libsql shape.
    assert.deepEqual(chunkForParamLimit(rows, 3, 100, 120).map((c) => c.length), [
      33, 33, 33, 33, 33, 33, 2,
    ]);
    assert.deepEqual(chunkForParamLimit(rows, 3, 32_766, 120).map((c) => c.length), [120, 80]);
    // 7 a entry, 1 a token, 12 a row.
    assert.equal(chunkForParamLimit(rows, 7, 100)[0].length, 14);
    assert.equal(chunkForParamLimit(rows, 1, 100)[0].length, 100);
    assert.equal(chunkForParamLimit(rows, 12, 100)[0].length, 8);
    // Never zero: argsPerRow above the ceiling still yields one row a chunk.
    assert.equal(chunkForParamLimit(rows, 250, 100)[0].length, 1);
  });

  // ---- the whole Db on a D1 binding ---------------------------------------
  await test("Db on D1: init + the row-count-sized writers stay under 100 bindings", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    const db = new Db("", undefined, undefined, fake);
    await db.init();

    // Registration: 200 coins, 12 bindings a row on one statement before this
    // change — the shape that D1 would have rejected outright (40 registrations
    // already bind 480).
    await db.recordTokenStatsMany(bigStatsList(200));

    // The observed-liquidity batch: its 120-row form binds 600 parameters.
    await db.recordObservedLiquidity(liquidityRows(200));

    // The max-mcap raise: 7 bindings an entry, and this one had no chunk at all.
    await db.updateTokenMaxMcaps(mcapEntries(60));

    // The freshness mark: 1 binding a token, 120 at its old chunk size.
    await db.noteSweptWithoutReading(Array.from({ length: 150 }, (_, i) => `tok${i}`));

    // The post-push enrollment: 9 bindings a row.
    await db.upsertPushWatchMany(
      Array.from({ length: 30 }, (_, i) => ({
        token: `push${i}`,
        chatId: "1",
        symbol: "T",
        pushedAt: 1_700_000_000_000 + i,
        mcapAtPush: 70_000,
        liquidityUsd: 20_000,
      })),
    );

    assert.equal(
      fake.maxArgs <= D1_MAX_BOUND_PARAMS,
      true,
      `a statement bound ${fake.maxArgs} parameters — D1 rejects anything over ${D1_MAX_BOUND_PARAMS}` +
        (fake.worst ? `\n      SQL: ${fake.worst.sql.slice(0, 300)}` : ""),
    );

    // The rows really landed (the statements ran; they were not merely split).
    const stats = await db.getTokenStatsMany(["tok0", "tok39", "tok199"]);
    assert.equal(stats.size, 3, "registration + liquidity rows must be readable");
    assert.equal(stats.get("tok0").maxMcapObserved, 80_000);
    const watch = await client.execute("SELECT COUNT(*) AS n FROM push_watch");
    assert.equal(Number(watch.rows[0].n), 30);

    // …and the write census sees them, which is the proof that `rowsAffected`
    // was translated from `meta.changes` and not from `meta.rows_written`.
    const census = writeCensusView();
    assert.equal(census.rows > 0, true, "the write census must count D1 writes");
    const keys = census.keys.map((k) => k.key);
    assert.equal(keys.includes("insert token_stats"), true, `keys: ${keys.join(", ")}`);
    assert.equal(keys.includes("update token_stats"), true, `keys: ${keys.join(", ")}`);

    client.close();
  });

  await test("Db on libsql: the same calls keep their original batch shape", async () => {
    const { client } = tmpClient();
    /** Every statement the Db sent, so each writer can be counted on its own. */
    let sent = [];
    const counting = {
      execute: (stmt) => {
        sent.push({ sql: String(stmt.sql), args: (stmt.args ?? []).length });
        return client.execute(stmt);
      },
      batch: (stmts, mode) => client.batch(stmts, mode),
    };
    const db = new Db("file:injected", undefined, counting);
    await db.init();

    /** The statements one writer issued, and the largest bind count among them. */
    const measure = (marker) => {
      const mine = sent.filter((s) => s.sql.includes(marker));
      return { statements: mine.length, maxArgs: Math.max(0, ...mine.map((s) => s.args)) };
    };

    // Registration: 200 rows × 12 bindings = ONE 2,400-parameter statement on
    // libsql (D1 splits the same call into 25).
    sent = [];
    await db.recordTokenStatsMany(bigStatsList(200));
    assert.deepEqual(
      measure("INSERT OR IGNORE INTO token_stats"),
      { statements: 1, maxArgs: 2400 },
      "registration must stay ONE 2,400-parameter statement on libsql",
    );

    // The observed-liquidity batch: 120 rows × 5 bindings (SET pair + IN + the
    // crossing CASE's copy) = 600, in two statements, exactly as before. On D1
    // this is ten statements (20 rows each) — a chunking fix that also applied
    // to libsql would add eight round trips to every tick's tail.
    sent = [];
    await db.recordObservedLiquidity(liquidityRows(200));
    assert.deepEqual(
      measure("last_liquidity_usd ="),
      { statements: 2, maxArgs: 600 },
      "liquidity must stay TWO 600-parameter statements on libsql",
    );

    // The max-mcap raise: 60 entries × 7 bindings = 420, one statement.
    sent = [];
    await db.updateTokenMaxMcaps(mcapEntries(60));
    assert.deepEqual(
      measure("max_mcap_observed ="),
      { statements: 1, maxArgs: 420 },
      "max-mcap must stay ONE 420-parameter statement on libsql",
    );

    client.close();
  });

  console.log("===== D1 TRANSPORT TESTS =====");
  for (const line of results) console.log(line);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("d1 transport suite crashed:", err);
  process.exit(1);
});
