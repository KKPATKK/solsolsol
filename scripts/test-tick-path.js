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
  DEFERRED_WRITE_MAX_ATTEMPTS,
  deferredWriteCount,
  classifyCardSend,
  cardSendView,
  noteDuplicateCards,
  deliveryDuplicatesView,
  WRITE_DRAIN_ERROR_KEY,
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
  // The GeckoTerminal feed state rides the same summary: `geo: 0` cannot say
  // whether the feed was rate-limited or the market was quiet, and the worker's
  // telemetry block is past the file-sync window (see geckoFeedStats).
  assert.equal(
    fakeScanner.lastSummary.gecko?.active,
    false,
    "no client in this process, so the record is present and inactive",
  );
  assert.equal(typeof fakeScanner.lastSummary.gecko.http429, "number");

  // A CANDIDATE-LESS tick must still publish it. Every `markPhase` call sits in
  // the per-candidate chain, so a tick that evaluated no candidate collected no
  // stamps — and the guard that gates `phases`/`cardSend` therefore swallowed
  // the gecko record too. Most ticks are candidate-less and `geo 0` IS a
  // candidate-less signature, so the one number built to explain `geo 0` was
  // unreadable exactly when a reader needed it (live 2026-09-21: absent on 8 of
  // 8 /health polls while `geo` read 0 on every one of them).
  const idle = {
    lastSummary: { profiles: 27, geo: 0 },
    markPhase() {
      /* never called: zero candidates walked the chain */
    },
    async runOnce() {
      /* a tick that ends without evaluating a single coin */
    },
  };
  installTickProbe(idle, {}, now);
  await idle.runOnce();
  assert.equal(
    idle.lastSummary.gecko?.active,
    false,
    "the feed state rides a candidate-less tick too",
  );
  assert.equal(typeof idle.lastSummary.gecko.http429, "number");
  assert.equal("phases" in idle.lastSummary, false, "no stamps → no phase chain is published");
  assert.equal("cardSend" in idle.lastSummary, false, "nor a card-send snapshot");
  assert.equal(idle.lastSummary.geo, 0, "the probe never rewrites the scanner's own counts");

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

  // ---------- round 4: the tick-front batch PRIMES the override -----------
  // The worker reads `trade_mode_override` in the statement it already sends
  // before the scan (WEDGE_READ_KEYS) and hands the value over, so the tick's
  // prefetch pays nothing: a primed service reports `primes 1 / reads 0`.
  overrideReads = 0;
  overrideValue = "auto";
  const primed = new TradeService(cfg, {}, db);
  primed.primeModeOverride("auto", Date.now());
  primed.prefetchMode();
  assert.equal(overrideReads, 0, "a primed prefetch issues no round trip");
  assert.equal(await primed.effectiveMode(), "auto", "the chain is answered from it");
  assert.equal(overrideReads, 0, "and pays nothing either");
  assert.equal(primed.modeStats().primes, 1, "the ride is visible, not assumed");
  assert.equal(primed.modeStats().reads, 0, "reads still means round trips WE paid for");

  // A reading of "no override stored" is still a reading: it must not turn
  // into a re-read (nor into a mode).
  overrideReads = 0;
  const noOverride = new TradeService(cfg, {}, db);
  noOverride.primeModeOverride(null, Date.now());
  assert.equal(await noOverride.effectiveMode(), "manual", "null = no override, so the env mode answers");
  assert.equal(overrideReads, 0, "an explicit null reading costs nothing");

  // ...and a ride is not a licence to be stale forever: past the TTL the value
  // ages out exactly like one of our own reads.
  overrideReads = 0;
  overrideValue = "off";
  const stale = new TradeService(cfg, {}, db);
  stale.primeModeOverride("auto", Date.now() - 60_000);
  assert.equal(await stale.effectiveMode(), "off", "a ride older than the TTL is not reused");
  assert.equal(overrideReads, 1, "so the service reads for itself");

  // A junk value is no override — the same rule the single-row read applies.
  overrideReads = 0;
  const junk = new TradeService(cfg, {}, db);
  junk.primeModeOverride("nonsense", Date.now());
  assert.equal(await junk.effectiveMode(), "manual", "junk never invents a mode");
  assert.equal(overrideReads, 0, "and never triggers a re-read inside the TTL");

  // A fresher cached read is never clobbered by an older ride.
  overrideValue = "auto";
  const ordered = new TradeService(cfg, {}, db);
  assert.equal(await ordered.effectiveMode(), "auto");
  overrideReads = 0;
  ordered.primeModeOverride("off", Date.now() - 60_000);
  assert.equal(await ordered.effectiveMode(), "auto", "an older ride cannot overwrite a fresher read");
  assert.equal(overrideReads, 0, "and nothing re-read");

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
  // scanner already returned, so nobody is left to catch it — but it must NOT
  // be dropped. Live 2026-09-19: `writeDrain: 4 calls / 4 failures` (100%),
  // because an un-awaited drain is cancelled when the invocation returns and
  // its writes reject; the old code only counted them, so the token_stats
  // bookkeeping never landed at all. The entry now stays queued (FIFO, in
  // place) and the NEXT drain retries it — one tick of latency instead of a
  // permanent data gap.
  clock = 20_000;
  let flakyAttempts = 0;
  // The drain's DURABLE copy of its own failure (see WRITE_DRAIN_ERROR_KEY):
  // the module-scope mirror is invisible exactly when it matters, because the
  // isolate holding the backlog is not the one answering /health — the live
  // read that motivated the field (`pending 47`) came from a pristine isolate
  // reporting `writeDrain {at 0}`.
  const drainErrorRows = [];
  const flakyDb = {
    async updateTokenMaxMcaps() {
      flakyAttempts += 1;
      clock += 40;
      // Fails exactly once, the way a cancelled invocation's write does.
      if (flakyAttempts === 1) throw new Error("turso 522");
    },
    async setWorkerState(key, value) {
      drainErrorRows.push({ key, value });
    },
  };
  const flakyTick = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      await flakyDb.updateTokenMaxMcaps([1]);
    },
  };
  installTickProbe(flakyTick, { db: flakyDb, deferWrites: true }, now);
  await flakyTick.runOnce();
  const failed = await drainDeferredWrites();
  assert.equal(failed.calls, 1, "the failed write is attempted once per drain");
  assert.equal(failed.failures, 1, "a failed deferred write is counted");
  assert.equal(failed.totals.failures, 1, "and rolled into the totals");
  assert.equal(failed.pending, 1, "and it stays queued instead of being dropped");
  assert.equal(deferredWriteCount(), 1, "the queue still holds it");
  // The REASON rides the view: /health reported pending/failures but never the
  // error text, so the one number that decides the fix was unreadable outside
  // `wrangler tail` (live 2026-09-24: pending 47, 38 failures). The batch stops
  // at the first failure, so this names the entry that stalled it.
  assert.equal(failed.lastError?.message, "turso 522", "the failure's reason is reported");
  assert.equal(failed.lastError?.name, "Error", "with the error's name");
  assert.equal(typeof failed.lastError?.at, "number", "and when it happened");
  assert.equal(
    failed.lastError?.method,
    "updateTokenMaxMcaps",
    "and WHICH write threw — both deferred methods share one table and one client, so the error text alone cannot say which fix applies",
  );
  // ...and the record is DURABLE, not just local. One row per failed drain
  // (never one per entry), written only on the failure path, so a healthy tick
  // pays nothing for it.
  assert.equal(drainErrorRows.length, 1, "the failure is copied to its durable row");
  assert.equal(
    drainErrorRows[0].key,
    WRITE_DRAIN_ERROR_KEY,
    "under the key /health reads (no second spelling to drift)",
  );
  const persistedDrainError = JSON.parse(drainErrorRows[0].value);
  assert.equal(persistedDrainError.method, "updateTokenMaxMcaps", "with the method");
  assert.equal(persistedDrainError.message, "turso 522", "the error text");
  assert.equal(typeof persistedDrainError.at, "number", "when it happened");
  assert.equal(
    persistedDrainError.pending,
    1,
    "and the backlog it stalled — the number that separates a blip from the live incident",
  );
  // The retry lands on the next drain, without the tick that queued it.
  const retried = await drainDeferredWrites();
  assert.equal(retried.calls, 1, "the next drain retries the same call");
  assert.equal(retried.failures, 0, "and this time it lands");
  assert.equal(retried.lastError, null, "a clean drain reports no error");
  // ...and the RECOVERY clears the durable row (2026-09-25). The row is only
  // ever rewritten by a FAILURE, so without this it stood there forever: live
  // /health read `writeDrainError` 8.4h old with `pending 15` while every
  // drain behind it had landed — a reader chasing an incident that was over.
  // `""` rather than a DELETE: /health already reads a missing row as null and
  // parses an empty one to null too (its JSON.parse throws into the same
  // catch), so nothing else has to change and no new Db method is needed.
  assert.equal(
    drainErrorRows.length,
    2,
    "the recovery clears the row this isolate wrote",
  );
  assert.equal(drainErrorRows[1].key, WRITE_DRAIN_ERROR_KEY, "under the same key");
  assert.equal(drainErrorRows[1].value, "", "cleared, not rewritten");
  // The guard makes that cost ONE write, once: the next drain (and every idle
  // one) writes nothing at all, so a healthy isolate pays nothing.
  const afterClear = await drainDeferredWrites();
  assert.equal(afterClear.calls, 0, "the queue is empty again");
  assert.equal(
    drainErrorRows.length,
    2,
    "a healthy isolate never pays for the clear again",
  );
  assert.equal(flakyAttempts, 2, "the real write ran a second time");
  assert.equal(retried.pending, 0, "the queue drains clean");

  // Bounded: a write that keeps failing is retried DEFERRED_WRITE_MAX_ATTEMPTS
  // times and then dropped, so a database that is down for hours cannot grow
  // the in-memory queue without limit.
  clock = 30_000;
  let deadAttempts = 0;
  const deadDb = {
    async recordTokenStatsMany() {
      deadAttempts += 1;
      clock += 10;
      throw new Error("turso down");
    },
  };
  const deadTick = {
    lastSummary: {},
    markPhase() {},
    async runOnce() {
      await deadDb.recordTokenStatsMany([1]);
    },
  };
  installTickProbe(deadTick, { db: deadDb, deferWrites: true }, now);
  await deadTick.runOnce();
  for (let attempt = 1; attempt < DEFERRED_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const tryView = await drainDeferredWrites();
    assert.equal(tryView.failures, 1, `attempt ${attempt} fails again`);
    assert.equal(tryView.pending, 1, `attempt ${attempt} keeps the entry queued`);
  }
  const gaveUp = await drainDeferredWrites();
  assert.equal(gaveUp.pending, 0, "the cap drops it rather than queueing forever");
  assert.equal(gaveUp.failures, 1, "the last failure is still counted");
  assert.equal(deadAttempts, DEFERRED_WRITE_MAX_ATTEMPTS, "exactly the capped attempts");

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
    // The page threshold is separate from the age-based alert's, because the
    // two measure different things: this path is only reachable when a tick
    // DID claim, so a lost completion write is not an outage on its own
    // (2026-09-20: all 8 recent pushes inside the scan-history ring came from
    // ticks the record calls dead).
    const { shouldAlertNoCompletion, COMPLETION_ALERT_GAP_MS } = require("../dist/worker.js");
    const cooldown = 30 * 60_000;
    const gap = COMPLETION_ALERT_GAP_MS;
    // The case that used to page every few hours: a 3-5 minute lost-flush run.
    for (const mins of [1, 3, 5]) {
      assert.equal(
        shouldAlertNoCompletion(mins * 60_000, 0, now).alerting,
        false,
        `${mins} minutes of lost completions stays quiet`,
      );
    }
    assert.equal(gap, 10 * 60_000, "the completion page needs 10 minutes, not 3");
    assert.ok(gap > 3 * 60_000, "and it must stay above the age-based alert's 3");
    // A stretch past the threshold pages once, with a rounded minute count.
    const fire = shouldAlertNoCompletion(11 * 60_000, 0, now);
    assert.deepEqual(fire, { alerting: true, minutes: 11 });
    assert.equal(shouldAlertNoCompletion(gap, 0, now).alerting, true, "the threshold itself pages");
    // ... and the shared cooldown still suppresses a repeat for 30 minutes.
    assert.equal(shouldAlertNoCompletion(11 * 60_000, now - 5 * 60_000, now).alerting, false);
    assert.equal(shouldAlertNoCompletion(11 * 60_000, now - cooldown + 1, now).alerting, false);
    assert.equal(shouldAlertNoCompletion(11 * 60_000, now - cooldown, now).alerting, true);
    // A never-alerted row (0) or an unreadable one (NaN) must not be read as
    // "alerted just now" — the cooldown only ever suppresses a real stamp.
    assert.equal(shouldAlertNoCompletion(20 * 60_000, 0, now).alerting, true);
    assert.equal(shouldAlertNoCompletion(20 * 60_000, Number.NaN, now).alerting, true);
    assert.equal(shouldAlertNoCompletion(90_000, 0, now).minutes, 2, "minutes are rounded up from 1");
    assert.equal(shouldAlertNoCompletion(0, 0, now).minutes, 1, "a sub-minute stretch still reads 1");
    console.log("completion-based outage alert: pass");
  }

  // ---------- card-send outcome: cut vs delivered vs deferred ---------------
  {
    // The rule the duplicate-card investigation needed: the two stamps around
    // the send (`send:telegram` before, `send:track` after) already say whether
    // it RETURNED, which `pushed`/`cardSendDeferred` in the summary cannot. The
    // three shapes below are the three real ones.
    const pre = [{ phase: "render", ms: 3_300 }];
    const claim = { phase: "send:claim", ms: 3_300 };
    const telegram = { phase: "send:telegram", ms: 3_542 };
    assert.equal(
      classifyCardSend([...pre, claim, telegram, { phase: "send:track", ms: 4_131 }]),
      "sent",
      "a send that returned is delivered",
    );
    // The live shape that produced the duplicate cards (2026-09-20): the chain
    // spent every deadline it was given and the send started at 3542ms of a
    // 4200ms tick, so its 658ms slice cut the await while Telegram may already
    // have accepted the card.
    assert.equal(classifyCardSend([...pre, claim, telegram]), "cut");
    // A claim opened and no send after it: the deferral path (or a claim
    // another isolate won) — nothing was written, nothing can duplicate.
    assert.equal(classifyCardSend([...pre, claim]), "deferred");
    // Nothing card-shaped happened at all.
    assert.equal(classifyCardSend(pre), null);
    assert.equal(classifyCardSend([]), null);
    // A cut AFTER a delivered card is still a cut: the consequence wins over
    // the tick's other, successful send.
    assert.equal(
      classifyCardSend([
        { phase: "send:telegram", ms: 2_500 },
        { phase: "send:track", ms: 3_000 },
        { phase: "send:telegram", ms: 3_600 },
      ]),
      "cut",
    );

    // The counters published on the summary the heartbeat serializes, so the
    // cut RATE becomes a number the operator can watch going down after a fix.
    resetTickProbe();
    const cutScanner = {
      lastSummary: { candidates: 1, pushed: 1 },
      markPhase(diag, name) {
        diag.pushPhase = name;
      },
      async runOnce() {
        this.markPhase(this.lastSummary, "render");
        clock = 7_250;
        this.markPhase(this.lastSummary, "send:claim");
        clock = 7_450;
        this.markPhase(this.lastSummary, "send:telegram");
      },
    };
    clock = 7_000;
    installTickProbe(cutScanner, {}, now);
    assert.deepEqual(cardSendView(), {
      sent: 0,
      cut: 0,
      deferred: 0,
      lastCutAt: 0,
      lastCutMs: 0,
    });
    await cutScanner.runOnce();
    const counted = cardSendView();
    assert.equal(counted.cut, 1, "the abandoned send is counted");
    assert.equal(counted.sent, 0, "and not mistaken for a delivery");
    assert.equal(counted.deferred, 0, "nor for a deferral");
    assert.equal(counted.lastCutAt, 7_450, "the cut's wall clock is recorded");
    assert.equal(counted.lastCutMs, 450, "with the tick-relative stamp it happened at");
    assert.equal(
      cutScanner.lastSummary.cardSend.cut,
      1,
      "and it rides the summary the completion heartbeat serializes",
    );
    console.log("card-send outcome (cut / delivered / deferred): pass");
  }

  // ---------- the duplicate counter that rides the same heartbeat -----------
  {
    // The user's report ("PONDER five times between 10:48 and 11:08 HKT") had
    // no number anywhere in /health, so neither the fix nor a regression could
    // be seen. The worker's tail hands the audit-ring duplicates to the probe,
    // and the summary the completion heartbeat serializes carries them from the
    // NEXT tick on (the tail runs after this tick's stamps are published — one
    // tick of lag, by construction, exactly like the deferral counters).
    resetTickProbe();
    assert.deepEqual(deliveryDuplicatesView(), { count: 0, tokens: [], at: 0 });
    const probeScanner = {
      lastSummary: { candidates: 1 },
      markPhase(diag, name) {
        diag.pushPhase = name;
      },
      async runOnce() {
        this.markPhase(this.lastSummary, "render");
      },
    };
    clock = 9_000;
    installTickProbe(probeScanner, {}, now);
    noteDuplicateCards(["AAAA", "BBBB", "CCCC", "DDDD"], 8_500);
    const view = deliveryDuplicatesView();
    assert.equal(view.count, 4, "every duplicate in the ring is counted");
    assert.deepEqual(view.tokens, ["AAAA", "BBBB", "CCCC"], "the list is capped at three");
    assert.equal(view.at, 8_500, "with the wall clock of the tail that saw them");
    await probeScanner.runOnce();
    assert.equal(
      probeScanner.lastSummary.deliveryDuplicates.count,
      4,
      "and it rides the summary the completion heartbeat serializes",
    );
    // An empty ring CLEARS the count (it is a rolling window, not a total), and
    // the stamp of the last sighting survives so the line stays answerable.
    noteDuplicateCards([], 9_500);
    const cleared = deliveryDuplicatesView();
    assert.equal(cleared.count, 0, "no duplicates in the ring reads as zero");
    assert.deepEqual(cleared.tokens, []);
    assert.equal(cleared.at, 8_500, "the last sighting keeps its stamp");
    // Malformed input must never throw in the tick tail.
    noteDuplicateCards(["", null, undefined, "ZZZZ"]);
    assert.equal(deliveryDuplicatesView().count, 1);
    console.log("duplicate-card counter (audit ring → heartbeat): pass");
  }

  // ---------- out-of-window guard: the zero-mcap push baseline ----------
  //
  // The self-heal's baseline fallback sits ~2290 lines into src/pushwatch.ts,
  // past the file-tool window, so it ships as
  // docs/patches/pushwatch-zero-mcap-baseline.apply.js and is applied in the
  // tree (the marker check lives HERE because scripts/test-unit.js is itself
  // past the window). A pair with no price reading used to seed `mcap_at_push
  // 0` (live 2026-09-24: exactly two rows, 💲 and 玉兔), which poisons
  // chgSincePush and collapses the dead-state resurrection floor to 0. Partial
  // application is the dangerous state, so every marker must agree.
  {
    const fs = require("node:fs");
    const path = require("node:path");
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const src = strip(
      fs.readFileSync(path.join(__dirname, "..", "src/pushwatch.ts"), "utf8"),
    );
    const markers = {
      "fallback prefers a positive reading": src.includes("constfallbackMcap="),
      "uses the FDV when the market cap is 0": src.includes("pair.fdvUsd"),
      "skips the enrollment when neither exists": src.includes(
        "if(healedMcap<=0)continue;",
      ),
      "the guard is the only baseline source": src.includes(
        "consthealedMcap=known?.mcapAtPush??fallbackMcap;",
      ),
    };
    const missing = Object.entries(markers)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length === 4) {
      console.log(
        "  ℹ zero-mcap baseline guard missing - apply docs/patches/pushwatch-zero-mcap-baseline.apply.js",
      );
    } else {
      assert.equal(
        missing.length,
        0,
        `partial application is unsafe - missing: ${missing.join(", ")} (see docs/patches/pushwatch-zero-mcap-baseline.apply.js)`,
      );
      console.log(
        "  ℹ zero-mcap baseline guard present - the heal cannot seed a 0 baseline",
      );
    }
  }

  console.log("tick probe + mode read + feed view + db seam: pass");
})().catch((err) => {
  console.error("push-path instrumentation tests failed:", err);
  process.exit(1);
});
