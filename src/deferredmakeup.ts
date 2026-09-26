/*
 * Deferred-card registry — the make-up obligation behind a card the scan's
 * tick budget refused to START (see DeferredPushLedger in scanner.ts).
 *
 * WHY IT IS ITS OWN MODULE: the obligation has to be visible in two places
 * that cannot import each other — the scanner (which records the deferral and
 * its recovery) and the discovery feed the tick always evaluates
 * (dexscreener.ts, which pulls the coin back into the scan). A leaf module
 * keeps that shared state out of the import cycle those two would otherwise
 * form.
 *
 * WHY THE FEED IS THE PULL POINT (live 2026-09-19): `deferredTotal 53` in
 * 10.3h with `recoveredTotal 0` and `pending` pinned at 1-4 — not one make-up
 * send was observable, while `candidates 1, pushed 0` repeated minute after
 * minute. A deferral only touches the coin's place in the re-evaluation pool
 * (nothing is written), and the pool is a ROTATION: the coin is re-evaluated
 * when its band comes around (3 min near zone, 18 min far) — and if the band
 * rotation, an mcap/liquidity prune or the query's LIMIT moved past it, not
 * again at all. The deferred coin therefore has to ride the one list that is
 * evaluated EVERY tick, in front of every pool coin: the profiles feed. That
 * costs nothing extra downstream (the feed's registration read and pair batch
 * already cover whatever the feed returns) and it is bounded
 * (DEFERRED_MAKEUP_MAX per tick), so a deferral that never comes back — the
 * market moved, the row was pruned — cannot grow the tick.
 *
 * WHY AN OBLIGATION IS RETIRED (2026-09-26): the bound above is a WINDOW
 * bound, not a lifetime one. An obligation that can never be paid — the coin
 * aged past every chat's max age, or has no pair at all — stays in the
 * registry forever, and because the make-up lane is OLDEST-FIRST, a dead tail
 * does not merely sit there: it consumes every make-up slot the lane has.
 * Live, before this rule existed: `deferral.pending 20` with `injectedTotal 8`
 * on EVERY tick, the 8 oldest entries measured at 47.6-167.0 h old against
 * the widest chat's 26 h max age — so the 8 slots were 100 % dead coins and
 * anything newer (including a genuine obligation at 7.7 h) never got one.
 * The prune rule is therefore not telemetry: it is what keeps the lane alive
 * (see noteDeferredCoin).
 */

/**
 * Deferred coins prepended to ONE tick's discovery feed. Eight is several
 * sweeps' worth of the live backlog (`pending` has been 1-4 all day) with
 * room for a burst, while a pathological backlog can never crowd out the
 * tick's actual discovery: the feed's own coins keep their slots (the
 * make-up list is appended past `SCAN_PROFILE_LIMIT`).
 */
export const DEFERRED_MAKEUP_MAX = 8;

/**
 * Hard cap on the registry itself — the same bound the in-memory ledger used
 * before it moved here, so the durable `pendingTokens` snapshot stays small.
 * The OLDEST entry is evicted at the cap: a deferral nobody has paid back in
 * hundreds of cards is the least likely to be paid back ever.
 */
export const DEFERRED_REGISTRY_MAX = 500;

/**
 * Consecutive observations with NO pair data before an obligation is retired
 * as unreachable.
 *
 * Three (≈ three ticks, ~3 minutes at the live 60s cadence) because the
 * observation is a fact about an UPSTREAM answer, not about the coin: a batch
 * the pair phase skipped (budget cut), a 429 backoff or a last-good feed
 * reuse can all leave one tick without the coin's pair, and one of those must
 * never retire a live obligation. A coin whose pool really is gone — the
 * prune target (`74sHNXtVDH…`: no pair AND no token_stats row) — misses every
 * time, so three costs it three ticks and nothing more.
 */
export const DEFERRED_PRUNE_ATTEMPTS = 3;

