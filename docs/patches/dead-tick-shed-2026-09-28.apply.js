#!/usr/bin/env node
/**
 * 2026-09-28 — the tick that backfilled a death sheds its drain, and the drain
 * stops racing the completion flush (src/worker.ts).
 *
 * FOUR anchored edits, idempotent, no regex:
 *
 *   B. `deadPredecessorThisTick` + the two pure helpers (drainCallCeiling /
 *      drainShedReason) next to DEAD_TICK_STREAK_RESET.
 *   A. runScan sets that flag from the death it backfilled.
 *   C. the drain is removed from tickprobe's onTickEnd hook — that hook runs
 *      BEFORE the worker's completion flush (it is the scanner's runOnce
 *      wrapper's `finally`), so the drain used to spend up to
 *      DEFERRED_MAX_CALLS_PER_DRAIN round trips in front of the one write a
 *      tick cannot lose.
 *   D. the drain is fired from the tick's tail instead, right behind the flush
 *      and in front of the tracker pass, with its ceiling lowered to one call
 *      when this tick backfilled a death
 *      (DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).
 *
 * Run: node docs/patches/dead-tick-shed-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(file, "utf8");

let ok = true;
/**
 * `marker` is a string that exists ONLY once this edit has been applied. Every
 * anchor below is deliberately PRESERVED by the edit (insert-after style), so
 * "the anchor is still there" cannot mean "not applied yet" — the marker is what
 * makes a second run a no-op instead of a duplicate.
 */
function patch(label, anchor, next, marker) {
  if (src.includes(marker)) {
    console.log(`= ${label}: already applied`);
    return;
  }
  const at = src.indexOf(anchor);
  if (at === -1) {
    console.log(`✗ ${label}: anchor NOT found`);
    ok = false;
    return;
  }
  if (src.indexOf(anchor, at + 1) !== -1) {
    console.log(`✗ ${label}: anchor is not unique`);
    ok = false;
    return;
  }
  src = src.slice(0, at) + next + src.slice(at + anchor.length);
  console.log(`✓ ${label}`);
}

// ── B: the flag and the pure ceiling rule ────────────────────────────────────
patch(
  "B/flag+helpers",
  "export const DEAD_TICK_STREAK_RESET = 2;",
  `export const DEAD_TICK_STREAK_RESET = 2;

/**
 * Whether the tick currently running backfilled a dead predecessor — i.e. THIS
 * is the tick that has to prove a wave of deaths is over. Module state because
 * the two places that need it live in different scopes: runScan proves it (see
 * the backfill there) and the drain, fired from the tick's tail, spends by it
 * (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).
 */
let deadPredecessorThisTick = false;

/**
 * The drain's call ceiling for a tick (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS
 * and DEFERRED_MAX_CALLS_PER_DRAIN). Pure + exported so the rule is unit-tested
 * (scripts/test-tick-path.js) instead of only observed in production.
 */
export function drainCallCeiling(deadPredecessor: boolean): number {
  return deadPredecessor
    ? DEFERRED_DEAD_PREDECESSOR_MAX_CALLS
    : DEFERRED_MAX_CALLS_PER_DRAIN;
}

/**
 * The reason to publish when that ceiling is the lowered one (see the drain's
 * \`shed\` field), or null when this tick drains at the normal ceiling.
 */
export function drainShedReason(deadPredecessor: boolean): string | null {
  return deadPredecessor ? "dead-predecessor" : null;
}`,
  "let deadPredecessorThisTick = false;",
);

// ── A: runScan records the death it backfilled ───────────────────────────────
patch(
  "A/flag set",
  `  const dead = prevHeartbeatRaw
    ? deadTickBackfillInfo(prevHeartbeatRaw, Date.now(), BACKFILL_STALE_MS)
    : null;`,
  `  const dead = prevHeartbeatRaw
    ? deadTickBackfillInfo(prevHeartbeatRaw, Date.now(), BACKFILL_STALE_MS)
    : null;
  // THIS tick's own account of what it found, for the tail that spends by it:
  // the drain behind the completion flush lands ONE call when this tick is the
  // one that has to prove the deaths are over (see
  // DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).
  deadPredecessorThisTick = dead !== null;`,
  "deadPredecessorThisTick = dead !== null;",
);

