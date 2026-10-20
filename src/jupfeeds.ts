import type { AppConfig } from "./config";
import type { PairInfo, TokenProfile } from "./dexscreener";

const BASE_URL = "https://lite-api.jup.ag/tokens/v2";
/**
 * Back off ALL Jupiter token-feed calls for this long after one 429 — same
 * policy as the GeckoTerminal client. Jupiter's lite-api is generous
 * (~60 req/min), but Workers share egress IPs with every other customer,
 * so a 429 window can still happen; without backoff the scanner would
 * re-hit it every tick. One skipped feed round costs nothing — the
 * re-eval pool keeps coverage.
 */
/**
 * CAP on a 429 pause (and the fallback when the answer advertises nothing).
 * Kept at the old fixed value on purpose: whatever a header says, a broken or
 * hostile stamp can never hold the client down longer than this. See
 * rateLimitPauseMs for the measured window this replaced a flat five minutes
 * with, and why the difference matters to a card.
 */
export const JUP_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
/**
 * The shortest pause a 429 may set. A `Retry-After`/reset stamp already in the
 * past (or a clock skew) must not turn into "retry immediately" — the pause
 * exists to keep us off a provider that just refused us.
 */
export const JUP_RATE_LIMIT_MIN_PAUSE_MS = 250;
/**
 * The longest pause the CARD's read will wait out for a second attempt.
 *
 * RAISED 4s → 10s (2026-10-17, the third round of "the 有機度 line is missing
 * from the card"). The old cap was sized for a read whose result the CARD was
 * waiting on (a card's wall is the chain, and waiting would have eaten the
 * push reserve). That is no longer what this call is: the read is un-awaited,
 * the card renders from whatever has landed and the line is appended by EDIT
 * when the reading arrives later (see Scanner.appendLateOrganicLine), so the
 * wait costs wall clock the card never pays. Meanwhile the provider's window
 * is 5 requests / ~10s (see rateLimitPauseMs), i.e. the advertised reset lands
 * exactly in the band the 4s cap refused — measured on the live cards: every
 * `why:"backoff"` card in the 2026-10-17 audit was `waited:false`, and the
 * wait was the only lever there was.
 *
 * 2026-10-20: the card DOES wait now, but only at its send gate and only until
 * the wall this call was handed (Scanner.organicCardReadWall, ~12.55s into the
 * tick) — the two ends read the same instant, so a pause is waited only when
 * the answer can still reach the first message. The 10s ceiling is unchanged.
 *
 * The true bound is still the caller's wall (room > pause + margin); this is
 * only the ceiling on what a wall may buy. Still far under
 * JUP_RATE_LIMIT_BACKOFF_MS, so an unusable header can never park the card.
 */
export const JUP_RATE_LIMIT_WAIT_MAX_MS = 10_000;
/**
 * Headroom added to a waited-out pause before retrying: the round trip plus
 * scheduling, so the retry cannot land 10ms before the window opens and get
 * refused again.
 */
const JUP_RATE_LIMIT_WAIT_MARGIN_MS = 750;

/**
 * How long a 429 should pause this client — a PURE rule, exported because the
 * number decides whether a card keeps its line and the three Jupiter gates.
 *
 * WHY IT IS NOT A FIXED FIVE MINUTES (measured 2026-10-17 from this repo's own
 * sandbox egress, 22 spaced requests): lite-api allows **5 requests per
 * ~10-second window**, and its 429 answers with
 *
 *   `x-ratelimit-current: 5`, `x-ratelimit-remaining: 0`,
 *   `x-ratelimit-reset: <epoch seconds>`  (and NO `Retry-After`)
 *
 * i.e. the refusal lasts seconds — 1-10s in the measurement. Against that, a
 * blanket 5-minute pause was 30-300x too long, and because ONE 429 silences
 * every call, the tick that exhausted the window also blanked the CARD's read
 * and the gates for five minutes (≈10 ticks) — exactly the shape the operator
 * reported as "many first-push cards have no 有機度".
 *
 * So: honour what the provider advertises (`Retry-After` in seconds or as an
 * HTTP date, else Jupiter's own `x-ratelimit-reset`), CLAMPED to
 * [JUP_RATE_LIMIT_MIN_PAUSE_MS, JUP_RATE_LIMIT_BACKOFF_MS] — a hostile or
 * broken header can neither disable the pause nor hold the client down for
 * longer than the old fixed window. No stamp at all keeps the old floor of five
 * minutes, which is the documented worst case, not the common one.
 */
export function rateLimitPauseMs(
  headers: { get(name: string): string | null },
  nowMs: number,
): number {
  const clamp = (ms: number): number =>
    Math.min(
      JUP_RATE_LIMIT_BACKOFF_MS,
      Math.max(JUP_RATE_LIMIT_MIN_PAUSE_MS, ms),
    );
  // 1) Retry-After: delta-seconds, or an HTTP date (both legal shapes).
  const retryAfter = (headers.get("retry-after") ?? "").trim();
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return clamp(secs * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return clamp(at - nowMs);
  }
  // 2) Jupiter's own window stamp, in epoch SECONDS.
  const rawReset = headers.get("x-ratelimit-reset");
  if (rawReset !== null) {
    const secs = Number(rawReset);
    if (Number.isFinite(secs) && secs > 0) return clamp(secs * 1000 - nowMs);
  }
  // 3) Nothing advertised: the documented worst case.
  return JUP_RATE_LIMIT_BACKOFF_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait `ms`, or resolve false as soon as `signal` aborts — the caller's abort
 * must not spend a queue slot on a request nobody will read (the same rule
 * DexScreenerClient.Throttle.run applies). On timeout the abort listener is
 * removed; on abort the timer is cleared.
 */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One signal that aborts when EITHER input does — the CALLER's abort (a
 * bounded read that has given up, see PushWatcher.bounded) or this attempt's
 * own transport window (AbortSignal.timeout). Hand-rolled rather than
 * AbortSignal.any, for the same reason the other clients hand-roll it: the
 * Workers runtime and the offline unit tests (Node) must agree on ONE
 * implementation, and the first cause — the one that names WHY the request
 * died — is forwarded either way.
 */
function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (a === undefined) return b;
  const combined = new AbortController();
  const forward = (from: AbortSignal): void => {
    if (from.aborted) combined.abort(from.reason);
    else
      from.addEventListener("abort", () => combined.abort(from.reason), {
        once: true,
      });
  };
  forward(a);
  forward(b);
  return combined.signal;
}

