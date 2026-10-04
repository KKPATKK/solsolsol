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
  /**
   * When the VALUES in this row were generated upstream, in epoch ms —
   * recovered from the response's own HTTP clocks (`age` / `date`, see
   * getJson), which every cache layer preserves. Absent = unknown (fixtures,
   * synthetic rows, and the Jupiter/Gecko legs, which are fetched live).
   *
   * WHY IT EXISTS (2026-10-03, DUST — docs/stale-readings-2026-10-03.md):
   * three cache layers sit between the tracker and the market (upstream 30s +
   * colo edge 120s + this client's in-memory 180s) and they STACK, while every
   * stamp in the chain recorded its OWN receipt — so a row could be ~5 minutes
   * stale and read "fresh" at every layer. Live: two 💀 cards quoted 現
   * $121.02K against a pool trading $290K-430K in the same minutes; the
   * reading was ~4 minutes old. The push-watch rules refuse to judge a reading
   * older than PUSH_WATCH_MAX_READING_AGE_MS, and this is how they know.
   */
  contentAt?: number;
}

/**
 * The oldest pair content this client will serve, or any rule may judge, in
 * ms — measured from the reading's own content clock (`PairInfo.contentAt`),
 * never from when a layer happened to hand it over.
 *
 * WHY IT EXISTS (2026-10-03, DUST — docs/stale-readings-2026-10-03.md). Three
 * caches sit between the tracker and the market and they STACK: DexScreener's
 * own `max-age=30`, this Worker's colo edge entry (PAIR_BATCH_CACHE_TTL_S,
 * 120s) and this client's in-memory map (PAIR_CACHE_TTL_MS, 180s). Each one
 * stamped its own receipt, so a reading could be minutes old and read "fresh"
 * at every layer — and nothing in the chain could even SAY how old it was.
 * Live: two 💀 cards quoted 現 $121.02K while the pool traded $290K–430K in the
 * same minutes (the $121K number was the market ~4 minutes earlier), and the
 * revival target they armed ($181.53K) sat BELOW the live price the whole
 * time, so the very next fresh reading would have "revived" the coin.
 *
 * WHERE 180s COMES FROM — it is arithmetic over the chain's own windows, not
 * an opinion. The worst content this chain can produce at a CACHE HIT is
 * (edge write age ≤ 120s) + (the upstream age that entry was written with,
 * measured 0–26s on real hits) ≈ 146s; and an entry can only be written at
 * all on an edge MISS, i.e. with content the origin had just generated. So
 * content older than ~150s means the edge entry that produced it is ALREADY
 * expired, and asking again reaches the origin (see the freshness gate in
 * fetchPairsForTokens — which is exactly what that gate does). 180s sits
 * above that 146s worst case — so no legitimate hit is ever refused — and
 * well below the 4+ minutes the DUST cards were reading.
 *
 * TWO USES, one meaning ("this content is too old to be evidence: get a
 * fresher one, or don't judge"):
 *  1. fetchPairsForTokens treats an in-memory HIT this old as a MISS, so the
 *     tracker re-asks the wire instead of re-serving the stale copy. Since
 *     the edge entry behind it is already expired (above), the re-ask is a
 *     real refresh, not a wasted request.
 *  2. The push-watch rules REFUSE to judge a reading this old AT ALL
 *     (fail-quiet — no card of any kind, the row is left completely
 *     untouched and re-read next pass; see pushwatch's
 *     PUSH_WATCH_MAX_READING_AGE_MS), so nothing is ever derived from
 *     minutes-old numbers even if some other carrier (a pin snapshot, a
 *     served lastPairs map) hands one over.
 *
 * UNKNOWN IS NOT STALE: a row with no `contentAt` at all (fixtures, synthetic
 * pairs, the Jupiter/Gecko legs, which are fetched live) is never refused —
 * the same "missing data never judges" direction the liquidity guards take.
 * Only a reading we can actually DATE may be refused for its age.
 */
export const PAIR_CONTENT_MAX_AGE_MS = 180_000;

/**
 * How old a pair's CONTENT is (ms), from the reading's own `contentAt` — never
 * from when this isolate received it, which is the stamp every cache layer in
 * the chain rewrites (see PairInfo.contentAt). Null = unknown: the row carried
 * no clock at all (fixtures, synthetic rows, the Jupiter/Gecko legs), which is
 * neither fresh nor stale — callers that must judge (pushwatch) fail OPEN on
 * unknown and only refuse a reading they can actually date.
 */
