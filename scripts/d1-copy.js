#!/usr/bin/env node
/*
 * Turso → Cloudflare D1: create the database, apply the schema, copy the rows
 * (2026-10-15).
 *
 * WHY. Turso's free plan bills rows WRITTEN; this bot writes ~624k/day against
 * an allowance of 333k/day (1.9x, measured — see docs/d1-migration-2026-10-15.md).
 * The account is already on Workers Paid, whose D1 allowance INCLUDES 50M rows
 * written a month, so the fix is a different store, not less writing. Turso
 * becomes a read-only archive: everything that used to write it now reads it
 * once, here.
 *
 * THE SHAPE OF THE COPY IS NOT INVENTED HERE. Column lists, primary keys and
 * the table set are read from a throwaway LOCAL database that the real
 * `Db.init()` has just created (see introspect) — i.e. from the same DDL
 * src/db.ts applies in production. Chunk sizes come from src/d1.ts's
 * `chunkForParamLimit` with D1's own 100-bound-parameter ceiling, the same
 * helper and the same number the tick's writers use. The schema is applied to
 * D1 by running the REAL `init()` through src/d1.ts's `createD1Transport` over
 * the REST binding (scripts/d1-rest.js), so production and this script cannot
 * disagree about what the schema is.
 *
 * TWO PASSES, AND WHY THE MARKERS MATTER. The cutover is `wrangler deploy` with
 * the binding present (binding presence IS the switch — see src/worker.ts), so
 * there is a window between "the copy finished reading Turso" and "prod stopped
 * writing Turso". The passes answer that:
 *
 *   seed     BEFORE the deploy. Full copy, `ON CONFLICT … DO UPDATE` — it is
 *            the only pass allowed to OVERWRITE, because it is the only one
 *            that runs while D1 has nothing but schema bootstrap rows.
 *            Stamped with worker_state.d1_seed_v1 so a re-run never repeats it
 *            (and so a failed deploy does not re-run it either: prod never
 *            switched, and the catch-up below fills whatever moved since).
 *   catchup  AFTER the deploy. `INSERT OR IGNORE` — it may only ADD rows D1 has
 *            never seen, never overwrite one, because from the deploy onward D1
 *            holds the NEWER truth and the archive is frozen. Stamped with
 *            worker_state.d1_cutover_v1, after which both passes are no-ops and
 *            every later deploy only verifies counts.
 *
 * Losing at most one tick of archive-window drift in the ignore pass is
 * deliberate: the alternative (upsert after the deploy) would roll live state
 * BACKWARD, which is the one direction that can duplicate pushes.
 *
 * Usage (CI drives these; D1_DATABASE_ID/D1_DATABASE_NAME and the credentials
 * come from the environment):
 *   node scripts/d1-copy.js ensure            # create if absent, print the uuid
 *   node scripts/d1-copy.js schema            # run Db.init() against D1
 *   node scripts/d1-copy.js seed              # pre-deploy, upsert
 *   node scripts/d1-copy.js catchup           # post-deploy, insert-if-missing
 *   node scripts/d1-copy.js verify            # counts only, non-zero if short
 *   node scripts/d1-copy.js seed --dry-run    # read Turso, write nothing
 * Flags: --force (ignore the pass's marker; the deploy workflow sets
 * FORCE_CATCHUP for its manual re-run input), --tables=a,b, --page-rows=N,
 * --dry-run (read the archive, build every statement, send nothing).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db } = require("../dist/db.js");
const {
  D1_MAX_BOUND_PARAMS,
  chunkForParamLimit,
  createD1Transport,
} = require("../dist/d1.js");
const {
  CloudflareApiError,
  MAX_VALUE_BYTES,
  boundBytes,
  createD1Rest,
  createRestBinding,
  normalizeStatement,
  planRequests,
} = require("./d1-rest.js");

/** worker_state key stamped by a completed `seed` pass (see the header). */
const SEED_MARKER_KEY = "d1_seed_v1";
/** worker_state key stamped by a completed `catchup` pass — the cutover. */
const CUTOVER_MARKER_KEY = "d1_cutover_v1";

/** Rows read from Turso per request (a page is one libsql round trip). */
const PAGE_ROWS = 500;

/** Statements handed to the transport at once (the REST layer splits further). */
const STATEMENTS_PER_FLUSH = 200;

