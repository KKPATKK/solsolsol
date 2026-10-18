/*
 * The Turso → D1 copy path (2026-10-15).
 *
 * WHY THIS SUITE EXISTS. scripts/d1-copy.js is the script that stands between
 * this bot's state (116k rows: the seen set that gates every push, the pool the
 * tick evaluates, the tracker's watch list) and a store that has never held it.
 * Three failures are silent and each of them costs real duplicate cards:
 *
 *   1. THE CHUNK RULE. D1 rejects a statement with more than 100 bound
 *      parameters. A copy that builds its INSERTs by row count instead of by
 *      the shared rule (chunkForParamLimit, src/d1.ts) aborts in the middle of
 *      the biggest table and looks like a network error.
 *   2. THE CONFLICT MODE. The seed may overwrite (D1 has only bootstrap rows),
 *      the catch-up may ONLY insert — from the deploy onward D1 holds the newer
 *      truth, and an upsert there rolls live state backward: the push gate's
 *      seen_tokens rows, the tracker's up_stages, the push-audit ring.
 *   3. THE SCHEMA. The migration applies the schema by running the REAL
 *      `Db.init()` through src/d1.ts's transport, so production and the copy
 *      cannot disagree — this suite pins that the DDL really lands in the
 *      target database, not merely that some statements were sent.
 *
 * The D1 side is a fake REST API (`fetch`) backed by the REAL SQLite engine, so
 * every statement the copy builds is executed and its result read back, with
 * D1's own rejection rule enforced on top (the parameter ceiling, the per-
 * statement response shape, `meta.changes`).
 *
 * Run: node scripts/test-d1-migrate.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db } = require("../dist/db.js");
const { D1_MAX_BOUND_PARAMS, createD1Transport } = require("../dist/d1.js");
const {
  CloudflareApiError,
  MAX_REQUEST_BYTES,
  MAX_VALUE_BYTES,
  boundBytes,
  createD1Rest,
  createRestBinding,
  planRequests,
  statementBytes,
} = require("./d1-rest.js");
const {
  archiveCounts,
  assertEverythingLanded,
  authHint,
  insertStatement,
  introspect,
  copyAll,
  verify,
} = require("../scripts/d1-copy.js");
const bind = require("../scripts/d1-bind.js");

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

function tmpDb(label) {
  const file = path.join(
    os.tmpdir(),
    `d1-migrate-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return { client: createClient({ url: `file:${file}` }), file };
}

/** The schema src/db.ts applies, on a local file database. */
async function initLocal(client) {
  const db = new Db("file:injected", undefined, client);
  await db.init();
}

/**
 * D1's REST API, answered by a real SQLite engine, enforcing D1's rules:
 *  - more than 100 bound parameters in one statement is an API error;
 *  - a statement's SQL may not exceed 100 KB;
 *  - `result` is an ARRAY of `{results, success, meta}`, one per statement;
 *  - `meta.changes` is the modified-row count (not rows_written, which counts
 *    index entries — see normalizeD1Result in src/d1.ts).
 */
class FakeD1Api {
  constructor(accountId) {
    this.accountId = accountId;
    this.databases = new Map(); // uuid -> { name, client }
    this.requests = [];
    this.maxParams = 0;
    this.maxParamBytes = 0;
    this.worst = null;
    this.statements = 0;
    this.fetch = (url, init) => this.handle(String(url), init);
  }

  async handle(url, init = {}) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.Authorization ?? init.headers?.authorization;
    if (auth !== "Bearer test-token") {
      return this.reply(403, { success: false, errors: [{ code: 10000, message: "auth" }] });
    }
    // The client builds full Cloudflare URLs; the fake routes on the part below
    // the API version prefix, exactly like the real endpoints.
    const pathname = new URL(url).pathname.replace(/^\/client\/v4/, "");
    const base = `/accounts/${this.accountId}/d1/database`;
    this.requests.push({ method, pathname, body });

    if (method === "GET" && pathname === base) {
      return this.reply(200, {
        success: true,
        errors: [],
        result: [...this.databases].map(([uuid, db]) => ({ uuid, name: db.name, created_at: "now" })),
        result_info: { page: 1, total_pages: 1 },
      });
    }
    if (method === "POST" && pathname === base) {
      const name = body?.name;
      if (!name) return this.reply(400, { success: false, errors: [{ code: 1000, message: "name required" }] });
      if ([...this.databases.values()].some((db) => db.name === name)) {
        return this.reply(400, { success: false, errors: [{ code: 7502, message: "database name already exists" }] });
      }
      const uuid = `uuid-${this.databases.size + 1}`;
      const { client } = tmpDb(`d1-${uuid}`);
      this.databases.set(uuid, { name, client });
      return this.reply(200, { success: true, errors: [], result: { uuid, name, created_at: "now" } });
    }

    const match = pathname.match(new RegExp(`^${base}/([^/]+)/query$`));
    if (method === "POST" && match) {
      const db = this.databases.get(match[1]);
      if (!db) return this.reply(404, { success: false, errors: [{ code: 7404, message: "no such database" }] });
      const statements = body?.batch
        ? body.batch
        : [{ sql: body?.sql, params: body?.params ?? [] }];
      const out = [];
      for (const stmt of statements) {
        const failure = this.check(stmt);
        if (failure) return failure;
        const res = await db.client.execute({ sql: stmt.sql, args: stmt.params ?? [] });
        const rows = res.rows.map((row) => ({ ...row }));
        const changes = Number(res.rowsAffected ?? 0);
        out.push({ results: rows, success: true, meta: { changes, rows_written: changes, changed_db: changes > 0 } });
      }
      return this.reply(200, { success: true, errors: [], result: out });
    }
    return this.reply(404, { success: false, errors: [{ code: 7404, message: `no route ${pathname}` }] });
  }

  /** D1's own rejections, so a chunking bug fails here and not in production. */
  check(stmt) {
    const params = (stmt.params ?? []).length;
    this.statements++;
    if (params > this.maxParams) this.worst = stmt;
    this.maxParams = Math.max(this.maxParams, params);
    // The values are weighed, not judged: D1's 100 KB rule is the SQL TEXT (see
    // planRequests), so a fat value is legal here — it only has to stay inside
    // the documented 2 MB string/row ceiling.
    this.maxParamBytes = Math.max(this.maxParamBytes, boundBytes(stmt.params ?? []));
    for (const param of stmt.params ?? []) {
      if (typeof param === "string" && Buffer.byteLength(param) > MAX_VALUE_BYTES) {
        return this.reply(400, {
          success: false,
          errors: [{ code: 7500, message: `value over ${MAX_VALUE_BYTES} bytes` }],
        });
      }
    }
    if (params > D1_MAX_BOUND_PARAMS) {
      return this.reply(400, {
        success: false,
        errors: [
          {
            code: 7500,
            message: `too many bound parameters (${params} > ${D1_MAX_BOUND_PARAMS}): ${stmt.sql.slice(0, 120)}`,
          },
        ],
      });
    }
    if (Buffer.byteLength(stmt.sql) > 100_000) {
      return this.reply(400, { success: false, errors: [{ code: 7500, message: "statement too long" }] });
    }
    return null;
  }

  reply(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    };
  }

  clientFor(name) {
    const entry = [...this.databases.entries()].find(([, db]) => db.name === name);
    return entry ? { uuid: entry[0], ...entry[1] } : null;
  }
}

