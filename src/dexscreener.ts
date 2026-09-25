import type { AppConfig } from "./config";
import { missingDeferredTokens, noteProfileFeed } from "./deferredmakeup";

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
  /** Circulating market cap. Every gate and every recorded push baseline
   * reads THIS field, so it must never be silently filled with an FDV. */
  marketCap: number;
  /**
   * Fully-diluted valuation when the source reports one, kept SEPARATE from
   * `marketCap`. FDV counts supply that is not circulating (locked/vested),
   * so it can be several times the market cap — folding the two together is
   * how a $1.59M FDV got recorded as the push price of a coin whose market
   * cap never passed ~$341K (2026-09-19 audit). `null`/absent = the source
   * carries no FDV figure.
   */
  fdvUsd?: number | null;
  /**
   * True when `marketCap` had to be filled from an FDV because the source
   * carried no circulating-market-cap figure (the Jupiter and GeckoTerminal
   * legs report only FDV for most Solana memecoins). Gating still uses the
   * value — the alternative is no data at all — but every recorded baseline
   * carries this flag, so calibration can exclude FDV-derived rows instead
   * of mistaking a valuation for a market cap.
   */
  mcapFromFdv?: boolean;
  volume: { h24: number; h1: number; m5: number };
  priceChange: { m5: number; h1: number };
  /** Transaction counts (DexScreener txns) — buy/sell pressure signal. */
  txns: { m5Buys: number; m5Sells: number; h1Buys: number; h1Sells: number };
  liquidity: { usd: number | null };
  pairCreatedAt: number;
  /**
   * Which upstream produced this row. The three legs feeding the scanner do
   * NOT share a liquidity metric, and the difference is a factor of ~2 — not
   * noise: DexScreener's `liquidity.usd` is the pool's total USD reserve,
   * while Jupiter's per-token `liquidity` is roughly HALF of it for the very
   * same pool (measured 2026-09-20 over the tracker's rotation: 10 of 14
   * recently-checked rows carried a Jupiter reading at 0.46–0.58× the
   * DexScreener value, e.g. Lobby 7950 vs 17446, SI 13305 vs 26568, DONATED
   * 29327 vs 55212 — while `stored/Jupiter` was 0.98–1.02 on every one).
   *
   * Any rule that judges an ABSOLUTE USD level (or compares two readings)
   * must therefore only mix like with like — see comparableLiquidity in
   * pushwatch.ts, which is what turned this into a false 💧 流動性枯竭 card.
   * Absent (legacy fixtures, synthetic pairs) = treated as DexScreener.
   */
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the profiles feed may keep trying (2026-09-19), attempt 1 included.
 *
 * THE FIRST ATTEMPT IS BOUNDED NOW TOO. It used to be left to the scanner's
 * own race — "a healthy response is sometimes slower than this budget, and
 * truncating it would trade a real feed for the make-up list" — but the race
 * keeps its own `[]` while the make-up list is built INSIDE this call, after
 * the fetch settles, so any fetch the race discards takes the deferred
 * backlog's only guaranteed lane with it. That is precisely what a completely
 * hung upstream does (no 429, no 5xx — just no answer): the call's abort floor
 * was 1000ms, LONGER than the 600ms window it had to fit inside, so the race
 * always won and the tick went out with nothing. Live 2026-09-19: the 13:56
 * tick was the retry-chain-expiry path (already rescued); the HANGING upstream
 * was still the old behavior.
 *
 * 480 IS A MEASUREMENT, NOT A THEOREM — and it is now the number the whole
 * call rests on: the call has to be DONE (make-up included) before the race
 * fires, i.e. `budget < window remaining`. The window is FEED_DEADLINE_MS
 * (900ms) called from the tick's own start, and this call is dispatched there
 * (the profiles fetch is kicked off FIRST — see scanner.runOnce), so a normal
 * front leaves it most of that window; 480 also stays under the throttle gap
 * plus the retry floor (250 + 250), which is what keeps a 5xx on THIS leg a
 * fail-fast instead of a doomed second attempt.
 *
 * WHY IT ROSE FROM 320 (2026-09-25): the live reading was `raw 0` tick after
 * tick with the make-up lane filling the list — i.e. the fetch was being
 * ABORTED, not refused (a 429 answers in ~350ms and is counted as `failed`,
 * not as an empty feed). Two causes, both fixed here: the abort window was
 * measured BEFORE the throttle queue rather than at dispatch (see getJson),
 * and 320ms was too tight for the shared-egress latency of the 900ms window.
 * The retry arithmetic below is unchanged: at 480 a second attempt still
 * cannot fit inside the throttle gap + RETRY_MIN_ATTEMPT_MS, so the leg still
 * answers within one attempt.
 *
 * Why the chain has to be bounded at all: the scanner races this one call
 * against the tick's feed window — FEED_DEADLINE_MS from the tick's start
 * (600ms when this was written, 900ms now) — and keeps the race's `[]` when
 * the window closes first,
 * so anything returned late is thrown away, make-up list included. The call
 * used to be made with NO deadline, so a single 429 (shared worker egress:
 * http429 12 in one isolate) started the 3-attempt chain with its 2s/4s backoff
 * (~6s) and lost that race every time: live, 9 of 40 ticks reported
 * `profiles 0` with every feed empty and the deferred backlog's only
 * guaranteed lane missing, and the 429 stamps sit inside those very ticks
 * (13:26:10.250 → the 13:26 tick, 13:31:09.915 → the 13:31 tick).
 *
 * With the chain bounded, a 429 resolves in ~budget ms (attempt 1 fails fast,
 * the capped backoff spends the rest, attempt 2 finds the budget gone and
 * returns null) — i.e. well inside the scanner's feed window, so the make-up
 * list this call returns on failure is what the tick actually evaluates.
 * Live after the change: `feedsMs 320, profiles 5, failedTotal 1,
 * lastRawProfiles 0, emptyFeedTotal 0` — the first failed fetch that did NOT
 * cost the backlog its lane.
 */