export function pairContentAgeMs(
  pair: { contentAt?: number },
  now: number,
): number | null {
  if (typeof pair.contentAt !== "number" || !Number.isFinite(pair.contentAt)) {
    return null;
  }
  return Math.max(0, now - pair.contentAt);
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
 * tick goes back to the make-up list alone.
 *
 * WHY IT ROSE FROM 10 MINUTES (2026-09-30, measured on the scan ring). The
 * 5-minute outage cycle this absorbed is no longer the shape: the shared egress
 * IP is now refused on MOST ticks, so what matters is not the gap between two
 * outages but the longest run with NO SUCCESSFUL FETCH — only a success stamps
 * the journal, so only a success re-arms this window. Live 00:01:26Z → 00:11:09Z
 * was 11 consecutive ticks at `profiles: 2` (the make-up size) with `http429
 * 19` of `feedRequests 21` in the isolate, ending the moment one fetch got
 * through; the earlier collapses (22:55–23:03, 23:23–23:26) have the same
 * shape. A 10-minute window therefore loses that whole lane on any run longer
 * than ten minutes — which is now the normal case rather than the exception.
 *
 * 30 minutes is sized against the MEASURED worst run (11 minutes) with margin,
 * and it is still a bound: the signal that the upstream is dead does NOT ride
 * this window — `feedMakeup.lastRawProfiles` / `failedTotal` / `emptyFeedTotal`
 * report the fetch itself and are unaffected by what the tick evaluates — so a
 * permanently refused feed reads as refused for those 30 minutes and then
 * collapses to the make-up lane, exactly as before, only later.
 */
export const PROFILE_FEED_REUSE_MS = 30 * 60_000;

/**
 * Self-budget for the boosted-token feed (/token-boosts/latest/v1), the same
 * shape as the profiles feed's budget: one request, no retry chain worth
 * waiting for. It is an OPTIONAL leg in the scanner (dropOptionalLeg), so a
 * 429 here costs one list, not the tick.
 *
 * WHY IT IS A FLOOR AND NOT THE WHOLE BUDGET (2026-09-30). 480 is the same
 * number the profiles leg spends on its whole call, and for the boosts leg that
 * arithmetic only holds while the throttle queue is FREE. The profiles list is
 * dispatched at tick start and takes the tick's first slot; this leg is the
 * tick's SECOND DexScreener request and therefore always pays a gap — the
 * queue spaces request STARTS `intervalMs` apart, globally across callers (see
 * Throttle). One gap at the configured 250ms still fits inside 480, which is
 * why the leg answers on a healthy day. The gap stops fitting the moment the
 * 429 controller widens the queue, and getJson's slot check then drops the
 * attempt WITHOUT SENDING IT: the tick reads `boosts 0` with `http429` flat,
 * and the only trace is `dropsByLeg.boosts`.
 *
 * MEASURED (2026-09-30 audit, live): the boosts list was delivered on 4 of 10
 * sampled ticks and dropped on 6, with `dropsByLeg.boosts` carrying the drops,
 * while the spacing sat on the adaptive ladder (250 → 400 → 640 → 1024 →
 * 1200). That is NOT the trade the drop was written for: nothing else in the
 * tick's feed window is queued behind this leg (the pair phase is enqueued
 * after the feed phase joins), so the drop bought no headroom for another leg
 * and cost the tick its entire boosts list.
 *
 * SO THE BUDGET IS THE SLOT, NOT A CONSTANT: the deadline in fetchBoostedTokens
 * is this leg's own slot (Throttle.nextSlotAt) plus one attempt
 * (BOOST_FEED_ATTEMPT_MS) — what the leg must actually wait for — and the
 * caller's window is passed in as a CAP, so a gap the tick cannot afford still
 * ends the leg rather than spending a slot whose answer the scanner's own race
 * would throw away.
 *
 * THAT CAP WAS STILL THE SHARED FEED WINDOW, AND IT WAS SMALLER THAN THE
 * CEILING (2026-10-03). The 2026-09-30 change fixed the LADDER's middle steps
 * (640/1024 fit a 1600ms window) but not its top: the leg's worst case is
 * DEX_ADAPTIVE_MAX_MS (1200) + BOOST_FEED_ATTEMPT_MS (480) = 1680ms after tick
 * start, while the scanner's FEED_DEADLINE_MS is 1600. So on any tick whose
 * queue sat at the ceiling the leg was dropped BEFORE SENDING IT — permanently,
 * once per tick, for as long as the spacing stayed raised. Measured live: 28
 * consecutive ticks at `intervalMs 1200` read `boosts 0` with
 * `dropsByLeg.boosts` climbing +1/tick, and the same feed read `boosts 22` the
 * moment the spacing stepped back to 750. That is the state this comment's
 * "so a gap the tick cannot afford still ends the leg" described as a choice,
 * while in practice it was the routine reading on any refused day.
 *
 * The scanner now hands this leg its OWN window (BOOST_FEED_WINDOW_MS, sized
 * to the ceiling arithmetic) instead of the shared feed deadline, because
 * nothing is queued behind the boosts list — the pair phase is enqueued after
 * the feed phase joins — so the old cap bought no headroom for anything and
 * cost the tick the whole lane. The cap itself stays: a window that cannot hold
 * the gap must still end the leg as a NAMED drop, never as an empty list.
 */
export const BOOST_FEED_SELF_BUDGET_MS = 480;

/**
 * The attempt the boosts leg keeps AFTER its queue gap: one shared-egress
 * answer, i.e. the same 480ms the profiles leg spends on its whole call (its
 * queue is empty, this leg's is not). Added to the leg's SLOT rather than to a
 * constant, so the same arithmetic holds at the 250ms base and on the widened
 * ladder: the leg asks for its slot + an attempt, and is dropped only when that
 * does not fit the window it was handed.
 *
 * EXPORTED because the caller's window is sized from it (see the scanner's
 * BOOST_FEED_WINDOW_MS): the ceiling arithmetic is `DEX_ADAPTIVE_MAX_MS +
 * BOOST_FEED_ATTEMPT_MS`, and a window written as a bare literal would silently
 * stop covering the leg the day either number moves.
 */
export const BOOST_FEED_ATTEMPT_MS = 480;

/**
 * Edge-cache TTL for the two LIST feeds (`/token-profiles/latest/v1`,
 * `/token-boosts/latest/v1`) — the requests that go through `cf` below.
 *
 * WHY THE LIST FEEDS ARE EDGE-CACHED AND THE PAIR BATCHES ARE NOT
 * (2026-09-25, live): the profiles list is the tick's biggest discovery lane
 * and the one reading the operator watches, and it was coming back EMPTY on
 * 133 of 464 ticks (27%). The cause is not this client's arithmetic: the
 * endpoint is rate-limited per SOURCE IP — ~5 requests/minute — and a
 * Cloudflare Worker's egress IP is shared fleet-wide, so the bucket is spent
 * by strangers and our single request per tick gets 429'd (the durable ring
 * measured 17 429s/hour; every one of them costs that tick its raw list, since
 * a 429 answers fast and is counted as a failure, never retried for a budgeted
 * caller).
 *
 * Nothing we do to our own spacing can refill a bucket we do not own; what
 * this DOES own is whether the request reaches the origin at all. The same
 * discipline the GeckoTerminal client has used since 2026-09-21 (see
 * geckoterminal.ts `requestInit`): ask through the colo's edge cache with
 * `cacheEverything` + `cacheTtl`, and keep non-2xx responses OUT of the cache
 * (`cacheTtlByStatus`), so a 429 can never be served to the next tick as if it
 * were a fresh feed. A HIT costs the invocation the same one subrequest but
 * never touches the origin: no 429, and a latency of ~10ms instead of the
 * shared egress's 300-800ms.
 *
 * 60 SECONDS because the list is a discovery list: the endpoint is a slowly
 * rotating set of "latest" profiles, the tick runs every 60s, and this client
 * ALREADY accepts a 10-minute-old list on a failed fetch (see
 * PROFILE_FEED_REUSE_MS) — so a 60s-old HIT is strictly fresher than what the
 * tick would otherwise evaluate. The pair batch carries its own, LONGER
 * window on the same discipline since 2026-09-30 — see
 * PAIR_BATCH_CACHE_TTL_S, which is where the reasoning lives: those rows are
 * the metrics the gate and the tracker judge, so the window is sized so the
 * edge can never serve anything staler than the client's own in-memory pair
 * cache already does.
 *
 * OPEN QUESTION (2026-09-26, deliberately NOT changed here — but no longer
 * unanswerable). A TTL that equals the tick period is a boundary: an entry
 * minted at T is HIT-able to T+60, and the next tick arrives at ~T+60 +
 * jitter, so whether the tick's own fetch is a HIT or a MISS is decided by that
 * jitter — and the MISS is the one that pays origin latency (300-800ms on the
 * shared egress) against FEED_DEADLINE_MS 900, which is the shape of the ticks
 * that evaluate no profiles at all. Raising this to 180 would keep the entry
 * alive across two ticks and stay inside what the client already tolerates (a
 * FAILED fetch serves a list up to PROFILE_FEED_REUSE_MS old), i.e. it
 * satisfies the invariant the guard in scripts/test-deferred-priority.js pins.
 *
 * What it was waiting for is the reading, and the reading was unusable:
 * listCacheHits / lastListCacheStatus were CLIENT module state, so an isolate
 * recycled every tick reported `0 / null` however well the cache was working
 * (live 2026-09-26T14:01Z: listCacheHits 0, lastListCacheStatus null, http429
 * 0, budgetDrops 0 on a tick that read `profiles: 2`). As of this build the
 * ledger is journaled into worker_state (see the ledger below and
 * /health's `dexListCache`), so the number is decided by DATA now: raise this
 * only when the durable misses are a real share of the total while http429
 * stays flat — that is the origin being asked because the entry expired, not
 * because we were refused. Until then 60 stands, and so does the guard that
 * pins it (its reason — a HIT is fresher than the 10-minute reuse lane — is
 * still true and is not what the data would overturn).
 */
export const LIST_FEED_CACHE_TTL_S = 60;

/**
 * The list-feed edge-cache LEDGER, and the durable key names it is mirrored
 * into.
 *
 * MODULE scope, not instance scope, and that is the point: this is the
 * accumulator the durable `dex_list_cache_*` rows are made from, and the tick
 * that reports it (Scanner.stampListCacheDelta) does not own the client's
 * fields. A second accumulator fed by the same event is exactly the drift this
 * repo keeps paying for, so there is ONE pair of counters: getStats() reads
 * them and the delta below is a difference against a baseline.
 *
 * WHAT IT ANSWERS: whether the edge cache actually serves the list feed.
 * `hits` climbing with `http429` flat means the origin was never asked; a
 * `misses` share that keeps growing means the entry EXPIRED before the next
 * tick needed it — which is the whole of the LIST_FEED_CACHE_TTL_S question.
 * A 2xx response with NO `cf-cache-status` header counts as a MISS: a hit is
 * the one outcome that needs a header to prove itself, and a response whose
 * provenance is unknown was answered by the origin as far as we can tell.
 * A non-2xx response is deliberately NOT part of this ratio (see getJson): it
 * was never a candidate for the cache. It is counted on its own row instead
 * (DEX_LIST_CACHE_REFUSED_KEY) — see noteListCacheRefused for why the ratio
 * alone could not answer the TTL question.
 */
const EDGE_CACHE_HIT_RE = /^(HIT|REVALIDATED)$/i;

const listCacheLedger = {
  hits: 0,
  misses: 0,
  /**
   * List requests the ORIGIN refused (non-2xx: a 429, a 5xx, a 4xx). Counted
   * apart from the two above — see noteListCacheRefused.
   */
  refused: 0,
  /** The last status seen in this isolate (null = no list fetch yet). */
  status: null as string | null,
  /**
   * The status the durable row already carries, so a replacement is queued
   * only when the label CHANGED (see peekListCacheDelta).
   */
  reported: null as string | null,
};

/**
 * Count one list-feed outcome. Called from getJson — the only place the
 * `cf-cache-status` header is visible — so there is exactly one place that
 * decides what a hit is; an inline regex at a second call site is how the
 * durable ratio would come to disagree with the page's own reading.
 */
function noteListCacheOutcome(status: string | null): void {
  listCacheLedger.status = status;
  if (status !== null && EDGE_CACHE_HIT_RE.test(status)) {
    listCacheLedger.hits += 1;
    return;
  }
  listCacheLedger.misses += 1;
}

/**
 * Count one list request the origin REFUSED, and record the refusal as the
 * lane's last outcome (2026-09-30).
 *
 * WHY THIS COUNTER HAD TO EXIST: hits and misses are 2xx-only BY
 * CONSTRUCTION — `cacheTtlByStatus` gives an entry a TTL for 200-299 alone, so
 * a 429 was never a candidate for the edge cache and was deliberately kept out
 * of the ratio. That is right for the ratio and useless for the decision,
 * because the whole point of the ledger is to answer "is `LIST_FEED_CACHE_TTL_S`
 * leaving the entry expired, or is the origin refusing us?" — and a refusal is
 * invisible in both of the counters it has. Measured 2026-09-30T00:0xZ: the
 * profiles leg answered 2xx TWICE in 21 ticks while /health went on reporting
 * `hits 5256 / misses 8 / hitPct 99.8`. The ratio was true of the responses
 * that arrived and silent about the nineteen that never did.
 *
 * `http429` (getStats) is not a substitute: it is per-ISOLATE, per-CLIENT, and
 * counts every leg — exactly the churn and the mixing this durable ledger was
 * built to survive.
 *
 * The label carries the refusal, so `lastStatus` answers "what happened on the
 * last list request?" in one reading: a `cf-cache-status` value when the origin
 * (or the edge) answered, `HTTP-<code>` when it refused to.
 */
function noteListCacheRefused(status: number): void {
  listCacheLedger.refused += 1;
  listCacheLedger.status = `HTTP-${status}`;
}

/** The counted window as of the last consume (see peekListCacheDelta). */
let listCacheBaseline = { hits: 0, misses: 0, refused: 0 };

/** What a reporter has to persist, and nothing it does not. */
export interface ListCacheDelta {
  hits: number;
  misses: number;
  /**
   * List requests the origin refused in this window. Unlike hits/misses this
   * one is not a cache verdict — it is the reading that says the lane never got
   * the chance to have one.
   */
  refused: number;
  /**
   * The status to persist, or null when the durable row already says it —
   * absent and "no list fetch yet" are the same row value, so a null status
   * can never be reported and never needs to be.
   */
  status: string | null;
}

/**
 * The counters since the last consume, WITHOUT advancing: the caller peeks,
 * writes, and only then commits (consumeListCacheDelta), so a refused write
 * re-offers the same window instead of dropping it. The same two-step the
 * Birdeye CU ledger uses for the same reason (peekBirdeyeCuDelta /
 * consumeBirdeyeCuDelta in src/birdeye.ts).
 */
export function peekListCacheDelta(): ListCacheDelta {
  return {
    hits: listCacheLedger.hits - listCacheBaseline.hits,
    misses: listCacheLedger.misses - listCacheBaseline.misses,
    refused: listCacheLedger.refused - listCacheBaseline.refused,
    status:
      listCacheLedger.status !== listCacheLedger.reported
        ? listCacheLedger.status
        : null,
  };
}

/**
 * Which rows of a peeked delta actually landed. Absent means NOT landed, so a
 * partial write commits only the rows it wrote.
 */
export interface ListCacheDeltaLanded {
  hits?: boolean;
  misses?: boolean;
  refused?: boolean;
  status?: boolean;
}

/**
 * Commit the parts of a peeked delta whose writes LANDED, and only those: a
 * row that failed is re-offered by the next peek, and a row that landed is
 * never written twice. The baseline advances by the delta rather than
 * jumping to the live ledger, so an outcome that arrived while the write was
 * in flight stays part of the NEXT delta instead of being lost or counted
 * once for two windows.
 *
 * The default acks everything, which is the QUEUED case (a front is present:
 * the row is on the tick's one write and there is nothing to retry yet).
 */
export function consumeListCacheDelta(
  delta: ListCacheDelta,
  landed: ListCacheDeltaLanded = {
    hits: true,
    misses: true,
    refused: true,
    status: true,
  },
): void {
  if (landed.hits) listCacheBaseline.hits += delta.hits;
  if (landed.misses) listCacheBaseline.misses += delta.misses;
  if (landed.refused) listCacheBaseline.refused += delta.refused;
  if (landed.status && delta.status !== null) {
    listCacheLedger.reported = delta.status;
  }
}

/**
 * The durable rows the ledger is mirrored into — ONE set of names, imported by
 * both the writer (Scanner.stampListCacheDelta) and the reader (/health),
 * because a literal in two places is how the two ends of a counter drift apart.
 * The first two are ADD counters (Db.bumpTelemetryCounter /
 * ScanFrontWrite.add), the third is a replacement (the label, not a count).
 */
export const DEX_LIST_CACHE_HITS_KEY = "dex_list_cache_hits";
export const DEX_LIST_CACHE_MISSES_KEY = "dex_list_cache_misses";
/**
 * List requests the origin refused (see noteListCacheRefused). Its own row for
 * the reason the misses row has one: a replacement would report a WINDOW as if
 * it were the total, and the reading this exists for is the share of refusals
 * against the 2xx outcomes the other two rows count.
 */
export const DEX_LIST_CACHE_REFUSED_KEY = "dex_list_cache_refused";
export const DEX_LIST_CACHE_LAST_KEY = "dex_list_cache_last";

/**
 * The last-good PROFILE LIST, in a form that outlives the isolate that fetched
 * it (see PROFILE_FEED_REUSE_MS above and DEX_PROFILES_LAST_KEY in db.ts).
 *
 * WHY (live 2026-09-26): the shared egress IP is 429'd 17-20 times an hour on
 * the profiles lane, and every one of those ticks fell back to the make-up
 * list alone — measured on the scan ring, 52 of 120 rows read `profiles: 2`
 * (the deferred make-up size) with the 429 ring's timestamps matching them one
 * for one. The client ALREADY has the fix for a rate-limited tick (a failed
 * fetch serves its last good list for up to PROFILE_FEED_REUSE_MS), but that
 * list was instance state and the isolate is recycled every tick, so the lane
 * only ever served a warm tick. Journaled into worker_state on the tick's
 * EXISTING front read and write (Scanner.seedProfileFeed /
 * Scanner.stampProfileFeedSnapshot) it costs no round trip, and the 429 tick
 * evaluates a minutes-old list instead of two make-up coins.
 *
 * The bound is a read guard, not a policy: the feed is a ~24-slot rotation, so
 * anything past this is not a list this client produced.
 */
export const PROFILE_FEED_LAST_MAX = 64;

/** What the journal row holds: the raw feed list and when it was fetched. */
export interface ProfileFeedSnapshot {
  /** Epoch ms of the successful fetch (the stamp the reuse window measures). */
  at: number;
  tokens: string[];
}

/**
 * Parse the journaled row (see ProfileFeedSnapshot). Null on anything that is
 * not a usable snapshot — an absent row, a half-written one, a shape from a
 * build that never wrote it — and the caller then behaves exactly as it did
 * before the journal existed (the make-up lane alone). Never throws: this runs
 * ahead of the tick's feed work, which must not be breakable by a row.
 */
export function parseProfileFeedSnapshot(
  raw: string | null | undefined,
): ProfileFeedSnapshot | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as { at?: unknown; tokens?: unknown };
  const at =
    typeof rec.at === "number" && Number.isFinite(rec.at) && rec.at > 0
      ? rec.at
      : null;
  if (at === null || !Array.isArray(rec.tokens)) return null;
  const tokens: string[] = [];
  for (const token of rec.tokens) {
    if (typeof token !== "string" || token.length === 0) continue;
    tokens.push(token);
    if (tokens.length >= PROFILE_FEED_LAST_MAX) break;
  }
  if (tokens.length === 0) return null;
  return { at, tokens };
}