/**
 * Minimum gap a PRIORITY call keeps from the last dispatch of the same lane
 * (see `Throttle.run`'s `priority` argument).
 *
 * WHY THE LANE HAS TWO GAPS (2026-10-17). One Jupiter client serves a whole
 * tick: the two discovery feeds and the pair fallback's chunks (which, with
 * DexScreener's pair lane refused fleet-wide, run EVERY tick and carry all
 * ~200 addresses — see docs/efficiency-2026-10-16.md), and then one read per
 * card whose answer the CARD ITSELF waits for. At JUPITER_REQUEST_INTERVAL_MS
 * = 500 that queue pushes a card's read a full spacing (or more) behind every
 * bulk call already waiting — and the card's line, unlike theirs, is gone for
 * good when the wall passes (best-effort reads are not retried next tick). So
 * the card read dispatches with this smaller gap instead: it still respects a
 * floor between requests (never a burst), but it does not queue behind
 * coverage work that the next tick will redo anyway. At most one or two calls
 * per tick can use it (one per card), so the load profile is unchanged.
 */
export const JUP_PRIORITY_GAP_MS = 150;

/**
 * The provider's rolling window, and how much of it the BULK lanes may spend.
 *
 * MEASURED (2026-10-17, from this repo's own sandbox egress): lite-api allows
 * **5 requests per ~10-second window** (`x-ratelimit-current: 5`), and a tick
 * with DexScreener's pair lane refused fleet-wide spends all five on bulk work
 * — two discovery feeds plus the pair fallback's chunks, which carry every
 * address now. The card's read is the SIXTH call, and it is the one call that
 * cannot be redone next tick: a card that loses its line has lost it forever,
 * and the same read feeds the three Jupiter gates. Observed live as
 * `organicWaited` ticks and, when the window did not reopen in time, cards
 * with no 🌱 有機度 at all.
 *
 * So the bulk lanes stop at 4 dispatches per window: the fifth is LEFT for the
 * card. This is a deliberate coverage trade, not a free win — whichever bulk
 * call arrives with the window full stands down (in practice the last chunk of
 * the pair fallback, ~100 addresses) and its tokens keep their re-eval slot
 * for the next tick. `JUP_RESERVE_CARD_SLOT=0` turns it off (bulk may spend all
 * five again), so the trade can be re-measured instead of trusted.
 *
 * Only dispatches from THIS client count: each isolate has its own client, so
 * the ledger cannot see another isolate's calls. That is enough here because a
 * tick's bulk burst is what closes the window for its own card.
 */
export const JUP_RATE_WINDOW_MS = 10_000;
export const JUP_WINDOW_BULK_MAX = 4;

/**
 * Upper bound on the reusable pair readings this client keeps (see
 * fetchTokenDataBatch). The tick's own slice is ~200 addresses and the pool
 * rotates ~1,100, so 1,500 covers a full rotation plus the tracker head — a
 * cap, not a budget: entries are pruned by age on every write as well.
 */
export const JUP_PAIR_CACHE_MAX = 1_500;

/** Spaces out HTTP requests so we stay well under Jupiter's rate limit. */
class Throttle {
  private lastCallAt = 0;
  constructor(private readonly intervalMs: number) {}

  /**
   * Enqueue one request START and return its result — or `null` when the
   * caller's abort landed before the slot did (the never-sent answer the
   * other clients' queues produce, see PushWatcher.bounded): a given-up
   * attempt may not spend a slot the calls behind it would pay for. Without a
   * signal the behaviour is exactly what it was.
   *
   * `priority` is the card read's slot (see fetchOrganicScore): it waits out
   * JUP_PRIORITY_GAP_MS instead of the full interval, so a single call with a
   * hard, non-retryable deadline is not queued behind the tick's bulk lanes.
   * It never skips the queue silently — the dispatch still paces `lastCallAt`,
   * so the call behind it waits its full interval from THIS dispatch.
   */
  async run<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    priority = false,
  ): Promise<T | null> {
    if (signal?.aborted) return null;
    const gap = priority
      ? Math.min(JUP_PRIORITY_GAP_MS, this.intervalMs)
      : this.intervalMs;
    const wait = Math.max(0, this.lastCallAt + gap - Date.now());
    if (wait > 0) {
      if (signal === undefined) {
        await sleep(wait);
      } else if (!(await waitUnlessAborted(wait, signal))) {
        return null;
      }
    }
    if (signal?.aborted) return null;
    this.lastCallAt = Date.now();
    return fn();
  }
}

/**
 * Raw Jupiter Token v2 entry — only the fields this integration uses.
 * The endpoint is Solana-native (`id` is the mint), so no chain filtering
 * is needed (unlike the multi-chain DexScreener boosts feed).
 */
interface JupToken {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
  /** ISO timestamp of the token's creation (≈ launchpad birth time). */
  createdAt?: unknown;
  /** Market cap in USD (only read on the trending leg — see its parser). */
  mcap?: unknown;
}

/** Rolling-window stats block on a token entry (stats5m / stats1h / stats24h). */
interface JupStats {
  priceChange?: unknown;
  numBuys?: unknown;
  numSells?: unknown;
  buyVolume?: unknown;
  sellVolume?: unknown;
}

/** Valid base58 Solana mint (32–44 chars, no 0/O/I/l). */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function toMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Pure parser for the Jupiter Token v2 list response (exported for offline
 * unit tests): keeps valid base58 mints only, maps `createdAt` to
 * `openTimestamp` so coins enter the re-eval pool with their true launch
 * age (a trending entry for an old coin lands outside the qualifying
 * window and is pruned after one retention cycle — harmless).
 */
export function parseJupTokens(data: unknown): TokenProfile[] {
  if (!Array.isArray(data)) return [];
  const out: TokenProfile[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const t = (raw ?? {}) as JupToken;
    const id = typeof t.id === "string" ? t.id : "";
    if (!MINT_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      tokenAddress: id,
      name: typeof t.name === "string" ? t.name : undefined,
      symbol: typeof t.symbol === "string" ? t.symbol : undefined,
      openTimestamp: toMs(t.createdAt),
    });
  }
  return out;
}

/**
 * The band a discovery feed's entries must sit inside to be worth a pair
 * lookup — see parseJupTrendTokens for why the trending leg needs one.
 */
export interface TrendBand {
  /** Youngest age (ms) a token may have and still be sampled. */
  minAgeMs: number;
  /** Oldest age (ms) — beyond this the qualifying window can never open. */
  maxAgeMs: number;
  minMcapUsd: number;
  maxMcapUsd: number;
}

/**
 * The trending band's own market-cap floor, as a fraction of the widest chat's
 * min-market-cap gate.
 *
 * STAYS 0.6 while the pool's floor (scanner.POOL_MCAP_PRUNE_RATIO) went to 0.8
 * on 2026-09-28 — on purpose, and the divergence is the safe direction:
 *
 *   - the pool's floor is a PRUNE. A coin it drops is already in token_stats;
 *     it stops being re-measured, but a later feed appearance re-registers it.
 *   - this is a DISCOVERY filter. A trending token it rejects is never
 *     inserted at all, so nothing downstream can recover it.
 *
 * Tightening discovery to match the pool would therefore make the band the
 * binding constraint on coverage, which is exactly what the pool's own
 * docstring forbids ("the discovery filter must not be tighter than the
 * pool's own prune bounds"). Keeping a WIDER net than the pool costs a few
 * registrations the pool will not sweep and nothing else.
 */
