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
 * Parse PUSH_WATCH_MUTE (comma-separated tracker card sigs to silence) into a
 * lower-cased, deduped list (pure — unit-tested). Empty/missing → [] (nothing
 * muted). The sigs are the delivery audit's own: `liqwarn` = the ⚠️ 流動性跌穿
 * 地板 warning, `drain` = the 💧 流動性枯竭 terminal card, `recap` = the 🏁
 * 結案報告 window summary, `hold` = the 📈 持倉增長 card, `div` = the ⚡
 * 籌碼集中 card, `sell` = the 🩸 賣壓主導 distribution card, and `w35`/`w45` =
 * the two DEPTH STAGES of the ⚠️ 動能轉弱 card (the rule fires it with
 * `weakMark`, so the audit sig is `w45` at ≤ -45% off the peak and `w35`
 * above it — muting one stage leaves the other visible, so both must be
 * listed), `pullback` = the 🪝 回調轉強 entry re-card (its once-per-
 * episode `pb` mark and 10-minute pace clock still land — see
 * PULLBACK_PACE_MS), and `strongbuy` = the 💪 強烈買入訊號 second-revival card
 * (its `revives_since_up` count and its episode reset still land — see
 * STRONG_BUY_REVIVES). An unknown sig is INERT — it matches no card — so a typo
 * can only leave a card visible, never silence the wrong one.
 */