/** Column types the copy can carry as JSON parameters. */
const COPYABLE_TYPES = /^(|text|integer|int|real|numeric|blob_\?)$/i;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Tables the bot provably fills once it has run once (the pool, the seen set,
 * worker_state). A zero in any of them is a wrong database, not a delete — see
 * verify. Not a copy list: the copy list is every table `Db.init()` creates.
 */
const NEVER_EMPTY_TABLES = ["worker_state", "seen_tokens", "token_stats"];

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const hasFlag = (name) => process.argv.slice(2).includes(name);

/** A GitHub Actions boolean input arrives as the string "true". */
const envFlag = (name) => /^(1|true)$/i.test(process.env[name] ?? "");

/** `key=value` into the log AND into $GITHUB_OUTPUT when CI asks for it. */
function setOutput(key, value) {
  console.log(`${key}=${value}`);
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${key}=${value}\n`);
}

/**
 * The schema as the LOCAL database has it after a real `Db.init()`, i.e. the
 * column lists and primary keys D1 must receive. Read from `PRAGMA table_info`
 * rather than written down here, because a hard-coded column list is exactly
 * the thing that silently stops matching src/db.ts — the copy would then insert
 * rows into columns that no longer exist, or drop a new one to its default.
 */
async function introspect() {
  const file = path.join(
    os.tmpdir(),
    `d1-copy-schema-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${file}` });
  try {
    const db = new Db("file:injected", undefined, client);
    await db.init();
    const listing = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables = [];
    for (const row of listing.rows) {
      const name = String(row.name);
      const info = await client.execute(`PRAGMA table_info(${quoteIdent(name)})`);
      const columns = info.rows.map((c) => ({
        name: String(c.name),
        type: String(c.type ?? ""),
        pk: Number(c.pk ?? 0),
      }));
      const unportable = columns.filter((c) => c.type && !COPYABLE_TYPES.test(c.type));
      if (unportable.length > 0) {
        throw new Error(
          `${name} has a column type this copy cannot carry over JSON (${unportable
            .map((c) => `${c.name} ${c.type}`)
            .join(", ")}) — encode it explicitly instead of letting the value silently become NULL`,
        );
      }
      tables.push({
        name,
        columns,
        pkColumns: columns
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
      });
    }
    return tables;
  } finally {
    client.close();
    fs.rmSync(file, { force: true });
  }
}

/**
 * One multi-row statement for `rows` (arrays, in `table.columns` order).
 *
 * `upsert` needs the primary key spelled out in `ON CONFLICT (<pk>)`, and every
 * non-key column set from `excluded` — a conflict target without a unique index
 * is a hard SQLite error, which is why the keys come from PRAGMA and not from a
 * guess.
 */
function insertStatement(table, rows, mode) {
  const columnList = table.columns.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = `(${table.columns.map(() => "?").join(", ")})`;
  const values = rows.map(() => placeholders).join(", ");
  const head = mode === "upsert" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
  let conflict = "";
  if (mode === "upsert") {
    const updatable = table.columns.filter((c) => !table.pkColumns.includes(c.name));
    conflict = table.pkColumns.length
      ? updatable.length > 0
        ? ` ON CONFLICT (${table.pkColumns.map(quoteIdent).join(", ")}) DO UPDATE SET ${updatable
            .map((c) => `${quoteIdent(c.name)} = excluded.${quoteIdent(c.name)}`)
            .join(", ")}`
        : ` ON CONFLICT (${table.pkColumns.map(quoteIdent).join(", ")}) DO NOTHING`
      : "";
  }
  const args = [];
  for (const row of rows) args.push(...row);
  return { sql: `${head} ${quoteIdent(table.name)} (${columnList}) VALUES ${values}${conflict}`, args };
}

/** The Turso client for the archive. Read-only by construction: SELECTs only. */
function archiveClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    throw new Error(
      "TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are required to read the archive (in CI they are repository secrets; see .github/workflows/deploy.yml)",
    );
  }
  return createClient({ url: url.replace(/^libsql:\/\//, "https://"), authToken: token });
}

/** The D1 transport every write goes through — src/d1.ts's own adapter. */
function d1Transport() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = process.env.D1_DATABASE_ID;
  if (!databaseId) throw new Error("D1_DATABASE_ID is required (see `ensure`)");
  const api = createD1Rest({ accountId, apiToken });
  return { api, transport: createD1Transport(createRestBinding(api, databaseId)) };
}

/** One page of rows, keyset-paginated on rowid (OFFSET would rescan per page). */
async function readPage(client, table, columns, afterRowid, limit) {
  const list = columns.map((c) => quoteIdent(c.name)).join(", ");
  const res = await client.execute({
    sql: `SELECT rowid AS __rowid, ${list} FROM ${quoteIdent(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    args: [afterRowid, limit],
  });
  return res.rows.map((row) => ({
    rowid: Number(row.__rowid),
    values: columns.map((c) => portableValue(row[c.name], table.name, c.name)),
  }));
}

