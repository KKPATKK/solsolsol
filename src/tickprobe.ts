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
 * wraps the things the worker can reach — the tick entry (`runOnce`), the phase
 * marker (`markPhase`) and the DB handle (`db`) — keeps every stamp of the tick
 * instead of just the last, and attaches its measurements to the summary the
 * heartbeat already carries. Nothing about the scanner's own behaviour
 * changes: the wrapper calls the original marker / method / tick in order, and
 * only adds fields.
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
 *
 * WHY THE DB SEAM (2026-09-19, later)
 * The front phase's cost is not the pair fetch: live after the 1250→1000ms cut
 * the eval phase was STILL 2.0-3.7s, and the tick kept arriving at the claim
 * (boundary 3550ms) just too late. The remaining steps between the pair fetch
 * and the candidate chain are DB round trips the gates do not read:
 * `recordTokenStatsMany` (registration) and `updateTokenMaxMcaps` (raise-only
 * bookkeeping). Both are pure persistence for the tick — the scanner's own
 * maps already hold the data the gates read, and its comment on the
 * registration explicitly accepts a lost tick ("the feed re-registers the coin
 * next tick"). So the probe TIMES them always, and can DEFER them: the scanner
 * is handed an already-resolved promise, the real call is queued FIFO, and the
 * worker drains the queue AFTER its completion flush (see the worker's
 * `drainDeferredWrites` call), i.e. outside the scan race the claim gate
 * measures.
 *
 * The read (`getTokenStatsMany`) is only TIMED, never deferred — the gates
 * consume its result in the same tick. And the deferral is scoped to the TICK
 * (`tickActive`): the same Db handle also serves callers outside a tick — the
 * worker's own backfill endpoint awaits its seed before responding — and those
 * keep their normal, immediate contract.
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

/**
 * The DB methods the probe may wrap. Loosely typed on purpose: the probe never
 * inspects the arguments or the result, it only forwards them, so the real
 * handle (with its own signatures) satisfies this structurally.
 */
export interface TickProbeDb {
  getTokenStatsMany?: (...args: never[]) => Promise<unknown>;
  recordTokenStatsMany?: (...args: never[]) => Promise<unknown>;
  updateTokenMaxMcaps?: (...args: never[]) => Promise<unknown>;
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
  /**
   * The scan's DB handle. Wrapped once per object (a rebuilt handle is a new
   * object); see the header for what is measured and what may be deferred.
   */
  db?: TickProbeDb;
  /**
   * Move the two write round trips out of the tick (see the header). Default
   * false: wrapped and timed, but still awaited in place. Turning it on
   * requires the caller to drain (see drainDeferredWrites) — the worker does
   * that after its completion flush.
   */
  deferWrites?: boolean;
}

/** One DB call the probe measured, cumulative per isolate. */
export interface DbStepView {
  calls: number;
  ms: number;
}

/** What a (worker-side) drain did, or null before the first one. */
export interface WriteDrainView {
  /** Calls drained in the most recent drain. */
  calls: number;
  /** Wall-clock ms that drain took. */
  ms: number;
  /** Epoch of the last drain that actually ran (0 before the first one). */
  at: number;
  /** Deferred calls whose real write threw. */
  failures: number;
  /** Cumulative since the isolate booted, so the effect is readable either way. */
  totals: { calls: number; ms: number; failures: number };
}

let view: TickProbeView | null = null;
let tickStartedAt = 0;
let stamps: TickPhaseStamp[] = [];
/**
 * Clock used by the DB seam and the drain. Production passes `Date.now` (see
 * installTickProbe's `now`); tests inject their own, which is the only way the
 * per-step ms can be asserted instead of merely observed.
 */
let dbClock: () => number = () => Date.now();

/** Writes waiting for the drain, in call order. */
let queue: Array<{ name: string; run: () => Promise<unknown> }> = [];
/** Cumulative per-method timing for this isolate. */
const steps = new Map<string, DbStepView>();
let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  totals: { calls: 0, ms: 0, failures: 0 },
};
/** DB handles already wrapped (double wrapping would double every write). */
const wrapped = new WeakSet<object>();
/**
 * True while a wrapped tick is running. Deferral is scoped to it so that the
 * same Db handle's calls from OUTSIDE a tick (the worker's backfill endpoint)
 * keep their normal contract — only the tick's own bookkeeping writes move.
 */
let tickActive = false;

/** The tick that finished most recently, or null before the first one. */
export function tickProbeView(): TickProbeView | null {
  return view ? { phases: view.phases.map((p) => ({ ...p })), tickMs: view.tickMs } : null;
}

