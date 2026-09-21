import type { AppConfig } from "./config";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
/**
 * Back off ALL GeckoTerminal calls for this long after the FIRST 429 in a row.
 * Measured 2026-08-16: the API rate-limits Cloudflare Worker egress (shared IP
 * pool) with a sustained 429 on trending_pools, which also started starving
 * new_pools. Without backoff the scanner would hit the 429 wall every
 * round; with it, one 429 pauses the feed for 5 min and it self-recovers.
 * Matches the discovery gap the re-eval pool + Birdeye backfill cover.
 *
 * This is the BASE of an escalation, not a flat window (see geckoBackoffMs):
 * re-measured 2026-09-20, the worker's egress was 429ed on EVERY attempt —
 * /debug/gecko-trending returned 429 three times out of three, and every tick's
 * summary reported `geo 0 / geoTrend 0` — so a feed that comes back at the
 * 5-minute mark and takes the same 429 is just paying a request per window for
 * nothing. The window now doubles per consecutive 429 (5 → 10 → 20 → 40 → 60
 * min cap) and resets on the first success, so the cost of a poisoned egress
 * decays to one probe an hour instead of twelve while staying self-healing.
 */
export const GECKO_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
/** Ceiling the doubling stops at (1 h). */
export const GECKO_BACKOFF_MAX_MS = 60 * 60_000;
/** Absolute ceiling, so an upstream Retry-After cannot park the feed for days. */
export const GECKO_BACKOFF_HARD_MAX_MS = 6 * 60 * 60_000;
/** ±10% spread, so N isolates do not all re-probe in the same second. */
export const GECKO_BACKOFF_JITTER = 0.1;
/**
 * Edge-cache TTL for GeckoTerminal subrequests, in seconds (see requestInit).
 *
 * WHY THE CACHE IS THE REAL FIX: the 429 is app-level rate limiting on
 * GeckoTerminal's side (`{"status":"429","title":"Rate Limited"}`) keyed on the
 * caller's IP, and Cloudflare Worker egress is a small shared pool — so the
 * quota is spent by other Workers before this one asks. Measured the same
 * minute from a normal host: `new_pools` and `trending_pools` both answered 200
 * with `cf-cache-status: HIT` (the public API serves `cache-control:
 * max-age=30, s-maxage=60` and Cloudflare caches it). A Worker subrequest does
 * NOT use that cache unless asked to, which is why every gecko call here was
 * billed to the shared IP; with cacheEverything the colo cache answers instead
 * and the origin limiter is never reached. 60s is the upstream's own s-maxage:
 * discovery only needs a coin's pool_created_at (it is evaluated when it ages
 * into the 80m–26h window), so a minute of staleness costs nothing.
 */
export const GECKO_CACHE_TTL_S = 60;
/**
 * SECOND host for the one path both serve keyless (see get): the same
 * `new_pools` payload is published by CoinGecko's Onchain API, and it is a
 * DIFFERENT hostname on a different rate-limit bucket, so a Worker whose
 * egress IP is over GeckoTerminal's quota can still discover.
 *
 * Why this is the shape of the compensation (measured 2026-09-21):
 * `api.geckoterminal.com` 429s the Worker's egress on every attempt while a
 * normal host answers 200, and the colo edge cache cannot heal it — a MISS
 * goes to the origin, the origin refuses to serve a 200, so nothing ever
 * enters the cache for the next request to HIT (`summary.gecko` live:
 * `ok2 429x2 cacheHits1 lastCacheStatus BYPASS`). The limiter is an IP quota,
 * so the only free lever left is asking a different host.
 *
 * SAME SHAPE, BUT KEYED ACCESS (clean-host measurements, 2026-09-21):
 * `/api/v3/onchain/networks/solana/new_pools` returns the identical
 * `{data:[{id:"solana_…", attributes:{pool_created_at, fdv_usd,
 * reserve_in_usd, transactions, volume_usd}, relationships.base_token}]}`
 * field set parseNewPools already reads, so the fallback needs no parser, and
 * one 07:57Z fetch even answered 200 / 29,960 bytes / 20 pools.
 *
 * That 200 does NOT reproduce — re-measured 08:22Z, three ways:
 *   no User-Agent          → 403 "Please add a descriptive User-Agent to your
 *                            request" (which is what a Worker's fetch sends)
 *   default/our User-Agent → 401 "Requests without API key are not allowed for
 *                            this endpoint"
 * so this host serves the fallback only WITH a key (see
 * AppConfig.coingeckoApiKey). The eligibility stays per-path because
 * `trending_pools` is key-gated on both hosts.
 */
