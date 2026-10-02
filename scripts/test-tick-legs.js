/*
 * PER-TICK LEG RING (/debug/tick-legs).
 *
 * WHY THIS FILE EXISTS: the 2026-10-02 429-storm postmortem found the slow
 * ticks' leg split unrecoverable — scan_history keeps 8 columns and the
 * heartbeat only the LATEST tick's legs, so by the time anyone asked "which
 * leg held it", the answer had already rotated out of /health. The ring
 * (src/worker.ts, TICK_LEG_RING_SIZE ticks, this isolate, zero round trips)
 * is the fix; these tests pin its contract:
 *
 *   1. `buildTickLegRow` maps the summary's legs and the front split into the
 *      row, and COPIES the maps/steps (a later mutation of scanner state must
 *      not rewrite a recorded tick).
 *   2. A tick with no summary — a cut, a shed, an early return — records
 *      `null` legs, never fabricated zeros: "no reading" and "spent 0ms" are
 *      different answers, and the cut note is what names the held stage.
 *   3. The ring trims to capacity keeping the newest, and the view is newest
 *      first with a clamped limit.
 *   4. The flush path really records BEFORE the completion write, and the
 *      /debug/tick-legs route is registered — a ring nobody fills or serves
 *      is decoration, and neither can be told from a live reading.
 *
 * Run: node scripts/test-tick-legs.js (npm run test:unit runs it after the
 * build, beside the other standalone suites).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildTickLegRow,
  recordTickLeg,
  tickLegRows,
  tickLegRingSize,
  resetTickLegRing,
  slowTickLegDue,
  parseTickLegRing,
  nextSlowTickRing,
  TICK_LEG_RING_SIZE,
  TICK_LEG_SLOW_MS,
  TICK_LEG_SLOW_RING_SIZE,
} = require("../dist/worker.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

const STEP_ZERO = { bump: 0, init: 0, gate: 0, outage: 0, json: 0, claim: 0 };

/** A minimal but complete input; tests override the half they exercise. */
function input(over = {}) {
  return {
    at: 1_700_000_000_000,
    via: "cron",
    ok: true,
    ms: 5145,
    err: null,
    cut: false,
    cutNote: null,
    preTick: null,
    subs: null,
    summary: null,
    skip: null,
    ...over,
  };
}

test("a full tick maps every leg and the front split", () => {
  const row = buildTickLegRow(
    input({
      preTick: {
        at: 1_700_000_000_000 - 6_000,
        steps: { ...STEP_ZERO, init: 1223, claim: 260 },
        preStartMs: 1150,
        preRaceMs: 260,
        raceMs: 15_090,
      },
      subs: 29,
      summary: {
        profiles: 21,
        pool: 79,
        candidates: 0,
        pushed: 0,
        feedsMs: 530,
        preFeedMs: 236,
        poolMs: 2400,
        poolWaitMs: 1870,
        poolLegMs: {
          "pool-read": 1870,
          "front-write": 258,
          pairs: 1202,
          "pairs-jup": 168,
        },
        pairs: 98,
        pairsJup: 98,
        pairsMissing: 0,
        evalMs: 1624,
        dbMs: 1200,
        poolStale: 1259,
      },
    }),
  );
  assert.equal(row.ms, 5145);
  assert.equal(row.preStartMs, 1150);
  assert.equal(row.preRaceMs, 260);
  assert.equal(row.raceMs, 15_090);
  assert.equal(row.steps.init, 1223);
  assert.equal(row.steps.claim, 260);
  assert.equal(row.subs, 29);
  assert.equal(row.pool, 79);
  assert.equal(row.feedsMs, 530);
  assert.equal(row.poolMs, 2400);
  assert.equal(row.poolWaitMs, 1870);
  assert.deepEqual(row.poolLegMs, {
    "pool-read": 1870,
    "front-write": 258,
    pairs: 1202,
    "pairs-jup": 168,
  });
  assert.equal(row.pairs, 98);
  assert.equal(row.pairsJup, 98);
  assert.equal(row.evalMs, 1624);
  assert.equal(row.dbMs, 1200);
  assert.equal(row.poolStale, 1259);
});

test("the row copies its maps — later mutation must not rewrite a tick", () => {
  const steps = { ...STEP_ZERO, init: 1 };
  const legMap = { pairs: 5 };
  const row = buildTickLegRow(
    input({
      preTick: { at: 1, steps, preStartMs: 1, preRaceMs: 2, raceMs: 3 },
      summary: { poolLegMs: legMap },
    }),
  );
  steps.init = 99;
  legMap.pairs = 99;
  assert.equal(row.steps.init, 1);
  assert.equal(row.poolLegMs.pairs, 5);
});

test("a cut tick with no summary records null legs, not zeros", () => {
  const row = buildTickLegRow(
    input({
      ok: false,
      ms: 15_502,
      err: "scan exceeded its 15500ms race window (…) , cut in the pool stage (13625ms in)",
      cut: true,
      cutNote: "cut in the pool stage (13625ms in)",
    }),
  );
  assert.equal(row.ok, false);
  assert.equal(row.cut, true);
  assert.equal(row.cutNote, "cut in the pool stage (13625ms in)");
  assert.equal(row.feedsMs, null);
  assert.equal(row.poolMs, null);
  assert.equal(row.poolLegMs, null);
  assert.equal(row.evalMs, null);
  assert.equal(row.poolStale, null);
  assert.equal(row.preStartMs, null);
  assert.equal(row.steps, null);
});

