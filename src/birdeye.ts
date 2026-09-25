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

/**
 * Birdeye Data API CU price per endpoint. The free tier is 30_000 CU/MONTH for
 * the WHOLE bot, and a request is billed whether or not its payload is usable
 * — which is why the holder probe's cap is a hit-rate dial, not a latency knob
 * (docs/round-trips.md §4.4). Prices recorded in this repo against the
 * published docs: token_overview 20 CU, ohlcv 35 CU, new_listing 30–80 CU
 * (charge the middle). top_traders has NO recorded price, so it is charged 0 —
 * an unpriced endpoint must not invent a number that then drives a budget
 * decision.
 */
export const BIRDEYE_CU_PRICES = {
  tokenOverview: 20,
  ohlcv: 35,
  newListing: 40,
  topTraders: 0,
} as const;

export type BirdeyeEndpoint = keyof typeof BIRDEYE_CU_PRICES;

/** UTC day key (`YYYY-MM-DD`) — Birdeye's quota resets on a calendar day. */
export function birdeyeUtcDay(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * CU spent since the last persist, per UTC day (module scope = isolate scope,
 * the same channel gmgn.ts uses for its feed stats). The worker drains this
 * into the durable worker_state ledger (see worker.syncBirdeyeCu), so the count
 * survives isolate recycling; the drain rides the post-scan telemetry rather
 * than a live per-tick write, because a per-tick round trip is exactly what the
 * 50-subrequest invocation budget cannot pay for (docs/round-trips.md §1).
 */
const cuPending = new Map<string, number>();

/**
 * One endpoint's day cell: how many requests were BILLED (`calls`) and what
 * they cost (`cu`). The CU half is the budget unit; the CALL half is the only
 * figure that can be checked against Birdeye's own dashboard, which is what
 * calibrates the price table above — and it keeps the unpriced endpoint
 * (`topTraders`, charged 0 for want of a published price) visible instead of
 * silently absent from a CU-only breakdown.
 */
export interface BirdeyeCuCell {
  calls: number;
  cu: number;
}

/** Per endpoint, per day (a missing endpoint means "not called that day"). */
export type BirdeyeCuCounts = Partial<Record<BirdeyeEndpoint, BirdeyeCuCell>>;

/**
 * The same pending deltas as `cuPending`, split by endpoint. Same isolate
 * scope, same drain: the totals answer "how much of the month is gone", this
 * answers "who spent it" — the question every tuning decision in
 * docs/round-trips.md §4.4 is actually denominated in (the holder probe, the
 * card path and the periodic backfill are three different callers sharing one
 * endpoint and one quota).
 */
const cuPendingBy = new Map<string, BirdeyeCuCounts>();

/**
 * Charge one request ATTEMPT (`BIRDEYE_CU_PRICES`) — drain-free and never
 * throwing, so it can sit in the client's hot path.
 */
export function chargeBirdeyeCu(
  endpoint: BirdeyeEndpoint,
  at = Date.now(),
): void {
  const cu = BIRDEYE_CU_PRICES[endpoint];
  const day = birdeyeUtcDay(at);
  // The CU half keeps the early exit an unpriced endpoint has always had: a
  // call with no recorded price contributes no spend, and an invented number
  // must never drive a budget decision. Its CALL is still counted below.
  if (cu > 0) cuPending.set(day, (cuPending.get(day) ?? 0) + cu);
  const byDay = cuPendingBy.get(day) ?? {};
  const cell = byDay[endpoint] ?? { calls: 0, cu: 0 };
  byDay[endpoint] = { calls: cell.calls + 1, cu: cell.cu + cu };
  cuPendingBy.set(day, byDay);
}

/** A copy of this isolate's unpersisted CU deltas (day → CU). */
export function peekBirdeyeCuDelta(): Map<string, number> {
  return new Map(cuPending);
}

/**
 * Drop the deltas a LANDED write persisted (see worker.syncBirdeyeCu).
 * Subtracting the snapshot rather than clearing the map keeps a charge that
 * arrived while the write was in flight in the pending set — the same
 * "advance the baseline only after the write landed" rule the deferral and
 * skip-capture syncs use.
 */
export function consumeBirdeyeCuDelta(
  persisted: Map<string, number>,
): void {
  for (const [day, cu] of persisted) {
    const left = (cuPending.get(day) ?? 0) - cu;
    if (left > 0) cuPending.set(day, left);
    else cuPending.delete(day);
  }
}

/** A copy of this isolate's unpersisted per-endpoint deltas (day → counts). */
export function peekBirdeyeCuByDay(): Map<string, BirdeyeCuCounts> {
  const out = new Map<string, BirdeyeCuCounts>();
  for (const [day, counts] of cuPendingBy) {
    const copy: Record<string, BirdeyeCuCell> = {};
    for (const [endpoint, cell] of Object.entries(
      counts as Record<string, BirdeyeCuCell | undefined>,
    )) {
      if (cell) copy[endpoint] = { ...cell };
    }
    out.set(day, copy as BirdeyeCuCounts);
  }
  return out;
}

/**
 * Drop the per-endpoint deltas a LANDED write persisted — the exact mirror of
 * consumeBirdeyeCuDelta, cell by cell, so a charge that arrived while the
 * write was in flight stays pending on both halves.
 */
export function consumeBirdeyeCuByDay(
  persisted: Map<string, BirdeyeCuCounts>,
): void {
  for (const [day, counts] of persisted) {
    const live = cuPendingBy.get(day);
    if (!live) continue;
    const liveRec = live as Record<string, BirdeyeCuCell | undefined>;
    for (const [endpoint, cell] of Object.entries(
      counts as Record<string, BirdeyeCuCell | undefined>,
    )) {
      if (!cell) continue;
      const own = liveRec[endpoint];
      if (!own) continue;
      const calls = own.calls - cell.calls;
      const cu = own.cu - cell.cu;
      if (calls > 0 || cu > 0) {
        liveRec[endpoint] = { calls: Math.max(0, calls), cu: Math.max(0, cu) };
      } else {
        delete liveRec[endpoint];
      }
    }
    if (Object.keys(liveRec).length === 0) cuPendingBy.delete(day);
  }
}

/** Pure helper for the durable ledger's day map: the days kept before pruning. */
export const BIRDEYE_CU_LEDGER_DAYS = 32;

/**
 * Is a persisted holder count still worth reusing, or must the card path buy
 * another `/defi/token_overview` (20 CU)?
 *
 * The card's holders line is the only thing that request pays for, and it is
 * bought inside the enrich batch — which the SAME coin re-enters on every tick
 * it is neither pushed nor finally rejected (a card send deferred by the tick
 * cut; a gate that rejects this tick and passes the next). Before this rule
 * each of those entries paid for the same reading again, which is the card-side
 * share §4.14 measured (docs/round-trips.md).
 *
 * `ttlMs <= 0` is the knob turned OFF — always read, the pre-2026-09-25
 * behaviour (BIRDEYE_HOLDER_CACHE_MIN = 0), and the escape hatch if the call
 * ever becomes free or the count must be live on every attempt.
 * `cachedAt <= 0` is the "never written" SENTINEL, not 1970 — the same rule
 * healthAgeMs follows for the frozen readings (worker.ts): a row whose stamp
 * was never set must not be mistaken for a fresh reading.
 */
export function holderCountCacheHit(
  cached: number | null,
  cachedAt: number | null,
  now: number,
  ttlMs: number,
): boolean {
  if (ttlMs <= 0) return false;
  if (cached === null || cachedAt === null) return false;
  if (cachedAt <= 0) return false;
  return now - cachedAt < ttlMs;
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

  private async getJson(
    path: string,
    endpoint: BirdeyeEndpoint,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Charged PER ATTEMPT, before the fetch: a request that reaches Birdeye
      // is billed whether or not its payload lands, and a request aborted by
      // the timeout below may still have been processed. Charging the success
      // path only would under-count exactly the retries this client is most
      // likely to make (429/5xx/timeout).
      chargeBirdeyeCu(endpoint);
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
      "ohlcv",
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
   * - proTraders: how many wallets among the top traders Birdeye tags as
   *   smart_trader (its smart-money label), excluding wallets also tagged as
   *   bundler or dev — those are not genuine pro traders. Counting the
   *   explicit label is far more accurate than inferring "pro" from positive
   *   PnL, which counts nearly every profitable wallet (bots included) and
   *   overstates the number.
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
      "topTraders",
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
      const tags = trader.tags ?? [];
      // Birdeye's explicit smart-money label; bundler/dev wallets are tagged
      // separately and are not genuine "pro" traders.
      if (
        tags.includes("smart_trader") &&
        !tags.includes("bundler") &&
        !tags.includes("dev")
      ) {
        pro++;
      }
      if (tags.includes("sniper")) {
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
   * Newly listed tokens — Birdeye's fresh-launch feed. The pump.fun API is
   * datacenter-blocked (530 from sandbox / Worker / GitHub Actions), so this
   * is the discovery source for the one-shot backfill:
   * meme_platform_enabled=true includes pump.fun launches. 30–80 CU per
   * request — fine for a bounded backfill, far too expensive for per-minute
   * live discovery on the free tier (30K CU/month).
   *
   * Field names are parsed defensively (the docs don't publish a schema for
   * the response items): address accepts address/mint/tokenAddress/token;
   * time accepts createTime/createdAt/creationTime/listedAt/blockTime/unixTime
   * (ms or s, normalized to s). Returns [] on any shape mismatch.
   */
  async fetchNewListings(
    timeToSec: number,
    limit = 20,
  ): Promise<Array<{ address: string; createdAtSec: number | null }>> {
    const data = (await this.getJson(
      `/defi/v2/tokens/new_listing?limit=${limit}&meme_platform_enabled=true&time_to=${timeToSec}`,
      "newListing",
    )) as {
      data?: { tokens?: unknown[]; items?: unknown[]; list?: unknown[] };
    } | null;
    const raw = data?.data?.tokens ?? data?.data?.items ?? data?.data?.list;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ address: string; createdAtSec: number | null }> = [];
    for (const t of raw as Record<string, unknown>[]) {
      const address = String(
        t?.address ?? t?.mint ?? t?.tokenAddress ?? t?.token ?? "",
      ).trim();
      if (!address) continue;
      const createdRaw =
        t?.liquidityAddedAt ??
        t?.createTime ??
        t?.createdAt ??
        t?.creationTime ??
        t?.listedAt ??
        t?.blockTime ??
        t?.unixTime;
      let createdAtSec: number | null = null;
      if (typeof createdRaw === "string" && createdRaw) {
        // Observed real shape: "liquidityAddedAt": "2026-08-14T03:38:19"
        // (ISO string — the liquidity-add / graduation time, which matches
        // how the scanner ages coins via DexScreener pairCreatedAt).
        const parsed = Date.parse(createdRaw);
        if (Number.isFinite(parsed)) {
          createdAtSec = Math.floor(parsed / 1000);
        }
      } else {
        const n = Number(createdRaw);
        if (Number.isFinite(n) && n > 0) {
          createdAtSec = n > 1e12 ? Math.floor(n / 1000) : n;
        }
      }
      out.push({ address, createdAtSec });
    }
    return out;
  }

  /** One raw new_listing response (schema probe for the backfill route). */
  async probeNewListing(): Promise<unknown> {
    return this.getJson(
      "/defi/v2/tokens/new_listing?limit=1&meme_platform_enabled=true",
      "newListing",
    );
  }

  /**
   * Holder count for a token from the token-overview endpoint — the card's
   * holders line (GMGN replacement; Birdeye is already keyed and reachable
   * from the Worker). Creator comes from the RugCheck report instead (see
   * rugcheck.ts) — Birdeye's creator lives in the security endpoint, which
   * returns 401 on the free tier. Only called for qualifying candidates,
   * so the 20 CU per call is negligible at the current push volume.
   * Field names are parsed defensively (the docs don't publish a schema)
   * so a schema change degrades to nulls, never a scan failure.
   */
  async getTokenOverview(address: string): Promise<{
    holderCount: number | null;
    creator: string | null;
  }> {
    const data = (await this.getJson(
      `/defi/token_overview?address=${encodeURIComponent(address)}&ui_amount_mode=raw`,
      "tokenOverview",
    )) as { data?: Record<string, unknown> } | null;
    return parseTokenOverview(data?.data);
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
      "ohlcv",
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

/**
 * Pure parser for the token-overview envelope's `data` object (exported for
 * offline unit tests — see scripts/test-unit.js). Defensive about field
 * names so a Birdeye schema change degrades to nulls, not a crash.
 */
export function parseTokenOverview(d: unknown): {
  holderCount: number | null;
  creator: string | null;
} {
  if (!d || typeof d !== "object") {
    return { holderCount: null, creator: null };
  }
  const rec = d as Record<string, unknown>;
  const holderRaw = rec.holder ?? rec.holders ?? rec.holderCount ?? rec.holder_count;
  const holderNum = Number(holderRaw);
  const holderCount =
    Number.isFinite(holderNum) && holderNum > 0 ? Math.floor(holderNum) : null;
  const creatorRaw =
    rec.creator ?? rec.creatorAddress ?? rec.creator_address ?? rec.ownerAddress;
  const creator =
    typeof creatorRaw === "string" && creatorRaw.trim().length >= 32
      ? creatorRaw.trim()
      : null;
  return { holderCount, creator };
}
