import { geckoFeedStats } from "./geckoterminal";
import { gmgnFeedStats } from "./gmgn";
// The subrequest window is stamped here, because this wrapper is the only
// place that sees EVERY phase the scanner marks (see src/subreqs.ts): the
// scanner itself is past the file-sync window, and the probe already
// intercepts its marker.
import {
  SUBREQ_BUDGET_FREE,
  SUBREQ_UNSEEN_ALLOWANCE,
  markSubreqPhase,
  subreqRemaining,
} from "./subreqs";

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
 * is handed an already-resolved promise, the real call is queued (FIFO across
 * methods, coalesced per token since 2026-09-27 — see DeferredBucket), and the
 * worker drains the queue AFTER its completion flush (see the worker's
 * `drainDeferredWrites` call), i.e. outside the scan race the claim gate
 * measures.
 *
 * The read (`getTokenStatsMany`) is only TIMED, never deferred — the gates
 * consume its result in the same tick. And the deferral is scoped to the TICK
 * (`tickActive`): the same Db handle also serves callers outside a tick — the
 * worker's own backfill endpoint awaits its seed before responding — and those
 * keep their normal, immediate contract.
 *
 * 2026-09-20: a deferred write that FAILED used to be counted and dropped
 * (live measurement: `writeDrain` 4 calls / 4 failures = 100%, because an
 * un-awaited drain is cancelled when the invocation returns and its writes
 * reject). The queue now owns the retry — a record leaves it only once it has
 * landed — so a cancelled drain costs one tick of latency instead of a
 * permanent gap in token_stats (see drainDeferredWrites). The same tick also
 * publishes the GeckoTerminal feed's state onto the summary, since `geo: 0`
 * could not say whether the feed was rate-limited (see geckoFeedStats).
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
  /**
   * The tick's scan. The optional probe is the invocation's remaining
   * subrequest allowance (see SCAN_SUBREQ_FLOOR in src/scanner.ts); the
   * wrapper FORWARDS it instead of swallowing it. A scanner that takes no
   * argument (every earlier shape, and every test double) still satisfies
   * this: fewer parameters is assignable.
   */
  runOnce: (subreqLeft?: () => number) => Promise<unknown>;
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
  /**
   * The durable-row writer, wrapped for exactly ONE purpose: publishing a
   * failed drain (see WRITE_DRAIN_ERROR_KEY and persistDrainError). Optional —
   * the probe works without it, and the offline tests' fake handles omit it.
   */
  setWorkerState?: (key: string, value: string) => Promise<unknown>;
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
  /**
   * The most recent failed deferred write — which METHOD threw, the error's
   * name and text, and when it happened — or null while nothing has failed
   * since this isolate booted.
   *
   * WHY it is on the wire: /health's `writeDrain` reports `pending` and
   * `failures` but never the REASON, which only ever reached `wrangler tail`.
   * Live 2026-09-24: `pending 47`, `totals {calls 57, ms 17759, failures
   * 38}` — a backlog of 47 writes with 67% of attempts failing — and no public
   * surface could say WHY (a transport abort, a Turso 5xx, a write too large,
   * a conflict), so the one number that decides the fix was unreadable outside
   * the dashboard. The drain stops its batch at the first failure (see
   * drainDeferredWrites), so this names the entry that stalled it.
   *
   * WHY THE METHOD, not just the text: both deferred methods write the SAME
   * table through the same client, so "turso 522" alone does not say whether
   * the registration INSERT or the max-mcap UPDATE is the one that cannot
   * land — and those two have different fixes (batch size vs. a raise-only
   * statement). The name is the failing bucket's own, i.e. the real Db method.
   *
   * WHY IT ALSO GOES DURABLE (2026-09-24, later): this mirror is MODULE
   * state, and the isolate holding the backlog is not the one answering
   * /health — the live read that motivated the field (`pending 47`) came from
   * a poll landing on a pristine isolate (`writeDrain {at 0}`), which is why
   * the mirror alone could never show the reason. Every failing drain
   * therefore ALSO copies this record to a worker_state row
   * (WRITE_DRAIN_ERROR_KEY) that any isolate can read back; see
   * persistDrainError.
   */
  lastError: {
    /** The deferred Db method that threw (e.g. recordTokenStatsMany). */
    method: string;
    /** The error's own name — "Error" for a plain thrown Error. */
    name: string;
    /** The error's message, verbatim (never a tombstone). */
    message: string;
    /** Epoch of the failure (the probe's injected dbClock). */
    at: number;
  } | null;
  /**
   * CALLS still waiting after this drain (0 = nothing owed). A failed call is
   * NOT dropped: its records stay in their bucket and are retried by the next
   * drain, so `failures > 0` with `pending > 0` reads as "the last tick's
   * batch did not land yet", not "lost". Bounded by the number of deferred
   * methods (one call per method, see DeferredBucket) — read `owedTokens` for
   * the backlog behind them.
   */
  pending: number;
  /**
   * RECORDS still owed behind those calls — the backlog, which `pending` cannot
   * express any more: the queue coalesces per token (see DeferredBucket), so one
   * owed call can carry dozens of records and `pending` stays 0-2 whatever the
   * backlog is. THIS is the number that used to grow without bound (live
   * 2026-09-27: 12 → 31 in eleven minutes) and the one that says how far the
   * token_stats bookkeeping is behind.
   */
  owedTokens: number;
  /**
   * Entries this drain did NOT touch because the tracker pass behind it still
   * needed the invocation's subrequest allowance (see DRAIN_TRACKER_RESERVE),
   * or because this drain's ceiling was lowered below what the room allowed
   * (`shed` names that case). Deliberately separate from `pending`, which also
   * counts a batch stopped by a failure: `pending 3 failures 0` is a held
   * batch, `pending 3 failures 1` is a database that just refused a write.
   * Neither drops anything.
   */
  heldForTracker: number;
  /**
   * Subrequests this drain left for the tracker pass behind it — the yield it
   * respected while it walked the queue (see drainTrackerReserve), so a reader
   * can tell a held batch from a spent one. Four readings are meaningful: 14 an
   * unmeasured isolate (the old flat reserve, i.e. nothing has changed for it),
   * a value between DRAIN_TRACKER_RESERVE_MIN and that ceiling a MEASURED
   * yield, DEFERRED_FORCE_DRAIN_FLOOR a queue over the cap being drained ahead
   * of the pass, and 0 an empty queue (nothing was held back).
   */
  reserve: number;
  /**
   * Non-null when this drain ran under a LOWER call ceiling than the normal one
   * (DEFERRED_MAX_CALLS_PER_DRAIN), and the reason why — currently only
   * "dead-predecessor" (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS). `calls` alone
   * cannot separate the three ways a small batch happens: the room, the ceiling,
   * or the queue being genuinely short, and the ceiling is the one an operator
   * changes.
   */
  shed: string | null;
  /** Cumulative since the isolate booted, so the effect is readable either way. */
  totals: { calls: number; ms: number; failures: number };
}

/**
 * How many times a deferred BATCH may fail before its records are dropped. The
 * calls are idempotent (INSERT OR IGNORE / raise-only UPDATE), so retrying is
 * free of consequence; the bound exists so a database that is down for hours
 * cannot hold the same records forever (it counts FAILURES per bucket, and the
 * scanner re-issues whatever it still needs — see DeferredBucket).
 */
export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;

/**
 * Records one coalesced call may carry (see DeferredBucket). The payload is a
 * multi-row statement, so the cap bounds its size: one tick's registration is
 * ~23-30 feed profiles and its raises are the pool slice, i.e. 40 keeps a
 * catch-up at the worst case a single tick ALREADY wrote before coalescing,
 * while a long backlog drains in bounded chunks (what did not fit stays owed).
 */
