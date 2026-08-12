export interface SupplyFlowConfig {
  /** Whether the on-chain supply-flow (rug/distribution) detector is active. */
  enabled: boolean;
  /** Distinct top-holder wallets that must feed the same collector to flag. */
  minFeeders: number;
  /** % of total supply that must accumulate at the collector in the window. */
  minFedPct: number;
  /** Collector outbound transfers in the window to count as "selling". */
  minSells: number;
  /** How far back to analyze each coin's transfers. */
  windowMs: number;
  /** Re-run the analysis this often per coin (results are cached in Turso). */
  refreshMs: number;
  /** How many of the largest holder accounts to inspect. */
  topAccounts: number;
  /** Wall-clock budget for one coin's analysis (deferred to next tick when exceeded). */
  budgetMs: number;
}

export interface AppConfig {
  /** Telegram bot token from @BotFather. Bot won't start without it. */
  telegramBotToken?: string;
  /** Turso database URL (libSQL). Persistence disabled without it. */
  tursoUrl?: string;
  /** Turso auth token (required for hosted Turso). */
  tursoAuthToken?: string;
  /** Birdeye API key for trader/sniper insights (optional). */
  birdeyeApiKey?: string;
  /** Helius RPC API key for on-chain first-minute volume (optional; without it the public Solana RPC is used). */
  heliusApiKey?: string;
  /** How often the scanner runs, in seconds (SCAN_INTERVAL_SECONDS, else SCAN_INTERVAL_MINUTES×60). */
  scanIntervalSeconds: number;
  /** Port the /health HTTP server binds to (Freebuff injects PORT). */
  port: number;
  /** How many of the newest token profiles to inspect per scan. */
  scanProfileLimit: number;
  /** Minimum spacing between DexScreener HTTP requests (rate limiting). */
  dexRequestIntervalMs: number;
  /** Minimum spacing between Birdeye HTTP requests (rate limiting). */
  birdeyeRequestIntervalMs: number;
  /** Minimum spacing between RugCheck HTTP requests (rate limiting). */
  rugcheckRequestIntervalMs: number;
  /** Minimum spacing between Solana RPC requests (rate limiting). */
  heliusRequestIntervalMs: number;
  /** On-chain supply-flow (rug/distribution) detector tuning. */
  supplyFlow: SupplyFlowConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawInterval = Number(
    env.SCAN_INTERVAL_SECONDS ?? Number(env.SCAN_INTERVAL_MINUTES ?? 5) * 60,
  );
  const rawPort = Number(env.PORT ?? 3000);
  const rawLimit = Number(env.SCAN_PROFILE_LIMIT ?? 40);
  const rawDexInterval = Number(env.DEX_REQUEST_INTERVAL_MS ?? 350);

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    tursoUrl: env.TURSO_DATABASE_URL || undefined,
    tursoAuthToken: env.TURSO_AUTH_TOKEN || undefined,
    birdeyeApiKey: env.BIRDEYE_API_KEY || undefined,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    scanIntervalSeconds:
      Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 300,
    port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000,
    scanProfileLimit:
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 40,
    dexRequestIntervalMs:
      Number.isFinite(rawDexInterval) && rawDexInterval >= 0 ? rawDexInterval : 350,
    birdeyeRequestIntervalMs: Number.isFinite(Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      ? Math.max(0, Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      : 1100,
    rugcheckRequestIntervalMs: Number.isFinite(Number(env.RUGCHECK_REQUEST_INTERVAL_MS ?? 800))
      ? Math.max(0, Number(env.RUGCHECK_REQUEST_INTERVAL_MS ?? 800))
      : 800,
    // 100ms (was 300ms) so a hot coin's opening-minute enumeration (~150 txs)
    // fits inside Cloudflare's 30s wall-clock limit; the keyed Helius
    // endpoint handles 10 req/s comfortably. Public-RPC fallback relies on
    // the circuit breaker instead.
    heliusRequestIntervalMs: Number.isFinite(Number(env.HELIUS_REQUEST_INTERVAL_MS ?? 100))
      ? Math.max(0, Number(env.HELIUS_REQUEST_INTERVAL_MS ?? 100))
      : 100,
    supplyFlow: {
      enabled: (env.SUPPLY_FLOW_ENABLED ?? "true") !== "false",
      minFeeders: Number(env.SUPPLY_FLOW_MIN_FEEDERS ?? 3),
      minFedPct: Number(env.SUPPLY_FLOW_MIN_FED_PCT ?? 1),
      minSells: Number(env.SUPPLY_FLOW_MIN_SELLS ?? 3),
      windowMs: Number(env.SUPPLY_FLOW_WINDOW_HOURS ?? 12) * 3600_000,
      refreshMs: Number(env.SUPPLY_FLOW_REFRESH_MIN ?? 30) * 60_000,
      topAccounts: Number(env.SUPPLY_FLOW_TOP_ACCOUNTS ?? 8),
      budgetMs: Number(env.SUPPLY_FLOW_BUDGET_MS ?? 10_000),
    },
  };
}
