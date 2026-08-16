import type { AppConfig } from "./config";

const BASE_URL = "https://api.geckoterminal.com/api/v2";

export interface NewPool {
  tokenAddress: string;
  createdAtMs: number | null;
  dex: string;
  fdvUsd: number | null;
  reserveUsd: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  constructor(config: AppConfig) {
    this.throttle = new Throttle(config.geckoterminalRequestIntervalMs);
  }

  async fetchNewPools(page = 1): Promise<NewPool[]> {
    try {
      const res = await this.throttle.run(() =>
        fetch(`${BASE_URL}/networks/solana/new_pools?page=${page}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!res.ok) return [];
      return parseNewPools(await res.json());
    } catch {
      return [];
    }
  }

  /**
   * Momentum feed — GeckoTerminal's trending pools (free, no key, verified
   * reachable 2026-08-16). Same item shape as new_pools (base_token in
   * relationships, pool_created_at ISO), so parseNewPools is reused. Sized by
   * GECKOTERMINAL_TRENDING_LIMIT (0 = disabled); the endpoint returns up to
   * 20 pools per call.
   */
  async fetchTrendingPools(limit: number): Promise<NewPool[]> {
    try {
      const res = await this.throttle.run(() =>
        fetch(
          `${BASE_URL}/networks/solana/trending_pools?include=base_token&limit=${Math.min(
            Math.max(1, Math.floor(limit)),
            20,
          )}`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          },
        ),
      );
      if (!res.ok) return [];
      return parseNewPools(await res.json());
    } catch {
      return [];
    }
  }
}
