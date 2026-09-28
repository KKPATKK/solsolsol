#!/usr/bin/env node
/**
 * 2026-09-28 — REVERT the drain-ordering half of the previous commit, keep the
 * shed half.
 *
 * MEASURED, not assumed (new build live 02:21:40Z): with the drain fired after
 * the completion flush, `writeDrain` read `calls 0` on every tick and
 * `owedTokens` climbed 124 -> 244 -> 293 -> 344 -> 420 (pinned at the force cap,
 * where the forced floor still only bought one call). The build before it read
 * `calls 1-4` with the same queue falling again. Reason: post-flush there is no
 * room left — the drain's own check is `subreqRemaining() <= reserve`, and the
 * flush's round trips have already been spent, so the walk never starts. The
 * completion flush is protected instead by the death-driven shed (one call on
 * the tick that backfilled a death), which costs the queue nothing else.
 *
 * FIVE anchored edits (worker.ts x3, tickprobe.ts x1, test-unit.js x1),
 * idempotent, no regex.
 *
 * Run: node docs/patches/dead-tick-shed-revert-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
let ok = true;

function apply(rel, edits) {
  const file = path.join(root, rel);
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const edit of edits) {
    if (src.includes(edit.marker)) {
      console.log(`= ${rel} ${edit.label}: already applied`);
      continue;
    }
    const at = src.indexOf(edit.anchor);
    if (at === -1) {
      console.log(`✗ ${rel} ${edit.label}: anchor NOT found`);
      ok = false;
      continue;
    }
    if (src.indexOf(edit.anchor, at + 1) !== -1) {
      console.log(`✗ ${rel} ${edit.label}: anchor is not unique`);
      ok = false;
      continue;
    }
    src = src.slice(0, at) + edit.next + src.slice(at + edit.anchor.length);
    console.log(`✓ ${rel} ${edit.label}`);
  }
  if (src !== before) fs.writeFileSync(file, src);
}

apply("src/worker.ts", [
  // ── the fire comes back to the hook it was always in ─────────────────────
  {
    label: "R1/drain back in onTickEnd",
    marker: "const drained = drainDeferredWrites(subreqRemaining, {",
    anchor: `            // The deferral drain is deliberately NOT fired here (moved
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
    next: `            // Fire the drain WITHOUT awaiting it — and, on a tick that
            // backfilled a death, under a ONE-CALL ceiling: the tick's budget
            // is done with these writes (that is the whole point of deferring
            // them), so the invocation tail must not pay for them either. The
            // queue is module state, so an isolate recycled before the drain
            // lands simply hands the same calls to the next tick's drain -- in
            // call order, which is the order the scanner wrote them in (the
            // registration insert first, then the max-mcap UPDATE). Same
            // pattern the deferral-counter sync already relies on ("its
            // promise is left running -- an idempotent write is welcome to
            // land late").
            //
            // THIS HOOK RUNS BEFORE THE COMPLETION FLUSH (it is the scanner's
            // runOnce wrapper \`finally\`), so these round trips do sit in front
            // of the one write a tick cannot lose, and that is deliberate:
            // moving the drain behind the flush was shipped 2026-09-28 02:21Z
            // and reverted within the hour, because post-flush there is NO
            // room left — the check below is \`subreqRemaining() <= reserve\`
            // and the flush has already spent its share, so the queue stopped
            // draining outright (\`calls 0\` on every tick, \`owedTokens\`
            // 124 -> 244 -> 293 -> 344 -> 420 pinned at the force cap) against
            // \`calls 1-4\` with a queue that fell again on the build before it.
            // What protects the flush instead is the death-driven shed: the
            // tick that backfilled a death — the one that has to land a
            // completion to end the stretch — spends ONE call here instead of
            // up to DEFERRED_MAX_CALLS_PER_DRAIN. Moving the drain safely
            // would need a real budget SPLIT (an explicit share for the drain,
            // the flush and the pass) rather than one reserve they take turns
            // measuring against.
            const drained = drainDeferredWrites(subreqRemaining, {
              maxCalls: drainCallCeiling(deadPredecessorThisTick),
              shed: drainShedReason(deadPredecessorThisTick),
            }).then(() => flushObservedLiquidity());
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
  },
  // ── and the tail block goes away ─────────────────────────────────────────
  {
    label: "R2/tail block removed",
    marker: "// Post-push tracker pass — the tick's FIRST tail work",
    anchor: `      // Deferred-write drain (with the observed-liquidity persist chained
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
      // Post-push tracker pass — the tick's LARGEST tail work, funded by the`,
    next: `      // Post-push tracker pass — the tick's FIRST tail work, funded by the`,
  },
  // ── the pass comment's own ordering note is true again ───────────────────
  {
    label: "R3/flag comment",
    marker: "the drain, fired from the tick's tail, spends by it",
    anchor: ` * the two places that need it live in different scopes: runScan proves it (see
 * the backfill there) and the drain, fired from the tick's tail, spends by it
 * (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).`,
    next: ` * the two places that need it live in different scopes: runScan proves it (see
 * the backfill there) and the drain, fired from the tick-end hook, spends by it
 * (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).`,
  },
]);

apply("src/tickprobe.ts", [
  {
    label: "R4/constant comment",
    marker: "and the drain is fired from that same tick, in front of",
    anchor: ` * ends the stretch — and the drain sits behind that flush in the SAME
 * invocation. Live 2026-09-28 00:33-00:53Z: twelve cron ticks in twenty minutes
 * died before their flush while the tick was still free to spend ten drain
 * round trips (a spend the libsql client's own retries can multiply into two or
 * three platform subrequests each, see docs/scan-completion-loss.md). Landing`,
    next: ` * ends the stretch — and the drain is fired from that same tick, in front of
 * that flush (see the worker's onTickEnd hook: moving it behind the flush was
 * measured and reverted on 2026-09-28, see docs/round-trips.md §4.45). Live
 * 2026-09-28 00:33-00:53Z: twelve cron ticks in twenty minutes died before their
 * flush while the tick was still free to spend ten drain round trips (a spend
 * the libsql client's own retries can multiply into two or three platform
 * subrequests each, see docs/scan-completion-loss.md). Landing`,
  },
]);

apply("scripts/test-unit.js", [
  {
    label: "R5/ordering guard -> wiring guard",
    marker: "the shed must reach the drain's call site",
    anchor: `    // ...and since 2026-09-28 its call site sits AFTER the completion flush in
    // program order. It used to live in tickprobe's onTickEnd hook, which runs
    // BEFORE \`db?.persistScanCompletion(...)\` (that hook is the scanner's
    // runOnce wrapper's \`finally\`, and the flush payload is only built once
    // runOnce returns) — so up to DEFERRED_MAX_CALLS_PER_DRAIN bookkeeping round
    // trips were spent in front of the one write a tick cannot lose.
    const drainAt = workerSrc.indexOf("constdrained=drainDeferredWrites(");
    const flushAt = workerSrc.indexOf("db?.persistScanCompletion(");
    assert.ok(flushAt !== -1, "the completion flush is still a call site here");
    assert.ok(
      drainAt !== -1,
      "the held drain call site is still here",
    );
    assert.ok(
      drainAt > flushAt,
      "the drain must be fired AFTER the completion flush",
    );`,
    next: `    // ...and the death-driven ceiling REACHES that call site (2026-09-28): the
    // same marker that pins the slot would keep passing if the wiring were
    // dropped and the drain went back to the normal ten-call ceiling on every
    // tick — which is the whole regression, since the drain's own unit test
    // exercises drainDeferredWrites directly and the rule test only checks the
    // two pure helpers.
    assert.ok(
      workerSrc.includes("maxCalls:drainCallCeiling(deadPredecessorThisTick)") &&
        workerSrc.includes("shed:drainShedReason(deadPredecessorThisTick)"),
      "the shed must reach the drain's call site",
    );`,
  },
]);

process.exit(ok ? 0 : 1);
