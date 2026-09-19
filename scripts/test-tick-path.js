/*
 * Push-path instrumentation tests (2026-09-19): the per-tick probe that records
 * every phase stamp of a scan, and the trade-mode read that used to sit
 * unbounded inside the card's claim slice.
 *
 * Both exist because a tick that ends `candidates 1, pushed 0` had no way to
 * say where its four seconds went, and because an unclamped Turso read on the
 * critical tail is what turned qualifying coins into deferred cards. Run by
 * `npm run test:unit` (after the build), or on its own:
 *   node scripts/test-tick-path.js
 */
const assert = require("node:assert/strict");
const {
  installTickProbe,
  tickProbeView,
  resetTickProbe,
  TICK_PROBE_MAX_PHASES,
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

  console.log("tick probe + mode read + feed view: pass");
})().catch((err) => {
  console.error("push-path instrumentation tests failed:", err);
  process.exit(1);
});
