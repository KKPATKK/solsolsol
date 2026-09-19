import type { AppConfig } from "./config";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
/**
 * Back off ALL GeckoTerminal calls for this long after one 429. Measured
 * 2026-08-16: the API rate-limits Cloudflare Worker egress (shared IP pool)
 * with a sustained 429 on trending_pools, which also started starving
 * new_pools. Without backoff the scanner would hit the 429 wall every
 * round; with it, one 429 pauses the feed for 5 min and it self-recovers.
 * Matches the discovery gap the re-eval pool + Birdeye backfill cover.
 */
const GECKO_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface NewPool {
  tokenAddress: string;
  createdAtMs: number | null;
  dex: string;
  fdvUsd: number | null;
  reserveUsd: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay well under GeckoTerminal's rate limit. */
class Throttle {
  private lastCallAt = 0;
  constructor(private readonly intervalMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const wait = Math.max(0, this.lastCallAt + this.intervalMs - Date.now());
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
    return fn();
  }
}

/**
 * Parse a `/networks/solana/new_pools` response (pure — unit-testable).
 *
 * Observed real shape (2026-08-14):
 *   data[].id                     = "solana_<poolAddress>"
 *   data[].attributes.pool_created_at = "2026-08-14T03:38:19" (ISO)
 *   data[].attributes.reserve_in_usd / fdv_usd
 *   data[].relationships.base_token.data.id = "solana_<tokenMint>"
 *   data[].relationships.dex.data.id        = "pump-fun" | "raydium" | ...
 */
export function parseNewPools(json: unknown): NewPool[] {
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: NewPool[] = [];
  for (const it of data) {
    const item = it as {
      attributes?: Record<string, unknown>;
      relationships?: {
        base_token?: { data?: { id?: string } };
        dex?: { data?: { id?: string } };
      };
    };
    const baseId = item?.relationships?.base_token?.data?.id;
    if (typeof baseId !== "string") continue;
    const tokenAddress = baseId.replace(/^solana_/, "");
    // Solana base58 mint (32-44 chars).
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) continue;
    const createdRaw = item?.attributes?.pool_created_at;
    let createdAtMs: number | null = null;
    if (typeof createdRaw === "string" && createdRaw) {
      const parsed = Date.parse(createdRaw);
      if (Number.isFinite(parsed)) createdAtMs = parsed;
    }
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    out.push({
      tokenAddress,
      createdAtMs,
      dex: String(item?.relationships?.dex?.data?.id ?? ""),
      fdvUsd: num(item?.attributes?.fdv_usd),
      reserveUsd: num(item?.attributes?.reserve_in_usd),
    });
  }
  return out;
}

/**
 * One token's live economics, as GeckoTerminal's `/tokens/{address}` reports
 * them. Used by the post-push tracker as a THIRD pair source (see
 * Scanner.pairsForTracker): DexScreener's batched endpoint can be 429-blocked
 * for its whole 90s backoff AND Jupiter's search does not index every pushed
 * memecoin, which left the tracker blind to its own coins for the duration.
 *
 * Field notes (verified against the live API on a tracked XCAT pool,
 * 2026-09-18): `market_cap_usd` comes back null for Solana memecoins, so
 * `fdv_usd` is what callers can actually use, and `total_reserve_in_usd` is
 * the reserve SUMMED over the token's pools (the closest analogue of
 * DexScreener's per-pool liquidity). The two valuation fields are returned
 * SEPARATELY (`marketCapUsd`, `fdvOnlyUsd`) with `fdvUsedAsMcap` marking the
 * fallback: folding an FDV into a market cap silently is how an FDV value got
 * recorded as a coin's push price (2026-09-19 audit). The payload carries NO
 * 5-minute volume/change and no hourly txn counts, so those stay zero — see
 * the call site for why that is the safe direction.
 */