/**
 * WHY A 401 IS NOT AN ANSWER. Cloudflare refuses a D1 call with `401 / 10000
 * Authentication error` in two very different situations: the credential is
 * revoked or expired, or the credential is perfectly good and simply has no D1
 * access — the "Edit Cloudflare Workers" template deploys this Worker on every
 * push and carries no D1 permission (cloudflare/workers-sdk#9320 is that exact
 * shape). Both arrive here as the same status, so when one does, ask
 * `/user/tokens/verify` (needs no account, no extra permission) and say which
 * one it was. This runs on the FAILURE path only: a healthy run makes no extra
 * call, and a run whose credentials are refused never gets far enough to have
 * written anything, which is why the hint can promise a re-run is safe.
 *
 * Returns "" whenever it has nothing certain to add — an unrelated error, a
 * missing credential, or a probe that itself failed gets no invented cause.
 */
async function authHint(
  err,
  {
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    fetchImpl = undefined,
  } = {},
) {
  if (!(err instanceof CloudflareApiError)) return "";
  if (err.status !== 401 && err.status !== 403) return "";
  if (!apiToken) return "";
  try {
    const { status, expiresOn } = await createD1Rest({
      accountId,
      apiToken,
      ...(fetchImpl ? { fetchImpl } : {}),
    }).verifyToken();
    if (status === "active") {
      return (
        `\n  the token itself answers /user/tokens/verify as "active" — it IS a valid Cloudflare credential` +
        `, so this is a PERMISSION/scope refusal, not a bad token. D1 needs Account > D1 > Edit on the` +
        ` account CLOUDFLARE_ACCOUNT_ID names (a token built from Cloudflare's "Edit Cloudflare Workers"` +
        ` template deploys this Worker on every push and still has no D1 access).` +
        `\n  Nothing was written to D1 by this run; add the permission and re-run, the copy is idempotent.`
      );
    }
    return (
      `\n  the token itself answers /user/tokens/verify as "${status}"${expiresOn ? ` (expires_on ${expiresOn})` : ""}` +
      ` — the CLOUDFLARE_API_TOKEN secret needs reissuing. Nothing was written to D1 by this run;` +
      ` the copy is idempotent, so re-running after the new secret is set is safe.`
    );
  } catch (probeErr) {
    // Measured 2026-10-15 against the real API: a token Cloudflare does not
    // accept answers the D1 route 401/10000 and /user/tokens/verify 400. What is
    // NOT claimed here is WHICH of those it is — verify needs no account and no
    // permission, but it also cannot see every kind of token (an account-owned
    // one, for instance), so all it proves is that the credential is what needs
    // fixing rather than the call.
    return (
      `\n  the D1 API refused this credential AND /user/tokens/verify refused it too (HTTP ${probeErr?.status ?? "?"})` +
      ` — verify needs no account and no permission, so the credential itself is what has to change, not the call.` +
      ` Reissue CLOUDFLARE_API_TOKEN (Account > D1 > Edit) and re-run; nothing was written and the copy is idempotent.`
    );
  }
}

/**
 * JSON parameters only carry null/string/number/boolean. libsql hands back
 * bigints for large integers and Uint8Array for blobs; both would either throw
 * or silently become an object on the wire, so they are converted here, where
 * the column name is still known (a bare `JSON.stringify` failure names nothing).
 */