export const DEFERRED_COALESCE_MAX_PER_CALL = 40;

/**
 * Subrequests the write drain leaves for the TRACKER PASS behind it.
 *
 * WHY A FLOOR (live 2026-09-25, ~41 minutes of starvation): the drain is fired
 * from the worker's `onTickEnd` — i.e. as soon as the scan ends, which is
 * BEFORE the tracker pass in that invocation's tail — and it used to walk its
 * queue with no ceiling at all (an entry per call). Its cost was therefore
 * "however long the backlog is", and a 20-entry backlog is 20 Turso round trips
 * spent in front of the one stage that runs LAST and is explicitly the residual
 * claimant of the platform's 50-subrequest allowance (see worker.ts's note on
 * `subreqRemaining`). The tracker is the only stage that defers by name
 * (`deferred:subreq-budget`), so a backlog can starve the whole row rotation
 * without ever failing anything: rows went unchecked for 41 minutes while every
 * completed pass read `rows 0/0`, and the rotation came back the moment the
 * backlog cleared (`summary.writeDrain.pending` 20 → 0).
 *
 * THE NUMBER: what a pass needs to be WORTH STARTING — its tail writes
 * (TRACKER_SUBREQ_RESERVE = 6, see pushwatch.ts) plus a few rows of the rotation
 * (one claim/check UPDATE each). 8 + 6 = 14, i.e. about eight rows rather than
 * the fifteen the rotation wants on a roomy tick. Held entries are NOT failures:
 * the queue is built to keep an entry until it lands, so the next tick's drain
 * (or this one, after the pass) takes them — see WriteDrainView.heldForTracker.
 *
 * WHY IT IS A CEILING AND NOT A FLAT YIELD (2026-09-28): a flat 14 turned out
 * to be a PERMANENT yield on this bot, because 14 is what a pass needs when it
 * has room to be worth starting — and a tick whose scan has spent 24-36 of the
 * 38 usable subrequests cannot offer it. Live (00:02-00:28Z, cadence restored
 * to 60s): `left` was 2-14, i.e. `<= 14` on every tick, so the drain landed
 * nothing while the queue grew 305 -> 2098 records in 26 minutes (`calls 5` ->
 * 7 lifetime, `heldForTracker 2`, `failures 0`). The queue is bounded — it
 * coalesces per token — and the scanner re-issues what it still needs, but the
 * bookkeeping it exists to carry was parked, so the yield is now MEASURED
 * (see noteTrackerPassSpend) and a queue over the cap drains first
 * (see DEFERRED_FORCE_DRAIN_RECORDS).
 */
export const DRAIN_TRACKER_RESERVE = 14;

/**
 * The floor the adaptive reserve may fall to (see drainTrackerReserve): the
 * cheapest pass that is still a pass, plus the tail writes it holds back for
 * itself — pushwatch.TRACKER_SUBREQ_FLOOR (3) + TRACKER_SUBREQ_RESERVE (6).
 * Below it the pass cannot even reach its rotation, which is the starvation
 * the reserve was introduced to prevent.
 */
export const DRAIN_TRACKER_RESERVE_MIN = 9;

/**
 * How many recent TICK-PATH pass measurements the reserve is the WORST of (see
 * noteTrackerPassSpend). More than one because a single thin pass would
 * otherwise license the drain to spend the room the NEXT pass needs; five
 * smooths that without outliving the shape it measures.
 */
export const TRACKER_PASS_SPEND_RING = 5;

/**
 * Records owed before the queue stops waiting for the tracker pass entirely
 * (see drainTrackerReserve): ten capped calls' worth. Below it the queue is a
 * catch-up; above it the drain is what the invocation owes, because a
 * bookkeeping queue nobody lands is exactly the leak coalescing was built to
 * stop (its live reading is "owedTokens rising every tick with calls 0").
 */
export const DEFERRED_FORCE_DRAIN_RECORDS = DEFERRED_COALESCE_MAX_PER_CALL * 10;

/**
 * Subrequests the drain keeps for the pass's own TAIL (its note persist, the
 * deferral-counter sync) even while it is draining a queue over the cap. NOT
 * the full reserve: a forced drain is allowed to cost the pass its ROTATION —
 * the pass defers that BY NAME (`deferred:subreq-budget`, pushwatch) rather
 * than dying — but never the one write that says the pass ran at all, which is
 * pushwatch.TRACKER_SUBREQ_RESERVE = 6.
 */
export const DEFERRED_FORCE_DRAIN_FLOOR = 6;

/**
 * Calls ONE drain may make, whatever the room says.
 *
 * WHY IT EXISTS (live 2026-09-28, right after the force rule landed): landing
 * ONE slice per bucket per tick was not enough, because the queue's inflow is
 * per-tick too — `owedTokens` read 356 -> 424 -> 477 -> 548 on consecutive ticks
 * with `calls 2` and `heldForTracker 0`, i.e. ~150 records were queued per tick
 * while at most two 40-record slices (one per method) landed. A bucket that
 * still owes records now goes to the BACK of this drain's rotation (fair
 * between the two methods), so the surplus room above the reserve is spent as
 * whole slices.
 *
 * The room check is the REAL bound — every call spends one subrequest, and the
 * drain stops at its reserve — so this cap is the belt to that braces: a room
 * reading that never falls must not turn one invocation into an unbounded walk.
 * Ten slices = 400 records, the queue's own cap, which is what makes "one drain
 * can clear a flooded queue" a true statement.
 */
export const DEFERRED_MAX_CALLS_PER_DRAIN = 10;

/**
 * Calls ONE drain may make on a tick that just BACKFILLED a dead predecessor
 * (see WriteDrainView.shed).
 *
 * WHY (2026-09-28): a tick that backfilled a death is the tick that has to
 * prove the wave of deaths is over — its own completion flush is the write that
 * ends the stretch — and the drain is fired from that same tick, in front of
 * that flush (see the worker's onTickEnd hook: moving it behind the flush was
 * measured and reverted on 2026-09-28, see docs/round-trips.md §4.45). Live
 * 2026-09-28 00:33-00:53Z: twelve cron ticks in twenty minutes died before their
 * flush while the tick was still free to spend ten drain round trips (a spend
 * the libsql client's own retries can multiply into two or three platform
 * subrequests each, see docs/scan-completion-loss.md). Landing
 * ONE slice still moves the bookkeeping forward — the queue coalesces, so what
 * is not landed stays owed and is re-offered by the next tick — while the rest
 * of the invocation's allowance goes to the flush, the tracker pass and the
 * deferral sync behind it.
 */
export const DEFERRED_DEAD_PREDECESSOR_MAX_CALLS = 1;

/**
 * Durable worker_state key holding the last FAILED drain (see
 * WriteDrainView.lastError and persistDrainError). Named here, next to the
 * drain that writes it, so the /health reader (worker.ts) and any debug route
 * share ONE spelling — the row's payload is the probe's own record, i.e.
 * `{ method, name, message, at, pending }`, and it is left in place until a
 * later failure overwrites it (a clean drain does NOT clear it: the last thing
 * that went wrong is evidence, and a reader has to be able to see it after the
 * isolate that hit it is gone).
 */
export const WRITE_DRAIN_ERROR_KEY = "write_drain_error";

/**
 * How long a durable drain-failure record stays "live" before /health calls
 * it stale (see worker.healthAgeMs). The row is written on a FAILURE and only
 * then (see persistDrainError), so a healthy bot leaves the last one in place
 * forever — live 2026-09-25 it read `took 8.4h ago` while every drain behind
 * it had landed, i.e. it described an incident nobody could act on. The age
 * was already published; this is the threshold that makes it actionable
 * instead of a bare number, and the clearing in drainDeferredWrites removes
 * the row outright once THIS isolate proves the drain recovered.
 */
