import type { Bot } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { BirdeyeClient } from "./birdeye";
import type { AppConfig } from "./config";
import type { Db, TokenStats } from "./db";
import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";
import { fmtAge, fmtUsd } from "./format";
import type { RugcheckClient } from "./rugcheck";

const CHAIN_BASE_URL = "https://dexscreener.com/solana/";
/** Axiom trade token page (mint address appended). */
const AXIOM_BASE_URL = "https://axiom.trade/t/";
/** A token's opening volume (DexScreener proxy) is only meaningful if we saw it young. */
const MAX_MEASURABLE_AGE_MIN = 5;
/** Re-fetch RugCheck reports older than this to pick up late bundler detection. */
const RUGCHECK_REFRESH_MS = 15 * 60_000;
/**
 * After a Birdeye lookup comes back empty/failed, do not re-query the same
 * token for this long. Every retry costs 35 CU on the free tier, and empty
 * results (data not indexed yet) are not cached in the DB, so without this
 * a waiting coin would hammer the endpoint on every 20s scan.
 */
const BIRDEYE_NEGATIVE_CACHE_MS = 5 * 60_000;

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
  source: "birdeye" | "proxy" | "unknown";
}

export class Scanner {
  private running = false;
  /** When each token's RugCheck report was last fetched (in-memory TTL). */
  private readonly rugcheckFetchedAt = new Map<string, number>();
  /**
   * When Birdeye last returned empty/failed for a token, so we can skip
   * re-querying it for a while (in-memory negative cache).
   */
  private readonly birdeyeFailedAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly bot: Bot,
    private readonly dex: DexScreenerClient,
    private readonly config: AppConfig,
    private readonly birdeye: BirdeyeClient | null,
    private readonly rugcheck: RugcheckClient | null,
  ) {}

  /** True while a Birdeye retry for this token should be skipped (negative cache). */
  private birdeyeNegativeCached(token: string): boolean {
    const at = this.birdeyeFailedAt.get(token);
    if (at === undefined) return false;
    if (Date.now() - at < BIRDEYE_NEGATIVE_CACHE_MS) return true;
    this.birdeyeFailedAt.delete(token); // prune stale entries
    return false;
  }

  /** Runs one full scan. Safe to call concurrently (overlapping runs are skipped). */
  async runOnce(): Promise<void> {
    if (this.running) {
      console.log("[scanner] previous scan still running, skipping this tick");
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const chats = await this.db.listEnabledChats();
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        return;
      }

      const profiles = await this.dex.fetchLatestSolanaProfiles();
      if (profiles.length === 0) {
        console.log("[scanner] no Solana profiles returned");
        return;
      }
      const addresses = [...new Set(profiles.map((p) => p.tokenAddress))];
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

      const candidates = this.matchCoins(profiles, pairsByToken, statsByToken, chats);
      let pushed = 0;
      for (const coin of candidates) {
        const opening = await this.resolveOpeningVolume(coin);
        // Strict opening-volume filter: exclude only when we know the value
        // and it is too hot. Unknown values (or known-low values) pass.
        if (opening.value !== null && opening.value >= coin.max1mVolUsd) {
          continue;
        }
        const rugcheck = await this.resolveRugcheckData(coin);
        // Bundler filter: skip coins whose bundled/insider supply share is
        // known and too high. Unknown (null) means no bundlers detected — pass.
        if (rugcheck.bundlerPct !== null && rugcheck.bundlerPct >= coin.maxBundlerPct) {
          continue;
        }
        // Top-10 holder data must be ready before pushing: when RugCheck has
        // not produced the report yet, hold the coin and re-check it on the
        // next scan instead of pushing a card with "未检测".
        if (rugcheck.top10Pct === null) {
          console.log(
            `[scanner] holding ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (RugCheck report not ready)`,
          );
          continue;
        }
        // Top-10 holder concentration filter.
        if (rugcheck.top10Pct >= coin.maxTop10HolderPct) {
          continue;
        }
        const trader = await this.resolveTraderData(coin);
        // Sniper filter: skip coins whose sniper buy share of supply is known
        // and too high. When Birdeye has no trader data yet, hold the coin
        // and re-check on the next scan (same policy as the top-10 metric).
        if (trader.sniperPct === null) {
          console.log(
            `[scanner] holding ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (sniper data not ready)`,
          );
          continue;
        }
        if (trader.sniperPct >= coin.maxSniperPct) {
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
      console.log(
        `[scanner] scan done in ${Date.now() - startedAt}ms: ${profiles.length} profiles, ${candidates.length} candidates, ${pushed} pushed` +
          (this.birdeye ? "" : " (Birdeye not configured)"),
      );
    } catch (err) {
      console.error(
        "[scanner] scan failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Resolve the coin's opening volume:
   *  1. cached exact value from Birdeye,
   *  2. fresh fetch from Birdeye (cached afterwards),
   *  3. DexScreener proxy (m5 at first sight, when seen young),
   *  4. unknown → the coin is pushed (no way to measure).
   */
  private async resolveOpeningVolume(
    coin: QualifyingCoin,
  ): Promise<OpeningVolume> {
    const { stats, pair } = coin;

    if (stats.birdeye1mVol !== null) {
      return { value: stats.birdeye1mVol, source: "birdeye" };
    }

    if (this.birdeye && !this.birdeyeNegativeCached(stats.token)) {
      try {
        const vol = await this.birdeye.getFirstMinuteVolume(
          stats.token,
          Math.floor(pair.pairCreatedAt / 1000),
        );
        if (vol !== null) {
          this.birdeyeFailedAt.delete(stats.token);
          await this.db.updateTokenBirdeyeVol(stats.token, vol);
          stats.birdeye1mVol = vol;
          return { value: vol, source: "birdeye" };
        }
        // Empty result (candles not indexed yet): back off instead of
        // re-querying the same coin on every 20s scan.
        this.birdeyeFailedAt.set(stats.token, Date.now());
      } catch (err) {
        this.birdeyeFailedAt.set(stats.token, Date.now());
        console.error(
          `[scanner] Birdeye lookup failed for ${stats.token}:`,
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
    if (this.birdeye && !this.birdeyeNegativeCached(stats.token)) {
      try {
        const info = await this.birdeye.getTraderInfo(
          stats.token,
          coin.pair.marketCap,
          coin.pair.priceUsd,
        );
        if (info.proTraders !== null && info.sniperPct !== null) {
          this.birdeyeFailedAt.delete(stats.token);
          await this.db.updateTokenProTraders(stats.token, info.proTraders);
          await this.db.updateTokenSniperPct(stats.token, info.sniperPct);
          stats.birdeyeProTraders = info.proTraders;
          stats.birdeyeSniperPct = info.sniperPct;
        } else {
          // Trader data not available yet: back off instead of re-querying
          // the same coin on every 20s scan.
          this.birdeyeFailedAt.set(stats.token, Date.now());
        }
        return info;
      } catch (err) {
        this.birdeyeFailedAt.set(stats.token, Date.now());
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
        if (liquidityUsd < chat.minLiquidityUsd) continue;
        if (volume24h < chat.minVolume24hUsd) continue;
        if (pair.marketCap < chat.minMarketCapUsd) continue;
        if (ageMs < chat.minAgeMinutes * 60_000) continue; // too fresh
        if (ageMs > chat.maxAgeMinutes * 60_000) continue; // too old
        if (pair.volume.m5 < chat.min5mVolUsd) continue;
        if (pair.priceChange.m5 < chat.min5mChgPct) continue;
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
      : `🌱 首分钟量: ${fmtUsd(opening.value)}${opening.source === "birdeye" ? " (Birdeye)" : ""}`;
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