function portableValue(value, table, column) {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) {
    throw new Error(
      `${table}.${column} is binary; this copy carries text/numbers only — encode it deliberately`,
    );
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/**
 * Copies ONE table. Reads the archive in pages and writes each page's statements
 * in flushes, so memory stays bounded by a flush rather than by the table (the
 * largest here is 59k rows) and a failure's progress is real rows, not a
 * half-built array.
 */
async function copyTable({ client, transport, table, mode, dryRun, pageRows, onProgress }) {
  // The chunk size is the SHARED rule (src/d1.ts), not a local guess: one row
  // costs one binding per column, and D1 rejects a statement over 100.
  const argsPerRow = Math.max(1, table.columns.length);
  const rowsPerStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / argsPerRow));

  let afterRowid = -1;
  let rows = 0;
  let statements = 0;
  let changes = 0;
  let pending = [];
  let maxParams = 0;
  let requests = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    if (dryRun) {
      // A dry run exists to catch what the real run would fail on, so it must
      // still PLAN the requests. Skipping the plan is how a statement of ~200
      // bytes of SQL carrying 335 KB of worker_state params passed a 37.9s dry
      // run and then stopped the first real seed in CI (2026-10-15).
      // Normalized exactly the way createRestBinding/`api.batch` normalizes
      // them, so the dry run weighs the same statements the real run sends
      // (the copy builds `{sql, args}`; the wire wants `{sql, params}`).
      requests += planRequests(pending.map(normalizeStatement)).length;
      pending = [];
      return;
    }
    const results = await transport.batch(pending);
    for (const result of results) changes += Number(result.rowsAffected ?? 0);
    pending = [];
  };

  for (;;) {
    const page = await readPage(client, table, table.columns, afterRowid, pageRows);
    if (page.length === 0) break;
    afterRowid = page[page.length - 1].rowid;
    rows += page.length;
    // A row past D1's documented 2 MB string/row ceiling cannot be carried by
    // ANY chunking, so it is refused here, by rowid, instead of being sent to
    // be rejected by the API in the middle of a 117k-row copy.
    for (const row of page) {
      const bytes = boundBytes(row.values);
      if (bytes > MAX_VALUE_BYTES) {
        throw new Error(
          `${table.name} rowid ${row.rowid} is ${bytes} bytes, over D1's ${MAX_VALUE_BYTES}-byte row/value limit` +
            ` — no chunk size can carry it, that value has to shrink first`,
        );
      }
    }
    for (const chunk of chunkForParamLimit(page.map((r) => r.values), argsPerRow, D1_MAX_BOUND_PARAMS)) {
      const statement = insertStatement(table, chunk, mode);
      maxParams = Math.max(maxParams, statement.args.length);
      pending.push(statement);
      statements++;
    }
    if (pending.length >= STATEMENTS_PER_FLUSH) {
      await flush();
      onProgress?.({ table: table.name, rows, statements, changes, maxParams });
    }
    if (page.length < pageRows) break;
  }
  await flush();
  return { table: table.name, rows, statements, changes, maxParams, rowsPerStatement, requests };
}

/** Every table, in name order. `only` narrows to a `--tables=` list. */
async function copyAll({ client, transport, tables, mode, dryRun, pageRows, log }) {
  const out = [];
  for (const table of tables) {
    const result = await copyTable({
      client,
      transport,
      table,
      mode,
      dryRun,
      pageRows,
      onProgress: (p) => log(`${table.name}: ${p.rows} rows read → ${p.statements} statements, ${p.changes} rows written`),
    });
    log(
      `${table.name}: ${result.rows} rows → ${result.statements} statements ` +
        `(${result.rowsPerStatement}/statement, max ${result.maxParams} params)` +
        (dryRun
          ? ` [dry run: ${result.requests} requests planned, every statement inside D1's limits]`
          : `, ${result.changes} rows affected`),
    );
    out.push(result);
  }
  return out;
}

/** `COUNT(*)` on one side of the copy. */
async function countRows(transport, table) {
  const res = await transport.execute({ sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}` });
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * What the archive held when the copy STARTED, per table.
 *
 * WHY A BASELINE AND NOT "the archive right now": the bot is LIVE during the
 * seed (the deploy has not switched it yet), so the archive keeps growing — a
 * tick inserts scan_history, a push inserts seen_tokens, the re-eval pool
 * rewrites token_stats. Comparing D1 to a count taken afterwards would demand
 * rows the copy never saw and fail the very run that is supposed to succeed.
 * The copy can only be held to what it READ.
 */
async function archiveCounts(client, tables) {
  const out = new Map();
  for (const table of tables) {
    const res = await client.execute(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`);
    out.set(table.name, Number(res.rows[0]?.n ?? 0));
  }
  return out;
}

/**
 * The verification that decides whether the migration is real: every table's
 * row count on BOTH sides, and a non-zero exit when D1 holds fewer rows than
 * the archive. D1 having MORE is expected forever after the cutover (the bot
 * keeps writing), which is why only "short" is a failure.
 */