export interface GeckoTokenSnapshot {
  priceUsd: number | null;
  /**
   * The valuation the tracker uses when it needs a market cap:
   * `market_cap_usd` when the API reports one, otherwise `fdv_usd` (the only
   * figure Solana memecoins carry — see the field notes). This keeps the
   * existing callers that read `fdvUsd` working unchanged; `fdvUsedAsMcap`
   * says whether the number is really a diluted valuation.
   */
  fdvUsd: number | null;
  /** Circulating market cap only — null when the API omits it. */
  marketCapUsd: number | null;
  /** Raw fully-diluted valuation only — a DIFFERENT quantity. */
  fdvOnlyUsd: number | null;
  /** True when `fdvUsd` is an FDV standing in for a missing market cap. */
  fdvUsedAsMcap: boolean;
  reserveUsd: number | null;
}

/**
 * Parse `/networks/solana/tokens/{address}` (pure — unit-testable). Returns
 * null when the payload carries none of the three numbers, so callers treat
 * "no data" and "not found" the same way.
 */
export function parseTokenSnapshot(json: unknown): GeckoTokenSnapshot | null {
  const attrs = (json as { data?: { attributes?: unknown } } | null)?.data
    ?.attributes;
  if (!attrs || typeof attrs !== "object") return null;
  const rec = attrs as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const priceUsd = num(rec.price_usd);
  const marketCapUsd = num(rec.market_cap_usd);
  const fdvOnlyUsd = num(rec.fdv_usd);
  const reserveUsd = num(rec.total_reserve_in_usd) ?? num(rec.reserve_in_usd);
  if (
    priceUsd === null &&
    marketCapUsd === null &&
    fdvOnlyUsd === null &&
    reserveUsd === null
  )
    return null;
  return {
    priceUsd,
    fdvUsd: marketCapUsd ?? fdvOnlyUsd,
    marketCapUsd,
    fdvOnlyUsd,
    fdvUsedAsMcap: marketCapUsd === null && fdvOnlyUsd !== null,
    reserveUsd,
  };
}

/**
 * Free live discovery of brand-new Solana pools (every DEX, incl. pump.fun
 * graduates) — no API key, reachable from datacenter egress. Each page holds
 * ~20 pools created within the last few minutes. This is the zero-CU
 * replacement for Birdeye's new_listing (30–80 CU/call is unaffordable on
 * the free tier for per-minute polling) now that pump.fun blocks datacenter
 * IPs. Best-effort: any failure returns [] and the scan continues on the
 * other feeds.
 */
export class GeckoTerminalClient {
  private readonly throttle: Throttle;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;

  constructor(config: AppConfig) {
    this.throttle = new Throttle(config.geckoterminalRequestIntervalMs);
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /**
   * Shared GET: throttle-spaced, 429-aware. Returns the parsed JSON on
   * success, null on rate-limit (setting the backoff window) or any other
   * failure — callers degrade to [] without throwing.
   */
  private async get(path: string): Promise<unknown> {
    if (this.rateLimited()) return null;
    try {
      const res = await this.throttle.run(() =>
        fetch(`${BASE_URL}${path}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (res.status === 429) {
        this.rateLimitedUntil = Date.now() + GECKO_RATE_LIMIT_BACKOFF_MS;
        return null;
      }
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /**
   * One token's snapshot (see GeckoTokenSnapshot). Shares the client's
   * throttle and 429 backoff with the discovery feeds: after a 429 this
   * returns null for the whole backoff window, exactly like the feeds do.
   */
  async fetchTokenSnapshot(mint: string): Promise<GeckoTokenSnapshot | null> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
    return parseTokenSnapshot(await this.get(`/networks/solana/tokens/${mint}`));
  }

  async fetchNewPools(page = 1): Promise<NewPool[]> {
    return parseNewPools(await this.get(`/networks/solana/new_pools?page=${page}`));
  }

  /**
   * Momentum feed — GeckoTerminal's trending pools (free, no key, verified
   * reachable 2026-08-16). Same item shape as new_pools (base_token in
   * relationships, pool_created_at ISO), so parseNewPools is reused. Sized by
   * GECKOTERMINAL_TRENDING_LIMIT (0 = disabled); the endpoint returns up to
   * 20 pools per call.
   */
  async fetchTrendingPools(limit: number): Promise<NewPool[]> {
    return parseNewPools(
      await this.get(
        `/networks/solana/trending_pools?include=base_token&limit=${Math.min(
          Math.max(1, Math.floor(limit)),
          20,
        )}`,
      ),
    );
  }
}
