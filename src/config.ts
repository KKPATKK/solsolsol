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
  /**
   * Also analyze each top account's INBOUND transfers (who fed them), so
   * distributed feeders that are not themselves top holders still surface
   * when they converge on one collector wallet. Doubles the gTFA calls per
   * coin; disable when the credit budget is tight.
   */
  checkInflow: boolean;
  /** Wall-clock budget for one coin's analysis (deferred to next tick when exceeded). */
  budgetMs: number;
}

/**
 * Parse BOT_ADMIN_IDS (comma-separated Telegram user IDs) into a number
 * list, dropping empty/garbage entries (pure — unit-tested). Empty string
 * or missing → [] (no admins: /setmode stays locked).
 */
export function parseAdminIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Whether a Telegram user may run money-affecting commands (pure —
 * unit-tested). When no admins are configured every call is denied
 * (fail-closed: /setmode and the buy button stay locked).
 */
export function isAdmin(userId: number | undefined, adminIds: number[]): boolean {
  return userId !== undefined && adminIds.includes(userId);
}

export interface TradeConfigSettings {
  /**
   * Base58 private key of the dedicated trading wallet (secret, from
   * BOT_WALLET_PRIVATE_KEY). Without it trading is disabled regardless of
   * mode. Use a NEW wallet funded with a small amount of SOL — never the
   * main wallet.
   */
  walletSecret?: string;
  /**
   * off = trading disabled (default). manual = the push card gets a
   * "🛒 買入" button that executes one buy when tapped. auto = buy
   * immediately after a qualifying coin is pushed. Never real-money until
   * the user explicitly sets this.
   */
  mode: "off" | "manual" | "auto";
  /** SOL amount per buy (input side of the swap) — fixed-size fallback. */
  amountSol: number;
  /** Buy with this % of the CURRENT wallet balance (0 = use amountSol). */
  buyBalancePct: number;
  /** Slippage tolerance in percent (memecoins move fast — default 25). */
  slippagePct: number;
  /** Priority fee in SOL per buy. */
  priorityFeeSol: number;
  /** Max buys per rolling 24h window (daily budget guard). */
  maxDailyBuys: number;
  /** Hard timeout for each quote/swap/RPC call (ms). */
  timeoutMs: number;
  /** Jupiter Swap API base (quotes + swap-tx building). */
  jupiterApiBase: string;
  /** Optional Jupiter API key (x-api-key header, unlocks higher rate limits). */
  jupiterApiKey?: string;
  /** RPC used to send the signed swap (defaults to Helius when keyed). */
  rpcUrl?: string;
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
  /**
   * Re-evaluation pool cap: how many never-pushed tokens nearing/inside the
   * qualifying age window to keep tracking (RE_EVAL_POOL_SIZE). Pool rows
   * are ordered by distance to the window entry, so the most relevant coins
   * are always evaluated first; anything not processed within the tick's
   * deadline stays in the pool and is retried next tick (nothing is lost).
   */
  reevalPoolSize: number;
  /**
   * How many newest pump.fun coins to register per scan (PUMPFUN_PROFILE_LIMIT).
   * DexScreener's token-profiles feed only returns ~24 Solana profiles per
   * scan, so pump.fun discovery is the widest free source of brand-new
   * coins — coins without a DexScreener pair yet are registered into the
   * re-eval pool and evaluated the moment their pair appears. Best-effort:
   * if pump.fun blocks the caller (datacenter IPs), discovery returns empty
   * and the scanner continues on DexScreener alone.
   */
  pumpfunProfileLimit: number;
  /** Minimum spacing between pump.fun HTTP requests (rate limiting). */
  pumpfunRequestIntervalMs: number;
  /**
   * How many newest GeckoTerminal Solana pools to register per scan
   * (GECKOTERMINAL_POOL_PAGES, default 1, max 5 — each page ~20 pools). Free
   * discovery feed (no key) covering every Solana DEX incl. pump.fun
   * graduates, the zero-CU replacement for Birdeye new_listing.
   */
  geckoterminalPoolPages: number;
  /** Minimum spacing between GeckoTerminal HTTP requests (rate limiting). */
  geckoterminalRequestIntervalMs: number;
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
  /** Jupiter direct trading settings (off by default — see TradeConfigSettings). */
  trade: TradeConfigSettings;
  /**
   * Telegram user IDs allowed to run /setmode (and tap the buy button when
   * non-empty). Money-affecting commands are denied when this is empty.
   */
  adminIds: number[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawInterval = Number(
    env.SCAN_INTERVAL_SECONDS ?? Number(env.SCAN_INTERVAL_MINUTES ?? 5) * 60,
  );
  const rawPort = Number(env.PORT ?? 3000);
  const rawLimit = Number(env.SCAN_PROFILE_LIMIT ?? 40);
  const rawReevalPool = Number(env.RE_EVAL_POOL_SIZE ?? 40);
  const rawPumpfunLimit = Number(env.PUMPFUN_PROFILE_LIMIT ?? 100);
  const rawGeoPages = Number(env.GECKOTERMINAL_POOL_PAGES ?? 1);
  const rawDexInterval = Number(env.DEX_REQUEST_INTERVAL_MS ?? 350);
  const rawTradeMode = (env.TRADE_MODE ?? "off").toLowerCase();
  const tradeAmount = Number(env.TRADE_AMOUNT_SOL ?? 0.1);
  const tradeBuyPct = Number(env.TRADE_BUY_BALANCE_PCT ?? 80);
  const tradeSlippage = Number(env.TRADE_SLIPPAGE_PCT ?? 25);
  const tradeFee = Number(env.TRADE_PRIORITY_FEE_SOL ?? 0.001);
  const tradeMaxBuys = Number(env.TRADE_MAX_DAILY_BUYS ?? 5);
  const tradeTimeout = Number(env.TRADE_TIMEOUT_MS ?? 15_000);

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
    reevalPoolSize:
      Number.isFinite(rawReevalPool) && rawReevalPool > 0
        ? Math.min(Math.floor(rawReevalPool), 300)
        : 40,
    pumpfunProfileLimit:
      Number.isFinite(rawPumpfunLimit) && rawPumpfunLimit > 0
        ? Math.min(Math.floor(rawPumpfunLimit), 300)
        : 100,
    pumpfunRequestIntervalMs: Number.isFinite(
      Number(env.PUMPFUN_REQUEST_INTERVAL_MS ?? 350),
    )
      ? Math.max(0, Number(env.PUMPFUN_REQUEST_INTERVAL_MS ?? 350))
      : 350,
    geckoterminalPoolPages:
      Number.isFinite(rawGeoPages) && rawGeoPages > 0
        ? Math.min(Math.floor(rawGeoPages), 5)
        : 1,
    geckoterminalRequestIntervalMs: Number.isFinite(
      Number(env.GECKOTERMINAL_REQUEST_INTERVAL_MS ?? 1000),
    )
      ? Math.max(0, Number(env.GECKOTERMINAL_REQUEST_INTERVAL_MS ?? 1000))
      : 1000,
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
      topAccounts: Number(env.SUPPLY_FLOW_TOP_ACCOUNTS ?? 10),
      checkInflow: (env.SUPPLY_FLOW_CHECK_INFLOW ?? "true") !== "false",
      budgetMs: Number(env.SUPPLY_FLOW_BUDGET_MS ?? 15_000),
    },
    trade: {
      walletSecret: env.BOT_WALLET_PRIVATE_KEY || undefined,
      mode:
        rawTradeMode === "auto"
          ? "auto"
          : rawTradeMode === "manual"
            ? "manual"
            : "off",
      amountSol:
        Number.isFinite(tradeAmount) && tradeAmount > 0 ? tradeAmount : 0.1,
      buyBalancePct:
        Number.isFinite(tradeBuyPct) && tradeBuyPct > 0 && tradeBuyPct <= 100
          ? tradeBuyPct
          : 0,
      slippagePct:
        Number.isFinite(tradeSlippage) && tradeSlippage >= 0
          ? tradeSlippage
          : 25,
      priorityFeeSol:
        Number.isFinite(tradeFee) && tradeFee >= 0 ? tradeFee : 0.001,
      maxDailyBuys:
        Number.isFinite(tradeMaxBuys) && tradeMaxBuys >= 0
          ? Math.floor(tradeMaxBuys)
          : 5,
      timeoutMs:
        Number.isFinite(tradeTimeout) && tradeTimeout > 0 ? tradeTimeout : 15_000,
      jupiterApiBase: env.JUPITER_API_BASE || "https://api.jup.ag",
      jupiterApiKey: env.JUPITER_API_KEY || undefined,
      rpcUrl: env.HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
        : undefined,
    },
    adminIds: parseAdminIds(env.BOT_ADMIN_IDS),
  };
}