async function verify({ client, transport, tables, log, mode = "sane", baseline = null }) {
  const rows = [];
  let short = 0;
  const empty = [];
  for (const table of tables) {
    const archive = Number(
      (await client.execute(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`)).rows[0]?.n ?? 0,
    );
    const read = baseline?.get(table.name) ?? null;
    const d1 = await countRows(transport, table.name);
    // `strict` is held to the baseline (what the copy read); the live archive
    // count is printed beside it because a difference there is expected.
    if (mode === "strict" ? read !== null && d1 < read : d1 < archive) short++;
    if (archive > 0 && d1 === 0 && NEVER_EMPTY_TABLES.includes(table.name)) empty.push(table.name);
    rows.push({ table: table.name, read, archive, d1, delta: d1 - archive });
    log(
      `${table.name.padEnd(16)} read ${String(read ?? "-").padStart(7)}   archive ${String(archive).padStart(7)}` +
        `   d1 ${String(d1).padStart(7)}   ${mode === "strict" && read !== null && d1 < read ? `SHORT ${read - d1}` : `+${d1 - archive}`}`,
    );
  }
  // A table the bot provably fills, empty in D1, is the wrong database (or one
  // that was reset) — never a delete: nothing prunes these to zero.
  if (empty.length > 0) {
    throw new Error(
      `D1 is empty in ${empty.join(", ")} while the archive has rows — wrong database, or the seed never landed`,
    );
  }
  // `strict` is only claimed right after an upsert copy, when D1 provably holds
  // every archive row. Later the counts are NOT comparable in either direction:
  // D1 keeps the live age window (its prune runs), the archive is frozen, and
  // post-cutover writes only ever add. Reporting them is the point; failing on
  // them would fail on a prune.
  if (short > 0 && mode === "strict") {
    throw new Error(
      `${short} table(s) hold fewer rows in D1 than the copy read from the archive — the copy did not land`,
    );
  }
  return rows;
}

/**
 * The seed's second proof, independent of any count: every row the copy READ was
 * written. An upsert reports one affected row per row whether it inserted or
 * updated, so `rowsAffected` must equal the rows read — a short count here means
 * a statement silently did nothing, which a row-count comparison could still
 * miss (the archive grows while the copy runs, so "D1 ≥ archive" is not enough).
 */
function assertEverythingLanded(results) {
  const short = results.filter((r) => r.changes < r.rows);
  if (short.length > 0) {
    throw new Error(
      `the copy read rows D1 did not take: ${short
        .map((r) => `${r.table} read ${r.rows}, affected ${r.changes}`)
        .join("; ")}`,
    );
  }
}

/** One worker_state marker, or null (an absent table means "not stamped yet"). */
async function readMarker(transport, key) {
  try {
    const res = await transport.execute({
      sql: "SELECT value FROM worker_state WHERE key = ?",
      args: [key],
    });
    return res.rows.length > 0 ? String(res.rows[0].value) : null;
  } catch {
    return null;
  }
}

async function writeMarker(transport, key) {
  await transport.execute({
    sql: "INSERT OR REPLACE INTO worker_state (key, value) VALUES (?, ?)",
    args: [key, new Date().toISOString()],
  });
  return new Date().toISOString();
}

// ---- subcommands -----------------------------------------------------------

/** `ensure`: the database named D1_DATABASE_NAME, created if the account lacks it. */
async function cmdEnsure() {
  const name = process.env.D1_DATABASE_NAME || "solana-meme-bot";
  const known = process.env.D1_DATABASE_ID;
  if (known) {
    console.log(`D1_DATABASE_ID is set (${known}) — using it, no API call`);
    setOutput("database_id", known);
    setOutput("database_name", name);
    return;
  }
  const api = createD1Rest({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  const db = await api.ensureDatabase(name);
  console.log(
    `${db.created ? "created" : "found"} D1 database ${db.name} (uuid ${db.uuid})` +
      (db.createdAt ? `, created_at ${db.createdAt}` : ""),
  );
  setOutput("database_id", db.uuid);
  setOutput("database_name", db.name);
}

/** `schema`: exactly what a cold isolate runs — `Db.init()` over the REST binding. */
async function cmdSchema() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = process.env.D1_DATABASE_ID;
  if (!databaseId) throw new Error("D1_DATABASE_ID is required (see `ensure`)");
  // The SAME binding shape and the same transport production uses, so the DDL,
  // the fingerprint gate and the column probes all run as they will on a cold
  // isolate — a schema step that used its own SQL path could pass here and
  // still fail at the first production init.
  const binding = createRestBinding(createD1Rest({ accountId, apiToken }), databaseId);
  const transport = createD1Transport(binding);
  const db = new Db("", undefined, undefined, binding);
  await db.init();
  const fingerprint = await transport.execute({
    sql: "SELECT value FROM worker_state WHERE key = 'schema_ddl_fingerprint'",
  });
  const tables = (await transport.execute({
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  }));
  setOutput("schema_tables", Number(tables.rows[0]?.n ?? 0));
  setOutput(
    "schema_ddl_fingerprint",
    fingerprint.rows.length > 0 ? String(fingerprint.rows[0].value) : "unknown",
  );
}

async function runCopy(kind) {
  const dryRun = hasFlag("--dry-run");
  const force = hasFlag("--force") || envFlag("FORCE_CATCHUP");
  const pageRows = Number(arg("--page-rows", PAGE_ROWS));
  const only = arg("--tables", null);
  const mode = kind === "seed" ? "upsert" : "ignore";
  const markerKey = kind === "seed" ? SEED_MARKER_KEY : CUTOVER_MARKER_KEY;
  const log = (line) => console.log(`[copy] ${line}`);

  const tables = (await introspect()).filter((t) => (only ? only.split(",").includes(t.name) : true));
  log(`schema from a local init(): ${tables.length} tables, D1 ceiling ${D1_MAX_BOUND_PARAMS} params/statement`);

  const client = archiveClient();
  try {
    if (dryRun) {
      // Read-only rehearsal: the whole archive is read, every statement is
      // built, and nothing is sent anywhere. This is how the copy's own risk
      // (paging, the chunk rule, the row shape, the row counts) is measured
      // before a database exists — and it needs no Cloudflare credentials.
      await copyAll({ client, transport: null, tables, mode, dryRun, pageRows, log });
      setOutput("copied", "false");
      return;
    }
    const { transport } = d1Transport();
    const stamped = await readMarker(transport, markerKey);
    if (stamped && !force) {
      log(`${markerKey} already stamped (${stamped}) — nothing to copy`);
      setOutput("copied", "false");
      await verify({ client, transport, tables, log });
      return;
    }
    // The seed is the one pass whose result can be proven by counting: it runs
    // (or re-runs) while nothing else writes D1, so afterwards D1 holds every
    // row it read. The catch-up runs against a LIVE database and only reports.
    const verifyMode = kind === "seed" ? "strict" : "sane";
    const baseline = verifyMode === "strict" ? await archiveCounts(client, tables) : null;
    log(
      `pass ${kind} (${mode}) starting` +
        (stamped ? ` — ${markerKey} overridden by --force` : ""),
    );
    const results = await copyAll({ client, transport, tables, mode, dryRun, pageRows, log });
    if (kind === "seed") assertEverythingLanded(results);
    log(
      `pass ${kind} done: ${results.reduce((n, r) => n + r.rows, 0)} rows, ` +
        `${results.reduce((n, r) => n + r.statements, 0)} statements, ` +
        `${results.reduce((n, r) => n + r.changes, 0)} rows affected`,
    );
    await verify({ client, transport, tables, log, mode: verifyMode, baseline });
    const at = await writeMarker(transport, markerKey);
    log(`stamped ${markerKey} = ${at}`);
    setOutput("copied", "true");
  } finally {
    client.close();
  }
}

/** `verify`: counts only. The deploy's own "is D1 actually the store?" check. */
async function cmdVerify() {
  const tables = await introspect();
  const client = archiveClient();
  const { transport } = d1Transport();
  try {
    await verify({ client, transport, tables, log: (line) => console.log(`[verify] ${line}`) });
  } finally {
    client.close();
  }
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "ensure":
      return cmdEnsure();
    case "schema":
      return cmdSchema();
    case "seed":
      return runCopy("seed");
    case "catchup":
      return runCopy("catchup");
    case "verify":
      return cmdVerify();
    default:
      throw new Error(
        `unknown command ${command ?? "(none)"} — expected ensure | schema | seed | catchup | verify`,
      );
  }
}

module.exports = {
  CUTOVER_MARKER_KEY,
  PAGE_ROWS,
  SEED_MARKER_KEY,
  STATEMENTS_PER_FLUSH,
  archiveCounts,
  authHint,
  assertEverythingLanded,
  copyAll,
  copyTable,
  countRows,
  insertStatement,
  introspect,
  readPage,
  verify,
};

if (require.main === module) {
  main().catch(async (err) => {
    // The hint is decided HERE rather than per subcommand so every path that can
    // meet the ambiguous 401 (ensure, schema, seed, catchup) says the same thing.
    const hint = await authHint(err);
    console.error(`d1-copy failed: ${err instanceof Error ? err.message : err}${hint}`);
    if (err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  });
}