export const PROFILE_FEED_SELF_BUDGET_MS = 480;

/**
 * What a budgeted caller must have left before a retry is worth starting (see
 * getJson): enough for one real attempt after the throttle gap is paid. Below
 * this the retry can only convert budget into wall clock, and the caller's
 * window is what the OTHER feeds need — measured 2026-09-19: a 429 that burned
 * the profiles call's full 320ms left the tick's feed fan-out 226ms, under
 * `fetchFeedCapped`'s 250ms floor, so Jupiter returned 0 for that minute.
 */
const RETRY_MIN_ATTEMPT_MS = 250;

/**
 * How long the last non-empty profile list may be evaluated again when the
 * next fetch produces nothing usable (see shouldReuseProfileList).
 *
 * WHY (2026-09-19, measured live): /token-profiles/latest/v1 answers **429
 * once per ~5 minutes** on the shared worker egress. Two independent samples of
 * the tick at minute%5==1: `lastRawProfiles 0, failedTotal +1, http429 +1,
 * last429At` inside that very tick, `blockedForMs` armed afterwards — and in
 * the preceding two hours **18 of 18** such ticks matched while every other
 * tick returned 20 raw profiles. The cost was one tick in five discovering
 * nothing (`profiles 4` = the make-up list alone).
 *
 * Widening PROFILE_FEED_SELF_BUDGET_MS cannot fix this: a 429 answers in
 * ~350ms, so more budget only buys more retry attempts against a door that is
 * shut for ~30s. What is scarce is not time, it is the list — and the previous
 * tick's list is a fine stand-in (the feed is a slowly rotating ~24-slot list,
 * and its coins are what the pool re-evaluates anyway).
 *
 * The bound exists so a DEAD feed cannot be papered over forever: past it, the
 * tick goes back to the make-up list alone. 10 minutes is deliberately longer
 * than the 5-minute outage cycle it absorbs, and short enough that a permanent
 * rate-limit shows up as `profiles` collapsing to the make-up size.
 */
export const PROFILE_FEED_REUSE_MS = 10 * 60_000;

/**
 * Self-budget for the boosted-token feed (/token-boosts/latest/v1), the same
 * shape as the profiles feed's budget: one request, no retry chain worth
 * waiting for. It is an OPTIONAL leg in the scanner (dropOptionalLeg), so a
 * 429 here costs one list, not the tick.
 */
export const BOOST_FEED_SELF_BUDGET_MS = 480;

/**
 * Should this tick evaluate the previous profile list instead of the one it
 * just fetched? Pure and exported so the rule is unit-tested rather than only
 * observed (scripts/test-deferred-priority.js).
 *
 * A non-empty fetch always wins — it is the fresh list. A failure (429, 404, a
 * hung upstream abandoned at the budget) or an empty answer reuses the last
 * good list, but only while it is younger than the window and only if one was
 * ever fetched.
 */
export function shouldReuseProfileList(
  fetched: number,
  failed: boolean,
  cachedAt: number | null,
  now: number,
  maxAgeMs: number,
): boolean {
  if (fetched > 0 && !failed) return false;
  if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt) || !(cachedAt > 0)) {
    return false;
  }
  const age = now - cachedAt;
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Compound momentum gate: a coin qualifies when its 5-minute tape is hot
 * (fast pump in progress right now) OR its 1-hour tape is hot (pumped
 * within the last hour and possibly consolidating between spikes — the
 * single-instant 5m snapshot alone misses coins sampled mid-pullback).
 * Exported for offline unit tests.
 */
