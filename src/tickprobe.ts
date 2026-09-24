import { geckoFeedStats } from "./geckoterminal";
import { gmgnFeedStats } from "./gmgn";
// The subrequest window is stamped here, because this wrapper is the only
// place that sees EVERY phase the scanner marks (see src/subreqs.ts): the
// scanner itself is past the file-sync window, and the probe already
// intercepts its marker.
import { markSubreqPhase } from "./subreqs";

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
  /**
   * The most recent failed deferred write — which method it was, the error
   * text, and when it happened — or null while nothing has failed since this
   * isolate booted.
   *
   * WHY it is on the wire: /health's `writeDrain` reports `pending` and
   * `failures` but never the REASON, which only ever reached `wrangler tail`.
   * Live 2026-09-24: `pending 47`, `totals {calls 57, ms 17759, failures
   * 38}` — a backlog of 47 writes with 67% of attempts failing — and no public
   * surface could say WHY (a transport abort, a Turso 5xx, a write too large,
   * a conflict), so the one number that decides the fix was unreadable outside
   * the dashboard. The drain stops its batch at the first failure (see
   * drainDeferredWrites), so this names the entry that stalled it.
   */
  lastError: { name: string; message: string; at: number } | null;
  /**
   * Calls still waiting after this drain (0 = the queue is empty). A failed
   * write is NOT dropped: it stays at the head of the queue and is retried by
   * the next drain, so `failures > 0` with `pending > 0` reads as "the last
   * tick's batch did not land yet", not "lost".
   */
  pending: number;
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
/** Cumulative per-method timing for this isolate. */
const steps = new Map<string, DbStepView>();
let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
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
  try {
    if (queue.length === 0) {
      // Nothing was queued: report the empty batch without erasing the last
      // real drain's stamp, so a reader can tell "nothing to do" from "never
      // drained".
      drain = { ...drain, calls: 0, ms: 0, failures: 0, pending: 0 };
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
    totals: {
      calls: drain.totals.calls + calls,
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
  draining = false;
  drain = {
    calls: 0,
    ms: 0,
    at: 0,
    failures: 0,
    lastError: null,
    pending: 0,
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
      // Same stamp, counted against the invocation's subrequest budget: the
      // phase points are what say WHERE a tick spent it, and they survive on
      // the isolate even when the invocation dies on it (see subreqView).
      markSubreqPhase(name, now());
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
