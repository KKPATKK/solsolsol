import type { TokenProfile } from "./dexscreener";
import {
  createD1Transport,
  type D1DatabaseLike,
  type D1Transport,
} from "./d1";

/**
 * PUMPPORTAL LAUNCH FEED (2026-11-06) — the replacement for pump.fun's
 * frontend API, which answers 403 (Cloudflare managed challenge) on both hosts
 * from this Worker's egress and cannot be fixed from here (the refusal is
 * below the request: headers, Origin/Referer, a proxy and a Durable Object
 * relay were all tried).
 *
 * WHAT CHANGED FROM THE FIRST CUT (2026-11-05). The stream has no HTTP
 * recent-tokens endpoint and no history, so the first cut held it open in a
 * Durable Object between ticks. That object was resident 24/7: 30 days × 24h ×
 * 0.128GB = 331,776 GB-s/month, ~83% of the Paid plan's 400,000 GB-s duration
 * allowance. This file now does the same job with NO resident object:
 *
 *   1. The 5-minute MAINTENANCE CRON opens the stream, collects for 4m45s and
 *      writes every create to D1 (`pump_portal_tokens`). The cron invocation
 *      has a 15-minute wall clock, and it is the only long-lived invocation
 *      this feed needs.
 *   2. The scan reads the newest 15 minutes from D1 in ONE SELECT per tick.
 *      No socket, no Durable Object, no duration charge.
 *   3. The 15-second gap between collection windows is the entire coverage
 *      cost: ~95% of the stream's time, against 100% for the resident object.
 *      That is the trade this file makes explicit.
 *
 * WHY A CRON AND NOT A QUEUE. The maintenance trigger already exists and is
 * observed arriving every 5 minutes (`/health.scheduledArrivalAt`); a queue
 * would add a producer, a consumer and a second deploy surface for the same
 * 15-minute wall clock. The collector is idempotent (D1's primary key does the
 * dedupe) and a duplicate delivery is stopped by the lease below, so the cron's
 * at-least-once delivery is safe.
 *
 * WHERE THE TOKENS LIVE. `pump_portal_tokens` is a small, bounded buffer:
 * ~11 creates/minute live, a 1-hour retention prune at the end of every
 * collection, and a 15-minute freshness window on the read side. At those
 * numbers the table holds ~660 rows and costs ~0.95M rows written a month —
 * ~1.9% of the Paid plan's 50M rows-written allowance.
 *
 * WHY THE DDL LIVES HERE, NOT IN Db.init(). The collector runs in the cron
 * isolate, where constructing the full application (Telegram, scanner, etc.)
 * just to open a socket would be wasteful and, worse, could collide with the
 * relayed maintenance invocation. This module owns its two small tables (plus
 * one index) and bootstraps them with `CREATE TABLE IF NOT EXISTS`; the main Db
 * schema does not need to know about the buffer. The DDL is idempotent and
 * runs once per store instance.
 */

/**
 * The stream endpoint. `api-key` is optional for `subscribeNewToken`.
 *
 * HTTPS, NOT `wss:` — Workers' `fetch()` rejects the `wss:` scheme outright
 * (live 2026-11-05: "Fetch API cannot load: wss://pumpportal.fun/api/data",
 * zero connects), and the upgrade is carried by the `Upgrade: websocket`
 * header instead. Same host, same path, same endpoint; only the scheme the
 * runtime accepts differs.
 */
export const PUMPPORTAL_WS_URL = "https://pumpportal.fun/api/data";
/** The subscription frame, sent once the socket is accepted. */
export const PUMPPORTAL_SUBSCRIBE = JSON.stringify({
  method: "subscribeNewToken",
});
/** Descriptive identity, same reason as the HTTP client's USER_AGENT. */
const USER_AGENT =
  "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";
/** Ceiling for one connect handshake (the collector must not wait forever). */
const CONNECT_TIMEOUT_MS = 5_000;
/** Reconnect backoff after a failure: 5s, doubling to 5 min. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;
/** Newest creates returned by one read (and the reader's hard cap). */
export const PUMPPORTAL_MAX_TOKENS = 500;
/** Rows older than this are invisible to the scan (a stale collector = empty). */
export const PUMPPORTAL_FRESH_MS = 15 * 60_000;
/** Rows older than this are pruned at the end of a collection window. */
export const PUMPPORTAL_RETAIN_MS = 60 * 60_000;
/**
 * How long one maintenance cron holds the socket. 4m45s of a 5-minute
 * cadence leaves the next delivery a 15s gap for the final flush and close.
 */
