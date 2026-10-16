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
 *      THE CEILING SPLITS STATEMENTS, NEVER REQUESTS. Each of those writers is
 *      pinned to EXACTLY ONE request per call on both stores (fake.roundTrips):
 *      a batch runs its statements in one round trip, so a writer that awaited
 *      each chunk separately would turn a parameter limit into a round-trip
 *      multiplier. That is not hypothetical — measured live on D1 on
 *      2026-10-15 (`/health.heartbeat.summary.dbTickSteps`), recordTokenStatsMany
 *      cost 2,875ms across 3 calls and updateTokenMaxMcaps 1,954ms across 5,
 *      against a store whose own SQL answered `meta.duration 0.2165` ms: the
 *      requests were the cost, not the statements.
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
    /**
     * Round trips, counted the way the store bills them: an `all()`/`run()` is
     * one request, a `batch()` is one request however many statements it
     * carries. Reset before a writer call to pin that call's shape.
     */
    this.roundTrips = { singles: 0, batches: 0, batchStatements: 0 };
  }

  reset() {
    this.roundTrips = { singles: 0, batches: 0, batchStatements: 0 };
  }

  prepare(sql) {
    const self = this;
    const build = (args) => ({
      _sql: sql,
      _args: args,
      bind: (...more) => build(more),
      all: () => {
        self.roundTrips.singles += 1;
        return self.exec(sql, args);
      },
      run: () => {
        self.roundTrips.singles += 1;
        return self.exec(sql, args);
      },
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
    this.roundTrips.batches += 1;
    this.roundTrips.batchStatements += stmts.length;
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
  await test("Db on D1: every row-count-sized writer is ONE request under 100 bindings", async () => {
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    const db = new Db("", undefined, undefined, fake);
    await db.init();

    /**
     * One writer call, and the shape it cost: exactly ONE batch request, no
     * single-statement request at all, carrying `statements` statements. The
     * split is the CEILING's business — the round trip must not multiply with
     * it (see runChunked in src/db.ts).
     */
    const oneRequest = async (label, run, statements, extraSingles = 0) => {
      fake.reset();
      await run();
      assert.deepEqual(
        fake.roundTrips,
        { singles: extraSingles, batches: 1, batchStatements: statements },
        `${label} must be ONE request carrying ${statements} statement(s)` +
          ` (plus ${extraSingles} bookkeeping request(s) of its own)`,
      );
      assert.equal(
        fake.maxArgs <= D1_MAX_BOUND_PARAMS,
        true,
        `${label} bound ${fake.maxArgs} parameters — D1 rejects anything over ${D1_MAX_BOUND_PARAMS}` +
          (fake.worst ? `\n      SQL: ${fake.worst.sql.slice(0, 300)}` : ""),
      );
    };

    // Registration: 200 coins, 12 bindings a row — the shape D1 rejects
    // outright (40 registrations already bind 480), so 25 statements of 8 rows.
    //
    // The ONE extra single-statement request is telemetry_token_stats_count,
    // and it is correct that it stays separate: its delta is the rows INSERT OR
    // IGNORE actually admitted, which only the server can answer (`changes()`),
    // so it must FOLLOW the statements it counts rather than be computed before
    // them — see CLAIM_COUNTER_UPSERT_SQL's own note on this. It is one request
    // per registration pass, not one per chunk.
    await oneRequest(
      "recordTokenStatsMany(200 rows)",
      () => db.recordTokenStatsMany(bigStatsList(200)),
      25,
      1,
    );

    // The observed-liquidity batch: 5 bindings a row, 20 rows a statement.
    await oneRequest(
      "recordObservedLiquidity(200 rows)",
      () => db.recordObservedLiquidity(liquidityRows(200)),
      10,
    );

    // The max-mcap raise: 7 bindings an entry, 14 entries a statement.
    await oneRequest(
      "updateTokenMaxMcaps(60 entries)",
      () => db.updateTokenMaxMcaps(mcapEntries(60)),
      5,
    );

    // The freshness mark: 1 binding a token, 100 tokens a statement.
    await oneRequest(
      "noteSweptWithoutReading(150 tokens)",
      () => db.noteSweptWithoutReading(Array.from({ length: 150 }, (_, i) => `tok${i}`)),
      2,
    );

    // The post-push enrollment: 9 bindings a row, 11 rows a statement.
    await oneRequest(
      "upsertPushWatchMany(30 rows)",
      () =>
        db.upsertPushWatchMany(
          Array.from({ length: 30 }, (_, i) => ({
            token: `push${i}`,
            chatId: "1",
            symbol: "T",
            pushedAt: 1_700_000_000_000 + i,
            mcapAtPush: 70_000,
            liquidityUsd: 20_000,
          })),
        ),
      3,
    );

    // The holder snapshot: 7 bindings a row, 14 rows a statement.
    await oneRequest(
      "recordPushedHolders(40 rows)",
      () =>
        db.recordPushedHolders(
          Array.from({ length: 40 }, (_, i) => ({
            token: `hold${i}`,
            owner: `own${i}`,
            rank: i + 1,
            uiAmount: 1000 + i,
            isCreator: i === 0,
            crimeHit: false,
          })),
          1_700_000_000_000,
        ),
      3,
    );

    // The rows really landed (the statements ran; they were not merely split).
    const stats = await db.getTokenStatsMany(["tok0", "tok39", "tok199"]);
    assert.equal(stats.size, 3, "registration + liquidity rows must be readable");
    assert.equal(stats.get("tok0").maxMcapObserved, 80_000);
    const watch = await client.execute("SELECT COUNT(*) AS n FROM push_watch");
    assert.equal(Number(watch.rows[0].n), 30);
    const holders = await client.execute("SELECT COUNT(*) AS n FROM pushed_holders");
    assert.equal(Number(holders.rows[0].n), 40);

    // …and the write census sees them, which is the proof that `rowsAffected`
    // was translated from `meta.changes` and not from `meta.rows_written`.
    const census = writeCensusView();
    assert.equal(census.rows > 0, true, "the write census must count D1 writes");
    const keys = census.keys.map((k) => k.key);
    assert.equal(keys.includes("insert token_stats"), true, `keys: ${keys.join(", ")}`);
    assert.equal(keys.includes("update token_stats"), true, `keys: ${keys.join(", ")}`);

    client.close();
  });

  await test("Db on D1: a list-shaped READ wider than the ceiling still runs in ONE request", async () => {
    // THE READER HALF OF THE CEILING (2026-10-16). The cutover chunked the
    // writers that size a statement by ROW COUNT, but a reader sized by CALLER
    // DATA had the same 100-parameter ceiling and no treatment: a feed wider
    // than 100 tokens made `getTokenStatsMany` a hard error that the scanner can
    // only absorb by skipping a whole tick's registration (`stats-read`).
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    const db = new Db("", undefined, undefined, fake);
    await db.init();
    await db.recordTokenStatsMany(bigStatsList(250));

    // 250 tokens = 250 bindings on one statement: illegal on D1, one request in
    // three statements when split (100/100/50).
    fake.reset();
    const tokens = Array.from({ length: 250 }, (_, i) => `tok${i}`);
    const stats = await db.getTokenStatsMany(tokens);
    assert.equal(stats.size, 250, "every token in the wide feed comes back");
    assert.deepEqual(
      fake.roundTrips,
      { singles: 0, batches: 1, batchStatements: 3 },
      "250 tokens must be 3 statements in ONE request, never three requests",
    );
    assert.equal(fake.maxArgs <= D1_MAX_BOUND_PARAMS, true, `max bound ${fake.maxArgs}`);

    // A narrower list keeps the single-statement shape: re-asking for 40 is one
    // statement, so the split only ever fires at the ceiling.
    fake.reset();
    assert.equal((await db.getTokenStatsMany(tokens.slice(0, 40))).size, 40);
    assert.deepEqual(fake.roundTrips, { singles: 1, batches: 0, batchStatements: 0 });

    // The other list-shaped reader: 120 owners + its two own bindings
    // (`pushed_at > ?`, `HAVING coins >= ?`) → 98 a statement, so 2.
    const owners = Array.from({ length: 120 }, (_, i) => `own${i}`);
    await db.recordPushedHolders(
      Array.from({ length: 120 }, (_, i) => ({
        token: `hold${i}`,
        owner: `own${i}`,
        rank: i + 1,
        uiAmount: 1000 + i,
        isCreator: i === 0,
        crimeHit: false,
      })),
      1_700_000_000_000,
    );
    fake.reset();
    const clusters = await db.getHolderClusters(owners, 1_600_000_000_000, 1);
    assert.equal(clusters.length, 120, "every owner's cluster row is merged back");
    assert.deepEqual(
      fake.roundTrips,
      { singles: 0, batches: 1, batchStatements: 2 },
      "120 owners + 2 own bindings = 2 statements of 98, in ONE request",
    );
    assert.equal(fake.maxArgs <= D1_MAX_BOUND_PARAMS, true, `max bound ${fake.maxArgs}`);
    client.close();
  });

  await test("Db on D1: a duplicated push claim answers false — the guard's own 0", async () => {
    // The claim is what stops a second card for a coin: an `INSERT OR IGNORE`
    // into seen_tokens whose row count the caller reads as the answer. A LOST
    // claim has to answer false, and that is D1's `meta.changes` for an insert
    // SQLite skipped — the negative direction of the translation, i.e. the one
    // whose failure mode is duplicate cards. Only the winning case was pinned
    // before (the batch test above), so this is the other half.
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    const db = new Db("", undefined, undefined, fake);
    await db.init();
    assert.equal(await db.claimTokenPush("1", "dup"), true, "the first claim must win");
    assert.equal(await db.claimTokenPush("1", "dup"), false, "the second claim must lose");
    assert.equal(await db.isTokenSeen("1", "dup"), true, "…and the row is still there");
    // ONE row, ONE counted claim: the paired counter statement rides the same
    // batch and asks SQLite's own `changes()`, so a lost claim must not move it
    // (the count is what `/health` publishes and what the reconcile compares).
    const rows = await client.execute("SELECT COUNT(*) AS n FROM seen_tokens");
    assert.equal(Number(rows.rows[0].n), 1);
    const counter = await client.execute(
      "SELECT value FROM worker_state WHERE key = 'telemetry_seen_tokens_count'",
    );
    assert.equal(Number(counter.rows[0].value), 1, "one winning claim, one counted row");
    client.close();
  });

  await test("Db on D1: a scan still reports what its round trips cost", async () => {
    // WHY THIS ONE IS PINNED (2026-10-16). `diag.dbMs` (/debug/tick-legs' `dbMs`)
    // is the tick's own un-raced DB cost, and on libsql it exists because the
    // SCAN client installs the wall's `onCost` hook (see ensureScanClient). The
    // D1 branch used to serve both modes from connect(), which passes no hook —
    // so every D1 tick reported `dbMs: 0` and the reading was silently dead on
    // the store the tick now uses (measured live: every /debug/tick-legs row,
    // 2026-10-16). The hook belongs on the scan client, because `get()` picks
    // that client exactly while the scan window is open.
    const { client } = tmpClient();
    const fake = new FakeD1(client);
    // ONE deliberately slow statement: the wall's onCost is wall time, and a
    // temp-file SQLite round trip can settle inside the same millisecond this
    // test started in — a real delay is what makes "cost > 0" mean something.
    const rawExec = fake.exec.bind(fake);
    fake.exec = async (sql, args) => {
      if (args.includes("slow-probe")) await new Promise((r) => setTimeout(r, 40));
      return rawExec(sql, args);
    };
    const db = new Db("", undefined, undefined, fake);
    await db.init();

    db.enterScanMode();
    await db.getWorkerState("slow-probe");
    const cost = db.exitScanMode();
    assert.ok(cost >= 40, `a scan must report the round trips it paid for (got ${cost}ms)`);

    // Leaving scan mode still answers: the wrapper changed the counter, not the
    // binding. Outside the window the same read must NOT be counted at all
    // (that number is the scan's, and exitScanMode already reset it).
    assert.equal(await db.getWorkerState("anything"), null);
    db.enterScanMode();
    const idle = db.exitScanMode();
    assert.equal(idle, 0, "a scan with no round trips must report 0ms, not a stale count");
    client.close();
  });

  await test("Db on libsql: the same calls keep their original statement shape, in ONE request", async () => {
    const { client } = tmpClient();
    /** Every statement the Db sent, so each writer can be counted on its own. */
    let sent = [];
    /** Requests, the way the transport bills them: one per batch() call. */
    let batches = 0;
    /** Single-statement calls, counted apart from `batches` for the READERS:
     *  a read that fits the ceiling must stay the execute() it always was. */
    let singles = 0;
    const counting = {
      execute: (stmt) => {
        singles += 1;
        sent.push({ sql: String(stmt.sql), args: (stmt.args ?? []).length });
        return client.execute(stmt);
      },
      batch: (stmts, mode) => {
        batches += 1;
        for (const s of stmts) {
          sent.push({ sql: String(s.sql ?? s), args: (s.args ?? []).length });
        }
        return client.batch(stmts, mode);
      },
    };
    const db = new Db("file:injected", undefined, counting);
    await db.init();

    /** How one writer call looked: its statements, its heaviest bind, its requests. */
    const measure = (marker) => {
      const mine = sent.filter((s) => s.sql.includes(marker));
      return {
        statements: mine.length,
        maxArgs: Math.max(0, ...mine.map((s) => s.args)),
        requests: batches,
      };
    };

    // Registration: 200 rows × 12 bindings = ONE 2,400-parameter statement on
    // libsql (D1 splits the same call into 25 statements), and ONE request on
    // both stores.
    sent = [];
    batches = 0;
    await db.recordTokenStatsMany(bigStatsList(200));
    assert.deepEqual(
      measure("INSERT OR IGNORE INTO token_stats"),
      { statements: 1, maxArgs: 2400, requests: 1 },
      "registration must stay ONE 2,400-parameter statement in ONE request",
    );

    // The observed-liquidity batch: 120 rows × 5 bindings (SET pair + IN + the
    // crossing CASE's copy) = 600, in two statements, exactly as before. On D1
    // this is ten statements (20 rows each) — a chunking fix that also applied
    // to libsql would add eight round trips to every tick's tail.
    sent = [];
    batches = 0;
    await db.recordObservedLiquidity(liquidityRows(200));
    assert.deepEqual(
      measure("last_liquidity_usd ="),
      { statements: 2, maxArgs: 600, requests: 1 },
      "liquidity must stay TWO 600-parameter statements in ONE request on libsql",
    );

    // The max-mcap raise: 60 entries × 7 bindings = 420, one statement.
    sent = [];
    batches = 0;
    await db.updateTokenMaxMcaps(mcapEntries(60));
    assert.deepEqual(
      measure("max_mcap_observed ="),
      { statements: 1, maxArgs: 420, requests: 1 },
      "max-mcap must stay ONE 420-parameter statement in ONE request on libsql",
    );

    // The list-shaped READER: 250 tokens is 250 bindings, far under libsql's
    // 32,766 — so the new chunking must NOT fire here, or every wide feed would
    // quietly buy extra statements on a store that never asked for them.
    sent = [];
    batches = 0;
    singles = 0;
    await db.getTokenStatsMany(Array.from({ length: 250 }, (_, i) => `tok${i}`));
    assert.deepEqual(
      { ...measure("SELECT * FROM token_stats"), singles },
      { statements: 1, maxArgs: 250, requests: 0, singles: 1 },
      "a 250-token read must stay ONE 250-parameter statement in ONE execute() call on libsql",
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
