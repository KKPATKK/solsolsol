/*
 * Push-path instrumentation tests (2026-09-19): the per-tick probe that records
 * every phase stamp of a scan, the trade-mode read that used to sit unbounded
 * inside the card's claim slice, and the DB seam that times the tick's round
 * trips and takes its two writes off the scan's critical path.
 *
 * All three exist because a tick that ends `candidates 1, pushed 0` had no way
 * to say where its four seconds went, and because the steps between the pair
 * fetch and the gates — an unclamped Turso read, then two write round trips —
 * are what turned qualifying coins into deferred cards. Run by
 * `npm run test:unit` (after the build), or on its own:
 *   node scripts/test-tick-path.js
 */
const assert = require("node:assert/strict");
const {
  installTickProbe,
  tickProbeView,
  resetTickProbe,
  TICK_PROBE_MAX_PHASES,
  dbStepView,
  writeDrainView,
  drainDeferredWrites,
  deferredWriteCount,
} = require("../dist/tickprobe.js");
const { TradeService } = require("../dist/jupiter.js");
const { resetFeedMakeup, noteProfileFeed, feedMakeupView } = require("../dist/deferredmakeup.js");

// ---------- the probe: every stamp of the tick, not just the last one ------
let clock = 1_000;
const now = () => clock;
let started = 0;
let ended = 0;
const fakeScanner = {
  lastSummary: { profiles: 3, pool: 10 },
  // The scanner's markPhase is private; the probe reaches it through the same
  // runtime seam the worker uses (and calls it with the tick's start).
  markPhase(diag, name, tickStartedAt) {
    assert.ok(tickStartedAt <= clock, "the marker is called with the tick's start");
    diag.pushPhase = name;
    diag.pushPhaseMs = now() - tickStartedAt;
  },
  async runOnce() {
    this.markPhase(this.lastSummary, "seen", 1_000);
    clock = 3_550;
    // The last stamp before a DEFERRED card: the claim gate (3550ms) has just
    // closed, so the chain's last recorded phase is exactly where the tick
    // gave up.
    this.markPhase(this.lastSummary, "render", 1_000);
    clock = 3_600;
    this.markPhase(this.lastSummary, "done", 1_000);
    return undefined;
  },
};

resetTickProbe();
installTickProbe(fakeScanner, {
  onTickStart: () => {
    started += 1;
    clock = 1_000;
  },
  onTickEnd: (summary) => {
    ended += 1;
    assert.equal(summary, fakeScanner.lastSummary, "the hook sees the flushed summary");
  },
}, now);

