// Use the Web-standard (HTTP/fetch-based) build explicitly: on Cloudflare
// Workers the main entry would resolve to the Node/WebSocket client (tsconfig
// is CommonJS, so wrangler picks the "require" condition), which cannot
// connect there. `@libsql/client/web` ships CJS + ESM variants, so the same
// import works in Node and on Workers. https:// URLs additionally force the
// pure-HTTP transport everywhere.
import { createClient, type Client } from "@libsql/client/web";

/**
 * Hard timeout for every Turso HTTP request. The database has been
 * intermittently degraded (5s+ round trips, occasional 522s and hangs); a
 * hung request must fail fast and be retried next tick instead of wedging
 * the scan (DB calls have no timeout by default). Healthy round trips are
 * ~100-300ms, so 15s only ever cuts off genuine hangs.
 */
const DB_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Min gap between token_stats prunes. Discovery inflow is ~140 coins/min
 * and only rows older than the 30h re-eval window are removed, so a 10-min
 * lag has zero functional impact while cutting the prune's rows-read by
 * 10x (it used to run every 60s tick — see pruneOldTokenStats). The
 * timestamp is shared via worker_state so concurrent isolates (cron +
 * HTTP fallback) share one cadence.
 */
const TOKEN_STATS_PRUNE_INTERVAL_MS = 10 * 60_000;

export interface ChatSettings {
  chatId: string;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /** Minimum market cap in USD. */
  minMarketCapUsd: number;
  /** Maximum market cap in USD (coins above are skipped — mid-cap range). */
  maxMarketCapUsd: number;
  /** Minimum token age in minutes. */
  minAgeMinutes: number;
  /** Maximum token age in minutes (coins older than this are skipped). */
  maxAgeMinutes: number;
  /** Minimum 5-minute volume in USD. */
  min5mVolUsd: number;
  /** Minimum 5-minute price change in percent (e.g. 18 = +18%). */
  min5mChgPct: number;
  /**
   * Minimum 1-hour price change in percent for the compound momentum gate
   * (a coin qualifies on 5m ≥ min5mChgPct OR 1h ≥ this — catches coins
   * sampled mid-pullback between spikes).
   */
  min1hChgPct: number;
  enabled: boolean;
}

/**
 * Current filter profile: mid-cap coins ($40K–$300K) aged 5–28 hours with a
 * hot 5m tape. The first-minute-volume, sniper, bundler and top-10 holder
 * filters were removed (bundler/top-10 data is shown on the card for
 * reference only).
 */
export const DEFAULT_SETTINGS: Omit<ChatSettings, "chatId"> = {
  minLiquidityUsd: 0,
  minVolume24hUsd: 0,
  minMarketCapUsd: 40000,
  maxMarketCapUsd: 300000,
  minAgeMinutes: 300, // 5h
  maxAgeMinutes: 1680, // 28h
  min5mVolUsd: 6000,
  min5mChgPct: 30,
  min1hChgPct: 40,
  enabled: false,
};

/**
 * Re-eval pool hot zone (see Db.getReevalPool): coins whose launch is within
 * [window entry − POOL_HOT_BELOW_MS, entry + POOL_HOT_ABOVE_MS] — about to
 * qualify or freshly qualified — are evaluated EVERY scan. This is the
 * push-latency-critical cohort: a coin that crosses the gates right after
 * entering the window should be pushed within a minute, not whenever its
 * rotation slot next comes up. The above-entry side is 1h (was 2h): a coin
 * that fails a gate at entry almost never flips within hours, so the extra
 * hour of band only burned rows-read (the hot band is read+sorted every
 * scan, and it is the pool query's dominant Turso rows-read consumer).
 */
const POOL_HOT_BELOW_MS = 0.5 * 3600_000;
const POOL_HOT_ABOVE_MS = 1 * 3600_000;
/** Max hot-zone coins per scan; the rest of the pool limit goes to rotation. */
const POOL_HOT_MAX = 300;
/**
 * Graduated rotation (2026-08-16 redesign, replaces the uniform-slot sweep):
 * the rotation zone — everything older than the hot zone — is split into TWO
 * tiers with different sweep cadences, because qualification probability
 * decays steeply with age:
 *
 *   NEAR zone: [window entry, entry + POOL_NEAR_WINDOW_MS] of age. Coins that
 *     just entered the window are the most likely to cross the mcap/volume
 *     gates, so their slots are swept frequently (POOL_NEAR_SLOTS × the 5-min
 *     pool cache = 10-min full sweep by default).
 *   FAR zone: the rest of the window (entry+6h → maxAge). Qualification is
 *     rare this deep in, so it is swept slowly (POOL_FAR_SLOTS × 5 min =
 *     30-min full sweep by default) — every coin is still re-checked at
 *     least once per sweep, but the old tail stops consuming most of the
 *     budget.
 *
 * The old uniform rotation (REEVAL_ROTATION_MINUTES → N equal slots over the
 * whole zone) gave every coin the same 30-min re-check cadence regardless of
 * how likely it was to qualify, and in dense bands the per-slot LIMIT
 * (ordered by distance to the slot center) systematically dropped edge coins
 * — starvation was reduced but not eliminated. The tiered version
 * concentrates the budget where qualification actually happens, and the
 * rotation bands order by qualification signal (max_mcap_observed) so the
 * LIMIT always picks the most promising coins.
 */
const POOL_NEAR_WINDOW_MS = 6 * 3600_000;
/** Near-zone slot count (10-min full sweep at the default pool cache). */
const POOL_NEAR_SLOTS = 2;
/** Far-zone slot count (30-min full sweep at the default pool cache). */
const POOL_FAR_SLOTS = 6;
/** Share of the rotation budget given to the near zone (rest → far zone). */
const POOL_NEAR_LIMIT_SHARE = 0.7;
/**
 * Rotation cadence default — must match the caller's pool cache TTL so
 * every cache expiry moves to the next slot instead of re-serving the same
 * slice. The scanner passes its configured TTL (REEVAL_POOL_CACHE_SECONDS,
 * default 180s) as rotationPeriodMs; this constant is the db-side default
 * (300s) used when no period is given (tests, /debug/pool fallback).
 */
const POOL_ROTATION_PERIOD_MS = 300_000;

/** Opening stats captured the first time the scanner ever saw a token. */
export interface TokenStats {
  token: string;
  firstSeenAt: number;
  /** m5 volume at first observation — approximates the opening volume. */
  firstM5Vol: number;
  /** Token age in minutes at first observation. */
  firstSeenAgeMin: number;
  /**
   * Estimated launch time (epoch ms) = firstSeenAt - firstSeenAgeMin*60s.
   * Stored + indexed so the re-eval pool query runs as a narrow range scan
   * instead of evaluating the computed expression across every token_stats
   * row (~400K — the dominant Turso rows-read consumer, alerted 2026-08-16).
   */
  launchMs: number;
  /** Exact first-minute volume from Birdeye (null = not measured yet). */
  birdeye1mVol: number | null;
  /** Bundler/insider supply share in percent from RugCheck (null = unknown). */
  rugcheckBundlerPct: number | null;
  /** Top-10 holder concentration in percent from RugCheck (null = unknown). */
  rugcheckTop10Pct: number | null;
  /**
   * Count of wallets Birdeye tags as smart_trader among the top traders
   * (excluding bundler/dev-tagged wallets), null = unknown.
   */
  birdeyeProTraders: number | null;
  /** Sniper buy share of supply in percent from Birdeye (null = unknown). */
  birdeyeSniperPct: number | null;
  /** Lowest market cap since listing (USD), null = unknown. */
  minMcapObserved: number | null;
  /**
   * Highest market cap ever observed by the scanner (pool pre-filter and
   * rotation-band ordering signal — see Db.getReevalPool). Null for rows
   * written before the v3 migration or never seen with pair data.
   */
  maxMcapObserved?: number | null;
  /** Cached supply-flow detector result (JSON of SupplyFlowResult), null = not analyzed. */
  supplyFlowJson: string | null;
  /** When the cached supply-flow result was produced (epoch ms). */
  supplyFlowAt: number | null;
}

