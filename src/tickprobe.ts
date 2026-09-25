import { geckoFeedStats } from "./geckoterminal";
import { gmgnFeedStats } from "./gmgn";
// The subrequest window is stamped here, because this wrapper is the only
// place that sees EVERY phase the scanner marks (see src/subreqs.ts): the
// scanner itself is past the file-sync window, and the probe already
// intercepts its marker.
import { markSubreqPhase, subreqRemaining } from "./subreqs";

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
 *
 * 2026-09-20: a deferred write that FAILED used to be counted and dropped
 * (live measurement: `writeDrain` 4 calls / 4 failures = 100%, because an
 * un-awaited drain is cancelled when the invocation returns and its writes
 * reject). The queue now owns the retry — an entry leaves it only once it has
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
   * statement). The name is the queue entry's own, i.e. the real Db method.
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
   * Calls still waiting after this drain (0 = the queue is empty). A failed
   * write is NOT dropped: it stays at the head of the queue and is retried by
   * the next drain, so `failures > 0` with `pending > 0` reads as "the last
   * tick's batch did not land yet", not "lost".
   */
  pending: number;
  /**
   * Entries this drain did NOT touch because the tracker pass behind it still
   * needed the invocation's subrequest allowance (see DRAIN_TRACKER_RESERVE).
   * Deliberately separate from `pending`, which also counts a batch stopped by
   * a failure: `pending 3 failures 0` is a held batch, `pending 3 failures 1` is
   * a database that just refused a write. Neither drops anything.
   */
  heldForTracker: number;
  /** Cumulative since the isolate booted, so the effect is readable either way. */
  totals: { calls: number; ms: number; failures: number };
}

/**
 * How many times one deferred write may fail before it is dropped. The calls
 * are idempotent (INSERT OR IGNORE / raise-only UPDATE), so retrying is free of
 * consequence; the bound exists so a database that is down for hours cannot
 * grow the in-memory queue without limit.
 */
export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;

/**
 * Subrequests the write drain leaves for the TRACKER PASS behind it.
 *
 * WHY A FLOOR (live 2026-09-25, ~41 minutes of starvation): the drain is fired
 * from the worker's `onTickEnd` — i.e. as soon as the scan ends, which is
 * BEFORE the tracker pass in that invocation's tail — and it walks its queue
 * with no ceiling at all: `while (queue.length > 0)`. Its cost is therefore
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
 */
export const DRAIN_TRACKER_RESERVE = 14;

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
 * One deferred write waiting for the drain. `attempts` counts FAILED runs: an
 * entry leaves the queue when it lands, or after DEFERRED_WRITE_MAX_ATTEMPTS
 * (see drainDeferredWrites for why the queue, not the batch, owns the state).
 */
interface DeferredCall {
  name: string;
  run: () => Promise<unknown>;
  attempts: number;
}

/** Writes waiting for the drain, in call order. */
let queue: DeferredCall[] = [];
/** One drain at a time — the queue is walked in place (see drainDeferredWrites). */
let draining = false;
/**
 * The wrapped handle's durable-row writer, captured in installTickProbe. Only
 * a FAILED drain uses it (see persistDrainError), so an isolate that never
 * fails a deferred write pays nothing for it.
 */
let stateWriter: ((key: string, value: string) => Promise<unknown>) | null = null;
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
  heldForTracker: 0,
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
/**
 * `subreqLeft` is the invocation's remaining allowance (src/subreqs.ts),
 * injectable for the same reason the tracker pass takes one: so a caller that
 * owns a different window — and every test — can say what "no room left"
 * means. The default reads the live counter.
 */
