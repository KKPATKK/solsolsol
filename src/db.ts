// Use the Web-standard (HTTP/fetch-based) build explicitly: on Cloudflare
// Workers the main entry would resolve to the Node/WebSocket client (tsconfig
// is CommonJS, so wrangler picks the "require" condition), which cannot
// connect there. `@libsql/client/web` ships CJS + ESM variants, so the same
// import works in Node and on Workers. https:// URLs additionally force the
// pure-HTTP transport everywhere.
import { createClient, type Client } from "@libsql/client/web";

export interface ChatSettings {
  chatId: string;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxAgeMinutes: number;
  /** Minimum market cap in USD. */
  minMarketCapUsd: number;
  /** Minimum token age in minutes (skip instant-fade scams). */
  minAgeMinutes: number;
  /** Minimum 5-minute volume in USD. */
  min5mVolUsd: number;
  /** Minimum 5-minute price change in percent (e.g. 18 = +18%). */
  min5mChgPct: number;
  /** Maximum opening (first-observed) volume in USD; only coins that opened under this qualify. */
  max1mVolUsd: number;
  /** Maximum bundler/insider supply share in percent; coins above are skipped. */
  maxBundlerPct: number;
  /** Maximum top-10 holder concentration in percent; coins above are skipped. */
  maxTop10HolderPct: number;
  /** Maximum sniper buy share of supply in percent; coins above are skipped. */
  maxSniperPct: number;
  enabled: boolean;
}

/** Defaults mirror the DexScreener pumpfun filter URL the user specified. */
export const DEFAULT_SETTINGS: Omit<ChatSettings, "chatId"> = {
  minLiquidityUsd: 0,
  minVolume24hUsd: 0,
  maxAgeMinutes: 1440, // 24h
  minMarketCapUsd: 10000, // user: market cap must exceed $10k
  minAgeMinutes: 6.3, // URL: minAge=0.105 hours
  min5mVolUsd: 1800, // URL: min5MVol=1800
  min5mChgPct: 18, // URL: min5MChg=18
  max1mVolUsd: 10000, // user: opening volume must be under $10k
  maxBundlerPct: 24, // user: skip coins with bundlers over 24%
  maxTop10HolderPct: 27, // user: skip coins with top-10 holders over 27%
  maxSniperPct: 5, // user: skip coins whose sniper buy share of supply is over 5%
  enabled: false,
};

/** Opening stats captured the first time the scanner ever saw a token. */
export interface TokenStats {
  token: string;
  firstSeenAt: number;
  /** m5 volume at first observation — approximates the opening volume. */
  firstM5Vol: number;
  /** Token age in minutes at first observation. */
  firstSeenAgeMin: number;
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

  constructor(url: string, authToken?: string) {
    this.url = url;
    this.authToken = authToken;
  }

