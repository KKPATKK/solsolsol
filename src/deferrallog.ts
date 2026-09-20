/*
 * Cross-isolate deferral counters — the durable half of the scanner's
 * in-memory deferral bookkeeping.
 *
 * WHY THIS EXISTS (the gap it closes): `Scanner.cardSendDeferredTotal` and
 * `DeferredPushLedger.recovered` are per-isolate counters, and the /health
 * summary that publishes them is overwritten by the NEXT tick's summary. So
 * two questions the counters are supposed to answer were unanswerable in
 * practice:
 *
 *   1. "did a deferred card ever get pushed back on a later tick?"
 *      (deferRecovered rising — the live proof of the at-least-once promise);
 *   2. "how often does a tick actually refuse a card?" (a rate needs a
 *      counter that outlives the isolate that incremented it);
 *   3. "a tick found candidates and pushed none — was a card REFUSED, or did
 *      the tick end with the coin still in hand?" Only the claim-stage
 *      refusal had a counter (the scanner's cardSendDeferredTotal); a tick
 *      whose chain hit its deadline broke out of the candidate loop before
 *      the claim stage and left no trace anywhere, so the push gap could
 *      outnumber every recorded deferral (see stalledTotal).
 *
 * Cloudflare recycles isolates within minutes, so the observation window was
 * a lottery: /health could only ever show the counters of whichever isolate
 * happened to answer, and the numbers reset behind it. This module holds the
 * Turso row (`worker_state.push_deferral`) that accumulates them fleet-wide,
 * with the same intent as `db.bumpDex429` for the DexScreener 429 counter —
 * the difference is only WHERE the write happens: a 429 fires off the scan's
 * critical path, so its writer can afford its own read + batch whenever it
 * likes, while a deferral is produced INSIDE the tick that is about to flush
 * — the tick whose tail is already racing Cloudflare's wall clock. So the
 * counters are read and written in that same invocation immediately AFTER the
 * completion flush has had its turn, as a read-modify-write on one
 * `worker_state` JSON row (the same shape as the `push_audit` delivery ring,
 * race tolerance included).
 *
 * The READ runs on every tick; the WRITE only on a tick that deferred a card
 * or paid one back. The read is not optional housekeeping: the totals are
 * published through the heartbeat, and the heartbeat is written by whichever
 * isolate won that tick's lease — so an isolate that reads the row once at
 * boot would keep publishing its pre-write copy after ANOTHER isolate had
 * already added to it, and /health (which serves the last heartbeat written)
 * would show the fleet totals going backwards, or hide the first make-up push
 * behind a stale `null`. One small single-row read per tick, spent after the
 * flush has landed, is the price of a copy that is never older than a tick.
 *
 * The stored shape is deliberately lossless for the two questions above:
 * monotonic totals (they survive the isolate that produced them), the FIRST
 * and LAST timestamp of each event kind (so "the first rise" is readable
 * after the fact instead of requiring someone to be watching when it
 * happened), and a small ring of recent events so a RATE is readable
 * directly from /health.heartbeat.deferral instead of only a lifetime
 * average.
 */

/** One recorded event batch: a tick's refusals and the make-ups it paid back. */
export interface PushDeferralEvent {
  /** ms epoch of the tick that reported it. */
  at: number;
  /** Initial cards that tick refused to start (see cardSendDeadline). */
  deferred: number;
  /** Deferred coins that tick pushed back — the at-least-once proof. */
  recovered: number;
  /**
   * Candidates that tick held and delivered no card for WITHOUT refusing one a
   * claim slice (`stalled`, see the snapshot's `stalledTotal`). The companion
   * count for the shape `cardSendDeferred` cannot see.
   */
  stalled: number;
  /** Coins still waiting for a make-up push, as that tick left them (gauge). */
  pending: number;
}

