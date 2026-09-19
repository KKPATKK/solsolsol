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

/** token → when it was first deferred (Map iteration order = oldest first). */
const pendingTokens = new Map<string, number>();

/**
 * Record that `token` was refused a card. Idempotent per token, so the many
 * ticks that re-evaluate a still-deferred coin while it is pending do not
 * extend the backlog or move it in the queue.
 */
export function addDeferredToken(
  token: string,
  at: number,
  maxEntries = DEFERRED_REGISTRY_MAX,
): void {
  if (token.length === 0 || pendingTokens.has(token)) return;
  pendingTokens.set(token, at);
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
