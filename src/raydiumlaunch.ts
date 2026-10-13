import type { AppConfig } from "./config";
import type { TokenProfile } from "./dexscreener";

/**
 * Raydium's LaunchLab mint API — the FOURTH keyless launch feed.
 *
 * WHY THIS HOST, AND WHY NOT `api-v3.raydium.io` (measured 2026-10-13):
 *
 * The pool list Raydium's docs publish cannot answer "newest pools" at any
 * price. `api-v3.raydium.io/pools/info/list-v2` accepts only metric sorts
 * (`sortField=liquidity|volume24h|fee24h|apr24h`); `createTime`/`createdAt`
 * are rejected with HTTP 500 `query sortField check error`, the look-alike
 * `poolSortField` is SILENTLY IGNORED (identical bytes to the liquidity sort),
 * and a pool row's `openTime` is an epoch-SECONDS field that is `"0"` on many
 * pools (every Concentrated pool sampled) and is not documented as pool
 * creation time. So a Raydium pool feed would have to diff-poll or watch the
 * chain — costs that are not worth it while DexScreener already indexes every
 * Raydium pool pair.
 *
 * What Raydium DOES expose is its launchpad's own mint list, and it is
 * genuinely newest-first: `GET /get/list?sort=new` answers
 * `{id, success, data:{rows:[…100], nextPageId}}` with `createAt` in
 * MILLISECONDS and the rows STRICTLY DESCENDING by it (verified live
 * 2026-10-13: newest ~2 minutes old, the 100th ~86 minutes old ≈ 70
 * launches/hour; `sort=new` on this host means it). Rows also carry
 * name/symbol/marketCap and the tenant platform (StonkFun, letsbonk.fun,
 * Growpad, …) — LaunchLab is Raydium's own pump.fun-style launchpad, rented
 * to third-party frontends.
 *
 * WHY A FOURTH LAUNCH SOURCE: the launch slot is the bot's bread and butter
 * (pump.fun v3 every tick, Meteora on gecko's skipped windows, gecko
 * new_pools every 5 minutes), and a launch feed's whole value is the earliest
 * possible sighting of a coin that may age into the qualifying window. This
 * source is INDEPENDENT of all three (different host, different chain of
 * custody: Raydium's own indexer), costs one request per tick, needs no key,
 * and its page covers ~1.4 hours so a 30s cadence can never miss a row.
 *
 * COST/VOLUME: one request per tick (2,880/day) when
 * RAYDIUM_LAUNCH_LIMIT > 0; ~70 launches/hour flow through it, of which the
 * tick's slice (~20) is the newest batch — net-new mints per tick are
 * typically 0-2, so the real cost is the single subrequest, not the pair
 * fetches (feeds are deduped against each other before the pair phase).
 *
 * NOT VERIFIED FROM THE WORKER'S OWN EGRESS YET: the sandbox reached it
 * (200), but `launch-mint-v1.raydium.io` has no probe on the deployed Worker
 * before this change. `/debug/raydium-launch` is that probe — read it after
 * the first deploy; a blocked host degrades to an empty feed (and the leg is
 * best-effort by construction), so the failure mode is a quiet `raydium 0`,
 * not a broken tick.
 *
 * RATE LIMITS ARE UNDOCUMENTED. The client therefore pauses 60s after any
 * 429/5xx instead of hammering, holds `health()` counters so the probe can
 * say WHY a feed is empty, and never retries inside the tick (one request,
 * the meteora.ts lesson: a rate-limited host will not answer better on
 * attempt three, and an un-awaited ladder outlives the feed window).
 */
export const RAYDIUM_LAUNCH_BASE_URL = "https://launch-mint-v1.raydium.io";

/**
 * The API's page is fixed at 100 rows; this is the hard ceiling for the
 * config knob (and what `parseRaydiumLaunches` slices to). Deeper batches buy
 * nothing: the rows are newest-first, so a tick only ever wants the head.
 */
export const RAYDIUM_LAUNCH_MAX_LIMIT = 100;

/**
 * Pause after a 429/5xx, in ms. Two ticks at the 30s clock — long enough to
 * stop a refusals-per-second loop against a host with undocumented limits,
 * short enough that a transient refusal costs the launch slot ~1 minute (the
 * other three feeds keep the slot filled meanwhile).
 */
export const RAYDIUM_LAUNCH_BACKOFF_MS = 60_000;

/**
 * Descriptive User-Agent: an anonymous shared-egress request is the shape that
 * gets blocked (CoinGecko 403'd the Worker without one — see GECKO_USER_AGENT
 * in geckoterminal.ts). Sent here for the same reason.
 */
const USER_AGENT = "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";

/** Solana base58 mint (32-44 chars) — the same shape check the other parsers use. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface RaydiumLaunchMint {
  /** The launch token — the side to register. */
  mint?: unknown;
  /**
   * The quote side. An OBJECT (`{address, symbol, …}` — WSOL / BONK / PUMP in
   * the live sample), not a string; a string is still tolerated because only
   * the equality check reads it and a shape change would otherwise drop every
   * row.
   */
  mintB?: unknown;
  /** Creation time in MILLISECONDS. */
  createAt?: unknown;
  name?: unknown;
  symbol?: unknown;
}

/** The quote-side address of a row, whatever shape the field arrives in. */
function quoteAddress(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const addr = (raw as { address?: unknown }).address;
    if (typeof addr === "string") return addr.trim();
  }
  return "";
}