export async function drainDeferredWrites(
  subreqLeft: () => number = subreqRemaining,
): Promise<WriteDrainView> {
  // One drain at a time. The queue is now edited IN PLACE (see below) rather
  // than swapped out, so a second caller — a slow drain that overlaps the next
  // tick's — must not walk the same entries; it gets the current view instead.
  if (draining) return writeDrainView();
  draining = true;
  const startedAt = dbClock();
  let calls = 0;
  let failures = 0;
  // The most recent failed entry of THIS drain (see WriteDrainView.lastError).
  // The batch stops at the first failure, so this names the entry that stalled
  // it — the reason /health could never surface before.
  let lastError: WriteDrainView["lastError"] = null;
  // Entries this drain walked past to keep the tracker pass's slice intact.
  let heldForTracker = 0;
  try {
    if (queue.length === 0) {
      // Nothing was queued: report the empty batch without erasing the last
      // real drain's stamp, so a reader can tell "nothing to do" from "never
      // drained".
      drain = { ...drain, calls: 0, ms: 0, failures: 0, pending: 0, heldForTracker: 0 };
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
    while (queue.length > 0) {
      // The tracker pass runs BEHIND this drain in the same invocation (the
      // worker fires the drain from onTickEnd and calls runTrackerPass in its
      // tail), and it is the stage that both needs the most round trips and has
      // no reservation of its own — it defers by name instead. So the drain
      // yields: a held entry is not lost, it just waits (see the queue's own
      // "an entry leaves it only once it has landed").
      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {
        heldForTracker = queue.length;
        break;
      }
      const call = queue[0];
      calls += 1;
      try {
        await call.run();
        queue.shift();
      } catch (err) {
        failures += 1;
        call.attempts += 1;
        const message = err instanceof Error ? err.message : err;
        lastError = {
          method: call.name,
          name: err instanceof Error ? err.name : "Error",
          message: typeof message === "string" ? message : String(message),
          at: dbClock(),
        };
        if (call.attempts >= DEFERRED_WRITE_MAX_ATTEMPTS) {
          queue.shift();
          console.error(
            `[tickprobe] deferred ${call.name} failed ${call.attempts}x — dropping it:`,
            message,
          );
        } else {
          console.error(
            `[tickprobe] deferred ${call.name} failed (attempt ${call.attempts}/${DEFERRED_WRITE_MAX_ATTEMPTS}) — kept for the next drain:`,
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
    pending: queue.length,
    heldForTracker,
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
  if (lastError !== null) await persistDrainError(lastError, queue.length);
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
 * A clean drain never clears the row. The last thing that went wrong is
 * evidence, and after a real outage the operator is reading /health hours
 * later, on a different isolate.
 */
async function persistDrainError(
  error: NonNullable<WriteDrainView["lastError"]>,
  pending: number,
): Promise<void> {
  if (stateWriter === null) return;
  try {
    await stateWriter(WRITE_DRAIN_ERROR_KEY, JSON.stringify({ ...error, pending }));
  } catch {
    // See above: a record that cannot be written must not cost the tail.
  }
}

/** Test seam: the probe is module state, like the scanner's own mirrors. */
export function resetTickProbe(): void {
  view = null;
  tickStartedAt = 0;
  stamps = [];
  queue = [];
  steps.clear();
  // The census baseline goes with the cumulative map it was copied from:
  // a stale snapshot would subtract another run's calls from this one's.
  stepsAtTickStart = new Map();
  dbClock = () => Date.now();
  draining = false;
  stateWriter = null;
  drain = {
    calls: 0,
    ms: 0,
    at: 0,
    failures: 0,
    lastError: null,
    pending: 0,
    heldForTracker: 0,
    totals: { calls: 0, ms: 0, failures: 0 },
  };
  cardSend = { sent: 0, cut: 0, deferred: 0, lastCutAt: 0, lastCutMs: 0 };
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
      attempts: 0,
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
  "isTokenSeen",
  "listSeenTokens",
  "getTokenStats",
  "getTokenPushedInfo",
  "resumeLaunchBackfill",
  "pruneOldTokenStats",
  "recordObservedLiquidity",
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
  "claimPushWatch",
  "claimPushWatchChecksMany",
  "reservePushWatchAlert",
  "updatePushWatchCheck",
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
  wrapDbMethod(target, "recordTokenStatsMany", deferWrites);
  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites);
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