/**
 * Recent retirements kept for the probe/Debug view. The durable row carries
 * the cumulative count; this ring carries the RECENT reasons, which is what
 * `/debug/deferral` is read for.
 */
export const DEFERRED_PRUNE_RING_MAX = 12;

/** Why an obligation stopped being owed (see noteDeferredCoin). */
export type DeferredRetireReason =
  /** The coin aged past every enabled chat's max age: no chat can accept it. */
  | "too-old"
  /** No pair data on DEFERRED_PRUNE_ATTEMPTS consecutive observations. */
  | "no-pair";

/** One retirement, as the probe reports it. */
export interface DeferredPruneEntry {
  token: string;
  reason: DeferredRetireReason;
  /** When the retirement happened (ms epoch). */
  at: number;
  /** The coin's age at that moment, whole minutes (null = it had no pair). */
  ageMin: number | null;
  /** The widest enabled chat's max age in force, whole minutes. */
  windowMaxAgeMin: number | null;
}

/**
 * One owed coin, as the probe reports it. `at` is when the obligation was
 * FIRST recorded, not the last time it was re-offered: a deferral is
 * idempotent per token (see addDeferredToken), so this is the age of the debt
 * itself.
 */
export interface DeferredEntryView {
  token: string;
  at: number;
  /** How long the coin has been owed, whole minutes. */
  owedMin: number;
  /** Consecutive no-pair observations so far (see DEFERRED_PRUNE_ATTEMPTS). */
  misses: number;
}

/**
 * This isolate's registry, as `/debug/deferral` publishes it. The durable row
 * answers "what is owed fleet-wide"; this answers "why is THIS isolate still
 * holding what it holds" — the misses counter is the half the row cannot
 * carry.
 */
export interface DeferralRegistryView {
  pending: DeferredEntryView[];
  pendingCount: number;
  /**
   * Obligations THIS ISOLATE has retired since it booted (module state). A
   * different question from the durable row's `prunedTotal`, which accumulates
   * the SCANNER's cursor deltas across isolates (see DeferredPushLedger) — the
   * split matters because the dead-tick rebuild replaces the scanner and its
   * baseline while this module state survives.
   */
  prunedTotal: number;
  firstPruneAt: number | null;
  lastPruneAt: number | null;
  /** Newest-last ring of recent retirements (see DEFERRED_PRUNE_RING_MAX). */
  lastPruned: DeferredPruneEntry[];
  /** The rule's slack, published so a reading is self-explanatory. */
  attempts: number;
  /** The widest enabled chat's max age the last observation judged against. */
  windowMaxAgeMin: number | null;
}

/** token → the obligation's state. Map iteration order = oldest first. */
const pendingTokens = new Map<string, DeferredEntry>();

interface DeferredEntry {
  /** When the obligation was FIRST recorded (ms epoch). */
  at: number;
  /**
   * Consecutive observations that found no pair data — the `no-pair` half of
   * the prune rule (see noteDeferredCoin). Reset to 0 by any observation that
   * proves the coin reachable, so only a RUN of misses retires anything.
   */
  misses: number;
}

/** Obligations retired by the prune rule since this isolate booted. */
let prunedTotal = 0;
let firstPruneAt: number | null = null;
let lastPruneAt: number | null = null;
const prunedRing: DeferredPruneEntry[] = [];
/** Widest enabled chat's max age, as last seen by noteDeferredCoin. */
let observedWindowMaxAgeMin: number | null = null;

/**
 * Record that `token` was refused a card. Idempotent per token, so the many
 * ticks that re-evaluate a still-deferred coin while it is pending do not
 * extend the backlog or move it in the queue — and, deliberately, do not
 * reset its `misses` either: a re-deferral says the tick ran out of budget,
 * not that the coin's pair came back.
 */