/**
 * The Cloudflare-specific fetch options this client asks for (see
 * LIST_FEED_CACHE_TTL_S). Declared locally, like the GeckoTerminal client's
 * identical one, because `RequestInit` does not carry `cf`.
 */
interface CloudflareFetchInit extends RequestInit {
  cf?: {
    cacheEverything?: boolean;
    cacheTtl?: number;
    cacheTtlByStatus?: Record<string, number>;
  };
}

/**
 * Which feed a request path belongs to — the label `budgetDrops` counts by
 * (2026-09-26).
 *
 * WHY THE LEG IS NAMED (live 2026-09-26): the counter told the operator that 2-3
 * requests per tick were never SENT (the throttle queue held them past the
 * caller's 480ms / 1s window), but not WHICH leg wanted them — and the three
 * legs have three different fixes: the profiles list is the tick's biggest
 * discovery lane (a drop there is a real loss, softened only by the 10-minute
 * reuse lane), the boosts list is optional by construction (dropOptionalLeg),
 * and the pair batches are a ROTATION whose leftovers stay in the re-eval pool
 * by design. One counter cannot be read without that name.
 *
 * Derived from the PATH rather than passed by each caller: the call sites are
 * three and the paths are fixed, so a third parameter would be three chances to
 * mislabel with no extra information. Pure and exported so the mapping is
 * unit-tested rather than inferred from a live reading.
 */
export type DexFeedLeg = "profiles" | "boosts" | "pairs" | "other";

export function dexFeedLeg(path: string): DexFeedLeg {
  if (path.startsWith("/token-profiles/")) return "profiles";
  if (path.startsWith("/token-boosts/")) return "boosts";
  if (path.startsWith("/latest/dex/tokens/")) return "pairs";
  // The by-address lookup (see fetchPairsByAddresses) is the same upstream
  // lane as the token batches: same endpoint family, same rate limit, same
  // 429 reaction (the batch block and the adaptive spacing both key on the
  // leg). Filing it under "pairs" is what keeps a refusal there from being
  // counted — and reacted to — as if it were some other leg's.
  if (path.startsWith("/latest/dex/pairs/")) return "pairs";
  return "other";
}

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
  /**
   * The slot handed to the item enqueued LAST (see nextSlotAt); 0 = this
   * isolate never queued anything yet. Distinct from `lastCallAt` on purpose:
   * it is a PLAN, and the plan is what a caller with a deadline needs to see
   * before it spends a slot (see getJson's drop check).
   */
  private plannedAt = 0;
  /**
   * Dispatch spacing in ms. MUTABLE (2026-09-29, see AdaptiveSpacing): the 429
   * controller raises it while the shared egress IP is being refused and walks
   * it back down after a healthy streak. Every read below goes through the
   * field, so a raised spacing applies to the requests already queued behind
   * the one that was refused — which is exactly the burst that re-triggers a
   * 429 the moment the cache-only block expires.
   */
  private intervalMs: number;
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Re-space the queue (see AdaptiveSpacing). Never negative. */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = Math.max(0, Math.round(intervalMs));
  }

  /**
   * When an item enqueued NOW would actually start.
   *
   * WHY (2026-09-26, live): the queue spaces request STARTS `intervalMs`
   * (250ms) apart and its chain is global across callers, so a slot spent by an
   * attempt that can never be answered is 250ms of dispatch spacing taken from
   * the requests BEHIND it — a dropped pair batch pushes the boosts list's one
   * request a full gap later, which is how one drop becomes two. The queue is
   * therefore asked for its next slot BEFORE an attempt is enqueued, so a
   * caller whose window has already gone drops the attempt for free instead of
   * paying for the slot (see getJson).
   *
   * Exact for a busy queue (each item dispatches one gap after the previous
   * plan, and a plan cannot start before the previous real dispatch because the
   * chain serializes them) and "now" for an idle one, where the next item has
   * no wait to pay: idle long enough and both terms are in the past.
   */
  nextSlotAt(): number {
    return Math.max(
      Date.now(),
      this.plannedAt + this.intervalMs,
      // A slot can slip past its plan when the isolate is busy (the callback
      // runs late), and the chain is ordered by ACTUAL dispatch — so the later
      // of the two is what the next item would really wait for.
      this.lastCallAt + this.intervalMs,
    );
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.plannedAt = this.nextSlotAt();
    const dispatched = this.tail.then(async () => {
      const wait = Math.max(0, this.lastCallAt + this.intervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
    });
    this.tail = dispatched;
    return dispatched.then(() => fn());
  }
}

/** Ceiling the adaptive spacing can reach, in ms (see AdaptiveSpacing). */
export const DEX_ADAPTIVE_MAX_MS = 1_200;
/**
 * How much the spacing grows per refused response. 1.6 is chosen against the
 * observed shape of the shared egress IP's limits (docs and /debug/dex429:
 * 429s arrive in bursts of 1-3, then nothing for minutes), so ONE refusal
 * already buys 150ms of extra room (250 → 400) and three buy the ceiling —
 * enough to stop a burst re-arming itself without costing the phase seconds it
 * will not get back.
 */
export const DEX_ADAPTIVE_GROWTH = 1.6;
/**
 * Consecutive 2xx responses needed to give one step of spacing back.
 *
 * WHY NOT DECAY IMMEDIATELY: the expiry of the cache-only block
 * (PAIR_BATCH_BACKOFF_MS) is exactly when the queue is hottest — every leg
 * that was deferred wants its request at once. Returning to 250ms on the first
 * answer would rebuild the burst that caused the episode. Six answers ≈ one
 * pair batch's worth of calls, i.e. the spacing only relaxes once the endpoint
 * has demonstrably served a real round of work.
 */
export const DEX_ADAPTIVE_RECOVER_SUCCESSES = 6;

/**
 * The durable, FLEET-WIDE spacing row (worker_state). JSON `DexSpacingStamp`.
 *
 * WHY DURABLE (2026-09-29). AdaptiveSpacing above is per-isolate, and this
 * Worker's isolates churn every ~30s — so the per-isolate version loses the
 * raise at the moment it starts to matter. Live 2026-09-29T00:57Z measured
 * exactly that: three refusals inside one isolate read `intervalMs 1024 /
 * spacingSteps 3 / http429 3`, while the tick two minutes later (a different
 * isolate) read `250 / 0` — the fleet had been refused three times in two
 * minutes and the next isolate walked into the same burst at full rate. The
 * row carries the raise ACROSS the churn, so "the shared egress IP is
 * refusing us right now" is one fact about the fleet rather than one fact per
 * isolate.
 *
 * It rides the scan front's ONE read and ONE write (db.SCAN_FRONT_GATE_KEYS,
 * spelled as a literal there for the import direction that list documents), so
 * the fleet reading costs the tick no round trip of its own — the IN-list is
 * one row longer — and the row is only ever WRITTEN on a tick whose step count
 * actually moved (see DexScreenerClient.durableSpacingWrite): a healthy fleet
 * writes nothing at all, forever.
 */
export const DEX_SPACING_STATE_KEY = "dex_spacing";

/**
 * How long one fleet-wide step of spacing survives without another refusal.
 *
 * SIZED AGAINST THE TICK, NOT AGAINST THE ISOLATE. The in-isolate walk-back
 * counts DEX_ADAPTIVE_RECOVER_SUCCESSES (6) consecutive 2xx, which is 1.5s of
 * dispatch at the base and 7.2s at the ceiling — so the first cut of this
 * window was 15s, on the reasoning that "six answers worth of quiet" is a few
 * seconds. That was MEASURED WRONG the same hour it shipped: the scan is what
 * reads the row and it runs once a minute, so a 15s window decayed the row to
 * zero long before the next tick could inherit anything — live
 * 2026-09-29T01:24:32Z wrote the row (a real 429 landed at 01:24:30) and the
 * sample at 01:25:04Z already read `spacingFleetSteps 0`. A fleet memory
 * shorter than the cadence of the thing that reads it is not a memory.
 *
 * So the unit is the tick: one clean tick (a scan that met no refusal, i.e. the
 * same evidence as a 6-success streak, at tick scale) buys one step back, with
 * the window set to the scan cadence so a row written by one tick is still
 * readable by the next. Measured on the 2026-09-29 ring, refusals arrive as a
 * drip rather than a burst (01:01, 01:12, 01:18, 01:24, 01:27 — minutes apart),
 * so in practice each one widens the NEXT tick or two and then the base is
 * handed back: a real wall keeps refreshing `at` and never comes down at all.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: PAIR_BATCH_BACKOFF_MS (90s). The block
 * already forces cache-only for its whole length, so the moment the deferred
 * legs all want a request at once is AFTER it — and a fleet row that stayed at
 * 1200ms until then would charge every tick of a recovered endpoint seconds it
 * will not get back (the tick's pair phase is one of its bounded legs). The
 * row is a memory of the refusal, not a second backoff.
 */
export const DEX_ADAPTIVE_FLEET_DECAY_MS = 60_000;

/** What DEX_SPACING_STATE_KEY holds (JSON). */
export interface DexSpacingStamp {
  /** Epoch ms at which `steps` was established (a refusal, or a walk-back). */
  at: number;
  /** Raises in force at `at`. 0 is a REAL reading (the fleet recovered) — 
   * see parseDexSpacingStamp. */
  steps: number;
}

