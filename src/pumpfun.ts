import type { AppConfig } from "./config";
import type { TokenProfile } from "./dexscreener";

const BASE_URL = "https://frontend-api.pump.fun";
/**
 * pump.fun's frontend API caps page size at 20 — requesting more returns
 * fewer. Paginate with `offset` to gather a full batch.
 */
const PAGE_SIZE = 20;
/** How many HTTP requests a single paginated feed may make at most. */
const MAX_PAGES = 15;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay well under pump.fun's rate limits. */
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

interface PumpCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  /** Creation time in milliseconds (frontend API convention). */
  created_timestamp?: number;
}

/**
 * Normalize a pump.fun /coins response into TokenProfile entries (pure —
 * unit-tested). Junk entries (missing mint, wrong shapes) are dropped;
 * non-array input yields [] so callers can treat a bad response as an empty
 * feed instead of crashing the scan.
 */
export function parsePumpCoins(data: unknown): TokenProfile[] {
  if (!Array.isArray(data)) return [];
  const out: TokenProfile[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const c = item as PumpCoin;
    const tokenAddress = typeof c.mint === "string" ? c.mint.trim() : "";
    if (!tokenAddress) continue;
    const created =
      typeof c.created_timestamp === "number" && c.created_timestamp > 0
        ? c.created_timestamp
        : undefined;
    out.push({
      tokenAddress,
      name: typeof c.name === "string" ? c.name : undefined,
      symbol: typeof c.symbol === "string" ? c.symbol : undefined,
      openTimestamp: created,
    });
  }
  return out;
}

/**
 * Discovery feed for brand-new Solana meme coins from pump.fun's public
 * frontend API. This is the widest free source of new coins: DexScreener's
 * token-profiles feed only returns ~24 Solana profiles per scan, while
 * pump.fun lists every coin created on the platform (pre- and
 * post-graduation) — the coins DexScreener never shows.
 *
 * pump.fun aggressively blocks datacenter IPs, so every failure mode is
 * handled gracefully: 4xx/5xx, HTML challenge pages and JSON that doesn't
 * parse all degrade to [] and the scanner continues on DexScreener alone
 * (the pump counter on /health shows whether discovery is live).
 */
export class PumpFunClient {
  private readonly throttle: Throttle;

  constructor(config: AppConfig) {
    this.throttle = new Throttle(config.pumpfunRequestIntervalMs);
  }

  private async getJson(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`pump.fun HTTP ${res.status}`);
        }
        if (!res.ok) return null; // 403/404 — blocked or endpoint moved
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return null; // challenge/HTML page masquerading as HTTP 200
        }
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 1000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("pump.fun request failed");
  }

  /**
   * Newest coins first, up to `limit` (each page is capped at 20 by the API,
   * so pages until the batch is full or the feed stops advancing). Returns
   * [] on any failure — the scanner treats discovery as best-effort.
   */
  async fetchNewestCoins(limit: number): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 300));
    const out: TokenProfile[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES && out.length < wanted; page++) {
      const data = await this.getJson(
        `/coins?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=created&order=DESC`,
      );
      if (!Array.isArray(data) || data.length === 0) break;
      let added = 0;
      for (const p of parsePumpCoins(data)) {
        if (seen.has(p.tokenAddress)) continue;
        seen.add(p.tokenAddress);
        out.push(p);
        added++;
      }
      if (data.length < PAGE_SIZE) break; // last page
      if (added === 0) break; // offset not advancing — stop at one page
    }
    return out.slice(0, wanted);
  }

  /**
   * Page backwards through newly created coins (used by the one-time
   * backfill script) and return coins created at/after `cutoffMs`. Stops
   * when a page's oldest coin is older than the cutoff, when the feed stops
   * advancing (offset unsupported), or after `maxPages`.
   */
  async fetchCoinsBefore(
    cutoffMs: number,
    opts: { maxPages?: number } = {},
  ): Promise<TokenProfile[]> {
    const maxPages = opts.maxPages ?? 1500;
    const out: TokenProfile[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const data = await this.getJson(
        `/coins?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=created&order=DESC`,
      );
      if (!Array.isArray(data) || data.length === 0) break;
      let added = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const p of parsePumpCoins(data)) {
        if (p.openTimestamp === undefined) continue;
        oldest = Math.min(oldest, p.openTimestamp);
        if (p.openTimestamp < cutoffMs) continue;
        if (seen.has(p.tokenAddress)) continue;
        seen.add(p.tokenAddress);
        out.push(p);
        added++;
      }
      if (added === 0) break; // offset not advancing — stop
      if (oldest < cutoffMs) break; // swept past the cutoff
    }
    return out;
  }
}