export function addDeferredToken(
  token: string,
  at: number,
  maxEntries = DEFERRED_REGISTRY_MAX,
): void {
  if (token.length === 0 || pendingTokens.has(token)) return;
  pendingTokens.set(token, { at, misses: 0 });
  while (pendingTokens.size > maxEntries) {
    const oldest = pendingTokens.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingTokens.delete(oldest);
  }
}

/**
 * Clear a deferred token (its card was pushed). Returns whether the token
 * was actually pending, i.e. whether this push IS the make-up send the
 * deferral promised.
 */
export function dropDeferredToken(token: string): boolean {
  return pendingTokens.delete(token);
}

/** Whether `token` carries an unpaid make-up obligation right now. */
export function isDeferredToken(token: string): boolean {
  return pendingTokens.has(token);
}

/**
 * Pending deferred-card identities, oldest first. This is what the durable
 * `worker_state.push_deferral` row stores, so a recycled isolate can hydrate
 * the real obligations instead of only their count.
 */
export function deferredTokenList(): string[] {
  return [...pendingTokens.keys()];
}

/** Obligations the prune rule has retired since this isolate booted. */
export function deferredPrunedTotal(): number {
  return prunedTotal;
}

/**
 * Retire one obligation: the coin can never produce the card this debt is for,
 * so keeping it only spends the make-up lane (and, via deferredTokenList, the
 * durable pending list) on something no push can ever clear.
 *
 * Only ever REMOVES an obligation, which is why it is safe to be wrong: a coin
 * the user is genuinely still owed keeps its place in the re-evaluation pool,
 * so the prune can cost it its forced make-up priority and never its card. The
 * same trade is already accepted for the delivered-drop (see
 * deliveredDeferredTokens in src/deferrallog.ts).
 */
function retireDeferred(
  token: string,
  reason: DeferredRetireReason,
  at: number,
  ageMs: number | null,
  windowMaxAgeMs: number | null,
): boolean {
  if (!pendingTokens.delete(token)) return false;
  prunedTotal += 1;
  if (firstPruneAt === null) firstPruneAt = at;
  lastPruneAt = at;
  prunedRing.push({
    token,
    reason,
    at,
    ageMin: ageMs === null || !Number.isFinite(ageMs) ? null : Math.round(ageMs / 60_000),
    windowMaxAgeMin:
      windowMaxAgeMs === null || !Number.isFinite(windowMaxAgeMs)
        ? null
        : Math.round(windowMaxAgeMs / 60_000),
  });
  if (prunedRing.length > DEFERRED_PRUNE_RING_MAX) {
    prunedRing.splice(0, prunedRing.length - DEFERRED_PRUNE_RING_MAX);
  }
  return true;
}

/**
 * Tell the registry what the tick just learned about an owed coin, and let it
 * retire the obligation when the answer is "no card is possible".
 *
 * THE FACTS ARE THE GATE'S OWN: `ageMs` is the number the per-chat age gate
 * decides on (`Date.now() - pair.pairCreatedAt`, src/scanner.ts matchCoins) and
 * `windowMaxAgeMs` is the WIDEST enabled chat's max age, so `ageMs >
 * windowMaxAgeMs` means every enabled chat rejects this coin on age. That is
 * the property that makes the prune safe to apply immediately rather than
 * after a grace period: it can only ever retire an obligation the gate itself
 * would refuse, and age is monotonic — a coin that is too old stays too old.
 * (`too FRESH` is deliberately NOT a retirement: a young coin ages INTO the
 * window, so it is an in-window reading like any other.)
 *
 * `ageMs === null` (no pair in the batch) is the only soft case, and it is the
 * one that needs slack: an upstream answer can miss a live coin for a tick
 * (budget cut, 429, last-good reuse), so it takes
 * DEFERRED_PRUNE_ATTEMPTS consecutive misses — any in-window observation in
 * between resets the run.
 *
 * Pure state transition, exported, and driven from one call site (matchCoins),
 * so the rule is unit-testable without the scan.
 */
