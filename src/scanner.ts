import type { Bot } from "grammy";
import { tradeKeyboard } from "./bot";
import type { BirdeyeClient } from "./birdeye";
import type { AppConfig } from "./config";
import type { Db, TokenStats } from "./db";
import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";
import { fmtUsd } from "./format";
import type { HeliusClient, SupplyFlowResult } from "./helius";
import type { RugcheckClient } from "./rugcheck";
import type { TradeService } from "./jupiter";
import type { PumpFunClient } from "./pumpfun";
import type { GeckoTerminalClient } from "./geckoterminal";
import type { GmgnClient, GmgnTokenInfo } from "./gmgn";
import type { AxiomClient, AxiomTrendingToken } from "./axiom";
import type { ArkhamClient, ArkhamTokenHolders } from "./arkham";
import type { CrimeWalletClient } from "./crimewallets";
import type { JupTokensClient } from "./jupfeeds";
import { renderMessage } from "./render";
import { WalletAnalyzer } from "./walletanalysis";


/** Re-fetch RugCheck reports older than this to pick up late bundler detection. */
const RUGCHECK_REFRESH_MS = 15 * 60_000;
/**
 * Min gap between Axiom refresh attempts. Refreshing mints a new access
 * token server-side; when Axiom's trending shards are genuinely down the
 * 5xx trigger would otherwise refresh once per scan (60s). A 5-min cooldown
 * bounds that to a handful of refreshes per outage.
 */
const AXIOM_REFRESH_COOLDOWN_MS = 5 * 60_000;
/**
 * After an on-chain (Helius) or Birdeye lookup comes back empty/failed, do
 * not re-query the same token for this long. Every RPC retry costs credits on
 * the Helius free tier, and empty results (data not indexed yet) are not
 * cached in the DB, so without this a waiting coin would hammer the endpoint
 * on every scan.
 */
const DATA_NEGATIVE_CACHE_MS = 5 * 60_000;
/**
 * Max wall-clock time for one scan pass. A hung/slow upstream call must not
 * wedge the scanner forever: the Worker isolate keeps module state between
 * ticks, so a scan that never resolves (e.g. killed by Cloudflare's ~30s
 * invocation limit mid-flight) would make every later tick skip and the bot
 * go silent. Released well before that wall-clock limit.
 */
const SCAN_TIMEOUT_MS = 25_000;
/**
 * Hard wall-clock deadline for one scan pass, enforced inside runOnce (well
 * before SCAN_TIMEOUT_MS releases the lock). Candidate processing is the
 * expensive part — the Helius opening-volume enumeration alone can burn up
 * to WINDOW_ENUM_BUDGET_MS (16s) per coin — so once the deadline is hit,
 * remaining candidates are deferred to the next tick (they stay in the
 * re-evaluation pool, nothing is lost). Keeps every tick comfortably inside
 * the worker's 26s heartbeat budget and Cloudflare's ~30s wall clock.
 */
const SCAN_TICK_DEADLINE_MS = 20_000;
/**
 * How long a first-seen token stays eligible for re-evaluation. Must cover
 * the qualifying age window (max 28h) plus a registration margin — the
 * operator runs 30h (28h + 2h slack): coins age into the window while
 * sitting in the pool, since the DexScreener profiles feed only ever
 * contains young tokens.
 */
const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;
/**
 * In-memory TTL for the re-eval pool query, from config.reevalPoolCacheMs
 * (REEVAL_POOL_CACHE_SECONDS, default 180 = 3 min). The pool only changes
 * when new coins are recorded, coins are pushed, or the age window slides —
 * nothing that happens between two 60s scans. The query is index-bounded
 * (see Db.getReevalPool: a launch_ms band scan over a few thousand rows
 * instead of the ~400K-row full scan it used to do — the dominant Turso
 * rows-read consumer, alerted 2026-08-16), so this cache cuts the remaining
 * cost to ~1/3 of a per-scan run at the default 3-min TTL. Stale coins are
 * harmless: the push path re-checks isTokenSeen from the DB before sending,
 * and newly discovered feed coins are evaluated via feedProfiles anyway. A
 * coin that ages into the window while the cache is live is pushed at the
 * next cache expiry, at most reevalPoolCacheMs later (the 3h
 * pre-qualification margin keeps most coins already pooled by then).
 */
/**
 * Margin (minutes) around the qualifying age window: the pool also holds
 * coins that will enter the window within 3h, so they are pushed the moment
 * they qualify instead of being picked up only after a later scan.
 */
const RE_EVAL_AGE_MARGIN_MIN = 180;

/** One qualifying coin, prepared for a specific chat. */
export interface QualifyingCoin {
  chatId: string;
  profile: TokenProfile;
  pair: PairInfo;
  stats: TokenStats;
}

/**
 * Why a single coin was rejected for one chat (surfaced via /health so the
 * operator can see exactly which filter blocked which coin). Only the coin's
 * first failing gate is recorded, and the list is bounded to keep the
 * heartbeat JSON small.
 */
export interface RejectionEntry {
  symbol: string;
  ageMin: number;
  mcapUsd: number;
  vol5Usd: number;
  chgPct: number;
  reason: string;
}

/** Rejection reasons from the last completed scan (surfaced via /health). */
export interface ScanSummary {
  profiles: number;
  /** pump.fun discovery feed size this scan (0 when blocked/unconfigured). */
  pump: number;
  /** GeckoTerminal new-pools feed size this scan (0 when blocked/unconfigured). */
  geo: number;
  /** GeckoTerminal trending-pools feed size this scan (momentum, 0 when disabled). */
  geoTrend: number;
  /** Jupiter recent-launchpad feed size this scan (0 when disabled/blocked). */
  jup: number;
  /** Jupiter trending feed size this scan (0 when disabled/blocked). */
  jupTrend: number;
  /** GMGN trending feed size this scan (0 when disabled/blocked). */
  gmgn: number;
  /** Axiom Trade trending feed size this scan (0 when disabled/not logged in). */
  axiom: number;
  /** Arkham smart-money enrichments this scan (0 when no key configured). */
  arkham: number;
  /** Coins whose creator/top-holder wallets matched the crime-wallet list. */
  crime: number;
  /** Coins that got a wallet analysis (creator/holder/cluster enrichment). */
  walletAnalysis: number;
  /** Birdeye periodic backfill: coins seeded into the re-eval pool this run. */
  backfill: number;
  pool: number;
  /** Evaluations that passed the age gate (age ≥ min) this scan — proves
   * in-window coins are actually being evaluated, not silently skipped. */
  agedEval: number;
  candidates: number;
  pushed: number;
  fails: {
    mcap: number;
    chg: number;
    vol5: number;
    age: number;
    /** Supply-flow (rug/distribution) pattern detected on-chain. */
    flow: number;
    /** Creator / top-holder wallet matched the crime-wallet blocklist. */
    crime: number;
    other: number;
  };
  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];
}

/** Cap on per-coin rejection entries kept in the scan summary/heartbeat. */
const REJECT_LOG_MAX = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalized description of a Telegram push failure (grammY ApiError or
 * network error) — code + description for the logs and worker_state, plus
 * whether a same-tick retry is worth it. Transient = 429 (rate limit),
 * 5xx, or a non-HTTP network error (no error_code); permanent 4xx (e.g.
 * 403 bot not a member / 400 bad chat) won't fix themselves within a
 * second, so those are surfaced but not retried in-tick — the chat-aware
 * re-eval pool still re-attempts them on later scans.
 */
interface PushErrorInfo {
  code: number | null;
  description: string;
  transient: boolean;
  line: string;
}

function describePushError(err: unknown): PushErrorInfo {
  const e = err as {
    error_code?: number;
    description?: string;
    message?: string;
  } | null;
  const code = typeof e?.error_code === "number" ? e.error_code : null;
  const description =
    e?.description ?? e?.message ?? (typeof err === "string" ? err : String(err));
  const transient = code === null || code === 429 || code >= 500;
  return {
    code,
    description,
    transient,
    line: code !== null ? `Telegram ${code}: ${description}` : description,
  };
}