export const GECKO_ALT_BASE_URL = "https://api.coingecko.com/api/v3/onchain";
/** Paths the alternate host serves without an API key (see GECKO_ALT_BASE_URL). */
const ALT_ELIGIBLE_PREFIX = "/networks/solana/new_pools";
/**
 * Descriptive User-Agent both hosts require.
 *
 * Measured 2026-09-21 with `/debug/gecko-alt` (the probe the fallback needed):
 * CoinGecko answers **403** with `"Please add a descriptive User-Agent to your
 * request"` to a keyless subrequest that has none — which is exactly what a
 * Worker's `fetch` sends by default (it is not curl). That single header is why
 * the alternate host looked unreachable from the Worker's egress while a normal
 * host got 200 from the same URL, so it is sent on BOTH hosts (they are both
 * CoinGecko's) and in every call, snapshot lookups included.
 */
export const GECKO_USER_AGENT =
  "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";
/** Header carrying a CoinGecko Demo-plan key (the free tier's keyed route). */
export const COINGECKO_DEMO_HEADER = "x-cg-demo-api-key";
/** Header carrying a CoinGecko Pro-plan key. */
export const COINGECKO_PRO_HEADER = "x-cg-pro-api-key";

/**
 * Whether `path` may be asked on the alternate host while the primary is
 * paused (pure — unit-tested). WITH a CoinGecko key the alternate is a full
 * mirror of the primary, so every path qualifies — and the key is also what
 * makes a request count against the key's quota instead of the shared egress
 * IP, i.e. the durable escape from the 429 (see AppConfig.coingeckoApiKey).
 *
 * KEYLESS (2026-09-21) the host answers 401 for *every* path, including
 * new_pools — the one 200 it served at 07:57Z did not reproduce. The keyless
 * branch is therefore kept NOT as a working fallback but as a bounded probe:
 * the refusal pause (see armAltPause) holds it to one request per escalated
 * window (5 → 60 min), so it costs ~nothing while self-healing the day the
 * keyless allowance opens or a key is configured. `geo` stays 0 until then.
 */
export function geckoAltEligible(path: string, keyed: boolean): boolean {
  return keyed || path.startsWith(ALT_ELIGIBLE_PREFIX);
}

export interface NewPool {
  tokenAddress: string;
  createdAtMs: number | null;
  dex: string;
  fdvUsd: number | null;
  reserveUsd: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cloudflare-only fetch options — absent from the standard RequestInit (this
 * repo compiles without workers-types), which is why they are declared here and
 * cast in requestInit. Ignored by any other runtime (the bot's Node entry
 * simply drops unknown init keys).
 */
interface CloudflareFetchInit extends RequestInit {
  cf?: {
    cacheEverything?: boolean;
    cacheTtl?: number;
    cacheTtlByStatus?: Record<string, number>;
  };
}

/**
 * Parse a `Retry-After` header into ms from `nowMs`. Accepts both documented
 * forms (delay-seconds and an HTTP-date) and returns null when the header is
 * missing, malformed, or already in the past — the caller then falls back to
 * its own escalated window. Pure, so the rule is unit-tested directly.
 */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (raw.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const secs = Number(raw);
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const delta = at - nowMs;
  return delta > 0 ? delta : null;
}

/**
 * How long to pause the feed after a 429 (pure — the escalation is asserted in
 * scripts/test-unit.js instead of being inferred from a live 429).
 *
 * `consecutive429` is 1 for the first 429, so the first window is still
 * GECKO_RATE_LIMIT_BACKOFF_MS (5 min — the behaviour the existing unit test and
 * the docs pin), and every further 429 in the same streak doubles it up to
 * GECKO_BACKOFF_MAX_MS. A Retry-After the API explicitly asked for wins, up to
 * the 6h hard ceiling. Jitter spreads the fleet's next probe.
 */
export function geckoBackoffMs(
  consecutive429: number,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(consecutive429));
  // 2**8 caps the shift; the min() below caps the value anyway.
  const doubled = GECKO_RATE_LIMIT_BACKOFF_MS * 2 ** Math.min(step - 1, 8);
  const base = Math.min(
    GECKO_BACKOFF_MAX_MS,
    Math.max(GECKO_RATE_LIMIT_BACKOFF_MS, doubled),
  );
  const asked =
    retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > base
      ? retryAfterMs
      : base;
  const capped = Math.min(GECKO_BACKOFF_HARD_MAX_MS, asked);
  const jitter = 1 + (random() * 2 - 1) * GECKO_BACKOFF_JITTER;
  return Math.round(capped * jitter);
}