const TREND_BAND_MCAP_FLOOR_RATIO = 0.6;

/**
 * Build the trending leg's band from the enabled chats' qualifying windows,
 * using the re-eval pool's lenient margins (floor × TREND_BAND_MCAP_FLOOR_RATIO,
 * ceiling × 2, age ± margin): a coin slightly below the floor now can rise into
 * it, and the pool would keep it for exactly that reason — so the discovery
 * filter must not be tighter than the pool's own prune bounds.
 */
export function trendBandFromChats(
  chats: Array<{
    minAgeMinutes: number;
    maxAgeMinutes: number;
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
  }>,
  ageMarginMin: number,
): TrendBand | null {
  if (chats.length === 0) return null;
  const margin = Math.max(0, ageMarginMin) * 60_000;
  return {
    minAgeMs: Math.max(0, Math.min(...chats.map((c) => c.minAgeMinutes)) * 60_000 - margin),
    maxAgeMs: Math.max(...chats.map((c) => c.maxAgeMinutes)) * 60_000 + margin,
    minMcapUsd: Math.min(...chats.map((c) => c.minMarketCapUsd)) * TREND_BAND_MCAP_FLOOR_RATIO,
    maxMcapUsd: Math.max(...chats.map((c) => c.maxMarketCapUsd)) * 2,
  };
}

/**
 * Trending-specific parser: the same mint/`createdAt` rules as
 * parseJupTokens, plus the feed's own `mcap`, minus everything OUTSIDE the
 * qualifying band.
 *
 * WHY THE BAND (measured 2026-09-21, from the Worker's egress).
 * `/toporganicscore/24h` ranks by 24h organic score, so its HEAD is
 * structurally the wrong population for a $60K–$230K / 80min–26h coin: of the
 * first 15 entries, 13 were blue chips 300–20,000 hours old (SOL, USDC, USDT,
 * JUP, WBTC, PUMP…) and the other two were 16h/$4.0M and 40h/$3.6M — i.e.
 * ZERO passed the gates, which is exactly why the leg had registered 14 coins
 * in its lifetime (`byFeed`) and pushed none of them. The band lives deeper:
 * 8 of the top 100 sat inside 80min–26h AND $60K–$230K (Lobby 26h/$202K,
 * TYLER 17.6h/$81K, INU 12h/$181K, PEEPEE 21.8h/$75K…), and 24 of 100 were
 * inside the age window alone.
 *
 * The filter runs HERE, not downstream, because every profile the scanner
 * accepts costs a DexScreener pair address in the front phase (see
 * scanner.pairsForTracker): fetching 100 entries is one subrequest, but 85
 * leftover blue chips would add ~3 pair batches to EVERY tick. Entries with no
 * parseable `createdAt` or `mcap` are KEPT — absent evidence is not evidence
 * against a coin, and the scanner's own gates remain the authority.
 */