export function parseMutedCardSigs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
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
   * CoinGecko / GeckoTerminal API key (COINGECKO_API_KEY, a SECRET — set it
   * in the Cloudflare dashboard or the workspace Keys UI, never in
   * wrangler.toml). The free feeds are metered on the CALLER'S IP and
   * Cloudflare Worker egress is a small shared pool, so that quota is spent
   * by other Workers before this one asks — the sustained `geo 0` 429s. A key
   * moves the meter onto the key, which is the only way off the shared-IP
   * limit. Optional: unkeyed, the gecko client still discovers through the
   * free path plus its alternate-host fallback.
   */
  coingeckoApiKey?: string;
  /**
   * Which CoinGecko plan `coingeckoApiKey` belongs to (COINGECKO_API_PLAN,
   * "demo" by default, "pro" for a paid key). It selects the header name
   * (`x-cg-demo-api-key` / `x-cg-pro-api-key`) AND the alternate-host mirror
   * that header is valid on (see geckoAltBaseUrl) — the two must agree, so a
   * key whose plan is entered wrong is refused everywhere.
   */
  coingeckoApiPlan: "demo" | "pro";
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
   * DexScreener boosted-token feed size per scan (DEXSCREENER_BOOSTS_LIMIT,
   * max 30, default 0 = disabled). Paid-promotion slots: fresh mints that
   * bought a DexScreener boost, which is the one discovery list that is both
   * keyless and disjoint from /token-profiles/latest/v1 (measured 2026-09-25:
   * 19 Solana rows, ZERO overlap with the 16 the profiles feed returned in the
   * same minute, same host so no new rate-limit bucket). Rows carry no metrics
   * and no timestamps — the age comes from the pair the next batch fetches.
   *
   * 2026-09-28: production runs the upstream's own ceiling
   * (DEXSCREENER_BOOSTS_LIMIT = "30" in wrangler.toml), and the measurement
   * that came with it is a NEGATIVE result worth keeping: this was raised from
   * 20 expecting +10 rows and the leg still reads 17. /token-boosts/latest/v1
   * answers 30 rows ACROSS CHAINS and the client filters to solana BEFORE it
   * slices, so the Solana subset — the only rows this feed can ever return —
   * was already under 20. The dial stays at the clamp because it costs the same
   * single request either way, but a future reader should not expect a gain
   * from it: the binding constraint here is how many Solana boosts exist, not
   * the number asked for. The clamp below (30) IS the upstream's row ceiling: a
   * bigger number is a typo, not a request for more.
   */
  dexscreenerBoostsLimit: number;
  /**
   * Minimum spacing between DexScreener boosts-lane FETCHES, in ms
   * (DEXSCREENER_BOOSTS_INTERVAL_SECONDS, default 300 = one fetch per 5 min;
   * 0 = no gate, i.e. one per tick — the pre-gate behaviour).
   *
   * WHY THE GATE EXISTS. The lane is the tick's SECOND request to
   * api.dexscreener.com, and that host's limiter is charged per SOURCE IP —
   * shared across the whole Worker fleet — so a per-tick boosts fetch is half
   * of this Worker's contribution to a bucket strangers spend anyway
   * (`pairCacheRefused`/`listCacheRefused` climb regardless of the spacing
   * this client chooses; measured 2026-09-25, docs/profiles-feed-zeros.md).
   * The lane's lifetime yield is a few dozen coins (`/debug/feed-stats`
   * boosts), so the request rate is the only honest dial left — the row size
   * already sits at the upstream's own ceiling and buys nothing (see
   * dexscreenerBoostsLimit).
   *
   * WHY THE GATE COSTS NOTHING IN COVERAGE. A boosted mint carries no metrics
   * and no timestamp (dexscreener.fetchBoostedTokens), so its age comes from
   * the pair — and the scanner only judges a coin once it ages into the 30h
   * qualifying window. A mint registered up to one interval late is therefore
   * judged on exactly the same ticks, which is the identical argument that let
   * gecko's keyed new-pools leg drop to one fetch per 5 minutes
   * (geckoterminalDiscoveryIntervalMs). Ticks the gate holds back are covered
   * by the always-on lanes: profiles stays per-tick, Jupiter recent/trending
   * are per-tick, and jupTrend is the momentum analogue this lane shares its
   * job with.
   *
   * The gate is DURABLE (Db.DEX_BOOSTS_AT_KEY), not per-isolate, for the reason
   * geckoterminalDiscoveryIntervalMs documents: isolates churn every ~30s, so a
   * per-isolate window would never elapse and the rate reduction would not
   * exist. It rides the scan front's single read + single write.
   *
   * HOW TO READ IT: on a tick the gate holds back, `summary.boosts` is 0 and
   * `summary.boostsDue` is false, and NO request is made (`dropsByLeg.boosts`
   * stays flat — a gated tick is not a dropped one). `boosts 0` with
   * `boostsDue true` is the other reading: a fetch that was allowed and came
   * back refused or empty. Comparing `/debug/dex429` before and after a change
   * to this value is the measurement that says whether it bought anything.
   */
  dexscreenerBoostsIntervalMs: number;
  /**
   * Re-evaluation pool cap: how many never-pushed tokens nearing/inside the
   * qualifying age window to keep tracking (RE_EVAL_POOL_SIZE). Pool rows
   * are ordered by distance to the window entry, so the most relevant coins
   * are always evaluated first; anything not processed within the tick's
   * deadline stays in the pool and is retried next tick (nothing is lost).
   *
   * The budget this number splits (see Db.getReevalPool) is hot + near + far,
   * and the HOT share is a hard requirement rather than a preference: the hot
   * band must fit UNDER its own LIMIT or its oldest eligible tier is clipped
   * on every scan (measured 2026-09-29: 82 of 268 eligible rows lost to a
   * 607-row band capped at 300, which is why the 1000 ceiling below is 1200 =
   * 460 hot + 490 near + 210 far plus the hot headroom).
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
   * pump.fun newest-coins count while GECKO DISCOVERY IS PAUSED
   * (PUMPFUN_FALLBACK_LIMIT, default 0 = off, capped at 300). GeckoTerminal and
   * pump.fun are the two keyless "brand-new coin" feeds; when gecko's new_pools
   * is paused (429 / refusal — the state since 2026-09-21, where `geo 0` leaves
   * the launch slot empty) this feed fills it. Zero while gecko is healthy, so
   * the steady state and its cost do not change. See pumpfunDiscoveryLimit.
   */
  pumpfunFallbackLimit: number;
  /**
   * Meteora Data API newest-pools count as the launch slot's LAST resort
   * (METEORA_FALLBACK_LIMIT, default 0 = off, capped at 300). Reached only when
   * gecko's new_pools AND pump.fun both delivered nothing on the same tick —
   * an independent provider, so a pump.fun block (which comes and goes for
   * datacenter IPs) cannot empty the slot on its own. One request when
   * reached; nothing while the layers ahead of it deliver. See src/meteora.ts.
   */
  meteoraFallbackLimit: number;
  /**
   * How many newest GeckoTerminal Solana pools to register per scan
   * (GECKOTERMINAL_POOL_PAGES, default 1, max 5 — each page ~20 pools). Free
   * discovery feed (no key) covering every Solana DEX incl. pump.fun
   * graduates, the zero-CU replacement for Birdeye new_listing.
   */
  geckoterminalPoolPages: number;
  /**
   * Minimum spacing between GeckoTerminal new-pools FETCHES, in ms
   * (GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS, default 300 = one fetch per
   * 5 min, 0 = no gate).
   *
   * WHY THE GATE EXISTS (2026-09-28): the new_pools leg used to be called on
   * every tick. That was free while the caller had no key — the shared Worker
   * egress IP was over GeckoTerminal's IP quota anyway, so an attempt bought
   * nothing and cost nothing. A key (COINGECKO_API_KEY) moves the limiter onto
   * the key instead, which is QUOTA-bound rather than rate-bound: the demo
   * plan is 10K calls/month, and one call per tick is ~43K/month, i.e. the key
   * would be burned in a week and then the leg would 429 again. One call per 5
   * minutes is 8,640/month, which fits — and the discovery loss is nil, because
   * a coin is only judged once it ages into the qualifying window (30h wide),
   * so a launch pool registered up to 5 minutes late is judged on exactly the
   * same tick. The in-between ticks are covered by pump.fun (always on) and
   * Meteora (see the launch-slot chain in src/scanner.ts).
   *
   * The gate is DURABLE (Db.GECKO_DISCOVERY_AT_KEY), not per-isolate, because
   * isolates churn every ~30s — a per-isolate window would never elapse and
   * the quota math above would not hold.
   */
  geckoterminalDiscoveryIntervalMs: number;
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
   * default 30, max 100, 0 = disabled). Seconds-old launchpad launches — the
   * free no-key replacement for the blocked pump.fun frontend-api feed.
   *
   * 2026-09-28: default 20 → 30, and the reason is that the 20 was FREE to
   * raise. /recent answers ≥30 rows in ONE request whatever limit is asked for
   * (measured 2026-08-21), and the client slices the parsed rows to this cap —
   * so the cap was deciding how many rows it already held got used, not how
   * much the upstream was asked for. Same one subrequest, same host: +10
   * seconds-old launches per tick. The cost side is Turso (every net-new coin
   * grows token_stats and with it the re-eval pool band scans), which is what
   * the rows-read quota and RE_EVAL_POOL_SIZE bound — so this is the number to
   * lower first if the pool ever outweighs the launches it finds.
   */
  jupiterRecentLimit: number;
  /**
   * Jupiter Token v2 trending feed size per scan (JUPITER_TRENDING_LIMIT,
   * default 100, max 100, 0 = disabled). 24h organic-score ranked coins — the
   * HEAD of that ranking is blue chips (measured 2026-09-21: 0 of the top 15
   * sat inside a $60K–$230K / 80min–26h window, 8 of the top 100 did), so the
   * leg reads a deep page and keeps only the band (see
   * jupfeeds.parseJupTrendTokens) — one subrequest either way, because the
   * filter runs before the pair phase.
   */
  jupiterTrendLimit: number;
  /** Minimum spacing between Jupiter HTTP requests (rate limiting). */
  jupiterRequestIntervalMs: number;
  /**
   * Post-push tracker (PUSH_WATCH_ENABLED, default true): every pushed coin
   * is watched for `windowHours` and refreshed from ONE DexScreener batch
   * call per tick; follow-up alerts report continuation (🚀 stages) or
   * breakdown (⚠️ weak / 💀 dead / 💧 liquidity). Birdeye holder growth
   * probes are CU-bounded by maxHolderChecksPerTick (0 = stage off).
   */
  pushWatch: {
    enabled: boolean;
    maxTracked: number;
    windowHours: number;
    cooldownMin: number;
    holdersRefreshMin: number;
    /**
     * Birdeye holder probes allowed per pass
     * (PUSH_WATCH_MAX_HOLDER_CHECKS, default 4, ceiling 10).
     *
     * `0` = the holder stage is OFF, and it is the only switch that stops the
     * SPEND rather than the card: the stage is gated by
     * `if (birdeye && cfg.maxHolderChecksPerTick > 0)`, so 0 removes the whole
     * block — no fetch, no `holder_probe_at` stamp read, no count written. Set
     * 2026-09-30 alongside muting 📈/⚡, whose probes were 193 of the month's
     * calls and 3_860 of its 8_060 CU. The Birdeye client stays wired for the
     * scanner's new-listing backfill.
     */
    maxHolderChecksPerTick: number;
    /**
     * How long ONE Birdeye holder probe may take, ms
     * (PUSH_WATCH_HOLDER_CAP_MS, default 2400). A probe is BILLED whether or
     * not its count lands, so this is the hit-rate dial: the endpoint measured
     * 1_008–2_525ms from the worker's own egress on 2026-09-23 (303–907ms two
     * days earlier), and a cap below that median pays for calls it then throws
     * away. Lower it only for latency, never for CU.
     */
    holderCapMs: number;
    /**
     * Minimum gap between holder probes, MINUTES
     * (PUSH_WATCH_HOLDER_MIN_GAP_MIN, default 60, 0 = off).
     *
     * The CU guard. `/defi/token_overview` is 20 CU and the free tier is
     * 30K CU/month — about 50 calls a DAY for the whole bot — while a probe
     * every pass (the 1-minute cron) would be 1_440 calls/day. 60 minutes =
     * 24 probes/day ≈ 480 CU/day ≈ 14.4K CU/month, which leaves the card path
     * and the periodic backfill inside the quota (see docs/round-trips.md
     * §4.4 for the table). Raise it only against a PAID plan: at 10 minutes the
     * stage alone is ~86K CU/month.
     */
    holderMinGapMin: number;
    /**
     * Tracker card types to SILENCE for now without stopping the tracker
     * (PUSH_WATCH_MUTE, a comma-separated list of card sigs; empty = nothing
     * muted): `liqwarn` ⚠️ 流動性跌穿地板, `drain` 💧 流動性枯竭, `recap` 🏁
     * 結案報告. A muted card is still DERIVED and its transition still LANDS —
     * a muted drain still terminalizes its row, a muted recap still closes the
     * window — so un-muting starts with the NEXT transition instead of
     * replaying a backlog, and muting can never stall the rotation (see
     * PushWatcher.isMuted). Reversible: delete a sig (or the whole variable)
     * and redeploy.
     */
    mutedSigs: string[];
  };
  /** Minimum spacing between DexScreener HTTP requests (rate limiting). */
  dexRequestIntervalMs: number;
  /** Minimum spacing between Birdeye HTTP requests (rate limiting). */
  birdeyeRequestIntervalMs: number;
  /**
   * Birdeye's CU allowance per calendar month (BIRDEYE_MONTHLY_CU_MAX,
   * default 30_000 = the free tier). Reporting only: /health's `birdeyeCu`
   * carries the measured month-to-date spend alongside this ceiling, so the
   * quota is observable instead of inferred from the push count. WHICH paid
   * calls to refuse once it runs out stays a separate, explicit decision —
   * dropping one changes what the card shows (docs/round-trips.md §4.4.2).
   */
  birdeyeMonthlyCuMax: number;
  /**
   * GMGN trending feed size per scan (GMGN_TRENDING_LIMIT, default 30,
   * 0 = discovery feed disabled). Candidates come momentum-ranked.
   */
  gmgnTrendingLimit: number;
  /** Master switch for ALL GMGN usage (feed + enrichment). When off, the
   * client is never constructed even if GMGN_API_KEY is set — mirrors
   * ARKHAM_ENABLED so a stale key can never burn requests against a
   * 429-blocking edge. */
  gmgnEnabled: boolean;
  /** Minimum spacing between GMGN HTTP requests (rate limiting). */
  gmgnRequestIntervalMs: number;
  /**
   * Block pushes for coins GMGN explicitly flags as wash trading
   * Reject pushes whose profiled top holders are overwhelmingly brand-new
   * wallets (insider/syndicate self-pump shape). Gate fires when
   * newWallets/checked > WALLET_NEW_RATIO_MAX and at least
   * WALLET_NEW_MIN_CHECKED wallets were profiled; 0 disables.
   */
  walletNewRatioMax: number;
  /** Minimum profiled top-holders before the new-wallet gate judges. */
  walletNewMinChecked: number;
  /**
   * Reject pushes whose top-10 holder concentration (LP-excluded, RugCheck)
   * is below TOP10_PCT_MIN — e.g. the MCGA shape (2.2%): float so dispersed
   * there is no committed holder base. 0 disables.
   */
  top10PctMin: number;
  /**
   * Reject pushes whose top-10 holder concentration (LP-excluded, RugCheck)
   * is above TOP10_PCT_MAX — e.g. a cartel holding >90% of supply: retail
   * only exists to provide exit liquidity. 0 disables.
   */
  top10PctMax: number;
  /**
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
   * Axiom bot-users push gate (AXIOM_MIN_BOT_USERS, default 90, 0 = off).
   * A candidate whose pair reports fewer distinct Axiom bot users than this
   * floor is rejected as a dead/shill pool — calibrated on live samples:
   * every coin the operator liked had 140+, junk sat below 90. One API call
   * per final candidate; missing data (session down, no pair address) never
   * judges so a dead session can't silence pushes.
   */
  axiomMinBotUsers: number;
  /**
   * External refresher mode (AXIOM_EXTERNAL_REFRESH, default off): when on,
   * the Worker stops refreshing the Axiom session itself — a scheduled
   * GitHub Action (scripts/axiom-refresh-action.py, curl_cffi Chrome TLS)
   * is the sole writer. Axiom rotates the refresh token on every call, so
   * two writers would invalidate each other's sessions.
   */
  axiomExternalRefresh: boolean;
  /**
   * Global Axiom kill switch (AXIOM_ENABLED, default on): 0 = the Worker never
   * builds the Axiom client at all. That removes every Axiom call in one move:
   * the trending feed, the per-candidate /token-info (which feeds BOTH the
   * card summary line and the axiomMinBotUsers gate — the gate is therefore
   * inert while this is off) and the session refresh/alert path. Cards fall
   * back to the legacy lines, exactly as they already did while the session
   * was down. Disabled 2026-09-19 after a session that could only be revived
   * by hand. See docs/axiom-refresher.md.
   */
  axiomEnabled: boolean;
  /**
   * Jupiter API base. Kept out of wrangler.toml [vars]: the Worker hit the
   * free tier's 64-variable cap (deploy ERROR 10055, 88 bound → 64 limit) and
   * this value had a code default anyway. The env override (if any) is honored
   * in config.trade.jupiterApiBase, and this top-level field is its read-only
   * alias so nothing in the app ever sees an empty string.
   */
  jupiterApiBase: string;
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
  /**
   * MIN market-cap/liquidity ratio for push candidates — the other side of
   * the band above, and the same number read the other way round: since
   *
   *     LP/mcap ≈ 2 × (tokens in the pool ÷ total supply)
   *
   * an mcap/LP BELOW this floor means the pool still holds more than a
   * QUARTER of the supply (LP/mcap above 0.5), i.e. much of the "market cap"
   * is tokens nobody has bought yet, sitting in a pool whose SOL side one or
   * two wallets can still take out.
   * MCAP_LIQ_RATIO_MIN = 2 is exactly the operator's "LP/mcap ≥ 0.50 blocks".
   * Calibrated 2026-09-28 on the push ring (see docs/suspicious-token-gates.md):
   * every push under 2.0x that later had its liquidity pulled is in this band
   * and no push above 2.9x was. 0 = disabled. */
  mcapLiqRatioMin: number;
  /**
   * Block pushes Jupiter has flagged as suspicious (audit.isSus on the token
   * payload the organic-score line already fetches). Presence-only: Jupiter
   * sets the field ONLY when it has flagged the token, so absent = "not
   * flagged", never "verified safe". Fail-open on a missing reading. See the
   * helper's calibration notes (JUP_SUS_BLOCK in wrangler.toml).
   */
  jupSusBlock: boolean;
  /**
   * Minimum Jupiter organic score (ORGANIC_MIN_SCORE, default 55, 0 = off).
   *
   * Jupiter's `organicScore` (0–100) separates real retail participation from
   * wash/coordinated volume, and it is FREE here: the reading is the very
   * response the card's 🌱 有機度 line already fetches (same request, no key,
   * no provider), so this gate adds no spend — see scanner.organicMinBlockReason.
   *
   * FAIL-OPEN on a missing reading, like every other gate: a token Jupiter
   * carries no score for (score absent — not a genuine 0) still pushes. The
   * slot is late-bound (dispatched with the display batch, read before the
   * send), so a reading that missed its deadline is "no data", not "low".
   *
   * OPERATOR CHOICE, not calibration: docs/suspicious-token-gates.md §5
   * measured score 0 at 5/5 drained in-window but deliberately declined to ship
   * a floor, because a low score can also mean a young token. 55 is the
   * operator's number (60 until 2026-10-01); watch fails.organic in
   * /health.heartbeat.summary before trusting it.
   */
  organicMinScore: number;
  /**
   * Maximum Jupiter 1h traders (ORGANIC_MAX_TRADERS_H1, default 1400, 0 = off).
   *
   * The 🌱 有機度 line's other half (`| 1h 交易者 243`) is the very same FREE
   * reading the score floor uses, so this ceiling costs no request, key or
   * provider either — see scanner.organicTradersBlockReason. It is an
   * ANTI-CROWDING ceiling rather than a quality floor: the operator wants the
   * coins nobody has piled into yet, so 1400 or more traders in the trailing
   * hour is left to run without a card (the boundary blocks — "少於 1400 才
   * 推送").
   *
   * FAIL-OPEN in every missing-reading shape ("沒有這項數據才推送"):
   * `tradersH1 === null` (Jupiter omitted the field), a NON-1h window (the
   * client falls back to the 6h then 24h count when the trailing hour has no
   * trades, and that fallback is not this ceiling's metric — the card still
   * PRINTS it, only the gate ignores it), and a reading that missed its
   * deadline (null).
   *
   * OPERATOR CHOICE, not calibration: watch fails.organic in
   * /health.heartbeat.summary before trusting the number.
   */
  organicMaxTradersH1: number;
  /** Crime-wallet blocklist (community list — see CrimeWalletClient). */
  crimeWallets: CrimeWalletsConfig;
  /** Pushed-coin wallet analysis (creator profile + holder ages + clustering). */
  walletAnalysis: WalletAnalysisConfig;
  /**
   * Flurry launch forensics (ported from github.com/NerdHerderDani/flurry,
   * Apache-2.0): deploy-slot bundle detection + one-hop funding lineage. Runs
   * as the LAST gate before each push — only coins that passed every other
   * gate — via Helius RPC (~5-12 calls/coin typical). Fail-open: non-pump
   * mints, RPC errors and budget exhaustion pass without blocking; verdicts
   * are cached per mint so re-sweeps cost 0 RPC. All Helius RPC, zero calls
   * to Birdeye/GeckoTerminal/DexScreener.
   */
  flurry: {
    /** Master switch (FLURRY_ENABLED, default true). */
    enabled: boolean;
    /**
     * Block pushes for bundled launches (FLURRY_BLOCK_BUNDLES, default
     * true); false = observe-only — the bundle flag is shown on the card
     * but never blocks.
     */
    blockBundles: boolean;
    /** Distinct wallets in the deploy slot required (FLURRY_MIN_WALLETS,
     * default 4 — the classic Jito-bundle shape). */
    minWallets: number;
    /** Supply % acquired in the deploy slot required (FLURRY_MIN_SUPPLY_PCT,
     * default 15). */
    minSupplyPct: number;
    /** Funding-lineage wallet cap (FLURRY_MAX_WALLETS, default 12 — 1 sig
     * call + up to 10 txs each, early-exit on the first inbound SOL). */
    maxWallets: number;
    /** Verdict cache TTL (FLURRY_CACHE_MS, default 30 min). */
    cacheMs: number;
    /** Hard per-coin budget (FLURRY_BUDGET_MS, default 15 s); exceeded →
     * fail-open. */
    budgetMs: number;
  };
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
  const rawGeoDiscoverySec = Number(
    env.GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS ?? 300,
  );
  const rawBoostsIntervalSec = Number(
    env.DEXSCREENER_BOOSTS_INTERVAL_SECONDS ?? 300,
  );
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
  const rawFlurryCacheMs = Number(env.FLURRY_CACHE_MS ?? 30 * 60_000);
  const rawFlurryBudgetMs = Number(env.FLURRY_BUDGET_MS ?? 15_000);

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    tursoUrl: env.TURSO_DATABASE_URL || undefined,
    tursoAuthToken: env.TURSO_AUTH_TOKEN || undefined,
    birdeyeApiKey: env.BIRDEYE_API_KEY || undefined,
    gmgnApiKey: env.GMGN_API_KEY || undefined,
    coingeckoApiKey: env.COINGECKO_API_KEY || undefined,
    coingeckoApiPlan:
      (env.COINGECKO_API_PLAN ?? "demo").toLowerCase() === "pro"
        ? "pro"
        : "demo",
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
      // 2026-09-28: clamp 100 → 200 (Workers Paid). Headroom, not a lever:
      // the DexScreener profiles page carries ~20–30 Solana rows per tick,
      // so neither cap binds. Coins-per-tick is bounded by the re-eval
      // rotation slice (scanner.RE_EVAL_PER_TICK_MAX) and its pair fetch.
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 40,
    // Off by default: the boosts leg is an OPTIONAL feed (it is dropped first
    // when the tick runs low on subrequests or on time), so enabling it is a
    // measurement, not a guess — wrangler.toml starts at "0".
    dexscreenerBoostsLimit: Number.isFinite(Number(env.DEXSCREENER_BOOSTS_LIMIT ?? 0))
      ? Math.max(0, Math.min(Math.floor(Number(env.DEXSCREENER_BOOSTS_LIMIT ?? 0)), 30))
      : 0,
    // Same discipline as geckoterminalDiscoveryIntervalMs below: "0" is the
    // documented no-gate value, and a JUNK value fails CLOSED to the 300s
    // default rather than open to a per-tick fetch — an unparseable knob must
    // not silently restore the request rate this gate exists to remove.
    dexscreenerBoostsIntervalMs:
      Number.isFinite(rawBoostsIntervalSec) && rawBoostsIntervalSec > 0
        ? Math.floor(rawBoostsIntervalSec) * 1000
        : env.DEXSCREENER_BOOSTS_INTERVAL_SECONDS === "0"
          ? 0
          : 300_000,
    // Ceiling 1200 (was 1000) since 2026-09-29: the hot band had outgrown its
    // 300-row LIMIT and was clipping its own eligible tier (see
    // POOL_HOT_ABOVE_MS in src/db.ts), so the hot budget went to 460 and the
    // pool to 460 + 490 + 210. The ceiling exists so a typo in
    // RE_EVAL_POOL_SIZE cannot turn the per-tick pool read into a full-table
    // read; raise it only with the band measurement in hand.
    reevalPoolSize:
      Number.isFinite(rawReevalPool) && rawReevalPool > 0
        ? Math.min(Math.floor(rawReevalPool), 1200)
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
    // 0 (and below) means OFF, which is what production sets: wrangler.toml's
    // comment reads `PUMPFUN_PROFILE_LIMIT = "0"` → "DISABLED". The guard here
    // used to be a bare `> 0 ? clamp : 100`, so an explicit 0 fell back to the
    // code default and the "disabled" feed ran at 100 coins — five paged
    // requests inside the feed window — on every tick. Found by the launch-slot
    // chain tests (2026-09-21): it is also why the gecko-fallback branch never
    // engaged in production (`pump 0`, no `pumpFallback`) and gecko's own
    // verdict was unused. A junk value is treated as OFF too (fail-closed for
    // cost); an UNSET variable keeps the historic 100 default.
    pumpfunProfileLimit:
      env.PUMPFUN_PROFILE_LIMIT === undefined
        ? 100
        : Number.isFinite(rawPumpfunLimit) && rawPumpfunLimit > 0
          ? Math.min(Math.floor(rawPumpfunLimit), 300)
          : 0,
    pumpfunRequestIntervalMs: Number.isFinite(
      Number(env.PUMPFUN_REQUEST_INTERVAL_MS ?? 350),
    )
      ? Math.max(0, Number(env.PUMPFUN_REQUEST_INTERVAL_MS ?? 350))
      : 350,
    pumpfunFallbackLimit: Number.isFinite(Number(env.PUMPFUN_FALLBACK_LIMIT ?? 0))
      ? Math.max(0, Math.min(Math.floor(Number(env.PUMPFUN_FALLBACK_LIMIT ?? 0)), 300))
      : 0,
    meteoraFallbackLimit: Number.isFinite(Number(env.METEORA_FALLBACK_LIMIT ?? 0))
      ? Math.max(0, Math.min(Math.floor(Number(env.METEORA_FALLBACK_LIMIT ?? 0)), 300))
      : 0,
    geckoterminalPoolPages:
      Number.isFinite(rawGeoPages) && rawGeoPages > 0
        ? Math.min(Math.floor(rawGeoPages), 2)
        : 1,
    // 0 = no gate (every tick). A junk value fails CLOSED to the 300s default
    // rather than open to every tick: an unparseable knob must not silently
    // become a 43K/month spend on somebody's key.
    geckoterminalDiscoveryIntervalMs:
      Number.isFinite(rawGeoDiscoverySec) && rawGeoDiscoverySec > 0
        ? Math.floor(rawGeoDiscoverySec) * 1000
        : env.GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS === "0"
          ? 0
          : 300_000,
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
    jupiterRecentLimit: Number.isFinite(Number(env.JUPITER_RECENT_LIMIT ?? 30))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_RECENT_LIMIT ?? 30)), 100))
      : 30,
    jupiterTrendLimit: Number.isFinite(Number(env.JUPITER_TRENDING_LIMIT ?? 100))
      ? Math.max(0, Math.min(Math.floor(Number(env.JUPITER_TRENDING_LIMIT ?? 100)), 100))
      : 100,
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
      holderCapMs: Number.isFinite(Number(env.PUSH_WATCH_HOLDER_CAP_MS ?? 2400))
        ? Math.max(500, Math.min(Math.floor(Number(env.PUSH_WATCH_HOLDER_CAP_MS ?? 2400)), 5000))
        : 2400,
      holderMinGapMin: Number.isFinite(Number(env.PUSH_WATCH_HOLDER_MIN_GAP_MIN ?? 60))
        ? Math.max(0, Math.min(Math.floor(Number(env.PUSH_WATCH_HOLDER_MIN_GAP_MIN ?? 60)), 1440))
        : 60,
      mutedSigs: parseMutedCardSigs(env.PUSH_WATCH_MUTE),
    },
    dexRequestIntervalMs:
      Number.isFinite(rawDexInterval) && rawDexInterval >= 0 ? rawDexInterval : 350,
    birdeyeRequestIntervalMs: Number.isFinite(Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      ? Math.max(0, Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))
      : 1100,
    birdeyeMonthlyCuMax: Number.isFinite(Number(env.BIRDEYE_MONTHLY_CU_MAX ?? 30000))
      ? Math.max(0, Math.floor(Number(env.BIRDEYE_MONTHLY_CU_MAX ?? 30000)))
      : 30000,
    gmgnTrendingLimit: Number.isFinite(Number(env.GMGN_TRENDING_LIMIT ?? 30))
      ? Math.max(0, Math.min(Math.floor(Number(env.GMGN_TRENDING_LIMIT ?? 30)), 100))
      : 30,
    gmgnEnabled:
      (env.GMGN_ENABLED ?? "true") !== "0" && (env.GMGN_ENABLED ?? "true") !== "false",
    gmgnRequestIntervalMs: Number.isFinite(Number(env.GMGN_REQUEST_INTERVAL_MS ?? 600))
      ? Math.max(0, Number(env.GMGN_REQUEST_INTERVAL_MS ?? 600))
      : 600,
    gmgnBlockWashTrading: (env.GMGN_BLOCK_WASH_TRADING ?? "true") !== "false",
    flurry: {
      enabled:
        (env.FLURRY_ENABLED ?? "true") !== "0" &&
        (env.FLURRY_ENABLED ?? "true") !== "false",
      blockBundles: (env.FLURRY_BLOCK_BUNDLES ?? "true") !== "false",
      minWallets: Number.isFinite(Number(env.FLURRY_MIN_WALLETS ?? 4))
        ? Math.max(2, Math.floor(Number(env.FLURRY_MIN_WALLETS ?? 4)))
        : 4,
      minSupplyPct: Number.isFinite(Number(env.FLURRY_MIN_SUPPLY_PCT ?? 15))
        ? Math.max(1, Math.min(Number(env.FLURRY_MIN_SUPPLY_PCT ?? 15), 100))
        : 15,
      maxWallets: Number.isFinite(Number(env.FLURRY_MAX_WALLETS ?? 12))
        ? Math.max(1, Math.min(Math.floor(Number(env.FLURRY_MAX_WALLETS ?? 12)), 50))
        : 12,
      cacheMs:
        Number.isFinite(rawFlurryCacheMs) && rawFlurryCacheMs > 0
          ? Math.min(3600_000, Math.max(60_000, rawFlurryCacheMs))
          : 30 * 60_000,
      budgetMs:
        Number.isFinite(rawFlurryBudgetMs) && rawFlurryBudgetMs > 0
          ? Math.min(26_000, Math.max(2_000, rawFlurryBudgetMs))
          : 15_000,
    },
    walletNewRatioMax: Number.isFinite(Number(env.WALLET_NEW_RATIO_MAX))
      ? Math.max(0, Math.min(Number(env.WALLET_NEW_RATIO_MAX), 1))
      : 0.8,
    walletNewMinChecked: Number.isFinite(Number(env.WALLET_NEW_MIN_CHECKED))
      ? Math.max(1, Math.floor(Number(env.WALLET_NEW_MIN_CHECKED)))
      : 5,
    top10PctMin: Number.isFinite(Number(env.TOP10_PCT_MIN))
      ? Math.max(0, Math.min(Number(env.TOP10_PCT_MIN), 100))
      : 10,
    top10PctMax: Number.isFinite(Number(env.TOP10_PCT_MAX))
      ? Math.max(0, Math.min(Number(env.TOP10_PCT_MAX), 100))
      : 90,
    axiomEmail: env.AXIOM_EMAIL || undefined,
    axiomPassword: env.AXIOM_PASSWORD || undefined,
    axiomTrendingLimit: Number.isFinite(Number(env.AXIOM_TRENDING_LIMIT ?? 20))
      ? Math.max(0, Math.min(Math.floor(Number(env.AXIOM_TRENDING_LIMIT ?? 20)), 100))
      : 20,
    axiomMinBotUsers: Number.isFinite(Number(env.AXIOM_MIN_BOT_USERS ?? 90))
      ? Math.max(0, Math.floor(Number(env.AXIOM_MIN_BOT_USERS ?? 90)))
      : 90,
    axiomExternalRefresh: (env.AXIOM_EXTERNAL_REFRESH ?? "0") === "1",
    axiomEnabled: (env.AXIOM_ENABLED ?? "1") !== "0",
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
    mcapLiqRatioMin: (() => {
      // Same stance as the ceiling: 0 disables, and anything unparseable
      // falls back to the shipped floor rather than to NaN (NaN would pass
      // every comparison and silently disable the gate).
      const v = Number(env.MCAP_LIQ_RATIO_MIN ?? 2);
      return Number.isFinite(v) && v > 0 ? v : 0;
    })(),
    jupSusBlock: (env.JUP_SUS_BLOCK ?? "true") !== "false",
    organicMinScore: (() => {
      // Same stance as the other floors: 0 disables, and anything unparseable
      // disables rather than becoming NaN (NaN would pass every comparison and
      // silently disarm the gate). Clamped to the score's own 0–100 scale so a
      // typo cannot turn the gate into a total block.
      const v = Number(env.ORGANIC_MIN_SCORE ?? 55);
      return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
    })(),
    organicMaxTradersH1: (() => {
      // Same stance as every other ceiling: 0 disables, and anything
      // unparseable disables rather than becoming NaN (NaN would pass every
      // comparison and silently disarm the gate). No upper clamp is needed —
      // a huge ceiling is simply one that never fires — and the value is the
      // operator's own number (1400), not a calibrated one.
      const v = Number(env.ORGANIC_MAX_TRADERS_H1 ?? 1400);
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
    /**
     * Top-level alias for config.trade.jupiterApiBase: kept in sync so the new
     * top-level field is never the empty string (the wrangler.toml JUPITER_API_BASE
     * var was removed to get under the Workers Free 64-variable cap).
     */
    jupiterApiBase: env.JUPITER_API_BASE || "https://api.jup.ag",
    adminIds: parseAdminIds(env.BOT_ADMIN_IDS),
  };
}