// ── C: the drain leaves the pre-flush hook ───────────────────────────────────
patch(
  "C/drain removed from onTickEnd",
  `            // Fire the drain WITHOUT awaiting it: the tick's budget is done
            // with these writes (that is the whole point of deferring them),
            // so the invocation tail must not pay for them either. The queue
            // is module state, so an isolate recycled before the drain lands
            // simply hands the same calls to the next tick's drain -- in call
            // order, which is the order the scanner wrote them in (the
            // registration insert first, then the max-mcap UPDATE). Same
            // pattern the deferral-counter sync already relies on ("its
            // promise is left running -- an idempotent write is welcome to
            // land late").
            const drained = drainDeferredWrites().then(() => flushObservedLiquidity());
            // Keep the isolate alive for it when the handler handed us a
            // waitUntil (see tickWaitUntil): an un-awaited promise is
            // cancelled the instant the handler returns, which is exactly
            // why these writes never landed on the cron path.
            if (tickWaitUntil) {
              try {
                tickWaitUntil(drained);
              } catch {
                // A stale context must never break the tick's tail.
                void drained;
              }
            } else {
              void drained;
            }
`,
  `            // The deferral drain is deliberately NOT fired here (moved
            // 2026-09-28 to the tick's tail — see the tracker pass below).
            // This hook runs BEFORE the worker's completion flush: it is the
            // scanner's runOnce wrapper's \`finally\`, and the flush payload is
            // only built once runOnce returns. Firing here therefore put up to
            // DEFERRED_MAX_CALLS_PER_DRAIN bookkeeping round trips IN FRONT of
            // the one write a tick cannot lose, while the drain's own contract
            // said "called by the worker AFTER its completion flush". Live
            // 2026-09-28 00:33-00:53Z: twelve cron ticks in twenty minutes
            // lost their completion while this hook was free to spend ten
            // calls behind each of them. \`writeDrain\` above still describes
            // the drain that ran after the PREVIOUS tick, unchanged by the
            // move.
`,
  "The deferral drain is deliberately NOT fired here",
);

// ── D1: the drain, from the tail, behind the flush ───────────────────────────
patch(
  "D1/drain fired in the tail",
  `      // Post-push tracker pass`,
  `      // Deferred-write drain (with the observed-liquidity persist chained
      // behind it): the tick's bookkeeping, fired AFTER the completion flush
      // above — the order its own contract always claimed, and the reason it
      // moved out of tickprobe's onTickEnd (that hook runs before this flush,
      // so it used to spend up to DEFERRED_MAX_CALLS_PER_DRAIN round trips in
      // front of the one write a tick cannot lose).
      //
      // Fired WITHOUT awaiting it, held by waitUntil: the invocation tail must
      // not pay for these writes, and the queue is module state, so an isolate
      // recycled before the batch lands hands the same calls — in the same
      // order — to the next tick's drain (the registration insert first, then
      // the max-mcap UPDATE).
      //
      // ONE call when this tick backfilled a dead predecessor
      // (DEFERRED_DEAD_PREDECESSOR_MAX_CALLS): that tick is the one that has to
      // prove the deaths are over, so the invocation's remaining allowance goes
      // to the pass below and to the deferral sync behind it — and whatever
      // this drain does not land stays owed, because the queue coalesces.
      const drained = drainDeferredWrites(subreqRemaining, {
        maxCalls: drainCallCeiling(deadPredecessorThisTick),
        shed: drainShedReason(deadPredecessorThisTick),
      }).then(() => flushObservedLiquidity());
      if (tickWaitUntil) {
        try {
          tickWaitUntil(drained);
        } catch {
          // A stale context must never break the tick's tail.
          void drained;
        }
      } else {
        void drained;
      }
      // Post-push tracker pass`,
  "const drained = drainDeferredWrites(subreqRemaining, {",
);

// ── D2: that comment's "FIRST tail work" is no longer true ───────────────────
patch(
  "D2/tail-work wording",
  `the tick's FIRST tail work, funded by the`,
  `the tick's LARGEST tail work, funded by the`,
  "the tick's LARGEST tail work",
);

if (src !== fs.readFileSync(file, "utf8")) {
  fs.writeFileSync(file, src);
  console.log("wrote src/worker.ts");
} else {
  console.log("src/worker.ts unchanged");
}
process.exit(ok ? 0 : 1);