export function passesChgGate(
  chg5m: number,
  chg1h: number,
  min5mPct: number,
  min1hPct: number,
): boolean {
  return chg5m >= min5mPct || chg1h >= min1hPct;
}

/**
 * Spaces out request DISPATCHES so actual request starts stay ≥ interval
 * apart, globally across all concurrent callers. Calls chain on the previous
 * dispatch (not its completion), so one caller's in-flight response may
 * overlap the next caller's spacing wait — pipelining without bursting.
 * (Without the chain, two concurrent callers would both compute the same
 * wait from lastCallAt and fire simultaneously — the exact 429 shape this
 * class exists to prevent.) Sequential callers behave exactly as before.
 */
class Throttle {
  private lastCallAt = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const dispatched = this.tail.then(async () => {
      const wait = Math.max(0, this.lastCallAt + this.intervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
    });
    this.tail = dispatched;
    return dispatched.then(() => fn());
  }
}

/**
 * Hard wall-clock budget for one fetchPairsForTokens call. A slow/limited
 * batch endpoint must not eat the whole scan tick (observed: 87s of retries
 * for 4 batches of 30 addresses, when the tick's heartbeat budget is 26s).
 * Batches past the deadline are skipped; their tokens simply stay in the
 * re-evaluation pool and are retried next tick.
 *
 * 2026-09-12: 10000 → 5500. After the feed-deadline cut (5500 → 4500, same
 * day) ticks STILL tripped the worker's 12s race budget (12.1–12.5s) — the
 * pairs phase is the only remaining phase with a budget larger than what's
 * left of the tick: 4.5s feeds + ~1s tracker/pool overhead + 10s pairs =
 * ~14.5s worst case, so every DexScreener-throttled tick rides the pairs
 * budget straight past the race. 5500 caps the worst-case envelope at
 * ~11s, leaving ~1s of flush headroom inside the 12s race, independent of
 * upstream health. Skipped batches are safe by design: those tokens stay
 * in the re-eval pool and are retried next tick (cache hits still served
 * instantly). Restore to 10000 only after a full day of zero budget rows
 * with the pairs phase visibly finishing early (evalMs well under the cap).
 *
 * 2026-09-12 (later): 5500 → 4500. The 5500 cap cleared the dead ticks
 * (the unbounded Jupiter fallback was the hang) and converted most ticks
 * into completions, but 08:39–08:47Z still showed the bimodal tail:
 * green ticks 7.2–8.7s vs trips 12.1–12.2s — trips happen when BOTH the
 * feed phase (4.5s) and pairs (5.5s) run to their caps, and 4.5 + 5.5 +
 * ~1.5s DB/registration/tracker overhead rides the 12s race edge. 4500
 * puts the combined worst case at 9s + overhead ≈ 10.5s with real flush
 * headroom. Same rollback ladder as every cap above; skipped batches stay
 * in the pool for the next tick. Raise only after a full day of zero
 * budget rows with evalMs visibly under the cap.
 *
 * 2026-09-15: 4500 → 2000. The cap was larger than the whole scan race
 * (~5.6s minus the 1.8s feed phase), so on any throttled tick the pairs
 * phase ran past the race and the tick was cut BEFORE the gates saw the
 * data it had just fetched — the `agedEval 0 / candidates 0` rows, i.e.
 * upstream work paid for and thrown away. 1500 is sized from the phase
 * timings the scanner reports live (feeds ~0.9s + pool read ~1.0s +
 * push-watch ~0.7s before this phase, so ~2.6s of the ~5.1s race is already
 * spent): the fetch dispatches a batch every DEX_REQUEST_INTERVAL_MS
 * (350ms → 250ms via wrangler.toml; ~5 → ~6 batches inside the pairs cap)
 * and cannot usefully start more than ~6 inside that remainder, so
 * a larger cap only delays the GATE phase past the race — which is how a
 * tick ends up with `agedEval 0`, every fails counter at 0 and a whole
 * fetch discarded. Capping earlier converts those into ticks whose gates
 * actually run on the coins fetched (plus every 3-min pair-cache hit in the
 * slice, which costs no request at all). Skipped tokens keep their pool slot
 * and are re-read on the next rotation slot: the cost of the cap is
 * latency, never coverage.
 *
 * 2026-09-15 (later): dispatch spacing 350 → 250ms (DEX_REQUEST_INTERVAL_MS,
 * wrangler.toml). This cap is unchanged — what changes is how many
 * 2026-09-16 (later): 1500 → 1250, funding the gate window on the re-cut
 * tick ladder. The pair phase is the last front phase, and the candidate it
 * fetches still has to be GATED before it can be pushed: live ticks that
 * found one ended `candidates: 1, pushed: 0` because the ~2–3s gate chain
 * (≈10 sequential awaits) only got ~1s. 1250ms still dispatches 5 slots at
 * the 250ms spacing (150 addresses, minus the feed's ~15–20 — the slice is
 * re-sized to match), so the coins actually fetched are unchanged in kind
 * while the gates gain 250ms.
 *
 * 30-address batches fit inside it. Starts are spaced globally by the shared
 * Throttle, so a 1.5s window held 5 dispatch slots at 350ms and holds 6 at
 * 250ms: ~30 more addresses fetched per tick for the same wall clock and the
 * same rows read from Turso. This is the "smaller throttle spacing" lever
 * the scanner's slice sizing points at. Watch /health → dex.http429: a
 * rising counter means the shared egress IP is being rate-limited again, and
 * the fix is to restore 350 (or higher) via DEX_REQUEST_INTERVAL_MS rather
 * than to touch this cap.
 *
 * 2026-09-19: 1250 → 1000, funding the CLAIM (paired with RE_EVAL_PER_TICK_MAX
 * 130 → 90 in scanner.ts). This cap is the last front phase, and the coin it
 * fetches still has to clear its gates, render and take the push claim before
 * the claim gate closes at 3550ms (cardClaimDeadline). Live before the cut:
 * every candidate the last two hours found was deferred — `cand>0 & pushed=0`
 * was 45 of 45 ticks — with the front phases ending at 3.2–3.4s and the chain
 * reaching the claim just past that boundary. 1000ms still dispatches 4 slots
 * at the 250ms spacing = 120 addresses, and the slice was re-sized to match
 * (90 + the feed's ~24 = 114), so the fetch finishes in ~1s instead of riding
 * its cap and the gates gain the difference. Same rule as every entry above:
 * skipped tokens keep their pool slot and are re-read on the next rotation
 * slot — the cost is latency (and a ~1.4× longer sweep), never coverage.
 */
