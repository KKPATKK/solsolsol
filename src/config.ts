export interface AppConfig {
  /** Telegram bot token from @BotFather. Bot won't start without it. */
  telegramBotToken?: string;
  /** Turso database URL (libSQL). Persistence disabled without it. */
  tursoUrl?: string;
  /** Turso auth token (required for hosted Turso). */
  tursoAuthToken?: string;
  /** Birdeye API key for exact minute-level volume (optional). */
  birdeyeApiKey?: string;
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
  };
}