export function parseJupTrendTokens(
  data: unknown,
  band: TrendBand | null,
  now: number,
): TokenProfile[] {
  if (!Array.isArray(data)) return [];
  const out: TokenProfile[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const t = (raw ?? {}) as JupToken;
    const id = typeof t.id === "string" ? t.id : "";
    if (!MINT_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const openTimestamp = toMs(t.createdAt);
    if (band) {
      if (openTimestamp !== undefined) {
        const age = now - openTimestamp;
        if (age < band.minAgeMs || age > band.maxAgeMs) continue;
      }
      const mcap = typeof t.mcap === "number" && Number.isFinite(t.mcap) ? t.mcap : undefined;
      if (mcap !== undefined && (mcap < band.minMcapUsd || mcap > band.maxMcapUsd)) continue;
    }
    out.push({
      tokenAddress: id,
      name: typeof t.name === "string" ? t.name : undefined,
      symbol: typeof t.symbol === "string" ? t.symbol : undefined,
      openTimestamp,
    });
  }
  return out;
}

/**
 * Jupiter Token API v2 DISCOVERY client (free lite-api, no key) — distinct
 * from src/jupiter.ts, which is the Jupiter Swap trading service:
 *   - fetchRecentTokens: seconds-old launchpad launches (pump.fun & co.) —
 *     the replacement for the blocked pump.fun frontend-api feed, with the
 *     same "enter the coin before DexScreener notices it" purpose.
 *   - fetchTrendingTokens: organic-score ranked coins (see the method: the
 *     /trending/24h endpoint it used to read went empty on 2026-09-21), read
 *     deep and filtered to the qualifying band — see parseJupTrendTokens.
 * Both degrade to [] on any failure; a rate limit sets a shared 5-minute
 * backoff so the scan never hammers a throttled upstream.
 */
/** Number of mints per /search call — the endpoint's documented cap. */
const JUP_BATCH_SIZE = 100;
/**
 * Wall-clock cap for one fetchTokenDataBatch fallback call (see the method
 * comment for the 2026-09-12 dead-tick evidence). Sized to finish 2–3
 * chunks at normal latency and to bail before the worker's 12s race when
 * Jupiter throttles.
 *
 * 2026-09-16: 3500 → 900. The fallback is the LAST front phase on exactly
 * the ticks with the least room (it only fires when DexScreener returned
 * under half the requested pairs — i.e. a 429/blocked tick), and it ran
 * from its own start, so 3.5s carried the pair phase (and the gates behind
 * it) past the scan's internal deadline. 900ms fits the front-phase window
 * (see FRONT_PHASE_WINDOW_MS in scanner.ts: feeds + pool + pairs must all
 * land inside it) and covers the ~100-address chunk that carries the pool
 * slice's live coins; addresses left over keep their tokens in the re-eval
 * pool and are re-read on the next tick, the same fail-safe as every other
 * budget here.
 */
const JUP_FALLBACK_BUDGET_MS = 900;
/**
 * Minimum ROOM a caller's deadline must leave before this fallback may even
 * START — the same floor the chunk loop applies below (`remaining` under this
 * and the chunk is not attempted). Exported because the SCANNER checks it
 * before it stamps the leg: a `pairs-jup` stage entered with no room would
 * publish a near-zero `poolLegMs` reading, indistinguishable from "the leg ran
 * and was instant" — and this repo reads "did not run" and "ran instantly" as
 * two different facts (see FrontLeg). The DexScreener pair lane states the same
 * rule for its own batches (max-latency): a request that cannot START inside
 * the phase is not a drop, it is not attempted at all.
 */
export const JUP_FALLBACK_MIN_ROOM_MS = 250;
/**
 * Chunks of ONE fallback call that may be on the wire together.
 *
 * WHY PARALLEL AT ALL (measured 2026-10-01, fourth-round reading recorded in
 * docs/profiles-feed-zeros.md). The front's ask is 2-3 chunks (~185-215
 * addresses: feed + pool slice + tracker head), and the loop used to be
 * SERIAL — so the second chunk's coverage was hostage to the first chunk's
 * latency. The live shape: a degraded tick resolved exactly one chunk
 * (`pairs 100 pairsJup 100`) with the whole 900ms budget spent, while a
 * healthy tick resolved 182 over 2-3 chunks in 565-880ms. With two lanes each
 * chunk holds the full window for its OWN round trip, so a slow first chunk
 * no longer cancels the rest of the ask — the same pipelined-batch shape the
 * DexScreener pair lane already uses (PAIR_BATCH_CONCURRENCY).
 *
 * WHY 2, not more: a lane already on the wire cannot be recalled when another
 * comes back refused, so the count is a ceiling on needless load against a
 * shared-egress upstream, not a throughput target — and the measured ask
 * shape is two lanes' worth. JUP_BATCH_SIZE stays the endpoint's documented
 * per-request cap.
 */
const JUP_FALLBACK_CONCURRENCY = 2;

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Pure mapper from Jupiter token entries to the scanner's PairInfo shape
 * (exported for offline unit tests). Every gate input the scan needs is
 * available here: mcap, liquidity, 5m volume + price change, buy/sell
 * counts, 1h change, and the pool creation time for the age gate.
 */
export function jupToPairInfos(data: unknown): Map<string, PairInfo> {
  const out = new Map<string, PairInfo>();
  if (!Array.isArray(data)) return out;
  for (const raw of data as Array<Record<string, unknown>>) {
    const id = typeof raw.id === "string" ? raw.id : undefined;
    if (!id || !MINT_RE.test(id) || out.has(id)) continue;
    const s5 = (raw.stats5m ?? {}) as JupStats;
    const s1 = (raw.stats1h ?? {}) as JupStats;
    const s24 = (raw.stats24h ?? {}) as JupStats;
    out.set(id, {
      chainId: "solana",
      url: `https://dexscreener.com/solana/${id}`,
      pairAddress: id,
      baseToken: {
        address: id,
        name: String(raw.name ?? ""),
        symbol: String(raw.symbol ?? ""),
      },
      priceUsd: String(n(raw.usdPrice)),
      // `mcap` first; FDV only as an explicitly FLAGGED fallback, so a
      // diluted valuation can never be recorded as a market cap by accident
      // (see PairInfo.fdvUsd / mcapFromFdv).
      marketCap: n(raw.mcap) || n(raw.fdv),
      fdvUsd: raw.fdv == null ? null : n(raw.fdv),
      mcapFromFdv: n(raw.mcap) <= 0 && n(raw.fdv) > 0,
      volume: {
        h24: n(s24.buyVolume) + n(s24.sellVolume),
        h1: n(s1.buyVolume) + n(s1.sellVolume),
        m5: n(s5.buyVolume) + n(s5.sellVolume),
      },
      priceChange: { m5: n(s5.priceChange), h1: n(s1.priceChange) },
      txns: {
        m5Buys: n(s5.numBuys),
        m5Sells: n(s5.numSells),
        h1Buys: n(s1.numBuys),
        h1Sells: n(s1.numSells),
      },
      liquidity: { usd: raw.liquidity === undefined ? null : n(raw.liquidity) },
      // Jupiter's `liquidity` is its own metric — measured at ~half of
      // DexScreener's pool reserve for the same pool (2026-09-20, see the
      // feedSource note on PairInfo), so a pair built here must never be
      // judged by a DexScreener-calibrated USD level.
      feedSource: "jupiter",
      pairCreatedAt: toMs(raw.createdAt) ?? 0,
    });
  }
  return out;
}

/**
 * Why a card read (
 * `fetchOrganicScore`) produced the reading it did — `ok` is the only value
 * that carries one. A card whose 🌱 有機度 line is missing is exactly a read
 * whose value is not `ok`, and until 2026-10-17 NOTHING in the fleet recorded
 * WHICH of these had happened: the operator saw the line vanish and the repo
 * had three separate investigations (§4.23/§4.24 of docs/round-trips.md) that
 * could only say "no window" or "no data" after manually probing the mints.
 * Every read now names its own reason, and the tick publishes it.
 */
export type JupCardReadWhy =
  /** The reading landed. */
  | "ok"
  /** A 429 has paused this client; nothing was sent (see rateLimitedUntil). */
  | "backoff"
  /** An HTTP answer that was not 2xx — `status` names it. */
  | "http"
  /** 2xx but the body was not the documented JSON array. */
  | "body"
  /** The array answered, but carried no entry for the mint. */
  | "no-entry"
  /** Jupiter has no organic data for this token (every field absent). */
  | "empty"
  /** Transport: a throw, a timeout, or a body that would not parse. */
  | "error";

/**
 * The outcome of ONE card read, kept per client so the tick can publish it
 * (see the scanner's `organicWhy` / `organicCards`).
 */
export interface JupCardReadNote {
  /** When the read started (epoch ms). */
  at: number;
  /** Dispatch → answer, both attempts included. */
  ms: number;
  /** Why the answer is what it is. */
  why: JupCardReadWhy;
  /** The last attempt's HTTP status (0 = nothing reached the wire). */
  status: number;
  /** Whether a second attempt was spent on a reading-less first one. */
  retried: boolean;
  /**
   * Whether that second attempt first WAITED OUT a 429 window (see
   * fetchOrganicScore). Separate from `retried` because the two say different
   * things: a retry after a 5xx is a blip, a retry after a wait is "the tick
   * itself exhausted the provider's 6/10s window" — the reading the operator
   * needs to know whether the pair fallback is crowding the card's read.
   */
  waited: boolean;
  /** Whether a reading came back (i.e. the card has its line). */
  landed: boolean;
}

/** One card read's reading (what the 🌱 有機度 line renders from). */
export interface JupOrganicReading {
  score: number | null;
  label: string | null;
  tradersH1: number | null;
  tradersWindow: "1h" | "6h" | "24h" | null;
  /** Jupiter flagged this token as suspicious (audit.isSus present+true). */
  sus: boolean;
  /** Deployer's share of supply, in percent (audit.devBalancePercentage). */
  devBalancePct: number | null;
}

export class JupTokensClient {
  private readonly throttle: Throttle;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;
  /**
   * The LAST transport's HTTP status (0 = none this call). Read right after a
   * `null` from `get` to say WHICH half failed: the wire (http) or the
   * transport itself (error). One slot, not a log — the note it feeds is read
   * by the tick that made the call.
   */
  private lastStatus = 0;
  /** The last card read's outcome (see JupCardReadNote). */
  private lastCardRead: JupCardReadNote | null = null;
  /** Dispatch starts inside the provider's rolling window, oldest first. */
  private windowDispatchesAt: number[] = [];
  /** Bulk calls stood down so the card read keeps its slot (2026-10-17). */
  private bulkStoodDown = 0;
  /**
   * Pair readings this client may REUSE (see fetchTokenDataBatch): the batch
   * lane is the gate data of last resort — with DexScreener refused
   * fleet-wide it is the only one — and the tick's slice is largely the same
   * feed coins every time, so re-asking all ~200 of them each tick spent two
   * of the provider's five window slots on readings the previous tick already
   * had. Insertion-ordered; bounded by JUP_PAIR_CACHE_MAX and pruned on write.
   */
  private readonly pairCache = new Map<string, { pair: PairInfo; at: number }>();
  /** Batch entries served from the cache / asked of the wire (see the TTL). */
  private pairCacheHits = 0;
  private pairCacheFetched = 0;

  constructor(
    config: AppConfig,
    /**
     * Injectable fetch for tests (defaults to global fetch). The second
     * parameter is the caller's abort, when the read has one (see get) — an
     * existing one-parameter stub still satisfies the type and simply never
     * sees it.
     */
    private readonly fetcher?: (url: string, signal?: AbortSignal) => Promise<Response>,
  ) {
    this.throttle = new Throttle(config.jupiterRequestIntervalMs);
    // JUP_RESERVE_CARD_SLOT=0 turns the reservation off (default on, see
    // JUP_WINDOW_BULK_MAX). Kept on the instance so the dispatch check below
    // is one field read instead of a config lookup per call.
    this.reserveCardSlot = config.jupReserveCardSlot !== false;
    // JUP_PAIR_CACHE_SECONDS=0 turns the reuse off (see fetchTokenDataBatch).
    // A missing/zero TTL means "always ask the wire", which is the behaviour
    // this replaced — so an old test double without the field still works.
    this.pairCacheTtlMs = Number.isFinite(config.jupPairCacheMs)
      ? Math.max(0, Number(config.jupPairCacheMs))
      : 0;
  }

  private readonly reserveCardSlot: boolean;
  private readonly pairCacheTtlMs: number;

  /**
   * Batch readings served from the reuse cache / asked of the wire, per client
   * (isolate). A climbing hit share is the TTL doing its job; a hit share that
   * stays 0 with a non-zero TTL means the tick's slice never repeats and the
   * cache is dead weight.
   */
  pairCacheStats(): { hits: number; fetched: number; ttlMs: number; size: number } {
    return {
      hits: this.pairCacheHits,
      fetched: this.pairCacheFetched,
      ttlMs: this.pairCacheTtlMs,
      size: this.pairCache.size,
    };
  }

  /**
   * Drop entries past the TTL, then the oldest if the cap is still exceeded.
   *
   * The scan is the WHOLE map rather than a break on the first live entry: a
   * re-fetched mint keeps its original insertion position while its `at`
   * moves, so the map is not strictly ordered by time and a break would leave
   * stale entries behind forever. Called once per batch call, on a map bounded
   * by JUP_PAIR_CACHE_MAX, so the walk is free.
   */
  private prunePairCache(now: number): void {
    if (this.pairCacheTtlMs <= 0) return;
    for (const [mint, hit] of this.pairCache) {
      if (now - hit.at >= this.pairCacheTtlMs) this.pairCache.delete(mint);
    }
    while (this.pairCache.size > JUP_PAIR_CACHE_MAX) {
      const oldest = this.pairCache.keys().next();
      if (oldest.done === true) break;
      this.pairCache.delete(oldest.value);
    }
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /**
   * Drop dispatches that have rolled out of the provider's window. Called at
   * every dispatch AND by the readers, so the ledger cannot grow without
   * bound on a client that a tick only sends a few calls from.
   */
  private pruneWindow(now: number): void {
    while (
      this.windowDispatchesAt.length > 0 &&
      now - this.windowDispatchesAt[0] >= JUP_RATE_WINDOW_MS
    ) {
      this.windowDispatchesAt.shift();
    }
  }

  /** Dispatches this client has made inside the provider's window right now. */
  windowDispatches(now = Date.now()): number {
    this.pruneWindow(now);
    return this.windowDispatchesAt.length;
  }

  /**
   * Bulk calls stood down to leave the card read its slot (cumulative for this
   * isolate's client). A non-zero reading on a tick is the reservation doing
   * work, and its size is the coverage that tick traded for the card's line.
   */
  bulkStoodDownCount(): number {
    return this.bulkStoodDown;
  }

  /**
   * Whether a 429 has this client paused right now — the reading that turns
   * "the feed was empty" into "the provider refused us" (a pause of missing
   * card lines is the same event).
   */
  isRateLimited(): boolean {
    return this.rateLimited();
  }

  /**
   * How much of the 429 pause is left, in ms (0 = not paused). The card read
   * compares this with its own wall to decide whether waiting the window out is
   * affordable (see fetchOrganicScore), and `cardReadNote()` records what
   * happened.
   */
  rateLimitedForMs(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now());
  }

  /**
   * The LAST card read's outcome — null until `fetchOrganicScore` is asked
   * (see JupCardReadNote). Last call wins, which is what the reader wants:
   * the tick asks right after the read it just made.
   */
  cardReadNote(): JupCardReadNote | null {
    return this.lastCardRead;
  }

  /**
   * Shared GET: throttle-spaced, 429-aware; null on any failure.
   *
   * The optional `signal` is the CALLER's abort for a read that has given up
   * (the tracker's bounded() cap — see Scanner.pairsForTracker): already
   * aborted it never reaches the wire, one aborted while queued is never
   * dispatched (see Throttle.run), and one aborted in flight is cancelled by
   * the fetch itself (see combineAbortSignals). Optional, so every existing
   * caller keeps its exact shape.
   *
   * `priority` rides straight into the lane (see Throttle.run) and is set only
   * by the card read.
   *
   * `allowPaused` is the CARD READ's one call (2026-10-17): it may try even
   * while a 429 has the client paused, because the provider's window is seconds
   * long and by the time a card slot opens it has usually reopened — while the
   * card's line and its three gates are the only calls that cannot be redone
   * next tick. Bulk lanes keep the pause.
   */
  private async get(
    path: string,
    signal?: AbortSignal,
    priority = false,
    allowPaused = false,
  ): Promise<unknown> {
    if (this.rateLimited() && !allowPaused) return null;
    this.lastStatus = 0;
    try {
      const doFetch =
        this.fetcher ??
        ((u: string, s?: AbortSignal) =>
          fetch(u, {
            headers: { Accept: "application/json" },
            // The caller's abort OR this attempt's own window, whichever
            // comes first (see combineAbortSignals).
            signal: combineAbortSignals(s, AbortSignal.timeout(10_000)),
          }));
      const res = await this.throttle.run<Response | null>(
        () => {
          // The card's reserved slot (see JUP_WINDOW_BULK_MAX). Checked at
          // DISPATCH, not at enqueue: the throttle may have held this call for
          // a second, and the window that matters is the one the request
          // actually lands in. A stood-down bulk call is NOT a failure — it is
          // a request the next tick will make — so it answers the same null an
          // unreachable provider does, and the counter is what tells the two
          // apart afterwards.
          if (!priority && this.reserveCardSlot) {
            const now = Date.now();
            if (this.windowDispatches(now) >= JUP_WINDOW_BULK_MAX) {
              this.bulkStoodDown += 1;
              return Promise.resolve(null);
            }
          }
          this.windowDispatchesAt.push(Date.now());
          return doFetch(`${BASE_URL}${path}`, signal);
        },
        signal,
        priority,
      );
      // A cut is NOT a request: the caller gave up while this attempt waited
      // for its slot, so there is no response — and no counter — to read.
      if (res === null) return null;
      // Recorded BEFORE the status checks so a caller reading a null answer
      // can name what happened (see lastStatus / JupCardReadNote).
      this.lastStatus = res.status;
      if (res.status === 429) {
        const now = Date.now();
        // What the provider advertises, clamped — see rateLimitPauseMs for the
        // measured 5-requests-per-10s window this replaced a fixed 5min with.
        this.rateLimitedUntil = now + rateLimitPauseMs(res.headers, now);
        return null;
      }
      if (!res.ok) return null;
      // An answer to the PROBE proves the provider is serving us again AFTER
      // the refusal, so end the pause early instead of sitting out the rest of
      // it (the feeds benefit on the next tick). A concurrent BULK answer is
      // NOT that proof — its request predates the 429 — and letting it clear
      // the pause would resurrect the burst the refusal just stopped (see the
      // one-shared-gate rule in fetchTokenDataBatch).
      if (allowPaused) this.rateLimitedUntil = 0;
      return await res.json();
    } catch {
      return null;
    }
  }


  /**
   * Organic-quality snapshot for a single mint (push-card enrichment):
   * Jupiter's organicScore separates real retail participation from
   * wash/coordinated volume (calibrated 2026-08-22: CONK 79 / 40M 75 /
   * BLC 61 vs DOTE 40 / BAOJIN 0 / Nudaeng 0).
   *
   * The same response carries Jupiter's own AUDIT block, and its `isSus` is
   * the only vendor-supplied suspicion flag this bot has (2026-09-28):
   * Jupiter's docs describe it as presence-only — "isSus is only present when
   * a token has been flagged" — so absent means NOT FLAGGED, never verified
   * safe. Reading it here costs nothing: same request, same parse, and the
   * scanner gates on it (scanner.jupSusBlockReason). `devBalancePct` rides
   * along for the reject reason and is display-only.
   *
   * Both audit numbers are null when the field is absent (unflagged) rather
   * than 0, so a caller can tell "Jupiter says nobody" from "Jupiter says
   * nothing" — the same distinction the bundler line makes.
   *
   * Trader count window fallback: Jupiter OMITS stats1h.numTraders
   * entirely when the trailing hour has zero trades (ARMY at push time —
   * stats1h only carried volumeChange), which silently dropped the
   * "| 1h 交易者" half of the card line. Fall back to the 6h then 24h
   * window and report which window the count came from (null = no
   * trader data in any window).
   *
   * THE LINE IS NON-RETRYABLE, SO THE READ IS ARMED THREE WAYS (2026-10-17).
   * This is the third recurrence of "the 有機度 line vanished from many cards"
   * (2026-09-17, 2026-09-26, now — see §4.23/§4.24 of docs/round-trips.md),
   * and both earlier rounds found the same shape: the reading EXISTS (measured
   * again 2026-10-17 from the deployed Worker's own egress: 21 recent pushes,
   * every mint answered in 44–268ms), and the card lost it to the TICK, not to
   * Jupiter. Unlike every feed in this file the card read is not re-tried by
   * the next tick — the card ships without the line, forever — so it is the one
   * call that must not be left to luck:
   *   1. it takes the lane's PRIORITY slot (see Throttle.run), so the bulk
   *      lanes a tick opens in front of it — two discovery feeds plus the pair
   *      fallback's chunks, which carry every address now that DexScreener's
   *      pair lane is refused fleet-wide — cannot push it past the chain wall;
   *   2. a first attempt that comes back WITHOUT a reading is retried ONCE, so
   *      a transient 5xx / broken body / single dropped search does not cost a
   *      card its line. `no-entry` / `empty` are retried too: a seconds-old
   *      launch is exactly when the search index can still be catching up, and
   *      for a coin that IS indexed those answers are the same one request to
   *      confirm. A 429 is NOT retried: the client is paused for
   *      JUP_RATE_LIMIT_BACKOFF_MS and a second call would either be sent into
   *      the same wall or (worse) counted as another request against a
   *      provider that just refused us;
   *   3. every read reports WHY (see JupCardReadNote, surfaced on the tick as
   *      `organicWhy`), because "the line is missing" and "the provider said
   *      429" were indistinguishable in production for three rounds.
   */
  async fetchOrganicScore(
    mint: string,
    /**
     * Optional sink for THIS read's outcome (see JupCardReadNote). A callback
     * rather than a read of `cardReadNote()` later, because the reader is a
     * card loop: two reads can be in flight across coins and the last-settled
     * note is not the one this card's line is about.
     */
    onNote?: (note: JupCardReadNote) => void,
    /**
     * The caller's WALL for this read (epoch ms) — the scanner hands it
     * `min(Date.now() + JUP_CARD_READ_WALL_MS, organicCardReadWall(startedAt))`:
     * the card's own hold deadline, so a 429 pause this call waits out is one
     * the send gate is still there for (2026-10-20 — before that the two waited
     * on different clocks and a failing reading landed on an already-sent card,
     * see Scanner.organicCardReadWall). Only one decision uses it: whether a
     * 429 pause is short enough to wait out before the second attempt (below).
     * Optional, so every existing caller keeps its exact shape (no deadline =
     * never wait).
     */
    deadlineMs?: number,
  ): Promise<JupOrganicReading | null> {
    const startedAt = Date.now();
    // 1) ONE attempt ALWAYS — even while a 429 has the client paused. The
    // provider's window is seconds long (measured: 5 requests / ~10s, see
    // rateLimitPauseMs), and a card slot opens ~2s into the tick, i.e. after
    // the bulk lanes that earned the 429 have themselves stopped: the window is
    // usually open again by now. This is the one call that cannot be redone
    // next tick, and it is also what the three Jupiter gates read.
    let attempt = await this.readOrganicOnce(mint, true);
    let retried = false;
    let waited = false;
    if (attempt.reading === null) {
      if (attempt.why === "backoff") {
        // The provider refused THIS attempt too. If what it advertised is a
        // few seconds and the card's wall can afford it, wait the window out
        // and take the second attempt — otherwise the card loses its line to a
        // window that a tick's own bulk load closed.
        const pauseMs = this.rateLimitedForMs();
        const room = deadlineMs === undefined ? 0 : deadlineMs - Date.now();
        if (
          pauseMs > 0 &&
          pauseMs <= JUP_RATE_LIMIT_WAIT_MAX_MS &&
          room > pauseMs + JUP_RATE_LIMIT_WAIT_MARGIN_MS
        ) {
          retried = true;
          waited = true;
          await sleep(pauseMs + 50);
          attempt = await this.readOrganicOnce(mint, true);
        }
      } else if (!this.rateLimited()) {
        // 2) A reading-less first attempt that was NOT a 429 is retried once
        // (transient 5xx / broken body / index lag on a fresh launch).
        retried = true;
        attempt = await this.readOrganicOnce(mint, false);
      }
    }
    const note: JupCardReadNote = {
      at: startedAt,
      ms: Date.now() - startedAt,
      why: attempt.reading !== null ? "ok" : attempt.why,
      status: attempt.status,
      retried,
      waited,
      landed: attempt.reading !== null,
    };
    this.lastCardRead = note;
    onNote?.(note);
    return attempt.reading;
  }

  /**
   * ONE attempt at the card read, with the REASON it produced what it did
   * (see JupCardReadNote). Never throws: a failure is a `why`, not an
   * exception, because the caller's whole contract is "the card omits the line
   * and pushes anyway" — the reason only has to survive to the tick summary.
   *
   * The single-mint read here is the ONE caller that takes the priority slot
   * (see Throttle.run and fetchOrganicScore) AND the one caller allowed to try
   * while a 429 pause is active (`allowPaused`).
   */
  private async readOrganicOnce(
    mint: string,
    /** May this attempt go out while a 429 has the client paused? */
    allowPaused: boolean,
  ): Promise<{
    reading: JupOrganicReading | null;
    why: JupCardReadWhy;
    /** The attempt's HTTP status (0 = nothing reached the wire). */
    status: number;
  }> {
    if (this.rateLimited() && !allowPaused) {
      return { reading: null, why: "backoff", status: 0 };
    }
    const data = await this.get(`/search?query=${mint}`, undefined, true, allowPaused);
    const status = this.lastStatus;
    if (data === null) {
      // A 429 raised by THIS call (get sets the pause) is named as such; any
      // other null is split by what the wire said — 0 or 200 means the
      // transport itself failed (throw / timeout / unparseable body), a
      // non-2xx status means the provider answered and refused.
      if (this.rateLimited()) return { reading: null, why: "backoff", status };
      return {
        reading: null,
        why: status === 0 || status === 200 ? "error" : "http",
        status,
      };
    }
    if (!Array.isArray(data)) return { reading: null, why: "body", status };
    const entry = data.find(
      (x) => (x as Record<string, unknown>).id === mint,
    ) as Record<string, unknown> | undefined;
    if (!entry) return { reading: null, why: "no-entry", status };
    const s1 = (entry.stats1h ?? {}) as Record<string, unknown>;
    // organicScore of 0 is a REAL value (BAOJIN/Nudaeng) — distinguish
    // "field absent" (undefined) from a genuine zero via typeof.
    const score =
      typeof entry.organicScore === "number" && Number.isFinite(entry.organicScore)
        ? entry.organicScore
        : null;
    const tradersOf = (stats: Record<string, unknown> | undefined) => {
      const raw = (stats ?? {}).numTraders;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    };
    const s6 = (entry.stats6h ?? {}) as Record<string, unknown>;
    const s24 = (entry.stats24h ?? {}) as Record<string, unknown>;
    let tradersH1 = tradersOf(s1);
    let tradersWindow: "1h" | "6h" | "24h" | null = tradersH1 !== null ? "1h" : null;
    if (tradersH1 === null) {
      tradersH1 = tradersOf(s6);
      if (tradersH1 !== null) {
        tradersWindow = "6h";
      } else {
        tradersH1 = tradersOf(s24);
        if (tradersH1 !== null) tradersWindow = "24h";
      }
    }
    // Audit block — present only when Jupiter has something to say about the
    // mints' safety. `isSus` is the flag the push gate reads; the dev balance
    // is carried for its reject reason. Absent fields stay null/false, never
    // coerced into a reassuring 0.
    const audit = (entry.audit ?? {}) as Record<string, unknown>;
    const sus = audit.isSus === true;
    const devRaw = audit.devBalancePercentage;
    const devBalancePct =
      typeof devRaw === "number" && Number.isFinite(devRaw) ? devRaw : null;
    // The flag ALONE is a reason to return a reading: a flagged token whose
    // organic score and trader count are both missing must still reach the
    // gate, or the gate would fail open exactly where it matters most.
    //
    // This is also the ONE shape a retry cannot fix: the search answered, in
    // time, for this mint, and Jupiter simply has no organic data for it
    // (`empty`) — so the note says exactly that instead of "no data".
    if (score === null && tradersH1 === null && !sus) {
      return { reading: null, why: "empty", status };
    }
    return {
      reading: {
        score,
        label:
          typeof entry.organicScoreLabel === "string" ? entry.organicScoreLabel : null,
        tradersH1,
        tradersWindow,
        sus,
        devBalancePct,
      },
      why: "ok",
      status,
    };
  }

  /** Newest launchpad launches (pump.fun & co.), newest first. */
  async fetchRecentTokens(limit: number): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 100));
    // Slice client-side: measured 2026-08-21 the lite-api returns ≥30 rows
    // regardless of the limit param, and the configured cap IS the Turso
    // rows-read budget guard (every extra row can become a token_stats one).
    // 2026-09-28: the cap moved 20 → 30 because of exactly that measurement —
    // the rows were already in the response, so the cap was choosing how many
    // of them to use, not how many to ask for.
    // 2026-09-28: the cap moved 20 → 30 because of exactly that measurement —
    // the rows were already in the response, so the cap was choosing how many
    // of them to use, not how many to ask for.
    return parseJupTokens(await this.get(`/recent?limit=${wanted}`)).slice(
      0,
      wanted,
    );
  }

  /**
   * Organic-score ranked tokens over the trailing 24h window.
   *
   * 2026-09-21 — the endpoint moved. `/trending/24h` answers HTTP 200 with an
   * EMPTY array (`[]`, 2 bytes) now, from the worker's egress AND from a
   * normal host, while `/recent` on the same API serves data in the same
   * minute — so this was not a 429, not a parse problem and not our egress:
   * the endpoint stopped serving. The feed never produced a coin again
   * (`jupTrend 0` on every sampled tick), i.e. one subrequest per tick for
   * nothing. `/toporganicscore/24h` is the live endpoint for what this feed
   * exists for — "early catch of resurging mints": measured the same day, 4
   * of its top 20 entries sat inside the scanner's qualifying age window
   * (12.5h–24h, mcap 177K–4.0M, organic score 75+) on established liquidity,
   * which is the resurging-mint shape this feed is for. Entries outside the
   * window are rejected by the age gate exactly as before — "mostly outside
   * the qualifying window" was already this feed's documented behaviour.
   */
  async fetchTrendingTokens(
    limit: number,
    band: TrendBand | null = null,
  ): Promise<TokenProfile[]> {
    const wanted = Math.max(1, Math.min(Math.floor(limit), 100));
    return parseJupTrendTokens(
      await this.get(`/toporganicscore/24h?limit=${wanted}`),
      band,
      Date.now(),
    ).slice(0, wanted);
  }

  /**
   * Batched gate data for arbitrary mints — the FALLBACK price source when
   * DexScreener's batched endpoint is 429-blocked. One call per 100 mints
   * covers every scan gate: mcap, liquidity, 5m/1h volume + change,
   * buy/sell counts and pool creation time.
   *
   * 2026-09-12: the chunk loop was unbounded in wall time — with a ~500-mint
   * missing set it walked 5 chunks × (10s per-request timeout + throttle
   * spacing) ≈ 50s+, and on 429/5xx-heavy ticks the scan never settled
   * inside the worker's 12s race: the isolate was killed at the ~30s wall
   * clock and the tick died before its completion flush (the recurring
   * "died before its completion flush — backfilled by next tick" rows,
   * 08:10–08:27Z). Capped at 3500ms: covers 2–3 chunks (~200–300 mints, more
   * than the ~100–160-coin pool needs) at normal latency; chunks past the
   * deadline keep their tokens in the re-eval pool for the next tick (same
   * fail-safe as the DexScreener batch skip). Every phase is now
   * deadline-bounded, so a tripped race still settles and flushes a
   * diagnosable timeout row instead of dying as a dead tick.
   */
  async fetchTokenDataBatch(
    mints: string[],
    /**
     * Absolute epoch ms the CALLER's phase must be done by (the scanner's
     * front-phase window, see FRONT_PHASE_WINDOW_MS). Same contract as
     * DexScreenerClient.fetchPairsForTokens' second parameter — and it exists
     * for the same reason.
     *
     * WHY (2026-10-01, follow-up to the 73-cut outage). The scanner used to
     * check only that SOME front window was left and then hand this method
     * nothing, so the leg spent its own full 900ms from its own start: started
     * 1ms before `frontDeadline` it still ran ~900ms PAST it, i.e. it could eat
     * most of the 1_600ms gate/push reserve (SCAN_GATE_RESERVE_MS) that the
     * front caps exist to protect. It was the last front leg whose budget was
     * not clamped to the shared window. A deadline ALREADY IN THE PAST sends
     * nothing (the loop's own first check does it), exactly like the pair lane.
     */
    callerDeadlineMs?: number,
    /**
     * The CALLER's abort for a read that has given up (the tracker's
     * bounded() cap — see Scanner.pairsForTracker): a leg the pass has
     * abandoned stops opening chunks and cancels the one in flight, instead
     * of running on for nobody. Same contract as the DexScreener client's
     * fetchPairsForTokens. Optional, so every existing caller and test double
     * keeps its shape.
     */
    signal?: AbortSignal,
    max = 500,
  ): Promise<Map<string, PairInfo>> {
    const out = new Map<string, PairInfo>();
    const list = mints.filter((m) => MINT_RE.test(m)).slice(0, Math.max(0, max));
    const nowMs = Date.now();
    // REUSE FIRST (2026-10-17, see pairCache): serve the readings this client
    // already has inside the TTL, and ask the wire only for the rest. The TTL
    // is the staleness bound every gate accepts — an older reading is never
    // served, it is re-fetched below.
    let asked = list;
    if (this.pairCacheTtlMs > 0) {
      this.prunePairCache(nowMs);
      asked = [];
      for (const mint of list) {
        const hit = this.pairCache.get(mint);
        if (hit && nowMs - hit.at < this.pairCacheTtlMs) {
          out.set(mint, hit.pair);
          this.pairCacheHits += 1;
        } else {
          asked.push(mint);
        }
      }
    }
    const deadline = Math.min(
      Date.now() + JUP_FALLBACK_BUDGET_MS,
      typeof callerDeadlineMs === "number"
        ? callerDeadlineMs
        : Number.POSITIVE_INFINITY,
    );
    // The shared chunk queue: each lane claims the next chunk SYNCHRONOUSLY
    // (slice + increment are one uninterrupted step, so two lanes can never
    // claim the same chunk), then does its own round trip inside the ONE
    // shared deadline. See JUP_FALLBACK_CONCURRENCY for why the lanes exist.
    const chunkCount = Math.ceil(asked.length / JUP_BATCH_SIZE);
    let nextChunk = 0;
    const lane = async (): Promise<void> => {
      while (nextChunk < chunkCount) {
        // The serial loop's own rules, kept per lane: once the client is
        // paused by a 429 no NEW chunk may be dispatched (a lane already on
        // the wire cannot be recalled — which is exactly why the lane count
        // stays small), a deadline already gone stops the lane, and the
        // same holds once the CALLER has given up (see signal).
        if (this.rateLimited() || Date.now() > deadline || signal?.aborted) return;
        // A chunk the lane cannot START inside the window is not attempted at
        // all — the same rule the serial loop applied (and the DexScreener
        // pair lane's batches): a request that cannot finish is pure latency,
        // and its tokens keep their pool slot for the next rotation.
        const remaining = deadline - Date.now();
        if (remaining <= JUP_FALLBACK_MIN_ROOM_MS || signal?.aborted) return;
        const chunk = asked.slice(
          nextChunk * JUP_BATCH_SIZE,
          (nextChunk + 1) * JUP_BATCH_SIZE,
        );
        nextChunk += 1;
        // Race the request itself against the remaining budget: checking the
        // deadline BETWEEN chunks bounds the loop but not a single hung
        // request (each get() carries its own multi-second transport
        // timeout), so one stalled call could carry this phase — and the
        // gate/push phase behind it — past the scan's deadline. A chunk that
        // expires contributes nothing; the other lane's chunk is unaffected.
        // The race's LOSER is now ABORTED (2026-10-17): a chunk whose window
        // ran out used to keep its queued attempt, which then dispatched
        // LATER — past the phase that wanted it — and spent a full throttle
        // slot the CARD's own organic read (same client, same lane) was
        // waiting for. With the pair lane refused fleet-wide this leg runs on
        // every tick, so those orphan dispatches landed right where the
        // card's read needed its slot. A cut attempt dies at the cut: while
        // still queued it never dispatches (Throttle.run), and one already on
        // the wire is cancelled by the fetch itself.
        const chunkAbort = new AbortController();
        let chunkTimer: ReturnType<typeof setTimeout> | undefined;
        const data = await Promise.race([
          this.get(
            `/search?query=${chunk.join(",")}`,
            combineAbortSignals(signal, chunkAbort.signal),
          ),
          new Promise<null>((resolve) => {
            chunkTimer = setTimeout(() => {
              chunkAbort.abort(new Error("chunk window spent"));
              resolve(null);
            }, remaining);
          }),
        ]);
        // Cleared either way: a pending timer would abort a LATER chunk's
        // signal (the lanes share this client) and hold the isolate open.
        if (chunkTimer !== undefined) clearTimeout(chunkTimer);
        for (const [k, v] of jupToPairInfos(data)) {
          out.set(k, v);
          // Stored even when the value came back, never when it did not: a
          // mint the provider has no entry for must be re-asked next tick,
          // not remembered as empty.
          this.pairCacheFetched += 1;
          if (this.pairCacheTtlMs > 0) {
            this.pairCache.set(k, { pair: v, at: Date.now() });
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(JUP_FALLBACK_CONCURRENCY, chunkCount) },
        () => lane(),
      ),
    );
    return out;
  }
}