export const PUMPPORTAL_COLLECT_MS = 285_000;
/**
 * The lease is slightly longer than the window, so a slow final flush cannot
 * make the next cron start a second socket; if this invocation dies, the lease
 * expires before the next delivery 15s later and that delivery takes over.
 */
export const PUMPPORTAL_LEASE_MS = 292_000;
/** Durability/request-count balance: ~2 rows a flush at the live 11/min rate. */
export const PUMPPORTAL_FLUSH_MS = 10_000;
/** A failed flush keeps its rows for the next attempt; this bounds memory. */
const PUMPPORTAL_MAX_PENDING = 2_000;
/** D1 call bound. The collector has 4m45s; a single stuck call must not eat it. */
const PUMPPORTAL_D1_BOUND_MS = 4_000;
/** The tick's read is on the scan path, so it gets a tighter leash. */
const PUMPPORTAL_READ_BOUND_MS = 2_000;
/** Statements per D1 batch (D1 caps a batch; a retry backlog can get large). */
const PUMPPORTAL_INSERT_CHUNK = 50;

/** The three statements that make up the buffer. Idempotent by construction. */
const PUMPPORTAL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS pump_portal_tokens (
    token TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_pump_portal_tokens_at
    ON pump_portal_tokens(at);`,
  `CREATE TABLE IF NOT EXISTS pump_portal_collector (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT NOT NULL,
    until INTEGER NOT NULL,
    last_start_at INTEGER,
    last_end_at INTEGER,
    last_ms INTEGER,
    connects INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    ignored INTEGER NOT NULL DEFAULT 0,
    written INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );`,
];

/** One create, as the reader hands it to the scanner. */
export interface PumpPortalToken {
  tokenAddress: string;
  name?: string;
  symbol?: string;
  /** Receipt time, ms. The stream carries no created timestamp. */
  at: number;
}

/**
 * Parse one WebSocket frame into a create event (pure — unit-testable).
 *
 * The pump.fun create event carries `{ mint, name, symbol, txType: "create",
 * ... }`. Frames the collector does not care about (subscription acks, trade
 * events it never subscribed to, malformed JSON) return null. `txType` is
 * checked only when present: LetsBonk creates on the same stream have been
 * observed without it, and the only subscription this collector holds is
 * `subscribeNewToken`, so a mint is sufficient evidence.
 */
export function parsePumpPortalCreate(raw: unknown): PumpPortalToken | null {
  let body: unknown = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const msg = body as Record<string, unknown>;
  if (typeof msg.txType === "string" && msg.txType !== "create") return null;
  const mint = typeof msg.mint === "string" ? msg.mint.trim() : "";
  if (mint === "") return null;
  return {
    tokenAddress: mint,
    name: typeof msg.name === "string" ? msg.name : undefined,
    symbol: typeof msg.symbol === "string" ? msg.symbol : undefined,
    at: Date.now(),
  };
}

/** The minimal outbound-socket surface this module uses (Workers' WebSocket). */
interface SocketLike {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}

/** The scanner's view of the buffer. Null = could not be read this tick. */
export interface PumpPortalReader {
  /**
   * Newest `limit` creates from the freshness window, newest first. An EMPTY
   * ARRAY is a real answer (a quiet feed); null means the read failed and the
   * scanner should fall back to the HTTP feed, exactly as before.
   */
  fetchRecent(limit: number): Promise<TokenProfile[] | null>;
}

/** What the collector needs from its destination (PumpPortalStore below). */
export interface PumpPortalSink {
  insertPumpPortalTokens(tokens: readonly PumpPortalToken[]): Promise<number>;
  prunePumpPortalTokens(before: number): Promise<number>;
}

/** Per-window outcome, persisted in the collector row for /debug/pumpportal. */
export interface PumpPortalCollectResult {
  ok: boolean;
  connects: number;
  messages: number;
  ignored: number;
  written: number;
  pruned: number;
  failures: number;
  lastError: string;
  ms: number;
}

export interface PumpPortalDebug {
  tokens: {
    rows: number;
    newestAt: number | null;
    oldestAt: number | null;
  };
  collector: {
    owner: string;
    until: number;
    lastStartAt: number | null;
    lastEndAt: number | null;
    lastMs: number | null;
    connects: number;
    messages: number;
    ignored: number;
    written: number;
    failures: number;
    lastError: string | null;
  } | null;
  freshMs: number;
  windowMs: number;
  leaseMs: number;
  now: number;
}

/** Clamp a reader limit to the buffer's ceiling. */
function clampLimit(limit: number): number {
  return Math.min(
    Math.max(Math.trunc(Number.isFinite(limit) ? limit : 50), 1),
    PUMPPORTAL_MAX_TOKENS,
  );
}

/** Race a D1 promise against a bound, without leaving its rejection unhandled. */
function withBound<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: Record<string, unknown>, key: string): number | null {
  const raw = row[key];
  // `Number(null)` is 0: a missing MAX()/MIN() or a NULL column must stay
  // NULL here, or the debug route reports an epoch reading for an empty table.
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The D1 side of the feed: the collector's sink, the scanner's reader and the
 * debug route's view. One instance per isolate is enough; the schema cache
 * makes the first call pay the DDL and every later call a single statement.
 *
 * It deliberately does NOT go through `Db.init()`: the cron isolate has no
 * scanner, no Telegram and no 3.5-second front budget, and the three tables
 * here are self-contained. `createD1Transport` still counts each call as a
 * subrequest (see src/d1.ts), so the invocation's budget stays honest.
 */
export class PumpPortalStore implements PumpPortalReader, PumpPortalSink {
  private readonly transport: D1Transport;
  private schema: Promise<void> | null = null;

  constructor(private readonly d1: D1DatabaseLike) {
    this.transport = createD1Transport(d1);
  }

  private ensureSchema(): Promise<void> {
    if (this.schema !== null) return this.schema;
    this.schema = withBound(
      this.transport.batch(PUMPPORTAL_DDL),
      PUMPPORTAL_D1_BOUND_MS,
      "pump portal schema",
    )
      .then(() => undefined)
      .catch((err) => {
        // A failed bootstrap must be retried by the next caller, not cached as
        // a permanently broken store.
        this.schema = null;
        throw err;
      });
    return this.schema;
  }

  async insertPumpPortalTokens(
    tokens: readonly PumpPortalToken[],
  ): Promise<number> {
    if (tokens.length === 0) return 0;
    await this.ensureSchema();
    const statements = tokens.map((token) => ({
      sql: `INSERT OR IGNORE INTO pump_portal_tokens (token, name, symbol, at)
        VALUES (?, ?, ?, ?)`,
      args: [
        token.tokenAddress,
        token.name ?? null,
        token.symbol ?? null,
        token.at,
      ],
    }));
    let written = 0;
    // One batch in the normal case (~2 rows a flush). The chunking only
    // matters after a failed flush has accumulated a backlog; D1's batch
    // ceiling is a hard reject, not a slow path.
    for (let i = 0; i < statements.length; i += PUMPPORTAL_INSERT_CHUNK) {
      const results = await withBound(
        this.transport.batch(
          statements.slice(i, i + PUMPPORTAL_INSERT_CHUNK),
        ),
        PUMPPORTAL_D1_BOUND_MS,
        "pump portal insert",
      );
      for (const result of results) {
        written += Number(result.rowsAffected ?? 0);
      }
    }
    return written;
  }

  async prunePumpPortalTokens(before: number): Promise<number> {
    await this.ensureSchema();
    const result = await withBound(
      this.transport.execute({
        sql: "DELETE FROM pump_portal_tokens WHERE at < ?",
        args: [before],
      }),
      PUMPPORTAL_D1_BOUND_MS,
      "pump portal prune",
    );
    return Number(result.rowsAffected ?? 0);
  }

  async fetchRecent(limit: number): Promise<TokenProfile[] | null> {
    try {
      await this.ensureSchema();
      const result = await withBound(
        this.transport.execute({
          sql: `SELECT token, name, symbol, at
            FROM pump_portal_tokens
            WHERE at >= ?
            ORDER BY at DESC
            LIMIT ?`,
          args: [Date.now() - PUMPPORTAL_FRESH_MS, clampLimit(limit)],
        }),
        PUMPPORTAL_READ_BOUND_MS,
        "pump portal read",
      );
      const out: TokenProfile[] = [];
      for (const row of result.rows) {
        const record = row as unknown as Record<string, unknown>;
        const tokenAddress = rowString(record, "token");
        const at = rowNumber(record, "at");
        if (tokenAddress === null || at === null) continue;
        out.push({
          tokenAddress,
          name: rowString(record, "name") ?? undefined,
          symbol: rowString(record, "symbol") ?? undefined,
          openTimestamp: at,
        });
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Claim the single collector slot. Atomic in SQLite: the INSERT creates the
   * row on a fresh database, and the conflict arm updates it only when the
   * previous lease has expired. `rowsAffected` is therefore the answer to
   * "did I get it?" — 0 means a live collector is already running.
   */
  async claimPumpPortalCollector(
    owner: string,
    now: number,
    until: number,
  ): Promise<boolean> {
    await this.ensureSchema();
    const result = await withBound(
      this.transport.execute({
        sql: `INSERT INTO pump_portal_collector
            (id, owner, until, last_start_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            owner = excluded.owner,
            until = excluded.until,
            last_start_at = excluded.last_start_at
          WHERE pump_portal_collector.until < ?`,
        args: [owner, until, now, now],
      }),
      PUMPPORTAL_D1_BOUND_MS,
      "pump portal claim",
    );
    return Number(result.rowsAffected ?? 0) > 0;
  }

  /** Release the slot and persist the window's outcome for the debug route. */
  async finishPumpPortalCollector(
    owner: string,
    result: PumpPortalCollectResult,
    now: number,
  ): Promise<void> {
    await this.ensureSchema();
    await withBound(
      this.transport.execute({
        sql: `UPDATE pump_portal_collector SET
            until = 0,
            last_end_at = ?,
            last_ms = ?,
            connects = ?,
            messages = ?,
            ignored = ?,
            written = ?,
            failures = ?,
            last_error = ?
          WHERE id = 1 AND owner = ?`,
        args: [
          now,
          result.ms,
          result.connects,
          result.messages,
          result.ignored,
          result.written,
          result.failures,
          result.lastError,
          owner,
        ],
      }),
      PUMPPORTAL_D1_BOUND_MS,
      "pump portal finish",
    );
  }

  async pumpPortalDebug(): Promise<PumpPortalDebug> {
    await this.ensureSchema();
    const results = await withBound(
      this.transport.batch([
        {
          sql: `SELECT COUNT(*) AS rows, MAX(at) AS newestAt, MIN(at) AS oldestAt
            FROM pump_portal_tokens`,
        },
        { sql: "SELECT * FROM pump_portal_collector WHERE id = 1" },
      ]),
      PUMPPORTAL_D1_BOUND_MS,
      "pump portal debug",
    );
    const tokensRow =
      (results[0]?.rows[0] as unknown as Record<string, unknown>) ?? {};
    const collectorRow =
      (results[1]?.rows[0] as unknown as Record<string, unknown>) ?? null;
    return {
      tokens: {
        rows: Number(tokensRow.rows ?? 0),
        newestAt: rowNumber(tokensRow, "newestAt"),
        oldestAt: rowNumber(tokensRow, "oldestAt"),
      },
      collector:
        collectorRow === null
          ? null
          : {
              owner: String(collectorRow.owner ?? ""),
              until: Number(collectorRow.until ?? 0),
              lastStartAt: rowNumber(collectorRow, "last_start_at"),
              lastEndAt: rowNumber(collectorRow, "last_end_at"),
              lastMs: rowNumber(collectorRow, "last_ms"),
              connects: Number(collectorRow.connects ?? 0),
              messages: Number(collectorRow.messages ?? 0),
              ignored: Number(collectorRow.ignored ?? 0),
              written: Number(collectorRow.written ?? 0),
              failures: Number(collectorRow.failures ?? 0),
              lastError: rowString(collectorRow, "last_error"),
            },
      freshMs: PUMPPORTAL_FRESH_MS,
      windowMs: PUMPPORTAL_COLLECT_MS,
      leaseMs: PUMPPORTAL_LEASE_MS,
      now: Date.now(),
    };
  }
}

/** Runtime switch, same convention as DEX_EGRESS_FALLBACK. */
export function pumpPortalFeedEnabled(env: Record<string, unknown>): boolean {
  const raw = env.PUMPPORTAL_FEED;
  return raw !== "0" && raw !== "false";
}

export interface PumpPortalCollectOptions {
  sink: PumpPortalSink;
  /** Absolute ms at which the window must close and the socket be released. */
  deadlineMs: number;
  flushMs?: number;
  now?: () => number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Hold the stream for one bounded window and flush creates into `sink`.
 *
 * The loop is deliberately small: connect, listen, flush on a timer, close at
 * the deadline. A close or error reconnects with the same 5s-to-5min backoff
 * the Durable Object used, and `seen` dedupes a mint repeated around a
 * reconnect. A watchdog closes the socket at the deadline even if a slow D1
 * call has the loop parked, which is what keeps two collection windows from
 * overlapping at the portal.
 *
 * Never throws: a failed handshake is a counter, not a dead tick. The caller
 * persists the returned reading.
 */
export async function collectPumpPortal(
  options: PumpPortalCollectOptions,
): Promise<PumpPortalCollectResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = Math.max(startedAt, options.deadlineMs);
  const flushMs = Math.max(250, options.flushMs ?? PUMPPORTAL_FLUSH_MS);
  const fetchImpl =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  const pending: PumpPortalToken[] = [];
  const seen = new Set<string>();
  let connects = 0;
  let messages = 0;
  let ignored = 0;
  let written = 0;
  let pruned = 0;
  let failures = 0;
  let lastError = "";

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      written += await options.sink.insertPumpPortalTokens(batch);
    } catch (err) {
      // Keep the rows for the next flush; the window's own final flush gets
      // one more attempt before the invocation returns.
      pending.unshift(...batch);
      if (pending.length > PUMPPORTAL_MAX_PENDING) {
        pending.splice(0, pending.length - PUMPPORTAL_MAX_PENDING);
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
  };

  const onMessage = (data: unknown): void => {
    const token = parsePumpPortalCreate(data);
    if (token === null) {
      ignored += 1;
      return;
    }
    messages += 1;
    if (seen.has(token.tokenAddress)) return;
    seen.add(token.tokenAddress);
    pending.push(token);
  };

  let backoff = RECONNECT_BASE_MS;
  while (now() < deadline) {
    const remaining = deadline - now();
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(CONNECT_TIMEOUT_MS, remaining)),
    );
    try {
      response = await fetchImpl(PUMPPORTAL_WS_URL, {
        headers: { Upgrade: "websocket", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
    } catch (err) {
      failures += 1;
      lastError = err instanceof Error ? err.message : "connect failed";
      await sleep(Math.max(0, Math.min(backoff, deadline - now())));
      backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
      continue;
    } finally {
      clearTimeout(timer);
    }
    const socket =
      (response as unknown as { webSocket?: SocketLike }).webSocket ?? null;
    if (response.status !== 101 || socket === null) {
      failures += 1;
      lastError = `HTTP ${response.status}`;
      void response.body?.cancel().catch(() => undefined);
      await sleep(Math.max(0, Math.min(backoff, deadline - now())));
      backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
      continue;
    }

    let closed = false;
    let resolveClosed: (() => void) | null = null;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const markClosed = (): void => {
      if (closed) return;
      closed = true;
      resolveClosed?.();
    };

    try {
      socket.accept();
      socket.addEventListener("message", (event) => onMessage(event.data));
      socket.addEventListener("close", markClosed);
      socket.addEventListener("error", markClosed);
      socket.send(PUMPPORTAL_SUBSCRIBE);
    } catch (err) {
      failures += 1;
      lastError = err instanceof Error ? err.message : "socket setup failed";
      try {
        socket.close();
      } catch {
        // already closed
      }
      await sleep(Math.max(0, Math.min(backoff, deadline - now())));
      backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
      continue;
    }

    connects += 1;
    backoff = RECONNECT_BASE_MS;
    // The deadline close is owned by this timer, not by the loop: a flush
    // that takes seconds must not keep the socket past the next window.
    const watchdog = setTimeout(() => {
      try {
        socket.close(1000, "window");
      } catch {
        // already closed
      }
      markClosed();
    }, Math.max(0, deadline - now()));

    while (!closed && now() < deadline) {
      await Promise.race([
        closedPromise,
        sleep(Math.max(1, Math.min(flushMs, deadline - now()))),
      ]);
      await flush();
    }
    clearTimeout(watchdog);
    try {
      socket.close(1000, "window");
    } catch {
      // already closed
    }
    if (closed) {
      // A server-side close is not the deadline: reconnect, but never faster
      // than the same 5s the object used (PumpPortal asks for one connection
      // at a time).
      await sleep(Math.max(0, Math.min(RECONNECT_BASE_MS, deadline - now())));
    }
  }

  await flush();
  try {
    pruned = await options.sink.prunePumpPortalTokens(
      now() - PUMPPORTAL_RETAIN_MS,
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: connects > 0,
    connects,
    messages,
    ignored,
    written,
    pruned,
    failures,
    lastError,
    ms: now() - startedAt,
  };
}