export const WRITE_DRAIN_ERROR_STALE_MS = 10 * 60_000;

/**
 * Whether a durable drain-failure record is HISTORY rather than a live failure
 * (see WRITE_DRAIN_ERROR_STALE_MS).
 *
 * ONE rule for both readers, because they must never disagree: /health's
 * `writeDrainErrorStale` flag and the retirement that deletes a row nobody
 * will ever clear (see the retire in worker.ts's /health). A record without a
 * usable `at` is never stale — an unreadable row must not license a write.
 */
export function drainErrorIsStale(
  record: { at?: unknown } | null | undefined,
  now: number,
): boolean {
  if (record === null || record === undefined || typeof record !== "object") return false;
  const at = Number((record as { at?: unknown }).at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > WRITE_DRAIN_ERROR_STALE_MS;
}

/**
 * What that row holds: the failed drain's own record (see
 * WriteDrainView.lastError) plus `pending` — the size of the queue the failure
 * stalled, which is the number that separates a blip from an outage.
 *
 * Exported so the /health reader (worker.ts) names the same shape rather than
 * re-declaring it, and so a schema change here cannot leave the reader parsing
 * a shape that no longer exists.
 */
export type WriteDrainErrorRecord = NonNullable<WriteDrainView["lastError"]> & {
  pending: number;
  /**
   * Records the failure stalled (see WriteDrainView.owedTokens) — the backlog
   * the reader needs, since `pending` counts coalesced CALLS and is 0-2.
   * Optional because a record written before 2026-09-27 does not carry it.
   */
  owedTokens?: number;
};

/**
 * What the tick did with the card its chain reached — the counter this whole
 * duplicate-card investigation needed and did not have.
 *
 * The scanner stamps `send:telegram` immediately BEFORE the card send and
 * `send:track` immediately after it returns (see the send in sendTo), so the
 * two stamps together already answer "did this tick's card send finish?":
 * the send is raced against its slice, so a `send:telegram` with no
 * `send:track` after it means the await was abandoned — Telegram may still have
 * ACCEPTED the card, the catch releases the claim, the coin is unseen again and
 * the next tick pushes the same card. That is the duplicate the operator sees
 * (live 2026-09-20: GROYPER x5 and PONDER x5 in one afternoon), and until it is
 * fixed in the scanner's send (past the file-sync window) the least this probe
 * can do is count it per tick, so the rate is a number instead of an anecdote
 * and a fix can be shown to work.
 */
export interface CardSendView {
  /** Ticks whose card send returned (the tick reached `send:track`). */
  sent: number;
  /**
   * Ticks where a card send was abandoned at its deadline — the duplicate
   * generator. An abandoned send may or may not have been delivered, which is
   * exactly why its claim must not be released blindly.
   */
  cut: number;
  /**
   * Ticks that opened a card claim and never started a send: the deferral path
   * (nothing written, the coin keeps its place in the pool and its make-up
   * priority) or a claim another isolate won — cheap either way.
   */
  deferred: number;
  /** Epoch of the most recent cut (0 = none since this isolate booted). */
  lastCutAt: number;
  /** Tick-relative ms of the phase stamp the last cut happened at. */
  lastCutMs: number;
}

let view: TickProbeView | null = null;
let tickStartedAt = 0;
let stamps: TickPhaseStamp[] = [];
/** Cumulative per isolate, like the DB step timings above. */
let cardSend: CardSendView = {
  sent: 0,
  cut: 0,
  deferred: 0,
  lastCutAt: 0,
  lastCutMs: 0,
};
/**
 * Clock used by the DB seam and the drain. Production passes `Date.now` (see
 * installTickProbe's `now`); tests inject their own, which is the only way the
 * per-step ms can be asserted instead of merely observed.
 */
let dbClock: () => number = () => Date.now();

/**
 * One COALESCED deferred write: everything owed to ONE Db method on ONE handle.
 *
 * WHY ONE BUCKET PER METHOD INSTEAD OF ONE ENTRY PER CALL (2026-09-27): the
 * queue held every call VERBATIM, and both deferred calls decide what to write
 * from the STORED value — `recordTokenStatsMany` only registers a token the
 * stats read did not return, `updateTokenMaxMcaps` only raises a maximum — so a
 * write that has not landed yet makes the SAME token look new again on the next
 * tick and queues ANOTHER copy of it. Live 2026-09-27: `pending` went 12 → 31
 * in eleven minutes while `totals.calls` went 2 → 7, every entry
 * `heldForTracker` (the drain never got room), i.e. the queue was feeding
 * itself and could only grow. Coalescing by token makes the backlog BOUNDED by
 * the number of DISTINCT tokens owed rather than by the number of ticks that
 * wanted them, turns a catch-up into ONE round trip per method, and removes the
 * duplicates that were the growth.
 *
 * `owed` maps each record's own token to the record still waiting, insertion
 * ordered (Map), so one bucket's payload keeps the order it was absorbed in.
 * `rank` fixes the LANDING order ACROSS buckets: a registration must land
 * before a raise for the same token, or the raise's UPDATE matches no row and
 * the high-water mark is silently lost.
 */
interface DeferredBucket {
  name: string;
  rank: number;
  /** The original Db method, captured at install (the wrapper replaces it). */
  call: (...args: unknown[]) => Promise<unknown>;
  owed: Map<string, unknown>;
  /** Merge one absorbed call's arguments into `owed` (first-wins / max-wins). */
  absorb: (args: readonly unknown[]) => void;
  /** FAILED runs: an owed batch is dropped after DEFERRED_WRITE_MAX_ATTEMPTS. */
  attempts: number;
}

/** Every bucket this isolate has opened (see DeferredBucket). */
let buckets: DeferredBucket[] = [];
/** Unique keys for records a bucket cannot coalesce by token (see below). */
let opaqueRecords = 0;

/** Records owed across every bucket (0 = nothing to drain). */
function owedRecordCount(): number {
  let n = 0;
  for (const bucket of buckets) n += bucket.owed.size;
  return n;
}

/**
 * The buckets with something owed, in LANDING order (see DeferredBucket.rank).
 * A stable sort, so equal ranks keep the order they were opened in — a rebuilt
 * handle's bucket never overtakes the live one's.
 */
function owedBuckets(): DeferredBucket[] {
  return buckets.filter((bucket) => bucket.owed.size > 0).sort((a, b) => a.rank - b.rank);
}

/**
 * The coalescing key of one deferred record: the token it writes. A record
 * without one (a test double's primitive, or a future call shape) gets a unique
 * key instead, so it keeps its own slot rather than being merged into a
 * stranger's row.
 */
function deferredRecordKey(record: unknown): string {
  if (typeof record === "string" && record.length > 0) return record;
  if (record !== null && typeof record === "object") {
    const token = (record as { token?: unknown }).token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  opaqueRecords += 1;
  return `#${opaqueRecords}`;
}

/**
 * Registration absorbs FIRST-WINS: the FIRST sight of a token is the row's
 * truth (`recordTokenStatsMany` is INSERT OR IGNORE, and re-absorbing a later
 * sight would move first_seen_at forward — the pool's age signal).
 */
function absorbFirstWins(owed: Map<string, unknown>, args: readonly unknown[]): void {
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
  for (const record of list) {
    const key = deferredRecordKey(record);
    if (owed.has(key)) continue;
    owed.set(key, record);
  }
}

/**
 * Two raise records merged into one — MAX-WINS on both columns, which is
 * IDENTICAL to landing them in sequence: the statement is raise-only, so the
 * column ends at max(stored, a, b) either way. A finite liquidity reading (0
 * included — a corpse's $0 LP is its signal) survives a later record that has
 * none.
 */
function mergeRaise(prev: unknown, next: unknown): Record<string, unknown> {
  const a = (prev ?? {}) as { token?: unknown; mcapUsd?: unknown; liquidityUsd?: unknown };
  const b = (next ?? {}) as { token?: unknown; mcapUsd?: unknown; liquidityUsd?: unknown };
  const mcap = Math.max(Number(a.mcapUsd) || 0, Number(b.mcapUsd) || 0);
  const la =
    typeof a.liquidityUsd === "number" && Number.isFinite(a.liquidityUsd)
      ? a.liquidityUsd
      : undefined;
  const lb =
    typeof b.liquidityUsd === "number" && Number.isFinite(b.liquidityUsd)
      ? b.liquidityUsd
      : undefined;
  const liquidityUsd = la === undefined ? lb : lb === undefined ? la : Math.max(la, lb);
  const merged: Record<string, unknown> = {
    token: typeof a.token === "string" && a.token.length > 0 ? a.token : b.token,
    mcapUsd: mcap,
  };
  if (liquidityUsd !== undefined) merged.liquidityUsd = liquidityUsd;
  return merged;
}

/** Raise-only bookkeeping absorbs MAX-WINS (see mergeRaise). */
function absorbMaxWins(owed: Map<string, unknown>, args: readonly unknown[]): void {
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
  for (const record of list) {
    const key = deferredRecordKey(record);
    const prev = owed.get(key);
    owed.set(key, prev === undefined ? record : mergeRaise(prev, record));
  }
}

/**
 * The bucket for one (method, handle) pair, opened on first use: a rebuilt Db
 * handle (the worker's dead-tick rebuild) gets its own, so a record never rides
 * a handle that is no longer the one the scanner writes through.
 */
function bucketFor(
  name: string,
  rank: number,
  call: (...args: unknown[]) => Promise<unknown>,
  absorb: (owed: Map<string, unknown>, args: readonly unknown[]) => void,
): DeferredBucket {
  for (const bucket of buckets) {
    if (bucket.name === name && bucket.call === call) return bucket;
  }
  const owed = new Map<string, unknown>();
  const bucket: DeferredBucket = {
    name,
    rank,
    call,
    owed,
    absorb: (args) => absorb(owed, args),
    attempts: 0,
  };
  buckets.push(bucket);
  return bucket;
}

/**
 * Land what one bucket owes: up to DEFERRED_COALESCE_MAX_PER_CALL records in
 * ONE call. Only the records that actually landed leave the bucket, so a failed
 * call re-offers its whole slice to the next drain — the container's "an entry
 * leaves the queue only once it has landed", now per record.
 */
async function runBucket(bucket: DeferredBucket): Promise<void> {
  const keys: string[] = [];
  const payload: unknown[] = [];
  for (const [key, record] of bucket.owed) {
    keys.push(key);
    payload.push(record);
    if (payload.length >= DEFERRED_COALESCE_MAX_PER_CALL) break;
  }
  const at = dbClock();
  try {
    await bucket.call(payload);
  } finally {
    // Timed where it REALLY ran, exactly like every other censused call.
    noteStep(bucket.name, dbClock() - at);
  }
  for (const key of keys) bucket.owed.delete(key);
}
/** One drain at a time — the queue is walked in place (see drainDeferredWrites). */
let draining = false;
/**
 * The wrapped handle's durable-row writer, captured in installTickProbe. Only
 * a FAILED drain uses it (see persistDrainError), so an isolate that never
 * fails a deferred write pays nothing for it.
 */
let stateWriter: ((key: string, value: string) => Promise<unknown>) | null = null;
/**
 * Whether THIS isolate has a durable drain-failure row of its own out there
 * (see persistDrainError / clearPersistedDrainError). Module state, like the
 * drain view: it is what makes the RECOVERY cheap — a clean drain only clears
 * the row when there is one it wrote, so a healthy tick pays no extra write.
 */
let drainErrorPersisted = false;
/** Cumulative per-method timing for this isolate. */
const steps = new Map<string, DbStepView>();
/**
 * Cumulative `steps` as it stood at the START of the tick (see
 * dbTickStepView): the per-tick census is the difference. A whole-map copy
 * rather than a counter per method, because the map is bounded by the census
 * list below and the tick boundary is the one place a snapshot is free.
 */
let stepsAtTickStart = new Map<string, DbStepView>();
let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
  owedTokens: 0,
  heldForTracker: 0,
  reserve: 0,
  shed: null,
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

/** Card-send outcomes since this isolate booted (see CardSendView). */
export function cardSendView(): CardSendView {
  return { ...cardSend };
}

/**
 * Classify one tick's card work from its phase stamps — pure, so the rule is
 * unit-tested instead of inferred from a live tick (which is the only way to
 * test it at all: the send itself lives inside runOnce, with no offline
 * fixture, past the file-sync window).
 *
 * "cut" wins over "sent" when a telegram stamp is the newest send step: a tick
 * that cut one card and delivered another reports the cut, because the cut is
 * the outcome with a consequence. "deferred" is the trailing `send:claim` with
 * no telegram stamp after it (the claim was opened and no send followed).
 * Stamps are a bounded ring, so this is per-TICK, not per-card — enough for
 * "is the cut rate going down?", and free by construction.
 */
export function classifyCardSend(
  stampsIn: readonly TickPhaseStamp[],
): "cut" | "sent" | "deferred" | null {
  let claimIdx = -1;
  let telegramIdx = -1;
  let trackIdx = -1;
  for (let i = 0; i < stampsIn.length; i += 1) {
    const phase = stampsIn[i].phase;
    if (phase === "send:claim") claimIdx = i;
    else if (phase === "send:telegram") telegramIdx = i;
    else if (phase === "send:track") trackIdx = i;
  }
  if (telegramIdx > trackIdx) return "cut";
  if (trackIdx >= 0) return "sent";
  if (claimIdx >= 0) return "deferred";
  return null;
}

/**
 * Cards the delivery audit shows went out TWICE (see
 * deferrallog.duplicateInitialTokens, which is the rule — this is only the
 * holder, because the worker's tick tail is where the ring is read and this
 * file is where the summary is published).
 *
 * Without it the duplicate rate is an anecdote from the chat: the user reports
 * "PONDER five times between 10:48 and 11:08" and nothing in /health moves.
 * With it, any fix (the scanner-side three-state send in
 * docs/scan-completion-loss.md, or the timing trade recorded there) has a
 * before/after number, and the ring's own decay makes it a rolling window
 * rather than a since-boot total.
 */
export interface DeliveryDuplicatesView {
  /** How many distinct tokens currently show two delivered `initial` cards. */
  count: number;
  /** Up to three of them, for the log/health line. */
  tokens: string[];
  /** Epoch of the last tick that saw at least one (0 = none yet). */
  at: number;
}

let duplicates: DeliveryDuplicatesView = { count: 0, tokens: [], at: 0 };

/** Record this tail's view of the audit ring (an empty list CLEARS the count). */
export function noteDuplicateCards(tokens: readonly string[], now = Date.now()): void {
  const list = tokens.filter((token) => typeof token === "string" && token.length > 0);
  duplicates = {
    count: list.length,
    tokens: list.slice(0, 3),
    at: list.length > 0 ? now : duplicates.at,
  };
}

/** Duplicates visible in the audit ring as of the last completed tail. */
export function deliveryDuplicatesView(): DeliveryDuplicatesView {
  return { ...duplicates, tokens: [...duplicates.tokens] };
}

/** Per-method DB timing since this isolate booted (see the header). */
export function dbStepView(): Record<string, DbStepView> {
  const out: Record<string, DbStepView> = {};
  for (const [name, s] of steps) out[name] = { ...s };
  return out;
}

/**
 * The DB census of the tick that just finished: per method, the CALLS (and
 * ms) it paid inside the probe's tick window — the difference against the
 * snapshot taken at tick start.
 *
 * WHY IT EXISTS (2026-09-25): the invocation's 50 subrequests are shared, and
 * the host split can only say that N of them went to `…turso.io`, never which
 * calls they were. `dbSteps` times three wrapped methods cumulatively since
 * boot — enough to prove a single candidate path, but it cannot answer "what
 * owns the ~20 Turso round trips a tick spends", so every earlier cut in that
 * direction was reasoned from a stage split instead of from a census. This is
 * the reading that decides what to batch next (docs/round-trips.md §4.11).
 *
 * The SCAN's window, not the whole tick: the tracker pass and the write drain
 * publish their own `trips` / `calls` counts, and the tail's writes are the
 * ones this probe must never defer (the drain's failure channel rides
 * `setWorkerState`). Methods that were not called this tick are omitted, so
 * the census stays a list of what actually cost something.
 */
export function dbTickStepView(): Record<string, DbStepView> {
  const out: Record<string, DbStepView> = {};
  for (const [name, s] of steps) {
    const base = stepsAtTickStart.get(name);
    const calls = s.calls - (base?.calls ?? 0);
    if (calls <= 0) continue;
    out[name] = { calls, ms: s.ms - (base?.ms ?? 0) };
  }
  return out;
}

/** The most recent drain plus its cumulative totals (see the header). */
export function writeDrainView(): WriteDrainView {
  return { ...drain, totals: { ...drain.totals } };
}

/**
 * How many deferred RECORDS are still waiting (0 = nothing queued). Records,
 * not calls: the queue coalesces per token (see DeferredBucket), so this is the
 * backlog a reader means by "how much bookkeeping is behind" — the number of
 * owed CALLS is `writeDrainView().pending`.
 */
export function deferredWriteCount(): number {
  return owedRecordCount();
}

/**
 * Subrequests the tracker pass actually spent the last few times it ran in a
 * SCAN TICK's tail (see noteTrackerPassSpend), newest last.
 *
 * WHY MEASURED (2026-09-28): the reserve answered "what does a pass need?" with
 * a constant, and that constant was the whole problem — a flat 14 is the need
 * of a pass that has room, while the pass this bot actually runs defers as soon
 * as its share runs out and so spends 5-8. Measuring turns the reserve into
 * "what this bot's pass has needed HERE", which is the only value that can be
 * right on both a thin rotation and a wide one.
 *
 * The samples come from the TICK path only (see worker.ts's pass call): the
 * pass's own cron delivery owns its whole invocation, so what it spends there
 * says nothing about the room a SHARED invocation leaves.
 */
const trackerPassSpend: number[] = [];

/**
 * Spendable subrequests in a window (src/subreqs.ts's own arithmetic, kept here
 * so that a reading outside it can be rejected as broken rather than believed).
 */
const SUBREQ_USABLE = Math.max(0, SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE);

/**
 * Feed one pass's measured subrequest spend to the drain's reserve (see
 * drainTrackerReserve). Readings outside `[0, SUBREQ_USABLE]` are DROPPED, not
 * clamped: the counter is shared with the peer tracker delivery (see
 * SubreqOwner), so a window opened underneath a running pass shows up as a
 * negative or absurd delta, and a broken reading must not become a policy. Zero
 * IS a real reading — a pass that deferred before its first round trip — and is
 * kept, because the floor clamps it up to what a pass needs anyway.
 */
export function noteTrackerPassSpend(subrequests: number): void {
  if (!Number.isFinite(subrequests)) return;
  if (subrequests < 0 || subrequests > SUBREQ_USABLE) return;
  trackerPassSpend.push(subrequests);
  if (trackerPassSpend.length > TRACKER_PASS_SPEND_RING) trackerPassSpend.shift();
}

/** What the reserve computes from: the worst recent sample, or null if none. */
export function trackerPassSpendView(): { worst: number; samples: number } | null {
  if (trackerPassSpend.length === 0) return null;
  return { worst: Math.max(...trackerPassSpend), samples: trackerPassSpend.length };
}

/**
 * Subrequests this drain must leave for the tracker pass behind it.
 *
 * THREE ANSWERS, in order of precedence:
 *   - the FORCED floor when the queue is over the cap: a backlog that deep is
 *     the drain's own problem, and the pass can afford to defer by name (see
 *     DEFERRED_FORCE_DRAIN_RECORDS);
 *   - the CEILING while no tick-path pass has reported a spend — an unmeasured
 *     isolate behaves exactly as it did before any of this existed;
 *   - the WORST recent measurement, clamped to `[MIN, CEILING]`, which is what
 *     the pass really needs here: a thin rotation then costs the drain a
 *     thinner yield, and a wide one takes the full 14 back.
 */
export function drainTrackerReserve(owed: number = owedRecordCount()): number {
  if (owed >= DEFERRED_FORCE_DRAIN_RECORDS) return DEFERRED_FORCE_DRAIN_FLOOR;
  const measured = trackerPassSpendView();
  if (measured === null) return DRAIN_TRACKER_RESERVE;
  return Math.min(
    DRAIN_TRACKER_RESERVE,
    Math.max(DRAIN_TRACKER_RESERVE_MIN, measured.worst),
  );
}

/**
 * Run every queued write, in call order, and report what it cost. Called by
 * the worker AFTER its completion flush: the tick's own scan race is over, so
 * this round trip can no longer delay a card's claim — it only costs the
 * invocation's tail. Failures are counted and logged, never thrown: the
 * scanner logs its own write failures, and a deferred write has nobody left
 * to catch for it.
 */
/**
 * `subreqLeft` is the invocation's remaining allowance (src/subreqs.ts),
 * injectable for the same reason the tracker pass takes one: so a caller that
 * owns a different window — and every test — can say what "no room left"
 * means. The default reads the live counter.
 */
/**
 * How ONE drain is allowed to spend, for the callers that know something the
 * queue does not — a tick that just backfilled a death lowers its ceiling (see
 * DEFERRED_DEAD_PREDECESSOR_MAX_CALLS). Absent options are the normal ceiling,
 * which is what every other caller wants.
 */
export interface DrainOptions {
  /** Calls this drain may make (see DEFERRED_MAX_CALLS_PER_DRAIN). */
  maxCalls?: number;
  /** Why that ceiling is lower than the normal one (null = it is not). */
  shed?: string | null;
}

export async function drainDeferredWrites(
  subreqLeft: () => number = subreqRemaining,
  opts: DrainOptions = {},
): Promise<WriteDrainView> {
  // One drain at a time. The queue is now edited IN PLACE (see below) rather
  // than swapped out, so a second caller — a slow drain that overlaps the next
  // tick's — must not walk the same entries; it gets the current view instead.
  if (draining) return writeDrainView();
  draining = true;
  const startedAt = dbClock();
  let calls = 0;
  let failures = 0;
  // Resolved ONCE, like the reserve below: the view is built after the try (and
  // by the empty-queue early return), so both readings have to be reachable
  // from there.
  const maxCalls = opts.maxCalls ?? DEFERRED_MAX_CALLS_PER_DRAIN;
  const shed = opts.shed ?? null;
  // The most recent failed entry of THIS drain (see WriteDrainView.lastError).
  // The batch stops at the first failure, so this names the entry that stalled
  // it — the reason /health could never surface before.
  let lastError: WriteDrainView["lastError"] = null;
  // Entries this drain walked past to keep the tracker pass's slice intact.
  let heldForTracker = 0;
  // The subrequests this drain leaves for the pass behind it — resolved once,
  // inside the walk below (see drainTrackerReserve), and published either way.
  // Declared with the other per-drain locals: the view is built after the
  // `finally`, so a `const` inside the try cannot reach it.
  let reserve = 0;
  try {
    if (owedRecordCount() === 0) {
      // Nothing was queued: report the empty batch without erasing the last
      // real drain's stamp, so a reader can tell "nothing to do" from "never
      // drained".
      drain = {
        ...drain,
        calls: 0,
        ms: 0,
        failures: 0,
        pending: 0,
        owedTokens: 0,
        heldForTracker: 0,
        // Nothing was owed, so nothing was held back for the tail.
        reserve: 0,
        // ...and a lowered ceiling stopped nothing (see WriteDrainView.shed).
        shed,
      };
      // An empty queue is also the DRY half of a recovery: if this isolate left
      // a failure row behind, it now describes an incident that is over.
      await clearPersistedDrainError();
      return writeDrainView();
    }
    // Call order matters (the scanner registers a coin before it raises its max
    // mcap), and an entry leaves the queue only once it has LANDED. That makes
    // a drain cut short by the invocation's end hand the rest of the batch —
    // including the call that was in flight — to the next tick's drain.
    //
    // WHY (measured 2026-09-19): the drain is fired WITHOUT being awaited, and
    // a fire-and-forget promise is cancelled when the invocation returns, so
    // its writes rejected at the transport or hard-wall timeout and the old code
    // merely COUNTED them — `writeDrain: 4 calls / 4 failures` (100%), i.e.
    // the token_stats bookkeeping never landed at all. Retrying the failed
    // entry on the next drain turns that permanent data gap into one tick of
    // latency (writeDrain.pending keeps it visible while it waits).
    // One round trip per BUCKET, not per record (see DeferredBucket): the
    // backlog is measured in records (`owedTokens`) but paid for in calls.
    // The yield is resolved ONCE for this drain (see drainTrackerReserve): a
    // reserve that moved while the queue drained would make the batch depend on
    // the order it happened to land in.
    reserve = drainTrackerReserve();
    // A WORKLIST, not one pass over the buckets: a bucket that still owes
    // records after its slice goes to the back (see
    // DEFERRED_MAX_CALLS_PER_DRAIN), so the room above the reserve is spent as
    // whole slices instead of one slice per method per tick.
    const ready = owedBuckets();
    while (ready.length > 0) {
      // The tracker pass runs BEHIND this drain in the same invocation (the
      // worker fires the drain from onTickEnd and calls runTrackerPass in its
      // tail), and it is the stage that both needs the most round trips and has
      // no reservation of its own — it defers by name instead. So the drain
      // yields: a held bucket is not lost, it just waits (see the queue's own
      // "an entry leaves it only once it has landed").
      if (calls >= maxCalls) {
        // The drain's own ceiling (see DEFERRED_MAX_CALLS_PER_DRAIN and
        // DEFERRED_DEAD_PREDECESSOR_MAX_CALLS): the room check below is what
        // normally ends this walk, and this is what ends it when the room
        // reading cannot be trusted to fall — or when the caller lowered the
        // ceiling because this tick has a completion to land (see `shed`).
        heldForTracker = ready.length;
        break;
      }
      if (subreqLeft() <= reserve) {
        heldForTracker = ready.length;
        break;
      }
      const bucket = ready.shift();
      if (!bucket) break;
      calls += 1;
      try {
        await runBucket(bucket);
        // A landed batch proves the handle works, so the count is for
        // CONSECUTIVE failures (the old per-entry rule): without this reset, a
        // bucket that failed twice hours ago would be DROPPED — the whole
        // backlog and all — by a single new failure today.
        bucket.attempts = 0;
        // Still owing records? Its slice is capped at 40, so the rest goes to
        // the back of the rotation: a deep queue catches up INSIDE this tick
        // instead of one slice per method per tick.
        if (bucket.owed.size > 0) ready.push(bucket);
      } catch (err) {
        failures += 1;
        bucket.attempts += 1;
        const message = err instanceof Error ? err.message : err;
        lastError = {
          method: bucket.name,
          name: err instanceof Error ? err.name : "Error",
          message: typeof message === "string" ? message : String(message),
          at: dbClock(),
        };
        const owed = bucket.owed.size;
        if (bucket.attempts >= DEFERRED_WRITE_MAX_ATTEMPTS) {
          bucket.owed.clear();
          console.error(
            `[tickprobe] deferred ${bucket.name} failed ${bucket.attempts}x — dropping ${owed} record(s):`,
            message,
          );
        } else {
          console.error(
            `[tickprobe] deferred ${bucket.name} failed (attempt ${bucket.attempts}/${DEFERRED_WRITE_MAX_ATTEMPTS}) — ${owed} record(s) kept for the next drain:`,
            message,
          );
        }
        // Stop the batch here: the database is what just failed, so another
        // round trip would only burn what is left of this invocation.
        break;
      }
    }
  } finally {
    draining = false;
  }
  const ms = dbClock() - startedAt;
  drain = {
    calls,
    ms,
    at: dbClock(),
    failures,
    lastError,
    pending: owedBuckets().length,
    owedTokens: owedRecordCount(),
    heldForTracker,
    reserve,
    shed,
    totals: {
      calls: drain.totals.calls + calls,
      ms: drain.totals.ms + ms,
      failures: drain.totals.failures + failures,
    },
  };
  // AWAITED, on purpose: this runs in the invocation's tail (the worker hands
  // the whole drain to waitUntil), and a floating write started here would be
  // cancelled the moment the invocation ended — the exact failure mode this
  // record exists to describe. It is also why the copy happens ONLY on a
  // failure: a drain that landed (`lastError === null`) writes nothing, so a
  // healthy tick pays nothing for this.
  if (lastError !== null) {
    await persistDrainError(lastError, owedBuckets().length, owedRecordCount());
  } else {
    // THE RECOVERY HALF (2026-09-25): the row is only ever rewritten by a
    // FAILURE, so without this a single bad minute left it standing forever —
    // live, /health read `writeDrainError` 8.4 hours old (`pending 15`) while
    // every drain behind it had landed, i.e. the field described an incident
    // nobody could act on. A clean drain that had work to do clears it; the
    // flag keeps that from costing a healthy isolate one write per tick.
    await clearPersistedDrainError();
  }
  return writeDrainView();
}

/**
 * Copy a failed drain onto its durable worker_state row (see
 * WRITE_DRAIN_ERROR_KEY), so the reason outlives the isolate that hit it.
 *
 * Best-effort, and deliberately so: the write that just failed may well have
 * failed because the database is unreachable, in which case this one throws
 * too and the record stays on this isolate's view for whoever reads it — which
 * is strictly more than the pre-2026-09-24 behaviour, where nothing left the
 * isolate at all. An over-strict version ("persist or fail the drain") would
 * turn a READABLE backlog into a broken tick, and the backlog is already
 * visible as `pending`.
 *
 * `pending` rides along because it is what separates a blip from the live
 * incident: one failed write with an empty tail is noise, the same reason with
 * 47 waiting behind it is the shape that motivated this field.
 *
 * A clean drain DOES clear the row now (2026-09-25, see
 * clearPersistedDrainError): the record is meant to be an ACTIVE failure, and
 * live it read 8.4h old while every drain behind it had landed. Evidence of a
 * past incident is still readable — /health publishes `writeDrainErrorStale`
 * and the age beside the record — but it can no longer be mistaken for a
 * current one. The clear costs nothing on a healthy isolate: it only runs when
 * THIS one has a row it wrote itself.
 */
async function persistDrainError(
  error: NonNullable<WriteDrainView["lastError"]>,
  pending: number,
  owedTokens: number,
): Promise<void> {
  if (stateWriter === null) return;
  try {
    await stateWriter(
      WRITE_DRAIN_ERROR_KEY,
      JSON.stringify({ ...error, pending, owedTokens }),
    );
    drainErrorPersisted = true;
  } catch {
    // See above: a record that cannot be written must not cost the tail.
  }
}

/**
 * Clear the durable failed-drain row once the drain has recovered — the mirror
 * of persistDrainError, and the fix for a field that stayed `live` for hours
 * after the incident ended (live 2026-09-25: `writeDrainError` 8.4h old with
 * `pending 15`, on a bot whose drains had all landed since).
 *
 * Guarded by `drainErrorPersisted` so a healthy isolate pays NOTHING: only the
 * isolate that wrote the row clears it, and only once. The write is an empty
 * string rather than a DELETE because /health already reads a missing row as
 * `null` — and so it reads an empty one (its parse throws and is caught), which
 * keeps the row's absence and its clearing indistinguishable to every reader
 * while avoiding a new Db method. Best-effort: a refused clear keeps the flag
 * set, so the next clean drain retries it, and `writeDrainErrorStale` still
 * names the record as history in the meantime.
 */
async function clearPersistedDrainError(): Promise<void> {
  if (stateWriter === null || !drainErrorPersisted) return;
  try {
    await stateWriter(WRITE_DRAIN_ERROR_KEY, "");
    drainErrorPersisted = false;
  } catch {
    // Keep the flag: the row is still out there, and the next clean drain is
    // the retry. A failed clear must never cost the drain's own tail.
  }
}

/** Test seam: the probe is module state, like the scanner's own mirrors. */
export function resetTickProbe(): void {
  view = null;
  tickStartedAt = 0;
  stamps = [];
  buckets = [];
  opaqueRecords = 0;
  // The pass measurements go with the buckets they reserve against: a test that
  // measures a spend must not leak it into the next test's drain.
  trackerPassSpend.length = 0;
  steps.clear();
  // The census baseline goes with the cumulative map it was copied from:
  // a stale snapshot would subtract another run's calls from this one's.
  stepsAtTickStart = new Map();
  dbClock = () => Date.now();
  draining = false;
  stateWriter = null;
  drainErrorPersisted = false;
  drain = {
    calls: 0,
    ms: 0,
    at: 0,
    failures: 0,
    lastError: null,
    pending: 0,
    owedTokens: 0,
    heldForTracker: 0,
    reserve: 0,
    shed: null,
    totals: { calls: 0, ms: 0, failures: 0 },
  };
  cardSend = { sent: 0, cut: 0, deferred: 0, lastCutAt: 0, lastCutMs: 0 };
}

function noteStep(name: string, ms: number): void {
  const seen = steps.get(name) ?? { calls: 0, ms: 0 };
  steps.set(name, { calls: seen.calls + 1, ms: seen.ms + ms });
}

/**
 * The census label for one call: a `worker_state` read or write names its KEY.
 *
 * WHY (2026-09-26, live): the census did what it was built for — a tick's scan
 * read `getWorkerState 5 calls / 2559ms` against a ~20-round-trip tick, i.e.
 * the single largest method in the window — and then stopped one step short of
 * being actionable: `getWorkerState` is the SHARED read of ~40 keys (the gate
 * rows, the tracker's holder stamp, the axiom session, the push-failure
 * record), so "5 calls" cannot say which five, and the next merge (the whole
 * point of the census, docs/round-trips.md §4.11) needs the names. The two
 * methods are generic by design and their CALLERS are what cost the round
 * trips, so the key rides the label: `getWorkerState:axiom_access_token 2`.
 *
 * Only these two: every other method in the census list is already a specific
 * operation (`claimPushWatchChecksMany`, `readScanFront`), and labelling them
 * would only multiply the map's keys. The label is a pure function of the
 * call's own arguments, so the cumulative `dbSteps` and the per-tick
 * `dbTickSteps` stay comparable.
 */
export function dbStepLabel(name: string, args: readonly unknown[]): string {
  if (name !== "getWorkerState" && name !== "setWorkerState") return name;
  const key = typeof args[0] === "string" ? args[0] : "";
  return key.length > 0 ? `${name}:${key}` : name;
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
  /**
   * The coalescing rule for a deferred call (see DeferredBucket). REQUIRED when
   * `defer` is on: the probe refuses to defer a call it cannot merge by token,
   * because the un-coalesced queue is what grew without bound.
   */
  absorb?: (owed: Map<string, unknown>, args: readonly unknown[]) => void,
  rank = 0,
): void {
  const original = target[name];
  if (typeof original !== "function") return;
  // BOUND to its handle, on purpose (live 2026-09-27): the deferred path runs
  // this LATER, from the drain (see runBucket), where `bucket.call(payload)`
  // has no receiver — a real Db method reached that way threw `TypeError:
  // this.get is not a function` in 0ms on every drain call, and after three
  // attempts it dropped a whole owed bucket (313 registrations). The offline
  // fakes are `this`-free, so only the binding keeps the production shape.
  const call = (original as (...args: unknown[]) => Promise<unknown>).bind(target);
  target[name] = (...args: unknown[]): Promise<unknown> => {
    // One label per CALL, not per wrapper: this wrapper is shared by every
    // key the tick happens to read or write, and for the two worker_state
    // methods the KEY is exactly what the census has to name (see
    // dbStepLabel).
    const label = dbStepLabel(name, args);
    if (!defer || !tickActive || !absorb) {
      const at = dbClock();
      return call.apply(target, args).then(
        (value) => {
          noteStep(label, dbClock() - at);
          return value;
        },
        (err: unknown) => {
          noteStep(label, dbClock() - at);
          throw err;
        },
      );
    }
    // Deferred: the scanner keeps its already-resolved promise, the record
    // goes into this method's bucket, and the drain lands it (see
    // drainDeferredWrites / runBucket — the timing note is taken there, where
    // the call REALLY runs).
    bucketFor(name, rank, call, absorb).absorb(args);
    return Promise.resolve();
  };
}

/**
 * The bounds the census wraps: every Db method a tick's scan is known to call,
 * timed (never deferred) so `summary.dbTickSteps` can name what the
 * subrequest split only attributes to Turso as a total.
 *
 * WHY THESE: measured live 2026-09-25 — a cron tick's window read `total 32`
 * with `turso 29`, and the tick's DB work is ~20 DISTINCT one-shot calls
 * rather than one fat loop (the tracker row loop is already a single batch:
 * `claimPushWatchChecksMany` pipelines ~28 CAS statements into one request,
 * and the pass note reads `rows 282/1`). A census is the only way to see
 * which of them still deserve to be merged into that same shape.
 *
 * A method that does not exist on the handle is skipped by wrapDbMethod, and
 * the three wrapped above are excluded (a second wrap would count every call
 * twice in noteStep).
 */
const CENSUS_METHODS = [
  "getWorkerState",
  "getWorkerStates",
  "setWorkerState",
  "setWorkerStatesMany",
  "listEnabledChats",
  "listPushWatch",
  "getPushAudit",
  "readPostScanTelemetry",
  "claimScanLock",
  "releaseScanLock",
  "getReevalPool",
  // The scan front's ONE read + ONE write (src/db.ts, docs/round-trips.md §4.13):
  // in the census because the merge's whole promise is a ROUND TRIP count — the
  // rows it carries used to arrive as `getWorkerState` ×3 + `listEnabledChats`,
  // and a batching decision has to be readable from the same census that made it.
  "readScanFront",
  "writeScanFront",
  "isTokenSeen",
  "listSeenTokens",
  "getTokenStats",
  "getTokenPushedInfo",
  "resumeLaunchBackfill",
  "pruneOldTokenStats",
  "recordObservedLiquidity",
  // The freshness mark's advance (src/db.ts, docs/pool-freshness-mark-2026-10-08.md):
  // flushed from the SAME tail as the observed liquidity above, so a tick's
  // outbound round trips are only complete if both are censused.
  "noteSweptWithoutReading",
  "persistScanCompletion",
  "writeScheduledTick",
  "stampScheduledArrival",
  "recordTokenStats",
  "updateTokenSupplyFlow",
  "updateTokenRugcheckData",
  "updateTokenProTraders",
  "updateTokenSniperPct",
  "recordPushDelivery",
  "claimRecapsAndPrune",
  "findUntrackedPushesAndLedger",
  "repairPushWatchBaselines",
  "claimAndReservePushWatch",
  "claimPushWatchChecksMany",
  "updatePushWatchCheck",
  "repinPushWatchPools",
  "upsertPushWatchMany",
  "setPushWatchHoldersMany",
  "rearmPushWatchAlert",
];

/**
 * Wrap the tick's DB methods: the three the gates use (one read, two
 * deferrable writes — see the header) plus the census list, which is only ever
 * TIMED.
 */
function wrapDb(db: TickProbeDb, deferWrites: boolean): void {
  if (wrapped.has(db as object)) return;
  wrapped.add(db as object);
  const target = db as Record<string, unknown>;
  // Reads keep their contract (the gates consume the result in this tick).
  wrapDbMethod(target, "getTokenStatsMany", false);
  // Writes: registration + raise-only bookkeeping, neither read by the gates.
  // The merge rules are the two coalescing absorbs (see DeferredBucket), and
  // the ranks fix the order they LAND in: a registration must exist before a
  // raise for the same token can match it.
  wrapDbMethod(target, "recordTokenStatsMany", deferWrites, absorbFirstWins, 0);
  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites, absorbMaxWins, 1);
  // The census: timed, never deferred (see CENSUS_METHODS). `setWorkerState`
  // is in it on purpose — the header's warning is about DEFERRING it (it is
  // the channel a failed drain publishes its own reason through), and a timed
  // wrapper keeps that record immediate while making the channel visible.
  //
  // `deferWrites` is deliberately NOT consulted here: a deferred write moves
  // the cost to a different tick, which would make the census a lie about the
  // tick it is measuring.
  for (const name of CENSUS_METHODS) {
    if (name === "getTokenStatsMany" || name === "recordTokenStatsMany") {
      continue; // wrapped above — a second wrap would double-count in noteStep
    }
    if (name === "updateTokenMaxMcaps") continue; // wrapped above
    wrapDbMethod(target, name, false);
  }
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
    // The durable-row writer, captured here because this is where the handle
    // is in scope (see TickProbeDb.setWorkerState). A handle without one (every
    // offline test's fake) leaves this null and the failure record stays local.
    const writer = (hooks.db as TickProbeDb).setWorkerState;
    stateWriter =
      typeof writer === "function"
        ? (key, value) => writer.call(hooks.db, key, value)
        : null;
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
      // Same stamp, counted against the invocation's subrequest budget: the
      // phase points are what say WHERE a tick spent it, and they survive on
      // the isolate even when the invocation dies on it (see subreqView).
      markSubreqPhase(name, now());
    };
  }
  // The probe is forwarded, not dropped: the wrapper owns the worker's call
  // site (`scanner.runOnce(subreqRemaining)`), and a scanner that silently
  // fell back to the module counter would make the floor's seam dead in
  // production while every test still passed.
  target.runOnce = async (subreqLeft?: () => number): Promise<unknown> => {
    tickStartedAt = now();
    stamps = [];
    view = null;
    tickActive = true;
    // The census' zero point: everything the scan pays from here is THIS
    // tick's (see dbTickStepView).
    stepsAtTickStart = new Map([...steps].map(([name, s]) => [name, { ...s }]));
    try {
      hooks.onTickStart?.();
    } catch {
      // A prefetch is an optimisation; it may never cost the tick.
    }
    try {
      return await runOnce(subreqLeft);
    } finally {
      // Tick over: a straggler write from here on is awaited by its caller
      // again (the queue keeps only what the tick itself queued).
      tickActive = false;
      const captured = stamps;
      view = {
        phases: captured,
        tickMs: captured.length > 0 ? captured[captured.length - 1].ms : now() - tickStartedAt,
      };
      // Card outcome for THIS tick, folded into the cumulative counters. Read
      // from the stamps rather than from the summary's counters because the
      // stamps are what say whether the send RETURNED — `pushed` and
      // `cardSendDeferred` cannot tell a delivered card from a cut one, which
      // is the whole question here.
      const outcome = classifyCardSend(captured);
      if (outcome !== null) {
        cardSend[outcome] += 1;
        if (outcome === "cut") {
          cardSend.lastCutAt = now();
          cardSend.lastCutMs = captured.length > 0 ? captured[captured.length - 1].ms : 0;
        }
      }
      if (target.lastSummary && typeof target.lastSummary === "object") {
        const summary = target.lastSummary as Record<string, unknown>;
        // GeckoTerminal's feed state (src/geckoterminal.ts). The summary's own
        // `geo` / `geoTrend` counts say the feed returned nothing; this says
        // WHY — a 429 streak, the backoff window it armed, and whether the
        // Cloudflare edge cache is answering instead of the rate-limited
        // origin. Needed because the 2026-09-20 measurement (worker egress
        // 429ed on every attempt, `geo 0 / geoTrend 0` on every tick) was
        // otherwise indistinguishable from a quiet market.
        //
        // OUTSIDE the phase guard below on purpose (2026-09-21). Every
        // `markPhase` call sits in the per-candidate chain, so a tick that
        // evaluated NO candidate collected no stamps — and the guard that
        // gates `phases` / `cardSend` therefore swallowed this record too.
        // Most ticks are candidate-less, and `geo 0` is precisely a
        // candidate-less signature, so the one number built to explain it was
        // unreadable exactly when a reader needed it (live: `summary.gecko`
        // was absent on 8 of 8 polls while `geo` read 0 on every one). The
        // feed state is a cumulative view of the client, not a tick-scoped
        // stamp, so it belongs to every tick.
        summary.gecko = geckoFeedStats();
        // GMGN rides along for the same reason (see gmgn.GmgnFeedStats): its
        // edge 429s a Worker's egress IP, and whether the client is currently
        // paused (and for how long) is the difference between "GMGN is
        // blocked" and "GMGN is being re-probed every tick for nothing".
        summary.gmgnFeed = gmgnFeedStats();
        // The census of THIS tick's scan window (see dbTickStepView). The
        // subrequest host split says how much went to Turso; this says which
        // calls it was, which is what a batching decision needs.
        summary.dbTickSteps = dbTickStepView();
        if (marker !== null && captured.length > 0) {
          summary.phases = captured;
          // Published here rather than by the worker's onTickEnd hook: this
          // file is inside the file-sync window and worker.ts's telemetry
          // block is not, and the summary is the channel the completion
          // heartbeat already serializes.
          summary.cardSend = cardSendView();
          summary.deliveryDuplicates = deliveryDuplicatesView();
        }
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