/**
 * Parse the durable spacing row. Null for absent, empty or unreadable, which
 * every caller must treat as "no fleet reading" rather than as zero — the two
 * are the same answer to `dexSpacingDecaySteps` by construction, but only the
 * former may be re-written without knowing what the row said.
 *
 * A `steps: 0` row IS valid and is the one worth keeping: it is the record of
 * an isolate that walked the spacing all the way back down, and without it the
 * next isolate would re-inherit an older, higher row and re-pay the episode.
 */
export function parseDexSpacingStamp(
  raw: string | null | undefined,
): DexSpacingStamp | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null;
    const steps =
      typeof row.steps === "number" && Number.isFinite(row.steps) ? row.steps : null;
    if (at === null || steps === null || at <= 0 || steps < 0) return null;
    return { at: Math.floor(at), steps: Math.floor(steps) };
  } catch {
    return null;
  }
}

/**
 * The steps still in force `now`: one step back per
 * DEX_ADAPTIVE_FLEET_DECAY_MS of fleet-wide quiet since the row was written.
 *
 * A future `at` (clock skew between isolates) yields the FULL count, not a
 * negative age: the row was written by an isolate that believed it was later
 * than this one, and the safe reading of that is "it just happened".
 */
export function dexSpacingDecaySteps(
  stamp: DexSpacingStamp | null,
  now: number,
): number {
  if (!stamp) return 0;
  const age = now - stamp.at;
  if (!Number.isFinite(age) || age <= 0) return stamp.steps;
  return Math.max(0, stamp.steps - Math.floor(age / DEX_ADAPTIVE_FLEET_DECAY_MS));
}

/**
 * The 429-driven dispatch-spacing controller.
 *
 * WHY IT EXISTS (2026-09-29). The spacing used to be one config constant
 * (DEX_REQUEST_INTERVAL_MS, 250ms) and the only reaction to a 429 was a 90s
 * cache-only block (PAIR_BATCH_BACKOFF_MS) plus a telemetry counter. That is a
 * binary answer to a graded problem: the block ends, the queue is still at
 * 250ms, and the next tick's batches walk straight back into the same refusal
 * — the live reading is a steady `dex.http429 ~11/hour` with the IP never
 * actually being asked to slow down.
 *
 * WHAT IT IS NOT: it is NOT a substitute for the 429's own block, and it never
 * lowers the spacing below the configured base. It only ever spends wall clock
 * when the upstream has PROVEN it is refusing (a counted 429 response), and it
 * returns every millisecond of that as soon as the endpoint serves again — so a
 * healthy day reads `intervalMs === DEX_REQUEST_INTERVAL_MS` exactly as before.
 *
 * TWO LAYERS, and the split is the point. THIS class is the in-isolate
 * controller: it is the only thing that can give a step back (it counts the
 * contiguous 2xx streak the fleet cannot see) and it reacts within the request
 * that was refused. The durable row beside it (DEX_SPACING_STATE_KEY, adopted
 * through adoptSteps below) is the FLEET memory: without it the raise died with
 * the isolate — measured live 2026-09-29T00:57Z, `intervalMs 1024 /
 * spacingSteps 3` in the isolate that was refused, `250 / 0` in the next one.
 *
 * `adoptSteps` can only ever RAISE, never lower. That is not a shortcut: the
 * profiles fetch is dispatched before the front row that carries the fleet
 * reading is even awaited (see the dispatch in runScan), so a refusal can land
 * BEFORE this isolate's own, fresher evidence exists — and letting a stale row
 * walk that back down would erase exactly the refusal that just happened.
 * Walking down is noteServed's job, per isolate, and the result is written back
 * to the row so the next isolate inherits the recovery too.
 */
export class AdaptiveSpacing {
  private current: number;
  private healthy = 0;
  private steps = 0;
  private readonly base: number;

  constructor(baseMs: number) {
    this.base = Math.max(0, Math.round(baseMs));
    this.current = this.base;
  }

  /** The spacing in force right now (ms). */
  get currentMs(): number {
    return this.current;
  }

  /** The spacing the queue returns to (DEX_REQUEST_INTERVAL_MS). */
  get baseMs(): number {
    return this.base;
  }

  /** How many raises are in force since the last full recovery. */
  get growthSteps(): number {
    return this.steps;
  }

  /**
   * A refused response (429) — grow the spacing. A no-op when the spacing is
   * disabled (`DEX_REQUEST_INTERVAL_MS = 0`): a caller that asked for no
   * spacing asked for no spacing, and inventing one would change the request
   * rate of a configuration nobody measured.
   */
  noteRefused(): void {
    if (this.base <= 0) return;
    this.healthy = 0;
    this.growOnce();
  }

  /**
   * One raise, the body noteRefused and adoptSteps share so the two can never
   * compute a different spacing for the same number of steps. `steps` counts
   * RAISES, not refusals: at the ceiling the spacing stays where it is and the
   * count does not move, or a burst of refusals would read as progress.
   */
  private growOnce(): void {
    const grown = Math.round(this.current * DEX_ADAPTIVE_GROWTH);
    const next = Math.min(DEX_ADAPTIVE_MAX_MS, Math.max(this.base, grown));
    if (next > this.current) {
      this.current = next;
      this.steps += 1;
    } else {
      // Already at the cap: stay there, and do not let the streak of refusals
      // be mistaken for progress (steps counts RAISES, not refusals).
      this.current = Math.max(this.base, next);
    }
  }

  /**
   * Raise the spacing to the FLEET's step count (see DEX_SPACING_STATE_KEY),
   * raising only — never lowering, for the reason the class doc gives. Returns
   * true when the spacing actually moved, which is the reading the caller
   * publishes as "this isolate inherited a raise".
   *
   * The loop is what keeps the two layers consistent: the spacing is grown by
   * the SAME growOnce the refusals use, so `8 steps` means the same 1200ms
   * whether it was reached by three live refusals or adopted from the row —
   * and a ceiling that cannot raise any further stops the loop instead of
   * counting phantom steps.
   */
  adoptSteps(target: number): boolean {
    if (this.base <= 0) return false;
    const want = Math.max(0, Math.floor(target));
    if (want <= this.steps) return false;
    const before = this.steps;
    this.healthy = 0;
    while (this.steps < want) {
      const at = this.steps;
      this.growOnce();
      if (this.steps === at) break;
    }
    // "Actually moved" is the honest return: a row that asks for more raises
    // than the ceiling holds stops the loop, and the caller must not read that
    // as an inheritance it never got.
    return this.steps > before;
  }

  /**
   * A served (2xx) response — give one step back after
   * DEX_ADAPTIVE_RECOVER_SUCCESSES of them.
   */
  noteServed(): void {
    if (this.base <= 0 || this.current <= this.base) {
      this.healthy = 0;
      return;
    }
    this.healthy += 1;
    if (this.healthy < DEX_ADAPTIVE_RECOVER_SUCCESSES) return;
    this.healthy = 0;
    const relaxed = Math.round(this.current / DEX_ADAPTIVE_GROWTH);
    this.current = Math.max(this.base, relaxed);
    if (this.current <= this.base) {
      this.current = this.base;
      this.steps = 0;
    } else {
      this.steps = Math.max(0, this.steps - 1);
    }
  }

