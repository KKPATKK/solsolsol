#!/usr/bin/env node
/**
 * Test half of docs/patches/holder-probe-slots-measured.apply.js.
 *
 * The stage now starts ONE holder probe a pass (the rate the 30-minute refresh
 * window needs) and its cap is the endpoint's measured latency (2_400ms, live
 * 1_008-2_525ms) plus the one gate a call may queue behind — so the tests that
 * pinned the old shape (whole due head when the slice covered gate + fetch, cap
 * 1_200, a 2s allowance that fit a probe) are re-pinned here:
 *
 *  - "a hanging Birdeye holder probe is capped and skipped": the bound is now
 *    2_400 + the 200ms gate, so the pass returns near 2_600ms, not 1_400.
 *  - "holder probes start with the pair batch...": the pass must hand the stage
 *    more than the cap for a probe to start at all, so its allowance goes
 *    2_000 -> 4_500ms (the row loop still eats its 1_600ms first, and the point
 *    of the test is unchanged: the stage still writes the count it proves).
 *  - "holder probe slots follow the Birdeye throttle...": one probe, one write,
 *    `probe1 miss0` and the three rows it cannot reach reported as `cut`; the
 *    hanging half now settles at 2_600 with one miss, not 1_400 with two.
 *  - "a pass with no room for the probes...": comment only (the cap it names).
 *
 * scripts/test-unit.js is far past the file tools' edit window (see
 * docs/round-trips.md §6). Same discipline: every replacement must match
 * EXACTLY once or nothing is written at all.
 */
const fs = require("fs");

const TU = "scripts/test-unit.js";
const B = "`"; // a literal backtick, kept out of the templates below

