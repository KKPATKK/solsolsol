import type { AppConfig } from "./config";

const BASE_URL = "https://api.dexscreener.com";

export interface TokenProfile {
  tokenAddress: string;
  name?: string;
  symbol?: string;
  openTimestamp?: number;
}

export interface PairInfo {
  chainId: string;
  url: string;
  /** The trading-pool address (used to identify the LP holder). */
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  /** Price of 1 base token in native quote (e.g. SOL) — used for SOL/USD. */
  priceNative?: number;
  marketCap: number;
  volume: { h24: number; m5: number };
  priceChange: { m5: number; h1: number };
  /** Transaction counts (DexScreener txns) — buy/sell pressure signal. */
  txns: { m5Buys: number; m5Sells: number; h1Buys: number; h1Sells: number };
  liquidity: { usd: number | null };
  pairCreatedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Compound momentum gate: a coin qualifies when its 5-minute tape is hot
 * (fast pump in progress right now) OR its 1-hour tape is hot (pumped
 * within the last hour and possibly consolidating between spikes — the
 * single-instant 5m snapshot alone misses coins sampled mid-pullback).
 * Exported for offline unit tests.
 */
export function passesChgGate(
  chg5m: number,
  chg1h: number,
  min5mPct: number,
  min1hPct: number,
): boolean {
  return chg5m >= min5mPct || chg1h >= min1hPct;
}

/** Spaces out HTTP requests so we stay well under DexScreener's rate limit. */
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
 * Hard wall-clock budget for one fetchPairsForTokens call. A slow/limited
 * batch endpoint must not eat the whole scan tick (observed: 87s of retries
 * for 4 batches of 30 addresses, when the tick's heartbeat budget is 26s).
 * Batches past the deadline are skipped; their tokens simply stay in the
 * re-evaluation pool and are retried next tick.
 */
const PAIRS_FETCH_BUDGET_MS = 10_000;
/**
 * Pair-data cache TTL. The re-eval pool rotates slowly (same coins swept
 * minute after minute), so re-fetching all ~550 addresses every tick burns
 * ~19 batched requests/min against a shared egress IP that other tenants
 * also hammer — the observed hard 429 block. A short TTL keeps gate math
 * fresh enough (cooldowns are ≥30 min) while cutting request volume ~70%.
 */
const PAIR_CACHE_TTL_MS = 180_000;
/** Cache size cap (oldest entries evicted) — bounds isolate memory. */
const PAIR_CACHE_MAX = 4_000;
/** After a batched-endpoint 429, skip all batch calls for this long. */
const PAIR_BATCH_BACKOFF_MS = 90_000;

export class DexScreenerClient {
  private readonly throttle: Throttle;
  /** Fresh pair data by token (see PAIR_CACHE_TTL_MS). Insertion-ordered. */
  private readonly pairCache = new Map<
    string,
    { pair: PairInfo; at: number }
  >();
  /** Until this epoch the batched endpoint 429'd — serve cache only. */
  private batchBlockedUntil = 0;

  constructor(private readonly config: AppConfig) {
    this.throttle = new Throttle(config.dexRequestIntervalMs);
  }

  /**
   * GET JSON with retries for transient errors (429/5xx). Deterministic
   * client errors (4xx) return null immediately — retrying a 404 for a
   * delisted token never helps, and the re-evaluation pool regularly
   * contains delisted coins, so this saves ~8s per failing batch.
   * `deadline` (optional, ms epoch) bounds the whole attempt loop: once the
   * budget is exhausted, in-flight requests abort quickly and the call
   * returns null instead of throwing.
   */
  private async getJson(path: string, deadline?: number): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining =
        deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (remaining <= 0) return null; // budget exhausted — stop trying
      try {
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(
              Math.max(1_000, Math.min(15_000, remaining)),
            ),
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`DexScreener HTTP ${res.status}`);
        }
        if (!res.ok) {
          return null; // deterministic client error — retrying won't help
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < 3 && Date.now() < (deadline ?? Number.POSITIVE_INFINITY)) {
          await sleep(attempt * 2000);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("DexScreener request failed");
  }

  /**
   * Newest token profiles first. Returns only Solana profiles so the scanner
   * never inspects other chains.
   */
  async fetchLatestSolanaProfiles(): Promise<TokenProfile[]> {
    const data = (await this.getJson("/token-profiles/latest/v1")) as Array<
      Record<string, unknown>
    >;
    if (!Array.isArray(data)) return [];
    const profiles: TokenProfile[] = [];
    for (const item of data) {
      if (item.chainId !== "solana") continue;
      const tokenAddress = String(item.tokenAddress ?? "");
      if (!tokenAddress) continue;
      profiles.push({
        tokenAddress,
        name: typeof item.name === "string" ? item.name : undefined,
        symbol: typeof item.symbol === "string" ? item.symbol : undefined,
        openTimestamp:
          typeof item.openTimestamp === "number" ? item.openTimestamp : undefined,
      });
    }
    return profiles.slice(0, this.config.scanProfileLimit);
  }

  /**
   * Fetch live pair data for up to 30 addresses per request.
   * The /latest/dex/tokens endpoint returns a flat `pairs` array, so we
   * group pairs by baseToken.address and keep the first Solana pair per token.
   * Bounded by PAIRS_FETCH_BUDGET_MS so a slow/limited endpoint cannot eat
   * the whole scan tick: batches past the deadline are skipped and their
   * tokens are simply re-tried on the next scan.
   */
  async fetchPairsForTokens(addresses: string[]): Promise<Map<string, PairInfo>> {
    const result = new Map<string, PairInfo>();
    const now = Date.now();
    // Serve whatever is still fresh from the cache first; only cache misses
    // hit the wire.
    const misses: string[] = [];
    for (const a of addresses) {
      const hit = this.pairCache.get(a);
      if (hit && now - hit.at < PAIR_CACHE_TTL_MS) {
        result.set(a, hit.pair);
      } else {
        misses.push(a);
      }
    }
    if (misses.length === 0) return result;
    // Blocked by a recent hard 429: don't hammer the endpoint (and don't
    // burn the tick's budget on doomed retries) — cache-only for now.
    if (Date.now() < this.batchBlockedUntil) return result;

    const deadline = now + PAIRS_FETCH_BUDGET_MS;
    for (let i = 0; i < misses.length; i += 30) {
      if (Date.now() > deadline) break; // keep the tick inside its budget
      const batch = misses.slice(i, i + 30);
      let data: { pairs?: Array<Record<string, unknown>> } | null;
      try {
        data = (await this.getJson(
          `/latest/dex/tokens/${batch.join(",")}`,
          deadline,
        )) as { pairs?: Array<Record<string, unknown>> } | null;
      } catch (err) {
        // A rate-limited batch means the remaining ones will 429 too — stop
        // instead of burning the rest of the tick's budget (and Cloudflare's
        // wall clock) on doomed retries, and back off across ticks so the
        // next scan goes straight to cache-only mode.
        if (/429/.test(err instanceof Error ? err.message : String(err))) {
          this.batchBlockedUntil = Date.now() + PAIR_BATCH_BACKOFF_MS;
          break;
        }
        continue; // transient/other error — skip this batch, try the next
      }
      const pairs = data?.pairs;
      if (!Array.isArray(pairs)) continue;

      for (const raw of pairs) {
        if (raw.chainId !== "solana") continue;
        const baseToken = raw.baseToken as
          | { address?: string; name?: string; symbol?: string }
          | undefined;
        if (!baseToken?.address) continue;
        if (result.has(baseToken.address)) continue; // first pair wins
        const volume = raw.volume as { h24?: number; m5?: number } | undefined;
        const txnsRaw = raw.txns as
          | {
              m5?: { buys?: number; sells?: number };
              h1?: { buys?: number; sells?: number };
            }
          | undefined;
        const priceChange = raw.priceChange as { m5?: number; h1?: number } | undefined;
        result.set(baseToken.address, {
          chainId: "solana",
          url: String(raw.url ?? ""),
          pairAddress: String(raw.pairAddress ?? ""),
          baseToken: {
            address: baseToken.address,
            name: baseToken.name ?? "",
            symbol: baseToken.symbol ?? "",
          },
          priceUsd: String(raw.priceUsd ?? "0"),
          priceNative: Number(raw.priceNative),
          marketCap: Number(raw.marketCap ?? 0),
          volume: {
            h24: Number(volume?.h24 ?? 0),
            m5: Number(volume?.m5 ?? 0),
          },
          priceChange: {
            m5: Number(priceChange?.m5 ?? 0),
            h1: Number(priceChange?.h1 ?? 0),
          },
          txns: {
            m5Buys: Number(txnsRaw?.m5?.buys ?? 0),
            m5Sells: Number(txnsRaw?.m5?.sells ?? 0),
            h1Buys: Number(txnsRaw?.h1?.buys ?? 0),
            h1Sells: Number(txnsRaw?.h1?.sells ?? 0),
          },
          liquidity: {
            // Preserve 0 — a drained pool reports usd: 0 and the push-watch
            // rug rule must see it, not mistake it for "unknown" (null).
            usd:
              (raw.liquidity as { usd?: number } | undefined)?.usd ===
                undefined
                ? null
                : Number((raw.liquidity as { usd?: number }).usd),
          },
          pairCreatedAt: Number(raw.pairCreatedAt ?? 0),
        });
        this.pairCache.set(baseToken.address, {
          pair: result.get(baseToken.address)!,
          at: now,
        });
      }
    }
    if (this.pairCache.size > PAIR_CACHE_MAX) {
      // Evolve oldest-first (Map preserves insertion order).
      for (const k of this.pairCache.keys()) {
        if (this.pairCache.size <= PAIR_CACHE_MAX) break;
        this.pairCache.delete(k);
      }
    }
    return result;
  }
}
