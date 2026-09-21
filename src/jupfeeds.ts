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
 *   - fetchTrendingTokens: organic-score ranked coins (see the method: the
 *     /trending/24h endpoint it used to read went empty on 2026-09-21).
 * Both degrade to [] on any failure; a rate limit sets a shared 5-minute
 * backoff so the scan never hammers a throttled upstream.
 */
/** Number of mints per /search call — the endpoint's documented cap. */
const JUP_BATCH_SIZE = 100;
/**
 * Wall-clock cap for one fetchTokenDataBatch fallback call (see the method
 * comment for the 2026-09-12 dead-tick evidence). Sized to finish 2–3
 * chunks at normal latency and to bail before the worker's 12s race when
 * Jupiter throttles.
 *
 * 2026-09-16: 3500 → 900. The fallback is the LAST front phase on exactly
 * the ticks with the least room (it only fires when DexScreener returned
 * under half the requested pairs — i.e. a 429/blocked tick), and it ran
 * from its own start, so 3.5s carried the pair phase (and the gates behind
 * it) past the scan's internal deadline. 900ms fits the front-phase window
 * (see FRONT_PHASE_WINDOW_MS in scanner.ts: feeds + pool + pairs must all
 * land inside it) and covers the ~100-address chunk that carries the pool
 * slice's live coins; addresses left over keep their tokens in the re-eval
 * pool and are re-read on the next tick, the same fail-safe as every other
 * budget here.
 */
