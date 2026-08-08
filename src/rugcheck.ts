import type { AppConfig } from "./config";

const BASE_URL = "https://api.rugcheck.xyz";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay well under RugCheck's rate limits. */
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

export interface RugcheckReport {
  /** Share of total supply held by insider/bundler networks, in percent. */
  bundlerPct: number | null;
  /**
   * Combined share of the top 10 REAL holders, in percent — the liquidity
   * pool (matched by the pair address) is excluded from the ranking.
   */
  top10HolderPct: number | null;
}

interface InsiderNetwork {
  tokenAmount?: number;
}

interface TopHolder {
  address?: string;
  owner?: string;
  pct?: number;
}

/**
 * RugCheck token report (public API, no key required).
 *
 * Both metrics come from a single report fetch:
 * - bundler/insider share of supply (a public-data proxy for Axiom's "bundlers %",
 *   which has no public API),
 * - top-10 holder concentration (sum of the 10 largest holder percentages).
 */
export class RugcheckClient {
  private readonly throttle: Throttle;

  constructor(config: AppConfig) {
    this.throttle = new Throttle(config.rugcheckRequestIntervalMs);
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
          throw new Error(`RugCheck HTTP ${res.status}`);
        }
        if (!res.ok) {
          throw new Error(`RugCheck HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 2000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("RugCheck request failed");
  }

  /**
   * Fetches the token report once and derives both percentages.
   *
   * @param address token mint address
   * @param pairAddress the trading-pool address, used to exclude the LP from
   *   the top-10 holder ranking (its holding is locked liquidity, not
   *   concentration risk).
   */
  async getReport(address: string, pairAddress?: string): Promise<RugcheckReport> {
    const data = (await this.getJson(
      `/v1/tokens/${encodeURIComponent(address)}/report`,
    )) as {
      token?: { supply?: number };
      insiderNetworks?: InsiderNetwork[];
      topHolders?: TopHolder[];
    } | null;

    // Bundler/insider share of supply.
    const supply = Number(data?.token?.supply ?? 0);
    const networks = data?.insiderNetworks;
    let bundlerPct: number | null = null;
    if (Array.isArray(networks) && networks.length > 0 && supply > 0) {
      let bundled = 0;
      for (const network of networks) {
        bundled += Number(network.tokenAmount ?? 0);
      }
      const pct = (bundled / supply) * 100;
      bundlerPct = Number.isFinite(pct) && pct > 0 ? pct : null;
    }

    // Top-10 holder concentration, excluding the liquidity pool.
    const holders = data?.topHolders;
    let top10HolderPct: number | null = null;
    if (Array.isArray(holders) && holders.length > 0) {
      const pool = pairAddress ? pairAddress.toLowerCase() : "";
      const realHolders = holders.filter((holder) => {
        if (!pool) return true;
        const addr = (holder.address ?? "").toLowerCase();
        const owner = (holder.owner ?? "").toLowerCase();
        return addr !== pool && owner !== pool;
      });
      const top10 = realHolders.slice(0, 10);
      let total = 0;
      for (const holder of top10) {
        total += Number(holder.pct ?? 0);
      }
      top10HolderPct = Number.isFinite(total) && total > 0 ? total : null;
    }

    return { bundlerPct, top10HolderPct };
  }
}
