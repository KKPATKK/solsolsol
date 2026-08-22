import { DEFAULT_CRIME_WALLETS_URL } from "./crimewallets";

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
 * Default Arkham entity types counted as "smart money" — funds, whales,
 * investors, professional traders and market makers. Deliberately excludes
 * neutral/infrastructure types (cex/dex/bridge/protocol/contract/miner): an
 * exchange hot wallet holding tokens is not an informed trader.
 */
const DEFAULT_SMART_MONEY_TYPES: ReadonlySet<string> = new Set([
  "fund",
  "hedgefund",
  "hedge_fund",
  "investor",
  "marketmaker",
  "market_maker",
  "trader",
  "vc",
  "venture",
  "whale",
]);

/**
 * Parse ARKHAM_SMART_MONEY_TYPES (comma-separated entity-type slugs) into a
 * lower-cased set (pure — unit-tested). Empty/missing → the default smart
 * money set; garbage entries are dropped.
 */
export function parseSmartMoneyTypes(raw: string | undefined): ReadonlySet<string> {
  if (!raw || !raw.trim()) return DEFAULT_SMART_MONEY_TYPES;
  const types = new Set<string>();
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (t) types.add(t);
  }
  return types.size > 0 ? types : DEFAULT_SMART_MONEY_TYPES;
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

export interface CrimeWalletsConfig {
  /**
   * Master switch (CRIME_WALLETS_ENABLED, default true). The client fetches
   * the community blocklist (one base58 address per line) and the scanner
   * checks each pushed coin's creator + top holder owners against it.
   * Free (no key) — unlike Arkham, no credits are burned by enabling it.
   */
  enabled: boolean;
  /**
   * Blocklist URL (CRIME_WALLETS_URL, default the solguala/crimewallets
   * `raw format.txt`). Any one-address-per-line file works.
   */
  url: string;
  /** Re-fetch cadence (CRIME_WALLETS_REFRESH_HOURS, default 6h). */
  refreshMs: number;
  /**
   * Block pushes whose creator (or top holder owner) is on the list
   * (CRIME_WALLETS_BLOCK, default false = display-only flag on the card).
   * Per the list's own README a match is a warning signal, not proof.
   */
  block: boolean;
  /**
   * Also check the top holder OWNER wallets (CRIME_WALLETS_CHECK_HOLDERS,
   * default true). Needs HELIUS_API_KEY (2 RPC calls per pushed coin —
   * getTokenLargestAccounts + getMultipleAccounts).
   */
  checkHolders: boolean;
  /** How many of the largest holder accounts to resolve owners for. */
  holderTopN: number;
  /** Fetch timeout (CRIME_WALLETS_FETCH_TIMEOUT_MS, default 8s). */
  timeoutMs: number;
}