const PAIRS_FETCH_BUDGET_MS = 1_000;
/**
 * Pair-data cache TTL. The re-eval pool rotates slowly (same coins swept
 * minute after minute), so re-fetching all ~550 addresses every tick burns
 * ~19 batched requests/min against a shared egress IP that other tenants
 * also hammer — the observed hard 429 block. A short TTL keeps gate math
 * fresh enough (cooldowns are ≥30 min) while cutting request volume ~70%.
 */
const PAIR_CACHE_TTL_MS = 180_000;
/** Cache size cap (oldest entries evicted) — bounds isolate memory. */
const PAIR_CACHE_MAX = 4_000;
/** After a batched-endpoint 429, skip all batch calls for this long. */
const PAIR_BATCH_BACKOFF_MS = 90_000;
/**
 * Batch requests kept in flight concurrently. The pair loop used to dispatch
 * strictly sequentially — each batch waited for the previous response before
 * even arming its throttle spacing — so fetch cost scaled as
 * N × (spacing + latency). Two workers pulling from the shared batch queue
 * overlap each batch's network latency with the next batch's spacing:
 * 7 batches cost ~(N-1) × spacing + latency ≈ 2.6s where 5 sequential
 * batches cost ~2.7s. Dispatch RATE is unchanged — the shared Throttle
 * still spaces actual request starts globally.
 *
 * 2026-09-15: 2 → 3 (the same reasoning, one more worker): with the pairs
 * budget at 2.0s the phase is latency-bound inside a short window, so the
 * third worker overlaps one more batch's response with the throttle
 * spacing instead of waiting behind it. Request STARTS stay spaced by the
 * shared throttle, so upstream request rate is unchanged — only how much
 * of the window is spent waiting on responses is.
 */
const PAIR_BATCH_CONCURRENCY = 3;

/**
 * Telemetry hooks so the worker can persist rate-limit events cross-isolate:
 * the client itself has no DB handle, and a 429 arms a 90s cache-only backoff
 * that must be visible from any isolate serving /health, not just the one
 * that happened to run the scan.
 */
export interface DexScreenerHooks {
  /**
   * Fired once per rate-limit episode (the first 429, not every retry
   * attempt of it), after the cache-only backoff is armed.
   */
  onBatch429?: (at: number) => void;
}