/** The durable `worker_state.push_deferral` row. */
export interface PushDeferralSnapshot {
  /** Deferrals since this row was first created — never decreases. */
  deferredTotal: number;
  /** Make-up pushes since this row was first created — never decreases. */
  recoveredTotal: number;
  /** Backlog the newest event left behind. */
  pending: number;
  /**
   * Candidate coins a tick ended WITHOUT delivering a card for and without
   * refusing one a claim slice.
   *
   * The other half of the "candidates found, nothing pushed" gap. A tick can
   * leave a qualifying coin in hand in two ways, and only the first had a
   * counter: the claim stage refuses the card when no send slice is left
   * (`deferred`, see cardSendDeadline), while the CHAIN stage breaks out of
   * the candidate loop before it ever gets there (`chain deadline reached —
   * deferring N candidate(s) to next tick`) and wrote nothing at all — so a
   * quiet-market stretch of `candidates 1, pushed 0` ticks could outnumber the
   * recorded deferrals indefinitely and read as if nothing was wrong (live
   * 2026-09-19: 33 of 118 ticks, against 5-6 recorded deferrals per hour).
   *
   * Deliberately NOT attributed to the chain by name: the summary cannot
   * separate a chain-deadline break from a candidate every enabled chat had
   * already received (the chain's seen-check skips it with no counter) or a
   * send that failed (recorded separately as a push failure). What it CAN say
   * exactly is that a qualifying coin was in hand and no card went out — and
   * with `deferred` beside it the gap stops being silent: the two counters
   * together account for (candidates − pushed) of every tick that reached the
   * push stage.
   */
  stalledTotal: number;
  /** When the first held-back candidate was recorded (null until one happens). */
  firstStallAt: number | null;
  /** When the most recent one was recorded. */
  lastStallAt: number | null;
  /**
   * Token identities still awaiting a make-up push. Bounded with the same
   * cap as the in-memory ledger so a recycled isolate can hydrate the actual
   * obligations, not just their aggregate count.
   */
  pendingTokens: string[];
  /** When the first deferral ever was recorded (null until one happens). */
  firstDeferredAt: number | null;
  /** When the most recent deferral was recorded. */
  lastDeferAt: number | null;
  /**
   * When the FIRST deferred coin was actually pushed back. This is the
   * field to watch for the "deferRecovered 第一次上升" milestone: it is
   * stamped once and never moves, so the milestone is provable afterwards.
   */
  firstRecoveredAt: number | null;
  /** When the most recent make-up push happened. */
  lastRecoveredAt: number | null;
  /** Newest-last ring of recent events (see PUSH_DEFERRAL_RING_MAX). */
  events: PushDeferralEvent[];
  /**
   * Which isolate's totals were folded in last (`applied`), as the write's
   * identity. The write is a read-modify-write from after the completion
   * flush, so a first attempt can COMMIT and still look failed to its caller
   * — the hard wall aborts the awaiting promise, the invocation is killed, or
   * the response is lost — and a blind retry would then add the same delta
   * twice. Recording the exact (isolate, totals) pair already in the row lets
   * the next attempt recognise "this is already mine" and ACK instead of
   * adding again. Keyed by owner because two isolates can legitimately carry
   * the same counters (both fresh, both at 1) while owning different deltas.
   */
  applied: {
    owner: string;
    deferred: number;
    recovered: number;
    stalled: number;
  } | null;
}

/** worker_state key holding the snapshot. */
export const PUSH_DEFERRAL_STATE_KEY = "push_deferral";
/**
 * Events kept in the ring. Deferrals are rare by design (a late tick refusing
 * a card), so a dozen entries is still days of cadence at any plausible rate,
 * and the ring is ONLY the rate window: `deferredTotal`/`recoveredTotal`/
 * `stalledTotal`, `pending`/`pendingTokens` and the first/last stamps all
 * survive pruning (see nextPushDeferralSnapshot).
 *
 * 2026-09-20: 60 → 12. Measured: the snapshot serializes to 4.3KB at the 60
 * cap — 35% of the 12.4KB completion batch the tick writes twice (claim +
 * flush). That batch has a fixed ~4.5s window inside a tick the cron
 * invocation kills at ~9.6s, so bytes are the one thing still buyable there,
 * and a 60-event ring was never read for anything but cadence.
 */
export const PUSH_DEFERRAL_RING_MAX = 12;
/**
 * Events older than this are dropped from the ring even when it is not full —
 * a burst month ago must not be reported as if it were current cadence. The
 * totals and the first/last stamps survive pruning: only the RATE window is
 * bounded.
 */
export const PUSH_DEFERRAL_RING_TTL_MS = 7 * 24 * 3600_000;

/** A snapshot with no events yet — the state of a fresh database. */
function emptyPushDeferralSnapshot(): PushDeferralSnapshot {
  return {
    deferredTotal: 0,
    recoveredTotal: 0,
    stalledTotal: 0,
    firstStallAt: null,
    lastStallAt: null,
    pending: 0,
    pendingTokens: [],
    firstDeferredAt: null,
    lastDeferAt: null,
    firstRecoveredAt: null,
    lastRecoveredAt: null,
    events: [],
    applied: null,
  };
}