  /**
   * Whether the last outcome was a refusal under an open block — the reading
   * the pair loop uses to decide it is worth trying the wire at all.
   */
  view(): { baseMs: number; currentMs: number; steps: number; healthy: number } {
    return {
      baseMs: this.base,
      currentMs: this.current,
      steps: this.steps,
      healthy: this.healthy,
    };
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
 *
 * 2026-09-28 (1_000 → 2_000, Workers Paid): the 2026-09-19 cut above existed
 * only to hand the claim its 3550ms — a free-plan number. The pair window is
 * now the front window (SCAN_TICK_DEADLINE_MS 8_000 − SCAN_GATE_RESERVE_MS
 * 1_600 = 6_400ms) and the claim deadline is 6_500ms, so the extra dispatch
 * slots are affordable: 2_000ms ÷ 250ms = 8 slots = 240 addresses, sized
 * against the rotation slice this was raised with (scanner.
 * RE_EVAL_PER_TICK_MAX 90 → 180 plus the feed's ~22 = ~202).
 *
 * The wire count does NOT simply double: the pair cache (PAIR_CACHE_TTL_MS
 * 180s) serves repeat coins for free, and the faster rotation (180 per tick
 * over a 330–524-row pool ≈ 2.6 ticks ≈ 2.6 min) is now SHORTER than that
 * TTL, so a larger share of each slice is a cache HIT. The counters to watch
 * are still `dex.http429` / `blockedForMs` / `budgetDrops` (see
 * DEX_REQUEST_INTERVAL_MS): a rising counter means the shared egress IP is
 * being rate-limited again and this value is the first thing to take back.
 */
const PAIRS_FETCH_BUDGET_MS = 2_000;
/**
 * Pair-data cache TTL. The re-eval pool rotates slowly (same coins swept
 * minute after minute), so re-fetching all ~550 addresses every tick burns
 * ~19 batched requests/min against a shared egress IP that other tenants
 * also hammer — the observed hard 429 block. A short TTL keeps gate math
 * fresh enough (cooldowns are ≥30 min) while cutting request volume ~70%.
 */
export const PAIR_CACHE_TTL_MS = 180_000;
/** Cache size cap (oldest entries evicted) — bounds isolate memory. */
const PAIR_CACHE_MAX = 4_000;
/**
 * Edge-cache TTL for the pair batches (`/latest/dex/tokens/<addresses>`), in
 * seconds — the same `cacheEverything` discipline the list feeds ride, on a
 * LONGER window because the freshness it may spend is larger.
 *
 * WHY THIS LANE CAN RIDE THE CACHE AT ALL (2026-09-30): the earlier note above
 * kept it out on purpose — these rows carry the metrics the gates and the
 * tracker judge — but the client ALREADY serves pair data up to
 * PAIR_CACHE_TTL_MS (180s) old from its own in-memory map, and does it for
 * every caller: the scan, the tracker pass and the /debug pair probes all read
 * that map before the wire. An edge entry is therefore never staler than what
 * a WARM isolate would already have served from memory; what changes is WHICH
 * isolates get to reuse it. That is the whole point: isolates are recycled
 * constantly (see POOL_EDGE_CACHE_URL in scanner.ts), so most ticks were cold
 * and paid the origin in full even though the previous tick's isolate had just
 * fetched the SAME batches. The batches repeat because their key is the
 * address set, and the set is stable while the pool snapshot's rotation slot
 * holds — the pool query itself is edge-cached (POOL_EDGE_CACHE_URL, TTL =
 * REEVAL_POOL_CACHE_SECONDS 90s), so consecutive ticks, and the cold isolates
 * among them, ask for the same URLs.
 *
 * WHY 120, NOT 60 OR 180: two ticks at the 60s cadence fit inside one entry
 * plus jitter, so the tick after a mint is a HIT instead of a boundary MISS —
 * and a MISS pays the shared egress's 300-800ms against a 2,000ms phase budget
 * (see PAIRS_FETCH_BUDGET_MS), which is the shape that drops tail batches. 180
 * is the in-memory number and stays the ceiling: this value must never exceed
 * PAIR_CACHE_TTL_MS (pinned by test).
 *
 * SAFETY: non-2xx stays OUT of the cache (`cacheTtlByStatus`), so a 429 can
 * never be served to the next tick as fresh pair data; the in-memory pair
 * cache is still consulted FIRST, so a hit there costs no request at all; and
 * while the 90s cache-only backoff is armed (`batchBlockedUntil`) no batch is
 * dispatched at all, so the edge cache is not a second way around a refusal.
 */
export const PAIR_BATCH_CACHE_TTL_S = 120;
/** After a batched-endpoint 429, skip all batch calls for this long. */
const PAIR_BATCH_BACKOFF_MS = 90_000;
/**
 * Minimum gap between two durable 429 records (see note429).
 *
 * WHY IT EXISTS (2026-10-01). The notify used to be debounced by the batch
 * block's own re-arm (`episodeStart = now >= batchBlockedUntil`), which only
 * worked while every refusal armed that block. Refusals are now charged to the
 * lane that made the request (see note429), and the LIST lanes are refused
 * about once a tick — measured live 14:59Z: `listCacheRefused 25` of
 * `feedRequests 30`, `lastRawProfiles 0` — so without a window of its own the
 * fleet ring would take one Turso write per tick, forever, for a drip that has
 * not changed. Sized as the number that debounce used to be, so the ring keeps
 * the cadence it had while the two were coupled.
 */
export const DEX_429_RECORD_MIN_GAP_MS = PAIR_BATCH_BACKOFF_MS;
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
   * Fired for a refusal on ANY of the client's lanes — the ring it feeds is
   * the host-wide "is DexScreener refusing this egress IP" reading — at most
   * once per DEX_429_RECORD_MIN_GAP_MS (see note429), so a refusal per tick
   * cannot become a Turso write per tick. The batch lane's own reactions (the
   * cache-only block, the spacing) do NOT ride this hook: they run on every
   * batch refusal, whether or not that refusal is recorded.
   */
  onBatch429?: (at: number) => void;
}

/**
 * How deep the pool behind one pair is, for the "which pair represents this
 * token" pick (see fetchPairsForTokens). `-1` for a pair that reports no
 * `liquidity.usd` — the pump.fun bonding curve's shape — so every real
 * reading outranks it, including a drained pool's `0` (the 0 is evidence the
 * 💧 rules must keep seeing).
 */
function pairDepth(pair: { liquidity: { usd: number | null } }): number {
  const liq = pair.liquidity?.usd;
  return typeof liq === "number" && Number.isFinite(liq) ? liq : -1;
}

/**
 * ONE raw pair from a DexScreener pairs body → the PairInfo every caller
 * reads. Extracted (2026-10-02) from fetchPairsForTokens' loop so the
 * by-address lookup behind the tracker's pool pin (see
 * fetchPairsByAddresses) maps a pair through the SAME field set: a second
 * inline copy is how the two lanes would come to disagree about what a
 * reading is — the pool pin's whole job is comparing pools through ONE
 * definition of their numbers.
 *
 * Returns null for anything the map cannot carry: a non-solana chain (the
 * endpoint serves every chain) and a pair with no baseToken address (they
 * exist in the feed and have no key). The field semantics are unchanged,
 * verbatim from the loop this came from: `marketCap` stays 0 when DexScreener
 * omits it (the gate rejects 0 rather than quietly substituting FDV), `fdv`
 * is its own quantity, and a drained pool's liquidity 0 is PRESERVED (it is
 * the 💧 rules' evidence — never "unknown").
 *
 * `contentAt` (epoch ms) is the response's own content timestamp, recovered by
 * the caller from its HTTP `age`/`date` clocks (see getJson) and attached here
 * so the reading's age travels WITH the row through every cache the client
 * keeps (see PairInfo.contentAt). Omitted = unknown.
 */
function parseDexPair(
  raw: Record<string, unknown>,
  contentAt?: number,
): PairInfo | null {
  if (raw.chainId !== "solana") return null;
  const baseToken = raw.baseToken as
    | { address?: string; name?: string; symbol?: string }
    | undefined;
  if (!baseToken?.address) return null;
  const volume = raw.volume as { h24?: number; h1?: number; m5?: number } | undefined;
  const txnsRaw = raw.txns as
    | {
        m5?: { buys?: number; sells?: number };
        h1?: { buys?: number; sells?: number };
      }
    | undefined;
  const priceChange = raw.priceChange as { m5?: number; h1?: number } | undefined;
  return {
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
    // Absent (not `undefined`) when the caller could not date the response:
    // the spread keeps the key out of the object entirely, so nothing that
    // serializes a pair writes a null-ish stamp (see the field's own note).
    ...(typeof contentAt === "number" && Number.isFinite(contentAt)
      ? { contentAt }
      : {}),
  };
}

export class DexScreenerClient {
  private readonly throttle: Throttle;
  /**
   * The 429-driven spacing controller (see AdaptiveSpacing). The throttle is
   * re-spaced from it on every refusal and every served response, so the two
   * can never disagree about the rate the queue is running at.
   */
  private readonly spacing: AdaptiveSpacing;
  /**
   * The durable fleet row's step count as this isolate last READ it, after
   * decay (see adoptDurableSpacing). Published so "the fleet is running wide"
   * is readable from /health — and so is the reading that proves a raise
   * crossed an isolate boundary rather than dying with one.
   */
  private fleetSteps = 0;
  /** How old that row was when it was read, or null when there was none. */
  private fleetAgeMs: number | null = null;
  /**
   * The step count the durable row is BELIEVED to hold — the value adopted
   * from it, updated on every write. `durableSpacingWrite` compares it against
   * the live spacing, which is what keeps a healthy tick from spending a write
   * to say "nothing changed". Null until the row has been read at all.
   */
  private persistedSteps: number | null = null;
  /** Fresh pair data by token (see PAIR_CACHE_TTL_MS). Insertion-ordered. */
  private readonly pairCache = new Map<
    string,
    { pair: PairInfo; at: number }
  >();
  /** Until this epoch the endpoint 429'd — serve pair cache only. */
  private batchBlockedUntil = 0;
  /**
   * When a refusal was last written to the fleet ring (see note429 and
   * DEX_429_RECORD_MIN_GAP_MS). Deliberately NOT the batch block: the block is
   * the batch lane's reaction, the ring is every lane's record.
   */
  private last429RecordedAt = 0;
  /** 429 responses seen by this isolate (incl. retry attempts). */
  private http429Total = 0;
  /** Epoch of the most recent 429 response, or null if never. */
  private last429At: number | null = null;
  /**
   * Pair-batch edge-cache ledger (see PAIR_BATCH_CACHE_TTL_S). INSTANCE state,
   * unlike the list ledger above: it is read through getStats() on the tick
   * summary the SCANNING isolate writes, so per-isolate is the right
   * granularity — and keeping it out of the module ledger is what stops a pair
   * HIT from changing the ratio that decides LIST_FEED_CACHE_TTL_S.
   */
  private pairCacheHits = 0;
  private pairCacheMisses = 0;
  private pairCacheRefused = 0;
  private lastPairCacheStatus: string | null = null;
  // The list-feed edge-cache ledger is MODULE state (see the ledger beside
  // LIST_FEED_CACHE_TTL_S): it is the accumulator the durable
  // dex_list_cache_* rows mirror, so it cannot be per-instance without the two
  // drifting — and getStats() below reads it from there.
  /**
   * Attempts this client NEVER SENT because the caller's deadline was already
   * spent (the throttle queue held them past it — see getJson). Counted apart
   * from `http429` because the two outages have different fixes: a 429 is the
   * upstream refusing, a drop is our own window being too small. Live 2026-09-25
   * the counters could not tell them apart, which is how `raw 0` read as
   * "DexScreener is blocking us" while the fetch may simply never have been
   * dispatched.
   */
  private budgetDrops = 0;
  private lastDroppedAt: number | null = null;
  /**
   * Those drops split by leg (see dexFeedLeg). The total says an attempt was
   * never sent; only the split says WHICH leg wanted it — and the three legs
   * have three different fixes (see the note on dexFeedLeg).
   */
  private dropsByLeg: Record<DexFeedLeg, number> = {
    profiles: 0,
    boosts: 0,
    pairs: 0,
    other: 0,
  };
  private lastDropLeg: DexFeedLeg | null = null;
  /**
   * The last profile fetch that returned coins, and when (see
   * PROFILE_FEED_REUSE_MS): what a rate-limited tick evaluates instead of
   * nothing. Instance state — but no longer isolate state: the scanner seeds
   * it from the durable journal at tick entry and journals it back on a
   * successful fetch (see DEX_PROFILES_LAST_KEY), so a recycled isolate
   * starts with the same list a warm one kept. A list fetched IN this isolate
   * is always the fresher of the two (`at` is the fetch stamp).
   */
  private lastGoodProfiles: { at: number; list: TokenProfile[] } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly hooks: DexScreenerHooks = {},
  ) {
    this.spacing = new AdaptiveSpacing(config.dexRequestIntervalMs);
    this.throttle = new Throttle(this.spacing.currentMs);
  }

  /**
   * Adopt the FLEET's durable spacing row (see DEX_SPACING_STATE_KEY) — the
   * one piece of 429 state that survives this isolate.
   *
   * Called once per scan, from the front row the tick already read (so it costs
   * no round trip), and RAISE-ONLY (see AdaptiveSpacing.adoptSteps): a refusal
   * that landed before the front came back is this isolate's own, fresher
   * evidence and must never be overwritten by an older row.
   *
   * The returned `steps` is what the ROW carried after decay — the honest
   * "what the fleet knew" reading, published on the summary as
   * `spacingFleetSteps` — while `intervalMs` is the rate this isolate is
   * actually running, which is the same number only when the adoption (or a
   * refusal of its own) is what moved it. `getStats()` publishes both, so a
   * live sample can tell the two layers apart.
   */
  adoptDurableSpacing(
    raw: string | null,
    now: number = Date.now(),
  ): {
    /** The row's step count after decay. 0 = no row, or a fully decayed one. */
    steps: number;
    /** Age of the row when read, or null when there was none. */
    ageMs: number | null;
    /** Whether the adoption actually widened this isolate's queue. */
    raised: boolean;
    /** The spacing this isolate is running after adoption (ms). */
    intervalMs: number;
  } {
    const stamp = parseDexSpacingStamp(raw);
    const steps = dexSpacingDecaySteps(stamp, now);
    this.fleetSteps = steps;
    this.fleetAgeMs = stamp === null ? null : Math.max(0, now - stamp.at);
    // What the row says, whether or not this isolate had already grown past it:
    // the comparison durableSpacingWrite makes is against the row, not against
    // the adoption's effect.
    this.persistedSteps = steps;
    const raised = this.spacing.adoptSteps(steps);
    if (raised) this.throttle.setIntervalMs(this.spacing.currentMs);
    return {
      steps,
      ageMs: this.fleetAgeMs,
      raised,
      intervalMs: this.spacing.currentMs,
    };
  }

  /**
   * The row to write back, or null when the durable value already agrees with
   * this isolate — the common case, and the reason a healthy day costs no
   * writes at all.
   *
   * `at` is the moment `steps` was established, and every write resets it: the
   * row is "as of `at`, the fleet was at `steps` raises", and decay is measured
   * from there. Writing a walked-back count with the OLD refusal's `at` would
   * make a later isolate decay it twice, which is why the timestamp travels
   * with the count rather than with the episode.
   *
   * A null `persistedSteps` (the row was never read — a standalone Scanner)
   * still writes a non-zero count: a raise nobody recorded is the one state
   * worth a write even when there is nothing to compare against.
   */
  durableSpacingWrite(now: number = Date.now()): DexSpacingStamp | null {
    const steps = this.spacing.growthSteps;
    if (this.persistedSteps !== null) {
      if (steps === this.persistedSteps) return null;
    } else if (steps <= 0) {
      return null;
    }
    this.persistedSteps = steps;
    return { at: now, steps };
  }

