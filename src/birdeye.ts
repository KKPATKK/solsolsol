import type { AppConfig } from "./config";

const BASE_URL = "https://public-api.birdeye.so";

interface OhlcvItem {
  unixTime: number;
  /** Token-unit volume (NOT USD). */
  v?: number;
  /** USD volume of the candle. */
  vUsd?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay well under Birdeye's rate limits. */
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

export class BirdeyeClient {
  private readonly throttle: Throttle;
  private readonly apiKey: string;

  constructor(config: AppConfig) {
    if (!config.birdeyeApiKey) {
      throw new Error("BIRDEYE_API_KEY is not configured");
    }
    this.apiKey = config.birdeyeApiKey;
    this.throttle = new Throttle(config.birdeyeRequestIntervalMs);
  }

  private async getJson(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}`, {
            headers: {
              "X-API-KEY": this.apiKey,
              "x-chain": "solana",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Birdeye HTTP ${res.status}`);
        }
        if (!res.ok) {
          throw new Error(`Birdeye HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 2000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Birdeye request failed");
  }

  /**
   * Exact volume traded during the first 60 seconds after listing, summed from
   * 1-minute OHLCV candles. Returns null when the data is unavailable.
   *
   * @param address token mint address
   * @param createdAtSec pair creation time in Unix seconds
   */
  async getFirstMinuteVolume(
    address: string,
    createdAtSec: number,
  ): Promise<number | null> {
    const from = Math.floor(createdAtSec);
    const to = from + 60;
    const data = (await this.getJson(
      `/defi/ohlcv?address=${encodeURIComponent(address)}&type=1m&time_from=${from}&time_to=${to}&currency=usd`,
    )) as { success?: boolean; data?: { items?: OhlcvItem[] } } | null;

    const items = data?.data?.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    let total = 0;
    let found = false;
    for (const item of items) {
      // Candle bucket starts at unixTime and spans [unixTime, unixTime + 60).
      if (item.unixTime >= from && item.unixTime < to) {
        const usd = Number(item.vUsd);
        if (Number.isFinite(usd) && usd > 0) {
          total += usd;
          found = true;
        }
      }
    }
    return found ? total : null;
  }

  /**
   * Trader insights from a single top-traders fetch:
   * - proTraders: how many of the top traders (by 24h volume) have positive
   *   realized PnL,
   * - sniperPct: share of the token's total supply that wallets Birdeye tags
   *   as snipers bought (sum of their buy volume ÷ supply × 100). This
   *   measures sniper *participation* — it stays meaningful after snipers
   *   dump, unlike a "currently held" figure — and matches the scale of
   *   Axiom's sniper metric.
   * Both are null only when the endpoint has no trader data yet, or when the
   * supply cannot be derived from price.
   */
  async getTraderInfo(
    address: string,
    marketCapUsd: number,
    priceUsd: number | string,
  ): Promise<{ proTraders: number | null; sniperPct: number | null }> {
    const data = (await this.getJson(
      `/defi/v2/tokens/top_traders?chain=solana&address=${encodeURIComponent(
        address,
      )}&timeframe=24h&sort_by=volume&limit=10`,
    )) as {
      data?: {
        items?: Array<{
          tags?: string[];
          realizedPnl?: number;
          volumeBuy?: number;
        }>;
      };
    } | null;

    const items = data?.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { proTraders: null, sniperPct: null };
    }

    const price = Number(priceUsd);
    const supply = price > 0 ? marketCapUsd / price : 0;

    let pro = 0;
    let sniperBuy = 0;
    for (const trader of items) {
      if (Number(trader.realizedPnl ?? 0) > 0) pro++;
      if ((trader.tags ?? []).includes("sniper")) {
        const buy = Number(trader.volumeBuy ?? 0);
        if (Number.isFinite(buy) && buy > 0) sniperBuy += buy;
      }
    }

    let sniperPct: number | null = null;
    if (supply > 0) {
      const pct = (sniperBuy / supply) * 100;
      // 0% is a real result (no sniper buys detected), not missing data.
      sniperPct = Number.isFinite(pct) ? Math.min(100, pct) : null;
    }
    return { proTraders: pro, sniperPct };
  }

  /**
   * Lowest market cap since listing, estimated from the candle low × supply.
   * Uses 1-minute candles for coins under 6h old, 15-minute for older ones.
   */
  async getMinMarketCapUsd(
    address: string,
    createdAtSec: number,
    supply: number,
  ): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000);
    const rangeSec = Math.max(60, now - Math.floor(createdAtSec));
    const type = rangeSec <= 6 * 3600 ? "1m" : "15m";

    const data = (await this.getJson(
      `/defi/ohlcv?address=${encodeURIComponent(
        address,
      )}&type=${type}&time_from=${Math.floor(createdAtSec)}&time_to=${now}&currency=usd`,
    )) as { data?: { items?: Array<{ l?: number }> } } | null;

    const items = data?.data?.items;
    if (!Array.isArray(items) || items.length === 0 || supply <= 0) return null;

    let minLow = Infinity;
    for (const item of items) {
      const low = Number(item.l);
      if (Number.isFinite(low) && low > 0 && low < minLow) minLow = low;
    }
    if (!Number.isFinite(minLow)) return null;

    const minMc = minLow * supply;
    return Number.isFinite(minMc) && minMc > 0 ? minMc : null;
  }
}