/** Non-negative finite integer, else 0 — the row is telemetry, never a crash. */
function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** ms epoch or null. */
function stamp(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Defensive read of the stored row: a worker_state value written by an older
 * build (or a hand-edited one) must degrade to a usable snapshot, never
 * throw on the flush path. Returns null when there is nothing to parse, so
 * the caller can tell "no row yet" from "an empty snapshot".
 */
export function parsePushDeferralSnapshot(
  raw: string | null | undefined,
): PushDeferralSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  let applied: PushDeferralSnapshot["applied"] = null;
  if (rec.applied && typeof rec.applied === "object") {
    const a = rec.applied as Record<string, unknown>;
    const owner = typeof a.owner === "string" ? a.owner : "";
    if (owner.length > 0) {
      applied = {
        owner,
        deferred: count(a.deferred),
        recovered: count(a.recovered),
        // A row written before the stalled counter existed reads as 0 — which
        // can only ever make a re-offered delta look un-applied once, never
        // silently swallow one.
        stalled: count(a.stalled),
      };
    }
  }
  const pendingTokens = Array.isArray(rec.pendingTokens)
    ? rec.pendingTokens
        .filter((token): token is string => typeof token === "string" && token.length > 0)
        .slice(-500)
    : [];
  const events: PushDeferralEvent[] = [];
  if (Array.isArray(rec.events)) {
    for (const e of rec.events) {
      if (!e || typeof e !== "object") continue;
      const ev = e as Record<string, unknown>;
      const at = stamp(ev.at);
      if (at === null) continue;
      events.push({
        at,
        deferred: count(ev.deferred),
        recovered: count(ev.recovered),
        stalled: count(ev.stalled),
        pending: count(ev.pending),
      });
    }
    events.sort((a, b) => a.at - b.at);
    // The same cap the WRITER applies, enforced on the read side too. The row
    // only gets rewritten when a deferral/recovery/stall happens, and deferrals
    // are rare by design — so a row written before the cap was lowered (or by
    // an older build) would otherwise keep its full ring in every heartbeat
    // this isolate mirrors. Measured exactly that on the first ticks after the
    // 60 → 12 cut: `deferral.events.length` stayed 60 (4.9KB of the payload)
    // until the next deferral happened to rewrite the row.
    if (events.length > PUSH_DEFERRAL_RING_MAX) {
      events.splice(0, events.length - PUSH_DEFERRAL_RING_MAX);
    }
  }
  return {
    deferredTotal: count(rec.deferredTotal),
    recoveredTotal: count(rec.recoveredTotal),
    stalledTotal: count(rec.stalledTotal),
    firstStallAt: stamp(rec.firstStallAt),
    lastStallAt: stamp(rec.lastStallAt),
    pending: count(rec.pending),
    pendingTokens,
    firstDeferredAt: stamp(rec.firstDeferredAt),
    lastDeferAt: stamp(rec.lastDeferAt),
    firstRecoveredAt: stamp(rec.firstRecoveredAt),
    lastRecoveredAt: stamp(rec.lastRecoveredAt),
    events,
    applied,
  };
}

/**
 * Whether this isolate's current totals are ALREADY folded into the stored
 * row — i.e. an earlier attempt of this very write committed while its
 * response was lost. The caller ACKs (advances its baseline and mirrors the
 * row) instead of adding the delta a second time.
 */
export function pushDeferralAlreadyApplied(
  snapshot: PushDeferralSnapshot | null,
  owner: string,
  totals: { deferred: number; recovered: number; stalled: number },
): boolean {
  const applied = snapshot?.applied;
  if (!applied) return false;
  return (
    applied.owner === owner &&
    applied.deferred === totals.deferred &&
    applied.recovered === totals.recovered &&
    applied.stalled === totals.stalled
  );
}

/**
 * The snapshot an isolate mirrors for /health: the stored row when there is
 * one, and an all-zero snapshot when there is not. Never null, because the
 * reader has to be able to tell "no card has been deferred yet" (zeros, with
 * `firstDeferredAt: null`) from "the counter channel is missing" — a bare
 * null would read as the latter and hide the moment `deferredTotal` first
 * moves off zero, which is the whole point of the row.
 *
 * The mirrored gauge is DERIVED from the list, for the same reason the write
 * derives it (see nextPushDeferralSnapshot): a row written by a build that
 * still published the caller's scan-time count can carry `pending: 7` beside
 * five tokens, and this function is the only thing that turns such a row into
 * a heartbeat — the mirror would then republish the disagreement on every
 * tick that has no delta of its own to write, i.e. indefinitely. Live
 * 2026-09-20 02:44Z: exactly that pair was still being served two minutes
 * after the write-side fix deployed, because the last write predated it.
 * The stored field is left as it is (this is a read), so nothing else
 * depends on the mirrored number being the stored one.
 */