  /**
   * Live rate-limit telemetry for /health: the configured dispatch spacing
   * (DEX_REQUEST_INTERVAL_MS), how often the shared egress IP has been 429'd
   * since this isolate booted, and how long the cache-only backoff still has
   * to run. `blockedForMs > 0` means the BATCHED endpoint itself refused us
   * (see note429; `pairCacheRefused` carries the receipts) and every tick is
   * serving cache-only until it clears — a LIST-lane refusal no longer arms
   * it, so this field and `spacingSteps` are the pair lane's own reading.
   */
  getStats(): {
    /** The spacing dispatch is running at RIGHT NOW (see AdaptiveSpacing): the
     * configured base until the endpoint refuses, then raised, then walked back
     * down. `configuredIntervalMs` is the same number on a healthy day. */
    intervalMs: number;
    /** The configured base (DEX_REQUEST_INTERVAL_MS) the spacing returns to. */
    configuredIntervalMs: number;
    /** How many raises are in force since the last full recovery (0 = at base). */
    spacingSteps: number;
    /** The FLEET row's raises as this isolate last read them, after decay (see
     * DEX_SPACING_STATE_KEY). Non-zero on an isolate this one inherited from:
     * `spacingSteps > spacingFleetSteps` means the raises are this isolate's
     * own, `spacingFleetSteps > 0` means they crossed an isolate boundary. */
    spacingFleetSteps: number;
    /** Age of that row when it was read, or null when there was none. */
    spacingFleetAgeMs: number | null;
    http429: number;
    last429At: number | null;
    blockedForMs: number;
    cacheSize: number;
    /** List-feed responses served from the colo edge cache (see
     * LIST_FEED_CACHE_TTL_S) — climbing = the origin was never asked. */
    listCacheHits: number;
    /** The same lane's responses the cache did NOT serve (`cf-cache-status`
     * MISS / BYPASS / EXPIRED / DYNAMIC, or no header at all): the share of
     * these against the hits is what decides LIST_FEED_CACHE_TTL_S, and hits
     * alone could not tell a working cache from a lane that never ran. */
    listCacheMisses: number;
    /** List requests the ORIGIN refused (non-2xx). The other half of the
     * TTL reading: `misses` climbing = the entry expired and the origin
     * answered, THIS climbing = there was nothing to serve because the origin
     * said no (see noteListCacheRefused). */
    listCacheRefused: number;
    /** The LAST list-feed outcome: a `cf-cache-status` (HIT / MISS / BYPASS /
     * DYNAMIC…) when the response was a 2xx, `HTTP-<code>` when the origin
     * refused it, or null when the leg has not run in this isolate. */
    lastListCacheStatus: string | null;
    /** Pair batches served from the colo edge cache (see
     * PAIR_BATCH_CACHE_TTL_S) — climbing = the origin was not asked for that
     * batch. Instance state: counted on the isolate that ran the fetch, read
     * back on that tick's own summary. */
    pairCacheHits: number;
    /** Pair batches the cache did NOT serve (`cf-cache-status` MISS / BYPASS /
     * EXPIRED / DYNAMIC, or no header at all): the share of these against the
     * hits is what says whether the edge window is landing between ticks. */
    pairCacheMisses: number;
    /** Pair batches the ORIGIN refused (non-2xx), counted apart for the same
     * reason as listCacheRefused (see noteListCacheRefused): otherwise "the
     * entry expired" and "the origin said no" read identically. */
    pairCacheRefused: number;
    /** The LAST pair-batch outcome: a `cf-cache-status` when the response was
     * a 2xx, `HTTP-<code>` when the origin refused, null while no pair fetch
     * has run in this isolate. */
    lastPairCacheStatus: string | null;
    /** Attempts never SENT because the caller's window was already spent (the
     * throttle queue ate it) — the reading that separates "refused" from
     * "never asked". */
    budgetDrops: number;
    lastDroppedAt: number | null;
    /** The drops split by leg — WHICH leg wanted the attempts that never went
     * out (see dexFeedLeg). Always all four keys, zero included: a leg that
     * never dropped has to read as 0, not as absent (which would be
     * indistinguishable from a client that never ran the leg at all). */
    dropsByLeg: Record<DexFeedLeg, number>;
    /** The leg of the most recent drop, or null while none dropped. */
    lastDropLeg: DexFeedLeg | null;
  } {
    return {
      intervalMs: this.spacing.currentMs,
      configuredIntervalMs: this.config.dexRequestIntervalMs,
      spacingSteps: this.spacing.growthSteps,
      spacingFleetSteps: this.fleetSteps,
      spacingFleetAgeMs: this.fleetAgeMs,
      http429: this.http429Total,
      last429At: this.last429At,
      blockedForMs: Math.max(0, this.batchBlockedUntil - Date.now()),
      cacheSize: this.pairCache.size,
      listCacheHits: listCacheLedger.hits,
      listCacheMisses: listCacheLedger.misses,
      listCacheRefused: listCacheLedger.refused,
      lastListCacheStatus: listCacheLedger.status,
      pairCacheHits: this.pairCacheHits,
      pairCacheMisses: this.pairCacheMisses,
      pairCacheRefused: this.pairCacheRefused,
      lastPairCacheStatus: this.lastPairCacheStatus,
      budgetDrops: this.budgetDrops,
      lastDroppedAt: this.lastDroppedAt,
      dropsByLeg: { ...this.dropsByLeg },
      lastDropLeg: this.lastDropLeg,
    };
  }

  /**
   * Seed the reuse lane from the durable journal (see DEX_PROFILES_LAST_KEY),
   * so a recycled isolate starts with the same last-good list a warm one kept.
   * The freshest list wins: a fetch this isolate just made is newer than any
   * row that predates it, and an older row must never displace it.
   */
  seedLastGoodProfiles(view: ProfileFeedSnapshot | null): void {
    if (view === null) return;
    const current = this.lastGoodProfiles;
    if (current !== null && current.at >= view.at) return;
    this.lastGoodProfiles = {
      at: view.at,
      list: view.tokens.map((tokenAddress) => ({ tokenAddress })),
    };
  }

  /**
   * What the tick journals (see Scanner.stampProfileFeedSnapshot): the list a
   * failed fetch would reuse, and the stamp that decides the reuse window.
   * Null when this isolate has fetched nothing yet (and no row was seeded).
   */
  lastGoodProfilesSnapshot(): ProfileFeedSnapshot | null {
    const good = this.lastGoodProfiles;
    if (good === null) return null;
    return { at: good.at, tokens: good.list.map((p) => p.tokenAddress) };
  }

  /**
   * Record one attempt that was NEVER SENT because the caller's window was
   * already spent (see budgetDrops). Named by leg, because the total alone
   * cannot be acted on (see dexFeedLeg).
   */
  private noteDrop(path: string): void {
    const leg = dexFeedLeg(path);
    this.budgetDrops += 1;
    this.dropsByLeg[leg] += 1;
    this.lastDropLeg = leg;
    this.lastDroppedAt = Date.now();
  }

  /**
   * Count one pair-batch edge-cache outcome (2xx only — see
   * PAIR_BATCH_CACHE_TTL_S). Same rule as the list lane and the same regex:
   * `HIT`/`REVALIDATED` is a batch the origin was not asked for, anything else
   * is a miss, and a response with no `cf-cache-status` at all counts as a miss
   * because a hit is the one outcome that needs evidence. Only WHERE the count
   * lives differs (instance here, the durable journal for lists).
   */
  private notePairCacheOutcome(status: string | null): void {
    this.lastPairCacheStatus = status;
    if (status !== null && EDGE_CACHE_HIT_RE.test(status)) {
      this.pairCacheHits += 1;
      return;
    }
    this.pairCacheMisses += 1;
  }

  /**
   * Count one pair-batch request the origin REFUSED (non-2xx), mirroring
   * noteListCacheRefused: without it, `pairCacheMisses` climbing reads the same
   * whether the edge entry expired or the origin said no — and those two have
   * opposite fixes (re-size the TTL vs. wait out the refusal).
   */
  private notePairCacheRefused(status: number): void {
    this.pairCacheRefused += 1;
    this.lastPairCacheStatus = `HTTP-${status}`;
  }

  /**
   * Record a 429: always the count, the timestamp and the fleet ring; the
   * batch lane's TWO reactions (arm the cache-only backoff, widen the dispatch
   * spacing) only when the refusal came from the batch lane itself.
   *
   * WHY THE LANE IS PASSED IN (2026-10-01, measured live). This method is
   * called from getJson, which the two LIST lanes (`/token-profiles/`,
   * `/token-boosts/`) share with the pair batches — and while it was called
   * with no lane at all, a LIST refusal did both batch jobs. The profiles list
   * is refused by the shared egress IP's bucket on most ticks by design (see
   * LIST_FEED_CACHE_TTL_S: ~5 requests/minute per SOURCE IP and strangers spend
   * the bucket), so the coupling did not read as an incident — it read as the
   * normal state: measured 14:59Z, the list was refused 2s into the tick
   * (`last429At` = tick start, `listCacheRefused` == `http429`), `blockedForMs`
   * read 87,942 BEFORE the pair phase ran, and the pair lane dispatched nothing
   * at all that hour (`poolLegMs.pairs 0`, `pairCacheMisses 0`,
   * `pairCacheRefused 0`) while `pairsJup == pairs` every tick — the tick's
   * pair data was 100% the Jupiter fallback's, for a refusal the batch
   * endpoint never made. That is the one reading the old coupling hid: the
   * batch lane was never asked, so nothing could say whether it too was
   * refused. The batch reactions are now driven by the batch lane's own
   * refusals — exactly what PAIR_BATCH_BACKOFF_MS and AdaptiveSpacing were
   * written to describe — and a real batch 429 still arms both of them at once.
   *
   * The spacing follows EVERY batch refusal, not once per episode: an episode
   * is 3 retry attempts × N batches, and it is the LAST of them that must
   * leave the queue slower than the first — resting the spacing on the episode
   * start would return the queue to 250ms while the storm was still arriving.
   *
   * The ring stays host-wide — "is DexScreener refusing this egress IP?" is a
   * property of the host, not of one lane — and it needs its own gap now
   * (DEX_429_RECORD_MIN_GAP_MS); the counter still increments per response, so
   * the drip stays visible even while the notify is debounced.
   */
  /**
   * The epoch ms a response's CONTENT was generated upstream, recovered from
   * the response's own HTTP clocks — the one reading every cache layer on the
   * way preserves (see PairInfo.contentAt).
   *
   * `age` is the time since the origin generated (or validated) the body, so
   * `now - age` IS that generation time and needs no clock agreement with the
   * origin. `date` is the fallback for a response that carries no age (a fresh
   * origin answer); note that `date + age` would be the SERVE time — exactly
   * the receipt-stamp mistake this field exists to avoid. Null = the response
   * carried neither clock (a synthetic Response in tests).
   */
  private static responseContentAt(res: Response, now: number): number | null {
    const ageRaw = res.headers.get("age");
    if (ageRaw !== null) {
      const ageS = Number(ageRaw);
      if (Number.isFinite(ageS) && ageS >= 0) return now - ageS * 1000;
    }
    const dateMs = Date.parse(res.headers.get("date") ?? "");
    return Number.isFinite(dateMs) ? dateMs : null;
  }

