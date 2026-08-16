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

export class GmgnClient {
  private readonly throttle: Throttle;

  constructor(private readonly config: AppConfig) {
    this.throttle = new Throttle(config.gmgnRequestIntervalMs);
  }

  /**
   * GET with X-APIKEY auth + timestamp/client_id, retries for 429/5xx
   * (2s/4s backoff), unwraps the `{ code, data }` envelope when present.
   * Deterministic 4xx returns null (retrying never helps).
   */
  private async getJson(
    path: string,
    query: Record<string, string | number>,
  ): Promise<unknown> {
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
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`GMGN HTTP ${res.status}`);
        }
        if (!res.ok) return null; // 4xx — deterministic
        const body = (await res.json()) as { data?: unknown };
        // Unwrap the { code, msg, data } envelope, repeatedly — the read
        // endpoints nest it twice (observed 2026-08-16:
        // {code,data:{code,data:{rank}}}) while token/info's payload has no
        // `data` key of its own, so the loop terminates on the real object.
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
