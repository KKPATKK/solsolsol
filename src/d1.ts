/**
 * Cloudflare D1 as a transport for `Db` (2026-10-15).
 *
 * WHY. Turso's free plan bills ROWS WRITTEN and this bot writes ~624k/day
 * against a 10M/month (333k/day) allowance — a chronic ~1.9x overage that the
 * 2026-10-14 call-level trims did not move (measured live: 624,463 rows on
 * 10-14, and 25,356/hour in the clean window after the L1+L2 deploy). The
 * account is already on Workers Paid, whose D1 allowance INCLUDES 50M rows
 * written a month (then $1/M, the same unit price as Turso's overage) — so
 * moving the state machine to D1 costs the $5 plan that is already paid and
 * removes the overage rather than reducing it.
 *
 * WHAT THIS IS. `Db` talks to exactly two calls — `execute({sql, args})` and
 * `batch([...], mode)` — and reads `rows` / `rowsAffected` off the answers
 * (see `wrapClientWithHardWall`, which intercepts those two names and nothing
 * else). This module adapts the Workers D1 binding to that same shape, so the
 * whole of `src/db.ts` — the single-flight lock, the batched registration, the
 * write census, the deferred-write drain — runs unchanged on either store.
 * Nothing here is Turso-specific: the libsql path keeps its own client (see
 * asSqlTransport in src/db.ts), which is what the Node entry, the scripts and
 * the offline unit suite use.
 *
 * THE TWO SHAPE DIFFERENCES THAT MATTER (both handled here):
 *   1. libsql answers `{rows, rowsAffected}`; D1 answers
 *      `{results, meta: {changes, rows_written}}`. `rows`/`rowsAffected` are
 *      what every call site reads, so D1 is translated INTO that shape rather
 *      than the other way round — a rewrite the other way would touch 81
 *      `execute` and 35 `batch` call sites.
 *      `meta.changes` (not `meta.rows_written`) is the translation's choice:
 *      `rows_written` counts index entries too (D1 documents it as such), while
 *      `changes` is SQLite's own modified-row count — the same quantity libsql
 *      reports as `rowsAffected`, which the write census (src/db.ts
 *      noteWriteCensus) and every `rowsAffected > 0` test in this repo compare
 *      against. Mixing the two would silently double the census.
 *   2. D1 rejects a statement with more than 100 bound parameters
 *      (developers.cloudflare.com/d1/platform/limits). `Db` sizes its chunks
 *      from `paramLimit()`, which answers this constant when the binding is in
 *      use — see Db.recordObservedLiquidity / updateTokenMaxMcaps /
 *      noteSweptWithoutReading, whose unchunked libsql shapes bind 600, 7n and
 *      120 parameters respectively.
 *
 * STATEMENT FORM. D1's `prepare().run()` is for statements that do not return
 * rows and `all()` for those that do; the binding is stricter here than libsql,
 * which accepts either call for either shape. The split is by leading verb
 * (SELECT/WITH/PRAGMA → `all()`, everything else → `run()`), because a
 * `CREATE TABLE` routed to `all()` is the one that actually throws.
 *
 * NO BACK-TRANSLATION. `batch()` is D1's own transactional batch (sequential,
 * all-or-nothing), which is exactly what `Db`'s batched claims already rely on
 * under libsql — the cross-isolate single-flight lock and the tick's must-land
 * writes both assume a failed batch leaves nothing written.
 *
 * NOTE ON COST AND LATENCY: a D1 binding call is a subrequest like the Turso
 * HTTP call it replaces (Workers counts services such as D1), and D1 documents
 * 1,000 queries per invocation on Paid plus a 30-second cap on a whole batch.
 * `Db`'s per-tick statement count (~250, batched) sits well inside both, but
 * the cap is a runtime property this module cannot enforce — it is measured
 * live via /health (`dbTickSteps`, `writeCensus`).
 */
import type { Row } from "@libsql/client/web";

/** D1's documented bound-parameter ceiling for ONE statement. */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * The part of a D1 result `Db` reads. Mirrors the binding's shape without
 * pulling in @cloudflare/workers-types, which this Worker deliberately avoids
 * (see Env/ScheduledEventLike in src/worker.ts).
 */