const JUP_FALLBACK_BUDGET_MS = 900;

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
      // `mcap` first; FDV only as an explicitly FLAGGED fallback, so a
      // diluted valuation can never be recorded as a market cap by accident
      // (see PairInfo.fdvUsd / mcapFromFdv).
      marketCap: n(raw.mcap) || n(raw.fdv),
      fdvUsd: raw.fdv == null ? null : n(raw.fdv),
      mcapFromFdv: n(raw.mcap) <= 0 && n(raw.fdv) > 0,
      volume: {
        h24: n(s24.buyVolume) + n(s24.sellVolume),
        h1: n(s1.buyVolume) + n(s1.sellVolume),
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
      // Jupiter's `liquidity` is its own metric — measured at ~half of
      // DexScreener's pool reserve for the same pool (2026-09-20, see the
      // feedSource note on PairInfo), so a pair built here must never be
      // judged by a DexScreener-calibrated USD level.
      feedSource: "jupiter",
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


  /**
   * Organic-quality snapshot for a single mint (push-card enrichment):
   * Jupiter's organicScore separates real retail participation from
   * wash/coordinated volume (calibrated 2026-08-22: CONK 79 / 40M 75 /
   * BLC 61 vs DOTE 40 / BAOJIN 0 / Nudaeng 0). Display-only today.
   *
   * Trader count window fallback: Jupiter OMITS stats1h.numTraders
   * entirely when the trailing hour has zero trades (ARMY at push time —
   * stats1h only carried volumeChange), which silently dropped the
   * "| 1h 交易者" half of the card line. Fall back to the 6h then 24h
   * window and report which window the count came from (null = no
   * trader data in any window).
   */
  async fetchOrganicScore(
    mint: string,
  ): Promise<{
    score: number | null;
    label: string | null;
    tradersH1: number | null;
    tradersWindow: "1h" | "6h" | "24h" | null;
  } | null> {
    const data = await this.get(`/search?query=${mint}`);
    if (!Array.isArray(data)) return null;
    const entry = data.find(
      (x) => (x as Record<string, unknown>).id === mint,
    ) as Record<string, unknown> | undefined;
    if (!entry) return null;
    const s1 = (entry.stats1h ?? {}) as Record<string, unknown>;
    // organicScore of 0 is a REAL value (BAOJIN/Nudaeng) — distinguish
    // "field absent" (undefined) from a genuine zero via typeof.
    const score =
      typeof entry.organicScore === "number" && Number.isFinite(entry.organicScore)
        ? entry.organicScore
        : null;
    const tradersOf = (stats: Record<string, unknown> | undefined) => {
      const raw = (stats ?? {}).numTraders;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    };
    const s6 = (entry.stats6h ?? {}) as Record<string, unknown>;
    const s24 = (entry.stats24h ?? {}) as Record<string, unknown>;
    let tradersH1 = tradersOf(s1);
    let tradersWindow: "1h" | "6h" | "24h" | null = tradersH1 !== null ? "1h" : null;
    if (tradersH1 === null) {
      tradersH1 = tradersOf(s6);
      if (tradersH1 !== null) {
        tradersWindow = "6h";
      } else {
        tradersH1 = tradersOf(s24);
        if (tradersH1 !== null) tradersWindow = "24h";
      }
    }
    if (score === null && tradersH1 === null) return null;
    return {
      score,
      label: typeof entry.organicScoreLabel === "string" ? entry.organicScoreLabel : null,
      tradersH1,
      tradersWindow,
    };
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

  /**
   * Organic-score ranked tokens over the trailing 24h window.
   *
   * 2026-09-21 — the endpoint moved. `/trending/24h` answers HTTP 200 with an
   * EMPTY array (`[]`, 2 bytes) now, from the worker's egress AND from a
   * normal host, while `/recent` on the same API serves data in the same
   * minute — so this was not a 429, not a parse problem and not our egress:
   * the endpoint stopped serving. The feed never produced a coin again
   * (`jupTrend 0` on every sampled tick), i.e. one subrequest per tick for
   * nothing. `/toporganicscore/24h` is the live endpoint for what this feed
   * exists for — "early catch of resurging mints": measured the same day, 4
   * of its top 20 entries sat inside the scanner's qualifying age window
   * (12.5h–24h, mcap 177K–4.0M, organic score 75+) on established liquidity,
   * which is the resurging-mint shape this feed is for. Entries outside the
   * window are rejected by the age gate exactly as before — "mostly outside
   * the qualifying window" was already this feed's documented behaviour.
   */
  async fetchTrendingTokens(limit: number): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 100));
    return parseJupTokens(
      await this.get(`/toporganicscore/24h?limit=${wanted}`),
    ).slice(0, wanted);
  }

  /**
   * Batched gate data for arbitrary mints — the FALLBACK price source when
   * DexScreener's batched endpoint is 429-blocked. One call per 100 mints
   * covers every scan gate: mcap, liquidity, 5m/1h volume + change,
   * buy/sell counts and pool creation time.
   *
   * 2026-09-12: the chunk loop was unbounded in wall time — with a ~500-mint
   * missing set it walked 5 chunks × (10s per-request timeout + throttle
   * spacing) ≈ 50s+, and on 429/5xx-heavy ticks the scan never settled
   * inside the worker's 12s race: the isolate was killed at the ~30s wall
   * clock and the tick died before its completion flush (the recurring
   * "died before its completion flush — backfilled by next tick" rows,
   * 08:10–08:27Z). Capped at 3500ms: covers 2–3 chunks (~200–300 mints, more
   * than the ~100–160-coin pool needs) at normal latency; chunks past the
   * deadline keep their tokens in the re-eval pool for the next tick (same
   * fail-safe as the DexScreener batch skip). Every phase is now
   * deadline-bounded, so a tripped race still settles and flushes a
   * diagnosable timeout row instead of dying as a dead tick.
   */
  async fetchTokenDataBatch(mints: string[], max = 500): Promise<Map<string, PairInfo>> {
    const out = new Map<string, PairInfo>();
    const list = mints.filter((m) => MINT_RE.test(m)).slice(0, Math.max(0, max));
    const deadline = Date.now() + JUP_FALLBACK_BUDGET_MS;
    for (let i = 0; i < list.length; i += JUP_BATCH_SIZE) {
      if (this.rateLimited() || Date.now() > deadline) break;
      const chunk = list.slice(i, i + JUP_BATCH_SIZE);
      // Race the request itself against the remaining budget: checking the
      // deadline BETWEEN chunks bounds the loop but not a single hung
      // request (each get() carries its own multi-second transport
      // timeout), so one stalled call could carry this phase — and the
      // gate/push phase behind it — past the scan's deadline. A chunk that
      // expires contributes nothing and the loop exits on the next check.
      const remaining = deadline - Date.now();
      if (remaining <= 250) break;
      const data = await Promise.race([
        this.get(`/search?query=${chunk.join(",")}`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      for (const [k, v] of jupToPairInfos(data)) out.set(k, v);
    }
    return out;
  }
}