  async init(): Promise<void> {
    // libsql:// is a WebSocket scheme; https:// drives the HTTP transport,
    // which works reliably on Workers (fetch) and in Node alike.
    const httpUrl = this.url.replace(/^libsql:\/\//, "https://");
    this.client = createClient({ url: httpUrl, authToken: this.authToken });
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY,
        min_liquidity_usd REAL NOT NULL DEFAULT 0,
        min_volume_24h_usd REAL NOT NULL DEFAULT 0,
        max_age_minutes INTEGER NOT NULL DEFAULT 1440,
        min_market_cap_usd REAL NOT NULL DEFAULT 7800,
        min_age_minutes REAL NOT NULL DEFAULT 6.3,
        min_5m_vol_usd REAL NOT NULL DEFAULT 1800,
        min_5m_chg_pct REAL NOT NULL DEFAULT 18,
        max_1m_vol_usd REAL NOT NULL DEFAULT 10000,
        max_bundler_pct REAL NOT NULL DEFAULT 24,
        max_top10_holder_pct REAL NOT NULL DEFAULT 27,
        max_sniper_pct REAL NOT NULL DEFAULT 5,
        enabled INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migrations for databases created before these columns existed.
    await this.addColumnIfMissing("chat_settings", "min_market_cap_usd", "REAL NOT NULL DEFAULT 7800");
    await this.addColumnIfMissing("chat_settings", "min_age_minutes", "REAL NOT NULL DEFAULT 6.3");
    await this.addColumnIfMissing("chat_settings", "min_5m_vol_usd", "REAL NOT NULL DEFAULT 1800");
    await this.addColumnIfMissing("chat_settings", "min_5m_chg_pct", "REAL NOT NULL DEFAULT 18");
    await this.addColumnIfMissing("chat_settings", "max_1m_vol_usd", "REAL NOT NULL DEFAULT 10000");
    await this.addColumnIfMissing("chat_settings", "max_bundler_pct", "REAL NOT NULL DEFAULT 24");
    await this.addColumnIfMissing("chat_settings", "max_top10_holder_pct", "REAL NOT NULL DEFAULT 27");
    await this.addColumnIfMissing("chat_settings", "max_sniper_pct", "REAL NOT NULL DEFAULT 5");
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS worker_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS seen_tokens (
        chat_id TEXT NOT NULL,
        token TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, token)
      );
    `);
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS token_stats (
        token TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        first_m5_vol REAL NOT NULL,
        first_seen_age_min REAL NOT NULL,
        birdeye_1m_vol REAL,
        rugcheck_bundler_pct REAL,
        rugcheck_top10_pct REAL,
        birdeye_pro_traders INTEGER,
        birdeye_sniper_pct REAL,
        min_mcap_observed REAL
      );
    `);
    await this.addColumnIfMissing("token_stats", "birdeye_1m_vol", "REAL");
    await this.addColumnIfMissing("token_stats", "rugcheck_bundler_pct", "REAL");
    await this.addColumnIfMissing("token_stats", "rugcheck_top10_pct", "REAL");
    await this.addColumnIfMissing("token_stats", "birdeye_pro_traders", "INTEGER");
    await this.addColumnIfMissing("token_stats", "birdeye_sniper_pct", "REAL");
    await this.addColumnIfMissing("token_stats", "min_mcap_observed", "REAL");
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
      maxAgeMinutes: Number(row.max_age_minutes ?? DEFAULT_SETTINGS.maxAgeMinutes),
      minMarketCapUsd: Number(row.min_market_cap_usd ?? DEFAULT_SETTINGS.minMarketCapUsd),
      minAgeMinutes: Number(row.min_age_minutes ?? DEFAULT_SETTINGS.minAgeMinutes),
      min5mVolUsd: Number(row.min_5m_vol_usd ?? DEFAULT_SETTINGS.min5mVolUsd),
      min5mChgPct: Number(row.min_5m_chg_pct ?? DEFAULT_SETTINGS.min5mChgPct),
      max1mVolUsd: Number(row.max_1m_vol_usd ?? DEFAULT_SETTINGS.max1mVolUsd),
      maxBundlerPct: Number(row.max_bundler_pct ?? DEFAULT_SETTINGS.maxBundlerPct),
      maxTop10HolderPct: Number(row.max_top10_holder_pct ?? DEFAULT_SETTINGS.maxTop10HolderPct),
      maxSniperPct: Number(row.max_sniper_pct ?? DEFAULT_SETTINGS.maxSniperPct),
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
          (chat_id, min_liquidity_usd, min_volume_24h_usd, max_age_minutes,
           min_market_cap_usd, min_age_minutes, min_5m_vol_usd, min_5m_chg_pct,
           max_1m_vol_usd, max_bundler_pct, max_top10_holder_pct, max_sniper_pct, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          min_liquidity_usd = excluded.min_liquidity_usd,
          min_volume_24h_usd = excluded.min_volume_24h_usd,
          max_age_minutes = excluded.max_age_minutes,
          min_market_cap_usd = excluded.min_market_cap_usd,
          min_age_minutes = excluded.min_age_minutes,
          min_5m_vol_usd = excluded.min_5m_vol_usd,
          min_5m_chg_pct = excluded.min_5m_chg_pct,
          max_1m_vol_usd = excluded.max_1m_vol_usd,
          max_bundler_pct = excluded.max_bundler_pct,
          max_top10_holder_pct = excluded.max_top10_holder_pct,
          max_sniper_pct = excluded.max_sniper_pct,
          enabled = excluded.enabled
      `,
      args: [
        settings.chatId,
        settings.minLiquidityUsd,
        settings.minVolume24hUsd,
        settings.maxAgeMinutes,
        settings.minMarketCapUsd,
        settings.minAgeMinutes,
        settings.min5mVolUsd,
        settings.min5mChgPct,
        settings.max1mVolUsd,
        settings.maxBundlerPct,
        settings.maxTop10HolderPct,
        settings.maxSniperPct,
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

  async isTokenSeen(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "SELECT 1 AS seen FROM seen_tokens WHERE chat_id = ? AND token = ? LIMIT 1",
      args: [chatId, token],
    });
    return res.rows.length > 0;
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

  async markTokenSeen(chatId: string, token: string): Promise<void> {
    await this.get().execute({
      sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
      args: [chatId, token, Date.now()],
    });
  }

  async getTokenStats(token: string): Promise<TokenStats | null> {
    const res = await this.get().execute({
      sql: "SELECT * FROM token_stats WHERE token = ?",
      args: [token],
    });
    const row = res.rows[0];
    if (!row) return null;
    const birdeye = row.birdeye_1m_vol;
    const rugcheck = row.rugcheck_bundler_pct;
    const top10 = row.rugcheck_top10_pct;
    const proTraders = row.birdeye_pro_traders;
    const sniperPct = row.birdeye_sniper_pct;
    const minMcap = row.min_mcap_observed;
    return {
      token: String(row.token),
      firstSeenAt: Number(row.first_seen_at),
      firstM5Vol: Number(row.first_m5_vol),
      firstSeenAgeMin: Number(row.first_seen_age_min),
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
    };
  }

  async recordTokenStats(stats: TokenStats): Promise<void> {
    await this.get().execute({
      sql: "INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [stats.token, stats.firstSeenAt, stats.firstM5Vol, stats.firstSeenAgeMin, stats.birdeye1mVol, stats.rugcheckBundlerPct, stats.rugcheckTop10Pct, stats.birdeyeProTraders, stats.birdeyeSniperPct, stats.minMcapObserved],
    });
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
}
