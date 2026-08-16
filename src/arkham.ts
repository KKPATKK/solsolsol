import type { AppConfig } from "./config";

/**
 * Arkham Intelligence API client — top token holders with entity/label
 * attribution (used for "smart money" detection on qualifying candidates).
 *
 * Auth is a single `API-Key` header (key from arkm.com/api-dashboard).
 * Endpoint verified against arkm.com/llms/get-token-holders-chain-address.md:
 *   GET https://api.arkm.com/token/holders/{chain}/{address}?limit=100&offset=0
 *   → { token, totalSupply, addressTopHolders: { solana: [{ address:
 *       { address, arkhamEntity: { id, name, type }, arkhamLabel: {...} },
 *       balance, pctOfCap, usd }] } }
 * `pctOfCap` is a FRACTION (0.06 = 6% of supply). Cost: 30 credits/call
 * (the free trial grants 1M credits ≈ 33K calls — negligible at our
 * ~2 candidates/tick rate). Only runs when ARKHAM_API_KEY is configured;
 * otherwise the card line shows 未配置 and nothing is called.
 */

const BASE_URL = "https://api.arkm.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out HTTP requests so we stay under Arkham's rate limits. */
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
 * Default entity types counted as "smart money". Arkham's `type` field is
 * a short slug (cex/fund/whale/...) assigned by their ULTRA attribution
 * system; the exact vocabulary isn't published as an enum, so both this set
 * and the match are lower-cased and the set is overridable via
 * ARKHAM_SMART_MONEY_TYPES. Deliberately excludes neutral/infrastructure
 * types (cex/dex/bridge/protocol/contract/miner) — an exchange hot wallet
 * holding tokens is not an informed trader.
 */
export const DEFAULT_SMART_MONEY_TYPES: ReadonlySet<string> = new Set([
  "fund",
  "hedgefund",
  "hedge_fund",
  "investor",
  "marketmaker",
  "market_maker",
  "trader",
  "vc",
  "venture",
  "whale",
]);

export interface ArkhamHolder {
  address: string;
  /** Entity name when attributed (e.g. "Wintermute", "Binance"), else null. */
  entityName: string | null;
  /** Entity type slug when attributed (e.g. "fund", "cex"), else null. */
  entityType: string | null;
  /** Wallet label when present (e.g. "Hot Wallet"), else null. */
  label: string | null;
  /** Token balance held. */
  balance: number | null;
  /** Share of circulating cap — FRACTION (0.06 = 6%), as the API sends it. */
  pctOfCap: number | null;
}

/** Parsed top-holder snapshot for one token (see parseArkhamHolders). */
export interface ArkhamTokenHolders {
  /** How many holder rows came back (top-100 page). */
  holderCount: number;
  /** Holders whose entity type is in the smart-money set. */
  smartMoney: ArkhamHolder[];
  /** All top holders (for display/tests). */
  topHolders: ArkhamHolder[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

/** Lower-cased type → true when it matches the configured smart-money set. */
export function isSmartMoneyType(
  type: string | null | undefined,
  smartMoneyTypes: ReadonlySet<string>,
): boolean {
  if (!type) return false;
  return smartMoneyTypes.has(type.toLowerCase());
}

/**
 * Pure parser for GET /token/holders/{chain}/{address} (exported for
 * tests). `data` is the full response body; `addressTopHolders` is keyed by
 * chain ("solana"). Malformed/missing holder lists yield a zero-count result
 * instead of null so the client can distinguish "API ok, no holders yet"
 * (fresh coin, not indexed) from "API shape changed" (parser mismatch).
 */
export function parseArkhamHolders(
  data: unknown,
  smartMoneyTypes: ReadonlySet<string> = DEFAULT_SMART_MONEY_TYPES,
): ArkhamTokenHolders | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const byChain = root.addressTopHolders;
  if (!byChain || typeof byChain !== "object") return null;
  const rows = (byChain as Record<string, unknown>).solana;
  if (!Array.isArray(rows)) return null;

  const topHolders: ArkhamHolder[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const addrObj = item.address as Record<string, unknown> | null | undefined;
    const address =
      typeof addrObj?.address === "string" ? addrObj.address : "";
    if (!address) continue;
    const entity =
      addrObj?.arkhamEntity && typeof addrObj.arkhamEntity === "object"
        ? (addrObj.arkhamEntity as Record<string, unknown>)
        : null;
    const label =
      addrObj?.arkhamLabel && typeof addrObj.arkhamLabel === "object"
        ? (addrObj.arkhamLabel as Record<string, unknown>)
        : null;
    topHolders.push({
      address,
      entityName: entity ? strOrNull(entity.name) : null,
      entityType: entity ? strOrNull(entity.type) : null,
      label: label ? strOrNull(label.name) : null,
      balance: num(item.balance),
      pctOfCap: num(item.pctOfCap),
    });
  }

  const smartMoney = topHolders.filter((h) =>
    isSmartMoneyType(h.entityType, smartMoneyTypes),
  );
  return { holderCount: topHolders.length, smartMoney, topHolders };
}

export class ArkhamClient {
  private readonly throttle: Throttle;

  constructor(private readonly config: AppConfig) {
    this.throttle = new Throttle(config.arkhamRequestIntervalMs);
  }

  /**
   * GET with the API-Key header; retries transient 429/5xx (2s/4s backoff)
   * and returns null on deterministic 4xx (retrying never helps).
   */
  private async getJson(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.throttle.run(() =>
          fetch(`${BASE_URL}${path}`, {
            headers: {
              "API-Key": this.config.arkhamApiKey ?? "",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Arkham HTTP ${res.status}`);
        }
        if (!res.ok) return null; // 4xx — deterministic
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(attempt * 2000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Arkham request failed");
  }

  /**
   * Top-100 holders for a Solana token with entity attribution. Smart-money
   * count is derived from the configured type set. Best-effort: null on
   * transport errors, a zero-count result when the API has no holders yet.
   */
  async fetchTokenHolders(address: string): Promise<ArkhamTokenHolders | null> {
    const data = await this.getJson(
      `/token/holders/solana/${encodeURIComponent(address)}?limit=100&offset=0`,
    );
    return parseArkhamHolders(data, this.config.arkhamSmartMoneyTypes);
  }
}