export interface WalletAnalysisConfig {
  /**
   * Master switch (WALLET_ANALYSIS_ENABLED, default true). On every pushed
   * coin, analyze the wallets involved: creator profile (age + serial-
   * launcher create count), top-holder wallet ages, and cross-coin holder
   * clustering ("same wallets repeatedly appearing across pushed coins").
   * Reuses the crime check's resolved holders — no extra RPC for the
   * holder list itself; each unique wallet then costs ONE Helius call
   * (cached per wallet, so repeat coins/retries are free). All best-effort
   * with a hard budget — a slow RPC degrades the card, never the push.
   */
  enabled: boolean;
  /**
   * How many unique wallets to profile per coin (WALLET_ANALYSIS_MAX_WALLETS,
   * default 9 = creator + 8 top holders). Profiling is serialized through
   * the Helius throttle, so this bounds the per-coin RPC spend.
   */
  maxWallets: number;
  /** In-memory TTL for a wallet profile (WALLET_ANALYSIS_PROFILE_CACHE_MIN, default 60). */
  profileCacheMs: number;
  /**
   * Wall-clock budget for one coin's wallet profiling (WALLET_ANALYSIS_BUDGET_MS,
   * default 8s). On expiry the analysis returns partial data (truncated)
   * instead of blocking the push.
   */
  budgetMs: number;
  /**
   * Serial-launcher threshold: a creator with >= this many pump.fun
   * "create" signatures in its sampled window is flagged (WALLET_ANALYSIS_MIN_CREATES,
   * default 3).
   */
  creatorMinCreates: number;
  /**
   * A holder wallet whose first signature is younger than this is counted
   * as a "new wallet" (WALLET_ANALYSIS_NEW_AGE_HOURS, default 24).
   */
  newWalletAgeHours: number;
  /**
   * A wallet is reported as a cluster hit when it was a top holder of this
   * many distinct pushed coins (WALLET_ANALYSIS_CLUSTER_MIN_COINS, default
   * 2 — at the current push volume, one wallet topping 2+ separate coins
   * that passed every gate is already unusual).
   */
  clusterMinCoins: number;
  /**
   * How far back the cross-coin clustering window looks (WALLET_ANALYSIS_CLUSTER_WINDOW_DAYS,
   * default 14). Older pushed_holders rows are pruned.
   */
  clusterWindowDays: number;
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
  /** GMGN OpenAPI key for smart-money enrichment + trending feed (optional). */
  gmgnApiKey?: string;
  /**
   * Arkham Intelligence API key (ARKHAM_API_KEY, a SECRET — set in the
   * Cloudflare dashboard, never here). Enables smart-money attribution on
   * push cards: the top-100 holders are checked for entity types in
   * `arkhamSmartMoneyTypes` (fund/investor/whale/...). Display-only — no
   * blocking — since "who holds" is context, not a rug signal.
   */
  arkhamApiKey?: string;
  /**
   * Master switch (ARKHAM_ENABLED, default false). Arkham is DISABLED
   * unless this is "true"/"1" — even when ARKHAM_API_KEY is set, so a
   * stray key can never silently re-enable paid credit-burning calls.
   */
  arkhamEnabled: boolean;
  /**
   * Entity types counted as "smart money" (ARKHAM_SMART_MONEY_TYPES,
   * comma-separated; defaults to funds/whales/investors/traders/MMs).
   * Matched lower-case against Arkham's entity `type` slug.
   */
  arkhamSmartMoneyTypes: ReadonlySet<string>;
  /** Minimum spacing between Arkham HTTP requests (rate limiting). */
  arkhamRequestIntervalMs: number;
  /** Axiom Trade account email (login-based trending feed; optional). */
  axiomEmail?: string;
  /** Axiom Trade account password (login-based trending feed; optional). */
  axiomPassword?: string;
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
   * Re-evaluation pool rotation tiers (see Db.getReevalPool): everything
   * older than the hot zone (evaluated every scan) is swept in TWO tiers.
   * NEAR (first 6h inside the age window — the coins most likely to cross
   * the gates after entering) every REEVAL_NEAR_SWEEP_MIN (default 6 min);
   * FAR (the older tail) every REEVAL_FAR_SWEEP_MIN (default 18 min — every
   * coin is still re-checked at least once per sweep, but the old tail
   * stops consuming most of the budget). Slots = sweep minutes ÷ the pool
   * cache TTL (2 near + 6 far at the defaults). Rotation bands order by
   * the highest mcap ever observed, and coins repeatedly seen below half
   * the market-cap gate are dropped from the pool (pre-qualification
   * filter), so the sweep budget concentrates on realistic candidates.
   */
  reevalNearSlots: number;
  reevalFarSlots: number;
  /**
   * Re-eval pool query cache TTL in ms (REEVAL_POOL_CACHE_SECONDS, default
   * 180 = 3 min). The pool query is the scan's dominant Turso rows-read
   * consumer, so it is cached and re-run once per TTL per isolate; the same
   * value drives the rotation period (slots advance with each cache
   * expiry), so it must stay aligned with the sweep vars above. Lower TTL =
   * faster pickup of newly eligible coins + faster rotation, at
   * proportionally more pool-query rows-read (180s ≈ ×1.67 the old 300s
   * cadence — still a small share of the Turso free tier's 500M
   * rows-read/month).
   */
  reevalPoolCacheMs: number;
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
  /**
   * GeckoTerminal trending-pools feed size per scan (GECKOTERMINAL_TRENDING_LIMIT,
   * default 20, 0 = disabled). Momentum-ranked pools — the free no-key
   * replacement for GMGN's trending feed (which GMGN's edge blocks for
   * Cloudflare Worker egress).
   */
  geckoterminalTrendingLimit: number;
  /**
   * Jupiter Token v2 recent-launches feed size per scan (JUPITER_RECENT_LIMIT,
   * default 20, max 100, 0 = disabled). Seconds-old launchpad launches — the
   * free no-key replacement for the blocked pump.fun frontend-api feed.
   * Keep modest while Turso's rows-read quota recovers: every net-new coin
   * grows token_stats and with it the re-eval pool band scans.
   */
  jupiterRecentLimit: number;
  /**
   * Jupiter Token v2 trending feed size per scan (JUPITER_TRENDING_LIMIT,
   * default 15, max 100, 0 = disabled). Momentum-ranked coins over 24h —
   * mostly older than the qualifying window, kept for early catch of
   * resurging mints.
   */
  jupiterTrendLimit: number;
  /** Minimum spacing between Jupiter HTTP requests (rate limiting). */
  jupiterRequestIntervalMs: number;
  /**
   * Post-push tracker (PUSH_WATCH_ENABLED, default true): every pushed coin
   * is watched for `windowHours` and refreshed from ONE DexScreener batch
   * call per tick; follow-up alerts report continuation (🚀 stages) or
   * breakdown (⚠️ weak / 💀 dead / 💧 liquidity). Birdeye holder growth
   * probes are CU-bounded by maxHolderChecksPerTick.
   */
  pushWatch: {
    enabled: boolean;
    maxTracked: number;
    windowHours: number;
    cooldownMin: number;
    holdersRefreshMin: number;
    maxHolderChecksPerTick: number;
  };
  /** Minimum spacing between DexScreener HTTP requests (rate limiting). */
  dexRequestIntervalMs: number;
  /** Minimum spacing between Birdeye HTTP requests (rate limiting). */
  birdeyeRequestIntervalMs: number;
  /**
   * GMGN trending feed size per scan (GMGN_TRENDING_LIMIT, default 30,
   * 0 = discovery feed disabled). Candidates come momentum-ranked.
   */
  gmgnTrendingLimit: number;
  /** Minimum spacing between GMGN HTTP requests (rate limiting). */
  gmgnRequestIntervalMs: number;
  /**
   * Block pushes for coins GMGN explicitly flags as wash trading
   * (GMGN_BLOCK_WASH_TRADING, default true). Only applies when a GMGN key
   * is configured.
   */
  gmgnBlockWashTrading: boolean;
  /**
   * Axiom Trade trending feed size per scan (AXIOM_TRENDING_LIMIT, default
   * 20, 0 = discovery feed disabled). Axiom's trending rows carry
   * sniper/insider/bundle/top10-holder signals no other free feed has.
   * Requires AXIOM_EMAIL + AXIOM_PASSWORD secrets and a one-time OTP login
   * (see /debug/axiom-login).
   */
  axiomTrendingLimit: number;
  /**
   * Periodic Birdeye new_listing backfill (BIRDEYE_BACKFILL_ENABLED, default
   * true): every BIRDEYE_BACKFILL_INTERVAL_MIN the scanner walks back
   * BIRDEYE_BACKFILL_LOOKBACK_MIN of Birdeye's fresh-launch feed and seeds
   * any unseen coins into token_stats (INSERT OR IGNORE). Safety net for
   * discovery gaps (e.g. the monitor pause that lets GeckoTerminal's
   * newest-pools pages roll past coins). CU-bounded: 1 request per run ≈
   * ~80 CU, 4 runs/day ≈ ~320 CU/month against the 30K free tier.
   */
  birdeyeBackfillEnabled: boolean;
  birdeyeBackfillIntervalMs: number;
  birdeyeBackfillLookbackMs: number;
  /** Minimum spacing between RugCheck HTTP requests (rate limiting). */
  rugcheckRequestIntervalMs: number;
  /** Minimum spacing between Solana RPC requests (rate limiting). */
  heliusRequestIntervalMs: number;
  /** On-chain supply-flow (rug/distribution) detector tuning. */
  supplyFlow: SupplyFlowConfig;
  /** Max market-cap/liquidity ratio for push candidates. A valuation far
   * above pool depth (Nudaeng: $297K mcap on $16K LP = 18x) means the price
   * runs on a sliver of liquidity — trivially wickable, nearly un-exitable.
   * 0 = disabled. See MCAP_LIQ_RATIO_MAX in wrangler.toml. */
  mcapLiqRatioMax: number;
  /** Crime-wallet blocklist (community list — see CrimeWalletClient). */
  crimeWallets: CrimeWalletsConfig;
  /** Pushed-coin wallet analysis (creator profile + holder ages + clustering). */
  walletAnalysis: WalletAnalysisConfig;
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
  const rawPoolCacheSec = Number(env.REEVAL_POOL_CACHE_SECONDS ?? 180);
  const poolCacheMs =
    (Number.isFinite(rawPoolCacheSec) && rawPoolCacheSec > 0
      ? Math.min(600, Math.max(30, rawPoolCacheSec))
      : 180) * 1000;
  const rawNearSweepMin = Number(env.REEVAL_NEAR_SWEEP_MIN ?? 6);
  const rawFarSweepMin = Number(env.REEVAL_FAR_SWEEP_MIN ?? 18);
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
  const crimeRefreshHours = Number(env.CRIME_WALLETS_REFRESH_HOURS ?? 6);
  const crimeTimeout = Number(env.CRIME_WALLETS_FETCH_TIMEOUT_MS ?? 8000);
  const crimeHolderTopN = Number(env.CRIME_WALLETS_HOLDER_TOP_N ?? 8);
  const waMaxWallets = Number(env.WALLET_ANALYSIS_MAX_WALLETS ?? 9);
  const waProfileCacheMin = Number(env.WALLET_ANALYSIS_PROFILE_CACHE_MIN ?? 60);
  const waBudgetMs = Number(env.WALLET_ANALYSIS_BUDGET_MS ?? 8000);
  const waMinCreates = Number(env.WALLET_ANALYSIS_MIN_CREATES ?? 3);
  const waNewAgeHours = Number(env.WALLET_ANALYSIS_NEW_AGE_HOURS ?? 24);
  const waClusterMinCoins = Number(env.WALLET_ANALYSIS_CLUSTER_MIN_COINS ?? 2);
  const waClusterDays = Number(env.WALLET_ANALYSIS_CLUSTER_WINDOW_DAYS ?? 14);

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    tursoUrl: env.TURSO_DATABASE_URL || undefined,
    tursoAuthToken: env.TURSO_AUTH_TOKEN || undefined,
    birdeyeApiKey: env.BIRDEYE_API_KEY || undefined,
    gmgnApiKey: env.GMGN_API_KEY || undefined,
    arkhamApiKey: env.ARKHAM_API_KEY || undefined,
    arkhamEnabled: env.ARKHAM_ENABLED === "true" || env.ARKHAM_ENABLED === "1",
    arkhamSmartMoneyTypes: parseSmartMoneyTypes(env.ARKHAM_SMART_MONEY_TYPES),
    arkhamRequestIntervalMs: Number.isFinite(Number(env.ARKHAM_REQUEST_INTERVAL_MS ?? 300))
      ? Math.max(0, Number(env.ARKHAM_REQUEST_INTERVAL_MS ?? 300))
      : 300,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    scanIntervalSeconds:
      Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 300,
    port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000,
    scanProfileLimit:
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 40,
    reevalPoolSize:
      Number.isFinite(rawReevalPool) && rawReevalPool > 0
        ? Math.min(Math.floor(rawReevalPool), 1000)
        : 40,
    // Slots = sweep minutes ÷ the pool cache TTL (they must stay aligned so
    // every cache expiry advances to the next slot). Defaults at the 3-min
    // cache: near 6 min → 2 slots; far 18 min → 6 slots.
    reevalNearSlots:
      Number.isFinite(rawNearSweepMin) && rawNearSweepMin > 0
        ? Math.min(12, Math.max(1, Math.round(rawNearSweepMin / (poolCacheMs / 60_000))))
        : 2,
    reevalFarSlots:
      Number.isFinite(rawFarSweepMin) && rawFarSweepMin > 0
        ? Math.min(48, Math.max(2, Math.round(rawFarSweepMin / (poolCacheMs / 60_000))))
        : 6,
    reevalPoolCacheMs: poolCacheMs,
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
        ? Math.min(Math.floor(rawGeoPages), 2)
        : 1,
    geckoterminalRequestIntervalMs: Number.isFinite(
      Number(env.GECKOTERMINAL_REQUEST_INTERVAL_MS ?? 1000),
    )
      ? Math.max(0, Number(env.GECKOTERMINAL_REQUEST_INTERVAL_MS ?? 1000))
      : 1000,
    geckoterminalTrendingLimit: Number.isFinite(
      Number(env.GECKOTERMINAL_TRENDING_LIMIT ?? 20),
    )
      ? Math.max(0, Math.min(Math.floor(Number(env.GECKOTERMINAL_TRENDING_LIMIT ?? 20)), 20))
      : 20,
    jupiterRecentLimit: Number.isFinite(Number(env.JUPITER_RECENT_LIMIT ?? 20))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_RECENT_LIMIT ?? 20)), 100))
      : 20,
    jupiterTrendLimit: Number.isFinite(Number(env.JUPITER_TRENDING_LIMIT ?? 15))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_TRENDING_LIMIT ?? 15)), 100))
      : 15,
    jupiterRequestIntervalMs: Number.isFinite(
      Number(env.JUPITER_REQUEST_INTERVAL_MS ?? 1000),
    )
      ? Math.max(0, Number(env.JUPITER_REQUEST_INTERVAL_MS ?? 1000))
      : 1000,
    pushWatch: {
      enabled: (env.PUSH_WATCH_ENABLED ?? "true") !== "0" && (env.PUSH_WATCH_ENABLED ?? "true") !== "false",
      maxTracked: Number.isFinite(Number(env.PUSH_WATCH_MAX_TRACKED ?? 30))
        ? Math.max(1, Math.min(Math.floor(Number(env.PUSH_WATCH_MAX_TRACKED ?? 30)), 30))
        : 30,
      windowHours: Number.isFinite(Number(env.PUSH_WATCH_WINDOW_HOURS ?? 24))
        ? Math.max(1, Math.min(Math.floor(Number(env.PUSH_WATCH_WINDOW_HOURS ?? 24)), 72))
        : 24,
      cooldownMin: Number.isFinite(Number(env.PUSH_WATCH_COOLDOWN_MIN ?? 30))
        ? Math.max(5, Math.min(Math.floor(Number(env.PUSH_WATCH_COOLDOWN_MIN ?? 30)), 240))
        : 30,
      holdersRefreshMin: Number.isFinite(Number(env.PUSH_WATCH_HOLDERS_REFRESH_MIN ?? 30))
        ? Math.max(10, Math.min(Math.floor(Number(env.PUSH_WATCH_HOLDERS_REFRESH_MIN ?? 30)), 180))
        : 30,
      maxHolderChecksPerTick: Number.isFinite(Number(env.PUSH_WATCH_MAX_HOLDER_CHECKS ?? 4))
        ? Math.max(0, Math.min(Math.floor(Number(env.PUSH_WATCH_MAX_HOLDER_CHECKS ?? 4)), 10))
        : 4,
    },
    dexRequestIntervalMs:
      Number.isFinite(rawDexInterval) && rawDexInterval >= 0 ? rawDexInterval : 350,
    birdeyeRequestIntervalMs: Number.isFinite(Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      ? Math.max(0, Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      : 1100,
    gmgnTrendingLimit: Number.isFinite(Number(env.GMGN_TRENDING_LIMIT ?? 30))
      ? Math.max(0, Math.min(Math.floor(Number(env.GMGN_TRENDING_LIMIT ?? 30)), 100))
      : 30,
    gmgnRequestIntervalMs: Number.isFinite(Number(env.GMGN_REQUEST_INTERVAL_MS ?? 600))
      ? Math.max(0, Number(env.GMGN_REQUEST_INTERVAL_MS ?? 600))
      : 600,
    gmgnBlockWashTrading: (env.GMGN_BLOCK_WASH_TRADING ?? "true") !== "false",
    axiomEmail: env.AXIOM_EMAIL || undefined,
    axiomPassword: env.AXIOM_PASSWORD || undefined,
    axiomTrendingLimit: Number.isFinite(Number(env.AXIOM_TRENDING_LIMIT ?? 20))
      ? Math.max(0, Math.min(Math.floor(Number(env.AXIOM_TRENDING_LIMIT ?? 20)), 100))
      : 20,
    birdeyeBackfillEnabled: (env.BIRDEYE_BACKFILL_ENABLED ?? "true") !== "false",
    birdeyeBackfillIntervalMs:
      Number.isFinite(Number(env.BIRDEYE_BACKFILL_INTERVAL_MIN ?? 360)) &&
      Number(env.BIRDEYE_BACKFILL_INTERVAL_MIN ?? 360) > 0
        ? Number(env.BIRDEYE_BACKFILL_INTERVAL_MIN ?? 360) * 60_000
        : 360 * 60_000,
    birdeyeBackfillLookbackMs:
      Number.isFinite(Number(env.BIRDEYE_BACKFILL_LOOKBACK_MIN ?? 360)) &&
      Number(env.BIRDEYE_BACKFILL_LOOKBACK_MIN ?? 360) > 0
        ? Number(env.BIRDEYE_BACKFILL_LOOKBACK_MIN ?? 360) * 60_000
        : 360 * 60_000,
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
    mcapLiqRatioMax: (() => {
      // 0 disables; garbage/negative falls back to disabled rather than NaN
      // (NaN would silently pass every comparison).
      const v = Number(env.MCAP_LIQ_RATIO_MAX ?? 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    })(),
    crimeWallets: {
      enabled: (env.CRIME_WALLETS_ENABLED ?? "true") !== "false",
      url: env.CRIME_WALLETS_URL || DEFAULT_CRIME_WALLETS_URL,
      refreshMs:
        Number.isFinite(crimeRefreshHours) && crimeRefreshHours > 0
          ? crimeRefreshHours * 3600_000
          : 6 * 3600_000,
      block: (env.CRIME_WALLETS_BLOCK ?? "false") === "true" || (env.CRIME_WALLETS_BLOCK ?? "false") === "1",
      checkHolders: (env.CRIME_WALLETS_CHECK_HOLDERS ?? "true") !== "false",
      holderTopN:
        Number.isFinite(crimeHolderTopN) && crimeHolderTopN > 0
          ? Math.min(Math.floor(crimeHolderTopN), 20)
          : 8,
      timeoutMs:
        Number.isFinite(crimeTimeout) && crimeTimeout > 0 ? crimeTimeout : 8000,
    },
    walletAnalysis: {
      enabled: (env.WALLET_ANALYSIS_ENABLED ?? "true") !== "false",
      maxWallets:
        Number.isFinite(waMaxWallets) && waMaxWallets > 0
          ? Math.min(Math.floor(waMaxWallets), 20)
          : 9,
      profileCacheMs:
        Number.isFinite(waProfileCacheMin) && waProfileCacheMin > 0
          ? Math.min(waProfileCacheMin, 1440) * 60_000
          : 60 * 60_000,
      budgetMs:
        Number.isFinite(waBudgetMs) && waBudgetMs > 0
          ? Math.min(Math.floor(waBudgetMs), 30_000)
          : 8000,
      creatorMinCreates:
        Number.isFinite(waMinCreates) && waMinCreates > 0
          ? Math.min(Math.floor(waMinCreates), 100)
          : 3,
      newWalletAgeHours:
        Number.isFinite(waNewAgeHours) && waNewAgeHours > 0
          ? Math.min(waNewAgeHours, 720)
          : 24,
      clusterMinCoins:
        Number.isFinite(waClusterMinCoins) && waClusterMinCoins > 0
          ? Math.min(Math.floor(waClusterMinCoins), 100)
          : 2,
      clusterWindowDays:
        Number.isFinite(waClusterDays) && waClusterDays > 0
          ? Math.min(Math.floor(waClusterDays), 90)
          : 14,
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
