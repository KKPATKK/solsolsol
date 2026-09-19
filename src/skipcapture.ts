/**
 * Early-return ("skip") capture for the scan tick (2026-09-19).
 *
 * WHY THIS EXISTS
 * `Scanner.lastSkip` is documented as the answer to "why did the scan return
 * without a summary", surfaced via /health so a silently-skipping scanner is
 * diagnosable without Cloudflare log access. It never reached a reader: three
 * writers record a reason ("previous-scan-still-running", "no-chats-enabled",
 * "empty-feed-and-pool") and runOnce's finally sets the field back to null in
 * the SAME tick, before the worker's completion flush reads it. Live on
 * 2026-09-19 every scan_history row and both heartbeats carried `skip: null` —
 * including the ticks where the sweep had in fact stopped dead (60-100% of
 * ticks per 10 minutes had profiles=0/pool=0), so the only trace was a shape.
 *
 * WHY THE SEAM IS A PROPERTY INTERCEPTOR
 * All three writers and that finally live past the file-sync window in
 * src/scanner.ts (byte offsets ~75k-144k), so they cannot be edited from here.
 * The worker constructs the scanner, so it installs this interceptor right
 * after construction: every NON-NULL assignment is recorded, while the field's
 * get/set behaviour stays exactly what the scanner's own code expects (the
 * getter still returns the live value, the nulling write included), so nothing
 * about the scanner changes.
 *
 * TWO VIEWS, ON PURPOSE
 *   - isolate view (this module): the newest reason plus per-reason counts —
 *     answers "why did the tick I am looking at do nothing".
 *   - durable view (`worker_state` row `skip_capture`, merged by the worker):
 *     the same counters accumulated across isolates — the only way to answer
 *     "how often does the sweep skip, and for which reason", because one
 *     isolate lives ~10-20 minutes (the same reason push_deferral and
 *     push_ledger exist).
 *
 * Freshness is measured, never guessed: a reason carries its own timestamp and
 * the heartbeat it is published with carries the tick's start, so a reader can
 * tell "this reason belongs to the tick being reported" (skipAt >= at) from
 * "stale, from an earlier tick" (skipAt < at) without a flag invented here.
 *
 * A write whose response is lost may add its delta twice: unlike the deferral
 * ledger there is no applied-marker, because these are frequency counters and
 * the marker would cost the same write it protects.
 */

/** `worker_state` row holding the fleet-wide counters (same pattern as push_deferral). */
export const SKIP_CAPTURE_STATE_KEY = "skip_capture";
/**
 * Bounded key set. The reasons are a closed set today, so this only stops a
 * future dynamic string from growing a row that /health reads on every ping.
 */
export const SKIP_CAPTURE_MAX_REASONS = 8;

/** New early returns to add to the durable row (see takeSkipCaptureDelta). */
export interface SkipDelta {
  total: number;
  counts: Record<string, number>;
  reason: string | null;
  at: number | null;
}

/** The durable row: counters across every isolate that has run this code. */
export interface SkipCaptureState {
  total: number;
  firstAt: number;
  lastAt: number;
  counts: Record<string, number>;
  lastReason: string | null;
  lastReasonAt: number | null;
  updatedAt: number;
}

/** The isolate view: what this isolate has seen since it was created. */
export interface SkipCaptureView {
  reason: string;
  at: number;
  total: number;
  counts: Record<string, number>;
}

interface InstalledCapture {
  reason: string | null;
  at: number | null;
  total: number;
  counts: Record<string, number>;
}

let installed: InstalledCapture | null = null;
/** Counters already persisted; the delta is measured against this. */
let synced: { total: number; counts: Record<string, number> } = { total: 0, counts: {} };
let clock: () => number = () => Date.now();

export function emptySkipCaptureState(): SkipCaptureState {
  return {
    total: 0,
    firstAt: 0,
    lastAt: 0,
    counts: {},
    lastReason: null,
    lastReasonAt: null,
    updatedAt: 0,
  };
}

/**
 * Record every reason the scanner writes to `lastSkip`, while leaving the field
 * itself working exactly as before. `now` is injectable so tests do not depend
 * on wall time.
 */