export class DexScreenerClient {
  private readonly throttle: Throttle;
  /** Fresh pair data by token (see PAIR_CACHE_TTL_MS). Insertion-ordered. */
  private readonly pairCache = new Map<
    string,
    { pair: PairInfo; at: number }
  >();
  /** Until this epoch the endpoint 429'd — serve pair cache only. */
  private batchBlockedUntil = 0;
  /** 429 responses seen by this isolate (incl. retry attempts). */
  private http429Total = 0;
  /** Epoch of the most recent 429 response, or null if never. */
  private last429At: number | null = null;
  /**
   * The last profile fetch that returned coins, and when (see
   * PROFILE_FEED_REUSE_MS): what a rate-limited tick evaluates instead of
   * nothing. In-memory by design — the scanner hands this list to the tick, so
   * a recycled isolate simply starts without it.
   */
  private lastGoodProfiles: { at: number; list: TokenProfile[] } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly hooks: DexScreenerHooks = {},
  ) {
    this.throttle = new Throttle(config.dexRequestIntervalMs);
  }

  /**
   * Live rate-limit telemetry for /health: the configured dispatch spacing
   * (DEX_REQUEST_INTERVAL_MS), how often the shared egress IP has been 429'd
   * since this isolate booted, and how long the cache-only backoff still has
   * to run. `blockedForMs > 0` means the batched endpoint is refusing us and
   * every tick is serving cache-only until it clears.
   */
  getStats(): {
    intervalMs: number;
    http429: number;
    last429At: number | null;
    blockedForMs: number;
    cacheSize: number;
  } {
    return {
      intervalMs: this.config.dexRequestIntervalMs,
      http429: this.http429Total,
      last429At: this.last429At,
      blockedForMs: Math.max(0, this.batchBlockedUntil - Date.now()),
      cacheSize: this.pairCache.size,
    };
  }

  /**
   * Record a 429 and arm the cache-only backoff. Called from getJson — the
   * only place the status is visible — because the pair path's retry loop
   * turns a budgeted 429 into a `null` response (attempt 2 sees the deadline
   * already gone and returns null instead of throwing), so the batch loop's
   * own /429/ check never ran on the real path: the backoff never armed and a
   * rate-limited tick looked identical to an empty one. Counting here makes
   * the limit observable (getStats → scan summary → /health) and lets the
   * next tick go straight to cache-only.
   *
   * One hook per episode: a storm is 3 retry attempts × N batches, and the
   * hook writes to Turso, so re-notifying while the backoff is already armed
   * would turn a rate limit into a write flood. The counter still increments
   * per response (that is the drip signal); only the notify is debounced.
   */
  private note429(): void {
    const now = Date.now();
    const episodeStart = now >= this.batchBlockedUntil;
    this.http429Total++;
    this.last429At = now;
    this.batchBlockedUntil = now + PAIR_BATCH_BACKOFF_MS;
    if (!episodeStart) return;
    try {
      this.hooks.onBatch429?.(now);
    } catch {
      // telemetry only — never fail a request over a counter write
    }
  }

  /**
   * GET JSON with retries for transient errors (429/5xx). Deterministic
   * client errors (4xx) return null immediately — retrying a 404 for a
   * delisted token never helps, and the re-evaluation pool regularly
   * contains delisted coins, so this saves ~8s per failing batch.
   * `deadline` (optional, ms epoch) bounds the whole attempt loop: attempt 1's
   * abort is clamped to the budget too (a bounded caller must not outlive the
   * deadline it was handed), the backoff sleeps only as long as the budget
   * allows, and once it is exhausted the call returns null instead of
   * throwing.
   */
  private async getJson(path: string, deadline?: number): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining =
        deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (remaining <= 0) return null; // budget exhausted — stop trying
      try {
        const res = await this.throttle.run(async () => {
          // COUNT THE THROTTLE WAIT AGAINST THE CALLER'S DEADLINE (2026-09-25).
          // `remaining` above was computed BEFORE the queue, and the throttle
          // can hold this attempt far longer than that — the request was then
          // issued with an abort window that had already expired (or with a
          // 1ms one), i.e. a bounded caller could outlive the budget it was
          // handed AND spend a doomed request doing it. Measured live: the
          // profiles feed read `raw 0` tick after tick while the make-up lane
          // quietly filled the list (the fetch was aborted before it could
          // answer). The wait is now paid out of the same window: a spent
          // budget ends the attempt here instead of sending it.
          if (deadline !== undefined && Date.now() >= deadline) return null;
          // A BOUNDED caller gets its deadline enforced on every attempt,
          // attempt 1 included. The old 1000ms floor was longer than the
          // 600ms window the profiles feed is handed, so the feed outlived
          // its caller's race and the race threw the make-up list away with
          // the body (see PROFILE_FEED_SELF_BUDGET_MS). An unbounded caller
          // keeps the full 15s.
          const left =
            deadline === undefined
              ? 15_000
              : Math.max(1, Math.min(15_000, deadline - Date.now()));
          return fetch(`${BASE_URL}${path}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(left),
          });
        });
        // A throttled-away attempt (the window closed while it queued) is a
        // budget answer, not a failure: the caller already owns its own
        // fallback, and retrying would only spend the caller's window.
        if (res === null) return null;
        if (res.status === 429) this.note429();
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`DexScreener HTTP ${res.status}`);
        }
        if (!res.ok) {
          return null; // deterministic client error — retrying won't help
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        // A 429 is never retried by a BUDGETED caller (see below); an unbounded
        // caller keeps its 2s/4s spacing, since it has no window to protect.
        const rateLimited =
          deadline !== undefined &&
          /429/.test(err instanceof Error ? err.message : String(err));
        const left =
          deadline === undefined
            ? Number.POSITIVE_INFINITY
            : deadline - Date.now();
        // A budgeted caller needs ROOM for the retry to be a retry rather than
        // a way to spend the window. The throttle alone (dexRequestIntervalMs,
        // 250-350ms) sits between two attempts, so an attempt started with less
        // than that left cannot reach the network before its own abort fires:
        // it just converts the caller's budget into wall clock. Measured
        // 2026-09-19 18:11:11Z: the profiles call held the tick until +674ms
        // (its 314ms sleep plus a throttle wait), the feed fan-out was
        // dispatched with 226ms left, `fetchFeedCapped`'s 250ms floor
        // short-circuited EVERY fan-out feed and Jupiter came back 0 for that
        // minute (20 on the next tick). So when the headroom is gone, the call
        // ENDS here instead of looping into an attempt nobody can win — and a
        // 429 always ends it: note429 has just armed the 90s backoff, so no
        // second request inside this window could succeed anyway.
        const retryHeadroomMs = this.config.dexRequestIntervalMs + RETRY_MIN_ATTEMPT_MS;
        if (attempt >= 3 || rateLimited || left < retryHeadroomMs) break;
        await sleep(Math.min(attempt * 2000, left - retryHeadroomMs));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("DexScreener request failed");
  }

  /**
   * The Solana mints in a /token-boosts/latest/v1 body, newest slots first:
   * paid promotion slots, so a fresh mint that bought a DexScreener boost.
   *
   * Measured 2026-09-25: 30 rows, 19 Solana. Rows carry `url, chainId,
   * tokenAddress, description, icon, header, openGraph, totalAmount, amount`
   * — NO metrics and NO timestamps, exactly like a profile row — so the age
   * comes from the pair the next batch fetches (and a boost mint with no pair
   * is skipped, not mis-aged, see the stats loop in scanner.ts).
   */
  async fetchBoostedTokens(limit: number): Promise<TokenProfile[]> {
    // Off by default (DEXSCREENER_BOOSTS_LIMIT = 0) — the leg must cost
    // nothing when disabled, not even a request.
    if (!(limit > 0)) return [];
    const deadline = Date.now() + BOOST_FEED_SELF_BUDGET_MS;
    let data: unknown = null;
    try {
      data = await this.getJson("/token-boosts/latest/v1", deadline);
    } catch (err) {
      // Optional leg: a failure here is [] and the tick continues.
      console.error(
        "[dex] boosts feed failed:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const out: TokenProfile[] = [];
    for (const item of rows) {
      if (item.chainId !== "solana") continue;
      const tokenAddress = String(item.tokenAddress ?? "");
      if (!tokenAddress) continue;
      out.push({ tokenAddress });
    }
    return out.slice(0, limit);
  }
  /**
   * Newest token profiles first. Returns only Solana profiles so the scanner
   * never inspects other chains.
   *
   * Self-budgeted and failure-tolerant (2026-09-19, see
   * PROFILE_FEED_SELF_BUDGET_MS): the call answers inside the tick's feed
   * window even when the upstream is rate-limiting, and a fetch that fails
   * outright still returns the make-up list — the deferred coins are the whole
   * reason this list exists, and the ticks this used to skip were the ones
   * that evaluated NOTHING (`profiles 0`, 23% of ticks). That includes an
   * upstream that never answers at all: the call abandons its own fetch
   * inside the tick's window and still builds the make-up list, instead of
   * letting the caller's race throw the list away with the body.
   */
  async fetchLatestSolanaProfiles(): Promise<TokenProfile[]> {
    let data: unknown = null;
    let failed = false;
    // The deadline bounds the WHOLE call, attempt 1 included (see
    // PROFILE_FEED_SELF_BUDGET_MS): a fetch this call abandons early still
    // builds the make-up list, whereas one the scanner's race discards takes
    // the make-up with it.
    const deadline = Date.now() + PROFILE_FEED_SELF_BUDGET_MS;
    try {
      data = await this.getJson("/token-profiles/latest/v1", deadline);
    } catch (err) {
      failed = true;
      console.error(
        "[dex] profiles feed failed:",
        err instanceof Error ? err.message : err,
      );
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    // A body that is not the expected array (a null from a deterministic 4xx,
    // a budget that ran out mid-chain) is a FAILED feed, not an empty one: it
    // is counted apart so the outage stays readable.
    if (!Array.isArray(data)) failed = true;
    const profiles: TokenProfile[] = [];
    for (const item of rows) {
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
    const feed = profiles.slice(0, this.config.scanProfileLimit);
    // Deferred make-up (see deferredmakeup.ts): the scanner's deferred cards
    // ride THIS list back into the tick.
    //
    // Why here and not the re-eval pool: a deferral only leaves the coin in
    // the pool, and the pool is a rotation — the coin comes around in 3 min
    // (near zone) or 18 min (far), and if a band move or an mcap/liquidity
    // prune skipped it, never. Live 2026-09-19: `deferredTotal 53,
    // recoveredTotal 0` in 10.3h, i.e. not one make-up send was observable.
    // The profiles feed is the one list a tick ALWAYS evaluates, and its coins
    // lead the candidate order, so the deferred coin is re-checked on every
    // tick until it either qualifies (and gets pushed) or stops qualifying.
    //
    // Appended PAST `scanProfileLimit`, so the feed's own coins keep their
    // slots.
    //
    // NOT skipped on an empty feed any more (2026-09-19): that skip existed to
    // keep `profiles: 0` readable as "the feed answered with nothing", and it
    // cost the deferred backlog its make-up chance on exactly the ticks a cold
    // isolate serves (5 of the 7 `profiles 0` ticks in a 118-tick window fell
    // within two minutes of a deploy — the first fetch of a fresh isolate
    // rides its whole budget and returns nothing). The signal moves instead of
    // being preserved by omission: the raw size is recorded per request in
    // deferredmakeup.ts (rawProfiles / emptyFeedTotal / lastEmptyFeedAt) and
    // published every tick with the scan summary, so a masked feed is
    // impossible to miss — while the deferred coin gets its chance here.
    //
    // Readability note: this list is what /health reports as `profiles`, so a
    // tick carrying make-up entries reads a few above the real feed size
    // (≤ DEFERRED_MAKEUP_MAX) — which is also the only observable that says
    // the make-up is pulling coins in BEFORE the first `deferRecovered` rise.
    //
    // Last-good reuse (2026-09-19, see PROFILE_FEED_REUSE_MS): a 429 (or a hung
    // upstream, or an empty answer) used to leave the tick evaluating ONLY the
    // make-up coins — one tick in five discovered nothing. Evaluating the
    // previous list again recovers that minute's coins.
    //
    // THE OUTAGE SIGNAL STAYS THE FETCH'S, NOT THE EVALUATION'S: noteProfileFeed
    // is still handed `feed.length` (0 on a 429), so lastRawProfiles /
    // failedTotal / lastFailedAt / emptyFeedTotal keep reporting what the
    // upstream did. Only what this tick EVALUATES changes — a masked feed stays
    // impossible to miss in /health.summary.feedMakeup.
    const now = Date.now();
    const reuse = shouldReuseProfileList(
      feed.length,
      failed,
      this.lastGoodProfiles?.at ?? null,
      now,
      PROFILE_FEED_REUSE_MS,
    );
    const evaluated = reuse && this.lastGoodProfiles ? this.lastGoodProfiles.list : feed;
    if (!failed && feed.length > 0) this.lastGoodProfiles = { at: now, list: feed };
    const makeup = missingDeferredTokens(evaluated.map((p) => p.tokenAddress));
    noteProfileFeed(feed.length, makeup.length, now, failed);
    if (makeup.length === 0) return evaluated;
    return [...evaluated, ...makeup.map((tokenAddress) => ({ tokenAddress }))];
  }

  /**
   * Fetch live pair data for up to 30 addresses per request.
   * The /latest/dex/tokens endpoint returns a flat `pairs` array, so we
   * group pairs by baseToken.address and keep the first Solana pair per token.
   * Bounded by PAIRS_FETCH_BUDGET_MS so a slow/limited endpoint cannot eat
   * the whole scan tick: batches past the deadline are skipped and their
   * tokens are simply re-tried on the next scan.
   */
  async fetchPairsForTokens(
    addresses: string[],
    /**
     * Absolute epoch ms the CALLER's phase must be done by (the scanner's
     * front-phase window, see FRONT_PHASE_WINDOW_MS). The pair fetch is the
     * last front phase, so when a deadline is supplied it yields to whichever
     * comes first: its own PAIRS_FETCH_BUDGET_MS or that deadline. Omitted
     * (tests, ad-hoc calls, and the scanner today, whose front-phase caps
     * already sum inside the window) → the local budget only.
     */
    callerDeadlineMs?: number,
  ): Promise<Map<string, PairInfo>> {
    const result = new Map<string, PairInfo>();
    const now = Date.now();
    // Serve whatever is still fresh from the cache first; only cache misses
    // hit the wire.
    const misses: string[] = [];
    for (const a of addresses) {
      const hit = this.pairCache.get(a);
      if (hit && now - hit.at < PAIR_CACHE_TTL_MS) {
        result.set(a, hit.pair);
      } else {
        misses.push(a);
      }
    }
    if (misses.length === 0) return result;
    // Blocked by a recent hard 429: don't hammer the endpoint (and don't
    // burn the tick's budget on doomed retries) — cache-only for now.
    if (Date.now() < this.batchBlockedUntil) return result;

    const deadline = Math.min(
      now + PAIRS_FETCH_BUDGET_MS,
      typeof callerDeadlineMs === "number" && callerDeadlineMs > now
        ? callerDeadlineMs
        : Number.POSITIVE_INFINITY,
    );
    const batches: string[][] = [];
    for (let i = 0; i < misses.length; i += 30) batches.push(misses.slice(i, i + 30));
    let nextBatch = 0;
    let saw429 = false;

    const worker = async (): Promise<void> => {
      while (nextBatch < batches.length && !saw429) {
        if (Date.now() > deadline) return; // keep the tick inside its budget
        const batch = batches[nextBatch++];
        let data: { pairs?: Array<Record<string, unknown>> } | null;
        try {
          data = (await this.getJson(
            `/latest/dex/tokens/${batch.join(",")}`,
            deadline,
          )) as { pairs?: Array<Record<string, unknown>> } | null;
        } catch (err) {
          // A rate-limited batch means the remaining ones will 429 too — stop
          // instead of burning the rest of the tick's budget (and Cloudflare's
          // wall clock) on doomed retries, and back off across ticks so the
          // next scan goes straight to cache-only mode.
          if (/429/.test(err instanceof Error ? err.message : String(err))) {
            saw429 = true;
            return;
          }
          continue; // transient/other error — skip this batch, try the next
        }
        const pairs = data?.pairs;
        if (!Array.isArray(pairs)) continue;

        for (const raw of pairs) {
          if (raw.chainId !== "solana") continue;
          const baseToken = raw.baseToken as
            | { address?: string; name?: string; symbol?: string }
            | undefined;
          if (!baseToken?.address) continue;
          if (result.has(baseToken.address)) continue; // first pair wins
          const volume = raw.volume as { h24?: number; h1?: number; m5?: number } | undefined;
          const txnsRaw = raw.txns as
            | {
                m5?: { buys?: number; sells?: number };
                h1?: { buys?: number; sells?: number };
              }
            | undefined;
          const priceChange = raw.priceChange as { m5?: number; h1?: number } | undefined;
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
            // Reported FDV, stored as its own quantity. DexScreener omits
            // `marketCap` for some pairs; that stays 0 (the gate rejects it)
            // rather than quietly becoming an FDV.
            fdvUsd: raw.fdv == null ? null : Number(raw.fdv),
            volume: {
              h24: Number(volume?.h24 ?? 0),
              h1: Number(volume?.h1 ?? 0),
              m5: Number(volume?.m5 ?? 0),
            },
            priceChange: {
              m5: Number(priceChange?.m5 ?? 0),
              h1: Number(priceChange?.h1 ?? 0),
            },
            txns: {
              m5Buys: Number(txnsRaw?.m5?.buys ?? 0),
              m5Sells: Number(txnsRaw?.m5?.sells ?? 0),
              h1Buys: Number(txnsRaw?.h1?.buys ?? 0),
              h1Sells: Number(txnsRaw?.h1?.sells ?? 0),
            },
            liquidity: {
              // Preserve 0 — a drained pool reports usd: 0 and the push-watch
              // rug rule must see it, not mistake it for "unknown" (null).
              usd:
                (raw.liquidity as { usd?: number } | undefined)?.usd ===
                undefined
                  ? null
                  : Number((raw.liquidity as { usd?: number }).usd),
            },
            // The metric every USD-level rule is calibrated on (see the
            // feedSource note on PairInfo).
            feedSource: "dexscreener",
            pairCreatedAt: Number(raw.pairCreatedAt ?? 0),
          });
          this.pairCache.set(baseToken.address, {
            pair: result.get(baseToken.address)!,
            at: now,
          });
        }
      }
    };
    // Pipelined dispatch: N workers pull batches from the shared queue so a
    // batch's network latency overlaps the next batch's throttle spacing
    // instead of stacking on it. All workers share one deadline; a 429 in any
    // worker halts new dispatches and the caller backs off across ticks.
    const workerCount = Math.min(PAIR_BATCH_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // `saw429` only stops the remaining batches of THIS call; the backoff and
    // the telemetry were already handled by note429 in getJson (which sees the
    // status even when the retry loop degrades it to a null response).
    if (this.pairCache.size > PAIR_CACHE_MAX) {
      // Evolve oldest-first (Map preserves insertion order).
      for (const k of this.pairCache.keys()) {
        if (this.pairCache.size <= PAIR_CACHE_MAX) break;
        this.pairCache.delete(k);
      }
    }
    return result;
  }
}