export function loadPushDeferralSnapshot(
  raw: string | null | undefined,
): PushDeferralSnapshot {
  const parsed = parsePushDeferralSnapshot(raw) ?? emptyPushDeferralSnapshot();
  return { ...parsed, pending: parsed.pendingTokens.length };
}

/**
 * The delta a completion flush should persist: this isolate's cumulative
 * totals minus the totals the last CONFIRMED write recorded. Null when there
 * is nothing new — which is also what keeps a rebuilt scanner, whose counters
 * restart at zero and so sit BELOW the baseline, from ever writing a negative
 * delta.
 *
 * The caller owns the baseline and advances it only after the write landed,
 * so the pair ("compute here", "advance there") is what makes a failed write
 * re-offer its delta next tick instead of dropping it, without ever adding it
 * twice.
 */
export function pushDeferralDelta(
  baseline: { deferred: number; recovered: number },
  totals: { deferred: number; recovered: number },
): { deferred: number; recovered: number } | null {
  const deferred = count(totals.deferred) - count(baseline.deferred);
  const recovered = count(totals.recovered) - count(baseline.recovered);
  if (deferred <= 0 && recovered <= 0) return null;
  return { deferred: Math.max(0, deferred), recovered: Math.max(0, recovered) };
}

/**
 * Qualifying coins a COMPLETED tick left in hand without delivering a card for
 * them — the amount `stalledTotal` accumulates, derived from what a
 * scan summary carries.
 *
 * WHY DERIVED rather than counted where it happens: the chain stage breaks out
 * of the candidate loop on its own deadline (`chain deadline reached —
 * deferring N candidate(s) to next tick`, src/scanner.ts) BEFORE the claim
 * stage is ever reached, and that break records nothing anywhere — so a quiet
 * stretch of `candidates 1, pushed 0` ticks could outnumber the recorded
 * deferrals indefinitely while /health showed no sign of it (live 2026-09-19:
 * 33 of 118 ticks against 5-6 deferrals/hour). The identity used here — coins
 * in hand, no card out, MINUS the ones the tick explicitly refused a claim
 * slice (those are already in `deferred`) — is exactly the remainder that had
 * no home before.
 *
 * A LOWER BOUND on chain-stage deferrals, not an exact count: a candidate the
 * chain did reach but skipped because every enabled chat already had the coin
 * (the per-chat seen-check) was also "in hand, nothing delivered", and the
 * summary cannot tell that case apart from a chain break. What it can say
 * exactly is that the tick ended with a qualifying coin and no card for it.
 *
 * `pushPhase === "done"` is the completion test: a tick the worker's race cut
 * short publishes its INFLIGHT summary with pushPhase still on the step it
 * died in (send:claim, tracker, …), and a tick that never scanned has no
 * summary at all — both are already reported by the dead-tick bookkeeping and
 * must not be re-counted here; a completed tick's summary is stamped `done`
 * with candidates and pushed final.
 */
/**
 * Delivery kinds that prove a coin's card was ACCEPTED BY TELEGRAM.
 *
 * `initial` is written by the scanner only after the send returned a
 * message_id, `resend` by the tracker's heal re-send under the same condition,
 * and `pushed-row` is synthesized from a `push_watch` row (written right after
 * a successful push) — all three are therefore hard evidence that a card for
 * that token reached the chat. `followup` and `heal-current` are NOT: they are about the
 * tracker's own rows and a healed baseline, so they say nothing about whether
 * the deferred INITIAL card was ever delivered. Keeping the list this narrow is
 * what makes the guard below safe — it may only ever forget an obligation a
 * delivery already discharged, never one the user is still owed.
 */
const DELIVERED_CARD_KINDS: ReadonlySet<string> = new Set([
  "initial",
  "resend",
  // Synthesized by the worker from the `push_watch` listing: PushWatcher.onPush
  // writes a row right AFTER a successful push, so a row is proof a card for
  // that token was delivered, and one is never written for a coin that was only
  // deferred. This is the durable half a `resend`-only delivery would otherwise
  // lose: the audit ring rolls such an entry out of its window within minutes,
  // and the push ledger records `initial` provenance only.
  "pushed-row",
]);