export class Scanner {
  private running = false;
  /** When the current scan started — lets a stale lock be broken by age. */
  private runningSince = 0;
  /** Monotonic scan id: a timed-out scan must not clobber a newer scan's state. */
  private scanSeq = 0;
  /** Summary of the last completed scan, persisted into the heartbeat. */
  lastSummary: ScanSummary | null = null;
  /**
   * Why the last runOnce returned without a summary (early-return reason),
   * surfaced via /health so a silently-skipping scanner is diagnosable
   * without Cloudflare log access: "previous-scan-still-running",
   * "no-chats-enabled", "empty-feed-and-pool", or null after a real scan.
   */
  lastSkip: string | null = null;
  /** When each token's RugCheck report was last fetched (in-memory TTL). */
  private readonly rugcheckFetchedAt = new Map<string, number>();
  /** Creator wallet learned from RugCheck reports (static per token). */
  private readonly rugcheckCreator = new Map<string, string>();
  /**
   * When Helius/Birdeye last returned empty/failed for a token, so we can
   * skip re-querying it for a while (in-memory negative cache).
   */
  private readonly dataFailedAt = new Map<string, number>();
  /**
   * Whether the one-time launch_ms backfill migration is complete (see
   * Db.resumeLaunchBackfill). Cached so the per-tick resume call stops as
   * soon as the flag is set — no extra DB reads forever after.
   */
  private launchBackfillDone = false;

  constructor(
    private readonly db: Db,
    private readonly bot: Bot,
    private readonly dex: DexScreenerClient,
    private readonly config: AppConfig,
    private readonly birdeye: BirdeyeClient | null,
    private readonly rugcheck: RugcheckClient | null,
    private readonly helius: HeliusClient | null,
    /** Trojan trading (null = trading disabled — no key configured). */
    private readonly trade: TradeService | null = null,
    /**
     * pump.fun discovery (null = disabled) — widens coverage beyond the
     * DexScreener profiles feed, which only lists ~24 Solana coins per scan.
     * Best-effort: failures degrade to the DexScreener-only path.
     */
    private readonly pumpfun: PumpFunClient | null = null,
    /**
     * GeckoTerminal new-pools discovery (null = disabled) — free (no key),
     * datacenter-reachable, covers every Solana DEX incl. pump.fun graduates.
     * Best-effort: failures degrade to the other feeds.
     */
    private readonly gecko: GeckoTerminalClient | null = null,
    /**
     * Jupiter Token v2 discovery (null = disabled) — free no-key feed pair:
     * recent launchpad launches (the pump.fun frontend-api replacement) and
     * 24h trending. Best-effort: failures degrade to the other feeds.
     */
    private readonly jupiter: JupTokensClient | null = null,
    /**
     * GMGN OpenAPI (null = disabled — no key). Two uses: (a) candidate
     * enrichment — smart-money count, wash-trading flag and holders fetched
     * before each push and shown on the card (wash-trading optionally
     * blocks); (b) trending discovery feed (GMGN_TRENDING_LIMIT > 0).
     * Best-effort: failures degrade to the other feeds.
     */
    private readonly gmgn: GmgnClient | null = null,
    /**
     * Axiom Trade trending (null = disabled — no credentials). Momentum
     * feed with sniper/insider/bundle/top10-holder signals in the row data.
     * Login is interactive (OTP email) so the access token is persisted in
     * worker_state by the /debug/axiom-login endpoint; the scanner only
     * refreshes it when expired. Best-effort: failures degrade to the other
     * feeds.
     */
    private readonly axiom: AxiomClient | null = null,
    /**
     * Arkham Intelligence (null = disabled — no key). Card-only enrichment:
     * top-100 holder entity attribution → smart-money count + names shown on
     * the push card. Best-effort: failures degrade to no enrichment.
     */
    private readonly arkham: ArkhamClient | null = null,
    /**
     * Crime-wallet blocklist (null = disabled). Each pushed coin's creator
     * (RugCheck) and top holder owner wallets are checked against the list;
     * a hit is flagged on the card (and optionally blocks the push — see
     * CRIME_WALLETS_BLOCK). Best-effort: an unloaded list degrades to no
     * check, never a blocked scan.
     */
    private readonly crimeWallets: CrimeWalletClient | null = null,
    /**
     * Wallet analysis (null = disabled): creator profile (age + serial-
     * launcher create count), top-holder wallet ages, and cross-coin holder
     * clustering for each pushed coin. Reuses the crime check's resolved
     * holders (no extra RPC for the holder list); each unique wallet costs
     * one cached Helius call. Best-effort with a hard budget — a slow RPC
     * truncates the card enrichment, never the push.
     */
    private readonly walletAnalyzer: WalletAnalyzer | null = null,
  ) {}

  /** True while an on-chain/Birdeye retry for this token should be skipped. */
  private dataNegativeCached(token: string): boolean {
    const at = this.dataFailedAt.get(token);
    if (at === undefined) return false;
    if (Date.now() - at < DATA_NEGATIVE_CACHE_MS) return true;
    this.dataFailedAt.delete(token); // prune stale entries
    return false;
  }

