/*
 * THE CANDIDATE'S OWN WALL (2026-10-22, layer 0+1 of the slow-tick plan).
 *
 * WHY THIS FILE EXISTS: 20 slow ticks measured on 2026-10-22 spent
 * `evalMs` 7,098–7,286ms with ONE candidate and 8,265–9,422ms with 2–3, i.e.
 * the serial candidate chain ran to the shared `chainDeadline` every time and
 * the coins behind the first were deferred (`candidates 2, pushed 0`). Nothing
 * in the chain had a budget of its own:
 *
 *   - RugCheck's 2s+4s retry ladder is 6s of SLEEPS, and its 15s abort per
 *     attempt outlived the whole window; `bestEffort` only stops WAITING, so
 *     the ladder kept running in the background after the coin was gone.
 *   - the early Jupiter gates could wait the full chain remainder for a
 *     reading that is judged again (and properly held for) at the send gate.
 *
 * Layer 1 clamps each live step to a per-CANDIDATE wall
 * (`CANDIDATE_CHAIN_BUDGET_MS`), so a slow upstream costs its own coin's
 * decoration instead of the next coin's window. These tests pin the two halves
 * that can be checked offline:
 *
 *   1. RugCheck's ladder is bounded BOTH ways: an attempt is aborted at the
 *      remaining wall, and a retry backoff that would cross it is skipped —
 *      instead of 6s of sleeps after the caller's deadline.
 *   2. The throttle refuses a wait that would cross the deadline BEFORE
 *      sleeping (the sleep, unlike the await, cannot be abandoned).
 *   3. The scanner really passes the per-candidate wall to every live step it
 *      clamps (RugCheck, wallet analysis, Flurry) and gives the early Jupiter
 *      gate its own shorter wait, so a late reading cannot eat the chain.
 *   4. The arithmetic: two candidates fit the chain window with the push
 *      reserve intact — the number the budget was chosen for.
 *
 * Run: node scripts/test-rugcheck-deadline.js (npm run test:unit runs it after
 * the build, beside the other standalone suites).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { RugcheckClient } = require("../dist/rugcheck.js");
const {
  SCAN_TICK_DEADLINE_MS,
  CANDIDATE_PUSH_RESERVE_MS,
  CANDIDATE_CHAIN_BUDGET_MS,
  ORGANIC_GATE_WAIT_MS,
} = require("../dist/scanner.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

/** The config surface RugcheckClient reads (nothing else is consulted). */
const config = (intervalMs = 0) => ({ rugcheckRequestIntervalMs: intervalMs });

/** A well-formed report whose two percentages are derivable. */
const REPORT = {
  token: { supply: 1000 },
  insiderNetworks: [{ tokenAmount: 50 }],
  topHolders: [
    { owner: "a", pct: 10 },
    { owner: "b", pct: 5 },
    { owner: "lp", pct: 40 },
  ],
  // RugCheck's creator is accepted only at mint length (>= 32 chars).
  creator: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Restore fetch after each test (the client calls globalThis.fetch). */
const realFetch = globalThis.fetch;
function stubFetch(impl) {
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = realFetch;
  };
}

