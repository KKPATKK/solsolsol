import type { AppConfig } from "./config";
import type { PairInfo, TokenProfile } from "./dexscreener";

const BASE_URL = "https://lite-api.jup.ag/tokens/v2";
/**
 * Back off ALL Jupiter token-feed calls for this long after one 429 — same
 * policy as the GeckoTerminal client. Jupiter's lite-api is generous
 * (~60 req/min), but Workers share egress IPs with every other customer,
 * so a 429 window can still happen; without backoff the scanner would
 * re-hit it every tick. One skipped feed round costs nothing — the
 * re-eval pool keeps coverage.
 */
const JUP_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay well under Jupiter's rate limit. */
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
 * Raw Jupiter Token v2 entry — only the fields this integration uses.
 * The endpoint is Solana-native (`id` is the mint), so no chain filtering
 * is needed (unlike the multi-chain DexScreener boosts feed).
 */
interface JupToken {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
  /** ISO timestamp of the token's creation (≈ launchpad birth time). */
  createdAt?: unknown;
}

/** Rolling-window stats block on a token entry (stats5m / stats1h / stats24h). */
interface JupStats {
  priceChange?: unknown;
  numBuys?: unknown;
  numSells?: unknown;
  buyVolume?: unknown;
  sellVolume?: unknown;
}

/** Valid base58 Solana mint (32–44 chars, no 0/O/I/l). */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function toMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Pure parser for the Jupiter Token v2 list response (exported for offline
 * unit tests): keeps valid base58 mints only, maps `createdAt` to
 * `openTimestamp` so coins enter the re-eval pool with their true launch
 * age (a trending entry for an old coin lands outside the qualifying
 * window and is pruned after one retention cycle — harmless).
 */
export function parseJupTokens(data: unknown): TokenProfile[] {
  if (!Array.isArray(data)) return [];
  const out: TokenProfile[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const t = (raw ?? {}) as JupToken;
    const id = typeof t.id === "string" ? t.id : "";
    if (!MINT_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      tokenAddress: id,
      name: typeof t.name === "string" ? t.name : undefined,
      symbol: typeof t.symbol === "string" ? t.symbol : undefined,
      openTimestamp: toMs(t.createdAt),
    });
  }
  return out;
}

/**
 * Jupiter Token API v2 DISCOVERY client (free lite-api, no key) — distinct
 * from src/jupiter.ts, which is the Jupiter Swap trading service:
 *   - fetchRecentTokens: seconds-old launchpad launches (pump.fun & co.) —
 *     the replacement for the blocked pump.fun frontend-api feed, with the
 *     same "enter the coin before DexScreener notices it" purpose.
 *   - fetchTrendingTokens: momentum-ranked established coins (mostly land
 *     outside the age window — kept for early catch of resurging mints).
 * Both degrade to [] on any failure; a rate limit sets a shared 5-minute
 * backoff so the scan never hammers a throttled upstream.
 */
/** Number of mints per /search call — the endpoint's documented cap. */
const JUP_BATCH_SIZE = 100;

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Pure mapper from Jupiter token entries to the scanner's PairInfo shape
 * (exported for offline unit tests). Every gate input the scan needs is
 * available here: mcap, liquidity, 5m volume + price change, buy/sell
 * counts, 1h change, and the pool creation time for the age gate.
 */
export function jupToPairInfos(data: unknown): Map<string, PairInfo> {
  const out = new Map<string, PairInfo>();
  if (!Array.isArray(data)) return out;
  for (const raw of data as Array<Record<string, unknown>>) {
    const id = typeof raw.id === "string" ? raw.id : undefined;
    if (!id || !MINT_RE.test(id) || out.has(id)) continue;
    const s5 = (raw.stats5m ?? {}) as JupStats;
    const s1 = (raw.stats1h ?? {}) as JupStats;
    const s24 = (raw.stats24h ?? {}) as JupStats;
    out.set(id, {
      chainId: "solana",
      url: `https://dexscreener.com/solana/${id}`,
      pairAddress: id,
      baseToken: {
        address: id,
        name: String(raw.name ?? ""),
        symbol: String(raw.symbol ?? ""),
      },
      priceUsd: String(n(raw.usdPrice)),
      marketCap: n(raw.mcap) || n(raw.fdv),
      volume: {
        h24: n(s24.buyVolume) + n(s24.sellVolume),
        m5: n(s5.buyVolume) + n(s5.sellVolume),
      },
      priceChange: { m5: n(s5.priceChange), h1: n(s1.priceChange) },
      txns: {
        m5Buys: n(s5.numBuys),
        m5Sells: n(s5.numSells),
        h1Buys: n(s1.numBuys),
        h1Sells: n(s1.numSells),
      },
      liquidity: { usd: raw.liquidity === undefined ? null : n(raw.liquidity) },
      pairCreatedAt: toMs(raw.createdAt) ?? 0,
    });
  }
  return out;
}

export class JupTokensClient {
  private readonly throttle: Throttle;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;

  constructor(
    config: AppConfig,
    /** Injectable fetch for tests (defaults to global fetch). */
    private readonly fetcher?: (url: string) => Promise<Response>,
  ) {
    this.throttle = new Throttle(config.jupiterRequestIntervalMs);
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** Shared GET: throttle-spaced, 429-aware; null on any failure. */
  private async get(path: string): Promise<unknown> {
    if (this.rateLimited()) return null;
    try {
      const doFetch =
        this.fetcher ??
        ((u: string) =>
          fetch(u, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          }));
      const res = await this.throttle.run(() => doFetch(`${BASE_URL}${path}`));
      if (res.status === 429) {
        this.rateLimitedUntil = Date.now() + JUP_RATE_LIMIT_BACKOFF_MS;
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }


  /** Newest launchpad launches (pump.fun & co.), newest first. */
  async fetchRecentTokens(limit: number): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 100));
    // Slice client-side: measured 2026-08-21 the lite-api returns ≥30 rows
    // regardless of the limit param, and the configured cap IS the Turso
    // rows-read budget guard (every extra row can become a token_stats one).
    return parseJupTokens(await this.get(`/recent?limit=${wanted}`)).slice(
      0,
      wanted,
    );
  }

  /** Momentum-ranked tokens over the trailing 24h window. */
  async fetchTrendingTokens(limit: number): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 100));
    return parseJupTokens(await this.get(`/trending/24h?limit=${wanted}`)).slice(
      0,
      wanted,
    );
  }

  /**
   * Batched gate data for arbitrary mints — the FALLBACK price source when
   * DexScreener's batched endpoint is 429-blocked. One call per 100 mints
   * covers every scan gate: mcap, liquidity, 5m/1h volume + change,
   * buy/sell counts and pool creation time.
   */
  async fetchTokenDataBatch(mints: string[], max = 500): Promise<Map<string, PairInfo>> {
    const out = new Map<string, PairInfo>();
    const list = mints.filter((m) => MINT_RE.test(m)).slice(0, Math.max(0, max));
    for (let i = 0; i < list.length; i += JUP_BATCH_SIZE) {
      if (this.rateLimited()) break;
      const chunk = list.slice(i, i + JUP_BATCH_SIZE);
      for (const [k, v] of jupToPairInfos(
        await this.get(`/search?query=${chunk.join(",")}`),
      ))
        out.set(k, v);
    }
    return out;
  }
}
