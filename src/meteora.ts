import type { AppConfig } from "./config";
import type { TokenProfile } from "./dexscreener";

/**
 * Meteora's public Data API — the THIRD keyless launch feed.
 *
 * WHY THIS SOURCE, and why it replaced "Meteora does not exist":
 *
 * The old host this repo probed, `dlmm-api.meteora.ag`, answers **404 to every
 * path**, root included (measured 2026-09-21 from both a clean host and the
 * Worker's own egress), which is why Meteora was written off and pump.fun's
 * v3 launch feed took the gecko stand-in slot. Meteora's docs now publish
 * `dlmm.datapi.meteora.ag` and `damm-v2.datapi.meteora.ag`, and both:
 *
 *   - answer **200 from the WORKER's own egress** (`/debug/pool-source`:
 *     `meteora-damm-v2 status 200 count 10 newestAgeS 32`,
 *     `meteora-dlmm status 200 count 10 newestAgeS 64`) — the only placement
 *     that counts, because the gecko alternate host looked healthy from a clean
 *     host and answered 403/429 from here;
 *   - accept `sort_by=pool_created_at:desc`, i.e. they can answer "the NEWEST
 *     pools" server-side. That is the thing Raydium and Orca cannot do at any
 *     price: Raydium's `sortField` enum is liquidity/volume/fee/apr (its own
 *     500 says `query sortField check error` for anything else, and the
 *     similarly-named `poolSortField` is silently IGNORED — identical bytes
 *     for `liquidity`, `time` and `bogus`), and Orca's pool objects carry no
 *     creation field at all;
 *   - carry `created_at` (ms) plus both pool sides as `token_x` / `token_y`
 *     with address + symbol, so a launch candidate needs no second request.
 *
 * DAMM v2 is wired rather than DLMM because its newest pool is the fresher one
 * (32s vs 64s), and a launch slot wants the earliest possible sighting: its
 * `met-dbc` rows are tokens the moment they leave Meteora's bonding curve.
 * Cost is one request, and only when the two layers ahead of it (gecko's
 * new_pools, then pump.fun) both delivered nothing this tick — see the
 * launch-slot chain in src/scanner.ts.
 */
export const METEORA_BASE_URL = "https://damm-v2.datapi.meteora.ag";

/**
 * Descriptive User-Agent: an anonymous shared-egress request is the shape that
 * gets blocked (CoinGecko 403'd the Worker without one — see GECKO_USER_AGENT).
 */
const USER_AGENT = "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";

/**
 * The API caps a page at 1000; we never want more than a launch batch, and the
 * bigger the page the bigger the parse. Matches the 300 cap the config applies.
 */
const MAX_LIMIT = 300;

/**
 * A launch pool is quoted in one of the wrapped majors. The token to register
 * is the OTHER side; a row whose sides are both quote mints (or neither) has no
 * single identifiable launch token and is dropped rather than guessed at.
 */
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** Solana base58 mint (32-44 chars) — same shape check the gecko parser uses. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface MeteoraToken {
  address?: string;
  symbol?: string;
  name?: string;
}

interface MeteoraPool {
  address?: string;
  name?: string;
  /** Pool creation time in MILLISECONDS (the probe's age math reads it as ms). */
  created_at?: number;
  tvl?: number;
  launchpad?: string | null;
  token_x?: MeteoraToken | null;
  token_y?: MeteoraToken | null;
}

/**
 * Normalize a Meteora `/pools` page into TokenProfile entries (pure —
 * unit-tested). Non-array input, junk rows and rows that do not resolve to a
 * single non-quote mint yield nothing, so a bad response is an empty feed
 * rather than a crash.
 */
export function parseMeteoraPools(json: unknown): TokenProfile[] {
  const raw = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(raw)) return [];
  const out: TokenProfile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as MeteoraPool;
    const xs = typeof p.token_x?.address === "string" ? p.token_x.address : "";
    const ys = typeof p.token_y?.address === "string" ? p.token_y.address : "";
    const xQuote = QUOTE_MINTS.has(xs);
    const yQuote = QUOTE_MINTS.has(ys);
    // Exactly one quote side, and the other side a plausible mint.
    if (xQuote === yQuote) continue;
    const token = xQuote ? p.token_y : p.token_x;
    const tokenAddress = (xQuote ? ys : xs).trim();
    if (!MINT_RE.test(tokenAddress) || seen.has(tokenAddress)) continue;
    const created =
      typeof p.created_at === "number" && p.created_at > 0
        ? p.created_at
        : undefined;
    // A pool without a creation time cannot age a coin (the re-eval pool is
    // keyed on it), so it is dropped here instead of inflating the feed count.
    if (created === undefined) continue;
    seen.add(tokenAddress);
    out.push({
      tokenAddress,
      name: typeof token?.name === "string" ? token.name : undefined,
      symbol: typeof token?.symbol === "string" ? token.symbol : undefined,
      openTimestamp: created,
    });
  }
  return out;
}

/**
 * Newest-pools feed for brand-new Solana tokens, from Meteora's public Data
 * API. Sits LAST in the launch-slot fallback chain (gecko → pump.fun →
 * here), so it is only ever asked when both layers ahead returned nothing —
 * but it is an independent provider, not a second URL for the same one, which
 * is the point of having a third source at all: pump.fun blocks datacenter
 * IPs on and off, and when it does this feed is what keeps the slot filled.
 *
 * Every failure mode degrades to [] (4xx/5xx, a challenge page, JSON that does
 * not parse) and costs exactly ONE request: no retry ladder, because a
 * rate-limited host will not answer inside the same tick any better on attempt
 * three, and an un-awaited retry chain outlives the feed window and competes
 * with the tick's tail (the lesson GMGN's 2s/4s ladder taught — see
 * docs/gecko-429.md).
 */
export class MeteoraClient {
  constructor(_config: AppConfig) {
    // No config needed yet (a single request per tick needs no throttle
    // state); the parameter is kept so the scanner can build every client
    // the same way and so a future knob does not change the call site.
    void _config;
  }

  async fetchNewestPools(limit: number): Promise<TokenProfile[]> {
    const want = Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
    const url =
      `${METEORA_BASE_URL}/pools?page=1&page_size=${want}` +
      "&sort_by=pool_created_at:desc";
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      // Timeout/abort: the feed window is gone, report empty.
      console.error(
        "[meteora] discovery request failed:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    if (!res.ok) {
      console.error(`[meteora] discovery HTTP ${res.status}`);
      return [];
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("[meteora] discovery returned a non-JSON body");
      return [];
    }
    return parseMeteoraPools(parsed).slice(0, want);
  }
}
