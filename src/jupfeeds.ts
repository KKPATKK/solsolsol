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
const JUP_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

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
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return null;
    const wait = Math.max(0, this.lastCallAt + this.intervalMs - Date.now());
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

export class JupTokensClient {
  private readonly throttle: Throttle;
  /** Timestamp until which all calls are skipped (after a 429). */
  private rateLimitedUntil = 0;

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
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
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
   */
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    if (this.rateLimited()) return null;
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
      const res = await this.throttle.run(
        () => doFetch(`${BASE_URL}${path}`, signal),
        signal,
      );
      // A cut is NOT a request: the caller gave up while this attempt waited
      // for its slot, so there is no response — and no counter — to read.
      if (res === null) return null;
      if (res.status === 429) {
        this.rateLimitedUntil = Date.now() + JUP_RATE_LIMIT_BACKOFF_MS;
        return null;
      }
      if (!res.ok) return null;
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
   */
  async fetchOrganicScore(
    mint: string,
  ): Promise<{
    score: number | null;
    label: string | null;
    tradersH1: number | null;
    tradersWindow: "1h" | "6h" | "24h" | null;
    /** Jupiter flagged this token as suspicious (audit.isSus present+true). */
    sus: boolean;
    /** Deployer's share of supply, in percent (audit.devBalancePercentage). */
    devBalancePct: number | null;
  } | null> {
    const data = await this.get(`/search?query=${mint}`);
    if (!Array.isArray(data)) return null;
    const entry = data.find(
      (x) => (x as Record<string, unknown>).id === mint,
    ) as Record<string, unknown> | undefined;
    if (!entry) return null;
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
    if (score === null && tradersH1 === null && !sus) return null;
    return {
      score,
      label: typeof entry.organicScoreLabel === "string" ? entry.organicScoreLabel : null,
      tradersH1,
      tradersWindow,
      sus,
      devBalancePct,
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
    const chunkCount = Math.ceil(list.length / JUP_BATCH_SIZE);
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
        const chunk = list.slice(
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
        const data = await Promise.race([
          this.get(`/search?query=${chunk.join(",")}`, signal),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), remaining),
          ),
        ]);
        for (const [k, v] of jupToPairInfos(data)) out.set(k, v);
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