export function noteDeferredCoin(
  token: string,
  facts: { ageMs: number | null; windowMaxAgeMs: number },
  now = Date.now(),
): boolean {
  const entry = pendingTokens.get(token);
  if (!entry) return false;
  if (Number.isFinite(facts.windowMaxAgeMs)) {
    observedWindowMaxAgeMin = Math.round(facts.windowMaxAgeMs / 60_000);
  }
  if (facts.ageMs === null || !Number.isFinite(facts.ageMs)) {
    entry.misses += 1;
    if (entry.misses >= DEFERRED_PRUNE_ATTEMPTS) {
      return retireDeferred(token, "no-pair", now, null, facts.windowMaxAgeMs);
    }
    return false;
  }
  if (facts.ageMs > facts.windowMaxAgeMs) {
    return retireDeferred(token, "too-old", now, facts.ageMs, facts.windowMaxAgeMs);
  }
  entry.misses = 0;
  return false;
}

/**
 * This isolate's registry view (see DeferralRegistryView). Read-only, so the
 * `/debug/deferral` probe can be polled while diagnosing.
 */
export function deferralRegistryView(now = Date.now()): DeferralRegistryView {
  const pending: DeferredEntryView[] = [];
  for (const [token, entry] of pendingTokens) {
    pending.push({
      token,
      at: entry.at,
      owedMin: Math.max(0, Math.round((now - entry.at) / 60_000)),
      misses: entry.misses,
    });
  }
  return {
    pending,
    pendingCount: pending.length,
    prunedTotal,
    firstPruneAt,
    lastPruneAt,
    lastPruned: prunedRing.slice(),
    attempts: DEFERRED_PRUNE_ATTEMPTS,
    windowMaxAgeMin: observedWindowMaxAgeMin,
  };
}

/**
 * Test seam: the view is module state, like the pending registry above.
 * Clears the obligations AND the prune bookkeeping, so a suite that asserts
 * "pending 1, pruned 1" cannot inherit another test's registry.
 */
export function resetDeferredRegistry(): void {
  pendingTokens.clear();
  prunedTotal = 0;
  firstPruneAt = null;
  lastPruneAt = null;
  prunedRing.length = 0;
  observedWindowMaxAgeMin = null;
}

/**
 * Deferred tokens that are NOT in `present` (the tick's pool/feed response) —
 * the ones the pool's rotation priority cannot reach. Prepend these to the
 * discovery feed and the coin is re-evaluated on THIS tick instead of on
 * whatever sweep would have come around. Pure, so the selection is testable
 * without the scan.
 */
/**
 * What the discovery feed has actually been returning, and what the make-up
 * did with it — the signal that used to live in `profiles`, and the reason it
 * had to move.
 *
 * `profiles` (the tick's profile-list length, published in /health and in the
 * scan_history row) is the oldest health signal this bot has: 0 means the feed
 * answered with nothing (a 429 backoff, a blocked endpoint, a cold isolate
 * whose first fetch rode its whole budget). The make-up used to be SKIPPED
 * outright whenever the raw feed was empty, purely to keep that `0` readable
 * — which cost the deferred backlog its make-up chance on exactly the ticks a
 * cold isolate serves (live 2026-09-19: 5 of the 7 `profiles 0` ticks in a
 * 118-tick window fell within two minutes of a deploy).
 *
 * Now the make-up injects regardless, and the raw number is kept here: a
 * `rawProfiles: 0` reading is what `profiles` used to say, `emptyFeedTotal`
 * accumulates it fleet-wide (the durable counters answer "how often", which a
 * single isolate's 10-20 minute lifetime cannot), and `injectedTotal` proves
 * the make-up is what pulled the deferred coins back. Published per tick by
 * the worker on the scan summary (see the runOnce wrapper in worker.ts).
 *
 * THE FAILED FETCH IS ITS OWN COUNTER (2026-09-19): the ticks that actually go
 * dark are not the ones the feed answers with nothing — they are the ones the
 * fetch never answers at all. Live: `profiles 0` on 9 of 40 ticks (23%), every
 * feed empty on those ticks, and `noteProfileFeed` never called once — the
 * profiles call had no deadline, so a single 429 started a ~6s retry chain
 * that the scanner's 600ms feed race discarded, make-up list included. The
 * 429 timestamps sit inside those very ticks (13:26:10.250 → the 13:26 tick,
 * 13:31:09.915 → the 13:31 tick). A request that fails or times out is
 * therefore counted as `failedTotal` (with `lastFailedAt`), NOT as an empty
 * feed: "answered with nothing" and "never answered" are different outages,
 * and only the second one used to cost the backlog its lane. The old
 * `profiles: 0` reading is their sum, readable as `rawProfiles 0` plus the two
 * counters.
 */
