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
 * quantity the platform limits. (src/db.ts passes its own `fetch` closure into
 * createClient — the libsql HTTP client would otherwise hold the fetch it
 * snapshotted at import time, which is the pre-wrapper global — and that
 * closure resolves THIS one at call time, so Turso round trips are counted.)
 *
 * TWO AXES, BECAUSE ONE OF THEM IS BLIND IN THE COMMON CASE
 * The phase ring is stamped from the scanner's own phase marks, which only
 * fire once a CANDIDATE enters the chain (deferred/seen/flow/…). Most ticks
 * process zero candidates (see the `candidates` column of scan_history), so a
 * killed tick usually publishes an empty ring — measured live on 2026-09-23:
 * windows of 34, 44 and 56 subrequests with no phase point at all. The host
 * split is the second axis and it never depends on the scanner reaching a
 * phase: it attributes every counted call to the host it was sent to, so a
 * dead window still says WHO spent the budget (`…turso.io` = DB round trips,
 * `api.telegram.org` = sends, `api.geckoterminal.com` / `api.dexscreener.com`
 * / the other feeds = the scan's upstream calls).
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
 * Subrequests this counter CANNOT see, reserved out of every reading.
 *
 * WHY, measured (2026-09-24): the live occurrence at 14:54:56Z read
 *
 *     err:Too many subrequests by single Worker invocation … [rows subreq 12]
 *
 * — the pass's own diagnostic (PushWatcher.passDiag) reporting 12 still
 * unspent at the moment the runtime refused the invocation. The refused call
 * is inside that count, because countSubreq runs before the request is
 * issued, so the counter had seen 38 when the platform stopped at 50: about
 * twelve subrequests went out through a seam this wrapper does not cover.
 * The gates were not at fault — at 12 unspent the row gate (≤6) and the
 * stage gates (<3) correctly read that there was room.
 *
 * RULED OUT before reserving anything, so this is a size, not a theory: no
 * transport bypasses fetch in the Worker (the deployed bundle contains no
 * WebSocket at all, and Turso goes through @libsql/client/web over https, so
 * the db closure resolves this same wrapped global); the reading was not
 * stale (seconds old, with the durable row beside it still reading
 * `running`); and the placement was not wrong (the death is in `rows`,
 * which the entry gate guards against a different case on purpose).
 *
 * WHAT IS STILL UNKNOWN is the SHAPE of the gap, not its size. Reserving it
 * is the conservative direction: a tick that spends only inside what the
 * counter can see cannot overrun what it cannot see, and being wrong costs
 * a pass that defers a tick early and is retried — never a lost write.
 *
 * ONE constant, moved by measurement: every occurrence now reports its own
 * number in the err note, so the next one re-sizes this without any further
 * instrumentation.
 */
export const SUBREQ_UNSEEN_ALLOWANCE = 12;

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

/**
 * Host buckets listed per window before the rest is folded into one row. Kept
 * small because /health is polled every minute: the split is meant to be read
 * at a glance (which upstream owns the budget), not archived.
 */
export const SUBREQ_HOST_RING = 7;

/**
 * Distinct hosts tracked per window. A pathological tick (many backfills, many
 * feeds in fallback) could otherwise grow the map without bound; past this the
 * calls land in the folded row instead, so the split still sums to the total.
 */
export const SUBREQ_HOST_TRACK_MAX = 24;

/** The folded row's key: every host past SUBREQ_HOST_TRACK_MAX, plus the ones
 *  past SUBREQ_HOST_RING at read time. Keeps `sum(hosts) === total` readable. */
export const SUBREQ_OTHER_HOST = "(other)";

/** One phase stamp: the window's total when the scanner reached `phase`. */
export interface SubreqPhasePoint {
  phase: string;
  /** Subrequests counted in this window up to and including the same phase. */
  total: number;
  /** Window-relative ms, so a point's cost can be read next to summary.phases. */
  ms: number;
}

/** One host's share of a window: `count` calls were sent to `host`. */
export interface SubreqHostCount {
  host: string;
  count: number;
}

/** One invocation's counter state. */
export interface SubreqWindowView {
  /** Window entry (epoch ms) — the tick's start, not its end. */
  at: number;
  /** Subrequests counted so far in this window. */
  total: number;
  /** Newest last, at most SUBREQ_PHASE_RING points. */
  phases: SubreqPhasePoint[];
  /**
   * Where the window's `total` went, biggest first, at most SUBREQ_HOST_RING
   * rows plus one SUBREQ_OTHER_HOST row carrying the remainder — so the counts
   * always add up to `total` and a reader can check that.
   */
  hosts: SubreqHostCount[];
}

export interface SubreqView {
  /** The allowance every window is spent against (SUBREQ_BUDGET_FREE). */
  budget: number;
  /**
   * Subrequests the counter cannot see (SUBREQ_UNSEEN_ALLOWANCE), reserved
   * out of every reading.
   */
  unseenAllowance: number;
  /**
   * `budget - unseenAllowance`: the ceiling a tick may actually spend
   * against. Published beside `budget` so the reservation is visible in
   * /health rather than buried in the arithmetic — a reader comparing a
   * window's `total` against 50 would otherwise be reading against a number
   * the tick never spends to.
   */
  usable: number;
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

/** Internally the host split is a map; the view flattens it to sorted rows. */
interface SubreqWindowState {
  at: number;
  total: number;
  phases: SubreqPhasePoint[];
  hosts: Map<string, number>;
}

/** The window being spent, and the finished ones behind it (newest first). */
let current: SubreqWindowState = { at: 0, total: 0, phases: [], hosts: new Map() };
let recent: SubreqWindowState[] = [];
let windows = 0;

/**
 * The host a fetch target belongs to. Both shapes a client uses are handled:
 * a URL string and a Request (the DB's own closure passes a string; the
 * upstream clients pass either). Anything unparseable still counts as a
 * subrequest — it just has no host to name.
 */
function hostOf(input: unknown): string {
  try {
    if (typeof input === "string") return new URL(input).host || "(no host)";
    if (input instanceof URL) return input.host || "(no host)";
    const url = (input as { url?: unknown } | null | undefined)?.url;
    if (typeof url === "string") return new URL(url).host || "(no host)";
  } catch {
    // fall through: a target we cannot parse is still a spent subrequest
  }
  return "(unknown)";
}

/** Flatten a window's host map into the published rows (bounded, summing). */
function hostRows(hosts: Map<string, number>): SubreqHostCount[] {
  const sorted = [...hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length <= SUBREQ_HOST_RING) {
    return sorted.map(([host, count]) => ({ host, count }));
  }
  const rows = sorted
    .slice(0, SUBREQ_HOST_RING)
    .map(([host, count]) => ({ host, count }));
  const rest = sorted.slice(SUBREQ_HOST_RING).reduce((sum, [, count]) => sum + count, 0);
  rows.push({ host: SUBREQ_OTHER_HOST, count: rest });
  return rows;
}

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
  current = { at, total: 0, phases: [], hosts: new Map() };
  windows += 1;
}

/**
 * Count one subrequest, attributed to the host it is going to. Called by the
 * fetch wrapper in src/worker.ts for every call, before the request is issued —
 * the same discipline the Birdeye CU ledger uses (an attempt that is billed is
 * counted whether or not it lands), because a request the runtime refuses
 * mid-flight was still an attempt.
 */
export function countSubreq(input?: unknown): void {
  current.total += 1;
  const host = hostOf(input);
  const seen = current.hosts.get(host);
  if (seen !== undefined) {
    current.hosts.set(host, seen + 1);
  } else if (current.hosts.size < SUBREQ_HOST_TRACK_MAX) {
    current.hosts.set(host, 1);
  } else {
    current.hosts.set(SUBREQ_OTHER_HOST, (current.hosts.get(SUBREQ_OTHER_HOST) ?? 0) + 1);
  }
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
  const flat = (w: SubreqWindowState): SubreqWindowView => ({
    at: w.at,
    total: w.total,
    phases: w.phases.map((p) => ({ ...p })),
    hosts: hostRows(w.hosts),
  });
  return {
    budget: SUBREQ_BUDGET_FREE,
    unseenAllowance: SUBREQ_UNSEEN_ALLOWANCE,
    usable: Math.max(0, SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE),
    current: flat(current),
    recent: recent.map(flat),
    windows,
  };
}

/**
 * Subrequests still spendable in this window, never below 0.
 *
 * WHY IT EXISTS (2026-09-24): `subreqView()` above answers "who spent the
 * budget" AFTER the fact, which is a post-mortem. This is the pre-flight
 * half — what a LATE stage of a tick must consult BEFORE it starts a spend
 *
 * SPENDABLE, not raw: the unseen reserve (SUBREQ_UNSEEN_ALLOWANCE, sized from
 * the live 14:54:56Z `rows subreq 12` occurrence) comes off first, because a
 * caller acting on this number is deciding whether it can afford a round
 * trip, and the round trips the counter cannot see are real ones. A window
 * that has counted nothing reports the usable ceiling, so a caller ahead of
 * its first fetch sees room rather than a false zero.
 * that costs several subrequests, so a starved tick defers its tail by name
 * instead of spending the invocation's last call on a `Too many subrequests
 * by single Worker invocation` throw. Measured on the live worker: the scan +
 * completion flush reach 47 of 50 on a cold isolate (its phase ring ending
 * `send:autobuy 46`), and the tracker pass behind it needs 5-13 more (its own
 * `trips` counter), so on exactly those ticks the pass died mid-flight and
 * took the deferral sync and the write drain with it.
 *
 * The tail's own reserve is the caller's business — this only reports the room
 * that is left, so the two ceilings can be spent in a known order instead of
 * by whichever stage happened to run last. A window that has counted nothing
 * yet reports the full budget, so a caller ahead of its first fetch (and any
 * test that does not install the probe) sees room, never a false zero.
 *
 * Optional `budget` override exists for the probe seam only; the tick path
 * spends against SUBREQ_BUDGET_FREE, which is a platform fact.
 */
export function subreqRemaining(budget: number = SUBREQ_BUDGET_FREE): number {
  if (!Number.isFinite(budget)) return Number.POSITIVE_INFINITY;
  return Math.max(0, budget - SUBREQ_UNSEEN_ALLOWANCE - current.total);
}

/** Test seam: forget the boot's windows (never called on the tick path). */
export function resetSubreqWindows(): void {
  current = { at: 0, total: 0, phases: [], hosts: new Map() };
  recent = [];
  windows = 0;
}