/**
 * Deferred obligations the delivery audit ring proves were ALREADY DELIVERED
 * (2026-09-20 duplicate fix).
 *
 * The shape it fixes: the durable pending list and the push itself are written
 * by the SAME completion flush. When that flush is lost (the dead-tick shape
 * this ledger documents), the push landed but the removal did not, so the coin
 * stays "owed" and the next tick's make-up pass pushes the same card a second
 * time — live 2026-09-20 00:47Z: GROYPER got its card, then a second one two
 * minutes later, and the audit ring carries `initial` entries for 4 of the 8
 * tokens still listed as pending.
 *
 * So: a pending token with a delivered-card audit entry is no longer owed, and
 * forgetting it can only REMOVE a duplicate — a token whose card never reached
 * the chat has no such entry and stays pending, exactly as it must. Coverage is
 * the audit ring's (~30 deliveries, ~6h), which is many times the window a
 * duplicate appears in (the next tick, seconds to a minute later).
 *
 * Pure and exported: the wiring is a durable read plus a registry drop, both of
 * which live in code the offline harness cannot drive (worker + scanner), so
 * the RULE is what the unit tests pin.
 */
export function deliveredDeferredTokens(
  pending: readonly string[],
  audit: ReadonlyArray<{ token?: string | null; kind?: string | null }>,
): string[] {
  if (pending.length === 0 || audit.length === 0) return [];
  const delivered = new Set(deliveredCardTokens(audit));
  if (delivered.size === 0) return [];
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const token of pending) {
    if (typeof token !== "string" || !delivered.has(token) || seen.has(token)) continue;
    seen.add(token);
    stale.push(token);
  }
  return stale;
}

/**
 * Tokens the audit ring proves had A CARD DELIVERED (any kind in
 * DELIVERED_CARD_KINDS), in first-seen order.
 *
 * One rule, two callers: the deferral guard below asks it of the pending list,
 * and the tracker's self-heal asks it of a claimed-but-untracked coin before
 * re-sending a first card (src/pushwatch.ts). The heal's gate used to ask the
 * narrower question — "was an INITIAL card delivered?" — and that is exactly
 * how one duplicate became five: a card cut by the send deadline is delivered
 * with NO audit entry at all, and the 補發 card it then sent writes the only
 * entry the token ever gets, kind `resend`. Because that kind was invisible to
 * the gate, the next heal pass still read "never delivered" and sent another
 * 補發 — live 2026-09-20: the operator reports "a push, then a 補發 card", then
 * four more of the same coin inside eleven minutes (PONDER, 10:48-11:08 HKT),
 * and the ring shows the `resend` rows (GROYPER 00:49Z, JEV, STACK, MEMEMAN).
 * Asking the wider question closes the loop after exactly ONE 補發 per token per
 * ring window, and cannot hide anything: every kind here is written only after
 * Telegram accepted a card, and a token with no entry at all still gets its
 * 補發 on this pass exactly as before.
 *
 * Pure and exported: both callers are durable-read + network code the offline
 * harness cannot drive, so the RULE is what the tests pin.
 */