  /**
   * Persist a per-chat push failure (worker_state `push_fail_<chatId>`,
   * JSON) so the operator can see exactly why a chat missed pushes without
   * Cloudflare log access — surfaced by /debug/chats. Keeps only the latest
   * failure plus a running count.
   */
  private async recordPushFailure(
    chatId: string,
    token: string,
    info: PushErrorInfo,
  ): Promise<void> {
    try {
      const key = `push_fail_${chatId}`;
      const raw = await this.db.getWorkerState(key);
      let count = 0;
      if (raw) {
        try {
          count = (JSON.parse(raw) as { count?: number }).count ?? 0;
        } catch {
          // corrupt state — start fresh
        }
      }
      await this.db.setWorkerState(
        key,
        JSON.stringify({
          at: Date.now(),
          code: info.code,
          description: info.description.slice(0, 200),
          token: token.slice(0, 12),
          count: count + 1,
        }),
      );
    } catch (err) {
      console.error(
        "[scanner] push-failure record failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Runs one full scan. Safe to call concurrently (overlapping runs are skipped). */
  async runOnce(): Promise<void> {
    if (this.running) {
      // A scan held longer than the budget is wedged: on Workers, the
      // watchdog timer below never fires while the isolate is frozen (it
      // freezes right after the response, before the timer queue runs), so a
      // scan that got frozen mid-await would otherwise block every later
      // tick forever. Break the lock by age so the next wake retries.
      const heldMs = Date.now() - this.runningSince;
      if (heldMs > SCAN_TIMEOUT_MS) {
        console.warn(
          `[scanner] releasing stale scan lock (held ${heldMs}ms) — retrying this tick`,
        );
        this.running = false;
      } else {
        console.log("[scanner] previous scan still running, skipping this tick");
        this.lastSkip = "previous-scan-still-running";
        return;
      }
    }
    const seq = ++this.scanSeq;
    this.running = true;
    this.runningSince = Date.now();
    const startedAt = Date.now();
    const tickDeadline = startedAt + SCAN_TICK_DEADLINE_MS;
    const diag: ScanSummary = {
      profiles: 0,
      pump: 0,
      geo: 0,
      geoTrend: 0,
      jup: 0,
      jupTrend: 0,
      gmgn: 0,
      axiom: 0,
      arkham: 0,
      crime: 0,
      walletAnalysis: 0,
      backfill: 0,
      pool: 0,
      agedEval: 0,
      candidates: 0,
      pushed: 0,
      fails: { mcap: 0, chg: 0, vol5: 0, age: 0, flow: 0, crime: 0, other: 0 },
      rejects: [],
    };
    // Watchdog: if the scan outlives its budget, release the lock so the next
    // tick can retry instead of the isolate wedging in a permanent skip loop.
    const watchdog = setTimeout(() => {
      if (seq === this.scanSeq) {
        console.error(
          `[scanner] scan exceeded ${SCAN_TIMEOUT_MS}ms — releasing lock; next tick will retry`,
        );
        this.running = false;
      }
    }, SCAN_TIMEOUT_MS);
    try {
      const chats = await this.db.listEnabledChats();
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }

      // Crime-wallet blocklist refresh (bounded by an in-memory TTL — a
      // no-op on most ticks; the first scan after a deploy fetches the
      // ~4.8K-address list once). Best-effort: a fetch failure keeps the
      // previous list and records lastError; the scan never waits more than
      // the client's fetch timeout on the very first load.
      if (this.crimeWallets) {
        try {
          await this.crimeWallets.refreshIfStale();
        } catch (err) {
          console.error(
            "[scanner] crime-wallet refresh failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // DexScreener profile feed. Same best-effort guard as pump.fun and
      // GeckoTerminal below: a rate-limited/5xx feed (shared worker egress
      // IPs get 429'd regularly) must degrade the scan to the re-eval pool
      // instead of aborting it — an unguarded throw here produced ~6s
      // all-zero scans (3 attempts × 2/4s backoff) that skipped the entire
      // pool evaluation (observed 2026-08-16).
      let profiles: TokenProfile[] = [];
      try {
        profiles = await this.dex.fetchLatestSolanaProfiles();
      } catch (err) {
        console.error(
          "[scanner] dexscreener profile feed failed:",
          err instanceof Error ? err.message : err,
        );
      }
      diag.profiles = profiles.length;
      // pump.fun discovery — the widest free source of brand-new coins
      // (DexScreener's profiles feed only returns ~24 Solana profiles per
      // scan). Best-effort: any failure returns [] and the scan continues
      // on DexScreener alone (see /health summary.pump to verify liveness).
      let pumpProfiles: TokenProfile[] = [];
      if (this.pumpfun) {
        try {
          pumpProfiles = await this.pumpfun.fetchNewestCoins(
            this.config.pumpfunProfileLimit,
          );
        } catch (err) {
          console.error(
            "[scanner] pump.fun discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.pump = pumpProfiles.length;
      // GeckoTerminal new-pools feed — the free (no-key) discovery source
      // covering every Solana DEX incl. pump.fun graduates, replacing the
      // CU-expensive Birdeye new_listing for live discovery. Pools are
      // registered by their pool_created_at (≈ graduation time, matching
      // how DexScreener pairs age coins), so they enter the re-eval pool
      // and are evaluated once they reach the qualifying age window.
      let geckoProfiles: TokenProfile[] = [];
      if (this.gecko) {
        try {
          const pools = [];
          for (
            let page = 1;
            page <= this.config.geckoterminalPoolPages;
            page++
          ) {
            const got = await this.gecko.fetchNewPools(page);
            pools.push(...got);
            if (got.length === 0) break;
          }
          geckoProfiles = pools
            .filter((p) => p.createdAtMs !== null)
            .map((p) => ({
              tokenAddress: p.tokenAddress,
              openTimestamp: p.createdAtMs ?? undefined,
            }));
        } catch (err) {
          console.error(
            "[scanner] geckoterminal discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.geo = geckoProfiles.length;
      // GeckoTerminal trending-pools — momentum feed (free, no key), the
      // replacement for GMGN trending (GMGN's edge blocks Cloudflare Worker
      // egress with 429). Sized by GECKOTERMINAL_TRENDING_LIMIT (0 =
      // disabled); best-effort — failures return [] and the scan continues.
      let geoTrendProfiles: TokenProfile[] = [];
      if (this.gecko && this.config.geckoterminalTrendingLimit > 0) {
        try {
          const trending = await this.gecko.fetchTrendingPools(
            this.config.geckoterminalTrendingLimit,
          );
          geoTrendProfiles = trending
            .filter((p) => p.createdAtMs !== null)
            .map((p) => ({
              tokenAddress: p.tokenAddress,
              openTimestamp: p.createdAtMs ?? undefined,
            }));
        } catch (err) {
          console.error(
            "[scanner] geckoterminal trending discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.geoTrend = geoTrendProfiles.length;
      // GMGN trending discovery — momentum-ranked candidates with GMGN's
      // smart-money/wash-trading-aware filters already applied server-side
      // (best-effort — failures return [] and the scan continues). Sized by
      // GMGN_TRENDING_LIMIT (0 = disabled).
      let gmgnProfiles: TokenProfile[] = [];
      if (this.gmgn && this.config.gmgnTrendingLimit > 0) {
        try {
          const trending = await this.gmgn.fetchTrending(
            this.config.gmgnTrendingLimit,
          );
          gmgnProfiles = trending
            .filter((t) => !t.isWashTrading)
            .map((t) => ({
              tokenAddress: t.address,
              openTimestamp: t.createdAtMs ?? undefined,
            }));
        } catch (err) {
          console.error(
            "[scanner] gmgn trending discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.gmgn = gmgnProfiles.length;
      // Axiom Trade trending — momentum feed with sniper/insider/bundle/
      // top10-holder signals Axiom computes server-side (no other free feed
      // has them). Needs a logged-in access token (see /debug/axiom-login);
      // the scanner refreshes a stale token via the stored refresh token and
      // silently skips when not logged in. Sized by AXIOM_TRENDING_LIMIT
      // (0 = disabled); best-effort — failures return [] and the scan
      // continues.
      let axiomProfiles: TokenProfile[] = [];
      if (this.axiom && this.config.axiomTrendingLimit > 0) {
        try {
          const trending = await this.fetchAxiomTrending();
          axiomProfiles = trending
            .filter((t) => t.createdAtMs !== null)
            .map((t) => ({
              tokenAddress: t.address,
              openTimestamp: t.createdAtMs ?? undefined,
            }));
        } catch (err) {
          console.error(
            "[scanner] axiom trending discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.axiom = axiomProfiles.length;
      // Jupiter Token v2 recent-launches — seconds-old launchpad launches
      // (pump.fun & co.), the free no-key replacement for the blocked
      // pump.fun frontend-api feed (HTTP 530 from Worker egress). Carries
      // createdAt so coins enter the re-eval pool with their true birth
      // time. Sized by JUPITER_RECENT_LIMIT (0 = disabled); best-effort —
      // failures return [] and the scan continues.
      let jupProfiles: TokenProfile[] = [];
      if (this.jupiter && this.config.jupiterRecentLimit > 0) {
        try {
          jupProfiles = await this.jupiter.fetchRecentTokens(
            this.config.jupiterRecentLimit,
          );
        } catch (err) {
          console.error(
            "[scanner] jupiter recent discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.jup = jupProfiles.length;
      // Jupiter Token v2 trending — momentum feed (free, no key). Mostly
      // older than the qualifying window; kept for early catch of
      // resurging mints. Sized by JUPITER_TRENDING_LIMIT (0 = disabled);
      // best-effort — failures return [] and the scan continues.
      let jupTrendProfiles: TokenProfile[] = [];
      if (this.jupiter && this.config.jupiterTrendLimit > 0) {
        try {
          jupTrendProfiles = await this.jupiter.fetchTrendingTokens(
            this.config.jupiterTrendLimit,
          );
        } catch (err) {
          console.error(
            "[scanner] jupiter trending discovery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.jupTrend = jupTrendProfiles.length;
      // Periodic Birdeye backfill — safety net for discovery gaps. Every
      // BIRDEYE_BACKFILL_INTERVAL_MIN the scanner walks back the lookback
      // window of Birdeye's new_listing feed (which includes pump.fun
      // launches) and seeds unseen coins into token_stats. This catches
      // coins created while the monitor paused (GeckoTerminal's newest-pools
      // pages roll past them and they'd never be seen again). CU-bounded: 1
      // request per run. Idempotent (INSERT OR IGNORE); last-run persisted
      // in worker_state so isolates don't re-run it on every recycle.
      try {
        diag.backfill = await this.runPeriodicBackfill();
      } catch (err) {
        console.error(
          "[scanner] periodic backfill failed:",
          err instanceof Error ? err.message : err,
        );
      }
      // Dedupe the feeds (mints overlap across all three); the DexScreener
      // entry wins — it carries richer profile data.
      const dexMints = new Set(profiles.map((p) => p.tokenAddress));
      const pumpMints = new Set(pumpProfiles.map((p) => p.tokenAddress));
      const geckoMints = new Set(geckoProfiles.map((p) => p.tokenAddress));
      const geoTrendMints = new Set(geoTrendProfiles.map((p) => p.tokenAddress));
      const gmgnMints = new Set(gmgnProfiles.map((p) => p.tokenAddress));
      const axiomMints = new Set(axiomProfiles.map((p) => p.tokenAddress));
      const jupMints = new Set(jupProfiles.map((p) => p.tokenAddress));
      const jupTrendMints = new Set(
        jupTrendProfiles.map((p) => p.tokenAddress),
      );
      const feedProfiles: TokenProfile[] = [
        ...profiles,
        ...pumpProfiles.filter((p) => !dexMints.has(p.tokenAddress)),
        ...geckoProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) && !pumpMints.has(p.tokenAddress),
        ),
        ...geoTrendProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress),
        ),
        ...gmgnProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress),
        ),
        ...axiomProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress),
        ),
        ...jupProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress) &&
            !axiomMints.has(p.tokenAddress),
        ),
        ...jupTrendProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress) &&
            !axiomMints.has(p.tokenAddress) &&
            !jupMints.has(p.tokenAddress),
        ),
      ];
      const now = Date.now();
      // Resume the one-time launch_ms backfill migration until it finishes
      // (bounded per tick — see Db.resumeLaunchBackfill). While legacy rows
      // still have NULL launch_ms they are invisible to the banded pool query
      // below, so finishing quickly keeps re-eval coverage continuous after a
      // deploy. Best-effort: a failure just retries next tick.
      if (!this.launchBackfillDone) {
        try {
          this.launchBackfillDone = await this.db.resumeLaunchBackfill(4_000);
        } catch (err) {
          console.error(
            "[scanner] launch_ms backfill resume failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Re-evaluation pool: tokens never pushed that are nearing or inside
      // the qualifying age window. The profiles feed only ever contains young
      // tokens, so without this pool a coin would rotate out of the feed
      // before reaching the minimum age (5h) and be lost forever. Bounds use
      // the widest age window across enabled chats plus a margin, so coins
      // are picked up shortly before they qualify and pushed the moment they
      // do.
      const poolMinAgeMin = Math.min(...chats.map((c) => c.minAgeMinutes));
      const poolMaxAgeMin = Math.max(...chats.map((c) => c.maxAgeMinutes));
      const poolMinMcapUsd = Math.min(...chats.map((c) => c.minMarketCapUsd));
      const recentStats = await this.getReevalPoolCached(now, {
        sinceMs: now - RE_EVAL_WINDOW_MS,
        minLaunchMs: now - (poolMaxAgeMin + RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        maxLaunchMs: now - (poolMinAgeMin - RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        windowEntryLaunchMs: now - poolMinAgeMin * 60_000,
        limit: this.config.reevalPoolSize,
        // Graduated rotation (see Db.getReevalPool): near slots swept every
        // ~REEVAL_NEAR_SWEEP_MIN, far slots every ~REEVAL_FAR_SWEEP_MIN, hot
        // zone every scan. Bands order by qualification signal and coins
        // repeatedly seen below half the market-cap gate are dropped, so
        // the sweep budget concentrates on coins that can actually qualify.
        nearSlots: this.config.reevalNearSlots,
        farSlots: this.config.reevalFarSlots,
        // Rotation period must equal the cache TTL so each expiry advances
        // the slot (see Db.getReevalPool rotationPeriodMs).
        rotationPeriodMs: this.config.reevalPoolCacheMs,
        minQualifyMcap: poolMinMcapUsd / 2,
        // Chat-aware seen exclusion: a token is dropped from the pool only
        // when EVERY enabled chat has already received it. Without this a
        // coin pushed to one chat (and marked seen there) vanished from the
        // pool even when another chat's push had just failed, so the missed
        // chat NEVER got a retry — the cross-chat push inconsistency
        // observed between the private chat and the channel.
        seenChatIds: chats.map((c) => c.chatId),
      });
      // token_stats grows with pump.fun discovery (100+ new coins per scan):
      // prune rows older than the re-eval window that were never pushed —
      // unreachable by the pool query and only wasting storage. Pushed coins
      // keep their rows so /flow and cached verdicts still work.
      try {
        await this.db.pruneOldTokenStats(now - RE_EVAL_WINDOW_MS);
      } catch (err) {
        console.error(
          "[scanner] token_stats prune failed:",
          err instanceof Error ? err.message : err,
        );
      }
      if (feedProfiles.length === 0 && recentStats.length === 0) {
        console.log("[scanner] no Solana profiles or re-eval candidates returned");
        this.lastSkip = "empty-feed-and-pool";
        return;
      }
      const poolProfiles: TokenProfile[] = [
        ...feedProfiles,
        ...recentStats
          .filter((s) => !feedProfiles.some((p) => p.tokenAddress === s.token))
          .map((s) => ({ tokenAddress: s.token })),
      ];
      diag.pool = poolProfiles.length;
      const addresses = [...new Set(poolProfiles.map((p) => p.tokenAddress))];
      const pairsByToken = await this.dex.fetchPairsForTokens(addresses);

      // Capture each token's opening stats the first time we ever see it.
      // One batched lookup for the whole feed, then one batched insert for
      // the new tokens — keeps the tick's Turso round trips to 2 instead of
      // ~2×profiles (per-round-trip latency is the tick's biggest cost when
      // the database is slow, observed ~5s/call). Registration is
      // pair-independent for pump.fun coins: a coin with no DexScreener pair
      // yet (bonding curve not graduated) is still recorded, so it enters
      // the re-eval pool and is evaluated the moment its pair appears. A
      // DexScreener profile with missing pair data is still skipped (it
      // simply re-registers next tick once the pair is fetched).
      const statsByToken = new Map<string, TokenStats>();
      const existingStats = await this.db.getTokenStatsMany(
        feedProfiles.map((p) => p.tokenAddress),
      );
      const newStats: TokenStats[] = [];
      for (const profile of feedProfiles) {
        const existing = existingStats.get(profile.tokenAddress);
        if (existing) {
          statsByToken.set(profile.tokenAddress, existing);
          continue;
        }
        const pair = pairsByToken.get(profile.tokenAddress);
        // No pair AND no pump.fun launch time → skip (retry next tick).
        if (!pair && profile.openTimestamp === undefined) continue;
        const ageMin = pair
          ? (now - pair.pairCreatedAt) / 60_000
          : profile.openTimestamp !== undefined
            ? (now - profile.openTimestamp) / 60_000
            : 0;
        const stats: TokenStats = {
          token: profile.tokenAddress,
          firstSeenAt: now,
          firstM5Vol: pair?.volume.m5 ?? 0,
          firstSeenAgeMin: ageMin,
          launchMs: pair
            ? pair.pairCreatedAt
            : profile.openTimestamp !== undefined
              ? profile.openTimestamp
              : now,
          birdeye1mVol: null,
          rugcheckBundlerPct: null,
          rugcheckTop10Pct: null,
          birdeyeProTraders: null,
          birdeyeSniperPct: null,
          minMcapObserved: null,
          supplyFlowJson: null,
          supplyFlowAt: null,
        };
        newStats.push(stats);
        statsByToken.set(profile.tokenAddress, stats);
      }
      if (newStats.length > 0) {
        await this.db.recordTokenStatsMany(newStats);
      }
      // Pool-only tokens (not in the current feed) reuse their cached stats.
      for (const stats of recentStats) {
        if (!statsByToken.has(stats.token)) statsByToken.set(stats.token, stats);
      }

      // ③ Track the highest market cap ever observed for pool candidates.
      // The re-eval pool query pre-filters on it (coins repeatedly seen far
      // below the gate stop consuming sweep budget) and orders rotation
      // bands by it. One batched raise-only UPDATE; the raise list is empty
      // in steady state (only genuine new highs trigger a write).
      const raises: Array<{ token: string; mcapUsd: number }> = [];
      for (const [token, pair] of pairsByToken) {
        const stats = statsByToken.get(token);
        if (
          !stats ||
          !Number.isFinite(pair.marketCap) ||
          pair.marketCap <= 0
        )
          continue;
        if (
          stats.maxMcapObserved === null ||
          stats.maxMcapObserved === undefined ||
          pair.marketCap > stats.maxMcapObserved
        ) {
          raises.push({ token, mcapUsd: pair.marketCap });
        }
      }
      if (raises.length > 0) {
        try {
          await this.db.updateTokenMaxMcaps(raises);
          for (const r of raises) {
            const s = statsByToken.get(r.token);
            if (s) s.maxMcapObserved = r.mcapUsd;
          }
        } catch (err) {
          console.error(
            "[scanner] max mcap tracking update failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      const agedEval = { count: 0 };
      const candidates = this.matchCoins(
        poolProfiles,
        pairsByToken,
        statsByToken,
        chats,
        diag.fails,
        diag.rejects,
        agedEval,
      );
      diag.agedEval = agedEval.count;
      diag.candidates = candidates.length;
      let pushed = 0;
      // Group candidates by token: all the expensive per-coin lookups below
      // (supply flow, RugCheck, Birdeye, GMGN, Arkham) are token-level, so
      // they run ONCE per token per tick instead of once per (token, chat)
      // pair — the previous version re-ran every lookup for each chat
      // candidate of the same coin, doubling API spend and burning the tick
      // deadline twice as fast. Pushes still happen per chat, and a push to
      // one chat failing (Telegram error) never blocks the others: the
      // chat-aware re-eval pool keeps the coin around so the missed chat
      // gets a retry on a later scan.
      const groups = new Map<string, QualifyingCoin[]>();
      for (const coin of candidates) {
        const key = coin.profile.tokenAddress;
        const group = groups.get(key);
        if (group) group.push(coin);
        else groups.set(key, [coin]);
      }
      let processedCandidates = 0;
      for (const group of groups.values()) {
        // Hard tick deadline: each token's expensive lookups (Helius up to
        // 16s + RugCheck + Birdeye) can exceed the remaining budget fast.
        // Defer the rest to the next tick — they stay in the re-evaluation
        // pool, so this only delays a push by a minute, never loses it.
        if (Date.now() > tickDeadline) {
          console.log(
            `[scanner] tick deadline reached — deferring ${candidates.length - processedCandidates} candidate(s) to next tick`,
          );
          break;
        }
        processedCandidates += group.length;
        // Chats in this group that have not yet received this coin (per-chat
        // dedupe: a coin already pushed to one chat is still pending for the
        // others, e.g. after a failed delivery — this is the fast path that
        // skips the slow lookups when every chat already has it).
        const unseen: QualifyingCoin[] = [];
        for (const coin of group) {
          if (await this.db.isTokenSeen(coin.chatId, coin.profile.tokenAddress)) {
            continue;
          }
          unseen.push(coin);
        }
        if (unseen.length === 0) continue;
        const coin = unseen[0];
        // Supply-flow (rug/distribution) check — run before the expensive
        // display lookups so a flagged coin never wastes the tick. Only a
        // confirmed flag blocks the push; a pending/incomplete analysis
        // (hold/unknown) pushes anyway with the card showing 未分析.
        const flow = await this.resolveSupplyFlow(coin, tickDeadline);
        if (flow.status === "flagged") {
          diag.fails.flow++;
          this.addReject(
            diag,
            coin,
            `供應集中 ${flow.result.feeders}錢包→1接收者 (${flow.result.fedPct.toFixed(1)}%供應, 賣出${flow.result.sells}次)`,
          );
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (supply-flow distribution detected)`,
          );
          continue;
        }
        // Bundler + top-10 holder share is resolved for the message card but
        // no longer filters — those filters were removed, so coins push even
        // when the RugCheck report is not ready yet (the card shows 未检测).
        const rugcheck = await this.resolveRugcheckData(coin);
        // Crime-wallet check: the coin's creator (RugCheck) and top holder
        // owner wallets are matched against the community blocklist. A hit
        // is a warning (flagged on the card) unless CRIME_WALLETS_BLOCK
        // turns it into a push blocker.
        const crime = this.crimeWallets
          ? await this.crimeWallets.checkToken(
              coin.stats.token,
              rugcheck.creator,
              this.helius,
              {
                checkHolders: this.config.crimeWallets.checkHolders,
                holderTopN: this.config.crimeWallets.holderTopN,
              },
            )
          : {
              hit: false,
              creatorHit: false,
              holderHits: [],
              checkedHolders: 0,
              loaded: false,
              holders: [],
            };
        if (crime.hit) diag.crime++;
        if (this.config.crimeWallets.block && crime.hit) {
          diag.fails.crime++;
          this.addReject(
            diag,
            coin,
            crime.creatorHit
              ? "Creator 在犯罪錢包名單（crimewallets）"
              : `${crime.holderHits.length} 個持有人錢包在犯罪錢包名單`,
          );
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (crime-wallet match)`,
          );
          continue;
        }
        // Trader data is resolved for the message card but no longer
        // filters — the sniper filter was removed, so coins push even when
        // the data is not ready yet.
        const trader = await this.resolveTraderData(coin);
        // Holder count (Birdeye token overview) — card-only enrichment,
        // best-effort like the trader data above. Creator comes from the
        // RugCheck report (this.rugcheck.creator).
        const holders = await this.resolveHolderCount(coin);
        // GMGN enrichment — smart money count, holders and the wash-trading
        // flag, shown on the card. Best-effort: failures degrade to no
        // enrichment. The wash-trading flag can block the push entirely
        // (GMGN_BLOCK_WASH_TRADING, default on) — same stance as the
        // gmgn-vl-radar filters (not_wash_trading).
        const gmgn = await this.resolveGmgnInfo(coin);
        if (
          this.gmgn &&
          this.config.gmgnBlockWashTrading &&
          gmgn?.isWashTrading === true
        ) {
          diag.fails.other++;
          this.addReject(diag, coin, "GMGN 標記為 wash trading");
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (GMGN wash-trading flag)`,
          );
          continue;
        }
        // Arkham smart-money attribution (card-only enrichment).
        const arkham = await this.resolveArkhamInfo(coin);
        if (arkham) diag.arkham++;
        // Wallet analysis — creator profile (age + serial-launcher create
        // count), top-holder wallet ages and cross-coin holder clustering.
        // Runs only for coins that pass every block gate (its pushed_holders
        // rows feed the clustering, so blocked coins must not pollute it).
        // Reuses the crime check's resolved holders (no extra RPC for the
        // holder list itself); each unique wallet costs one cached Helius
        // call inside a hard budget, so a slow RPC degrades the card, never
        // the push.
        const wallet = this.walletAnalyzer
          ? await this.walletAnalyzer.analyze({
              token: coin.stats.token,
              creator: rugcheck.creator,
              holders: crime.holders,
              crime,
            })
          : null;
        if (wallet?.ok) diag.walletAnalysis++;
        // Live trade-mode read (once per token): /setmode flips apply to the
        // very next card. Buy button renders in manual mode; sell buttons in
        // any non-off mode (in auto the coin was already bought — exits are
        // what matter).
        const tradeMode = this.trade
          ? await this.trade.effectiveMode()
          : "off";
        const tokenAddress = coin.pair.baseToken.address;
        const message = renderMessage(
          coin,
          rugcheck.bundlerPct,
          rugcheck.top10Pct,
          trader.sniperPct,
          flow.status === "clean",
          holders.holderCount,
          rugcheck.creator,
          gmgn,
          arkham,
          crime,
          wallet,
        );
        const sendTo = async (c: QualifyingCoin): Promise<void> => {
          await this.bot.api.sendMessage(c.chatId, message, {
            reply_markup: {
              inline_keyboard: tradeKeyboard(
                tokenAddress,
                this.trade ? this.trade.buySizeLabel : "",
                tradeMode,
                { modeSwitch: Boolean(this.trade) },
              ),
            },
          });
          await this.db.markTokenSeen(c.chatId, c.profile.tokenAddress);
          pushed++;
          // Auto trading mode: buy immediately after the push. The mode is
          // read live (a /setmode flip applies right away); executeBuy also
          // re-checks the mode gate internally. Dedupe is guaranteed twice
          // over — the coin is already in seen_tokens, and trade_log has
          // UNIQUE(token) — so a slow buy can never double-spend.
          if (this.trade && (await this.trade.effectiveMode()) === "auto") {
            await this.autoBuy(c);
          }
        };
        for (const c of unseen) {
          // Re-check right before sending: a concurrent scan (rare, only
          // when a scan outlives the 1-min cron) could have pushed it
          // meanwhile, or a previous tick's retry may have landed.
          if (await this.db.isTokenSeen(c.chatId, c.profile.tokenAddress)) {
            continue;
          }
          const symbol = c.profile.symbol ?? c.pair.baseToken.symbol ?? c.profile.tokenAddress;
          try {
            await sendTo(c);
          } catch (err) {
            // A failed delivery is NOT the end: surface the Telegram error
            // (code + description, recorded per chat for /debug/chats) and
            // retry once on transient failures (429 / 5xx / network). The
            // chat-aware re-eval pool re-pushes the coin to this chat on a
            // later scan either way — never mark it seen on failure.
            const info = describePushError(err);
            await this.recordPushFailure(c.chatId, c.profile.tokenAddress, info);
            console.error(
              `[scanner] failed to push ${symbol} to ${c.chatId}: ${info.line}`,
            );
            if (info.transient) {
              await sleep(1200);
              if (await this.db.isTokenSeen(c.chatId, c.profile.tokenAddress)) {
                continue;
              }
              try {
                await sendTo(c);
              } catch (retryErr) {
                const retryInfo = describePushError(retryErr);
                await this.recordPushFailure(c.chatId, c.profile.tokenAddress, retryInfo);
                console.error(
                  `[scanner] retry failed to push ${symbol} to ${c.chatId}: ${retryInfo.line}`,
                );
              }
            }
          }
        }
      }
      diag.pushed = pushed;
      console.log(
        `[scanner] scan done in ${Date.now() - startedAt}ms: ${profiles.length} profiles, ${poolProfiles.length} pooled, ${candidates.length} candidates, ${pushed} pushed` +
          (this.birdeye ? "" : " (Birdeye not configured)"),
      );
    } catch (err) {
      console.error(
        "[scanner] scan failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      clearTimeout(watchdog);
      // Only a still-current scan may publish summary/state; a timed-out scan
      // that eventually settles must not clobber a newer scan's results.
      if (seq === this.scanSeq) {
        this.lastSummary = diag;
        this.lastSkip = null;
        this.running = false;
      }
    }
  }

  /**
   * Periodic Birdeye new_listing backfill (see runOnce call site). Returns
   * how many coins were newly seeded, or 0 when the interval hasn't elapsed
   * / Birdeye isn't configured / nothing new was found. Persists the last
   * run in worker_state so every isolate shares one cadence instead of each
   * re-running on recycle (CU protection).
   */
  private async runPeriodicBackfill(): Promise<number> {
    const birdeye = this.birdeye;
    if (!birdeye || !this.config.birdeyeBackfillEnabled) return 0;
    const cfg = this.config;
    const lastRaw = await this.db.getWorkerState("birdeye_backfill_at");
    const lastRunAt = lastRaw ? Number(lastRaw) : 0;
    const now = Date.now();
    if (Number.isFinite(lastRunAt) && now - lastRunAt < cfg.birdeyeBackfillIntervalMs) {
      return 0; // interval not elapsed
    }
    // Walk the lookback window backwards in 6h chunks (time_to must stay
    // within ~3 days). Each chunk returns the newest ~20 listings.
    const windowMs = cfg.birdeyeBackfillLookbackMs;
    const chunkSec = 6 * 3600;
    const toFloor = Math.floor(now / 1000);
    const fromFloor = Math.floor((now - windowMs) / 1000);
    const found: Array<{ address: string; createdAtSec: number | null }> = [];
    const seen = new Set<string>();
    for (let to = toFloor; to > fromFloor; to -= chunkSec) {
      let items: Array<{ address: string; createdAtSec: number | null }> = [];
      try {
        items = await birdeye.fetchNewListings(to, 20);
      } catch (err) {
        console.error(
          "[scanner] periodic backfill new_listing failed:",
          err instanceof Error ? err.message : err,
        );
        break;
      }
      let added = 0;
      for (const it of items) {
        if (seen.has(it.address)) continue;
        seen.add(it.address);
        added++;
        if (it.createdAtSec !== null) found.push(it);
      }
      if (added === 0) break; // window walked — nothing further back
    }
    if (found.length === 0) {
      // Still mark the run so a permanently-empty feed doesn't re-trigger
      // every scan (and burn CU retrying).
      await this.db.setWorkerState("birdeye_backfill_at", String(now));
      return 0;
    }
    const stats = found.map((it) => ({
      token: it.address,
      firstSeenAt: it.createdAtSec! * 1000,
      firstM5Vol: 0,
      firstSeenAgeMin: (now - it.createdAtSec! * 1000) / 60_000,
      launchMs: it.createdAtSec! * 1000,
      birdeye1mVol: null,
      rugcheckBundlerPct: null,
      rugcheckTop10Pct: null,
      birdeyeProTraders: null,
      birdeyeSniperPct: null,
      minMcapObserved: null,
      supplyFlowJson: null,
      supplyFlowAt: null,
    }));
    await this.db.recordTokenStatsMany(stats);
    await this.db.setWorkerState("birdeye_backfill_at", String(now));
    return stats.length;
  }

  /**
   * Auto-mode buy for a just-pushed coin. Bounded by a hard timeout so a
   * slow Trojan response can never wedge the tick; result is reported to the
   * chat. Errors are logged, never thrown (a failed buy must not fail the
   * scan).
   */
  private async autoBuy(coin: QualifyingCoin): Promise<void> {
    const token = coin.pair.baseToken.address;
    const symbol = coin.pair.baseToken.symbol || coin.profile.symbol || token.slice(0, 8);
    const t0 = Date.now();
    try {
      const outcome = await Promise.race([
        this.trade!.executeBuy(token, coin.chatId),
        new Promise<{
          decision: { ok: false; reason: string };
          result?: undefined;
        }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                decision: { ok: false, reason: "超时（Trojan 无响应）" },
              }),
            this.config.trade.timeoutMs + 3_000,
          ),
        ),
      ]);
      const { decision, result } = outcome;
      const lines = ["🛒 自动买入", `🪙 ${symbol}`];
      if (!decision.ok) {
        lines.push(`⏭ 未下单: ${decision.reason}`);
      } else if (result && result.ok) {
        lines.push(`✅ 成功: ${this.trade!.amountSol} SOL`);
        if (result.txHash) lines.push(`🔗 tx: ${result.txHash}`);
      } else {
        lines.push(`❌ 失败: ${result?.error ?? "未知错误"}`);
      }
      lines.push(`⏱ ${Date.now() - t0}ms`);
      await this.bot.api.sendMessage(coin.chatId, lines.join("\n"));
    } catch (err) {
      console.error(
        `[scanner] auto-buy failed for ${symbol} (${token}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Resolve the coin's opening volume (display-only card field):
   *  1. cached exact value (computed on-chain before that computation was
   *     removed to save Helius credits — already-stored values still show),
   *  2. DexScreener proxy (m5 at first sight, when seen young),
   *  3. unknown → the card shows —（无法测量）.
   * The fresh on-chain computation (~150–250 Helius credits per coin) was
   * removed; Birdeye is also deliberately NOT consulted (its OHLCV endpoint
   * was the main free-tier budget burner).
   */
  /** Bundler + top-10 holder share + creator: cached → single RugCheck fetch → unknown. */
  private async resolveRugcheckData(coin: QualifyingCoin): Promise<{
    bundlerPct: number | null;
    top10Pct: number | null;
    creator: string | null;
  }> {
    const { stats } = coin;
    // Use the cache only while it is fresh. RugCheck keeps refining reports
    // after a token launches (e.g. late bundler detection), so re-fetch stale
    // reports instead of locking in an early "no bundlers" result forever.
    const fetchedAt = this.rugcheckFetchedAt.get(stats.token);
    const fresh =
      fetchedAt !== undefined && Date.now() - fetchedAt < RUGCHECK_REFRESH_MS;
    // Creator is a static token property — keep it in-memory across refetches
    // (the DB stores only the two percentages).
    const knownCreator = this.rugcheckCreator.get(stats.token) ?? null;
    if (stats.rugcheckTop10Pct !== null && fresh) {
      return {
        bundlerPct: stats.rugcheckBundlerPct,
        top10Pct: stats.rugcheckTop10Pct,
        creator: knownCreator,
      };
    }
    if (this.rugcheck) {
      try {
        const report = await this.rugcheck.getReport(
          stats.token,
          coin.pair.pairAddress,
        );
        this.rugcheckFetchedAt.set(stats.token, Date.now());
        if (report.creator) this.rugcheckCreator.set(stats.token, report.creator);
        await this.db.updateTokenRugcheckData(
          stats.token,
          report.bundlerPct,
          report.top10HolderPct,
        );
        stats.rugcheckBundlerPct = report.bundlerPct;
        stats.rugcheckTop10Pct = report.top10HolderPct;
        return {
          bundlerPct: report.bundlerPct,
          top10Pct: report.top10HolderPct,
          creator: report.creator ?? knownCreator,
        };
      } catch (err) {
        console.error(
          `[scanner] RugCheck lookup failed for ${stats.token}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Fetch failed or no client: fall back to whatever is cached rather than
    // treating a known report as unknown.
    if (stats.rugcheckTop10Pct !== null) {
      return {
        bundlerPct: stats.rugcheckBundlerPct,
        top10Pct: stats.rugcheckTop10Pct,
        creator: knownCreator,
      };
    }
    return { bundlerPct: null, top10Pct: null, creator: knownCreator };
  }

  /**
   * On-chain supply-flow (rug/distribution) verdict for a coin:
   *  1. fresh cached result (token_stats.supply_flow, refreshed every
   *     refreshMs),
   *  2. live analysis via Helius (getTokenLargestAccounts + gTFA
   *     out-transfers — ~1-3s, budget-guarded),
   *  3. hold — analysis pending or failed. The coin is NOT blocked: it
   *     pushes anyway with the card showing 未分析 (the detector is
   *     best-effort — only a confirmed flag blocks). The 5-min negative
   *     cache + Helius circuit breaker keep a down endpoint from stalling
   *     the tick.
   * Returns "unknown" when the check is disabled or Helius is not
   * configured — also pushes with the card showing 未分析.
   */
  private async resolveSupplyFlow(
    coin: QualifyingCoin,
    tickDeadline: number,
  ): Promise<
    | { status: "clean"; result: SupplyFlowResult }
    | { status: "flagged"; result: SupplyFlowResult }
    | { status: "hold" }
    | { status: "unknown" }
  > {
    const { stats, pair } = coin;
    const cfg = this.config.supplyFlow;
    if (!cfg.enabled || !this.config.heliusApiKey) return { status: "unknown" };

    // Fresh cache → reuse (avoids re-analyzing the same coin every minute).
    if (stats.supplyFlowJson && stats.supplyFlowAt !== null) {
      try {
        const parsed = JSON.parse(stats.supplyFlowJson) as SupplyFlowResult;
        if (Date.now() - stats.supplyFlowAt < cfg.refreshMs) {
          return parsed.flagged
            ? { status: "flagged", result: parsed }
            : { status: "clean", result: parsed };
        }
      } catch {
        // stale/corrupt cache → re-analyze
      }
    }
    // Recent empty/failed lookups: back off instead of hammering Helius.
    if (this.dataNegativeCached(stats.token)) return { status: "hold" };
    // Budget guard: the analysis makes ~10 RPC calls; only start it when it
    // can finish within the tick deadline, else defer to the next tick.
    if (tickDeadline - Date.now() < cfg.budgetMs) return { status: "hold" };

    try {
      const price = Number(pair.priceUsd);
      const supply = Number.isFinite(price) && price > 0 ? pair.marketCap / price : 0;
      if (supply <= 0) return { status: "hold" };
      const result = await Promise.race([
        this.helius!.analyzeSupplyFlow(stats.token, pair.pairAddress, supply, {
          windowMs: cfg.windowMs,
          minFeeders: cfg.minFeeders,
          minFedPct: cfg.minFedPct,
          minSells: cfg.minSells,
          topAccounts: cfg.topAccounts,
          checkInflow: cfg.checkInflow,
          now: Date.now(),
        }),
        // Hard cap: a slow/stuck gTFA must not wedge the tick — treat as
        // pending and retry next tick (nothing is lost, the coin stays held).
        new Promise<SupplyFlowResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                flagged: false,
                feeders: 0,
                fedPct: 0,
                sells: 0,
                collector: null,
                analyzedAt: Date.now(),
                windowMs: cfg.windowMs,
              }),
            cfg.budgetMs,
          ),
        ),
      ]);
      if (!result.ok) return { status: "hold" };
      this.dataFailedAt.delete(stats.token);
      const json = JSON.stringify(result);
      await this.db.updateTokenSupplyFlow(stats.token, json);
      stats.supplyFlowJson = json;
      stats.supplyFlowAt = result.analyzedAt;
      return result.flagged
        ? { status: "flagged", result }
        : { status: "clean", result };
    } catch (err) {
      this.dataFailedAt.set(stats.token, Date.now());
      console.error(
        `[scanner] supply-flow lookup failed for ${stats.token}:`,
        err instanceof Error ? err.message : err,
      );
      return { status: "hold" };
    }
  }

  /** Append a post-match rejection to the scan summary (bounded). */
  private addReject(
    diag: ScanSummary,
    coin: QualifyingCoin,
    reason: string,
  ): void {
    if (diag.rejects.length >= REJECT_LOG_MAX) return;
    const pair = coin.pair;
    const ageMs = Date.now() - pair.pairCreatedAt;
    diag.rejects.push({
      symbol: pair.baseToken.symbol || coin.profile.symbol || "?",
      ageMin: Math.round(ageMs / 60_000),
      mcapUsd: Math.round(pair.marketCap),
      vol5Usd: Math.round(pair.volume.m5),
      chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
      reason,
    });
  }

  /** Pro-trader count + sniper buy share: cached → single Birdeye fetch → unknown. */
  private async resolveTraderData(coin: QualifyingCoin): Promise<{
    proTraders: number | null;
    sniperPct: number | null;
  }> {
    const stats = coin.stats;
    // Both metrics come from the same fetch; only trust the cache when both
    // are known, so a partially-fetched result never locks in a null.
    if (stats.birdeyeProTraders !== null && stats.birdeyeSniperPct !== null) {
      return {
        proTraders: stats.birdeyeProTraders,
        sniperPct: stats.birdeyeSniperPct,
      };
    }
    if (this.birdeye && !this.dataNegativeCached(stats.token)) {
      try {
        const info = await this.birdeye.getTraderInfo(
          stats.token,
          coin.pair.marketCap,
          coin.pair.priceUsd,
        );
        if (info.proTraders !== null && info.sniperPct !== null) {
          this.dataFailedAt.delete(stats.token);
          await this.db.updateTokenProTraders(stats.token, info.proTraders);
          await this.db.updateTokenSniperPct(stats.token, info.sniperPct);
          stats.birdeyeProTraders = info.proTraders;
          stats.birdeyeSniperPct = info.sniperPct;
        } else {
          // Trader data not available yet: back off instead of re-querying
          // the same coin on every scan.
          this.dataFailedAt.set(stats.token, Date.now());
        }
        return info;
      } catch (err) {
        this.dataFailedAt.set(stats.token, Date.now());
        console.error(
          `[scanner] Birdeye trader lookup failed for ${stats.token}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { proTraders: null, sniperPct: null };
  }

  /**
   * Holder count (Birdeye token overview) — the card's holders line.
   * Best-effort with the same 5-min negative cache: a failure degrades to
   * "—" on the card, never blocks or slows the push. Only fetched for
   * qualifying candidates, so the 20 CU/request cost is negligible at the
   * current push volume.
   */
  private async resolveHolderCount(coin: QualifyingCoin): Promise<{
    holderCount: number | null;
  }> {
    const mint = coin.pair.baseToken.address;
    if (!this.birdeye || this.dataNegativeCached(mint)) {
      return { holderCount: null };
    }
    try {
      const info = await this.birdeye.getTokenOverview(mint);
      if (info.holderCount === null) {
        // No holder data back — back off instead of re-querying the same
        // coin on every scan.
        this.dataFailedAt.set(mint, Date.now());
      } else {
        this.dataFailedAt.delete(mint);
      }
      return { holderCount: info.holderCount };
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] Birdeye overview lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return { holderCount: null };
    }
  }

  /**
   * Re-eval pool with an in-memory TTL cache (see config.reevalPoolCacheMs):
   * the query is the scan's dominant Turso rows-read consumer, and its
   * result changes only slowly, so cache hits skip the DB entirely. The
   * cache key is the TTL alone — the since/launch bounds slide with `now`
   * and therefore differ on every call, so comparing them (as the first
   * version did) made the cache NEVER hit and the pool query ran on every
   * scan (a 2-min TTL advertised, 0 achieved). A stale pool is harmless:
   * the push path re-checks isTokenSeen from the DB before sending, and
   * newly discovered feed coins are evaluated via feedProfiles anyway.
   */
  private reevalPoolCache: {
    at: number;
    stats: TokenStats[];
  } | null = null;
  private async getReevalPoolCached(
    now: number,
    opts: {
      sinceMs: number;
      minLaunchMs: number;
      maxLaunchMs: number;
      windowEntryLaunchMs: number;
      limit: number;
      nearSlots?: number;
      farSlots?: number;
      rotationPeriodMs?: number;
      minQualifyMcap?: number;
      seenChatIds?: string[];
    },
  ): Promise<TokenStats[]> {
    if (this.reevalPoolCache && now - this.reevalPoolCache.at < this.config.reevalPoolCacheMs) {
      return this.reevalPoolCache.stats;
    }
    const stats = await this.db.getReevalPool(opts);
    this.reevalPoolCache = { at: now, stats };
    return stats;
  }

  /**
   * Axiom trending with access-token lifecycle: uses the token persisted by
   * /debug/axiom-tokens (worker_state `axiom_access_token`); on a
   * refreshable failure (auth rejection OR a 5xx from the sharded trending
   * hosts, which is what an invalid/expired token actually produces) it
   * refreshes once via `axiom_refresh_token` and persists whatever comes
   * back (access + rotated refresh). A cooldown prevents hammering the
   * refresh endpoint when the API itself is down. Returns [] when not
   * logged in or when refresh fails (re-login via /debug/axiom-tokens
   * needed). Never throws to the caller — feed failures degrade to the
   * other discovery sources.
   */
  private lastAxiomRefreshAt = 0;
  private async fetchAxiomTrending(): Promise<AxiomTrendingToken[]> {
    const accessToken = await this.db.getWorkerState("axiom_access_token");
    if (!accessToken) return [];
    try {
      return await this.axiom!.fetchTrending(
        accessToken,
        "1h",
        this.config.axiomTrendingLimit,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const authFailure = /auth/i.test(msg);
      // 5xx from every trending host is also refresh-worthy: Axiom's shards
      // answer 502 to an invalid/expired access token (measured 2026-08-16),
      // so a plain 5xx can mean the token died, not the API.
      const refreshable = authFailure || /HTTP 50[0-9]/.test(msg);
      if (!refreshable) {
        // 429 / other: skip this round, keep the token (it's still valid);
        // the next scan retries the same token.
        console.error(
          "[scanner] axiom trending fetch failed (non-refreshable):",
          msg,
        );
        return [];
      }
      const now = Date.now();
      if (now - this.lastAxiomRefreshAt < AXIOM_REFRESH_COOLDOWN_MS) {
        console.error(
          "[scanner] axiom refresh cooldown active — skipping refresh this round:",
          msg,
        );
        return [];
      }
      this.lastAxiomRefreshAt = now;
      const refreshToken = await this.db.getWorkerState("axiom_refresh_token");
      if (!refreshToken) {
        console.error(
          "[scanner] axiom access token rejected and no refresh token — re-login via /debug/axiom-tokens",
        );
        return [];
      }
      try {
        const fresh = await this.axiom!.refreshAccessToken(refreshToken);
        if (!fresh || !fresh.accessToken) {
          console.error(
            "[scanner] axiom refresh returned no token — re-login via /debug/axiom-tokens",
          );
          return [];
        }
        await this.db.setWorkerState("axiom_access_token", fresh.accessToken);
        // Persist a rotated refresh token when the API issues one (the SDK
        // keeps the old one otherwise — both are safe to store).
        if (fresh.refreshToken) {
          await this.db.setWorkerState("axiom_refresh_token", fresh.refreshToken);
        }
        return await this.axiom!.fetchTrending(
          fresh.accessToken,
          "1h",
          this.config.axiomTrendingLimit,
        );
      } catch (refreshErr) {
        console.error(
          "[scanner] axiom token refresh failed — re-login via /debug/axiom-tokens:",
          refreshErr instanceof Error ? refreshErr.message : refreshErr,
        );
        return [];
      }
    }
  }

  /**
   * GMGN enrichment for one candidate: smart money, holders, wash-trading
   * flag. Best-effort — any failure/empty result negative-caches the coin
   * (5 min) and degrades to no enrichment; the push is only blocked when a
   * confirmed wash-trading flag comes back and blocking is enabled.
   */
  private async resolveGmgnInfo(
    coin: QualifyingCoin,
  ): Promise<GmgnTokenInfo | null> {
    if (!this.gmgn) return null;
    const mint = coin.pair.baseToken.address;
    if (this.dataNegativeCached(mint)) return null;
    try {
      const info = await this.gmgn.fetchTokenInfo(mint);
      const empty =
        info === null ||
        (info.smartWallets === null &&
          info.holderCount === null &&
          info.isWashTrading === null);
      if (empty) {
        this.dataFailedAt.set(mint, Date.now());
        return null;
      }
      this.dataFailedAt.delete(mint);
      return info;
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] GMGN lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Arkham smart-money attribution for one candidate: entity types of the
   * top-100 holders, shown on the card. Best-effort — any failure/empty
   * result negative-caches the coin (5 min) and degrades to no enrichment.
   */
  private async resolveArkhamInfo(
    coin: QualifyingCoin,
  ): Promise<ArkhamTokenHolders | null> {
    if (!this.arkham) return null;
    const mint = coin.pair.baseToken.address;
    if (this.dataNegativeCached(mint)) return null;
    try {
      const holders = await this.arkham.fetchTokenHolders(mint);
      const empty = holders === null || holders.holderCount === 0;
      if (empty) {
        this.dataFailedAt.set(mint, Date.now());
        return null;
      }
      this.dataFailedAt.delete(mint);
      return holders;
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] Arkham lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private matchCoins(
    profiles: TokenProfile[],
    pairsByToken: Map<string, PairInfo>,
    statsByToken: Map<string, TokenStats>,
    chats: {
      chatId: string;
      minLiquidityUsd: number;
      minVolume24hUsd: number;
      minMarketCapUsd: number;
      maxMarketCapUsd: number;
      minAgeMinutes: number;
      maxAgeMinutes: number;
      min5mVolUsd: number;
      min5mChgPct: number;
    }[],
    fails: ScanSummary["fails"],
    rejects: RejectionEntry[],
    agedEval: { count: number },
  ): QualifyingCoin[] {
    const out: QualifyingCoin[] = [];
    for (const profile of profiles) {
      const pair = pairsByToken.get(profile.tokenAddress);
      if (!pair) continue;
      const stats = statsByToken.get(profile.tokenAddress);
      if (!stats) continue;
      const liquidityUsd = pair.liquidity.usd ?? 0;
      const volume24h = pair.volume.h24;
      const ageMs = Date.now() - pair.pairCreatedAt;
      // Log the coin's first failing gate for this chat (bounded — the feed
      // + pool can be 60+ coins, but 50 entries keep the heartbeat small).
      const reject = (reason: string) => {
        if (rejects.length >= REJECT_LOG_MAX) return;
        rejects.push({
          symbol: pair.baseToken.symbol || profile.symbol || "?",
          ageMin: Math.round(ageMs / 60_000),
          mcapUsd: Math.round(pair.marketCap),
          vol5Usd: Math.round(pair.volume.m5),
          chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
          reason,
        });
      };

      for (const chat of chats) {
        if (liquidityUsd < chat.minLiquidityUsd) {
          fails.other++;
          reject(`流动性 ${fmtUsd(liquidityUsd)} < ${fmtUsd(chat.minLiquidityUsd)}`);
          continue;
        }
        if (volume24h < chat.minVolume24hUsd) {
          fails.other++;
          reject(`24h量 ${fmtUsd(volume24h)} < ${fmtUsd(chat.minVolume24hUsd)}`);
          continue;
        }
        if (pair.marketCap < chat.minMarketCapUsd) {
          fails.mcap++;
          reject(`市值 ${fmtUsd(pair.marketCap)} < ${fmtUsd(chat.minMarketCapUsd)}`);
          continue; // too small
        }
        if (pair.marketCap > chat.maxMarketCapUsd) {
          fails.mcap++;
          reject(`市值 ${fmtUsd(pair.marketCap)} > ${fmtUsd(chat.maxMarketCapUsd)}`);
          continue; // too big — mid-cap range only
        }
        if (ageMs < chat.minAgeMinutes * 60_000) {
          fails.age++;
          reject(`上線 ${Math.round(ageMs / 60_000)}m < ${chat.minAgeMinutes}m`);
          continue; // too fresh
        }
        if (ageMs > chat.maxAgeMinutes * 60_000) {
          fails.age++;
          reject(`上線 ${Math.round(ageMs / 60_000)}m > ${chat.maxAgeMinutes}m`);
          continue; // too old
        }
        // Reached the age gate in-window (age ≥ min) — count these so /health
        // can prove in-window coins are evaluated each scan, not silently
        // skipped (per-chat count, consistent with the fails counters).
        agedEval.count++;
        if (pair.volume.m5 < chat.min5mVolUsd) {
          fails.vol5++;
          reject(`5m量 ${fmtUsd(pair.volume.m5)} < ${fmtUsd(chat.min5mVolUsd)}`);
          continue;
        }
        if (pair.priceChange.m5 < chat.min5mChgPct) {
          fails.chg++;
          reject(`5m涨幅 ${pair.priceChange.m5.toFixed(1)}% < ${chat.min5mChgPct}%`);
          continue;
        }
        out.push({
          chatId: chat.chatId,
          profile,
          pair,
          stats,
        });
      }
    }
    return out;
  }
}
