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
 * counters are written in that same invocation immediately AFTER the
 * completion flush has had its turn, as a read-modify-write on one
 * `worker_state` JSON row (the same shape as the `push_audit` delivery ring,
 * race tolerance included), and a tick with nothing new writes nothing: an
 * ordinary minute costs zero extra round trips.
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
    firstDeferredAt: null,
    lastDeferAt: null,
    firstRecoveredAt: null,
    lastRecoveredAt: null,
    events: [],
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
    firstDeferredAt: stamp(rec.firstDeferredAt),
    lastDeferAt: stamp(rec.lastDeferAt),
    firstRecoveredAt: stamp(rec.firstRecoveredAt),
    lastRecoveredAt: stamp(rec.lastRecoveredAt),
    events,
  };
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
): PushDeferralSnapshot {
  const prev = parsePushDeferralSnapshot(raw) ?? emptyPushDeferralSnapshot();
  const deferred = count(delta.deferred);
  const recovered = count(delta.recovered);
  const next: PushDeferralSnapshot = {
    deferredTotal: prev.deferredTotal + deferred,
    recoveredTotal: prev.recoveredTotal + recovered,
    pending: count(delta.pending),
    firstDeferredAt: prev.firstDeferredAt,
    lastDeferAt: prev.lastDeferAt,
    firstRecoveredAt: prev.firstRecoveredAt,
    lastRecoveredAt: prev.lastRecoveredAt,
    events: prev.events.slice(),
  };
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
