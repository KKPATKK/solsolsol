/*
 * Subrequest accounting for the invocation budget.
 *
 * WHY THIS EXISTS
 * Workers Free allows 50 subrequests per INVOCATION and this bot's tick lives
 * on that edge: the runtime's `Too many subrequests by single Worker
 * invocation` throw is what kills a tick before its completion flush (the
 * `previous tick died before its completion flush` rows) and what starves the
 * tail of the ticks that do flush (a tracker-pass note that reads
 * `err:Too many subrequests`, or a pass stuck in `phase:"running"`).
 *
 * Until now there was no count of the thing being spent. The per-stage `trips`
 * in the pass note cover only the pass's own DB round trips; `dbSteps` covers
 * three wrapped Db methods; `writeDrain` covers the drain. None of them can
 * answer "WHICH phase spent the budget", which is the only question that
 * decides what to batch or drop — so every previous cut in that direction
 * (docs/round-trips.md §1, §4.2) was reasoned from a stage split rather than
 * from a total.
 *
 * WHAT IS COUNTED
 * Every call to the global `fetch`, counted by a wrapper the worker installs
 * once (see the installer in src/worker.ts). That is deliberately the ONLY
 * seam: the DB client is @libsql/client/web, i.e. one HTTP request per
 * statement batch, so Turso round trips, Telegram sends and every upstream
 * feed (gecko, pump.fun, Meteora, DexScreener, Jupiter, Birdeye, Helius, GMGN)
 * all come through the same function. One counter therefore measures the exact
 * quantity the platform limits.
 *
 * HOW A KILLED INVOCATION IS READ
 * The counter is per INVOCATION but the module outlives it on a warm isolate.
 * `beginSubreqWindow` at tick entry rolls the finished window into `recent`,
 * so an invocation that died on the budget publishes nothing itself — and the
 * NEXT tick on that isolate (the one that backfills its history row) can still
 * see how far the dead one got and how much it had spent at each phase before
 * it stopped.
 */

/**
 * The runtime's per-invocation subrequest allowance on Workers Free. Pinned
 * here because every reading this counter produces is only meaningful against
 * it, and because the number is a platform fact rather than a tuning knob:
 * exceeding it throws mid-tick, wherever the next call happens to be.
 */
export const SUBREQ_BUDGET_FREE = 50;

/**
 * Phase points kept per window. The interesting window is the one that DIED,
 * so the ring keeps the newest stamps: the tail is where the budget went.
 */
export const SUBREQ_PHASE_RING = 8;

/**
 * Finished windows kept for reading. More than one because the window
 * immediately before a tick can be a plain HTTP request (/health reads and
 * uptime-monitor pings also open a window), and the reader is looking for the
 * tick-sized one — keeping two makes "the dead tick's tail" survive that.
 */
export const SUBREQ_RECENT_WINDOWS = 2;

/** One phase stamp: the window's total when the scanner reached `phase`. */
export interface SubreqPhasePoint {
  phase: string;
  /** Subrequests counted in this window up to and including the same phase. */
  total: number;
  /** Window-relative ms, so a point's cost can be read next to summary.phases. */
  ms: number;
}

/** One invocation's counter state. */
export interface SubreqWindowView {
  /** Window entry (epoch ms) — the tick's start, not its end. */
  at: number;
  /** Subrequests counted so far in this window. */
  total: number;
  /** Newest last, at most SUBREQ_PHASE_RING points. */
  phases: SubreqPhasePoint[];
}

export interface SubreqView {
  /** The allowance every window is spent against (SUBREQ_BUDGET_FREE). */
  budget: number;
  /** The window being spent right now (this invocation). */
  current: SubreqWindowView;
  /**
   * Finished windows, newest first, at most SUBREQ_RECENT_WINDOWS. The one
   * with a phase ring and a total near the budget is a killed tick.
   */
  recent: SubreqWindowView[];
  /** Windows rolled since this isolate booted (a live counter reads > 0). */
  windows: number;
}

/** The window being spent, and the finished ones behind it (newest first). */
let current: SubreqWindowView = { at: 0, total: 0, phases: [] };
let recent: SubreqWindowView[] = [];
let windows = 0;

/**
 * Start a fresh window for an invocation entering the tick path. The window
 * being closed is rolled into `recent` with its own total and phase ring —
 * that is the whole point of the roll: an invocation killed by the budget
 * never gets to publish anything, so its last state has to be readable by the
 * NEXT one (see the header).
 */
export function beginSubreqWindow(at = Date.now()): void {
  // A window that never counted anything (a module load, a route that returned
  // before its first call) is not worth a slot in the ring.
  if (current.total > 0 || current.phases.length > 0) {
    recent = [current, ...recent].slice(0, SUBREQ_RECENT_WINDOWS);
  }
  current = { at, total: 0, phases: [] };
  windows += 1;
}

/**
 * Count one subrequest. Called by the fetch wrapper in src/worker.ts for every
 * call, before the request is issued — the same discipline the Birdeye CU
 * ledger uses (an attempt that is billed is counted whether or not it lands),
 * because a request the runtime refuses mid-flight was still an attempt.
 */
export function countSubreq(): void {
  current.total += 1;
}

/**
 * Record the window's total at a phase boundary. Wired into the scanner's own
 * phase marker through the tick probe (src/tickprobe.ts), so it costs one
 * array push on a path that already stamps — no round trip, no timer.
 */
export function markSubreqPhase(phase: string, at = Date.now()): void {
  if (current.phases.length >= SUBREQ_PHASE_RING) current.phases.shift();
  current.phases.push({
    phase,
    total: current.total,
    ms: current.at > 0 ? Math.max(0, at - current.at) : 0,
  });
}

/** What the heartbeat publishes (see the `subreqs` field there). */
export function subreqView(): SubreqView {
  return {
    budget: SUBREQ_BUDGET_FREE,
    current: {
      at: current.at,
      total: current.total,
      phases: current.phases.map((p) => ({ ...p })),
    },
    recent: recent.map((w) => ({
      at: w.at,
      total: w.total,
      phases: w.phases.map((p) => ({ ...p })),
    })),
    windows,
  };
}

/** Test seam: forget the boot's windows (never called on the tick path). */
export function resetSubreqWindows(): void {
  current = { at: 0, total: 0, phases: [] };
  recent = [];
  windows = 0;
}
