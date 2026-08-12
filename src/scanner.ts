import type { Bot } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { BirdeyeClient } from "./birdeye";
import type { AppConfig } from "./config";
import type { Db, TokenStats } from "./db";
import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";
import { fmtAge, fmtUsd } from "./format";
import type { HeliusClient, SupplyFlowResult } from "./helius";
import type { RugcheckClient } from "./rugcheck";

const CHAIN_BASE_URL = "https://dexscreener.com/solana/";
/** Axiom trade token page (mint address appended). */
const AXIOM_BASE_URL = "https://axiom.trade/t/";
/** A token's opening volume (DexScreener proxy) is only meaningful if we saw it young. */
const MAX_MEASURABLE_AGE_MIN = 5;
/** Re-fetch RugCheck reports older than this to pick up late bundler detection. */
const RUGCHECK_REFRESH_MS = 15 * 60_000;
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
 * Room (ms) needed in the tick before attempting the on-chain opening-volume
 * computation: its enumeration budget is 16s, so only start it when it can
 * actually finish within the tick deadline. The computation is display-only
 * (the first-minute-volume filter was removed) — never risk the whole tick
 * for a message-card field; fall back to the cheap proxy/unknown path.
 */
const OPENING_VOLUME_ROOM_MS = 18_000;
/**
 * How long a first-seen token stays eligible for re-evaluation. Must cover
 * the qualifying age window (max 40h) plus margin: coins age into the
 * window while sitting in the pool, since the DexScreener profiles feed
 * only ever contains young tokens.
 */
const RE_EVAL_WINDOW_MS = 42 * 60 * 60_000;
/**
 * Re-evaluation pool cap. Sized so the per-tick pairs re-fetch stays within
 * 2 DexScreener batches (30 addresses each): the pool is ordered by distance
 * to the age-window entry, so the 40 most relevant coins are always covered.
 */
const RE_EVAL_POOL_SIZE = 40;
/**
 * Margin (minutes) around the qualifying age window: the pool also holds
 * coins that will enter the window within 3h, so they are pushed the moment
 * they qualify instead of being picked up only after a later scan.
 */
const RE_EVAL_AGE_MARGIN_MIN = 180;

/** One qualifying coin, prepared for a specific chat. */
interface QualifyingCoin {
  chatId: string;
  profile: TokenProfile;
  pair: PairInfo;
  stats: TokenStats;
}

/** Resolved opening (first-minute) volume for a coin. */
interface OpeningVolume {
  /** Exact volume in USD, or null when it could not be determined. */
  value: number | null;
  source: "helius" | "proxy" | "unknown";
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
  pool: number;
  candidates: number;
  pushed: number;
  fails: {
    mcap: number;
    chg: number;
    vol5: number;
    age: number;
    /** Supply-flow (rug/distribution) pattern detected on-chain. */
    flow: number;
    other: number;
  };
  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];
}

/** Cap on per-coin rejection entries kept in the scan summary/heartbeat. */
const REJECT_LOG_MAX = 50;