/** Creates a database in the fake account, the way `ensure` would. */
async function createDatabase(api, name) {
  const res = await api.handle("https://api.cloudflare.com/client/v4/accounts/acct/d1/database", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
    body: JSON.stringify({ name }),
  });
  const body = JSON.parse(await res.text());
  assert.equal(body.success, true, `create failed: ${JSON.stringify(body.errors)}`);
  return body.result.uuid;
}

async function count(client, table) {
  const res = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  return Number(res.rows[0].n);
}

async function main() {
  // ---- the request plan (limits that are not documented must still be held) --
  await test("planRequests: at most 50 statements and 1 MB per request", () => {
    const small = Array.from({ length: 121 }, (_, i) => ({ sql: "INSERT INTO t (a) VALUES (?)", params: [i] }));
    const requests = planRequests(small);
    assert.deepEqual(requests.map((r) => r.length), [50, 50, 21]);
    // A byte-heavy group is split by SIZE before the statement count runs out:
    // 20 statements of ~60 KB fit 16 to a 1 MB request, not 50.
    const heavy = Array.from({ length: 20 }, () => ({ sql: "INSERT INTO t (a) VALUES (?)", params: ["x".repeat(60_000)] }));
    assert.deepEqual(planRequests(heavy).map((r) => r.length), [16, 4]);
  });

  await test("planRequests: an over-long statement is refused, not sent", () => {
    assert.throws(
      () => planRequests([{ sql: `SELECT '${"x".repeat(100_001)}'`, params: [] }]),
      /over D1's 100000-byte limit/,
    );
  });

  await test("planRequests: the 100 KB rule counts the SQL text, not the bound values", () => {
    // The shape that stopped the first real seed (2026-10-15): an INSERT whose
    // SQL is ~50 bytes and whose params are 335 KB (worker_state's rows). D1's
    // limit is sqlite's SQLITE_LIMIT_SQL_LENGTH — the query TEXT — and SQLite's
    // own guidance for a value that size is to BIND it, so counting the values
    // towards the statement refused a statement D1 accepts.
    const fat = [
      { sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)", params: ["push_audit", "x".repeat(335_048)] },
    ];
    const plans = planRequests(fat);
    assert.equal(plans.length, 1, "one statement is one request");
    assert.equal(plans[0].length, 1);
    // The request bound still counts the values, so a group of them is split
    // before the body outgrows MAX_REQUEST_BYTES.
    const many = Array.from({ length: 4 }, () => ({
      sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)",
      params: ["k", "x".repeat(300_000)],
    }));
    const grouped = planRequests(many);
    assert.equal(grouped.length, 2, "1.2 MB of values does not fit one request");
    assert.equal(
      grouped.every((r) => r.reduce((n, s) => n + statementBytes(s), 0) <= MAX_REQUEST_BYTES),
      true,
    );
  });

  await test("planRequests: a value over D1's 2 MB row ceiling is refused by name", () => {
    assert.throws(
      () =>
        planRequests([
          { sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)", params: ["k", "x".repeat(MAX_VALUE_BYTES + 1)] },
        ]),
      /over D1's 2000000-byte row\/value limit/,
    );
  });

  await test("statementBytes counts SQL and parameters", () => {
    assert.equal(statementBytes({ sql: "SELECT 1", params: [] }), 8);
    // "SELECT ?" is 8 bytes, the JSON parameters are 7 more.
    assert.equal(statementBytes({ sql: "SELECT ?", params: [12345] }), 15);
  });

  // ---- the wrangler.toml binding -------------------------------------------
  await test("d1-bind: appends the binding block, replaces it idempotently", () => {
    const options = { binding: "DB", name: "solana-meme-bot", databaseId: "uuid-1" };
    const original = 'name = "solana-meme-bot"\n\n[vars]\nA = "1"\n';
    const once = bind.applyBinding(original, options);
    assert.equal(once.startsWith(original), true, "the file is preserved as it was");
    assert.equal(once.includes('binding = "DB"'), true);
    assert.equal(once.includes('database_id = "uuid-1"'), true);
    const twice = bind.applyBinding(once, options);
    assert.equal(twice, once, "running it twice must not stack two bindings");
    const moved = bind.applyBinding(once, { ...options, databaseId: "uuid-2" });
    assert.equal(moved.includes("uuid-1"), false, "the old id is removed, not left behind");
    assert.equal(moved.includes("uuid-2"), true);
    assert.equal(moved.split("[[d1_databases]]").length - 1, 1);
  });

  await test("d1-bind: an unclosed block is an error, not a silent append", () => {
    assert.throws(
      () => bind.applyBinding(`${bind.BEGIN}\n[[d1_databases]]\n`, {
        binding: "DB",
        name: "n",
        databaseId: "u",
      }),
      /opening marker but not its closing one/,
    );
  });

  // ---- the SQL the copy builds ---------------------------------------------
  await test("insertStatement: upsert names the key; ignore never overwrites", async () => {
    const tables = await introspect();
    const stats = tables.find((t) => t.name === "token_stats");
    assert.deepEqual(stats.pkColumns, ["token"]);
    const row = stats.columns.map((c) => (c.name === "token" ? "abc" : 1));
    const upsert = insertStatement(stats, [row], "upsert");
    assert.match(upsert.sql, /^INSERT INTO "token_stats" \("token", /);
    assert.match(
      upsert.sql,
      /ON CONFLICT \("token"\) DO UPDATE SET "first_seen_at" = excluded\."first_seen_at"/,
    );
    assert.equal(upsert.args.length, stats.columns.length);
    const ignore = insertStatement(stats, [row], "ignore");
    assert.match(ignore.sql, /^INSERT OR IGNORE INTO "token_stats"/);
    assert.equal(ignore.sql.includes("ON CONFLICT"), false, "ignore must not carry an update clause");

    // The primary key of a composite table is shipped whole.
    const seen = tables.find((t) => t.name === "seen_tokens");
    assert.deepEqual(seen.pkColumns, ["chat_id", "token"]);
    assert.match(
      insertStatement(seen, [seen.columns.map(() => 1)], "upsert").sql,
      /ON CONFLICT \("chat_id", "token"\) DO UPDATE SET/,
    );
  });

  await test("introspect: the copy's table set is the schema's, not a hand-written list", async () => {
    const tables = await introspect();
    // Name order, as SQLite's own BINARY collation sorts them — the copy walks
    // the list in this order and every assertion below indexes it by name.
    assert.deepEqual(
      tables.map((t) => t.name),
      [
        "chat_settings",
        // One row per (chat, token) card awaiting a transient retry
        // (2026-10-18) — the copy carries it like any other table, and its
        // composite primary key makes a re-copy idempotent per obligation.
        "push_outbox",
        "push_watch",
        "pushed_holders",
        "scan_history",
        "seen_tokens",
        "sell_log",
        // One row per tick (2026-10-17) — the copy carries it like any other
        // table; its `at` primary key makes a re-copy idempotent per tick.
        "tick_legs",
        "token_stats",
        "trade_log",
        "worker_state",
      ],
    );
    for (const table of tables) {
      assert.equal(table.columns.length > 0, true, `${table.name} has no columns`);
      assert.equal(table.pkColumns.length > 0, true, `${table.name} has no primary key`);
    }
  });

  await test("a table the archive predates copies as zero rows instead of failing the seed", async () => {
    // THE SHAPE THAT BROKE THE 2026-10-17 DEPLOY. The table list comes from the
    // LOCAL init() (so it grows with the schema), while the archive is a frozen
    // 2026-10-15 snapshot. `tick_legs` existed on one side only, and the seed
    // died with `SQLITE_UNKNOWN: no such table: tick_legs` before the deploy
    // step could run. A table the archive predates holds zero rows — a reading,
    // not a failure — and D1's copy of it is created by the same init.
    const old = tmpDb("archive-pre-tick-legs");
    try {
      await initLocal(old.client);
      await old.client.execute("DROP TABLE tick_legs");
      await old.client.execute(
        "INSERT INTO scan_history (at, ok, ms, err, profiles, pool, candidates, pushed) VALUES (1700000000000, 1, 4000, NULL, 12, 30, 5, 1)",
      );
      const tables = await introspect();
      // A dry run plans statements and sends none, so it needs no D1; the
      // verify half below only counts rows, so a one-row stub answers it.
      const stub = {
        batch: async () => [],
        execute: async () => ({ rows: [{ n: 1 }] }),
      };
      const runs = await copyAll({
        client: old.client,
        transport: stub,
        tables,
        mode: "upsert",
        dryRun: true,
        pageRows: 1,
        log: () => {},
      });
      const legs = runs.find((r) => r.table === "tick_legs");
      assert.ok(legs, "the table list still carries the new table");
      assert.equal(legs.rows, 0, "nothing to read from an archive that predates it");
      assert.equal(legs.statements, 0, "and nothing to plan");
      assert.equal(legs.absentInArchive, true, "and the log says WHY it is empty");
      assert.equal(
        runs.find((r) => r.table === "scan_history").rows,
        1,
        "the tables the archive does have are still copied",
      );
      // Both other readers of the archive side must agree with the copy.
      const counts = await archiveCounts(old.client, tables);
      assert.equal(counts.get("tick_legs"), 0);
      const report = await verify({
        client: old.client,
        transport: stub,
        tables,
        log: () => {},
        mode: "sane",
      });
      const legRow = (report.rows ?? report).find?.((r) => r.table === "tick_legs");
      if (legRow) assert.equal(legRow.archive, 0, "verify counts it as 0, not as missing");
    } finally {
      // tmpDb only hands back the client + path (the libsql client has no
      // close()); every other test in this file cleans up the same way.
      await fs.promises.rm(old.file, { force: true });
    }
  });

  // ---- the whole copy, against a D1 that enforces D1's rules ---------------
  const api = new FakeD1Api("acct");
  const databaseId = await createDatabase(api, "solana-meme-bot");
  const d1Client = api.clientFor("solana-meme-bot").client;

  const rest = createD1Rest({
    accountId: "acct",
    apiToken: "test-token",
    fetchImpl: api.fetch,
    sleep: async () => {},
  });
  const binding = createRestBinding(rest, databaseId);
  const transport = createD1Transport(binding);

  await test("schema: the REAL Db.init() lands in D1 through the REST binding", async () => {
    const db = new Db("", undefined, undefined, binding);
    await db.init();
    const tables = await d1Client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = tables.rows.map((r) => String(r.name));
    assert.deepEqual(names, (await introspect()).map((t) => t.name));
    // init stamps its fingerprint row, which is what makes the next init skip
    // the DDL — proof the batch really ran rather than merely being sent.
    const fingerprint = await d1Client.execute(
      "SELECT value FROM worker_state WHERE key = 'schema_ddl_fingerprint'",
    );
    assert.equal(fingerprint.rows.length, 1, "init must stamp the DDL fingerprint");
  });

  // The archive: the same schema, with rows in every table the bot fills.
  const archive = tmpDb("archive");
  await initLocal(archive.client);
  await archive.client.execute(
    "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, max_mcap_observed, discovered_via) VALUES ('tok-1', 1700000000000, 12.5, 90, 70000, 'test'), ('tok-2', 1700000001000, 13.5, 91, 71000, NULL)",
  );
  await archive.client.execute(
    "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-1', 'tok-1', 1700000000000), ('chat-2', 'tok-2', 1700000001000)",
  );
  await archive.client.execute(
    "INSERT INTO scan_history (at, ok, ms, err, profiles, pool, candidates, pushed) VALUES (1700000000000, 1, 4000, NULL, 12, 30, 5, 1)",
  );
  // PER-TICK LEG HISTORY (2026-10-17): nullable-by-design columns (a cut tick
  // publishes fewer readings than a completed one), and a JSON column whose
  // value must survive the copy byte for byte — the same shape the live table
  // stores.
  await archive.client.execute(
    "INSERT INTO tick_legs (at, via, ms, profiles, pool, pairs, pairs_jup, jup, pump, meteora, raydium, geo, boosts, feed_legs, candidates, pushed, organic_why) VALUES (1700000000000, 'clock', 942, 25, 1112, 202, 184, 30, 20, 20, 20, 0, 0, '{\"jup\":132,\"pump\":204}', 1, 0, 'backoff')",
  );
  await archive.client.execute(
    "INSERT INTO tick_legs (at, via, ms, profiles, pool) VALUES (1700000001000, NULL, NULL, NULL, NULL)",
  );
  await archive.client.execute(
    "INSERT INTO chat_settings (chat_id, min_liquidity_usd, enabled) VALUES ('chat-1', 12345, 1)",
  );
  await archive.client.execute(
    "INSERT INTO push_watch (token, chat_id, symbol, pushed_at, mcap_at_push, peak_mcap) VALUES ('tok-1', 'chat-1', 'T1', 1700000000000, 70000, 72000)",
  );
  await archive.client.execute(
    "INSERT INTO pushed_holders (token, owner, rank, ui_amount, pushed_at) VALUES ('tok-1', 'owner-1', 1, 5.5, 1700000000000)",
  );
  // THE CARD OUTBOX (2026-10-18): the retry row carries the rendered card and
  // its keyboard as TEXT (the artifact the tick cannot reconstruct later) plus
  // the numeric attempt/TTL budget, with a composite primary key that makes a
  // re-copy idempotent per obligation.
  await archive.client.execute(
    "INSERT INTO push_outbox (chat_id, token, symbol, message, keyboard, mcap, liquidity, pool, organic, attempts, next_at, expires_at, created_at, last_error) VALUES ('chat-1', 'tok-2', 'T2', '<b>T2</b> card', '{\"inline_keyboard\":[[{\"text\":\"BUY\"}]]}', 71000, 13000, 'pool-2', NULL, 1, 1700000060000, 1700000600000, 1700000000000, 'Telegram 500: oops')",
  );
  // The trade logs carry an INTEGER PRIMARY KEY (AUTOINCREMENT): the copy must
  // ship the id explicitly or the rows land under new ones.
  await archive.client.execute(
    "INSERT INTO trade_log (id, token, chat_id, mode, status, tx_hash, amount_sol, slippage_pct, created_at) VALUES (7, 'tok-1', 'chat-1', 'dry', 'filled', 'sig', 0.05, 1.5, 1700000000000)",
  );
  await archive.client.execute(
    "INSERT INTO sell_log (id, token, chat_id, mode, status, tx_hash, amount_token, created_at) VALUES (3, 'tok-1', 'chat-1', 'dry', 'half', 'sig2', 0.5, 1700000000000)",
  );
  // OR REPLACE: init itself writes the telemetry counters (over an empty
  // database), so the fixture sets them the way the archive's tick would have.
  await archive.client.execute(
    "INSERT OR REPLACE INTO worker_state (key, value) VALUES ('telemetry_seen_tokens_count', '2'), ('push_audit', '[{\"kind\":\"push\"}]')",
  );

  // The shape the first real seed died on (2026-10-15): a fat but perfectly
  // legal value. worker_state carries JSON blob rings (the live archive's
  // push_audit is 33 KB, the crime list bigger), and this one row is over D1's
  // 100 KB SQL-text rule the moment that rule is made to count the bound values
  // with the text — while D1 itself accepts 2 MB of value per row.
  const fatRing = `[${Array.from(
    { length: 5_000 },
    (_, i) => `{"m":"mint-${i}","at":1700${String(i % 1000).padStart(4, "0")}}`,
  ).join(",")}]`;
  await archive.client.execute({
    sql: "INSERT OR REPLACE INTO worker_state (key, value) VALUES ('crime_wallets_ring_v1', ?)",
    args: [fatRing],
  });

  const tables = await introspect();

  await test("seed: every archive row lands, values and NULLs included (upsert)", async () => {
    const runs = await copyAll({
      client: archive.client,
      transport,
      tables,
      mode: "upsert",
      dryRun: false,
      pageRows: 1, // one row a page, so paging is exercised on every table
      log: () => {},
    });
    assert.equal(runs.every((r) => r.rows > 0), true, "every table has rows to copy");
    assert.equal(
      api.maxParams <= D1_MAX_BOUND_PARAMS,
      true,
      `a statement bound ${api.maxParams} parameters — D1 rejects anything over ${D1_MAX_BOUND_PARAMS}` +
        (api.worst ? `\n      SQL: ${api.worst.sql.slice(0, 300)}` : ""),
    );

    const stats = await d1Client.execute("SELECT * FROM token_stats ORDER BY token");
    assert.equal(stats.rows.length, 2);
    assert.equal(String(stats.rows[0].token), "tok-1");
    assert.equal(Number(stats.rows[0].max_mcap_observed), 70000);
    assert.equal(Number(stats.rows[0].first_m5_vol), 12.5);
    assert.equal(stats.rows[1].discovered_via, null, "a NULL must stay NULL, not become a string");
    assert.equal(await count(d1Client, "seen_tokens"), 2);
    assert.equal(await count(d1Client, "scan_history"), 1);
    assert.equal(await count(d1Client, "chat_settings"), 1);
    assert.equal(await count(d1Client, "push_watch"), 1);
    assert.equal(await count(d1Client, "pushed_holders"), 1);
    // worker_state: init's own bootstrap rows plus the archive's, not instead of them.
    const state = await d1Client.execute("SELECT value FROM worker_state WHERE key = 'telemetry_seen_tokens_count'");
    assert.equal(String(state.rows[0].value), "2");
    // The fat value landed byte-identical — and it really went through the fake
    // API's checks, so this cannot pass by the copy having skipped the row.
    const ring = await d1Client.execute("SELECT value FROM worker_state WHERE key = 'crime_wallets_ring_v1'");
    assert.equal(
      String(ring.rows[0]?.value) === fatRing,
      true,
      "a five-figure value must ride as a bound parameter, byte for byte",
    );
    assert.equal(
      api.maxParamBytes >= 150_000,
      true,
      `the fat statement was never sent (max params seen: ${api.maxParamBytes} bytes)`,
    );

    // The strongest statement available at seed time: every row the copy READ
    // was written (rowsAffected == rows, so no statement silently did nothing),
    // and D1 holds at least that many rows. (Later passes can only report
    // counts — the archive keeps growing and D1 prunes.)
    assertEverythingLanded(runs);
    assert.equal(runs.every((r) => r.changes === r.rows), true, "an upsert affects one row per row");
    const baseline = await archiveCounts(archive.client, tables);
    await verify({ client: archive.client, transport, tables, log: () => {}, mode: "strict", baseline });
  });

  await test("seed is idempotent: a re-run changes nothing and still fits the limits", async () => {
    const before = await d1Client.execute("SELECT COUNT(*) AS n FROM token_stats");
    const runs = await copyAll({
      client: archive.client,
      transport,
      tables,
      mode: "upsert",
      dryRun: false,
      pageRows: 500,
      log: () => {},
    });
    const after = await d1Client.execute("SELECT COUNT(*) AS n FROM token_stats");
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
    // An upsert of an unchanged row still counts as affected (it is the same
    // `changes() == 1` the seed relies on), and no row was duplicated.
    assertEverythingLanded(runs);
    assert.equal(runs.every((r) => r.statements >= 1), true);
  });

  await test("catchup: adds rows D1 has never seen, never overwrites a newer one", async () => {
    // D1 is live from here on: the tracker has advanced its own row, a new coin
    // was pushed (a seen_tokens row the archive cannot know), and the archive
    // meanwhile holds a token_stats row written in the cutover window.
    await d1Client.execute("UPDATE push_watch SET peak_mcap = 99000, up_stages = '[\"up\"]' WHERE token = 'tok-1'");
    await d1Client.execute(
      "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-1', 'tok-9', 1700000002000)",
    );
    await archive.client.execute(
      "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min) VALUES ('tok-3', 1700000003000, 14.5, 92)",
    );
    await archive.client.execute("UPDATE token_stats SET max_mcap_observed = 5 WHERE token = 'tok-1'");

    const runs = await copyAll({
      client: archive.client,
      transport,
      tables,
      mode: "ignore",
      dryRun: false,
      pageRows: 500,
      log: () => {},
    });
    // Exactly ONE row was missing from D1 (the window's token_stats row): every
    // other table's rows already existed, and an ignored conflict writes nothing.
    assert.equal(runs.reduce((n, r) => n + r.changes, 0), 1);
    assert.equal(runs.find((r) => r.table === "token_stats").changes, 1);
    assert.equal(runs.find((r) => r.table === "seen_tokens").changes, 0);

    // The window's row landed…
    const arrived = await d1Client.execute("SELECT * FROM token_stats WHERE token = 'tok-3'");
    assert.equal(arrived.rows.length, 1);
    // …D1's newer push_watch row was left alone…
    const watch = await d1Client.execute("SELECT peak_mcap, up_stages FROM push_watch WHERE token = 'tok-1'");
    assert.equal(Number(watch.rows[0].peak_mcap), 99000, "ignore must not roll the tracker backward");
    assert.equal(String(watch.rows[0].up_stages), '["up"]');
    // …and the claim D1 itself made is still there.
    assert.equal(
      (await d1Client.execute("SELECT COUNT(*) AS n FROM seen_tokens WHERE token = 'tok-9'")).rows[0].n,
      1,
    );
    // The archive's STALE value for an existing row did not overwrite D1's.
    const tok1 = await d1Client.execute("SELECT max_mcap_observed FROM token_stats WHERE token = 'tok-1'");
    assert.equal(Number(tok1.rows[0].max_mcap_observed), 70000);
  });

  await test("verify: refuses a database that is empty or short, and forgives growth during the copy", async () => {
    const rows = await verify({ client: archive.client, transport, tables, log: () => {} });
    assert.equal(rows.length, tables.length);
    assert.equal(rows.every((r) => r.archive > 0 && r.d1 >= r.archive), true);

    // A freshly created D1 with the schema applied and NOTHING copied: the two
    // shapes a wrong database takes — tables the bot fills left empty, and a
    // copy that is plainly short of the archive.
    const other = new FakeD1Api("acct");
    const uuid = await createDatabase(other, "solana-meme-bot");
    const otherBinding = createRestBinding(
      createD1Rest({
        accountId: "acct",
        apiToken: "test-token",
        fetchImpl: other.fetch,
        sleep: async () => {},
      }),
      uuid,
    );
    const otherTransport = createD1Transport(otherBinding);
    await new Db("", undefined, undefined, otherBinding).init();
    await assert.rejects(
      () => verify({ client: archive.client, transport: otherTransport, tables, log: () => {} }),
      /D1 is empty in seen_tokens, token_stats/,
    );
    // A PARTIAL copy is the other shape: the tables the bot fills are there, and
    // the copy still did not carry everything — only `strict` catches that one.
    await copyAll({
      client: archive.client,
      transport: otherTransport,
      tables: tables.filter((t) => ["token_stats", "seen_tokens", "worker_state"].includes(t.name)),
      mode: "upsert",
      dryRun: false,
      pageRows: 500,
      log: () => {},
    });
    await verify({ client: archive.client, transport: otherTransport, tables, log: () => {} });
    const baseline = await archiveCounts(archive.client, tables);
    await assert.rejects(
      () => verify({
        client: archive.client,
        transport: otherTransport,
        tables,
        log: () => {},
        mode: "strict",
        baseline,
      }),
      /hold fewer rows in D1 than the copy read from the archive/,
    );
    // …and rows the LIVE bot adds to the archive after the copy are not held
    // against it: the seed must not fail because the bot kept ticking.
    await archive.client.execute(
      "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min) VALUES ('tok-late', 1700000004000, 15, 93)",
    );
    const grown = await verify({
      client: archive.client,
      transport: otherTransport,
      tables,
      log: () => {},
      baseline,
    });
    const statsRow = grown.find((r) => r.table === "token_stats");
    assert.equal(statsRow.archive, statsRow.read + 1, "the archive moved on after the baseline");
    // The row that appeared AFTER the baseline is not something the copy could
    // have carried, and the tables it DID copy still satisfy their own count.
    assert.equal(
      grown.filter((r) => r.read !== null && r.d1 > 0).every((r) => r.d1 >= r.read),
      true,
      "the copy's own yardstick still holds",
    );

    archive.client.close();
    for (const [, db] of api.databases) db.client.close();
    for (const [, db] of other.databases) db.client.close();
  });

  // ---- the ambiguous 401 --------------------------------------------------
  await test("a refused D1 call names its cause instead of printing the status twice", async () => {
    // Cloudflare answers the SAME 401/10000 for a revoked token and for a live
    // token with no D1 permission (workers-sdk#9320: wrangler deploys the
    // Worker, the D1 call is refused), so the message has to ask
    // /user/tokens/verify before it can say which one it was. These are the
    // three answers it must keep apart, plus the errors it must not touch.
    const reply = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    });
    const refuse = () =>
      reply(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    const fetchWith = (verifyResponse) => async (url) =>
      new URL(url).pathname.replace(/^\/client\/v4/, "") === "/user/tokens/verify"
        ? verifyResponse
        : refuse();
    const refusedCall = new CloudflareApiError(
      "GET /accounts/acct/d1/database → HTTP 401 (10000 Authentication error)",
      401,
      [{ code: 10000, message: "Authentication error" }],
    );
    const probe = (verifyResponse) => ({
      accountId: "acct",
      apiToken: "test-token",
      fetchImpl: fetchWith(verifyResponse),
    });

    const active = await authHint(
      refusedCall,
      probe(reply(200, { success: true, result: { id: "tok", status: "active" } })),
    );
    assert.match(active, /PERMISSION\/scope refusal/);
    assert.match(active, /D1 > Edit/);
    assert.match(active, /idempotent/);

    const expired = await authHint(
      refusedCall,
      probe(
        reply(200, {
          success: true,
          result: { id: "tok", status: "expired", expires_on: "2026-10-01T00:00:00Z" },
        }),
      ),
    );
    assert.match(expired, /"expired"/);
    assert.match(expired, /2026-10-01T00:00:00Z/);
    assert.doesNotMatch(expired, /PERMISSION/);

    // The real shape measured 2026-10-15: a token Cloudflare refuses answers the
    // D1 route 401/10000 and /user/tokens/verify 400. The message names the
    // credential as the thing to change and stops there — verify cannot see
    // every kind of token, so it does not get to call the token invalid.
    const unverifiable = await authHint(
      refusedCall,
      probe(reply(400, { success: false, errors: [{ code: 10000, message: "Authentication error" }] })),
    );
    assert.match(unverifiable, /HTTP 400/);
    assert.match(unverifiable, /credential itself is what has to change/);
    assert.doesNotMatch(unverifiable, /revoked|expired or mistyped/);

    // A refusal that is not an auth one (the parameter ceiling answers 400) and
    // a plain JS error get no invented cause…
    const ceiling = new CloudflareApiError("statement too big", 400, []);
    assert.equal(await authHint(ceiling, probe(reply(200, { success: true, result: {} }))), "");
    assert.equal(await authHint(new Error("boom"), {}), "");
    // …and with nothing to probe with, the hint stays SILENT rather than asking
    // as an empty token, which would answer 401 and blame the secret for it.
    assert.equal(await authHint(refusedCall, { accountId: "acct", apiToken: "" }), "");
  });

  // ---- the CI wiring that runs all of the above ----------------------------
  // A workflow step is invisible to the type system, and the failure mode is a
  // step that runs with an EMPTY credential variable — which is exactly how
  // this migration's first draft shipped a `schema`/`seed` pair without the
  // database id `ensure` had just resolved. These assertions are the ones that
  // would have caught it before a run.
  const readWorkflow = (name) =>
    fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");

  /** The lines of one job of a workflow (a 2-space-indented key starts the next). */
  function jobBlock(text, job) {
    const lines = text.split("\n");
    const start = lines.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, `deploy.yml has no ${job} job`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  }

  /** A job's steps, as `{ name, body }`. */
  function stepsOf(block) {
    const out = [];
    for (const line of block) {
      const header = line.match(/^ {6}- name: (.+)$/);
      if (header) out.push({ name: header[1], body: [] });
      else if (out.length > 0) out[out.length - 1].body.push(line);
    }
    return out.map((s) => ({ name: s.name, body: s.body.join("\n") }));
  }

  await test("deploy.yml: migrate → deploy → catchup, and every step gets the id it needs", () => {
    const yml = readWorkflow("deploy.yml");
    const migrate = stepsOf(jobBlock(yml, "migrate"));
    const deploy = stepsOf(jobBlock(yml, "deploy"));
    const catchup = stepsOf(jobBlock(yml, "catchup"));

    // Order matters more than anything else here: nothing may switch prod onto
    // D1 before the rows are in it, and the catch-up must run after the switch.
    assert.match(jobBlock(yml, "deploy").join("\n"), /needs: migrate/);
    assert.match(jobBlock(yml, "catchup").join("\n"), /needs: \[migrate, deploy\]/);

    const ensureStep = migrate.find((s) => s.body.includes("d1-copy.js ensure"));
    assert.ok(ensureStep, "migrate must resolve/create the database");
    assert.match(ensureStep.body, /id: database/);

    for (const sub of ["schema", "seed"]) {
      const step = migrate.find((s) => s.body.includes(`d1-copy.js ${sub}`));
      assert.ok(step, `migrate has no ${sub} step`);
      assert.match(
        step.body,
        /D1_DATABASE_ID: \$\{\{ steps\.database\.outputs\.database_id \}\}/,
        `the ${sub} step must receive the id \`ensure\` resolved`,
      );
    }
    // Without these the seed cannot read the archive at all — it would fail
    // after the DDL instead of before it.
    const seedStep = migrate.find((s) => s.body.includes("d1-copy.js seed"));
    assert.match(seedStep.body, /secrets\.TURSO_DATABASE_URL/);
    assert.match(seedStep.body, /secrets\.TURSO_AUTH_TOKEN/);

    // The cutover: the binding is injected into the runner's own checkout in
    // the same job, before the deploy that consumes it.
    const bindAt = deploy.findIndex((s) => s.body.includes("d1-bind.js --database-id"));
    // The COMMAND, not the word: the step's own trailing comments mention
    // `wrangler deploy` too (the cron-delivery note), and a text match on the
    // bare word finds the binding step itself.
    const deployAt = deploy.findIndex((s) => /^\s*run: .*wrangler deploy/m.test(s.body));
    assert.notEqual(bindAt, -1, "the deploy job must inject the D1 binding");
    assert.equal(bindAt < deployAt, true, "the binding must be injected BEFORE wrangler deploy");
    assert.match(deploy[bindAt].body, /needs\.migrate\.outputs\.database_id/);

    const catchupStep = catchup.find((s) => s.body.includes("d1-copy.js catchup"));
    assert.ok(catchupStep, "the catchup job must run the catch-up pass");
    assert.match(catchupStep.body, /needs\.migrate\.outputs\.database_id/);
    assert.match(catchupStep.body, /secrets\.TURSO_AUTH_TOKEN/);
    assert.match(catchupStep.body, /FORCE_CATCHUP/);

    // No committed database id, anywhere: it belongs to the account, not the
    // repository (see scripts/d1-bind.js), and a committed one would bind every
    // local deploy to someone else's database.
    assert.equal(/^\s*database_id\s*=/m.test(readWorkflow("deploy.yml")), false);
    assert.equal(/d1_databases/.test(fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8")), false,
      "wrangler.toml must not carry a committed D1 binding — CI injects it");
  });

  await test("the CI writers target D1, and archive credentials reach only the read-only copy", () => {
    // Turso is the READ-ONLY archive after the cutover: the copy is allowed to
    // hold its credentials because it issues SELECTs and nothing else (see
    // archiveClient in scripts/d1-copy.js), and every other job writes D1.
    // A writer that still carried TURSO_* could rotate a token or insert pool
    // rows into a store the Worker never reads — silently.
    const deployYml = readWorkflow("deploy.yml");
    const steps = ["migrate", "deploy", "catchup"].flatMap((job) =>
      stepsOf(jobBlock(deployYml, job)),
    );
    const withArchiveCreds = steps.filter((s) => /secrets\.TURSO_/.test(s.body));
    assert.equal(withArchiveCreds.length > 0, true, "the seed/catchup copy needs to read the archive");
    for (const step of withArchiveCreds) {
      assert.match(
        step.body,
        /d1-copy\.js (seed|catchup|verify)/,
        `"${step.name}" holds archive credentials but is not the read-only copy`,
      );
    }

    // The Axiom refresher is the operator job left that WRITES D1 FROM THE
    // RUNNER, so it must not hold archive credentials at all, and must name the
    // D1 database explicitly (resolved by name on every run). The pool backfill
    // used to be the second name in this loop; since 2026-10-15 it writes
    // through the deployed Worker's own binding instead, so it holds no
    // credential and resolves no database — pinned by its own test below.
    const axiomYml = readWorkflow("axiom-refresh.yml");
    assert.equal(/secrets\.TURSO_AUTH_TOKEN/.test(axiomYml), false, "axiom-refresh.yml still reads archive credentials");
    assert.equal(/secrets\.TURSO_DATABASE_URL/.test(axiomYml), false, "axiom-refresh.yml still reads archive credentials");
    assert.match(axiomYml, /scripts\/d1-copy\.js ensure/, "axiom-refresh.yml must resolve the D1 database");
    assert.match(axiomYml, /D1_DATABASE_ID: \$\{\{ steps\.d1\.outputs\.database_id \}\}/);

    // The four hand-run tools that CAN write a store carry the same explicit
    // opt-in, so "the archive is read-only" is a property of the scripts and not
    // only of the workflows: backfill (token_stats rows), the Axiom refresher
    // (the rotated pair — a rotation in the wrong store kills the session),
    // pool-read-cost's `index` mode (a partial index the Worker mints on D1),
    // and test-filters.js — which is `npm test`, called by hand far more often
    // than any of them, and which upserts token_stats then runs the REAL
    // Scanner.runOnce before deleting its own seen_tokens rows.
    const optIns = [
      ["scripts/backfill-pumpfun.mjs", /--allow-archive-write/],
      ["scripts/axiom-refresh-action.py", /ARCHIVE_WRITE_OK/],
      ["scripts/pool-read-cost.js", /ALLOW_ARCHIVE_WRITE/],
      ["scripts/test-filters.js", /--allow-archive-write/],
    ];
    for (const [file, optIn] of optIns) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(src, optIn, `${file} must gate its archive writes behind an opt-in`);
    }

    // The opt-in must be a CONJUNCTION with the credentials: a guard that only
    // mentioned the flag would still connect whenever TURSO_* happened to be in
    // the environment (which is exactly how `npm test` reached the archive in
    // this workspace). Only the phases' `if (db)` checks may then follow.
    const filters = fs.readFileSync(path.join(__dirname, "..", "scripts", "test-filters.js"), "utf8");
    assert.match(
      filters,
      /const USE_ARCHIVE = Boolean\(URL && TOKEN\) && ARCHIVE_WRITE_OK;/,
      "test-filters.js must make the archive available only when opt-in AND credentials are both present",
    );
    assert.match(
      filters,
      /if \(USE_ARCHIVE\) \{/,
      "test-filters.js phase 1 must gate the real settings read on USE_ARCHIVE",
    );

    // …and there is a THIRD way to run the database phases that reaches no
    // remote store at all: FILTERS_LOCAL_DB, a throwaway SQLite file through
    // the injected-client seam. It exists because the guard above left the
    // writing path (registration, claims, the flush) with no hand-run check —
    // either skip the DB or write the frozen archive. Two properties keep it
    // from becoming a hole: the explicit archive opt-in WINS (a stale variable
    // cannot redirect a deliberate archive run), and the local Db is built on
    // the local file, never on the Turso URL.
    assert.match(
      filters,
      /const USE_LOCAL = Boolean\(LOCAL_DB\) && !ARCHIVE_WRITE_OK;/,
      "the local DB mode must be unusable while the archive opt-in is on",
    );
    assert.match(
      filters,
      /const USE_DB = USE_ARCHIVE \|\| USE_LOCAL;/,
      "the phases must gate on `a store exists`, not on the archive alone",
    );
    assert.match(
      filters,
      /new Db\(`file:\$\{LOCAL_DB\}`/,
      "local mode must build its Db on the local file, not on the Turso URL",
    );
    assert.match(
      filters,
      /USE_LOCAL\s*\n?\s*\? createClient\(\{ url: `file:\$\{LOCAL_DB\}` \}\)/,
      "…and its seen_tokens cleanup must stay on the same file",
    );
  });

  await test("the pool backfill asks the deployed Worker, and can write no store itself", () => {
    // WHY THIS PINS A WORKFLOW. The one-shot backfill used to scrape pump.fun's
    // launch feed from the runner and gate on its reachability. That feed
    // refuses every egress this bot has (403 / Cloudflare challenge, measured
    // 2026-10-15: sandbox, Worker AND the GitHub-hosted runner), so the gate
    // skipped the backfill while the job still reported SUCCESS — the failure
    // this change removes. It now asks the deployed Worker's `/debug/backfill`
    // route, whose D1 binding does the write in production.
    const yml = readWorkflow("backfill-pumpfun.yml");
    assert.match(yml, /node scripts\/backfill-pool\.mjs/, "the workflow must run the pool-backfill script");
    assert.equal(
      /backfill-pumpfun\.mjs/.test(yml),
      false,
      "the pump.fun script's feed is refused from every egress we have — the workflow must not invoke it",
    );
    // It fetches no feed itself: the probe (curl) was the gate that turned a
    // blocked feed into a green run, and the Worker is what reaches Birdeye.
    // Comments are stripped first, so the header may discuss the old probe
    // without the assertion either failing on prose or passing on it — the old
    // file's curl sat on a `run: |` continuation line, which a match on the
    // `run:` line alone would have missed.
    const codeOnly = yml
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.equal(
      /\bcurl\b/.test(codeOnly),
      false,
      "the workflow must not fetch a feed itself — the Worker's route is the only call",
    );
    // NO credential at all, which is stronger than the archive-credential rule
    // it replaces: the route is unauthenticated and the write is the Worker's,
    // so there is nothing here to rotate, leak — or resolve a database with.
    assert.equal(/secrets\./.test(yml), false, "the backfill workflow must hold no secret at all");
    assert.equal(
      /D1_DATABASE_ID|database_id/.test(yml),
      false,
      "it writes through the Worker's binding, so it resolves no database id",
    );
    // Manual only: dispatching is what spends Birdeye CU, so a `push:` trigger
    // (the old file had one, on the script's path) would seed production as a
    // side effect of a commit. Asserted on the `on:` BLOCK, not on its first
    // line: the old file's `workflow_dispatch:` was first there too, with
    // `push:` right behind it.
    const onAt = yml.indexOf("\non:");
    const jobsAt = yml.indexOf("\njobs:");
    assert.ok(onAt > 0 && jobsAt > onAt, "the workflow must keep an on: block above its jobs");
    const onBlock = yml.slice(onAt, jobsAt);
    assert.match(onBlock, /^  workflow_dispatch:/m, "dispatch is the trigger to keep");
    assert.equal(
      /^\s{2}(push|schedule|pull_request|workflow_run|release):/m.test(onBlock),
      false,
      "the trigger must be dispatch-ONLY — the route writes production",
    );

    // The URL the run asks is wrangler.toml's CRON_RELAY_URL, resolved AT RUN
    // TIME — a hostname copied into a script or workflow is how a job ends up
    // asking a Worker that no longer exists. Asserted as BEHAVIOR (the script's
    // own --check-url, which sends nothing) rather than by grepping its source.
    const scriptPath = path.join(__dirname, "..", "scripts", "backfill-pool.mjs");
    const script = fs.readFileSync(scriptPath, "utf8");
    const tomlUrl = fs
      .readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8")
      .match(/^\s*CRON_RELAY_URL\s*=\s*"([^"]+)"/m)?.[1];
    assert.ok(tomlUrl, "wrangler.toml must carry CRON_RELAY_URL (the Worker's own URL)");
    const { spawnSync } = require("node:child_process");
    const checked = spawnSync(process.execPath, [scriptPath, "--check-url"], { encoding: "utf8" });
    assert.equal(checked.status, 0, `--check-url must resolve a URL, got: ${checked.stderr}`);
    assert.equal(
      checked.stdout.trim(),
      tomlUrl,
      "the script must ask the Worker wrangler.toml declares — never a copy of the hostname",
    );
    assert.equal(
      /workers\.dev/.test(script),
      false,
      "the hostname must not be duplicated in the script",
    );
    // The honesty the old workflow lacked: a refusal exits non-zero, and the
    // seed is confirmed by reading the row back through the pool's own read
    // path — `ok:true` from the writer alone is not evidence the row landed.
    assert.match(script, /process\.exit\(1\)/, "a refused or unlanded run must exit non-zero");
    assert.match(script, /TOKEN_PATH/, "the script must read the seeded row back");
    assert.match(script, /\/debug\/backfill/, "the script must name the route it drives");
  });

  console.log("===== D1 MIGRATION TESTS =====");
  for (const line of results) console.log(line);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log(
    `  (D1 requests issued: ${api.requests.filter((r) => r.pathname.endsWith("/query")).length}, statements: ${api.statements}, max bound params: ${api.maxParams})`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("d1 migration suite crashed:", err);
  process.exit(1);
});
