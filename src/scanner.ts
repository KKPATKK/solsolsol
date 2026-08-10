import type { Bot } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { BirdeyeClient } from "./birdeye";
import type { AppConfig } from "./config";
import type { Db, TokenStats } from "./db";
import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";
import { fmtAge, fmtUsd } from "./format";
import type { HeliusClient } from "./helius";
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
/** Re-evaluate tokens first seen within this window until their data arrives. */
const RE_EVAL_WINDOW_MS = 60 * 60_000;
/** Re-evaluation pool cap (keeps the pairs re-fetch + JSON parse small). */
const RE_EVAL_POOL_SIZE = 20;

/** One qualifying coin, prepared for a specific chat. */
interface QualifyingCoin {
  chatId: string;
  profile: TokenProfile;
  pair: PairInfo;
  stats: TokenStats;
  /** The chat's opening-volume threshold, used at push time. */
  max1mVolUsd: number;
  /** The chat's bundler threshold, used at push time. */
  maxBundlerPct: number;
  /** The chat's top-10 holder threshold, used at push time. */
  maxTop10HolderPct: number;
  /** The chat's sniper-holder threshold, used at push time. */
  maxSniperPct: number;
}

/** Resolved opening (first-minute) volume for a coin. */
interface OpeningVolume {
  /** Exact volume in USD, or null when it could not be determined. */
  value: number | null;
  source: "helius" | "proxy" | "unknown";
}

/** Rejection reasons from the last completed scan (surfaced via /health). */
export interface ScanSummary {
  profiles: number;
  pool: number;
  candidates: number;
  pushed: number;
  holds: {
    /** Opening volume known and too hot (>= chat max). */
    opening: number;
    /** Bundler share known and too high. */
    bundler: number;
    /** RugCheck report not ready yet (re-check next scan). */
    rugcheck: number;
    /** Top-10 holder concentration known and too high. */
    top10: number;
    /** Birdeye trader data not ready yet (re-check next scan). */
    sniper: number;
    /** Sniper share known and too high. */
    sniperHigh: number;
  };
  fails: {
    mcap: number;
    chg: number;
    vol5: number;
    age: number;
    other: number;
  };
}

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
    const diag: ScanSummary = {
      profiles: 0,
      pool: 0,
      candidates: 0,
      pushed: 0,
      holds: {
        opening: 0,
        bundler: 0,
        rugcheck: 0,
        top10: 0,
        sniper: 0,
        sniperHigh: 0,
      },
      fails: { mcap: 0, chg: 0, vol5: 0, age: 0, other: 0 },
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
      // Re-evaluation pool: tokens seen recently that were never pushed, so a
      // coin held while RugCheck/Birdeye data arrives — or seen too young to
      // qualify on first sight — keeps being retried instead of rotating out
      // of the "latest profiles" feed and being lost forever.
      const recentStats = await this.db.getRecentTokenStats(
        Date.now() - RE_EVAL_WINDOW_MS,
        RE_EVAL_POOL_SIZE,
      );
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

      // Capture each token's opening volume the first time we ever see it
      // (while it is still young, its m5 volume ≈ its opening volume).
      const now = Date.now();
      const statsByToken = new Map<string, TokenStats>();
      for (const profile of profiles) {
        const pair = pairsByToken.get(profile.tokenAddress);
        if (!pair) continue;
        const existing = await this.db.getTokenStats(profile.tokenAddress);
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
        };
        await this.db.recordTokenStats(stats);
        statsByToken.set(profile.tokenAddress, stats);
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
      );
      diag.candidates = candidates.length;
      let pushed = 0;
      for (const coin of candidates) {
        // Fast path: skip coins already pushed to this chat before doing the
        // (slow) RugCheck/Birdeye lookups for them again.
        if (await this.db.isTokenSeen(coin.chatId, coin.profile.tokenAddress)) {
          continue;
        }
        const opening = await this.resolveOpeningVolume(coin);
        // Strict opening-volume filter: exclude only when we know the value
        // and it is too hot. Unknown values (or known-low values) pass.
        if (opening.value !== null && opening.value >= coin.max1mVolUsd) {
          diag.holds.opening++;
          continue;
        }
        const rugcheck = await this.resolveRugcheckData(coin);
        // Bundler filter: skip coins whose bundled/insider supply share is
        // known and too high. Unknown (null) means no bundlers detected — pass.
        if (rugcheck.bundlerPct !== null && rugcheck.bundlerPct >= coin.maxBundlerPct) {
          diag.holds.bundler++;
          continue;
        }
        // Top-10 holder data must be ready before pushing: when RugCheck has
        // not produced the report yet, hold the coin and re-check it on the
        // next scan instead of pushing a card with "未检测".
        if (rugcheck.top10Pct === null) {
          diag.holds.rugcheck++;
          console.log(
            `[scanner] holding ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (RugCheck report not ready)`,
          );
          continue;
        }
        // Top-10 holder concentration filter.
        if (rugcheck.top10Pct >= coin.maxTop10HolderPct) {
          diag.holds.top10++;
          continue;
        }
        const trader = await this.resolveTraderData(coin);
        // Sniper filter: skip coins whose sniper buy share of supply is known
        // and too high. When Birdeye has no trader data yet, hold the coin
        // and re-check on the next scan (same policy as the top-10 metric).
        if (trader.sniperPct === null) {
          diag.holds.sniper++;
          console.log(
            `[scanner] holding ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (sniper data not ready)`,
          );
          continue;
        }
        if (trader.sniperPct >= coin.maxSniperPct) {
          diag.holds.sniperHigh++;
          continue;
        }
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
  ): Promise<OpeningVolume> {
    const { stats, pair } = coin;

    if (stats.birdeye1mVol !== null) {
      return { value: stats.birdeye1mVol, source: "helius" };
    }

    if (this.helius && !this.dataNegativeCached(stats.token)) {
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
      maxAgeMinutes: number;
      minMarketCapUsd: number;
      minAgeMinutes: number;
      min5mVolUsd: number;
      min5mChgPct: number;
      max1mVolUsd: number;
      maxBundlerPct: number;
      maxTop10HolderPct: number;
      maxSniperPct: number;
    }[],
    fails: ScanSummary["fails"],
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

      for (const chat of chats) {
        if (liquidityUsd < chat.minLiquidityUsd) {
          fails.other++;
          continue;
        }
        if (volume24h < chat.minVolume24hUsd) {
          fails.other++;
          continue;
        }
        if (pair.marketCap < chat.minMarketCapUsd) {
          fails.mcap++;
          continue;
        }
        if (ageMs < chat.minAgeMinutes * 60_000) {
          fails.age++;
          continue; // too fresh
        }
        if (ageMs > chat.maxAgeMinutes * 60_000) {
          fails.age++;
          continue; // too old
        }
        if (pair.volume.m5 < chat.min5mVolUsd) {
          fails.vol5++;
          continue;
        }
        if (pair.priceChange.m5 < chat.min5mChgPct) {
          fails.chg++;
          continue;
        }
        out.push({
          chatId: chat.chatId,
          profile,
          pair,
          stats,
          max1mVolUsd: chat.max1mVolUsd,
          maxBundlerPct: chat.maxBundlerPct,
          maxTop10HolderPct: chat.maxTop10HolderPct,
          maxSniperPct: chat.maxSniperPct,
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