/**
 * Normalize a LaunchLab `/get/list` response into TokenProfile entries (pure —
 * unit-tested). The rows are newest-first by contract; this SORTS defensively
 * (descending `createAt`) so a server-side ordering regression cannot make the
 * tick's slice old launches, then slices to `limit`.
 *
 * Junk is dropped rather than guessed at: a row with no usable `mint` (or one
 * whose mint IS the quote side), a missing/zero `createAt` (the re-eval pool
 * is keyed on birth time, so an untimeable row is junk — same rule as
 * meteora.ts), duplicates within the page, and non-object rows. Non-array
 * input (a challenge page, a shape change) yields [] so a bad response is an
 * empty feed rather than a crash.
 */
export function parseRaydiumLaunches(json: unknown, limit = RAYDIUM_LAUNCH_MAX_LIMIT): TokenProfile[] {
  const rowsRaw = (json as { data?: { rows?: unknown } } | null)?.data?.rows;
  if (!Array.isArray(rowsRaw)) return [];
  const out: TokenProfile[] = [];
  const seen = new Set<string>();
  for (const item of rowsRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as RaydiumLaunchMint;
    const tokenAddress = typeof row.mint === "string" ? row.mint.trim() : "";
    if (!MINT_RE.test(tokenAddress)) continue;
    // The launch token is `mint`; a row claiming the quote side as its base
    // has no identifiable launch token and is dropped rather than registered.
    if (quoteAddress(row.mintB) === tokenAddress) continue;
    if (seen.has(tokenAddress)) continue;
    const created =
      typeof row.createAt === "number" && Number.isFinite(row.createAt) && row.createAt > 0
        ? row.createAt
        : undefined;
    if (created === undefined) continue;
    seen.add(tokenAddress);
    out.push({
      tokenAddress,
      name: typeof row.name === "string" ? row.name : undefined,
      symbol: typeof row.symbol === "string" ? row.symbol : undefined,
      openTimestamp: created,
    });
  }
  // Newest first, whatever order the page arrived in.
  out.sort((a, b) => (b.openTimestamp ?? 0) - (a.openTimestamp ?? 0));
  const want = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), RAYDIUM_LAUNCH_MAX_LIMIT))
    : RAYDIUM_LAUNCH_MAX_LIMIT;
  return out.slice(0, want);
}

/**
 * The probe/diagnostic view of this client (see `/debug/raydium-launch`): why
 * a `raydium 0` happened — a refusal (lastStatus), a pause in force
 * (backoffUntil), a non-JSON body (lastError) or simply an empty page after
 * an OK response (ok > 0 with a 0 count). Per-isolate module state, exactly
 * like the other feed clients' counters — the probe answers from the isolate
 * that ran the request.
 */
export interface RaydiumLaunchHealth {
  requests: number;
  ok: number;
  http429: number;
  failures: number;
  consecutive429: number;
  lastStatus: number;
  lastOkAt: number;
  lastBytes: number;
  lastError: string | null;
  backoffMs: number;
  backoffUntil: number;
}

/**
 * Newest-launch feed for Raydium LaunchLab + its tenant launchpads. One
 * request per tick when enabled; every failure mode degrades to [] and the
 * scan continues on the other three launch feeds.
 */
export class RaydiumLaunchClient {
  private readonly stats: RaydiumLaunchHealth = {
    requests: 0,
    ok: 0,
    http429: 0,
    failures: 0,
    consecutive429: 0,
    lastStatus: 0,
    lastOkAt: 0,
    lastBytes: 0,
    lastError: null,
    backoffMs: 0,
    backoffUntil: 0,
  };

  constructor(_config: AppConfig) {
    // No config needed yet (one request per tick needs no throttle state);
    // the parameter is kept so the worker builds every client the same way
    // and a future knob does not change the call site — same shape as
    // meteora.ts.
    void _config;
  }

  health(): RaydiumLaunchHealth {
    return { ...this.stats };
  }

  async fetchNewLaunches(limit: number): Promise<TokenProfile[]> {
    // A host that just refused stays unanswered until its pause ends: this is
    // the only thing standing between an undocumented limiter and one doomed
    // request per tick.
    if (Date.now() < this.stats.backoffUntil) return [];
    const want = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), RAYDIUM_LAUNCH_MAX_LIMIT))
      : RAYDIUM_LAUNCH_MAX_LIMIT;
    this.stats.requests += 1;
    let res: Response;
    try {
      res = await fetch(`${RAYDIUM_LAUNCH_BASE_URL}/get/list?sort=new`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      // Timeout/abort: the feed window is gone, report empty.
      this.stats.failures += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      console.error("[raydium-launch] discovery request failed:", this.stats.lastError);
      return [];
    }
    this.stats.lastStatus = res.status;
    if (!res.ok) {
      this.stats.failures += 1;
      if (res.status === 429) {
        this.stats.http429 += 1;
        this.stats.consecutive429 += 1;
      } else {
        this.stats.consecutive429 = 0;
      }
      // Refusals (429/5xx) all park the leg for the pause; a 4xx that is not
      // 429 is a shape/route problem and would not answer better in 60s
      // either, so it shares the same door out.
      this.stats.backoffMs = RAYDIUM_LAUNCH_BACKOFF_MS;
      this.stats.backoffUntil = Date.now() + RAYDIUM_LAUNCH_BACKOFF_MS;
      this.stats.lastError = `HTTP ${res.status}`;
      console.error(`[raydium-launch] discovery HTTP ${res.status}`);
      return [];
    }
    const text = await res.text();
    this.stats.lastBytes = text.length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.stats.failures += 1;
      this.stats.lastError = "non-JSON body";
      console.error("[raydium-launch] discovery returned a non-JSON body");
      return [];
    }
    const out = parseRaydiumLaunches(parsed, want);
    this.stats.ok += 1;
    this.stats.consecutive429 = 0;
    this.stats.backoffMs = 0;
    this.stats.backoffUntil = 0;
    this.stats.lastOkAt = Date.now();
    this.stats.lastError = null;
    return out;
  }
}
