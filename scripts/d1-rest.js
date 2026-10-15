/*
 * Cloudflare D1 over the REST API (2026-10-15).
 *
 * WHY THIS EXISTS. The Worker reaches D1 through the `env.DB` BINDING, which
 * only exists inside Workers — so the migration (create the database, apply the
 * schema, copy ~117k rows out of Turso) and the operators' scripts (backfill)
 * have to reach the SAME database from outside, with the same Cloudflare API
 * token the deploy already uses (`CLOUDFLARE_API_TOKEN` with D1:Edit).
 * https://api.cloudflare.com/client/v4, `Authorization: Bearer <token>`.
 *
 * THE IMPORTANT PART: `createRestBinding` answers the SAME shape as the Workers
 * binding (`prepare().bind().all()/run()` and `batch()`), so the migration runs
 * the schema through src/d1.ts's `createD1Transport` — one adapter, one set of
 * rules (the `{results, meta.changes}` translation and the 100-bound-parameter
 * ceiling), and the SQL the migration applies is byte-for-byte the SQL
 * production applies. A second, REST-shaped copy of that knowledge is exactly
 * the thing that would drift from src/db.ts and silently split the schema.
 *
 * DOCUMENTED LIMITS THIS FILE RESPECTS (developers.cloudflare.com/d1/platform/limits):
 *   - 100 bound parameters per query → the CALLER chunks rows (see
 *     chunkForParamLimit in src/d1.ts, the same helper src/db.ts uses);
 *   - 100 KB per SQL statement → ours are ~1 KB (a chunk of rows), so it never
 *     binds here, but a statement built by a future caller is checked;
 *   - 30 seconds per API call → a request carries a bounded number of
 *     statements, and each request that times out is retried;
 *   - 1,200 API requests / 5 minutes per token → ~340 requests for the whole
 *     copy at 50 statements per request, sequential, nowhere near the ceiling;
 *     this is also why statements are batched at all instead of one per row.
 * Nothing documents a maximum statement count or body size for one request, so
 * both are held deliberately low here (50 statements / 1 MB) rather than
 * discovered in production.
 *
 * The response `result` is an ARRAY with one entry per statement
 * (`{results, success, meta}`), which is what makes the batch shape work:
 * per-statement success is checked, not just the outer one, because a batch
 * that returns HTTP 200 while one statement failed would otherwise look like a
 * completed copy.
 */

/** Cloudflare's API expects the database UUID in the path, never its name. */
const API_BASE = "https://api.cloudflare.com/client/v4";

/** Statements per `/query` request. Undocumented limit → kept deliberately low. */
const STATEMENTS_PER_REQUEST = 50;

/** Bytes of SQL + parameters per request. Undocumented limit → kept low. */
const MAX_REQUEST_BYTES = 1_000_000;

/** D1's documented per-statement SQL length cap. */
const MAX_STATEMENT_BYTES = 100_000;

/** HTTP statuses worth retrying: rate limits and Cloudflare's own hiccups. */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

class CloudflareApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors ?? [];
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `{sql, params}` normalized from either a statement object or bare SQL. */
function normalizeStatement(stmt) {
  if (typeof stmt === "string") return { sql: stmt, params: [] };
  return { sql: String(stmt.sql), params: [...(stmt.params ?? stmt.args ?? [])] };
}

/** How many bytes of the request one statement will cost (SQL + parameters). */
function statementBytes(stmt) {
  return (
    Buffer.byteLength(stmt.sql) +
    (stmt.params.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(stmt.params)))
  );
}

/**
 * Splits statements into requests: at most `perRequest` statements and
 * `maxBytes` each. A single statement that is too big is a hard error rather
 * than a silent oversize request — the fix is a smaller chunk upstream (see
 * chunkForParamLimit), never a retry.
 */