export interface FeedMakeupView {
  /** Profile requests observed since this isolate booted. */
  feedRequests: number;
  /** Size of the LAST raw feed, before the make-up appended anything. */
  lastRawProfiles: number;
  /** Requests whose raw feed ANSWERED empty (`profiles` used to show this). */
  emptyFeedTotal: number;
  /** When the most recent empty feed was seen. */
  lastEmptyFeedAt: number | null;
  /**
   * Requests whose fetch FAILED or timed out (no answer at all). Counted
   * apart from `emptyFeedTotal` because it is the outage the make-up now
   * survives: the deferred coins below were evaluated on a tick whose feed
   * never arrived.
   */
  failedTotal: number;
  /** When the most recent failed fetch was seen. */
  lastFailedAt: number | null;
  /** Deferred coins the make-up has appended, lifetime. */
  injectedTotal: number;
  /** Coins the LAST feed request appended (0 = nothing was pending). */
  lastInjected: number;
}

let feedView: FeedMakeupView = {
  feedRequests: 0,
  lastRawProfiles: 0,
  emptyFeedTotal: 0,
  lastEmptyFeedAt: null,
  failedTotal: 0,
  lastFailedAt: null,
  injectedTotal: 0,
  lastInjected: 0,
};

/**
 * Record one profile fetch: `raw` is what the endpoint returned (before the
 * make-up), `injected` how many deferred coins were appended to it, and
 * `failed` whether the fetch never answered (see FeedMakeupView).
 */
export function noteProfileFeed(
  raw: number,
  injected: number,
  at: number,
  failed = false,
): void {
  const answeredEmpty = !failed && raw === 0;
  feedView = {
    feedRequests: feedView.feedRequests + 1,
    lastRawProfiles: raw,
    emptyFeedTotal: feedView.emptyFeedTotal + (answeredEmpty ? 1 : 0),
    lastEmptyFeedAt: answeredEmpty ? at : feedView.lastEmptyFeedAt,
    failedTotal: feedView.failedTotal + (failed ? 1 : 0),
    lastFailedAt: failed ? at : feedView.lastFailedAt,
    injectedTotal: feedView.injectedTotal + injected,
    lastInjected: injected,
  };
}

/** This isolate's feed/make-up view (see noteProfileFeed). */
export function feedMakeupView(): FeedMakeupView {
  return { ...feedView };
}

/** Test seam: the view is module state, like the pending registry above. */
export function resetFeedMakeup(): void {
  feedView = {
    feedRequests: 0,
    lastRawProfiles: 0,
    emptyFeedTotal: 0,
    lastEmptyFeedAt: null,
    failedTotal: 0,
    lastFailedAt: null,
    injectedTotal: 0,
    lastInjected: 0,
  };
}

export function missingDeferredTokens(
  present: Iterable<string>,
  max = DEFERRED_MAKEUP_MAX,
): string[] {
  const have = new Set(present);
  const out: string[] = [];
  for (const token of pendingTokens.keys()) {
    if (have.has(token) || out.includes(token)) continue;
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}