export interface D1ResultLike {
  results?: Array<Record<string, unknown>> | null;
  success?: boolean;
  meta?: {
    changes?: number;
    rows_written?: number;
    rows_read?: number;
    last_row_id?: number;
    changed_db?: boolean;
  } | null;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(): Promise<D1ResultLike>;
  run(): Promise<D1ResultLike>;
}

/** The Workers D1 binding (`env.DB`). */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

/** A statement in the shape `Db` builds them. */
export interface D1Statement {
  sql: string;
  args?: readonly unknown[];
}

/** What one statement answers, in the shape every `Db` call site reads. */
export interface D1TransportResult {
  rows: Row[];
  rowsAffected: number;
}

/**
 * Statements whose answer carries rows, i.e. the ones that must go through
 * `all()`. Anything else — INSERT/UPDATE/DELETE/DDL — belongs to `run()`.
 */
const RETURNS_ROWS = /^\s*(select|with|pragma)\b/i;

/**
 * D1's answer, in libsql's shape. `rows` is cast: D1 hands back plain objects
 * while libsql's `Row` is an array with named properties (its own docs call the
 * array form legacy). Every reader in this repo goes through
 * `String(row.x)` / `Number(row.x)` or `row as Record<string, unknown>`, so the
 * object form is what they already handle.
 */
export function normalizeD1Result(res: D1ResultLike | null | undefined): D1TransportResult {
  const rows = (res?.results ?? []) as unknown as Row[];
  const changes = Number(res?.meta?.changes ?? 0);
  return { rows, rowsAffected: Number.isFinite(changes) ? changes : 0 };
}

/** One statement, prepared and bound for the binding. */
function prepare(d1: D1DatabaseLike, stmt: D1Statement | string): D1PreparedStatementLike {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const args = typeof stmt === "string" ? [] : (stmt.args ?? []);
  return args.length > 0 ? d1.prepare(sql).bind(...args) : d1.prepare(sql);
}

/** The Db's two calls, answered by the D1 binding. */
export interface D1Transport {
  execute(stmt: D1Statement | string): Promise<D1TransportResult>;
  batch(stmts: Array<D1Statement | string>): Promise<D1TransportResult[]>;
  close(): void;
}

/**
 * Adapts a D1 binding to the transport `Db` drives. Exported for the unit
 * tests, which pin the shape translation and the write/read routing against a
 * fake binding (the D1 binding itself does not exist outside Workers).
 */
export function createD1Transport(d1: D1DatabaseLike): D1Transport {
  return {
    async execute(stmt) {
      const prepared = prepare(d1, stmt);
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      return normalizeD1Result(
        RETURNS_ROWS.test(sql) ? await prepared.all() : await prepared.run(),
      );
    },
    async batch(stmts) {
      if (stmts.length === 0) return [];
      const results = await d1.batch(stmts.map((s) => prepare(d1, s)));
      return results.map((r) => normalizeD1Result(r));
    },
    close() {
      // A binding owns its own connection: there is nothing to close, and
      // `Db` only ever calls close() from the Node entry (libsql path).
    },
  };
}

/**
 * Splits `rows` into the chunks a statement may bind, given that each row costs
 * `argsPerRow` bindings: at most `floor(paramLimit / argsPerRow)` rows per chunk,
 * and never more than `cap` (the caller's own round-trip preference, e.g. the
 * 120 rows recordObservedLiquidity has always used on libsql).
 *
 * WHY ONE HELPER. Three writers in src/db.ts build a row-count-sized statement
 * (recordObservedLiquidity at 3 bindings a row, noteSweptWithoutReading at 1,
 * updateTokenMaxMcaps at 7), and each of them has to respect the transport's
 * ceiling — D1's 100 is a hard reject, not a slow path. Sizing them from ONE
 * function is what makes a unit test able to assert the ceiling for all three
 * (and for the Turso → D1 copy script, which uses it against multi-column
 * INSERTs).
 */
export function chunkForParamLimit<T>(
  rows: readonly T[],
  argsPerRow: number,
  paramLimit: number,
  cap: number = Number.POSITIVE_INFINITY,
): T[][] {
  const perChunk = Math.max(
    1,
    Math.min(cap, Math.floor(paramLimit / Math.max(1, argsPerRow))),
  );
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) out.push(rows.slice(i, i + perChunk));
  return out;
}
