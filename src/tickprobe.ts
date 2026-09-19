/*
 * Per-tick probe for the scan (2026-09-19).
 *
 * WHY THIS EXISTS
 * A tick that ends `candidates 1, pushed 0` could not say where its four
 * seconds went. The scanner stamps each phase (markPhase → `pushPhase` /
 * `pushPhaseMs`), but it keeps only the LAST stamp and the completion path
 * overwrites it with `done`, so a deferred card and a delivered card look
 * identical from outside; the chain's own code (markPhase, the claim gate, the
 * send) lives past the file-sync window in src/scanner.ts and cannot be edited
 * from here.
 *
 * WHY A RUNTIME SEAM
 * The worker constructs the scanner and calls it once per tick, and the
 * completion heartbeat publishes `scanner.lastSummary` verbatim. So the probe
 * wraps the two things the worker can reach — the tick entry (`runOnce`) and
 * the phase marker (`markPhase`) — keeps every stamp of the tick instead of
 * just the last, and attaches them to the summary the heartbeat already
 * carries. Nothing about the scanner's own behaviour changes: the wrapper calls
 * the original marker and the original tick in order, and only adds fields.
 *
 * WHAT IT PROVES (live use)
 *   - `summary.phases` = where the tick actually spent its budget, e.g.
 *     `seen@2100, flow@2600, render@3550` — the last stamp before a deferred
 *     card is the chain step that ran out of clock, and its timestamp is the
 *     distance between the chain and the claim window (3550ms at the current
 *     constants, see cardClaimDeadline).
 *   - the callbacks let the worker attach its own per-tick numbers
 *     (`summary.modeRead`, `summary.feedMakeup`) without the heartbeat literal
 *     being editable — see jupiter.ts's prefetchMode and deferredmakeup.ts's
 *     feed view.
 */

/** One phase stamp, tick-relative ms (see Scanner.markPhase). */
export interface TickPhaseStamp {
  phase: string;
  ms: number;
}

/** What the probe collected for the tick that just finished. */
export interface TickProbeView {
  /** Stamps in order, oldest first — the tail is what matters (last 12 kept). */
  phases: TickPhaseStamp[];
  /** Tick-relative ms of the newest stamp (or the tick's own duration). */
  tickMs: number;
}

/**
 * Stamps kept per tick. The chain walks ~11 phases plus the send/tracker ones,
 * and a full walk is exactly the case where nothing needs diagnosing (it
 * finished); the interesting ticks are the ones that stop early, so a ring that
 * keeps the NEWEST stamps is what a reader needs.
 */
export const TICK_PROBE_MAX_PHASES = 12;

/**
 * The seam the probe wraps — satisfied by Scanner without importing it. Only
 * the tick entry is named, and loosely: `Scanner.markPhase` is PRIVATE and
 * `lastSummary` is not part of any exported shape, so a structural type listing
 * them would reject the scanner itself. Both are reached through the cast
 * below, which is the whole point of a runtime seam (see the header).
 */
export interface TickProbeSeam {
  runOnce: () => Promise<unknown>;
}

/** What the cast inside installTickProbe needs from the wrapped object. */
interface TickProbeTarget extends TickProbeSeam {
  markPhase?: (diag: unknown, name: string, startedAt: number) => void;
  lastSummary?: unknown;
}

/** Per-tick hooks for the caller (the worker owns what they attach). */
export interface TickProbeHooks {
  /**
   * Runs at the tick's start, before the scan does any work — the place to kick
   * off anything that must be warm BEFORE the critical tail (the trade-mode
   * prefetch), so the chain's late call does not pay for it.
   */
  onTickStart?: () => void;
  /**
   * Runs after the scan finished, with the summary the completion heartbeat is
   * about to serialize. Attaching to that object is how per-tick telemetry
   * reaches /health.
   */
  onTickEnd?: (summary: unknown) => void;
}

let view: TickProbeView | null = null;
let tickStartedAt = 0;
let stamps: TickPhaseStamp[] = [];

/** The tick that finished most recently, or null before the first one. */
export function tickProbeView(): TickProbeView | null {
  return view ? { phases: view.phases.map((p) => ({ ...p })), tickMs: view.tickMs } : null;
}

/** Test seam: the probe is module state, like the scanner's own mirrors. */
export function resetTickProbe(): void {
  view = null;
  tickStartedAt = 0;
  stamps = [];
}

/**
 * Install the probe on a scanner-shaped target. Idempotent per target: a
 * re-created scanner (the worker's post-dead-tick rebuild) is a new object, and
 * a re-install on one already wrapped would record twice.
 */
export function installTickProbe(
  seam: TickProbeSeam,
  hooks: TickProbeHooks = {},
  now: () => number = () => Date.now(),
): void {
  const target = seam as TickProbeTarget;
  const marker =
    typeof target.markPhase === "function" ? target.markPhase.bind(target) : null;
  const runOnce = target.runOnce.bind(target);
  if (marker !== null) {
    target.markPhase = (diag: unknown, name: string, startedAt: number): void => {
      // The scanner's own stamp first: the probe never changes what the
      // summary reports, it only keeps a copy that is not overwritten.
      marker(diag, name, startedAt);
      const stamp: TickPhaseStamp = { phase: name, ms: now() - tickStartedAt };
      if (stamps.length >= TICK_PROBE_MAX_PHASES) stamps.shift();
      stamps.push(stamp);
    };
  }
  target.runOnce = async (): Promise<unknown> => {
    tickStartedAt = now();
    stamps = [];
    view = null;
    try {
      hooks.onTickStart?.();
    } catch {
      // A prefetch is an optimisation; it may never cost the tick.
    }
    try {
      return await runOnce();
    } finally {
      const captured = stamps;
      view = {
        phases: captured,
        tickMs: captured.length > 0 ? captured[captured.length - 1].ms : now() - tickStartedAt,
      };
      if (marker !== null && captured.length > 0 && target.lastSummary && typeof target.lastSummary === "object") {
        (target.lastSummary as Record<string, unknown>).phases = captured;
      }
      try {
        hooks.onTickEnd?.(target.lastSummary);
      } catch {
        // Telemetry only: a hook that throws must not fail a tick that already
        // delivered (or deferred) its card.
      }
    }
  };
}