export function deliveredCardTokens(
  audit: ReadonlyArray<{ token?: string | null; kind?: string | null }>,
): string[] {
  if (audit.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of audit) {
    const token = entry?.token;
    if (typeof token !== "string" || token.length === 0) continue;
    if (typeof entry.kind !== "string" || !DELIVERED_CARD_KINDS.has(entry.kind)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Tokens the delivery audit shows Telegram accepted as a FRESH card more than
 * once — the duplicate the operator reports by hand (2026-09-20: "PONDER
 * 10:48, then 10:57, 11:01, 11:03, 11:08" HKT).
 *
 * Only `initial` counts. `resend`/`followup`/`heal-current` are the tracker
 * repairing its own rows and are expected to repeat, and `pushed-row` is a
 * synthesized proof with no kind of its own; a second `initial` for one token
 * means the coin was pushed as a fresh discovery twice, which is exactly the
 * duplicate the user sees. Nothing here is used to suppress anything — the one
 * thing that may drop an obligation is deliveredDeferredTokens above, and only
 * on hard proof — so this can never hide a card the user is still owed.
 *
 * The result is a WINDOW, not a lifetime total: the ring holds ~30 deliveries
 * (~6h at the live push rate), so it decays on its own and answers "how many
 * duplicates are visible right now?" — which is the acceptance measure for the
 * scanner-side send fix (docs/scan-completion-loss.md) either way, and the way
 * to tell that generator from the lost-completion-write one this file's guard
 * already covers.
 *
 * Pure and exported: the read that feeds it happens in the worker's tick tail,
 * which the offline harness cannot drive, so the RULE is what the tests pin.
 */
export function duplicateInitialTokens(
  audit: ReadonlyArray<{ token?: string | null; kind?: string | null }>,
): string[] {
  if (audit.length === 0) return [];
  const counts = new Map<string, number>();
  for (const entry of audit) {
    const token = entry?.token;
    if (typeof token !== "string" || token.length === 0) continue;
    if (entry.kind !== "initial") continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [token, count] of counts) {
    if (count > 1) out.push(token);
  }
  return out;
}

/**
 * Durable ledger of card sends whose DELIVERY IS UNKNOWN — the third state of
 * the three-state send (2026-09-20, see docs/scan-completion-loss.md § "(A) cut
 * → unclaim → re-eval 重推").
 *
 * WHY (the duplicate it removes): the send was two-state —
 * `bestEffort(send, deadline, null)` returned either Telegram's message or
 * `null`, and `null` was read as "not delivered". It is not: the race stops
 * WAITING, never the request. So a card that was already on its way to Telegram
 * was treated as failed, the `seen_tokens` claim was deleted, and the next
 * tick's re-eval pool pushed the same coin again — the operator's "推送之後又
 * 收到同一隻幣" report (live 2026-09-20 10:48–11:08 HKT, PONDER five times).
 *
 * With a third state, an abandoned send KEEPS its claim — the claim is the only
 * thing that stops the re-push — and records itself here. This ledger settles
 * that record in exactly one of two directions:
 *
 *   * PROVEN delivered (a DELIVERED_CARD_KINDS proof exists in the audit ring,
 *     which is what the worker's reconcile reads) → drop the record, keep the
 *     claim. The card reached the chat, so the coin must NOT be pushed again.
 *   * PROVEN undelivered (grace elapsed, no proof anywhere) → RELEASE the claim
 *     so a later scan re-pushes the coin. At most one duplicate, two minutes
 *     late. Fail-open on purpose: "一定不能漏推" is the hard rule, and the two
 *     costs are not symmetric (a missing card is a lost trade, a duplicate is
 *     noise).
 *
 * The record is DURABLE because the isolate that started the send is exactly
 * what may not survive to settle it — an abandoned send means the tick ran out
 * of room, which is one step from the wall-clock kill the sibling docs in
 * docs/scan-completion-loss.md describe.
 *
 * Pure and exported: the durable read/write and the unclaim live in worker code
 * the offline harness cannot drive, so the RULES are what the tests pin.
 */
export const UNCONFIRMED_CARD_STATE_KEY = "unconfirmed_card_sends";

/**
 * Ring cap. A cut is rare once the reserve gives the send a real slice, so more
 * than a couple of records at once means something else is wrong; 12 keeps the
 * row a sub-2KB write on a tick tail that is racing the wall clock.
 */
export const UNCONFIRMED_CARD_MAX = 12;

/**
 * How long a record may stay unconfirmed before its claim is released. Two cron
 * cadences: a send that is going to settle at all does so in about a second
 * (the background chain writes its own `initial` audit entry), so a record that
 * is still unproven after two minutes means the sending isolate died between
 * the send and the audit — the card may or may not have arrived, and re-pushing
 * is the never-miss choice.
 */
export const UNCONFIRMED_CARD_GRACE_MS = 120_000;

/** One abandoned send awaiting proof, keyed by (chatId, token). */
export interface UnconfirmedCardSend {
  chatId: string;
  token: string;
  /** ms epoch the abandoned send started — the grace clock. */
  at: number;
  symbol: string | null;
}

function unconfirmedRecord(v: unknown): UnconfirmedCardSend | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const chatId = typeof o.chatId === "string" ? o.chatId : "";
  const token = typeof o.token === "string" ? o.token : "";
  const at = stamp(o.at) ?? 0;
  if (chatId.length === 0 || token.length === 0 || at <= 0) return null;
  const symbol = typeof o.symbol === "string" && o.symbol.length > 0 ? o.symbol : null;
  return { chatId, token, at, symbol };
}

/**
 * Read side, tolerant like every other row in this module: garbage, a missing
 * row or a round-tripped value degrades to "nothing unconfirmed", which is the
 * pre-three-state behaviour. Newest kept when the ring overflowed.
 */
export function parseUnconfirmedCardSends(
  raw: string | null | undefined,
): UnconfirmedCardSend[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: UnconfirmedCardSend[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const entry = unconfirmedRecord(item);
      if (!entry) continue;
      const key = `${entry.chatId}:${entry.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out.slice(-UNCONFIRMED_CARD_MAX);
  } catch {
    return [];
  }
}

/** Serialize the ring, capped — the only writer shape the row accepts. */
export function serializeUnconfirmedCardSends(
  list: readonly UnconfirmedCardSend[],
  max: number = UNCONFIRMED_CARD_MAX,
): string {
  return JSON.stringify(list.slice(-Math.max(1, max)));
}

/**
 * Add (or refresh) one record. Re-recording the same (chatId, token) keeps ONE
 * entry with the NEWER timestamp, so a coin abandoned twice cannot leave two
 * records that would release the same claim twice.
 */
export function addUnconfirmedCardSend(
  raw: string | null | undefined,
  entry: { chatId: string; token: string; at: number; symbol?: string | null },
  max: number = UNCONFIRMED_CARD_MAX,
): string {
  const next = parseUnconfirmedCardSends(raw).filter(
    (e) => !(e.chatId === entry.chatId && e.token === entry.token),
  );
  next.push({
    chatId: entry.chatId,
    token: entry.token,
    at: entry.at,
    symbol: entry.symbol ?? null,
  });
  return serializeUnconfirmedCardSends(next, max);
}

/**
 * Drop the record for one (chatId, token) — the background chain's own settle:
 * a send that is CONFIRMED (audit written) or CONFIRMED failed (record cleared
 * and the claim released right there) must not be settled a second time by the
 * worker's reconcile.
 */
export function removeUnconfirmedCardSend(
  raw: string | null | undefined,
  chatId: string,
  token: string,
): string {
  return serializeUnconfirmedCardSends(
    parseUnconfirmedCardSends(raw).filter(
      (e) => !(e.chatId === chatId && e.token === token),
    ),
  );
}

/**
 * Split the ring into what the caller must do next. Pure: the caller owns the
 * durable write and the unclaim, this owns the RULE.
 *
 * Order matters to the caller: persist `kept` BEFORE unclaiming anything. A
 * record that survives a crash after the claim was released would release the
 * claim a second time — and if the coin had been re-pushed and re-claimed in
 * between, that second release would delete a NEW claim and put a third card in
 * flight. Writing the shrink first makes the release at-most-once.
 */
export function settleUnconfirmedCardSends(
  records: readonly UnconfirmedCardSend[],
  now: number,
  graceMs: number,
  proven: ReadonlySet<string>,
): {
  confirmed: UnconfirmedCardSend[];
  release: UnconfirmedCardSend[];
  kept: UnconfirmedCardSend[];
} {
  const confirmed: UnconfirmedCardSend[] = [];
  const release: UnconfirmedCardSend[] = [];
  const kept: UnconfirmedCardSend[] = [];
  for (const r of records) {
    if (proven.has(r.token)) {
      confirmed.push(r);
      continue;
    }
    if (now - r.at >= graceMs) {
      release.push(r);
      continue;
    }
    kept.push(r);
  }
  return { confirmed, release, kept };
}

/** The three outcomes of one card send (see the ledger above). */
export type CardSendOutcome = "sent" | "failed" | "abandoned";

/** What the send path must do for one outcome. */
export interface CardSendDisposition {
  /** Write the delivery audit — hard proof Telegram accepted the card. */
  audit: boolean;
  /** Delete the seen_tokens claim so a later scan re-pushes the coin. */
  releaseClaim: boolean;
  /** Keep the claim and settle the in-flight request in the background. */
  watchInBackground: boolean;
  /** Write the durable unconfirmed record the reconcile settles. */
  recordUnconfirmed: boolean;
  /** Surface a delivery failure to the caller (its retry / failure record). */
  throwFailure: boolean;
}

/**
 * The never-miss rule, as one pure function: Telegram ACCEPTED the card (audit
 * it), Telegram REJECTED it (release the claim, surface the failure, the coin is
 * re-pushed by a later tick), or we STOPPED WAITING (keep the claim, record it,
 * watch it to a conclusion in the background).
 *
 * `abandoned` deliberately neither audits (nothing was confirmed) nor releases
 * (the card may already be in the chat, and releasing is what re-pushes it).
 * That asymmetry is the whole fix: the old two-state send mapped "abandoned"
 * onto "failed", which is the duplicate generator the operator reported.
 */
export function cardSendDisposition(outcome: CardSendOutcome): CardSendDisposition {
  switch (outcome) {
    case "sent":
      return {
        audit: true,
        releaseClaim: false,
        watchInBackground: false,
        recordUnconfirmed: false,
        throwFailure: false,
      };
    case "failed":
      return {
        audit: false,
        releaseClaim: true,
        watchInBackground: false,
        recordUnconfirmed: false,
        throwFailure: true,
      };
    case "abandoned":
    default:
      return {
        audit: false,
        releaseClaim: false,
        watchInBackground: true,
        recordUnconfirmed: true,
        throwFailure: false,
      };
  }
}

export function heldBackCandidates(
  summary: {
    pushPhase?: string;
    candidates?: number;
    pushed?: number;
    cardSendDeferred?: number;
  } | null,
): number {
  if (!summary || summary.pushPhase !== "done") return 0;
  return Math.max(
    0,
    count(summary.candidates) - count(summary.pushed) - count(summary.cardSendDeferred),
  );
}

/**
 * Fold one tick's delta into the stored snapshot. Pure, and idempotent only
 * in the sense the caller needs: the caller re-offers the SAME delta after a
 * failed write (its baseline only advances once the write lands), and adding
 * a delta twice would double-count — which is why the baseline lives with
 * the caller and the write is the one that advances it, never this function.
 *
 * `raw` is the value read from Turso; null/unparseable starts a fresh
 * snapshot (totals restart, which is the honest reading of a lost row —
 * `firstRecoveredAt` being re-stamped is the one visible cost, so the row is
 * never deleted by pruning).
 */
export function nextPushDeferralSnapshot(
  raw: string | null | undefined,
  delta: { deferred: number; recovered: number; stalled: number; pending: number },
  at: number,
  /**
   * The isolate + cumulative totals this delta came from (see `applied`).
   * Optional so a projection can skip the dedupe marker; the production path
   * always passes it.
   */
  appliedBy: {
    owner: string;
    deferred: number;
    recovered: number;
    stalled: number;
  } | null = null,
  /**
   * The tokens this isolate holds as owed. Passing it makes the pending list
   * AND — by construction — the gauge `pending` above come from the same
   * array, so the two cannot drift apart (see the derivation below). Omit it
   * only in a projection that genuinely has no list to offer; then the
   * legacy `delta.pending` stands as the gauge.
   */
  pendingTokens?: readonly string[],
): PushDeferralSnapshot {
  const prev = parsePushDeferralSnapshot(raw) ?? emptyPushDeferralSnapshot();
  const deferred = count(delta.deferred);
  const recovered = count(delta.recovered);
  const stalled = count(delta.stalled);
  // The backlog gauge and the token list are ONE fact: the gauge is the length
  // of the list this very snapshot carries, so /health can never publish a
  // backlog that disagrees with the tokens it is listing.
  //
  // That disagreement was live (2026-09-20): `pending` read 7 next to a
  // 5-token list for a whole tick and on every heartbeat after it, because the
  // gauge came from the caller's scan-time count (`summary.deferPending`, taken
  // before the duplicate guard trimmed the list) while the list came from the
  // post-guard registry. Deriving it here means the two can only ever be one
  // number, whatever the caller's counters say.
  //
  // A list is OPTIONAL, and the two absences mean different things:
  //   * no list at all (legacy callers, projections) → `delta.pending` stands
  //     as the gauge, exactly as before;
  //   * an empty list from a caller that DID read its store → nothing is owed.
  //     It still does not wipe `pendingTokens`: an isolate whose scanner is not
  //     ready yet holds no registry but must not erase obligations it simply
  //     has not read. The gauge then follows the list that is kept, which keeps
  //     the invariant (gauge === list length) true in every branch.
  const hasList = pendingTokens !== undefined;
  const catalogued =
    hasList && pendingTokens.length > 0
      ? [...new Set(pendingTokens)].slice(-500)
      : prev.pendingTokens;
  const next: PushDeferralSnapshot = {
    deferredTotal: prev.deferredTotal + deferred,
    recoveredTotal: prev.recoveredTotal + recovered,
    stalledTotal: prev.stalledTotal + stalled,
    firstStallAt: prev.firstStallAt,
    lastStallAt: prev.lastStallAt,
    pending: hasList ? catalogued.length : count(delta.pending),
    pendingTokens: catalogued,
    firstDeferredAt: prev.firstDeferredAt,
    lastDeferAt: prev.lastDeferAt,
    firstRecoveredAt: prev.firstRecoveredAt,
    lastRecoveredAt: prev.lastRecoveredAt,
    events: prev.events.slice(),
    applied: prev.applied,
  };
  if (appliedBy && (deferred > 0 || recovered > 0 || stalled > 0)) {
    next.applied = appliedBy;
  }
  if (deferred > 0) {
    if (next.firstDeferredAt === null) next.firstDeferredAt = at;
    next.lastDeferAt = at;
  }
  if (recovered > 0) {
    if (next.firstRecoveredAt === null) next.firstRecoveredAt = at;
    next.lastRecoveredAt = at;
  }
  if (stalled > 0) {
    if (next.firstStallAt === null) next.firstStallAt = at;
    next.lastStallAt = at;
  }
  next.events.push({ at, deferred, recovered, stalled, pending: next.pending });
  const cutoff = at - PUSH_DEFERRAL_RING_TTL_MS;
  next.events = next.events
    .filter((e) => e.at >= cutoff)
    .slice(-PUSH_DEFERRAL_RING_MAX);
  return next;
}