/**
 * Per-isolate GeckoTerminal feed state, published on the tick summary (see
 * tickprobe) so `/health` can tell "the feed is empty" from "the feed is
 * rate-limited" without a separate probe. Before this the only signal was
 * `summary.geo: 0 / geoTrend: 0`, which looks the same whether the API is
 * blocked, the shape changed, or the market is quiet.
 */
export interface GeckoFeedStats {
  /** True once a client was built in this isolate (the worker always does). */
  active: boolean;
  /** True when every request carries a CoinGecko key (see AppConfig.coingeckoApiKey). */
  keyed: boolean;
  /** HTTP requests actually issued (backed-off calls cost 0). */
  requests: number;
  /** Responses that parsed as OK. */
  ok: number;
  /** 429s seen since the isolate booted. */
  http429: number;
  /** 429s in the current streak — the escalation input (0 after a success). */
  consecutive429: number;
  /** Subrequests the edge cache answered (`cf-cache-status: HIT`). */
  cacheHits: number;
  /** Upstream status of the newest request (0 = none yet). */
  lastStatus: number;
  /** `cf-cache-status` of the newest request (null when the header is absent). */
  lastCacheStatus: string | null;
  last429At: number;
  lastOkAt: number;
  /** Window applied by the newest 429 (0 = not backing off). */
  backoffMs: number;
  /** Epoch the current backoff expires at (0 = not backing off). */
  backoffUntil: number;
  /** Which host answered last: the primary, or the alternate fallback. */
  lastHost: "primary" | "alt" | null;
  /** Attempts against the alternate host while the primary is paused. */
  altAttempts: number;
  /** Alternate-host responses that parsed as OK. */
  altOk: number;
  /** Alternate-host 429s (its own bucket, so its pause is separate). */
  alt429: number;
  /** Failures (429 **or** a hard refusal) that armed the alternate's pause. */
  altFailures: number;
  /** HTTP status of the newest alternate-host failure (0 = none yet). */
  altLastStatus: number;
  /** Epoch the alternate host's pause expires at (0 = not paused). */
  altBackoffUntil: number;
}

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
 * The isolate's client, for telemetry only (see geckoFeedStats). The worker
 * builds exactly one per isolate, so a module-level handle is the cheapest
 * channel that reachable code can publish from.
 */
let lastClient: GeckoTerminalClient | null = null;