const edits = [
  {
    name: "the hanging probe returns at the measured cap (2400 + 200)",
    old:
      "    assert.ok(\n" +
      "      elapsed >= 1_300,\n" +
      "      " + B + "the cap carries the 200ms gate (1200 + 200), took ${elapsed}ms" + B + ",\n" +
      "    );\n" +
      "    assert.ok(elapsed < 2_000, " + B + "the pass must return near the holder cap, took ${elapsed}ms" + B + ");",
    next:
      "    assert.ok(\n" +
      "      elapsed >= 2_500,\n" +
      "      " + B + "the cap carries the 200ms gate (2400 + 200), took ${elapsed}ms" + B + ",\n" +
      "    );\n" +
      "    assert.ok(elapsed < 3_400, " + B + "the pass must return near the holder cap, took ${elapsed}ms" + B + ");",
  },
  {
    name: "the pair-batch test's row-loop cost, restated for the bigger allowance",
    old:
      "      // The row loop is the pass's clock (Turso round trips): one batched trip\n" +
      "      // that costs the whole 2s allowance leaves the tail nothing at all.",
    next:
      "      // The row loop is the pass's clock (Turso round trips): one batched trip\n" +
      "      // that costs 1_600ms of the 4.5s allowance still leaves the stage room\n" +
      "      // for the one probe its cap needs.",
  },
  {
    name: "the pair-batch test's slice wording",
    old:
      "    // dispatch sees the pass's whole allowance — and still must not start what\n" +
      "    // the collect cannot reach (see the slot test below). This pass hands the\n" +
      "    // stage a ~1_950ms slice, which is less than the 1_200 + 1_100 one gate\n" +
      "    // costs, so only the single probe that needs no gate starts.",
    next:
      "    // dispatch sees the pass's whole allowance — and still must not start what\n" +
      "    // the collect cannot reach (see the slot test below). This pass hands the\n" +
      "    // stage a ~2_900ms slice, which covers the 2_400 + 1_100 one gate costs,\n" +
      "    // so the single probe the stage starts is one it can wait out.",
  },
  {
    name: "the pair-batch test's allowance and expectation",
    old:
      "    const out = await pw.runTick(Date.now() + 2_000);\n" +
      '    assert.equal(probes, 1, "a slice shorter than gate + fetch starts only the gate-free probe");',
    next:
      "    const out = await pw.runTick(Date.now() + 4_500);\n" +
      '    assert.equal(probes, 1, "one probe a pass is the rate the window needs");',
  },
  {
    name: "the slot test's premise: the measured endpoint, not the gate",
    old:
      "    // One rate gate serves every Birdeye call in the isolate\n" +
      "    // (BIRDEYE_REQUEST_INTERVAL_MS, 1100ms live — the stage shares it with the\n" +
      "    // scan's own Birdeye use). It is not a per-call queue: calls that arrived\n" +
      "    // in the same window fire TOGETHER, so probe 0 pays the fetch and every\n" +
      "    // later probe pays the fetch plus ONE gate (measured against the real\n" +
      "    // client: 302 / 1_402 / 1_402 / 1_404ms). Live 2026-09-23 every pass with\n" +
      "    // four due rows read " + B + "probe4 miss3" + B + " — three calls spent and three rows\n" +
      "    // parked for the 10-minute backoff, for ONE count — because each probe's\n" +
      "    // cap was the bare fetch cap.",
    next:
      "    // One rate gate serves every Birdeye call in the isolate\n" +
      "    // (BIRDEYE_REQUEST_INTERVAL_MS, 1100ms live — the stage shares it with the\n" +
      "    // scan's own Birdeye use). It is not a per-call queue: calls that arrived\n" +
      "    // in the same window fire TOGETHER, so N probes cost ONE wait, not N — and\n" +
      "    // the stage therefore starts ONE of them: the refresh window needs ~1\n" +
      "    // count a minute (29 tracked rows / 30 minutes ≈ 0.97), while each extra\n" +
      "    // probe is another Birdeye subrequest out of the invocation's 50 that the\n" +
      "    // old 1_200ms cap collected as a miss (" + B + "probe4 miss3" + B + ": three calls spent,\n" +
      "    // three rows parked for the 10-minute backoff, ONE count) — the endpoint's\n" +
      "    // own live latency is 1_008–2_525ms (measured 2026-09-23 from the\n" +
      "    // worker's egress), above that cap for five of six calls.",
  },
  {
    name: "the slot test's first half: one probe, one count, the rest cut",
    old:
      '    assert.equal(probes, 4, "the slice covers gate + fetch, so the whole due head starts");\n' +
      '    assert.equal(holderWrites.length, 4, "every count comes back, in the one batch");\n' +
      "    assert.match(String(out.note), /probe4 miss0/, " + B + "nothing is thrown away to the gate: ${out.note}" + B + ");\n" +
      "    assert.match(String(out.note), /held0 cut0/, " + B + "every due row got its turn: ${out.note}" + B + ");",
    next:
      '    assert.equal(probes, 1, "one probe a pass — the rate the window needs");\n' +
      '    assert.equal(holderWrites.length, 1, "and the count it brings back lands in the one batch");\n' +
      "    assert.match(String(out.note), /probe1 miss0/, " + B + "nothing is thrown away to the gate: ${out.note}" + B + ");\n" +
      "    assert.match(\n" +
      "      String(out.note),\n" +
      "      /held0 cut3/,\n" +
      "      " + B + "the rows it cannot reach stay due, never parked: ${out.note}" + B + ",\n" +
      "    );",
  },
  {
    name: "the slot test's hanging half: the cap carries the gate",
    old:
      "    // The cap carries the GATE, not just the fetch: with a 200ms interval both\n" +
      "    // hanging probes settle at 1_400 — one gate plus the fetch cap — where the\n" +
      "    // bare 1_200 used to collect them as misses.",
    next:
      "    // The cap carries the GATE, not just the fetch: with a 200ms interval the\n" +
      "    // hanging probe is given 2_400 + 200 and settles there, where the old bare\n" +
      "    // fetch cap used to collect it as a miss earlier.",
  },
  {
    name: "the slot test's hanging half: one slot, one miss, 2_600ms",
    old:
      '    assert.equal(hangProbes, 2, "a hanging probe does not stop the second slot from starting");\n' +
      "    assert.ok(\n" +
      "      elapsed >= 1_300,\n" +
      "      " + B + "each cap carries the 200ms gate (1200 + 200), so the pass waits for it: ${elapsed}ms" + B + ",\n" +
      "    );\n" +
      "    assert.ok(elapsed < 2_300, " + B + "and returns as soon as they settle: ${elapsed}ms" + B + ");\n" +
      '    assert.match(String(hangOut.note), /probe2 miss2/, ' + B + "two turns, two misses: ${hangOut.note}" + B + ");",
    next:
      '    assert.equal(hangProbes, 1, "one slot, so one hanging probe — the second row stays due");\n' +
      "    assert.ok(\n" +
      "      elapsed >= 2_500,\n" +
      "      " + B + "the cap carries the 200ms gate (2400 + 200), so the pass waits for it: ${elapsed}ms" + B + ",\n" +
      "    );\n" +
      "    assert.ok(elapsed < 3_400, " + B + "and returns as soon as it settles: ${elapsed}ms" + B + ");\n" +
      '    assert.match(String(hangOut.note), /probe1 miss1/, ' + B + "one turn, one miss: ${hangOut.note}" + B + ");",
  },
  {
    name: "the no-room test names the measured cap",
    old: "    // 1s allowance: less than the 1200ms cap a probe needs, so none starts.",
    next: "    // 1s allowance: less than the 2400ms cap a probe needs, so none starts.",
  },
];

let text = fs.readFileSync(TU, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      tu: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS tu: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        tu: " + e.name);
}
fs.writeFileSync(TU, text);