export function installSkipCapture(
  target: { lastSkip: string | null },
  now: () => number = () => Date.now(),
): void {
  clock = now;
  const capture: InstalledCapture = { reason: null, at: null, total: 0, counts: {} };
  installed = capture;
  // A re-created scanner restarts the isolate interval, so the persist baseline
  // must follow it — otherwise every delta would be negative and silent.
  synced = { total: 0, counts: {} };
  let value: string | null = target.lastSkip;
  Object.defineProperty(target, "lastSkip", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next: string | null) => {
      // Only a reason counts: the finally's `= null` is the clear, not a skip.
      if (typeof next === "string" && next.length > 0) {
        capture.reason = next;
        capture.at = clock();
        capture.total += 1;
        capture.counts[next] = (capture.counts[next] ?? 0) + 1;
      }
      value = next;
    },
  });
}

/** Newest reason this isolate recorded, or null when it never recorded one. */
export function skipCaptureSnapshot(): SkipCaptureView | null {
  if (!installed || installed.reason === null || installed.at === null) return null;
  return {
    reason: installed.reason,
    at: installed.at,
    total: installed.total,
    counts: { ...installed.counts },
  };
}

/** Early returns since the last confirmed persist (null = nothing new). */
export function takeSkipCaptureDelta(): SkipDelta | null {
  if (!installed) return null;
  const total = installed.total - synced.total;
  if (total <= 0) return null;
  const counts: Record<string, number> = {};
  for (const [reason, n] of Object.entries(installed.counts)) {
    const d = n - (synced.counts[reason] ?? 0);
    if (d > 0) counts[reason] = d;
  }
  return { total, counts, reason: installed.reason, at: installed.at };
}

/**
 * Advance the persist baseline. Called ONLY after a write landed, so a failed
 * (or wall-clock-killed) write re-offers its delta on the next attempt.
 */
export function markSkipCaptureSynced(): void {
  if (!installed) return;
  synced = { total: installed.total, counts: { ...installed.counts } };
}

/** Tolerant parse: a corrupt or pre-schema row degrades to "nothing yet". */
export function parseSkipCaptureState(raw: string | null | undefined): SkipCaptureState {
  if (!raw) return emptySkipCaptureState();
  try {
    const parsed = JSON.parse(raw) as Partial<SkipCaptureState> | null;
    const counts: Record<string, number> = {};
    const rawCounts = parsed?.counts;
    if (rawCounts && typeof rawCounts === "object" && !Array.isArray(rawCounts)) {
      for (const [reason, n] of Object.entries(rawCounts as Record<string, unknown>)) {
        const v = num(n);
        if (reason && v !== null && v > 0) counts[reason] = v;
      }
    }
    return {
      total: Math.max(0, num(parsed?.total) ?? 0),
      firstAt: num(parsed?.firstAt) ?? 0,
      lastAt: num(parsed?.lastAt) ?? 0,
      counts: pruneSkipCounts(counts),
      lastReason: typeof parsed?.lastReason === "string" ? parsed.lastReason : null,
      lastReasonAt: num(parsed?.lastReasonAt),
      updatedAt: num(parsed?.updatedAt) ?? 0,
    };
  } catch {
    return emptySkipCaptureState();
  }
}

/** Fold one delta into the durable state. `firstAt` is stamped once. */
export function mergeSkipCaptureState(
  prev: SkipCaptureState,
  delta: SkipDelta,
  now: number,
): SkipCaptureState {
  const counts = { ...prev.counts };
  for (const [reason, n] of Object.entries(delta.counts)) {
    counts[reason] = (counts[reason] ?? 0) + n;
  }
  return {
    total: prev.total + delta.total,
    firstAt: prev.firstAt > 0 ? prev.firstAt : now,
    lastAt: now,
    counts: pruneSkipCounts(counts),
    lastReason: delta.reason ?? prev.lastReason,
    lastReasonAt: delta.at ?? prev.lastReasonAt,
    updatedAt: now,
  };
}

/** Keep the highest counts when a bounded key set is exceeded. */
export function pruneSkipCounts(counts: Record<string, number>): Record<string, number> {
  const keys = Object.keys(counts);
  if (keys.length <= SKIP_CAPTURE_MAX_REASONS) return counts;
  const keep = keys
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    .slice(0, SKIP_CAPTURE_MAX_REASONS);
  const out: Record<string, number> = {};
  for (const k of keep) out[k] = counts[k] ?? 0;
  return out;
}

/** Test seam: the capture is per-install module state. */
export function resetSkipCapture(): void {
  installed = null;
  synced = { total: 0, counts: {} };
  clock = () => Date.now();
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
