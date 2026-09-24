#!/usr/bin/env node
/**
 * A revival needs a base, and the baseline repair needs a second trigger
 * (2026-09-24, found by verifying the previous deploy).
 *
 * WHY — the live reading that sent me here. The deploy that added
 * `Db.repairPushWatchBaselines` (docs/patches/drain-error-and-baseline-repair.
 * apply.js) did NOT repair 玉兔, because by then the row read `peak_mcap 0`:
 * `/debug/push-watch` had shown `peakMcap 70921` an hour earlier, and its other
 * columns were all 0 too (`mcap_at_push 0, dead_trough_mcap 0, last_mcap 0,
 * lastState null`, `followupsSent 9`). The repair's own honesty guard
 * (`peak_mcap > 0`) refused the row — correctly, since it must never invent a
 * number — so the question was where a high-water mark went.
 *
 * It went here:
 *
 *     const target = (row.deadTroughMcap ?? row.mcapAtPush) * RESURRECTION_MULT;
 *     if (live.mcap >= target) { ...peakMcap: live.mcap, resetBaselineMcap: live.mcap }
 *
 * For a row whose trough is 0 and whose baseline was never a reading (the exact
 * product of the heal's old 0-baseline enrollment), the target is 0 — and
 * `live.mcap >= 0` is true for EVERY reading, another 0 included. So the row
 * resurrects on every pass, and each resurrection returns `peakMcap:
 * live.mcap` and `resetBaselineMcap: live.mcap`, i.e. a NON-reading written
 * straight into both columns. The 0 baseline is therefore self-perpetuating: it
 * is what makes the target 0, and the target being 0 is what writes the 0 back.
 * The $70.9K peak was collateral — the same reset that replaces the push
 * baseline replaces the peak.
 *
 * So two edits, and they are one change: the guard stops the loop that destroys
 * the evidence, and the trigger makes sure a row that regains a reading is
 * repaired even on an isolate that already spent its one shot.
 *
 * An apply script because src/pushwatch.ts sits past the file-tool window; every
 * anchor must match exactly once or nothing is written.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "src/pushwatch.ts",
    what: "a revival target must have a base",
    marker: "const troughBase = row.deadTroughMcap ?? row.mcapAtPush;",
    anchor: lines(
      '  if (row.lastState === "dead") {',
      "    const target = (row.deadTroughMcap ?? row.mcapAtPush) * RESURRECTION_MULT;",
      "    if (live.mcap >= target) {",
    ),
    replacement: lines(
      '  if (row.lastState === "dead") {',
      "    // The revival target needs a real BASE, and `deadTroughMcap ?? mcapAtPush`",
      "    // is not one for a row whose trough hit 0 AND whose baseline was never a",
      "    // reading: the product is 0, and `live.mcap >= 0` is true for EVERY",
      "    // reading — another 0 included. That shape is not hypothetical, it is",
      "    // exactly what the heal's old 0-baseline enrollment produced, and the loop",
      "    // it feeds is self-perpetuating: the resurrection below returns",
      "    // `peakMcap: live.mcap` and `resetBaselineMcap: live.mcap`, i.e. a",
      "    // NON-reading written back into both columns, which is what keeps the",
      "    // target at 0 for the next pass.",
      "    //",
      "    // Live 2026-09-24 (玉兔, mcap_at_push 0, followupsSent 9): the row",
      "    // resurrected repeatedly and its $70.9K peak was overwritten with 0 — so",
      "    // the baseline repair could not touch it either, its `peak_mcap > 0`",
      "    // guard being the thing that must never invent a number.",
      "    //",
      "    // A trough of 0 IS a reading (a corpse's $0 LP — see the drain rules",
      "    // below), but it is still not a base, so the baseline is the fallback",
      "    // there: the coin has to regain 1.5 × what it was PUSHED at, not 1.5 ×",
      "    // nothing. When neither is a reading there is no target at all, and the",
      "    // row stays dead and silent — the fail-quiet direction, which is the same",
      "    // \"missing data never judges\" rule the liquidity guards use.",
      "    const troughBase = row.deadTroughMcap ?? row.mcapAtPush;",
      "    const target =",
      "      (troughBase > 0 ? troughBase : row.mcapAtPush) * RESURRECTION_MULT;",
      "    if (target > 0 && live.mcap >= target) {",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the repair's second trigger",
    marker: "needsBaselineRepair",
    anchor: lines(
      "    // A stored baseline that is not a READING is not a missing value but a",
      "    // POISONED one (live 2026-09-24: two rows carried mcap_at_push 0 — see",
      "    // docs/patches/pushwatch-zero-mcap-baseline.apply.js for what it poisons).",
      "    // The heal's guard stops new ones and this fixes the old ones, once per",
      "    // isolate, with ONE statement against the whole table.",
      "    //",
      "    // NOT driven by `rows` above, which is the tempting source (it is already",
      "    // in hand): it is capped at cfg.maxTracked with active rows first, so the",
      "    // live listing reads `rows 30/30` — every slot active and the row that",
      "    // needs the repair absent, because the shape a 0 baseline produces ends up",
      "    // terminal (a drained 💧 row), and terminal rows sort last. The rotation",
      "    // below cannot reach it either, for the same reason: it evaluates",
      "    // activeRows only.",
      "    if (!baselineRepairDone) {",
    ),
    replacement: lines(
      "    // A stored baseline that is not a READING is not a missing value but a",
      "    // POISONED one (live 2026-09-24: two rows carried mcap_at_push 0 — see",
      "    // docs/patches/pushwatch-zero-mcap-baseline.apply.js for what it poisons).",
      "    // ONE statement repairs them (Db.repairPushWatchBaselines), issued on two",
      "    // triggers that between them cover both shapes the pool can be in:",
      "    //",
      "    //   - `!baselineRepairDone`: once per isolate, and that is the only way to",
      "    //     reach a row the listing cannot SHOW. It is capped at cfg.maxTracked",
      "    //     with active rows first, and the other shape a 0 baseline takes is a",
      "    //     row in the 💧 drain path, which ends up terminal — and terminal rows",
      "    //     sort last. The rotation below cannot see it either: it evaluates",
      "    //     activeRows only.",
      "    //   - `rows`: a 0-baseline row that IS in the listing and carries a real",
      "    //     peak right now. This is what the one-shot alone misses — the",
      "    //     statement's own `peak_mcap > 0` guard needs the reading to exist at",
      "    //     the moment it runs, so an isolate that spent its one shot before the",
      "    //     reading arrived would leave the row poisoned for the rest of its",
      "    //     window. That is not cosmetic while the row is ACTIVE: with a baseline",
      "    //     of 0, chgSincePush divides against max(0, 1), so a phantom",
      "    //     +499,900% can drive the ⚡ divergence card.",
      "    //",
      "    // Both triggers are free once the pool is clean (a boolean and a listing",
      "    // that is already in hand), so the only cost is the statement itself, and",
      "    // it goes out only when one of them says there is something to fix.",
      "    const needsBaselineRepair =",
      "      !baselineRepairDone ||",
      "      rows.some((r) => r.mcapAtPush <= 0 && r.peakMcap > 0);",
      "    if (needsBaselineRepair) {",
    ),
  },

  // ------------------------------------------------------- scripts/test-unit --
  {
    file: "scripts/test-unit.js",
    what: "the evaluateWatch cases for a base-less revival",
    marker: "const zeroBase = row({",
    // Rides this script because that test sits at ~line 7400 of 10.8K, past
    // what the file tool will edit.
    anchor: lines(
      "    const legacy = evaluateWatch(row({ deadTroughMcap: null }), 1000, { mcap: 52_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);",
      "    assert.equal(legacy.alerts.length, 0);",
      '    assert.equal(legacy.lastState, "dead");',
    ),
    replacement: lines(
      "    const legacy = evaluateWatch(row({ deadTroughMcap: null }), 1000, { mcap: 52_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);",
      "    assert.equal(legacy.alerts.length, 0);",
      '    assert.equal(legacy.lastState, "dead");',
      "",
      "    // A row with NO base at all: a trough of 0 AND a baseline that is not a",
      "    // reading (the heal's old 0-mcap enrollment). `(deadTroughMcap ??",
      "    // mcapAtPush) x 1.5` is then 0, and `live.mcap >= 0` is true for EVERY",
      "    // reading — another 0 included — so the old comparison resurrected the row",
      "    // on every single pass. That is not merely a wrong card: the resurrection",
      "    // returns `peakMcap: live.mcap` and `resetBaselineMcap: live.mcap`, so it",
      "    // wrote the non-reading back into BOTH columns and thereby kept its own",
      "    // target at 0. Live 2026-09-24 (玉兔, mcap_at_push 0, followupsSent 9): the",
      "    // loop overwrote a $70.9K peak with 0, which is also why the baseline",
      "    // repair's `peak_mcap > 0` guard then had to refuse the row.",
      "    const zeroBase = row({ mcapAtPush: 0, peakMcap: 0, deadTroughMcap: 0 });",
      "    // The live LIQUIDITY is held at the row's last reading throughout these",
      "    // cases on purpose: the 💧 crash rule runs BEFORE the dead-state",
      "    // absorption, so a $0 reading here fires a drain card (and can terminalise",
      "    // the row) that has nothing to do with what is being pinned.",
      "    const dead0 = evaluateWatch(zeroBase, 1000, { mcap: 0, liquidity: 20_000, chg5m: 0, vol5m: 0, buysH1: 0, sellsH1: 0 }, cfg);",
      '    assert.deepEqual(dead0.alerts, [], "no revival card off a $0 target");',
      '    assert.equal(dead0.lastState, "dead", "the row stays dead");',
      '    assert.equal(dead0.resetBaselineMcap, undefined, "and no non-reading is written into the baseline");',
      "    // The same row WITH a live reading: still no revival — there is no base to",
      "    // beat — and no reset, while the measurement itself still lands.",
      "    const zeroBaseLive = evaluateWatch(zeroBase, 1000, { mcap: 5_000, liquidity: 20_000, chg5m: 3, vol5m: 500, buysH1: 5, sellsH1: 2 }, cfg);",
      '    assert.deepEqual(zeroBaseLive.alerts, [], "a live reading with no base is not a revival");',
      '    assert.equal(zeroBaseLive.lastState, "dead");',
      '    assert.equal(zeroBaseLive.resetBaselineMcap, undefined, "nothing is reset off a 0 target");',
      '    assert.equal(zeroBaseLive.peakMcap, 5_000, "while the measurement still lands");',
      "",
      "    // A stored trough of 0 IS a reading (a corpse's $0 LP) but still not a",
      "    // usable base, so the baseline is the fallback there: 50K x 1.5 = 75K.",
      "    // Without that fallback a coin that went all the way to zero could never",
      "    // come back at all.",
      "    const zeroTrough = row({ deadTroughMcap: 0 });",
      "    const belowBase = evaluateWatch(zeroTrough, 1000, { mcap: 60_000, liquidity: 30_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);",
      '    assert.deepEqual(belowBase.alerts, [], "60K is below the baseline-derived 75K floor");',
      '    assert.equal(belowBase.lastState, "dead");',
      "    const aboveBase = evaluateWatch(zeroTrough, 1000, { mcap: 80_000, liquidity: 30_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);",
      '    assert.equal(aboveBase.resetBaselineMcap, 80_000, "a real recovery off a 0 trough still revives");',
      "    assert.match(aboveBase.alerts[0].text, /死而復生 X/);",
    ),
  },

  // The note condition. First written as `repairedBaselines > 0`, i.e. visible
  // only when the statement actually CHANGED a row — which hides the one thing
  // the stage is worth watching for: a healthy pool's expected reading is
  // `fixed0` (the statement can only ever find rows left by pre-guard code), so
  // keying on the CHANGE made the stage unobservable in the only case that will
  // ever be normal. Keying on the TRIP keeps the note clean (once per isolate,
  // on its first pass, absent afterwards) while leaving a live check that the
  // stage is wired at all.
  {
    file: "src/pushwatch.ts",
    what: "stageNote: report the repair's TRIP, not only its wins",
    marker: "spent.repair.trips > 0",
    anchor: lines(
      "      // Only when there WAS one: the repair is a one-off backlog fix, and a",
      "      // permanent `repair 0/0 fixed0` would be one more number to read on",
      "      // every line of every note forever.",
      "      `${",
      "        repairedBaselines > 0",
      '          ? ` repair ${spent.repair.ms}/${spent.repair.trips} fixed${repairedBaselines}`',
      '          : ""',
      "      }` +",
    ),
    replacement: lines(
      "      // Only on the pass that RAN it: the repair is attempted once per",
      "      // isolate, so this is one line on a fresh isolate's first pass and",
      "      // absent forever after — never a permanent `repair 0/0 fixed0`. That is",
      "      // also what makes it a live check that the stage is wired at all, since",
      "      // the healthy reading is `fixed0`: the statement can only find rows left",
      "      // behind by pre-guard code, and there are none to find once it has run.",
      "      `${",
      "        spent.repair.trips > 0",
      '          ? ` repair ${spent.repair.ms}/${spent.repair.trips} fixed${repairedBaselines}`',
      '          : ""',
      "      }` +",
    ),
  },

  // The two fixtures above were first written with a $0 live liquidity, which
  // fires the 💧 crash rule that runs BEFORE the dead-state absorption — the row
  // terminalised and the case measured the wrong thing. Kept as its own step so
  // a tree that already carries the first version converges instead of silently
  // keeping a test that asserts through an unrelated card; on a fresh tree the
  // corrected text is already there and this is skipped.
  {
    file: "scripts/test-unit.js",
    what: "the base-less revival fixtures hold the liquidity steady",
    marker: "liquidity: 20_000, chg5m: 0, vol5m: 0",
    anchor: lines(
      "    const dead0 = evaluateWatch(zeroBase, 1000, { mcap: 0, liquidity: 0, chg5m: 0, vol5m: 0, buysH1: 0, sellsH1: 0 }, cfg);",
    ),
    replacement: lines(
      "    // The live LIQUIDITY is held at the row's last reading throughout these",
      "    // cases on purpose: the 💧 crash rule runs BEFORE the dead-state",
      "    // absorption, so a $0 reading here fires a drain card (and can terminalise",
      "    // the row) that has nothing to do with what is being pinned.",
      "    const dead0 = evaluateWatch(zeroBase, 1000, { mcap: 0, liquidity: 20_000, chg5m: 0, vol5m: 0, buysH1: 0, sellsH1: 0 }, cfg);",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the base-less revival's live-reading fixture too",
    marker: "liquidity: 20_000, chg5m: 3, vol5m: 500",
    anchor: lines(
      "    const zeroBaseLive = evaluateWatch(zeroBase, 1000, { mcap: 5_000, liquidity: 900, chg5m: 3, vol5m: 500, buysH1: 5, sellsH1: 2 }, cfg);",
    ),
    replacement: lines(
      "    const zeroBaseLive = evaluateWatch(zeroBase, 1000, { mcap: 5_000, liquidity: 20_000, chg5m: 3, vol5m: 500, buysH1: 5, sellsH1: 2 }, cfg);",
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
