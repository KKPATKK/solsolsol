import type { AppConfig } from "./config";

/**
 * GMGN OpenAPI client — market/token read endpoints used for (a) candidate
 * enrichment (smart-money count, wash-trading flag, holders) and (b) the
 * trending discovery feed. Auth for these read endpoints is just the
 * X-APIKEY header + `timestamp` + `client_id` query params (no request
 * signature — that's only required for swap/order routes).
 *
 * Base URL and auth model verified against gmgn-skills (GMGNAI/gmgn-skills,
 * src/client/OpenApiClient.ts): GET /v1/market/rank (trending) and
 * GET /v1/token/info both use `authExistRequest` (X-APIKEY only).
 */

const BASE_URL = "https://openapi.gmgn.ai";

/**
 * Back off ALL GMGN calls for this long after one 429 — the same policy the
 * GeckoTerminal and Jupiter token clients already use.
 *
 * 2026-09-21: GMGN 429s a Cloudflare Worker's shared egress IP for the whole
 * window (the repo's own note on the gecko trending feed: "the replacement for
 * GMGN trending (GMGN's edge blocks Cloudflare Worker egress with 429)"), and
 * /debug/gmgn answered `GMGN HTTP 429` on every live sample. Without this
 * window the client's 2s/4s retry ladder re-hit the same wall EVERY time, and
 * the cost is not the one request the caller sees: `getJson`'s retry chain
 * keeps running ~6s in the background after the caller's deadline race has
 * already given up — once per tick for the discovery feed and once per
 * CANDIDATE for the enrichment — competing with the eval and push phases for
 * the isolate, inside a tick envelope sized (worker.SCAN_TICK_BUDGET_MS)
 * against a ~9.6s kill. Retrying an IP-level rate limit inside the same tick
 * was never going to succeed; one attempt per window can, and it keeps GMGN a
 * cheap standing probe instead of a per-tick cost.
 */
export const GMGN_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay under GMGN's rate limit. */
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

export interface GmgnTokenInfo {
  /** Smart-money wallets (wallet_tags_stat.smart_wallets) — GMGN's key signal. */
  smartWallets: number | null;
  holderCount: number | null;
  /** Explicit wash-trading flag (only from the trending feed; token info has none). */
  isWashTrading: boolean | null;
  degenCalls: number | null;
  buyVolume5m: number | null;
  sellVolume5m: number | null;
}

export interface GmgnTrendingItem {
  address: string;
  symbol?: string;
  name?: string;
  marketCap: number | null;
  liquidity: number | null;
  volume1h: number | null;
  holderCount: number | null;
  smartDegenCount: number | null;
  isWashTrading: boolean;
  createdAtMs: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** GMGN timestamps are unix SECONDS; ms timestamps (<1e12) pass through. */
const toMs = (v: unknown): number | null => {
  const n = num(v);
  if (n === null) return null;
  return n < 1e12 ? n * 1000 : n;
};

const boolOrNull = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** Pure parser for GET /v1/market/rank (trending) — exported for tests. */
export function parseTrending(data: unknown): GmgnTrendingItem[] {
  const rank = Array.isArray(data)
    ? data
    : (data as { rank?: unknown } | null)?.rank;
  if (!Array.isArray(rank)) return [];
  const out: GmgnTrendingItem[] = [];
  for (const raw of rank) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const address = String(item.address ?? "");
    if (!address) continue;
    out.push({
      address,
      symbol: typeof item.symbol === "string" ? item.symbol : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      marketCap: num(item.usd_market_cap ?? item.market_cap),
      liquidity: num(item.liquidity),
      volume1h: num(item.volume ?? item.volume_1h),
      holderCount: num(item.holder_count),
      smartDegenCount: num(item.smart_degen_count),
      isWashTrading: item.is_wash_trading === true,
      createdAtMs: toMs(
        item.creation_timestamp ?? item.created_timestamp ?? item.created_at,
      ),
    });
  }
  return out;
}

/** Pure parser for GET /v1/token/info — exported for tests. */
export function parseTokenInfo(data: unknown): GmgnTokenInfo | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const price =
    obj.price && typeof obj.price === "object"
      ? (obj.price as Record<string, unknown>)
      : {};
  const stat =
    obj.stat && typeof obj.stat === "object"
      ? (obj.stat as Record<string, unknown>)
      : {};
  const walletTags =
    obj.wallet_tags_stat && typeof obj.wallet_tags_stat === "object"
      ? (obj.wallet_tags_stat as Record<string, unknown>)
      : {};
  return {
    smartWallets: num(walletTags.smart_wallets),
    holderCount: num(obj.holder_count ?? stat.holder_count),
    isWashTrading: null, // token/info has no wash-trading flag (trending only)
    degenCalls: num(stat.degen_call_count),
    buyVolume5m: num(price.buy_volume_5m),
    sellVolume5m: num(price.sell_volume_5m),
  };
}

/**
 * Feed state for telemetry, published by the isolate's client (see
 * gmgnFeedStats). Never read by any decision.
 */
export interface GmgnFeedStats {
  /** False when this isolate has not built a client (disabled / no key). */
  active: boolean;
  requests: number;
  http429: number;
  consecutive429: number;
  lastStatus: number;
  last429At: number;
  lastOkAt: number;
  backoffMs: number;
  backoffUntil: number;
}

/**
 * The isolate's client, for telemetry only (same channel as
 * geckoterminal.geckoFeedStats): the worker builds exactly one per isolate and
 * the summary is what the completion heartbeat serializes.
 */
let lastClient: GmgnClient | null = null;

