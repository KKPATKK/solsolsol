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
  priceChange: { m5: number };
  liquidity: { usd: number | null };
  pairCreatedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export class DexScreenerClient {
  private readonly throttle: Throttle;

  constructor(private readonly config: AppConfig) {
    this.throttle = new Throttle(config.dexRequestIntervalMs);
  }

  private async getJson(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`DexScreener HTTP ${res.status}`);
        }
        if (!res.ok) {
          // Deterministic client errors (e.g. 404/400: a token without pairs
          // or a bad batch) will never succeed on retry — treat as empty
          // instead of burning 3 attempts × backoff per dead token. The
          // re-evaluation pool regularly contains delisted coins, so this
          // saves ~8s per failing batch.
          return null;
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 2000);
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
   */
  async fetchPairsForTokens(addresses: string[]): Promise<Map<string, PairInfo>> {
    const result = new Map<string, PairInfo>();
    for (let i = 0; i < addresses.length; i += 30) {
      const batch = addresses.slice(i, i + 30);
      const data = (await this.getJson(
        `/latest/dex/tokens/${batch.join(",")}`,
      )) as { pairs?: Array<Record<string, unknown>> } | null;
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
        const priceChange = raw.priceChange as { m5?: number } | undefined;
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
          },
          liquidity: {
            usd: Number((raw.liquidity as { usd?: number } | undefined)?.usd ?? 0) || null,
          },
          pairCreatedAt: Number(raw.pairCreatedAt ?? 0),
        });
      }
    }
    return result;
  }
}