function planRequests(statements, perRequest = STATEMENTS_PER_REQUEST, maxBytes = MAX_REQUEST_BYTES) {
  const requests = [];
  let current = [];
  let bytes = 0;
  for (const stmt of statements) {
    const size = statementBytes(stmt);
    if (size > MAX_STATEMENT_BYTES) {
      throw new Error(
        `statement is ${size} bytes, over D1's ${MAX_STATEMENT_BYTES}-byte limit: ${stmt.sql.slice(0, 200)}…`,
      );
    }
    if (current.length > 0 && (current.length >= perRequest || bytes + size > maxBytes)) {
      requests.push(current);
      current = [];
      bytes = 0;
    }
    current.push(stmt);
    bytes += size;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/**
 * The Cloudflare API, for the D1 endpoints this repo needs. Every call retries
 * rate limits and 5xx (a long copy WILL meet one), honors `Retry-After`, and
 * throws with the API's own error text instead of a bare status, because CI
 * logs are the only place a failure here can be read.
 */
function createD1Rest({
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  maxAttempts = 5,
}) {
  if (!accountId) throw new Error("missing CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken) throw new Error("missing CLOUDFLARE_API_TOKEN");
  if (typeof fetchImpl !== "function") throw new Error("missing fetch implementation");

  async function call(method, path, body, attempt = 1) {
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
        return call(method, path, body, attempt + 1);
      }
      throw new Error(`${method} ${path} failed after ${attempt} attempts: ${err.message}`);
    }

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      await sleep(waitMs);
      return call(method, path, body, attempt + 1);
    }

    if (!res.ok || payload?.success === false) {
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const detail = errors.map((e) => `${e.code ?? "?"} ${e.message ?? ""}`).join("; ");
      throw new CloudflareApiError(
        `${method} ${path} → HTTP ${res.status}${detail ? ` (${detail})` : ""}${payload ? "" : `: ${text.slice(0, 300)}`}`,
        res.status,
        errors,
      );
    }
    return payload;
  }

  /** Every D1 database in the account (the API pages at 10-10,000 per page). */
  async function listDatabases() {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const payload = await call("GET", `/accounts/${accountId}/d1/database?page=${page}&per_page=100`);
      const result = payload?.result ?? [];
      out.push(...result);
      const totalPages = Number(payload?.result_info?.total_pages ?? 1);
      if (page >= totalPages) break;
    }
    return out.map((db) => ({ uuid: db.uuid, name: db.name, createdAt: db.created_at ?? null }));
  }

  async function createDatabase(name) {
    const payload = await call("POST", `/accounts/${accountId}/d1/database`, { name });
    const created = payload?.result;
    if (!created?.uuid) {
      throw new Error(`create database ${name} answered no uuid: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return { uuid: created.uuid, name: created.name ?? name, createdAt: created.created_at ?? null };
  }

  /**
   * The database named `name`, created if the account does not have it yet.
   * Idempotent — this is the CI path that runs on every deploy, and a second
   * `create` for an existing name is an API error, not a no-op.
   */
  async function ensureDatabase(name) {
    const existing = (await listDatabases()).find((db) => db.name === name);
    if (existing) return { ...existing, created: false };
    try {
      return { ...(await createDatabase(name)), created: true };
    } catch (err) {
      // A concurrent run may have created it between the list and the create.
      const raced = (await listDatabases()).find((db) => db.name === name);
      if (raced) return { ...raced, created: false };
      throw err;
    }
  }

  /**
   * ONE statement. Answers the D1-shaped result (`{results, success, meta}`),
   * i.e. what the binding would answer — see normalizeD1Result in src/d1.ts.
   */
  async function query(databaseId, stmt) {
    const statement = normalizeStatement(stmt);
    const payload = await call("POST", `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      sql: statement.sql,
      params: statement.params,
    });
    return firstResult(payload, statement.sql);
  }

  /**
   * MANY statements, in order, in as many requests as the limits require. The
   * answer is one entry per statement — the shape `batch()` has everywhere else
   * in this repo.
   */
  async function batch(databaseId, statements, { onProgress } = {}) {
    const requests = planRequests(statements.map(normalizeStatement));
    const out = [];
    for (let i = 0; i < requests.length; i++) {
      const group = requests[i];
      const payload = await call("POST", `/accounts/${accountId}/d1/database/${databaseId}/query`, {
        batch: group.map((s) => ({ sql: s.sql, params: s.params })),
      });
      const results = Array.isArray(payload?.result) ? payload.result : [payload?.result];
      if (results.length !== group.length) {
        throw new Error(
          `asked for ${group.length} statements, D1 answered ${results.length} results`,
        );
      }
      for (let j = 0; j < results.length; j++) {
        if (results[j]?.success === false) {
          throw new Error(
            `D1 rejected a statement: ${group[j].sql.slice(0, 200)}` +
              `\n      ${JSON.stringify(results[j]?.results ?? results[j]).slice(0, 300)}`,
          );
        }
      }
      out.push(...results);
      onProgress?.(i + 1, requests.length, group.length);
    }
    return out;
  }

  return {
    listDatabases,
    createDatabase,
    ensureDatabase,
    query,
    batch,
    /** Raw call, for the one-off probes CI logs (account checks). */
    call,
  };
}

/** One statement's result, tolerating a non-array `result`. */
function firstResult(payload, sql) {
  const result = payload?.result;
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== "object") {
    throw new Error(`D1 answered no result for: ${sql.slice(0, 200)}`);
  }
  if (first.success === false) {
    throw new Error(`D1 rejected a statement: ${sql.slice(0, 200)}`);
  }
  return first;
}

/**
 * The Workers D1 binding, answered by REST — the seam that lets the migration
 * drive src/d1.ts's own transport (and so apply exactly the SQL production
 * applies) from a GitHub runner.
 */
function createRestBinding(api, databaseId) {
  const prepared = (sql, params) => ({
    // `_sql`/`_params` are how `batch` below reads a handle back (the binding's
    // own contract is bind/all/run — see D1PreparedStatementLike in src/d1.ts).
    _sql: sql,
    _params: params,
    bind: (...more) => prepared(sql, more),
    all: () => api.query(databaseId, { sql, params }),
    run: () => api.query(databaseId, { sql, params }),
  });
  return {
    prepare(sql) {
      return prepared(String(sql), []);
    },
    async batch(stmts) {
      // Each statement answers `{results, success, meta}`: the shape
      // createD1Transport normalizes, and `_sql`/`_params` are read off the
      // handle the binding handed out (see prepared above).
      return api.batch(
        databaseId,
        stmts.map((s) => ({ sql: s._sql ?? String(s), params: s._params ?? [] })),
      );
    },
    /** Not part of the binding contract: used by the copy's own bookkeeping. */
    async raw(sql, params = []) {
      return api.query(databaseId, { sql, params });
    },
    async rawBatch(statements, opts) {
      return api.batch(databaseId, statements, opts);
    },
  };
}

module.exports = {
  API_BASE,
  CloudflareApiError,
  MAX_REQUEST_BYTES,
  MAX_STATEMENT_BYTES,
  STATEMENTS_PER_REQUEST,
  createD1Rest,
  createRestBinding,
  planRequests,
  normalizeStatement,
  statementBytes,
};