/** Per-method DB timing since this isolate booted (see the header). */
export function dbStepView(): Record<string, DbStepView> {
  const out: Record<string, DbStepView> = {};
  for (const [name, s] of steps) out[name] = { ...s };
  return out;
}

/** The most recent drain plus its cumulative totals (see the header). */
export function writeDrainView(): WriteDrainView {
  return { ...drain, totals: { ...drain.totals } };
}

/** How many deferred writes are still waiting (0 = nothing queued). */
export function deferredWriteCount(): number {
  return queue.length;
}

/**
 * Run every queued write, in call order, and report what it cost. Called by
 * the worker AFTER its completion flush: the tick's own scan race is over, so
 * this round trip can no longer delay a card's claim — it only costs the
 * invocation's tail. Failures are counted and logged, never thrown: the
 * scanner logs its own write failures, and a deferred write has nobody left
 * to catch for it.
 */
export async function drainDeferredWrites(): Promise<WriteDrainView> {
  const pending = queue;
  queue = [];
  if (pending.length === 0) {
    // Nothing was queued: report the empty batch without erasing the last real
    // drain's stamp, so a reader can tell "nothing to do" from "never drained".
    drain = { ...drain, calls: 0, ms: 0, failures: 0 };
    return writeDrainView();
  }
  const startedAt = dbClock();
  let failures = 0;
  for (const call of pending) {
    try {
      await call.run();
    } catch (err) {
      failures += 1;
      console.error(
        `[tickprobe] deferred ${call.name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const ms = dbClock() - startedAt;
  drain = {
    calls: pending.length,
    ms,
    at: dbClock(),
    failures,
    totals: {
      calls: drain.totals.calls + pending.length,
      ms: drain.totals.ms + ms,
      failures: drain.totals.failures + failures,
    },
  };
  return writeDrainView();
}

/** Test seam: the probe is module state, like the scanner's own mirrors. */
export function resetTickProbe(): void {
  view = null;
  tickStartedAt = 0;
  stamps = [];
  queue = [];
  steps.clear();
  dbClock = () => Date.now();
  drain = { calls: 0, ms: 0, at: 0, failures: 0, totals: { calls: 0, ms: 0, failures: 0 } };
}

function noteStep(name: string, ms: number): void {
  const seen = steps.get(name) ?? { calls: 0, ms: 0 };
  steps.set(name, { calls: seen.calls + 1, ms: seen.ms + ms });
}

/**
 * Wrap one DB method. A read is timed and still awaited by the scanner; a
 * deferred write hands the scanner an already-resolved promise and queues the
 * real call (see the header).
 */
function wrapDbMethod(
  target: Record<string, unknown>,
  name: string,
  defer: boolean,
): void {
  const original = target[name];
  if (typeof original !== "function") return;
  const call = original as (...args: unknown[]) => Promise<unknown>;
  target[name] = (...args: unknown[]): Promise<unknown> => {
    if (!defer || !tickActive) {
      const at = dbClock();
      return call.apply(target, args).then(
        (value) => {
          noteStep(name, dbClock() - at);
          return value;
        },
        (err: unknown) => {
          noteStep(name, dbClock() - at);
          throw err;
        },
      );
    }
    queue.push({
      name,
      run: async () => {
        const at = dbClock();
        try {
          return await call.apply(target, args);
        } finally {
          noteStep(name, dbClock() - at);
        }
      },
    });
    return Promise.resolve();
  };
}

/** Wrap the three DB methods the tick uses around its gates (see the header). */
function wrapDb(db: TickProbeDb, deferWrites: boolean): void {
  if (wrapped.has(db as object)) return;
  wrapped.add(db as object);
  const target = db as Record<string, unknown>;
  // Reads keep their contract (the gates consume the result in this tick).
  wrapDbMethod(target, "getTokenStatsMany", false);
  // Writes: registration + raise-only bookkeeping, neither read by the gates.
  wrapDbMethod(target, "recordTokenStatsMany", deferWrites);
  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites);
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
  if (hooks.db) {
    dbClock = now;
    wrapDb(hooks.db, hooks.deferWrites === true);
  }
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
    tickActive = true;
    try {
      hooks.onTickStart?.();
    } catch {
      // A prefetch is an optimisation; it may never cost the tick.
    }
    try {
      return await runOnce();
    } finally {
      // Tick over: a straggler write from here on is awaited by its caller
      // again (the queue keeps only what the tick itself queued).
      tickActive = false;
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