/**
 * Thin wrapper around the Turso (libSQL) client.
 *
 * seen_tokens uses a composite primary key (chat_id, token) so a coin is
 * pushed at most once per chat, while the same coin may still qualify for
 * different chats with different filters.
 */
export class Db {
  private client: Client | null = null;
  private readonly url: string;
  private readonly authToken?: string;
  /** Pre-built client (unit tests: local `file:` libsql, no network). */
  private readonly injectedClient?: Client;

  constructor(url: string, authToken?: string, injectedClient?: Client) {
    this.url = url;
    this.authToken = authToken;
    this.injectedClient = injectedClient;
  }

  /** Creates the libsql client once (lazy; no network until first call). */
  private connect(): Client {
    if (this.client) return this.client;
    if (this.injectedClient) {
      this.client = this.injectedClient;
      return this.client;
    }
    // libsql:// is a WebSocket scheme; https:// drives the HTTP transport,
    // which works reliably on Workers (fetch) and in Node alike.
    const httpUrl = this.url.replace(/^libsql:\/\//, "https://");
    this.client = createClient({
      url: httpUrl,
      authToken: this.authToken,
      // Bound every request (see DB_REQUEST_TIMEOUT_MS): a stalled Turso
      // call aborts instead of hanging the tick indefinitely.
      fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
        }),
    });
    return this.client;
  }

  async init(): Promise<void> {
    const c = this.connect();
    // All idempotent DDL in ONE batched round trip. Previously each statement
    // was its own round trip (~14 of them, each up to DB_REQUEST_TIMEOUT_MS),
    // so a degraded database could push init past the ~30s scheduled-event
    // wall clock and kill the tick before the scanner initialized — cron then
    // LOOKED dead from /health (observed 2026-08-14).
    await c.batch(
      [
        `CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id TEXT PRIMARY KEY,
          min_liquidity_usd REAL NOT NULL DEFAULT 0,
          min_volume_24h_usd REAL NOT NULL DEFAULT 0,
          min_market_cap_usd REAL NOT NULL DEFAULT 40000,
          max_market_cap_usd REAL NOT NULL DEFAULT 300000,
          min_age_minutes REAL NOT NULL DEFAULT 300,
          max_age_minutes REAL NOT NULL DEFAULT 1680,
          min_5m_vol_usd REAL NOT NULL DEFAULT 6000,
          min_5m_chg_pct REAL NOT NULL DEFAULT 30,
          min_1h_chg_pct REAL NOT NULL DEFAULT 40,
          enabled INTEGER NOT NULL DEFAULT 0
        );`,
        `CREATE TABLE IF NOT EXISTS worker_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );`,
        `CREATE TABLE IF NOT EXISTS seen_tokens (
          chat_id TEXT NOT NULL,
          token TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, token)
        );`,
        `CREATE TABLE IF NOT EXISTS token_stats (
          token TEXT PRIMARY KEY,
          first_seen_at INTEGER NOT NULL,
          first_m5_vol REAL NOT NULL,
          first_seen_age_min REAL NOT NULL,
          launch_ms INTEGER,
          birdeye_1m_vol REAL,
          rugcheck_bundler_pct REAL,
          rugcheck_top10_pct REAL,
          birdeye_pro_traders INTEGER,
          birdeye_sniper_pct REAL,
          min_mcap_observed REAL,
          max_mcap_observed REAL,
          supply_flow TEXT,
          supply_flow_at INTEGER
        );`,
        // Permanent per-tick scan history, so interruptions are visible long
        // after the fact (the scan_heartbeat row only keeps the latest value).
        `CREATE TABLE IF NOT EXISTS scan_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          ms INTEGER NOT NULL,
          err TEXT,
          profiles INTEGER,
          pool INTEGER,
          candidates INTEGER,
          pushed INTEGER
        );`,
        `CREATE INDEX IF NOT EXISTS idx_scan_history_at ON scan_history(at);`,
        // The re-eval pool query filters token_stats by first_seen_at and
        // anti-joins seen_tokens every tick; these indexes keep it fast as
        // both tables grow (token_stats is pruned each tick).
        `CREATE INDEX IF NOT EXISTS idx_token_stats_first_seen ON token_stats(first_seen_at);`,
        `CREATE INDEX IF NOT EXISTS idx_seen_tokens_token ON seen_tokens(token);`,
        // Trade log: one row per bought token (UNIQUE(token) ⇒ a coin is
        // bought at most once, enforced at the DB layer regardless of mode).
        `CREATE TABLE IF NOT EXISTS trade_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL UNIQUE,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          tx_hash TEXT,
          amount_sol REAL NOT NULL,
          slippage_pct REAL NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        );`,
        `CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log(created_at);`,
        // Sell log: every exit attempt (half/all). NOT unique on token — you
        // can legitimately sell half now and the rest later. Mirrors trade_log.
        `CREATE TABLE IF NOT EXISTS sell_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          tx_hash TEXT,
          amount_token REAL,
          error TEXT,
          created_at INTEGER NOT NULL
        );`,
        `CREATE INDEX IF NOT EXISTS idx_sell_log_created ON sell_log(created_at);`,
        // Pushed-coin top-holder snapshots (wallet analysis, feature C): one
        // row per (pushed token, holder owner) plus the creator row, written
        // at push time. Cross-coin clustering = "same wallets repeatedly
        // appearing across pushed coins" (coordinated-activity detection).
        // Rows are tiny (≤ 9 per push) and pruned after the clustering
        // window, so growth is bounded.
        `CREATE TABLE IF NOT EXISTS pushed_holders (
          token TEXT NOT NULL,
          owner TEXT NOT NULL,
          rank INTEGER NOT NULL,
          ui_amount REAL NOT NULL DEFAULT 0,
          is_creator INTEGER NOT NULL DEFAULT 0,
          crime_hit INTEGER NOT NULL DEFAULT 0,
          pushed_at INTEGER NOT NULL,
          PRIMARY KEY (token, owner)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_owner ON pushed_holders(owner, pushed_at);`,
        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_at ON pushed_holders(pushed_at);`,
      ],
      "write",
    );

    // Flag reads in ONE batched read round trip.
    const flags = await c.batch(
      [
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v2_applied'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v1_done'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v2_done'",
          args: [],
        },
      ],
      "read",
    );
    const settingsV2 =
      flags[0].rows.length > 0 ? String(flags[0].rows[0].value) : null;
    const schemaAlterDone =
      flags[1].rows.length > 0 ? String(flags[1].rows[0].value) : null;
    const schemaAlterV2 =
      flags[2].rows.length > 0 ? String(flags[2].rows[0].value) : null;

    // One-time migration: existing chats keep their old filter values unless
    // reset. The operator specified a new filter profile, so apply it to all
    // chats once; future /filter customizations are preserved after this.
    const d = DEFAULT_SETTINGS;
    if (!settingsV2) {
      await this.get().execute({
        sql: `UPDATE chat_settings SET
          min_market_cap_usd = ?,
          max_market_cap_usd = ?,
          min_age_minutes = ?,
          max_age_minutes = ?,
          min_5m_vol_usd = ?,
          min_5m_chg_pct = ?`,
        args: [
          d.minMarketCapUsd,
          d.maxMarketCapUsd,
          d.minAgeMinutes,
          d.maxAgeMinutes,
          d.min5mVolUsd,
          d.min5mChgPct,
        ],
      });
      await this.setWorkerState("settings_v2_applied", "1");
      console.log("[db] applied new filter defaults to existing chats (settings_v2)");
    }
    // One-time legacy column backfills (databases created before these
    // columns existed). Fresh databases already carry every column in the
    // CREATE TABLE, so this runs at most once per database; bump the flag
    // name (v1→v2…) if new ALTERs are ever added.
    if (!schemaAlterDone) {
      await this.addColumnIfMissing("chat_settings", "min_market_cap_usd", "REAL NOT NULL DEFAULT 40000");
      await this.addColumnIfMissing("chat_settings", "max_market_cap_usd", "REAL NOT NULL DEFAULT 300000");
      await this.addColumnIfMissing("chat_settings", "min_age_minutes", "REAL NOT NULL DEFAULT 300");
      await this.addColumnIfMissing("chat_settings", "max_age_minutes", "REAL NOT NULL DEFAULT 1680");
      await this.addColumnIfMissing("chat_settings", "min_5m_vol_usd", "REAL NOT NULL DEFAULT 6000");
      await this.addColumnIfMissing("chat_settings", "min_5m_chg_pct", "REAL NOT NULL DEFAULT 30");
      await this.addColumnIfMissing("token_stats", "birdeye_1m_vol", "REAL");
      await this.addColumnIfMissing("token_stats", "rugcheck_bundler_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "rugcheck_top10_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "birdeye_pro_traders", "INTEGER");
      await this.addColumnIfMissing("token_stats", "birdeye_sniper_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "min_mcap_observed", "REAL");
      await this.addColumnIfMissing("token_stats", "supply_flow", "TEXT");
      await this.addColumnIfMissing("token_stats", "supply_flow_at", "INTEGER");
      await this.setWorkerState("schema_alter_v1_done", "1");
    }
    // v2: store launch_ms (estimated launch time) so the re-eval pool query
    // can use the idx_token_stats_launch index instead of computing
    // (first_seen_at - first_seen_age_min * 60000) on every row (~400K) and
    // sorting the result — the scan's dominant Turso rows-read consumer.
    // Existing rows are backfilled in bounded chunks (a single huge UPDATE
    // could exceed the 15s request timeout on a degraded database). Fresh
    // databases already carry the column from CREATE TABLE, so this is a
    // no-op backfill for them.
    //
    // Only a SMALL slice is kicked off here: a long init eats into the
    // scheduled event's ~30s wall clock before the scan even starts, and a
    // 20s budget on a slow database still leaves ~350K legacy rows undone
    // with no way to resume on a warm isolate (init runs once per isolate;
    // the next chance to continue could be an isolate recycle hours away).
    // The scanner resumes the rest per tick via resumeLaunchBackfill until
    // the flag is set, so legacy rows become visible to the banded pool
    // query within minutes instead of hours.
    if (!schemaAlterV2) {
      await this.addColumnIfMissing("token_stats", "launch_ms", "INTEGER");
      await this.get().execute({
        sql: "CREATE INDEX IF NOT EXISTS idx_token_stats_launch ON token_stats(launch_ms)",
        args: [],
      });
      let done = false;
      const kickBudget = Date.now() + 6_000;
      for (let i = 0; i < 4 && Date.now() < kickBudget; i++) {
        const updated = await this.backfillLaunchChunk();
        if (updated < 5000) {
          done = true; // no NULL rows left — migration complete
          break;
        }
      }
      if (done) {
        await this.setWorkerState("schema_alter_v2_done", "1");
        console.log("[db] launch_ms backfill complete");
      } else {
        console.log("[db] launch_ms backfill started — resuming on later ticks");
      }
    }
    // v3: max_mcap_observed — highest market cap the scanner has ever seen
    // for each coin. The re-eval pool pre-filters on it (coins repeatedly
    // observed far below the qualifying gate stop consuming sweep budget)
    // and orders rotation bands by it, so the LIMIT picks the most promising
    // coins. Unconditional because addColumnIfMissing is idempotent (fresh
    // databases already carry the column from CREATE TABLE).
    await this.addColumnIfMissing("token_stats", "max_mcap_observed", "REAL");
    // v4: min_1h_chg_pct — the compound momentum gate's 1-hour leg (chat
    // filter). Unconditional because addColumnIfMissing is idempotent.
    await this.addColumnIfMissing(
      "chat_settings",
      "min_1h_chg_pct",
      "REAL NOT NULL DEFAULT 40",
    );
    // Telemetry counters: /health used to run COUNT(*) over token_stats
    // (~400K rows) and seen_tokens (~50K rows) on every ping — at the 1-min
    // uptime-monitor cadence that alone is ~600M rows/day (alerted
    // 2026-08-16). Seed the counters once per database here, then keep them
    // fresh with cheap incremental bumps (see bumpTelemetryCounter) so
    // /health reads two tiny worker_state rows instead of two full scans.
    const telemetrySeeded = await this.getWorkerState(
      "telemetry_counts_seeded_v1",
    );
    if (!telemetrySeeded) {
      const counts = await c.batch(
        [
          { sql: "SELECT COUNT(*) AS n FROM token_stats", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM seen_tokens", args: [] },
        ],
        "read",
      );
      const n1 = Number(
        (counts[0].rows[0] as { n?: number | bigint } | undefined)?.n ?? 0,
      );
      const n2 = Number(
        (counts[1].rows[0] as { n?: number | bigint } | undefined)?.n ?? 0,
      );
      await c.batch(
        [
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_token_stats_count', ?)",
            args: [String(n1)],
          },
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_seen_tokens_count', ?)",
            args: [String(n2)],
          },
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_counts_seeded_v1', '1')",
            args: [],
          },
        ],
        "write",
      );
    }
  }

  /**
   * Record that a scheduled cron event arrived — raw upserts that work even
   * BEFORE init() (worker_state exists in every live database; connect() is
   * lazy and needs no DDL). This is the cross-isolate proof that the Cron
   * Trigger is delivering: a slow/failed init otherwise kills the scheduled
   * event inside the ~30s wall clock and cron looks dead from /health even
   * though the trigger fires (observed 2026-08-14).
   */
  async bumpScheduledTick(): Promise<void> {
    const c = this.connect();
    const now = String(Date.now());
    const res = await c.execute({
      sql: "SELECT value FROM worker_state WHERE key = 'scheduled_tick_total'",
      args: [],
    });
    const prev = res.rows.length > 0 ? parseInt(String(res.rows[0].value), 10) || 0 : 0;
    await c.execute({
      sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_total', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [String(prev + 1)],
    });
    await c.execute({
      sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [now],
    });
  }

  private async addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    try {
      await this.get().execute({
        sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        args: [],
      });
      console.log(`[db] added column ${table}.${column}`);
    } catch (err) {
      // SQLite throws "duplicate column name" when it already exists — fine.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) {
        console.warn(`[db] migrate ${table}.${column} skipped:`, msg);
      }
    }
  }

  /**
   * Backfill one bounded chunk of the launch_ms migration (see init and
   * resumeLaunchBackfill). Bounds: the subquery collects at most 5000 NULL
   * rows per call, so a single statement never reads more than a few
   * thousand rows even on a 350K-row table.
   */
  private async backfillLaunchChunk(): Promise<number> {
    const res = await this.get().execute({
      sql: `UPDATE token_stats
            SET launch_ms = first_seen_at - first_seen_age_min * 60000
            WHERE launch_ms IS NULL
              AND token IN (
                SELECT token FROM token_stats WHERE launch_ms IS NULL LIMIT 5000
              )`,
      args: [],
    });
    return Number(res.rowsAffected ?? 0);
  }

  /**
   * Resume the launch_ms backfill migration (see init). Called once per scan
   * tick until the migration flag is set, so a migration that outlived its
   * in-init budget keeps making progress on a warm isolate instead of
   * waiting for the next isolate recycle (legacy rows with NULL launch_ms
   * are invisible to the banded re-eval pool query meanwhile). Bounded: at
   * most 4 chunks or `budgetMs`, whichever comes first, so a slow database
   * can't blow the tick budget. Returns true when the migration is complete
   * (or was already) — the caller caches that so this stops being called.
   * Idempotent and concurrency-safe: chunks are independent, and the flag is
   * only set once no NULL rows remain (a chunk < 5000 means the subquery's
   * LIMIT didn't cap — there are no NULL rows left to collect).
   */
  async resumeLaunchBackfill(budgetMs: number): Promise<boolean> {
    if (await this.getWorkerState("schema_alter_v2_done")) return true;
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < 4 && Date.now() < deadline; i++) {
      const updated = await this.backfillLaunchChunk();
      if (updated < 5000) {
        await this.setWorkerState("schema_alter_v2_done", "1");
        console.log("[db] launch_ms backfill complete");
        return true;
      }
    }
    return false;
  }

  private get(): Client {
    if (!this.client) {
      throw new Error("Database is not initialized");
    }
    return this.client;
  }

  private mapRow(row: Record<string, unknown>): ChatSettings {
    return {
      chatId: String(row.chat_id),
      minLiquidityUsd: Number(row.min_liquidity_usd ?? 0),
      minVolume24hUsd: Number(row.min_volume_24h_usd ?? 0),
      minMarketCapUsd: Number(row.min_market_cap_usd ?? DEFAULT_SETTINGS.minMarketCapUsd),
      maxMarketCapUsd: Number(row.max_market_cap_usd ?? DEFAULT_SETTINGS.maxMarketCapUsd),
      minAgeMinutes: Number(row.min_age_minutes ?? DEFAULT_SETTINGS.minAgeMinutes),
      maxAgeMinutes: Number(row.max_age_minutes ?? DEFAULT_SETTINGS.maxAgeMinutes),
      min5mVolUsd: Number(row.min_5m_vol_usd ?? DEFAULT_SETTINGS.min5mVolUsd),
      min5mChgPct: Number(row.min_5m_chg_pct ?? DEFAULT_SETTINGS.min5mChgPct),
      min1hChgPct: Number(row.min_1h_chg_pct ?? DEFAULT_SETTINGS.min1hChgPct),
      enabled: Number(row.enabled) === 1,
    };
  }

  async getChatSettings(chatId: string): Promise<ChatSettings | null> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings WHERE chat_id = ?",
      args: [chatId],
    });
    const row = res.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async saveChatSettings(settings: ChatSettings): Promise<void> {
    await this.get().execute({
      sql: `
        INSERT INTO chat_settings
          (chat_id, min_liquidity_usd, min_volume_24h_usd,
           min_market_cap_usd, max_market_cap_usd, min_age_minutes, max_age_minutes,
           min_5m_vol_usd, min_5m_chg_pct, min_1h_chg_pct, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          min_liquidity_usd = excluded.min_liquidity_usd,
          min_volume_24h_usd = excluded.min_volume_24h_usd,
          min_market_cap_usd = excluded.min_market_cap_usd,
          max_market_cap_usd = excluded.max_market_cap_usd,
          min_age_minutes = excluded.min_age_minutes,
          max_age_minutes = excluded.max_age_minutes,
          min_5m_vol_usd = excluded.min_5m_vol_usd,
          min_5m_chg_pct = excluded.min_5m_chg_pct,
          min_1h_chg_pct = excluded.min_1h_chg_pct,
          enabled = excluded.enabled
      `,
      args: [
        settings.chatId,
        settings.minLiquidityUsd,
        settings.minVolume24hUsd,
        settings.minMarketCapUsd,
        settings.maxMarketCapUsd,
        settings.minAgeMinutes,
        settings.maxAgeMinutes,
        settings.min5mVolUsd,
        settings.min5mChgPct,
        settings.min1hChgPct,
        settings.enabled ? 1 : 0,
      ],
    });
  }

  async listEnabledChats(): Promise<ChatSettings[]> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings WHERE enabled = 1",
      args: [],
    });
    return res.rows.map((row) => this.mapRow(row));
  }

  /**
   * Every chat row regardless of push state (operator diagnostics —
   * /debug/chats). Lets the operator see each chat's full filter profile,
   * including disabled ones, since the pool query bounds use the WIDEST
   * enabled chat and a stale wide chat silently widens the tracked window.
   */
  async listAllChats(): Promise<ChatSettings[]> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings ORDER BY chat_id",
      args: [],
    });
    return res.rows.map((row) => this.mapRow(row));
  }

  async isTokenSeen(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "SELECT 1 AS seen FROM seen_tokens WHERE chat_id = ? AND token = ? LIMIT 1",
      args: [chatId, token],
    });
    return res.rows.length > 0;
  }

  /**
   * Whether a token was ever pushed to any chat, and when the first push
   * happened (seen_tokens rows are written by markTokenSeen on every push).
   * Used by /flow to mark coins the bot has already alerted on.
   */
  async getTokenPushedInfo(
    token: string,
  ): Promise<{ pushed: boolean; at?: number }> {
    const res = await this.get().execute({
      sql: "SELECT first_seen_at FROM seen_tokens WHERE token = ? ORDER BY first_seen_at LIMIT 1",
      args: [token],
    });
    const row = res.rows[0];
    if (!row) return { pushed: false };
    const at = Number((row as Record<string, unknown>).first_seen_at);
    return Number.isFinite(at) && at > 0
      ? { pushed: true, at }
      : { pushed: true };
  }

  /**
   * Cross-isolate telemetry: Cloudflare Workers isolates have independent
   * module state, so /health on one isolate cannot see counters living on
   * the isolate that ran the scheduled scanner. Persisting the scan
   * heartbeat in Turso makes the scanner observable from anywhere.
   */
  async setWorkerState(key: string, value: string): Promise<void> {
    await this.get().execute({
      sql: "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    });
  }

  async getWorkerState(key: string): Promise<string | null> {
    const res = await this.get().execute({
      sql: "SELECT value FROM worker_state WHERE key = ?",
      args: [key],
    });
    const row = res.rows[0];
    if (!row) return null;
    const v = (row as Record<string, unknown>).value;
    return v === null || v === undefined ? null : String(v);
  }

  /** All pushed rows in seen_tokens, oldest first (telemetry for /debug/pushes). */
  async listSeenTokens(): Promise<{ chatId: string; token: string; firstSeenAt: number }[]> {
    try {
      const res = await this.get().execute({
        sql: "SELECT chat_id, token, first_seen_at FROM seen_tokens ORDER BY first_seen_at ASC",
        args: [],
      });
      return res.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          chatId: String(r.chat_id ?? ""),
          token: String(r.token ?? ""),
          firstSeenAt: Number(r.first_seen_at ?? 0),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Atomically add `delta` to a worker_state integer counter. Used to keep
   * the /health table counts (countSeenTokens/countTokenStats) fresh without
   * a COUNT(*) per read. The upsert-add is atomic in SQLite, so concurrent
   * isolates can never lose an increment (a read-modify-write could).
   * Telemetry only — a failed bump must never fail the write it follows.
   */
  private async bumpTelemetryCounter(
    key: string,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    try {
      await this.get().execute({
        sql: `INSERT INTO worker_state (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET
                value = CAST(value AS INTEGER) + excluded.value`,
        args: [key, String(delta)],
      });
    } catch (err) {
      console.warn(`[db] telemetry counter ${key} bump failed:`, err);
    }
  }

  /**
   * Read a cached table count (worker_state integer), falling back to a live
   * COUNT(*) only when the cache is missing (e.g. a database seeded before
   * the counters existed). /health hits this on every ping, so the common
   * path must be the single-row read, never a full table scan.
   */
  private async readTelemetryCounter(
    key: string,
    fallbackSql: string,
  ): Promise<number> {
    try {
      const v = await this.getWorkerState(key);
      if (v !== null && /^-?\d+$/.test(v)) return Number(v);
    } catch {
      // fall through to the live count
    }
    try {
      const res = await this.get().execute({ sql: fallbackSql, args: [] });
      const row = res.rows[0] as { n?: number | bigint } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /** Total pushed rows in seen_tokens (telemetry for /health). */
  async countSeenTokens(): Promise<number> {
    return this.readTelemetryCounter(
      "telemetry_seen_tokens_count",
      "SELECT COUNT(*) AS n FROM seen_tokens",
    );
  }

  /** Total rows in token_stats (telemetry for /health — pool coverage). */
  async countTokenStats(): Promise<number> {
    return this.readTelemetryCounter(
      "telemetry_token_stats_count",
      "SELECT COUNT(*) AS n FROM token_stats",
    );
  }

  /**
   * Append one permanent scan-history row per tick (survives isolate
   * evictions, unlike the in-memory counters). History is bounded: rows
   * older than 30 days are pruned, at most once per day.
   */
  async recordScanHistory(entry: {
    at: number;
    ok: boolean;
    ms: number;
    err: string | null;
    profiles: number | null;
    pool: number | null;
    candidates: number | null;
    pushed: number | null;
  }): Promise<void> {
    await this.get().execute({
      sql: `INSERT INTO scan_history (at, ok, ms, err, profiles, pool, candidates, pushed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.at,
        entry.ok ? 1 : 0,
        entry.ms,
        entry.err,
        entry.profiles,
        entry.pool,
        entry.candidates,
        entry.pushed,
      ],
    });
    const lastPrune = await this.getWorkerState("history_last_prune");
    // Once per day is enough: the table is ~43K rows (30 days × 1 row/tick),
    // and the hourly cadence read the whole index ~24×/day (~1M rows/day —
    // a non-trivial rows-read consumer at the 500M/month free tier).
    if (!lastPrune || Date.now() - Number(lastPrune) > 24 * 3600_000) {
      await this.get().execute({
        sql: "DELETE FROM scan_history WHERE at < ?",
        args: [Date.now() - 30 * 24 * 3600_000],
      });
      await this.setWorkerState("history_last_prune", String(Date.now()));
    }
  }

  /** Record a Trojan buy attempt (UNIQUE(token): one row per coin). */
  async recordTrade(entry: {
    token: string;
    chatId: string;
    mode: "auto" | "manual";
    status: "success" | "failed";
    txHash: string | null;
    amountSol: number;
    slippagePct: number;
    error: string | null;
  }): Promise<void> {
    await this.get().execute({
      sql: `INSERT OR IGNORE INTO trade_log
            (token, chat_id, mode, status, tx_hash, amount_sol, slippage_pct, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.token,
        entry.chatId,
        entry.mode,
        entry.status,
        entry.txHash,
        entry.amountSol,
        entry.slippagePct,
        entry.error,
        Date.now(),
      ],
    });
  }

  /** Whether a buy was ever attempted for this token (any chat, any mode). */
  async hasTraded(token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "SELECT 1 AS seen FROM trade_log WHERE token = ? LIMIT 1",
      args: [token],
    });
    return res.rows.length > 0;
  }

  /** Number of buy attempts since `sinceMs` (rolling daily-budget guard). */
  async countTradesSince(sinceMs: number): Promise<number> {
    const res = await this.get().execute({
      sql: "SELECT COUNT(*) AS n FROM trade_log WHERE created_at >= ?",
      args: [sinceMs],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  /**
   * Telegram-set trade-mode override (worker_state key trade_mode_override).
   * Takes precedence over the env TRADE_MODE var in every money-moving path;
   * null means "no override — use the env config". Invalid stored values
   * (e.g. a stale hand edit) are ignored and treated as no override.
   */
  async getTradeModeOverride(): Promise<"off" | "manual" | "auto" | null> {
    const v = await this.getWorkerState("trade_mode_override");
    if (v === "off" || v === "manual" || v === "auto") return v;
    return null;
  }

  /** Persist (or clear, when null) the Telegram trade-mode override. */
  async setTradeModeOverride(
    mode: "off" | "manual" | "auto" | null,
  ): Promise<void> {
    if (mode === null) {
      await this.get().execute({
        sql: "DELETE FROM worker_state WHERE key = ?",
        args: ["trade_mode_override"],
      });
      return;
    }
    await this.setWorkerState("trade_mode_override", mode);
  }

  /** Record a sell attempt (half/all) — no UNIQUE: sells can repeat. */
  async recordSell(entry: {
    token: string;
    chatId: string;
    mode: "half" | "all";
    status: "success" | "failed";
    txHash: string | null;
    amountToken: number | null;
    error: string | null;
  }): Promise<void> {
    await this.get().execute({
      sql: `INSERT INTO sell_log
            (token, chat_id, mode, status, tx_hash, amount_token, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.token,
        entry.chatId,
        entry.mode,
        entry.status,
        entry.txHash,
        entry.amountToken,
        entry.error,
        Date.now(),
      ],
    });
  }

  /** Most recent sell attempts (newest first) for diagnostics. */
  async latestSells(
    limit: number,
  ): Promise<Array<{ token: string; status: string; txHash: string | null; mode: string; error: string | null; createdAt: number }>> {
    const res = await this.get().execute({
      sql: "SELECT token, mode, status, tx_hash, error, created_at FROM sell_log ORDER BY created_at DESC LIMIT ?",
      args: [Math.max(1, Math.min(limit, 50))],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        mode: String(r.mode),
        status: String(r.status),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        createdAt: Number(r.created_at),
      };
    });
  }

  /** Most recent trade attempts (newest first) for diagnostics. */
  async latestTrades(
    limit: number,
  ): Promise<Array<{ token: string; status: string; txHash: string | null; mode: string; error: string | null; createdAt: number }>> {
    const res = await this.get().execute({
      sql: "SELECT token, mode, status, tx_hash, error, created_at FROM trade_log ORDER BY created_at DESC LIMIT ?",
      args: [Math.max(1, Math.min(limit, 50))],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        mode: String(r.mode),
        status: String(r.status),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        createdAt: Number(r.created_at),
      };
    });
  }

  async markTokenSeen(chatId: string, token: string): Promise<void> {
    const res = await this.get().execute({
      sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
      args: [chatId, token, Date.now()],
    });
    // Keep the /health count fresh (INSERT OR IGNORE: rowsAffected 0 when
    // the coin was already marked — e.g. a re-push guard — so no bump).
    await this.bumpTelemetryCounter(
      "telemetry_seen_tokens_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  private statsFromRow(row: Record<string, unknown>): TokenStats {
    const birdeye = row.birdeye_1m_vol;
    const rugcheck = row.rugcheck_bundler_pct;
    const top10 = row.rugcheck_top10_pct;
    const proTraders = row.birdeye_pro_traders;
    const sniperPct = row.birdeye_sniper_pct;
    const minMcap = row.min_mcap_observed;
    const flowJson = row.supply_flow;
    const flowAt = row.supply_flow_at;
    return {
      token: String(row.token),
      firstSeenAt: Number(row.first_seen_at),
      firstM5Vol: Number(row.first_m5_vol),
      firstSeenAgeMin: Number(row.first_seen_age_min),
      // Rows written before the launch_ms migration fall back to the same
      // computed value the old query used, so nothing changes for them.
      launchMs: Number(
        row.launch_ms ??
          Number(row.first_seen_at) - Number(row.first_seen_age_min) * 60_000,
      ),
      birdeye1mVol: birdeye === null || birdeye === undefined ? null : Number(birdeye),
      rugcheckBundlerPct:
        rugcheck === null || rugcheck === undefined ? null : Number(rugcheck),
      rugcheckTop10Pct:
        top10 === null || top10 === undefined ? null : Number(top10),
      birdeyeProTraders:
        proTraders === null || proTraders === undefined ? null : Number(proTraders),
      birdeyeSniperPct:
        sniperPct === null || sniperPct === undefined ? null : Number(sniperPct),
      minMcapObserved:
        minMcap === null || minMcap === undefined ? null : Number(minMcap),
      maxMcapObserved:
        row.max_mcap_observed === null || row.max_mcap_observed === undefined
          ? null
          : Number(row.max_mcap_observed),
      supplyFlowJson:
        flowJson === null || flowJson === undefined ? null : String(flowJson),
      supplyFlowAt:
        flowAt === null || flowAt === undefined ? null : Number(flowAt),
    };
  }

  async getTokenStats(token: string): Promise<TokenStats | null> {
    const res = await this.get().execute({
      sql: "SELECT * FROM token_stats WHERE token = ?",
      args: [token],
    });
    const row = res.rows[0];
    if (!row) return null;
    return this.statsFromRow(row);
  }

  /**
   * Fetch stats for many tokens in ONE query. The scanner calls this once
   * per tick for the whole profiles feed; with per-token queries the tick
   * would make ~20 sequential Turso round trips, which dominates the scan
   * time whenever the database is slow (observed: ~5s per round trip).
   */
  async getTokenStatsMany(tokens: string[]): Promise<Map<string, TokenStats>> {
    const out = new Map<string, TokenStats>();
    if (tokens.length === 0) return out;
    const res = await this.get().execute({
      sql: `SELECT * FROM token_stats WHERE token IN (${tokens
        .map(() => "?")
        .join(",")})`,
      args: tokens,
    });
    for (const row of res.rows) {
      const stats = this.statsFromRow(row);
      out.set(stats.token, stats);
    }
    return out;
  }

  /**
   * Tokens that have never been pushed to any chat and are nearing or inside
   * the qualifying age window. This is the re-evaluation pool: DexScreener's
   * profiles feed only ever contains young tokens, so coins that must age
   * into the window (e.g. 6h minimum) would otherwise rotate out of the feed
   * and be lost forever. The pool instead keeps them until they qualify.
   *
   * `launch_ms` records the estimated launch time (pairCreatedAt or feed
   * openTimestamp at first observation). The query returns only tokens whose
   * launch falls within [minLaunchMs, maxLaunchMs], ordered by distance to
   * the window entry point — tokens that can qualify right now (or within
   * minutes) are always evaluated first.
   *
   * Index strategy (rows-read alert 2026-08-16): the previous version
   * filtered on the computed expression (first_seen_at - age*60s) and sorted
   * by ABS(launch - entry), which forced SQLite to scan and sort EVERY
   * token_stats row (~400K) per run. Candidates are ordered by distance to
   * the entry point, so only rows near the entry are ever returned: scan the
   * launch_ms index in a narrow band around the entry, widening until the
   * limit is met or the whole window is covered. That turns the ~400K-row
   * scan into a range scan over a few thousand rows. NOT EXISTS probes the
   * seen_tokens index per candidate instead of materializing the whole table
   * per query.
   *
   * Coverage fix (2026-08-16, zero-push bug): the widening loop stopped as
   * soon as the band around the entry held `limit` rows, and the pool is
   * ordered by proximity to the entry — so in a dense launch market the
   * LIMIT filled up with coins just below the age gate and coins that had
   * already aged past the gate were NEVER re-evaluated (measured: 26.8K
   * eligible never-pushed coins in the window, pool returned 1000 coins ALL
   * aged 3-6h, zero aged 6h+). Older coins only drift farther from the
   * entry over time, so they never came back.
   *
   * Structure now (2026-08-16): the pool splits into a HOT zone (coins
   * around the entry, evaluated every scan, ordered by distance to the
   * entry — the push-latency-critical cohort) plus a GRADUATED rotation:
   *
   *   NEAR zone (entry → entry+6h of age): the coins most likely to cross
   *     the gates after entering — POOL_NEAR_SLOTS slots swept every ~10 min.
   *   FAR zone (older tail): POOL_FAR_SLOTS slots swept every ~30 min —
   *     every coin is still re-checked at least once per far sweep, but the
   *     old tail stops consuming most of the budget.
   *
   * Rotation bands are ordered by qualification signal (max_mcap_observed
   * DESC, then first_m5_vol DESC), NOT distance to the slot center — the
   * per-slot LIMIT then always picks the most promising coins instead of
   * arbitrarily dropping band-edge coins in dense markets (the residual
   * starvation of the earlier uniform-slot design). When minQualifyMcap is
   * set, coins whose known max mcap is below it are dropped from every band
   * (NULL = never seen with pair data → kept): the sweep budget
   * concentrates on coins that can actually qualify. Rows-read stays
   * bounded: each scan reads the hot band (~1.5h of launches) plus one near
   * slot plus one far slot, never the whole window.
   */
  async getReevalPool(opts: {
    /** first_seen_at >= this (drops tokens whose launch is too far in the past). */
    sinceMs: number;
    /** Estimated launch must be >= this (age <= maxAgeMinutes + margin). */
    minLaunchMs: number;
    /** Estimated launch must be <= this (age >= minAgeMinutes - margin). */
    maxLaunchMs: number;
    /** Estimated launch of a token that just entered the window (age == minAgeMinutes). */
    windowEntryLaunchMs: number;
    limit: number;
    /**
     * Near-zone slot count (see POOL_NEAR_SLOTS). Default 2 → a full
     * near-zone sweep every ~10 min at the default pool cache.
     */
    nearSlots?: number;
    /**
     * Far-zone slot count (see POOL_FAR_SLOTS). Default 6 → a full
     * far-zone sweep every ~30 min at the default pool cache.
     */
    farSlots?: number;
    /**
     * Rotation period in ms — MUST equal the caller's pool cache TTL so
     * each cache expiry advances to the next slot. Defaults to
     * POOL_ROTATION_PERIOD_MS (300s); production passes the configured
     * REEVAL_POOL_CACHE_SECONDS (default 180s → 6-min near / 18-min far
     * sweeps at the default slot counts).
     */
    rotationPeriodMs?: number;
    /**
     * Pre-qualification floor: when set, coins whose max_mcap_observed is
     * known and below this value are dropped from every band (NULL = never
     * seen with pair data → kept). The scanner passes the widest chat's
     * minMarketCapUsd / 2.
     */
    minQualifyMcap?: number;
    /**
     * Enabled chat IDs (chat_settings WHERE enabled = 1). When provided, a
     * token is excluded from the pool only when EVERY one of these chats has
     * already seen it — a coin pushed to one chat but missed by another
     * (failed Telegram delivery) stays in the pool so the missed chat gets a
     * retry on a later scan. When omitted (legacy callers/tests), the old
     * token-level exclusion applies: any seen row removes the coin.
     */
    seenChatIds?: string[];
    /** Override for deterministic tests; defaults to Date.now(). */
    now?: number;
  }): Promise<TokenStats[]> {
    const now = opts.now ?? Date.now();
    const center = opts.windowEntryLaunchMs;
    const spanLo = opts.minLaunchMs;
    const spanHi = opts.maxLaunchMs;
    const hotLo = Math.max(spanLo, center - POOL_HOT_BELOW_MS);
    const hotHi = Math.min(spanHi, center + POOL_HOT_ABOVE_MS);
    const hotLimit = Math.min(opts.limit, POOL_HOT_MAX);
    const out: TokenStats[] = [];
    if (hotHi > hotLo) {
      // Hot zone: every scan, nearest to the entry first (latency-critical).
      out.push(
        ...(await this.queryReevalBand(hotLo, hotHi, center, {
          sinceMs: opts.sinceMs,
          limit: hotLimit,
          minQualifyMcap: opts.minQualifyMcap,
          seenChatIds: opts.seenChatIds,
          orderBy: "entry",
        })),
      );
    }
    const rotLimit = Math.max(0, opts.limit - hotLimit);
    if (rotLimit <= 0) return out;
    const rotLo = spanLo; // oldest launch in the window
    const rotHi = hotLo; // everything older than the hot zone
    if (rotHi <= rotLo) return out;
    const nearLo = Math.max(rotLo, center - POOL_NEAR_WINDOW_MS);
    const nearSlots = Math.max(1, Math.floor(opts.nearSlots ?? POOL_NEAR_SLOTS));
    const farSlots = Math.max(1, Math.floor(opts.farSlots ?? POOL_FAR_SLOTS));
    const nearLimit = Math.max(
      0,
      Math.min(rotLimit, Math.round(rotLimit * POOL_NEAR_LIMIT_SHARE)),
    );
    const farLimit = Math.max(0, rotLimit - nearLimit);
    const slot = Math.floor(now / (opts.rotationPeriodMs ?? POOL_ROTATION_PERIOD_MS));
    // Near zone: entry → entry + POOL_NEAR_WINDOW_MS of age — fresh
    // in-window coins, most likely to cross the gates → frequent sweep.
    if (rotHi > nearLo && nearLimit > 0) {
      const slotW = (rotHi - nearLo) / nearSlots;
      const s = slot % nearSlots;
      const lo = rotHi - (s + 1) * slotW;
      const hi = rotHi - s * slotW;
      out.push(
        ...(await this.queryReevalBand(lo, hi, (lo + hi) / 2, {
          sinceMs: opts.sinceMs,
          limit: nearLimit,
          minQualifyMcap: opts.minQualifyMcap,
          seenChatIds: opts.seenChatIds,
          orderBy: "signal",
        })),
      );
    }
    // Far zone: the older tail — qualification is rare this deep, so sweep
    // it slowly; every coin is still re-checked at least once per sweep.
    if (nearLo > rotLo && farLimit > 0) {
      const slotW = (nearLo - rotLo) / farSlots;
      const s = slot % farSlots;
      const lo = nearLo - (s + 1) * slotW;
      const hi = nearLo - s * slotW;
      out.push(
        ...(await this.queryReevalBand(lo, hi, (lo + hi) / 2, {
          sinceMs: opts.sinceMs,
          limit: farLimit,
          minQualifyMcap: opts.minQualifyMcap,
          seenChatIds: opts.seenChatIds,
          orderBy: "signal",
        })),
      );
    }
    return out;
  }

  /**
   * One banded re-eval pool query (see getReevalPool). `orderBy` "entry"
   * ranks by distance to the band center (hot zone — nearest to the window
   * entry first); "signal" ranks by qualification signal
   * (max_mcap_observed, then first_m5_vol) so the per-band LIMIT picks the
   * most promising coins instead of arbitrary band-edge ones.
   */
  private async queryReevalBand(
    lo: number,
    hi: number,
    center: number,
    opts: {
      sinceMs: number;
      limit: number;
      minQualifyMcap?: number;
      seenChatIds?: string[];
      orderBy: "entry" | "signal";
    },
  ): Promise<TokenStats[]> {
    const qualifyClause =
      opts.minQualifyMcap !== undefined
        ? ` AND (max_mcap_observed IS NULL OR max_mcap_observed >= ?)`
        : "";
    const seen = this.seenExclusion(opts.seenChatIds);
    const args: Array<string | number> = [lo, hi, opts.sinceMs];
    if (opts.minQualifyMcap !== undefined) args.push(opts.minQualifyMcap);
    args.push(...seen.args);
    const order =
      opts.orderBy === "signal"
        ? "ORDER BY COALESCE(max_mcap_observed, 0) DESC, COALESCE(first_m5_vol, 0) DESC"
        : "ORDER BY ABS(launch_ms - ?)";
    if (opts.orderBy === "entry") args.push(center);
    args.push(opts.limit);
    const res = await this.get().execute({
      sql: `SELECT * FROM token_stats
            WHERE launch_ms BETWEEN ? AND ?
              AND first_seen_at > ?
              ${qualifyClause}
              ${seen.clause}
            ${order}
            LIMIT ?`,
      args,
    });
    return res.rows.map((row) => this.statsFromRow(row));
  }

  /**
   * SQL fragment + args that implement the pool's "seen" exclusion.
   *
   * Chat-aware (seenChatIds provided): a token is excluded only when EVERY
   * enabled chat has already seen it — the scanner passes the enabled chat
   * list so a coin whose push to one chat failed (Telegram error) stays in
   * the re-eval pool and is retried for the missed chat instead of being
   * lost forever (the bug behind cross-chat push inconsistency). The
   * subquery walks the idx_seen_tokens_token index per candidate and the
   * chat_settings table is tiny (a handful of rows), so rows-read stays
   * bounded like the legacy NOT EXISTS probe.
   *
   * Legacy (seenChatIds omitted): any seen row removes the coin, matching
   * the pre-2026-08-17 behavior used by tests and one-shot callers.
   */
  private seenExclusion(seenChatIds?: string[]): {
    clause: string;
    args: Array<string | number>;
  } {
    if (seenChatIds && seenChatIds.length > 0) {
      return {
        clause: `AND (
          SELECT COUNT(*) FROM seen_tokens s
          WHERE s.token = token_stats.token
            AND s.chat_id IN (${seenChatIds.map(() => "?").join(",")})
        ) < ?`,
        args: [...seenChatIds, seenChatIds.length],
      };
    }
    return {
      clause:
        "AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)",
      args: [],
    };
  }

  /**
   * Raise max_mcap_observed to the given CURRENT market cap for tokens whose
   * stored value is lower (one batched statement; entries with no raise are
   * no-ops). The re-eval pool uses this as its qualification pre-signal: a
   * coin repeatedly observed far below minQualifyMcap stops consuming sweep
   * budget, and rotation bands order by it so the LIMIT picks the most
   * promising coins.
   */
  /**
   * Record the top-holder snapshot of one pushed coin (wallet analysis,
   * feature C): the creator row plus each resolved top holder, tagged with
   * their rank, whether they are the creator and whether they hit the crime
   * list. INSERT OR IGNORE so a coin pushed to several chats / retried
   * across ticks only stores one snapshot. Callers pass `pushedAt` so the
   * cluster window is anchored to the push time, not the write time.
   */
  async recordPushedHolders(
    rows: Array<{
      token: string;
      owner: string;
      rank: number;
      uiAmount: number;
      isCreator: boolean;
      crimeHit: boolean;
    }>,
    pushedAt: number,
  ): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
    const args: Array<string | number> = [];
    for (const r of rows) {
      args.push(
        r.token,
        r.owner,
        r.rank,
        Number.isFinite(r.uiAmount) ? r.uiAmount : 0,
        r.isCreator ? 1 : 0,
        r.crimeHit ? 1 : 0,
        pushedAt,
      );
    }
    await this.get().execute({
      sql: `INSERT OR IGNORE INTO pushed_holders (token, owner, rank, ui_amount, is_creator, crime_hit, pushed_at) VALUES ${placeholders}`,
      args,
    });
  }

  /**
   * Per-owner cluster stats over pushed_holders: how many DISTINCT pushed
   * coins each owner was a top holder (or creator) of since `sinceMs`, the
   * most recent push, and whether any of their rows is the creator row.
   * One query for the whole wallet batch (rows are few — ~9 per push).
   */
  async getHolderClusters(
    owners: string[],
    sinceMs: number,
    minCoins: number,
  ): Promise<
    Array<{
      owner: string;
      coins: number;
      lastSeenAt: number;
      isCreator: boolean;
    }>
  > {
    if (owners.length === 0) return [];
    const res = await this.get().execute({
      sql: `SELECT owner,
                   COUNT(DISTINCT token) AS coins,
                   MAX(pushed_at) AS last_seen,
                   MAX(is_creator) AS is_creator
            FROM pushed_holders
            WHERE owner IN (${owners.map(() => "?").join(",")}) AND pushed_at > ?
            GROUP BY owner
            HAVING coins >= ?`,
      args: [...owners, sinceMs, minCoins],
    });
    return res.rows.map((row) => ({
      owner: String(row.owner),
      coins: Number(row.coins ?? 0),
      lastSeenAt: Number(row.last_seen ?? 0),
      isCreator: Number(row.is_creator ?? 0) === 1,
    }));
  }

  /**
   * Global cluster scan for /debug/holder-clusters: every wallet that was a
   * top holder (or creator) of >= minCoins distinct pushed coins in the
   * window, ranked by coin count then most recent activity. Small table, so
   * a plain GROUP BY scan is cheap (bounded by the window filter + LIMIT).
   */
  async getGlobalHolderClusters(
    sinceMs: number,
    minCoins: number,
    limit = 25,
  ): Promise<
    Array<{
      owner: string;
      coins: number;
      lastSeenAt: number;
      isCreator: boolean;
      crimeHits: number;
    }>
  > {
    const res = await this.get().execute({
      sql: `SELECT owner,
                   COUNT(DISTINCT token) AS coins,
                   MAX(pushed_at) AS last_seen,
                   MAX(is_creator) AS is_creator,
                   SUM(crime_hit) AS crime_hits
            FROM pushed_holders
            WHERE pushed_at > ?
            GROUP BY owner
            HAVING coins >= ?
            ORDER BY coins DESC, last_seen DESC
            LIMIT ?`,
      args: [sinceMs, minCoins, limit],
    });
    return res.rows.map((row) => ({
      owner: String(row.owner),
      coins: Number(row.coins ?? 0),
      lastSeenAt: Number(row.last_seen ?? 0),
      isCreator: Number(row.is_creator ?? 0) === 1,
      crimeHits: Number(row.crime_hits ?? 0),
    }));
  }

  /**
   * Prune pushed_holders rows older than `olderThanMs` (bounded chunk — the
   * table is tiny, so one pass suffices; the analyzer rate-limits calls via
   * worker_state `pushed_holders_last_prune`).
   */
  async prunePushedHolders(olderThanMs: number, maxRows = 5000): Promise<number> {
    const res = await this.get().execute({
      sql: `DELETE FROM pushed_holders WHERE rowid IN (
              SELECT rowid FROM pushed_holders WHERE pushed_at < ? LIMIT ?
            )`,
      args: [olderThanMs, maxRows],
    });
    return Number(res.rowsAffected ?? 0);
  }

  async updateTokenMaxMcaps(
    entries: Array<{ token: string; mcapUsd: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const cases = entries
      .map(
        () =>
          `WHEN token = ? AND (max_mcap_observed IS NULL OR max_mcap_observed < ?) THEN ?`,
      )
      .join(" ");
    const args: Array<string | number> = [];
    const tokens: string[] = [];
    for (const e of entries) {
      args.push(e.token, e.mcapUsd, e.mcapUsd);
      tokens.push(e.token);
    }
    await this.get().execute({
      sql: `UPDATE token_stats SET max_mcap_observed = CASE ${cases} ELSE max_mcap_observed END
            WHERE token IN (${tokens.map(() => "?").join(",")})`,
      args: [...args, ...tokens],
    });
  }

  /**
   * Diagnostic for /debug/pool: age distribution of token_stats rows
   * (never-pushed vs total) plus how many never-pushed coins sit inside the
   * re-eval window (launch 3h–43h ago). Tells whether a zero-push stretch is
   * a cold market (pool covers the whole window but nothing qualifies) or a
   * coverage gap (the pool's LIMIT starves 12h+ coins in a dense launch
   * market — see Scanner.getReevalPoolCached).
   */
  async getPoolHistogram(
    now: number,
    /** Enabled chat ids — the histogram's eligibleInWindow mirrors the
     * chat-aware pool exclusion (see seenExclusion) when provided. */
    seenChatIds?: string[],
  ): Promise<{
    total: number;
    neverPushed: number;
    buckets: Record<string, number>;
    eligibleInWindow: number;
  }> {
    const H = 3600_000;
    const res = await this.get().execute({
      sql: `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token) THEN 1 ELSE 0 END) AS never_pushed,
        SUM(CASE WHEN launch_ms > ? THEN 1 ELSE 0 END) AS b0_3h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b3_6h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b6_12h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b12_24h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b24_43h,
        SUM(CASE WHEN launch_ms <= ? THEN 1 ELSE 0 END) AS b_over43h
      FROM token_stats`,
      args: [
        now - 3 * H,
        now - 6 * H,
        now - 3 * H,
        now - 12 * H,
        now - 6 * H,
        now - 24 * H,
        now - 12 * H,
        now - 43 * H,
        now - 24 * H,
        now - 43 * H,
      ],
    });
    const r = res.rows[0] as Record<string, number | null>;
    const seen = this.seenExclusion(seenChatIds);
    const elig = await this.get().execute({
      sql: `SELECT COUNT(*) AS n FROM token_stats
            WHERE launch_ms BETWEEN ? AND ?
              AND first_seen_at > ?
              ${seen.clause}`,
      args: [now - 43 * H, now - 3 * H, now - 42 * H, ...seen.args],
    });
    return {
      total: Number(r.total ?? 0),
      neverPushed: Number(r.never_pushed ?? 0),
      buckets: {
        "0-3h": Number(r.b0_3h ?? 0),
        "3-6h": Number(r.b3_6h ?? 0),
        "6-12h": Number(r.b6_12h ?? 0),
        "12-24h": Number(r.b12_24h ?? 0),
        "24-43h": Number(r.b24_43h ?? 0),
        ">43h": Number(r.b_over43h ?? 0),
      },
      eligibleInWindow: Number(elig.rows[0]?.n ?? 0),
    };
  }

  async recordTokenStats(stats: TokenStats): Promise<void> {
    const res = await this.get().execute({
      sql: "INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, supply_flow, supply_flow_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
      args: [stats.token, stats.firstSeenAt, stats.firstM5Vol, stats.firstSeenAgeMin, stats.launchMs, stats.birdeye1mVol, stats.rugcheckBundlerPct, stats.rugcheckTop10Pct, stats.birdeyeProTraders, stats.birdeyeSniperPct, stats.minMcapObserved],
    });
    await this.bumpTelemetryCounter(
      "telemetry_token_stats_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  /**
   * Record stats for several first-seen tokens in ONE multi-row insert.
   * Same rationale as getTokenStatsMany: batch to keep the tick's Turso
   * round trips low when the database is slow.
   */
  async recordTokenStatsMany(statsList: TokenStats[]): Promise<void> {
    if (statsList.length === 0) return;
    const placeholders = statsList
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .join(",");
    const args: Array<string | number | null> = [];
    for (const s of statsList) {
      args.push(
        s.token,
        s.firstSeenAt,
        s.firstM5Vol,
        s.firstSeenAgeMin,
        s.launchMs,
        s.birdeye1mVol,
        s.rugcheckBundlerPct,
        s.rugcheckTop10Pct,
        s.birdeyeProTraders,
        s.birdeyeSniperPct,
        s.minMcapObserved,
      );
    }
    const res = await this.get().execute({
      sql: `INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, supply_flow, supply_flow_at) VALUES ${placeholders}`,
      args,
    });
    await this.bumpTelemetryCounter(
      "telemetry_token_stats_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  /**
   * Drop token_stats rows older than `olderThanMs` that were never pushed
   * (unreachable by the re-eval pool query, which only reads the last ~30h).
   * Bounds storage growth from pump.fun discovery, which registers 100+
   * new coins per scan; pushed coins keep their rows so /flow and cached
   * verdicts still work.
   *
   * Rows-read discipline (alerted 2026-08-16): the previous version ran an
   * un-chunked DELETE every 60s tick. It used the first_seen_at index, but
   * without ANALYZE statistics SQLite's default selectivity estimate for
   * the range is ~25%, so the plan could walk a large share of the
   * ~400K-row table per tick. This version (a) rate-limits the prune to
   * once per TOKEN_STATS_PRUNE_INTERVAL_MS (shared via worker_state across
   * isolates) and (b) deletes in bounded chunks (LIMIT 5000, max 3 chunks
   * per run), so a single statement can never read more than a few thousand
   * rows even when a backlog exists. Verified plan: the inner SELECT walks
   * idx_token_stats_first_seen and stops at LIMIT; NOT EXISTS probes the
   * seen_tokens index per candidate.
   */
  async pruneOldTokenStats(olderThanMs: number): Promise<number> {
    const lastPrune = await this.getWorkerState("token_stats_last_prune");
    if (lastPrune !== null && Date.now() - Number(lastPrune) < TOKEN_STATS_PRUNE_INTERVAL_MS) {
      return 0; // not due yet — the table can hold 10 min of extra rows safely
    }
    let deleted = 0;
    for (let chunk = 0; chunk < 3; chunk++) {
      const res = await this.get().execute({
        sql: `DELETE FROM token_stats WHERE token IN (
                SELECT token FROM token_stats
                WHERE first_seen_at < ?
                  AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)
                LIMIT 5000)`,
        args: [olderThanMs],
      });
      const n = Number(res.rowsAffected ?? 0);
      deleted += n;
      if (n < 5000) break; // backlog cleared
    }
    // Keep the /health count fresh (NOT EXISTS probes the seen_tokens index
    // per candidate instead of materializing the whole table like NOT IN did).
    await this.bumpTelemetryCounter("telemetry_token_stats_count", -deleted);
    await this.setWorkerState("token_stats_last_prune", String(Date.now()));
    return deleted;
  }

  async updateTokenBirdeyeVol(token: string, volume: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_1m_vol = ? WHERE token = ?",
      args: [volume, token],
    });
  }

  async updateTokenRugcheckData(
    token: string,
    bundlerPct: number | null,
    top10Pct: number | null,
  ): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET rugcheck_bundler_pct = ?, rugcheck_top10_pct = ? WHERE token = ?",
      args: [bundlerPct, top10Pct, token],
    });
  }

  async updateTokenProTraders(token: string, count: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_pro_traders = ? WHERE token = ?",
      args: [count, token],
    });
  }

  async updateTokenSniperPct(token: string, sniperPct: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_sniper_pct = ? WHERE token = ?",
      args: [sniperPct, token],
    });
  }

  async updateTokenMinMcap(token: string, minMcap: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET min_mcap_observed = ? WHERE token = ?",
      args: [minMcap, token],
    });
  }

  /** Cache the supply-flow detector result for a token (reused until refreshMs elapses). */
  async updateTokenSupplyFlow(token: string, json: string): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET supply_flow = ?, supply_flow_at = ? WHERE token = ?",
      args: [json, Date.now(), token],
    });
  }
}