export class Scanner {
  private running = false;
  /** Monotonic scan id: a timed-out scan must not clobber a newer scan's state. */
  private scanSeq = 0;
  /** Summary of the last completed scan, persisted into the heartbeat. */
  lastSummary: ScanSummary | null = null;
  /** When each token's RugCheck report was last fetched (in-memory TTL). */
  private readonly rugcheckFetchedAt = new Map<string, number>();
  /**
   * When Helius/Birdeye last returned empty/failed for a token, so we can
   * skip re-querying it for a while (in-memory negative cache).
   */
  private readonly dataFailedAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly bot: Bot,
    private readonly dex: DexScreenerClient,
    private readonly config: AppConfig,
    private readonly birdeye: BirdeyeClient | null,
    private readonly rugcheck: RugcheckClient | null,
    private readonly helius: HeliusClient | null,
  ) {}

  /** True while an on-chain/Birdeye retry for this token should be skipped. */
  private dataNegativeCached(token: string): boolean {
    const at = this.dataFailedAt.get(token);
    if (at === undefined) return false;
    if (Date.now() - at < DATA_NEGATIVE_CACHE_MS) return true;
    this.dataFailedAt.delete(token); // prune stale entries
    return false;
  }

  /** Runs one full scan. Safe to call concurrently (overlapping runs are skipped). */
  async runOnce(): Promise<void> {
    if (this.running) {
      console.log("[scanner] previous scan still running, skipping this tick");
      return;
    }
    const seq = ++this.scanSeq;
    this.running = true;
    const startedAt = Date.now();
    const tickDeadline = startedAt + SCAN_TICK_DEADLINE_MS;
    const diag: ScanSummary = {
      profiles: 0,
      pool: 0,
      candidates: 0,
      pushed: 0,
      fails: { mcap: 0, chg: 0, vol5: 0, age: 0, flow: 0, other: 0 },
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
        return;
      }

      const profiles = await this.dex.fetchLatestSolanaProfiles();
      diag.profiles = profiles.length;
      const now = Date.now();
      // Re-evaluation pool: tokens never pushed that are nearing or inside
      // the qualifying age window. The profiles feed only ever contains young
      // tokens, so without this pool a coin would rotate out of the feed
      // before reaching the minimum age (6h) and be lost forever. Bounds use
      // the widest age window across enabled chats plus a margin, so coins
      // are picked up shortly before they qualify and pushed the moment they
      // do.
      const poolMinAgeMin = Math.min(...chats.map((c) => c.minAgeMinutes));
      const poolMaxAgeMin = Math.max(...chats.map((c) => c.maxAgeMinutes));
      const recentStats = await this.db.getReevalPool({
        sinceMs: now - RE_EVAL_WINDOW_MS,
        minLaunchMs: now - (poolMaxAgeMin + RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        maxLaunchMs: now - (poolMinAgeMin - RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        windowEntryLaunchMs: now - poolMinAgeMin * 60_000,
        limit: RE_EVAL_POOL_SIZE,
      });
      if (profiles.length === 0 && recentStats.length === 0) {
        console.log("[scanner] no Solana profiles or re-eval candidates returned");
        return;
      }
      const poolProfiles: TokenProfile[] = [
        ...profiles,
        ...recentStats
          .filter((s) => !profiles.some((p) => p.tokenAddress === s.token))
          .map((s) => ({ tokenAddress: s.token })),
      ];
      diag.pool = poolProfiles.length;
      const addresses = [...new Set(poolProfiles.map((p) => p.tokenAddress))];
      const pairsByToken = await this.dex.fetchPairsForTokens(addresses);

      // Capture each token's opening stats the first time we ever see it.
      // One batched lookup for the whole feed, then one batched insert for
      // the new tokens — keeps the tick's Turso round trips to 2 instead of
      // ~2×profiles (per-round-trip latency is the tick's biggest cost when
      // the database is slow, observed ~5s/call).
      const statsByToken = new Map<string, TokenStats>();
      const existingStats = await this.db.getTokenStatsMany(
        profiles.map((p) => p.tokenAddress),
      );
      const newStats: TokenStats[] = [];
      for (const profile of profiles) {
        const pair = pairsByToken.get(profile.tokenAddress);
        if (!pair) continue;
        const existing = existingStats.get(profile.tokenAddress);
        if (existing) {
          statsByToken.set(profile.tokenAddress, existing);
          continue;
        }
        const stats: TokenStats = {
          token: profile.tokenAddress,
          firstSeenAt: now,
          firstM5Vol: pair.volume.m5,
          firstSeenAgeMin: (now - pair.pairCreatedAt) / 60_000,
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

      const candidates = this.matchCoins(
        poolProfiles,
        pairsByToken,
        statsByToken,
        chats,
        diag.fails,
        diag.rejects,
      );
      diag.candidates = candidates.length;
      let pushed = 0;
      for (const [candIdx, coin] of candidates.entries()) {
        // Hard tick deadline: each candidate's expensive lookups (Helius up
        // to 16s + RugCheck + Birdeye) can exceed the remaining budget fast.
        // Defer the rest to the next tick — they stay in the re-evaluation
        // pool, so this only delays a push by a minute, never loses it.
        if (Date.now() > tickDeadline) {
          console.log(
            `[scanner] tick deadline reached — deferring ${candidates.length - candIdx} candidate(s) to next tick`,
          );
          break;
        }
        // Fast path: skip coins already pushed to this chat before doing the
        // (slow) RugCheck/Birdeye lookups for them again.
        if (await this.db.isTokenSeen(coin.chatId, coin.profile.tokenAddress)) {
          continue;
        }
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
        // Opening volume is resolved for the message card but no longer
        // filters — the first-minute-volume filter was removed.
        const opening = await this.resolveOpeningVolume(coin, tickDeadline);
        // Bundler + top-10 holder share is resolved for the message card but
        // no longer filters — those filters were removed, so coins push even
        // when the RugCheck report is not ready yet (the card shows 未检测).
        const rugcheck = await this.resolveRugcheckData(coin);
        // Trader data is resolved for the message card but no longer
        // filters — the sniper filter was removed, so coins push even when
        // the data is not ready yet.
        const trader = await this.resolveTraderData(coin);
        // Re-check right before sending: a concurrent scan (rare, only when
        // a scan outlives the 1-min cron) could have pushed it meanwhile.
        if (await this.db.isTokenSeen(coin.chatId, coin.profile.tokenAddress)) {
          continue;
        }
        try {
          const tokenAddress = coin.pair.baseToken.address;
          await this.bot.api.sendMessage(
            coin.chatId,
            renderMessage(
              coin,
              opening,
              rugcheck.bundlerPct,
              rugcheck.top10Pct,
              trader.proTraders,
              trader.sniperPct,
              flow.status === "clean",
            ),
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔗 打开 Axiom 页面",
                      url: `${AXIOM_BASE_URL}${tokenAddress}`,
                    } as InlineKeyboardButton,
                  ],
                ],
              },
            },
          );
          await this.db.markTokenSeen(coin.chatId, coin.profile.tokenAddress);
          pushed++;
        } catch (err) {
          console.error(
            `[scanner] failed to push ${coin.profile.symbol ?? coin.profile.tokenAddress} to ${coin.chatId}:`,
            err instanceof Error ? err.message : err,
          );
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
        this.running = false;
      }
    }
  }

  /**
   * Resolve the coin's opening volume:
   *  1. cached exact value (computed on-chain via Helius),
   *  2. fresh on-chain computation from the pump.fun bonding curve,
   *  3. DexScreener proxy (m5 at first sight, when seen young),
   *  4. unknown → the coin is pushed (no way to measure).
   * Birdeye is deliberately NOT consulted here anymore: its OHLCV endpoint
   * (35 CU/call) was the main free-tier budget burner, and the on-chain
   * computation is free (1 credit/call on Helius' plan).
   */
  private async resolveOpeningVolume(
    coin: QualifyingCoin,
    tickDeadline: number,
  ): Promise<OpeningVolume> {
    const { stats, pair } = coin;

    if (stats.birdeye1mVol !== null) {
      return { value: stats.birdeye1mVol, source: "helius" };
    }

    // Budget guard: the on-chain computation is display-only and can cost up
    // to 16s per coin — only start it when it can finish within the tick
    // deadline, so a candidate never risks the 30s wall clock for a
    // message-card field.
    if (
      this.helius &&
      !this.dataNegativeCached(stats.token) &&
      tickDeadline - Date.now() >= OPENING_VOLUME_ROOM_MS
    ) {
      try {
        const vol = await this.helius.getFirstMinuteVolumeUsd(stats.token, {
          priceUsd: pair.priceUsd,
          priceNative: pair.priceNative,
          pairCreatedAt: pair.pairCreatedAt,
          pairAddress: pair.pairAddress,
        });
        if (vol !== null) {
          this.dataFailedAt.delete(stats.token);
          await this.db.updateTokenBirdeyeVol(stats.token, vol);
          stats.birdeye1mVol = vol;
          return { value: vol, source: "helius" };
        }
        // Empty result (curve not indexed / first minute not complete / not a
        // pump token): back off instead of re-querying every scan.
        this.dataFailedAt.set(stats.token, Date.now());
      } catch (err) {
        this.dataFailedAt.set(stats.token, Date.now());
        console.error(
          `[scanner] on-chain volume lookup failed for ${stats.token}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (stats.firstSeenAgeMin <= MAX_MEASURABLE_AGE_MIN) {
      return { value: stats.firstM5Vol, source: "proxy" };
    }
    return { value: null, source: "unknown" };
  }

  /** Bundler + top-10 holder share: cached → single RugCheck fetch → unknown. */
  private async resolveRugcheckData(coin: QualifyingCoin): Promise<{
    bundlerPct: number | null;
    top10Pct: number | null;
  }> {
    const { stats } = coin;
    // Use the cache only while it is fresh. RugCheck keeps refining reports
    // after a token launches (e.g. late bundler detection), so re-fetch stale
    // reports instead of locking in an early "no bundlers" result forever.
    const fetchedAt = this.rugcheckFetchedAt.get(stats.token);
    const fresh =
      fetchedAt !== undefined && Date.now() - fetchedAt < RUGCHECK_REFRESH_MS;
    if (stats.rugcheckTop10Pct !== null && fresh) {
      return {
        bundlerPct: stats.rugcheckBundlerPct,
        top10Pct: stats.rugcheckTop10Pct,
      };
    }
    if (this.rugcheck) {
      try {
        const report = await this.rugcheck.getReport(
          stats.token,
          coin.pair.pairAddress,
        );
        this.rugcheckFetchedAt.set(stats.token, Date.now());
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
      };
    }
    return { bundlerPct: null, top10Pct: null };
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

function renderMessage(
  coin: QualifyingCoin,
  opening: OpeningVolume,
  bundlerPct: number | null,
  top10Pct: number | null,
  proTraders: number | null,
  sniperPct: number | null,
  supplyFlowClean: boolean,
): string {
  const { pair, profile } = coin;
  const name = pair.baseToken.name || profile.name || "Unknown";
  const symbol = pair.baseToken.symbol || profile.symbol || "?";
  const tokenAddress = pair.baseToken.address;
  const price = Number(pair.priceUsd);
  const liquidityUsd = pair.liquidity.usd ?? 0;
  const ageMs = Date.now() - pair.pairCreatedAt;

  const openingLine =
    opening.value === null
      ? "🌱 首分钟量: —（无法测量）"
      : `🌱 首分钟量: ${fmtUsd(opening.value)}${opening.source === "helius" ? " (链上)" : ""}`;
  const bundlerLine =
    bundlerPct === null
      ? "🛡 Bundler: 0.0%（未检测到捆绑网络）"
      : `🛡 Bundler: ${bundlerPct.toFixed(1)}%`;
  const top10Line =
    top10Pct === null
      ? "👥 Top10 持仓: —（未检测）"
      : `👥 Top10 持仓: ${top10Pct.toFixed(1)}% (剔除LP)`;
  const flowLine = supplyFlowClean
    ? "🕸 供應流: ✅ 无集中出货（链上检查通过）"
    : "🕸 供應流: —（未分析）";
  const proTradersLine =
    proTraders === null
      ? "🧑‍💻 Pro 交易者: —（未检测）"
      : `🧑‍💻 Pro 交易者: ${proTraders} (smart)`;
  const sniperLine =
    sniperPct === null
      ? "🎯 Sniper 買入: —（未檢測）"
      : `🎯 Sniper 買入: ${sniperPct.toFixed(1)}%（佔供應）`;

  const lines = [
    `🪙 ${name} (${symbol})`,
    `💵 价格: ${fmtUsd(price)}`,
    `💰 市值: ${fmtUsd(pair.marketCap)}`,
    `⚡ 5m 涨幅: ${pair.priceChange.m5 >= 0 ? "+" : ""}${pair.priceChange.m5.toFixed(2)}%`,
    `📊 5m 量: ${fmtUsd(pair.volume.m5)}`,
    openingLine,
    bundlerLine,
    top10Line,
    flowLine,
    proTradersLine,
    sniperLine,
    `📈 24h 量: ${fmtUsd(pair.volume.h24)}`,
    `💧 流动性: ${fmtUsd(liquidityUsd)}`,
    `⏱️ 上线: ${fmtAge(ageMs)}`,
    `🔑 合约: ${tokenAddress}`,
    `🔗 ${CHAIN_BASE_URL}${tokenAddress}`,
  ];
  return lines.join("\n");
}
