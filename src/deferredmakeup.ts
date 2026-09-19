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