  private note429(batchLane: boolean): void {
    const now = Date.now();
    this.http429Total++;
    this.last429At = now;
    if (batchLane) {
      this.batchBlockedUntil = now + PAIR_BATCH_BACKOFF_MS;
      this.spacing.noteRefused();
      this.throttle.setIntervalMs(this.spacing.currentMs);
    }
    if (now - this.last429RecordedAt < DEX_429_RECORD_MIN_GAP_MS) return;
    this.last429RecordedAt = now;
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
   *
   * `edgeCacheTtlS` (optional, seconds) asks for the Cloudflare EDGE CACHE on
   * this request — passed by the two LIST feeds (LIST_FEED_CACHE_TTL_S) and,
   * since 2026-09-30, by the pair batches too (PAIR_BATCH_CACHE_TTL_S, a
   * longer window on the same discipline). With the TTL set, a 429 stops
   * costing the tick its data: a HIT never leaves the colo, and a refused
   * 400/500 is kept out of the cache by `cacheTtlByStatus`, so nothing bad can
   * be served as if it were fresh. The outcome is counted on the LANE's own
   * ledger (see the `pairLane` split below).
   */
  private async getJson(
    path: string,
    deadline?: number,
    edgeCacheTtlS?: number,
    /**
     * Filled with the 2xx response's CONTENT timestamp (see
     * responseContentAt and PairInfo.contentAt) — a holder, because the value
     * belongs to the caller's response and this method's return type is the
     * parsed body. Only ever written on a 2xx that reaches the body read, so a
     * refusal or a spent budget can never overwrite a caller's prior stamp.
     */
    pairContentAt?: { at: number | null },
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining =
        deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (remaining <= 0) return null; // budget exhausted — stop trying
      // THE SLOT IS DECIDED BEFORE IT IS SPENT (2026-09-26).
      //
      // The check inside the queue below can only notice the window is gone
      // AFTER the queue has handed this attempt a slot — and a slot is not
      // free: the throttle's chain is global across callers and spaces every
      // request START 250ms apart, so a doomed attempt delays the legs behind
      // it by a full gap. Live 2026-09-26: `budgetDrops` 2-3 per tick, every
      // one of them an attempt that could never have been answered (the
      // operator's reading: the request was never dispatched). Predicting the
      // slot first (see Throttle.nextSlotAt) drops such an attempt for free,
      // and the in-queue check stays as a BACKSTOP for the one case a plan
      // cannot see: the isolate stalls long enough for a real dispatch to slip
      // past it.
      if (deadline !== undefined && this.throttle.nextSlotAt() >= deadline) {
        this.noteDrop(path);
        return null;
      }
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
          if (deadline !== undefined && Date.now() >= deadline) {
            // NEVER SENT (see budgetDrops): the queue held this attempt past
            // the caller's window. Counting it apart from a 429 is the whole
            // reason the field exists — the two have different fixes.
            this.noteDrop(path);
            return null;
          }
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
          const init: CloudflareFetchInit = {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(left),
          };
          if (edgeCacheTtlS !== undefined && edgeCacheTtlS > 0) {
            // See LIST_FEED_CACHE_TTL_S / PAIR_BATCH_CACHE_TTL_S. Non-2xx stays
            // OUT of the cache: a 429 must never be served to the next tick as
            // fresh data.
            init.cf = {
              cacheEverything: true,
              cacheTtl: edgeCacheTtlS,
              cacheTtlByStatus: {
                "200-299": edgeCacheTtlS,
                "300-399": 0,
                "400-599": 0,
              },
            };
          }
          return fetch(`${BASE_URL}${path}`, init);
        });
        // A throttled-away attempt (the window closed while it queued) is a
        // budget answer, not a failure: the caller already owns its own
        // fallback, and retrying would only spend the caller's window.
        if (res === null) return null;
        // ONE place decides which LANE an outcome belongs to (the path — the
        // same dexFeedLeg mapping the drop counters use), so a pair HIT can
        // never move the list ratio that decides LIST_FEED_CACHE_TTL_S — and
        // the 429 handler below charges the refusal to that same lane (see
        // note429), which is why the answer is computed before the
        // edge-cache branch rather than inside it.
        const pairLane = dexFeedLeg(path) === "pairs";
        if (edgeCacheTtlS !== undefined) {
          if (res.ok) {
            // ONE place counts a list outcome and one place decides what a hit
            // is (see the ledger): a second inline regex here is how the durable
            // ratio would come to disagree with the page's own reading. The
            // pair lane reuses the same rule (see notePairCacheOutcome).
            //
            // 2xx ONLY for the hit/miss split, and it is the ratio's meaning
            // that requires it: `cacheTtlByStatus` gives an entry a TTL for
            // 200-299 alone, so a 429/5xx was never a candidate for the edge
            // cache and cannot read as an entry that had EXPIRED.
            const cacheStatus = res.headers.get("cf-cache-status");
            if (pairLane) this.notePairCacheOutcome(cacheStatus);
            else noteListCacheOutcome(cacheStatus);
          } else {
            // …and the refusal, counted on its OWN counter (2026-09-30, see
            // noteListCacheRefused): keeping it out of hit/miss was right and
            // keeping it out of the durable record entirely left the one
            // reading the TTL decision needs — "the origin refused us" —
            // invisible. Live: 19 refusals in 21 ticks read `99.8% HIT`.
            if (pairLane) this.notePairCacheRefused(res.status);
            else noteListCacheRefused(res.status);
          }
        }
        if (res.status === 429) this.note429(pairLane);
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`DexScreener HTTP ${res.status}`);
        }
        if (!res.ok) {
          return null; // deterministic client error — retrying won't help
        }
        // Date the CONTENT, not the receipt (see PairInfo.contentAt). The
        // response's own clocks are the only reading that survives the three
        // cache layers this client sits behind: every layer re-stamps when it
        // SERVED the body, none of them changes when the body was generated.
        if (pairContentAt) {
          pairContentAt.at = DexScreenerClient.responseContentAt(res, Date.now());
        }
        // A 2xx is the ONLY reading that relaxes the spacing (see
        // AdaptiveSpacing): a 404 for a delisted token is "not refused", not
        // "healthy", and counting it would return the queue to the base
        // spacing while the endpoint was still limiting the real traffic.
        this.spacing.noteServed();
        this.throttle.setIntervalMs(this.spacing.currentMs);
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
        // The LIVE spacing, not the configured one: once the adaptive
        // controller has widened the queue (see AdaptiveSpacing) the gap
        // between two attempts IS the wider number, so the room a retry needs
        // is too — sizing it from the base would admit a retry whose throttle
        // wait alone outlives the caller's window.
        const retryHeadroomMs = this.spacing.currentMs + RETRY_MIN_ATTEMPT_MS;
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
   *
   * `feedWindowDeadline` (optional, ms epoch) is the caller's own window — the
   * scanner hands it BOOST_FEED_WINDOW_MS (its own, sized to the ladder's
   * ceiling plus an attempt), NOT the shared feed deadline it used to pass. See
   * BOOST_FEED_SELF_BUDGET_MS for the arithmetic and why the cap stays.
   */
  async fetchBoostedTokens(
    limit: number,
    feedWindowDeadline?: number,
  ): Promise<TokenProfile[]> {
    // Off by default (DEXSCREENER_BOOSTS_LIMIT = 0) — the leg must cost
    // nothing when disabled, not even a request.
    if (!(limit > 0)) return [];
    // THE SLOT IS DECIDED BEFORE IT IS SPENT here too, and the budget is what
    // the slot costs: this leg is the tick's second DexScreener request, so it
    // must wait one gap before its own attempt starts (see
    // BOOST_FEED_SELF_BUDGET_MS). A free queue still answers inside the same
    // 480ms the profiles leg gets, so nothing changes on a healthy tick.
    const deadline = Math.max(
      Date.now() + BOOST_FEED_SELF_BUDGET_MS,
      this.throttle.nextSlotAt() + BOOST_FEED_ATTEMPT_MS,
    );
    // ...and the caller's window is the CAP. A queue this leg cannot afford to
    // sit in is not a request the tick can use: the answer would land after the
    // feed phase joins and be thrown away by the caller's own race, while the
    // gap it spent is one the pair phase pays for. Counted as a drop — an
    // attempt that was never sent — because the other reading, an empty boosts
    // list, is exactly what a healthy upstream returning nothing looks like
    // (see noteDrop).
    //
    // THIS CAP IS WHY THE LADDER'S CEILING USED TO DROP EVERY TICK
    // (2026-10-03): at intervalMs 1200 the slot + attempt is 1680ms, so a
    // caller handing in the 1600ms shared feed window dropped the leg on every
    // ceiling tick — see BOOST_FEED_SELF_BUDGET_MS. The scanner's window is now
    // BOOST_FEED_WINDOW_MS (2000), sized for this arithmetic.
    if (feedWindowDeadline !== undefined && deadline > feedWindowDeadline) {
      this.noteDrop("/token-boosts/latest/v1");
      return [];
    }
    let data: unknown = null;
    try {
      // Same edge-cache discipline as the profiles list (see
      // LIST_FEED_CACHE_TTL_S): same host, same shared-IP bucket, same
      // "latest" list semantics.
      data = await this.getJson("/token-boosts/latest/v1", deadline, LIST_FEED_CACHE_TTL_S);
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
   *
   * `seed` is the caller's durable journal row (see DEX_PROFILES_LAST_KEY),
   * handed over as a PROMISE because the caller dispatches this fetch before
   * it has read that row: the two overlap by design, and a refusal can land
   * first — instantly, when this client is in its own 90-second cache-only
   * backoff. Waiting for the row on the fallback path only (see below) is
   * what makes the lane order-independent: live 2026-09-26T23:10-23:11Z, two
   * ticks whose fetch was refused read `profiles 3` — the make-up lane alone
   * — while the row on disk was two minutes old, purely because the fetch had
   * already settled before the seed existed.
   */
  async fetchLatestSolanaProfiles(
    seed?: Promise<ProfileFeedSnapshot | null>,
  ): Promise<TokenProfile[]> {
    let data: unknown = null;
    let failed = false;
    // The deadline bounds the WHOLE call, attempt 1 included (see
    // PROFILE_FEED_SELF_BUDGET_MS): a fetch this call abandons early still
    // builds the make-up list, whereas one the scanner's race discards takes
    // the make-up with it.
    const deadline = Date.now() + PROFILE_FEED_SELF_BUDGET_MS;
    try {
      // Edge-cached (see LIST_FEED_CACHE_TTL_S): the one lane whose 429s the
      // operator sees as `raw 0`, and whose freshness bar is the loosest (this
      // method already re-evaluates a 10-minute-old list on a failed fetch).
      data = await this.getJson("/token-profiles/latest/v1", deadline, LIST_FEED_CACHE_TTL_S);
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
    // The caller's row, waited for ONLY when this fetch is about to fall
    // back (see the seed parameter): `failed || feed.length === 0` is exactly
    // the set shouldReuseProfileList may serve below, so a healthy fetch never
    // waits on Turso and a refused one gets the list the caller had ALREADY
    // read. The wait is short by construction — the caller's row read is one
    // round trip that is already in flight — and a rejected or absent row is
    // simply no seed.
    if (seed && (failed || feed.length === 0)) {
      try {
        this.seedLastGoodProfiles(await seed);
      } catch {
        /* the row is best-effort: a failed read seeds nothing */
      }
    }
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
   * group pairs by baseToken.address and keep the DEEPEST Solana pool per
   * token (see the pick's own note in the loop — an array position is not a
   * property of the market).
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
     * (tests and ad-hoc calls) → the local budget only. The SCANNER PASSES IT
     * since 2026-10-01 — it used to rely on its front-phase caps summing
     * inside the window, which the 73-cut outage falsified (see the module
     * note in scanner.ts around SCAN_GATE_RESERVE_MS).
     */
    callerDeadlineMs?: number,
  ): Promise<Map<string, PairInfo>> {
    const result = new Map<string, PairInfo>();
    /**
     * The depth already accepted for each token IN THIS RESPONSE (see the
     * pick's note in the batch loop). Deliberately separate from `result`:
     * `result` is pre-seeded with cache hits, and a cache hit's depth must
     * not decide how a freshly-fetched pair is judged.
     */
    const batchDepth = new Map<string, number>();
    const now = Date.now();
    // Serve whatever is still fresh from the cache first; only cache misses
    // hit the wire.
    const misses: string[] = [];
    for (const a of addresses) {
      const hit = this.pairCache.get(a);
      if (hit && now - hit.at < PAIR_CACHE_TTL_MS) {
        // …but only while the CONTENT it holds is still fresh enough to
        // serve (see PAIR_CONTENT_MAX_AGE_MS). The entry's own write age is
        // not that reading: a body fetched just now can already be minutes
        // old (the edge handed over a near-expiry entry), and this map used
        // to re-serve it for another 180s on top — the DUST cards' ~4-minute
        // reading in one line. An entry past the bound is treated as a MISS
        // so the wire is asked again; the edge entry behind it has always
        // expired by then (the bound is sized above that window), so the
        // re-ask is a real refresh. Undated entries are served as before.
        const age = pairContentAgeMs(hit.pair, now);
        if (age === null || age <= PAIR_CONTENT_MAX_AGE_MS) {
          result.set(a, hit.pair);
          continue;
        }
      }
      misses.push(a);
    }
    if (misses.length === 0) return result;
    // Blocked by a recent hard 429: don't hammer the endpoint (and don't
    // burn the tick's budget on doomed retries) — cache-only for now.
    if (Date.now() < this.batchBlockedUntil) return result;

    // A caller deadline ALREADY IN THE PAST is honoured as "send nothing"
    // (2026-10-01), not folded into the local budget: this used to read
    // `callerDeadlineMs > now ? callerDeadlineMs : Infinity`, so the one caller
    // whose phase had already run out — the tick that is late — silently got
    // another full PAIRS_FETCH_BUDGET_MS of wire time. A deadline in the past
    // now makes the loop's own `Date.now() > deadline` check stop it before the
    // first batch, which is the same rule the loop already applies to a batch
    // it cannot start ("pure latency here"), and cache hits are still served
    // above this line — they are free and the gates need them.
    const deadline = Math.min(
      now + PAIRS_FETCH_BUDGET_MS,
      typeof callerDeadlineMs === "number"
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
        // A batch the throttle cannot START inside this phase's window is not
        // a drop — it is not attempted AT ALL (2026-09-26).
        //
        // WHY (live 2026-09-26: `budgetDrops` 2-3 per tick, the operator's
        // reading "the request was never sent"): the pair phase dispatches up
        // to 6 batches into a 1s window at a 250ms global spacing, so its TAIL
        // batches were being enqueued only for the queue to hold them past the
        // deadline — every one of them consumed a 250ms slot from the legs
        // behind it and then answered nothing. A batch that cannot start is
        // pure latency here: skipped tokens keep their pool slot and are
        // re-read on the next rotation (see PAIRS_FETCH_BUDGET_MS), i.e. the
        // same outcome the drop produced, minus the slot and minus the false
        // reading. So the phase ENDS instead: `nextSlotAt` is the queue's own
        // plan, and this is the same arithmetic its drop check would have
        // applied one call later.
        if (this.throttle.nextSlotAt() >= deadline) return;
        const batch = batches[nextBatch++];
        let data: { pairs?: Array<Record<string, unknown>> } | null;
        /**
         * This batch's content timestamp (see PairInfo.contentAt), filled by
         * getJson from the response's own clocks and attached to every row
         * below — the reading's age must travel WITH the pair, because the
         * in-memory cache re-serves the same object and a later caller cannot
         * tell a fresh fetch from a stale hit otherwise.
         */
        const contentAt: { at: number | null } = { at: null };
        try {
          data = (await this.getJson(
            `/latest/dex/tokens/${batch.join(",")}`,
            deadline,
            // See PAIR_BATCH_CACHE_TTL_S: the batches are keyed by the address
            // set, which the edge-cached pool snapshot keeps stable across
            // ticks, so a cold isolate rides the previous tick's fetch instead
            // of paying the shared egress (and its 429s) again.
            PAIR_BATCH_CACHE_TTL_S,
            contentAt,
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
          const info = parseDexPair(raw, contentAt.at ?? undefined);
          if (!info) continue;
          // DEEPEST POOL WINS — the pair that REPRESENTS a token is the one
          // with the most liquidity behind it, not whichever array position
          // the feed happened to use. DexScreener usually lists the deepest
          // pool first (measured 2026-09-19 over 11 coins, and again
          // 2026-10-02), but "usually" is not a market fact: one token's
          // returned pairs spanned mcap $48K–$3.3M across 8 pools on
          // 2026-10-02 (Agency) — a drained pair at $0 LP, two more at ~$3,
          // and one $85K-LP pool printing a $3,058 market cap (1000× off) —
          // while the tracker's peak/drawdown/dead rules and the scan gates
          // all read whatever this map holds, as ONE series. A single listing
          // accident therefore quoted a 💀 card's 現價 at half the pool's own
          // price. A real reading (a drained pool's 0 included: it is the
          // 💧 rules' evidence) outranks a pair that reports no `liquidity`
          // at all; ties keep the first, so the pick is stable when the feed
          // repeats itself.
          const depth = pairDepth(info);
          const known = batchDepth.get(info.baseToken.address);
          if (known !== undefined && depth <= known) continue;
          batchDepth.set(info.baseToken.address, depth);
          result.set(info.baseToken.address, info);
          this.pairCache.set(info.baseToken.address, { pair: info, at: now });
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

  /**
   * The DEXSCREENER answer for specific POOLS, keyed by pair address — the
   * lookup behind the tracker's pool pin (see the pin's own note in
   * src/pushwatch.ts).
   *
   * WHY IT EXISTS: fetchPairsForTokens answers "which pair REPRESENTS this
   * token" (one pair per token, deepest wins), so a tracker row can never
   * learn from it whether its OWN pool — the one the push was based on — is
   * still in DexScreener's response. Live 2026-10-02 (Agency): one mint's
   * returned pairs spanned mcap $48K–$3.3M across 8 pools, and a row judged
   * from whichever pool the token batch happened to hold is exactly how a
   * 現價 came out at half the market's. This endpoint
   * (/latest/dex/pairs/{chainId}/{pairIds}, up to 30 ids per request, a
   * `pairs` array back) answers for the pool the caller NAMES, and nothing
   * else.
   *
   * `answered` is the contract that keeps absence honest:
   *   false → this call did NOT get a full 2xx body (blocked, refused, out of
   *           window). A requested pool missing from `pairs` is UNKNOWN —
   *           definitely not gone.
   *   true  → the body arrived; a requested pool that is not in `pairs` is
   *           genuinely not in DexScreener's response (a switch / delist),
   *           which is the ONLY state the caller may re-pin from.
   * A partially-answered multi-batch call reports false: the un-answered
   * batch's pools must not read as gone. (The pin path requests ≤30 addresses,
   * i.e. one batch; the loop exists for completeness.)
   *
   * Lane discipline is the token batches' own: the shared throttle spaces the
   * request, a 429 arms the batch block + adaptive spacing through note429
   * (dexFeedLeg files this path under "pairs"), and the edge cache carries
   * PAIR_BATCH_CACHE_TTL_S — the pinned address set is stable across passes,
   * so a warm edge absorbs repeat lookups instead of re-paying the shared
   * egress.
   */
  async fetchPairsByAddresses(
    addresses: string[],
    /**
     * Absolute epoch ms the CALLER's phase must be done by — same contract as
     * fetchPairsForTokens' deadline. Omitted (tests, ad-hoc calls) → the local
     * budget only.
     */
    callerDeadlineMs?: number,
  ): Promise<{ pairs: Map<string, PairInfo>; answered: boolean }> {
    const pairs = new Map<string, PairInfo>();
    const uniq: string[] = [];
    for (const a of addresses) {
      if (typeof a === "string" && a.length > 0 && !uniq.includes(a)) uniq.push(a);
    }
    // An empty request is trivially answered (there is nothing to be wrong
    // about), so the caller can tell it apart from a refusal below.
    if (uniq.length === 0) return { pairs, answered: true };
    // Blocked by a recent hard 429: never send, and never let the caller read
    // the empty answer as "the pools are gone".
    if (Date.now() < this.batchBlockedUntil) return { pairs, answered: false };
    const deadline = Math.min(
      Date.now() + PAIRS_FETCH_BUDGET_MS,
      typeof callerDeadlineMs === "number"
        ? callerDeadlineMs
        : Number.POSITIVE_INFINITY,
    );
    const batches: string[][] = [];
    for (let i = 0; i < uniq.length; i += 30) batches.push(uniq.slice(i, i + 30));
    let answered = true;
    for (const batch of batches) {
      // A batch the throttle cannot START inside the caller's window is not
      // attempted at all (the same rule the token lane documents): nothing was
      // asked, so the answer is incomplete — UNKNOWN, not "gone".
      if (Date.now() > deadline || this.throttle.nextSlotAt() >= deadline) {
        answered = false;
        break;
      }
      let data: unknown;
      /** The batch's content timestamp — same contract as the token lane's. */
      const contentAt: { at: number | null } = { at: null };
      try {
        data = await this.getJson(
          `/latest/dex/pairs/solana/${batch.join(",")}`,
          deadline,
          // See PAIR_BATCH_CACHE_TTL_S / the note above.
          PAIR_BATCH_CACHE_TTL_S,
          contentAt,
        );
      } catch {
        // A 429 has already armed the block and the spacing (see note429),
        // and any other error is transient: either way the caller must read
        // this call as unanswered.
        answered = false;
        break;
      }
      if (data === null || typeof data !== "object") {
        answered = false;
        break;
      }
      const list = (data as { pairs?: unknown }).pairs;
      if (!Array.isArray(list)) {
        // A 2xx body without the documented `pairs` array is not an answer
        // about any pool.
        answered = false;
        break;
      }
      for (const raw of list) {
        if (raw === null || typeof raw !== "object") continue;
        const info = parseDexPair(
          raw as Record<string, unknown>,
          contentAt.at ?? undefined,
        );
        if (!info || info.pairAddress.length === 0) continue;
        pairs.set(info.pairAddress, info);
      }
    }
    return { pairs, answered };
  }
}