/** Feed state of this isolate's client, or an inactive zero record. */
export function gmgnFeedStats(): GmgnFeedStats {
  if (lastClient === null) {
    return {
      active: false,
      requests: 0,
      http429: 0,
      consecutive429: 0,
      lastStatus: 0,
      last429At: 0,
      lastOkAt: 0,
      backoffMs: 0,
      backoffUntil: 0,
    };
  }
  return lastClient.stats();
}

export class GmgnClient {
  private readonly throttle: Throttle;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;
  /** Telemetry (see GmgnFeedStats) — never read by any decision. */
  private requests = 0;
  private http429 = 0;
  private consecutive429 = 0;
  private lastStatus = 0;
  private last429At = 0;
  private lastOkAt = 0;
  private backoffMs = 0;

  constructor(private readonly config: AppConfig) {
    this.throttle = new Throttle(config.gmgnRequestIntervalMs);
    // Publish this client's feed state (see gmgnFeedStats).
    lastClient = this;
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** Feed state for /health (see GmgnFeedStats). */
  stats(): GmgnFeedStats {
    return {
      active: true,
      requests: this.requests,
      http429: this.http429,
      consecutive429: this.consecutive429,
      lastStatus: this.lastStatus,
      last429At: this.last429At,
      lastOkAt: this.lastOkAt,
      backoffMs: this.backoffMs,
      backoffUntil: this.rateLimitedUntil,
    };
  }

  /**
   * GET with X-APIKEY auth + timestamp/client_id, retries 5xx (2s/4s
   * backoff), unwraps the `{ code, data }` envelope when present.
   * Deterministic 4xx returns null (retrying never helps).
   *
   * A 429 is NOT a retry case: it arms the shared backoff window and returns
   * null immediately (see GMGN_RATE_LIMIT_BACKOFF_MS), so the caller's deadline
   * race cannot leave a retry chain running in the background. While the
   * window is armed every call returns null before touching the network.
   */
  private async getJson(
    path: string,
    query: Record<string, string | number>,
  ): Promise<unknown> {
    if (this.rateLimited()) return null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) params.set(k, String(v));
        params.set("timestamp", String(Math.floor(Date.now() / 1000)));
        params.set("client_id", crypto.randomUUID());
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}?${params.toString()}`, {
            headers: {
              "X-APIKEY": this.config.gmgnApiKey ?? "",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
          }),
        );
        this.requests += 1;
        this.lastStatus = res.status;
        if (res.status === 429 || res.status >= 500) {
          // Surface the API's error detail (RATE_LIMIT_EXCEEDED vs
          // RATE_LIMIT_BANNED + reset_at) for diagnostics via /debug/gmgn.
          let detail = "";
          try {
            const body = (await res.json()) as {
              msg?: string;
              data?: { reset_at?: number | string };
            };
            const reset = body.data?.reset_at;
            detail = ` ${body.msg ?? ""}${reset !== undefined ? ` reset=${reset}` : ""}`.trim();
          } catch {
            // body not JSON — keep the plain status
          }
          if (res.status === 429) {
            // Rate limit: pause the client instead of retrying into the same
            // wall (see GMGN_RATE_LIMIT_BACKOFF_MS).
            this.http429 += 1;
            this.consecutive429 += 1;
            this.last429At = Date.now();
            this.backoffMs = GMGN_RATE_LIMIT_BACKOFF_MS;
            this.rateLimitedUntil = this.last429At + this.backoffMs;
            console.warn(
              `[gmgn] 429${detail} — pausing the client ${Math.round(
                this.backoffMs / 1000,
              )}s (one probe per window instead of a retry ladder per tick)`,
            );
            return null;
          }
          throw new Error(`GMGN HTTP ${res.status}${detail}`);
        }
        if (!res.ok) return null; // 4xx — deterministic
        const body = (await res.json()) as { data?: unknown };
        // Unwrap the { code, msg, data } envelope, repeatedly — the read
        // endpoints nest it twice (observed 2026-08-16:
        // {code,data:{code,data:{rank}}}) while token/info's payload has no
        // `data` key of its own, so the loop terminates on the real object.
        this.lastOkAt = Date.now();
        if (this.consecutive429 > 0) {
          console.log(
            `[gmgn] client recovered after ${this.consecutive429} consecutive 429(s)`,
          );
          this.consecutive429 = 0;
          this.backoffMs = 0;
          this.rateLimitedUntil = 0;
        }
        let unwrapped: unknown = body;
        while (
          unwrapped !== null &&
          typeof unwrapped === "object" &&
          (unwrapped as { data?: unknown }).data !== undefined
        ) {
          unwrapped = (unwrapped as { data?: unknown }).data;
        }
        return unwrapped;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 2000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("GMGN request failed");
  }

  /**
   * GMGN Trending — momentum-ranked candidates (used as a discovery feed).
   * Same endpoint + filters as the gmgn-vl-radar project, minus the strict
   * gates (those stay per-chat in the scanner).
   */
  async fetchTrending(limit: number): Promise<GmgnTrendingItem[]> {
    const data = await this.getJson("/v1/market/rank", {
      chain: "sol",
      interval: "1h",
      limit,
      order_by: "volume",
      direction: "desc",
    });
    return parseTrending(data);
  }

  /**
   * One-token snapshot for candidate enrichment: smart-money activity,
   * wash-trading flag and holder count. Defensive field probing — the
   * response nests some fields under `price` (gmgn-cli prints the data
   * object whose token metrics live in the `price` subtree).
   */
  async fetchTokenInfo(address: string): Promise<GmgnTokenInfo | null> {
    const data = await this.getJson("/v1/token/info", {
      chain: "sol",
      address,
    });
    return parseTokenInfo(data);
  }
}
