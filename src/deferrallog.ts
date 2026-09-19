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
 *      counter that outlives the isolate that incremented it).
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
  applied: { owner: string; deferred: number; recovered: number } | null;
}

/** worker_state key holding the snapshot. */
export const PUSH_DEFERRAL_STATE_KEY = "push_deferral";
/**
 * Events kept in the ring. Deferrals are rare by design (a late tick refusing
 * a card), so 60 entries is days-to-weeks of cadence at any plausible rate
 * while keeping the JSON that every /health response carries small.
 */
export const PUSH_DEFERRAL_RING_MAX = 60;
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
      applied = { owner, deferred: count(a.deferred), recovered: count(a.recovered) };
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
        pending: count(ev.pending),
      });
    }
    events.sort((a, b) => a.at - b.at);
  }
  return {
    deferredTotal: count(rec.deferredTotal),
    recoveredTotal: count(rec.recoveredTotal),
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
  totals: { deferred: number; recovered: number },
): boolean {
  const applied = snapshot?.applied;
  if (!applied) return false;
  return (
    applied.owner === owner &&
    applied.deferred === totals.deferred &&
    applied.recovered === totals.recovered
  );
}

/**
 * The snapshot an isolate mirrors for /health: the stored row when there is
 * one, and an all-zero snapshot when there is not. Never null, because the
 * reader has to be able to tell "no card has been deferred yet" (zeros, with
 * `firstDeferredAt: null`) from "the counter channel is missing" — a bare
 * null would read as the latter and hide the moment `deferredTotal` first
 * moves off zero, which is the whole point of the row.
 */
export function loadPushDeferralSnapshot(
  raw: string | null | undefined,
): PushDeferralSnapshot {
  return parsePushDeferralSnapshot(raw) ?? emptyPushDeferralSnapshot();
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
  const deferred = totals.deferred - baseline.deferred;
  const recovered = totals.recovered - baseline.recovered;
  if (deferred <= 0 && recovered <= 0) return null;
  return { deferred: Math.max(0, deferred), recovered: Math.max(0, recovered) };
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
  delta: { deferred: number; recovered: number; pending: number },
  at: number,
  /**
   * The isolate + cumulative totals this delta came from (see `applied`).
   * Optional so a projection can skip the dedupe marker; the production path
   * always passes it.
   */
  appliedBy: { owner: string; deferred: number; recovered: number } | null = null,
  pendingTokens: string[] = [],
): PushDeferralSnapshot {
  const prev = parsePushDeferralSnapshot(raw) ?? emptyPushDeferralSnapshot();
  const deferred = count(delta.deferred);
  const recovered = count(delta.recovered);
  const next: PushDeferralSnapshot = {
    deferredTotal: prev.deferredTotal + deferred,
    recoveredTotal: prev.recoveredTotal + recovered,
    pending: count(delta.pending),
    pendingTokens: pendingTokens.length > 0 ? [...new Set(pendingTokens)].slice(-500) : prev.pendingTokens,
    firstDeferredAt: prev.firstDeferredAt,
    lastDeferAt: prev.lastDeferAt,
    firstRecoveredAt: prev.firstRecoveredAt,
    lastRecoveredAt: prev.lastRecoveredAt,
    events: prev.events.slice(),
    applied: prev.applied,
  };
  if (appliedBy && (deferred > 0 || recovered > 0)) next.applied = appliedBy;
  if (deferred > 0) {
    if (next.firstDeferredAt === null) next.firstDeferredAt = at;
    next.lastDeferAt = at;
  }
  if (recovered > 0) {
    if (next.firstRecoveredAt === null) next.firstRecoveredAt = at;
    next.lastRecoveredAt = at;
  }
  next.events.push({ at, deferred, recovered, pending: next.pending });
  const cutoff = at - PUSH_DEFERRAL_RING_TTL_MS;
  next.events = next.events
    .filter((e) => e.at >= cutoff)
    .slice(-PUSH_DEFERRAL_RING_MAX);
  return next;
}