(async () => {
  // ---------- 1. the RugCheck ladder is bounded by the caller's wall --------

  await test("a 429 ladder stops at the deadline instead of sleeping 2s+4s", async () => {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    });
    try {
      const client = new RugcheckClient(config(0));
      const started = Date.now();
      await assert.rejects(
        client.getReport("mint", "pair", { deadline: Date.now() + 150 }),
        /429/,
      );
      const spent = Date.now() - started;
      assert.equal(calls, 1, "one attempt — the 2s backoff would cross the wall");
      assert.ok(spent < 1_000, `the refusal was immediate (spent ${spent}ms)`);
    } finally {
      restore();
    }
  });

  await test("the throttle refuses a wait that would cross the deadline BEFORE sleeping", async () => {
    const restore = stubFetch(async () => jsonResponse(REPORT));
    try {
      const client = new RugcheckClient(config(5_000));
      const first = await client.getReport("mint", "pair");
      assert.equal(first.bundlerPct, 5, "the first call pays the fetch and reads it");
      const started = Date.now();
      // The throttle's next slot is ~5s away; the deadline is 100ms out.
      await assert.rejects(
        client.getReport("mint", "pair", { deadline: Date.now() + 100 }),
        /throttle|deadline/i,
      );
      const spent = Date.now() - started;
      assert.ok(spent < 300, `no sleep was paid (spent ${spent}ms)`);
    } finally {
      restore();
    }
  });

  await test("a deadline far out leaves the happy path unchanged", async () => {
    const restore = stubFetch(async () => jsonResponse(REPORT));
    try {
      const client = new RugcheckClient(config(0));
      const report = await client.getReport("mint", "lp", {
        deadline: Date.now() + 60_000,
      });
      assert.equal(report.bundlerPct, 5);
      assert.equal(report.top10HolderPct, 15, "the LP holder is excluded");
      assert.equal(report.creator, REPORT.creator);
    } finally {
      restore();
    }
  });

  // ---------- 2. the scanner passes the wall to every live step ------------

  const scannerSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "scanner.ts"),
    "utf8",
  );
  const rugcheckSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "rugcheck.ts"),
    "utf8",
  );

  await test("every clamped chain step takes the CANDIDATE wall, not the shared one", async () => {
    assert.ok(
      scannerSrc.includes("const candidateDeadline = Math.min(") &&
        scannerSrc.includes("Date.now() + CANDIDATE_CHAIN_BUDGET_MS,"),
      "the candidate wall is computed once, off the shared deadline and the budget",
    );
    // The one step whose own ladder used to outlive the coin.
    assert.ok(
      scannerSrc.includes("this.resolveRugcheckData(coin, candidateDeadline)"),
      "RugCheck is resolved inside the candidate's wall",
    );
    assert.ok(
      scannerSrc.includes("deadline: candidateDeadline,"),
      "the wallet walk's serial RPC budget is the candidate's",
    );
    assert.ok(
      scannerSrc.includes(
        "Math.min(candidateDeadline, Date.now() + FLURRY_ANALYZE_CAP_MS),",
      ),
      "the Flurry wait still keeps its own cap under the candidate wall",
    );
    // The other live steps are clamped by the bestEffort race.
    for (const step of ["rugcheck", "crime", "axiom", "wallets", "flurry"]) {
      assert.ok(
        scannerSrc.includes(`this.markPhase(diag, "${step}", startedAt);`),
        `the ${step} step is still stamped`,
      );
    }
    const candidateSection = scannerSrc.slice(
      scannerSrc.indexOf("const candidateDeadline = Math.min("),
      scannerSrc.indexOf("const liqRatioLow = mcapRatioLowBlockReason("),
    );
    assert.ok(
      candidateSection.includes("CANDIDATE_CHAIN_BUDGET_MS"),
      "the wall is the budget, not an inline number",
    );
    // And the shared deadline is still what caps it: a fast tick must not be
    // pushed past the send reserve just because the budget is generous.
    assert.ok(
      scannerSrc.includes("chainDeadline,\n          Date.now() + CANDIDATE_CHAIN_BUDGET_MS,"),
      "the candidate wall is min(chainDeadline, now + budget)",
    );
  });

  await test("the early Jupiter gates get a shorter wait than the coin itself", async () => {
    assert.ok(
      scannerSrc.includes("const organicGateDeadline = Math.min(") &&
        scannerSrc.includes("Date.now() + ORGANIC_GATE_WAIT_MS,"),
      "the gate's wait is its own constant",
    );
    assert.ok(
      scannerSrc.includes(
        "await this.bestEffort(() => organicSlot, organicGateDeadline, null)",
      ),
      "the early gate races that shorter wait, not the chain wall",
    );
    assert.equal(
      ORGANIC_GATE_WAIT_MS < CANDIDATE_CHAIN_BUDGET_MS,
      true,
      "a gate that can only fail open must not outlive the coin's own steps",
    );
  });

  await test("the RugCheck client's ladder is bounded both ways (source pin)", async () => {
    assert.ok(
      rugcheckSrc.includes("Math.max(1, deadline - Date.now())"),
      "an attempt is aborted at the remaining wall",
    );
    assert.ok(
      rugcheckSrc.includes(
        "Math.min(REQUEST_TIMEOUT_MS, remaining),",
      ),
      "the 15s ceiling still caps a normal attempt",
    );
    assert.ok(
      rugcheckSrc.includes("if (deadline !== undefined && Date.now() + backoff >= deadline) break;"),
      "a retry backoff that would cross the wall is skipped",
    );
    assert.ok(
      rugcheckSrc.includes("if (deadline !== undefined && Date.now() + wait >= deadline) {"),
      "the throttle refuses the wait before paying it",
    );
  });

  // ---------- 3. the arithmetic the budget was chosen for ------------------

  await test("two candidates fit the chain window with the send reserve intact", async () => {
    const chainWindowMs = SCAN_TICK_DEADLINE_MS - CANDIDATE_PUSH_RESERVE_MS;
    assert.equal(chainWindowMs, 8_100, "the window every chain step shares");
    assert.ok(
      CANDIDATE_CHAIN_BUDGET_MS * 2 <= chainWindowMs,
      `two candidates (${CANDIDATE_CHAIN_BUDGET_MS * 2}ms) must fit ${chainWindowMs}ms`,
    );
    assert.ok(
      CANDIDATE_CHAIN_BUDGET_MS < chainWindowMs,
      "one candidate must leave room for the send that follows it",
    );
    assert.ok(
      CANDIDATE_CHAIN_BUDGET_MS - ORGANIC_GATE_WAIT_MS >= 2_000,
      "the budget leaves the gate's wait and the free steps room inside it",
    );
  });

  console.log(
    `\nrugcheck / candidate wall: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
})();