(async () => {
  await fakeScanner.runOnce();

  assert.equal(started, 1, "the tick-start hook fires before the scan");
  assert.equal(ended, 1, "and the tick-end hook after it");
  const view = tickProbeView();
  assert.deepEqual(
    view.phases.map((p) => p.phase),
    ["seen", "render", "done"],
    "every phase stamp is kept in order",
  );
  assert.deepEqual(
    view.phases.map((p) => p.ms),
    [0, 2_550, 2_600],
    "each stamp carries its tick-relative ms",
  );
  assert.equal(view.tickMs, 2_600, "the view's duration is the newest stamp");
  // The completion heartbeat serializes `scanner.lastSummary` verbatim, so the
  // phases must be ON it (the only channel reachable from the worker).
  assert.deepEqual(
    fakeScanner.lastSummary.phases.map((p) => p.phase),
    ["seen", "render", "done"],
    "the stamps are attached to the summary the heartbeat publishes",
  );
  assert.equal(fakeScanner.lastSummary.pushPhase, "done", "the scanner's own marker is untouched");

  // A long tick keeps the NEWEST stamps: the interesting ticks are the ones
  // that walk many phases and still end without a push, and the last step
  // before the refusal is what a reader needs.
  clock = 5_000;
  const many = {
    lastSummary: {},
    markPhase() {
      /* the probe wraps this one too */
    },
    async runOnce() {
      for (let i = 0; i < TICK_PROBE_MAX_PHASES + 5; i++) {
        clock += 10;
        this.markPhase(this.lastSummary, `p${i}`, 5_000);
      }
    },
  };
  installTickProbe(many, {}, now);
  await many.runOnce();
  const ring = tickProbeView();
  assert.equal(ring.phases.length, TICK_PROBE_MAX_PHASES, "the stamp ring is capped");
  assert.equal(
    ring.phases[ring.phases.length - 1].phase,
    `p${TICK_PROBE_MAX_PHASES + 4}`,
    "and it keeps the newest ones, not the oldest",
  );
  assert.equal(ring.phases[0].phase, "p5", "the evicted ones are the oldest");
  assert.equal(
    many.lastSummary.phases.length,
    TICK_PROBE_MAX_PHASES,
    "the summary carries the same ring",
  );

  // A hook that throws must not fail the tick (telemetry never breaks a push).
  let ran = false;
  const hostile = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      ran = true;
    },
  };
  installTickProbe(hostile, {
    onTickStart: () => {
      throw new Error("prefetch blew up");
    },
    onTickEnd: () => {
      throw new Error("telemetry blew up");
    },
  }, now);
  await hostile.runOnce();
  assert.equal(ran, true, "the tick still runs when a hook throws");

  // ---------- the trade-mode read: prefetched, reused, bounded -------------
  const cfg = { mode: "manual", amountSol: 0.01, slippagePct: 10, maxDailyBuys: 5, walletSecret: undefined, jupiterApiKey: undefined, heliusApiKey: undefined };
  let overrideReads = 0;
  let overrideValue = "auto";
  let failReads = false;
  const db = {
    async getTradeModeOverride() {
      overrideReads += 1;
      if (failReads) throw new Error("turso is slow");
      return overrideValue;
    },
    async setTradeModeOverride(value) {
      overrideValue = value;
    },
  };
  const trade = new TradeService(cfg, {}, db);

  assert.equal(await trade.effectiveMode(), "auto", "the override wins over the env mode");
  assert.equal(overrideReads, 1);
  // The whole point: the chain's call 3-4s later must NOT pay for a round trip.
  assert.equal(await trade.effectiveMode(), "auto");
  assert.equal(overrideReads, 1, "a second call inside the TTL reuses the read");
  assert.equal(trade.modeStats().reuses, 1, "and the reuse is countable");
  // The worker prefetches off the critical path; the tick's late call is then
  // served from the cache without any read at all.
  trade.prefetchMode();
  assert.equal(overrideReads, 1, "a warm prefetch does not read again");
  trade.modeStats();
  // A prefetch racing a caller shares ONE round trip.
  const cold = new TradeService(cfg, {}, db);
  overrideReads = 0;
  cold.prefetchMode();
  const shared = await cold.effectiveMode();
  assert.equal(shared, "auto");
  assert.equal(overrideReads, 1, "prefetch + caller never issue two reads");

  // A write-through: the isolate that handled /setmode applies it immediately.
  const flipped = new TradeService(cfg, {}, db);
  await flipped.effectiveMode();
  await flipped.setModeOverride("off");
  overrideValue = "off";
  assert.equal(await flipped.effectiveMode(), "off", "the flip is live in this isolate");
  assert.equal(flipped.modeStats().reads, 1, "without a second read");

  // A read that fails or overruns falls back to the ENV mode (the fail-safe the
  // unbounded read had before), and is counted instead of silently repeated.
  const broken = new TradeService(cfg, {}, db);
  failReads = true;
  assert.equal(await broken.effectiveMode(), "manual", "an unanswered read never invents a mode");
  assert.equal(broken.modeStats().timeouts, 1, "the cut read is visible");
  failReads = false;

  // ---------- the feed view behind the make-up ----------------------------
  resetFeedMakeup();
  noteProfileFeed(0, 3, 700);
  noteProfileFeed(24, 0, 900);
  const feed = feedMakeupView();
  assert.equal(feed.feedRequests, 2);
  assert.equal(feed.lastRawProfiles, 24, "the last raw size, before any make-up");
  assert.equal(feed.emptyFeedTotal, 1, "an empty feed is what used to be `profiles: 0`");
  assert.equal(feed.lastEmptyFeedAt, 700, "and it is stamped");
  assert.equal(feed.injectedTotal, 3, "the make-up's pull-ins accumulate");
  assert.equal(feed.lastInjected, 0, "the newest request added nothing");
  resetFeedMakeup();
  assert.equal(feedMakeupView().feedRequests, 0, "the test seam resets the view");

  // ---------- the DB seam: timed reads, deferred writes --------------------
  resetTickProbe();
  clock = 10_000;
  const wire = [];
  const seamDb = {
    async getTokenStatsMany(rows) {
      wire.push("read");
      clock += 120;
      return new Map(rows.map((r) => [r, {}]));
    },
    async recordTokenStatsMany(rows) {
      wire.push("register");
      clock += 200;
      return undefined;
    },
    async updateTokenMaxMcaps(raises) {
      wire.push("mcap");
      clock += 300;
      return undefined;
    },
  };
  const observed = [];
  const seams = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      // The tick's own order, exactly as runOnce makes these calls: the read
      // first (the gates consume its result), then the two bookkeeping writes.
      const readBack = await seamDb.getTokenStatsMany(["a", "b"]);
      observed.push(readBack instanceof Map);
      await seamDb.recordTokenStatsMany(["x"]);
      observed.push("register-returned");
      await seamDb.updateTokenMaxMcaps(["y"]);
      observed.push("mcap-returned");
    },
  };
  installTickProbe(seams, { db: seamDb, deferWrites: true }, now);
  await seams.runOnce();

  // The gates' read keeps its contract — awaited, same result — and is timed,
  // because the chain cannot start before it answers. The two WRITES hand the
  // scanner an already-resolved promise, which is the whole point: they used
  // to sit between the pair fetch and the candidate chain.
  assert.deepEqual(
    observed,
    [true, "register-returned", "mcap-returned"],
    "the tick's read answers and its writes return at once",
  );
  assert.deepEqual(wire, ["read"], "only the read hit the wire during the tick");
  assert.deepEqual(
    dbStepView().getTokenStatsMany,
    { calls: 1, ms: 120 },
    "the registration read's round trip is measured",
  );
  assert.equal(deferredWriteCount(), 2, "both tick writes wait for the drain");
  assert.equal(
    dbStepView().recordTokenStatsMany,
    undefined,
    "and are not timed until they really run",
  );

  // The drain runs them in CALL ORDER — the scanner writes registration before
  // the max-mcap raises, and the bookkeeping must not reorder them.
  const drained = await drainDeferredWrites();
  assert.deepEqual(wire, ["read", "register", "mcap"], "the drain keeps call order");
  assert.equal(drained.calls, 2, "the drain reports the batch size");
  assert.equal(drained.ms, 500, "and what the batch cost");
  assert.equal(drained.failures, 0, "nothing failed");
  assert.deepEqual(drained.totals, { calls: 2, ms: 500, failures: 0 }, "with cumulative totals");
  assert.deepEqual(
    dbStepView().recordTokenStatsMany,
    { calls: 1, ms: 200 },
    "each write is timed where it actually runs",
  );
  assert.equal(deferredWriteCount(), 0, "the queue is emptied");

  // An empty drain is a no-op that keeps the totals (the worker drains every
  // tick, whether or not the tick queued anything).
  const empty = await drainDeferredWrites();
  assert.equal(empty.calls, 0);
  assert.equal(empty.ms, 0);
  assert.equal(empty.totals.calls, 2, "the cumulative totals survive an empty drain");
  assert.equal(writeDrainView().at, drained.at, "and the last real drain is still described");

  // A deferred write that throws is counted, never rethrown at the drain: the
  // scanner already returned, so nobody is left to catch it.
  clock = 20_000;
  const angryDb = {
    async updateTokenMaxMcaps() {
      clock += 40;
      throw new Error("turso 522");
    },
  };
  const angryTick = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      await angryDb.updateTokenMaxMcaps([1]);
    },
  };
  installTickProbe(angryTick, { db: angryDb, deferWrites: true }, now);
  await angryTick.runOnce();
  const failed = await drainDeferredWrites();
  assert.equal(failed.calls, 1);
  assert.equal(failed.failures, 1, "a failed deferred write is counted");
  assert.equal(failed.totals.failures, 1, "and rolled into the totals");

  // A write error must still reach the scanner when the caller did NOT ask for
  // the deferral (deferWrites is off by default).
  const strictDb = {
    async recordTokenStatsMany() {
      throw new Error("turso 4xx");
    },
  };
  installTickProbe(
    { lastSummary: {}, markPhase() {}, async runOnce() {} },
    { db: strictDb },
    now,
  );
  const timedBefore = dbStepView().recordTokenStatsMany?.calls ?? 0;
  await assert.rejects(() => strictDb.recordTokenStatsMany([]), /turso 4xx/);
  assert.equal(deferredWriteCount(), 0, "an undeferred write is never queued");
  assert.equal(
    dbStepView().recordTokenStatsMany.calls,
    timedBefore + 1,
    "but it is timed (and its error reaches the scanner)",
  );

  // The deferral is scoped to the TICK: the same handle is also called from
  // outside one (the worker's own backfill endpoint awaits its seed before
  // responding), and that call keeps its immediate contract.
  assert.deepEqual(wire, ["read", "register", "mcap"], "outside a tick nothing is queued");
  const timedBeforeOutside = dbStepView().recordTokenStatsMany?.calls ?? 0;
  await seamDb.recordTokenStatsMany(["outside"]);
  assert.deepEqual(wire, ["read", "register", "mcap", "register"], "an outside write goes straight out");
  assert.equal(deferredWriteCount(), 0, "and is not queued");
  assert.equal(
    dbStepView().recordTokenStatsMany.calls,
    timedBeforeOutside + 1,
    "it is timed where it runs",
  );

  // Wrapping is per DB object: the worker's dead-tick rebuild creates a new
  // handle, and a re-install on one already wrapped would double every write.
  const target = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      await seamDb.recordTokenStatsMany(["z"]);
    },
  };
  installTickProbe(target, { db: seamDb, deferWrites: true }, now);
  await target.runOnce();
  assert.equal(deferredWriteCount(), 1, "a second install does not wrap the handle twice");
  await drainDeferredWrites();

  // ---------- dead-tick recovery (worker.ts deadTickRebuildDecision) ----------
  // The 2026-09-19 16:05-16:33Z incident: 23 consecutive cron ticks, each won
  // the claim, wrote a phase=scanning heartbeat and died before its completion
  // flush, while the breaker never fired — its increment and rebuild sat in a
  // `finally` a killed invocation never runs. The recovery now runs on the
  // SUCCESSOR tick, before it scans. These cases pin that rule.
  {
    const {
      deadTickRebuildDecision,
      heartbeatRebuiltAt,
      heartbeatDeadStreak,
      nextDeadStreak,
    } = require("../dist/worker.js");
    const now = 1_800_000_000_000;
    const stale = 45_000;
    const deadHb = JSON.stringify({ at: now - 60_000, ok: true, phase: "scanning" });

    // A stale phase=scanning heartbeat with no marker: the predecessor never
    // flushed, so the successor rebuilds the state BEFORE it scans.
    assert.deepEqual(deadTickRebuildDecision(deadHb, now, stale), {
      rebuild: true,
      deadAt: now - 60_000,
    });
    // Marker present: the row is stale because the state behind it was ALREADY
    // rebuilt. This is the case that stops one death from rebuilding forever
    // (the recovering tick's own heartbeat is stale too, and it never flushes).
    const marked = JSON.stringify({
      at: now - 60_000,
      phase: "scanning",
      rebuiltAt: now - 59_500,
    });
    assert.deepEqual(deadTickRebuildDecision(marked, now, stale), { rebuild: false });
    // A landed completion flush is proof of life, however old the row is.
    assert.deepEqual(
      deadTickRebuildDecision(JSON.stringify({ at: now - 600_000, phase: "done" }), now, stale),
      { rebuild: false },
    );
    // A fresh scanning heartbeat is a tick that is still RUNNING, not a death:
    // rebuilding here would tear down the state of a live scan.
    assert.deepEqual(
      deadTickRebuildDecision(JSON.stringify({ at: now - 5_000, phase: "scanning" }), now, stale),
      { rebuild: false },
    );
    // Missing / unparsable / shapeless rows can never trigger a rebuild.
    for (const raw of [null, undefined, "", "not json", "{}", JSON.stringify({ phase: "scanning" })]) {
      assert.deepEqual(deadTickRebuildDecision(raw, now, stale), { rebuild: false });
    }
    assert.equal(heartbeatRebuiltAt(marked), now - 59_500);
    assert.equal(heartbeatRebuiltAt(deadHb), null);
    assert.equal(heartbeatRebuiltAt("not json"), null);
    assert.equal(heartbeatRebuiltAt(JSON.stringify({ rebuiltAt: 0 })), null);

    // The counter helper is pinned even though its publish site (the claim
    // heartbeat) is outside the editable window: the escalation rule 0→1→2 on
    // consecutive proven deaths is what DEAD_TICK_STREAK_RESET means.
    assert.equal(heartbeatDeadStreak(deadHb), 0);
    assert.equal(heartbeatDeadStreak(JSON.stringify({ deadStreak: 2 })), 2);
    assert.equal(heartbeatDeadStreak(JSON.stringify({ deadStreak: -3 })), 0);
    assert.equal(heartbeatDeadStreak("not json"), 0);
    assert.equal(nextDeadStreak(0, true), 1);
    assert.equal(nextDeadStreak(1, true), 2);
    assert.equal(nextDeadStreak(2, false), 2);
    assert.equal(nextDeadStreak(-5, true), 1);
    console.log("dead-tick recovery: pass");
  }

  // ---------- bounded recovery awaits (worker.ts recoveryAwait) ----------
  // The recovery runs BEFORE the scan, on the ticks that are already in
  // trouble — so every round trip it makes is bounded. A hung write there used
  // to inherit the full 6s transport / 7.2s hard-wall ladder and grow the front
  // phase past Cloudflare's invocation kill, killing the recovering tick too:
  // that is how one lost completion became a chain of them.
  {
    const { recoveryAwait, RECOVERY_DB_BOUND_MS } = require("../dist/worker.js");

    // A settled promise passes its value through untouched.
    assert.equal(await recoveryAwait(Promise.resolve(42), 50, "unit"), 42);

    // A promise that never settles — the hung libsql write shape — answers null
    // on the bound instead of spending the tick on it, and is left running
    // (every write on the recovery path is idempotent, so a late commit is
    // harmless and the next tick re-offers it).
    const t0 = Date.now();
    let settledLate = false;
    const hung = new Promise((resolve) =>
      setTimeout(() => {
        settledLate = true;
        resolve("late");
      }, 400),
    );
    assert.equal(await recoveryAwait(hung, 60, "unit"), null);
    const waited = Date.now() - t0;
    assert.ok(waited >= 40, `waited at least the bound (waited ${waited}ms)`);
    assert.ok(waited < 350, `released the tick on the bound (waited ${waited}ms)`);
    assert.equal(settledLate, false, "the abandoned promise is left running");

    // A rejection is the same answer as a timeout: the recovery is best-effort
    // bookkeeping and must never fail the tick doing the recovering (the
    // caller's own catch would otherwise abort the steps after it, e.g. the
    // alert after a failed announce write).
    assert.equal(await recoveryAwait(Promise.reject(new Error("boom")), 50, "unit"), null);
    assert.equal(
      await recoveryAwait(Promise.reject(new Error("boom")), 50, "unit").then(() => "continued"),
      "continued",
      "a failed recovery step does not throw into the caller",
    );

    // The bound itself stays a fraction of the tick: the read plus two writes
    // must not be able to grow the front phase into the invocation's kill
    // window (the regression this replaced could reach ~22s).
    assert.ok(RECOVERY_DB_BOUND_MS > 0 && RECOVERY_DB_BOUND_MS <= 1_200);
    assert.ok(1_500 + 2 * RECOVERY_DB_BOUND_MS < 5_000);
    console.log("bounded recovery awaits: pass");
  }

  // ---------- completion-based outage alert (worker.ts wedgeChainEntry) ----------
  // The age-based checkOutageAndAlert cannot see this outage at all: the claim
  // heartbeat refreshes `at` every tick, so the reported age never passes one
  // cadence and 28 minutes of zero completions read green (2026-09-19). Only a
  // record of COMPLETIONS can grow, only the successor tick can keep it, and the
  // continuation test is what lets one row survive the claim overwrite without
  // any cleanup write on healthy ticks.
  {
    const { wedgeChainEntry, SCAN_WEDGE_STATE_KEY } = require("../dist/worker.js");
    const now = 1_800_000_000_000;
    const tol = 180_000;
    const deadAt = now - 60_000; // the first tick that never flushed
    assert.equal(SCAN_WEDGE_STATE_KEY, "scan_wedge");

    // First death: nothing stored, so the stretch starts at the dead tick.
    const first = wedgeChainEntry(null, deadAt, now, tol);
    assert.deepEqual(first, { start: deadAt, tickAt: now });

    // Next death tick one cadence later: the predecessor started ~one cadence
    // after the row was written, so it IS the same stretch — `start` is kept and
    // the reported age therefore grows.
    const second = wedgeChainEntry(JSON.stringify(first), deadAt + 60_000, now + 60_000, tol);
    assert.deepEqual(second, { start: deadAt, tickAt: now + 60_000 });
    const third = wedgeChainEntry(JSON.stringify(second), deadAt + 120_000, now + 120_000, tol);
    assert.equal(third.start, deadAt, "the stretch keeps its original start");
    assert.equal(now + 180_000 - third.start, 240_000, "age measured from the last completion");

    // A row left over from an outage that already ENDED must not make one fresh
    // death look like a long outage: its tickAt is far from the dead tick.
    const staleRow = JSON.stringify({ start: deadAt - 3_600_000, tickAt: now - 3_600_000 });
    assert.equal(wedgeChainEntry(staleRow, now, now + 1_000, tol).start, now);
    // A row whose start is LATER than the dead tick cannot describe it either.
    assert.equal(wedgeChainEntry(JSON.stringify({ start: now, tickAt: now - 1_000 }), now - 60_000, now, tol).start, now - 60_000);
    // Unparsable / shapeless / negative rows start a new stretch instead of
    // throwing or inheriting nonsense.
    for (const raw of [undefined, "", "not json", "{}", JSON.stringify({ start: -1, tickAt: 5 })]) {
      assert.equal(wedgeChainEntry(raw, deadAt, now, tol).start, deadAt);
    }
    console.log("completion-based outage alert: pass");
  }

  console.log("tick probe + mode read + feed view + db seam: pass");
})().catch((err) => {
  console.error("push-path instrumentation tests failed:", err);
  process.exit(1);
});