test("the ring trims to capacity, keeping the newest", () => {
  resetTickLegRing();
  for (let i = 1; i <= TICK_LEG_RING_SIZE + 10; i++) {
    recordTickLeg(buildTickLegRow(input({ at: i, ms: i })));
  }
  assert.equal(tickLegRingSize(), TICK_LEG_RING_SIZE);
  const rows = tickLegRows(TICK_LEG_RING_SIZE);
  assert.equal(rows.length, TICK_LEG_RING_SIZE);
  assert.equal(rows[0].at, TICK_LEG_RING_SIZE + 10); // newest first
  assert.equal(rows[rows.length - 1].at, 11); // oldest 10 trimmed
});

test("tickLegRows clamps its limit", () => {
  resetTickLegRing();
  recordTickLeg(buildTickLegRow(input({ at: 1 })));
  recordTickLeg(buildTickLegRow(input({ at: 2 })));
  assert.equal(tickLegRows(1).length, 1);
  assert.equal(tickLegRows(1)[0].at, 2);
  assert.equal(tickLegRows(9999).length, 2);
  assert.equal(tickLegRows(9999)[0].at, 2);
  // A nonsense limit still answers with one tick rather than nothing.
  assert.equal(tickLegRows(0).length, 1);
  resetTickLegRing();
  assert.equal(tickLegRows(5).length, 0);
});

test("the durable threshold: slow is due at 8s, not a millisecond before", () => {
  assert.equal(slowTickLegDue(TICK_LEG_SLOW_MS - 1), false);
  assert.equal(slowTickLegDue(TICK_LEG_SLOW_MS), true);
  assert.equal(slowTickLegDue(14_182), true);
});

test("parseTickLegRing drops junk and keeps the newest rows", () => {
  assert.deepEqual(parseTickLegRing(null), []);
  assert.deepEqual(parseTickLegRing(""), []);
  assert.deepEqual(parseTickLegRing("not json"), []);
  assert.deepEqual(parseTickLegRing("{}"), []);
  assert.deepEqual(parseTickLegRing('[1,null,{"at":"x"},{}]'), []);
  const rows = [];
  for (let i = 1; i <= TICK_LEG_SLOW_RING_SIZE + 5; i++) {
    rows.push({ at: i, ms: 9000 + i });
  }
  const parsed = parseTickLegRing(JSON.stringify(rows));
  assert.equal(parsed.length, TICK_LEG_SLOW_RING_SIZE);
  assert.equal(parsed[0].at, 6); // the oldest 5 dropped
  assert.equal(parsed[parsed.length - 1].at, TICK_LEG_SLOW_RING_SIZE + 5);
});

test("nextSlowTickRing appends this tick and trims the oldest", () => {
  const row = buildTickLegRow(input({ at: 99, ms: 9000 }));
  const seeded = JSON.stringify([
    { at: 1, ms: 9000 },
    { at: 2, ms: 9999 },
  ]);
  assert.deepEqual(nextSlowTickRing(seeded, row).map((r) => r.at), [1, 2, 99]);
  // A full ring drops exactly one, the oldest.
  const full = [];
  for (let i = 1; i <= TICK_LEG_SLOW_RING_SIZE; i++) {
    full.push({ at: i, ms: 9000 });
  }
  const trimmed = nextSlowTickRing(JSON.stringify(full), row);
  assert.equal(trimmed.length, TICK_LEG_SLOW_RING_SIZE);
  assert.equal(trimmed[0].at, 2);
  assert.equal(trimmed[trimmed.length - 1].at, 99);
});

test("the flush records before the completion write, and the route exists", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "worker.ts"),
    "utf8",
  );
  const recordAt = src.indexOf("recordTickLeg(");
  const flushAt = src.indexOf("const flushCompletion =");
  assert.ok(recordAt > 0, "the flush path must record a ring row");
  assert.ok(flushAt > 0, "the completion write must exist");
  assert.ok(
    recordAt < flushAt,
    "the ring must be recorded before the flush it describes",
  );
  assert.ok(
    src.includes('url.pathname === "/debug/tick-legs"'),
    "the /debug/tick-legs route must be registered",
  );
  // The durable half: the sink must be gated on the slow threshold (a write
  // per tick would be the round-trip flood the ring exists to avoid), fired
  // before the flush so the reserve still covers it.
  const slowGateAt = src.indexOf("slowTickLegDue(legRow.ms)");
  const sinkAt = src.indexOf("persistSlowTickLeg(legRow)");
  assert.ok(slowGateAt > 0, "the durable sink is gated on the slow threshold");
  assert.ok(sinkAt > slowGateAt, "a slow tick really fires the durable write");
  assert.ok(
    sinkAt < flushAt,
    "the durable write is fired before the completion flush, not after it",
  );
  assert.ok(
    src.includes("db?.getWorkerState(TICK_LEG_SLOW_KEY)"),
    "the route reads the durable ring, not only the in-memory one",
  );
});

console.log(`\ntick leg ring: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