/** Feed state of this isolate's client, or an inactive zero record. */
export function geckoFeedStats(): GeckoFeedStats {
  if (lastClient === null) {
    return {
      active: false,
      keyed: false,
      requests: 0,
      ok: 0,
      http429: 0,
      consecutive429: 0,
      cacheHits: 0,
      lastStatus: 0,
      lastCacheStatus: null,
      last429At: 0,
      lastOkAt: 0,
      backoffMs: 0,
      backoffUntil: 0,
      lastHost: null,
      altAttempts: 0,
      altOk: 0,
      alt429: 0,
      altFailures: 0,
      altLastStatus: 0,
      altBackoffUntil: 0,
    };
  }
  return lastClient.stats();
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
  /** Keyed mode (see geckoAltEligible): every request carries this header. */
  private readonly apiKey: string | null;
  private readonly apiKeyHeader: string;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;
  /** Telemetry (see GeckoFeedStats) — never read by any decision. */
  private requests = 0;
  private ok = 0;
  private http429 = 0;
  private consecutive429 = 0;
  private cacheHits = 0;
  private lastStatus = 0;
  private lastCacheStatus: string | null = null;
  private last429At = 0;
  private lastOkAt = 0;
  private backoffMs = 0;
  /** See GeckoFeedStats.lastHost / alt* — the fallback host's own state. */
  private lastHost: "primary" | "alt" | null = null;
  private altAttempts = 0;
  private altOk = 0;
  private alt429 = 0;
  /** Every failure that paused the alternate — see armAltPause. */
  private altFailures = 0;
  private altLastStatus = 0;
  private altRateLimitedUntil = 0;

  constructor(config: AppConfig) {
    this.throttle = new Throttle(config.geckoterminalRequestIntervalMs);
    // A key moves the rate limit from the caller's shared egress IP onto the
    // key itself — the only lever that survives a poisoned IP pool.
    this.apiKey = config.coingeckoApiKey ?? null;
    this.apiKeyHeader =
      config.coingeckoApiPlan === "pro" ? COINGECKO_PRO_HEADER : COINGECKO_DEMO_HEADER;
    // Publish this client's feed state (see geckoFeedStats).
    lastClient = this;
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** Feed state for /health (see GeckoFeedStats). */
  stats(): GeckoFeedStats {
    return {
      active: true,
      keyed: this.apiKey !== null,
      requests: this.requests,
      ok: this.ok,
      http429: this.http429,
      consecutive429: this.consecutive429,
      cacheHits: this.cacheHits,
      lastStatus: this.lastStatus,
      lastCacheStatus: this.lastCacheStatus,
      last429At: this.last429At,
      lastOkAt: this.lastOkAt,
      backoffMs: this.backoffMs,
      backoffUntil: this.rateLimitedUntil,
      lastHost: this.lastHost,
      altAttempts: this.altAttempts,
      altOk: this.altOk,
      alt429: this.alt429,
      altFailures: this.altFailures,
      altLastStatus: this.altLastStatus,
      altBackoffUntil: this.altRateLimitedUntil,
    };
  }

  /**
   * Fetch init for every GeckoTerminal call: JSON, a descriptive User-Agent
   * (see GECKO_USER_AGENT — without it CoinGecko 403s the Worker's egress), a
   * 10s transport cap, and the Cloudflare edge cache (see GECKO_CACHE_TTL_S).
   * `cacheTtlByStatus` keeps error responses — a 429 in particular — out of the
   * cache, so a bad minute can never be served to the next tick as if it were a
   * fresh feed.
   */
  private requestInit(): CloudflareFetchInit {
    const init: CloudflareFetchInit = {
      headers: {
        Accept: "application/json",
        "User-Agent": GECKO_USER_AGENT,
        ...(this.apiKey !== null ? { [this.apiKeyHeader]: this.apiKey } : {}),
      },
      signal: AbortSignal.timeout(10_000),
      cf: {
        cacheEverything: true,
        cacheTtl: GECKO_CACHE_TTL_S,
        cacheTtlByStatus: {
          "200-299": GECKO_CACHE_TTL_S,
          "300-399": 0,
          "400-599": 0,
        },
      },
    };
    return init;
  }

  /**
   * Shared GET: throttle-spaced, 429-aware, cache-friendly. Returns the parsed
   * JSON on success, null on rate-limit (escalating the backoff window) or any
   * other failure — callers degrade to [] without throwing.
   *
   * ONE FALLBACK HOST, ONLY WHILE THE PRIMARY IS PAUSED (2026-09-21): the
   * limiter is an IP quota on GeckoTerminal's side, and a poisoned quota never
   * heals through the edge cache (a MISS reaches the origin, the origin 429s,
   * nothing is cached for the next request to HIT). CoinGecko's Onchain API
   * serves the same `new_pools` payload from a different hostname, so while
   * the primary is paused an eligible path is asked there instead. The
   * primary's backoff is NOT cleared by an alternate success — its escalation
   * is a fact about the primary — and the alternate has its OWN pause that is
   * armed only by its own 429, so the cost when both are blocked is one probe
   * per alternate window, not one per tick.
   *
   * KEYED MODE (see AppConfig.coingeckoApiKey): with a CoinGecko key every
   * request carries it, so the quota is the key's rather than the shared
   * egress IP's — the primary stops being 429ed at all — and the alternate
   * becomes a full mirror (see geckoAltEligible). Unkeyed behaviour is
   * unchanged.
   *
   * ANY failure pauses the alternate, not just a 429 (see armAltPause): live
   * 2026-09-21 the Worker's egress got a 403 there, which is a refusal rather
   * than a rate limit, and without this the fallback would have spent a request
   * per tick for nothing.
   */
  private async get(path: string): Promise<unknown> {
    if (this.rateLimited()) {
      const now = Date.now();
      if (
        !geckoAltEligible(path, this.apiKey !== null) ||
        now < this.altRateLimitedUntil
      ) {
        return null;
      }
      this.altAttempts += 1;
      return this.attempt(GECKO_ALT_BASE_URL, path, true);
    }
    return this.attempt(BASE_URL, path, false);
  }

  /**
   * Arm the fallback's own pause. A 429 and a hard refusal share ONE
   * escalation: both mean "the alternate is not usable right now", and the
   * only difference is what the log says. What matters is that the fallback
   * stops asking — without this, a 403 (its live shape from the Worker's own
   * egress) spent one request per tick forever while `geo` stayed 0.
   */
  private armAltPause(
    path: string,
    status: number,
    retryAfterMs: number | null = null,
  ): void {
    this.altFailures += 1;
    this.altLastStatus = status;
    const window = geckoBackoffMs(this.altFailures, retryAfterMs);
    this.altRateLimitedUntil = Date.now() + window;
    console.warn(
      `[gecko] alternate host ${status} on ${path} (failure #${this.altFailures}) — pausing it ${Math.round(
        window / 1000,
      )}s (primary still paused)`,
    );
  }

  /**
   * One request against one host, with the counter/backoff bookkeeping for
   * whichever side it belongs to (see get). Never throws.
   */
  private async attempt(
    baseUrl: string,
    path: string,
    alt: boolean,
  ): Promise<unknown> {
    try {
      const res = await this.throttle.run(() =>
        fetch(`${baseUrl}${path}`, this.requestInit()),
      );
      this.requests += 1;
      this.lastStatus = res.status;
      const cacheStatus = res.headers.get("cf-cache-status");
      this.lastCacheStatus = cacheStatus;
      if (cacheStatus !== null && /^(HIT|REVALIDATED)$/i.test(cacheStatus)) {
        this.cacheHits += 1;
      }
      if (res.status === 429) {
        const now = Date.now();
        this.last429At = now;
        const asked = parseRetryAfterMs(res.headers.get("retry-after"), now);
        if (alt) {
          this.alt429 += 1;
          this.armAltPause(path, 429, asked);
          return null;
        }
        this.http429 += 1;
        this.consecutive429 += 1;
        this.backoffMs = geckoBackoffMs(this.consecutive429, asked);
        this.rateLimitedUntil = now + this.backoffMs;
        console.warn(
          `[gecko] 429 #${this.consecutive429} on ${path} — pausing the feed ${Math.round(
            this.backoffMs / 1000,
          )}s${asked !== null ? ` (retry-after ${Math.round(asked / 1000)}s)` : ""}`,
        );
        return null;
      }
      if (!res.ok) {
        // A hard refusal (401/403/5xx) is NOT a rate limit — it means the
        // alternate does not serve this path keyless, or its edge blocks the
        // Worker's egress. Deployed 2026-09-21 this was the live shape (a 403
        // per tick, zero payoff), so it pauses the fallback exactly like a 429
        // does: one probe per escalated window, which still self-heals if the
        // refusal is lifted or a key is configured.
        if (alt) this.armAltPause(path, res.status);
        return null;
      }
      if (alt) {
        if (this.altFailures > 0) {
          console.log(
            `[gecko] alternate host recovered after ${this.altFailures} failure(s)`,
          );
          this.altFailures = 0;
        }
        this.altOk += 1;
        this.lastOkAt = Date.now();
        this.lastHost = "alt";
        console.log(
          `[gecko] discovery served by the alternate host (primary still paused ${Math.round(
            Math.max(0, this.rateLimitedUntil - Date.now()) / 1000,
          )}s)`,
        );
        return res.json();
      }
      if (this.consecutive429 > 0) {
        console.log(
          `[gecko] feed recovered after ${this.consecutive429} consecutive 429(s)`,
        );
        this.consecutive429 = 0;
        this.backoffMs = 0;
      }
      this.ok += 1;
      this.lastOkAt = Date.now();
      this.lastHost = "primary";
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
