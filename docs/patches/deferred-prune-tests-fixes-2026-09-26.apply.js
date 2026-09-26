#!/usr/bin/env node
/**
 * Deferred-prune test fixes (2026-09-26): re-point the pre-existing deferral
 * tests at the counter's new shape, and fix one assertion the new test got
 * backwards.
 *
 * The churn is the same class round 3 and round 4 had: adding a field to a
 * tested shape breaks every `deepEqual` that pins the WHOLE shape. Three here,
 * all in the same family:
 *
 *  - `pushDeferralDelta` now returns `{deferred, recovered, pruned}` — three
 *    deep-equals pin the old two-field object;
 *  - the cold `loadPushDeferralSnapshot` mirror gains `prunedTotal` /
 *    `firstPruneAt` / `lastPruneAt`, and its deep-equal pins every key;
 *  - the ACK test's re-offer expectation.
 *
 * The fourth edit is NOT churn: the new registry test asserted that a retired
 * token cannot be re-admitted by `defer()`. That is backwards. `defer()` is
 * only called when a card SEND was refused a claim slice — which happens after
 * the coin passed every gate, age included — so a fresh deferral of a mint
 * that was pruned earlier is a genuinely new, live obligation. The zombie is
 * the opposite shape: its coin left the window and is never re-deferred, only
 * re-seeded from the durable list, and THAT is what the prune clears.
 *
 * Run: node docs/patches/deferred-prune-tests-fixes-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [label, old, new, alreadyApplied] — applied in order to ONE working copy. */
const EDITS = [
  [
    "pushDeferralDelta's first in-tick expectation carries the retired cursor",
    lines(
      `    // (the rebuild resets this cursor's location but not the counter — see`,
      `    // stalledUnflushed in worker.ts), so a chain-deferral-only tick is folded`,
      `    // in by nextPushDeferralSnapshot below rather than by this difference.`,
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),`,
      `      { deferred: 2, recovered: 1 },`,
      `    );`,
    ),
    lines(
      `    // (the rebuild resets this cursor's location but not the counter — see`,
      `    // stalledUnflushed in worker.ts), so a chain-deferral-only tick is folded`,
      `    // in by nextPushDeferralSnapshot below rather than by this difference.`,
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),`,
      `      { deferred: 2, recovered: 1, pruned: 0 },`,
      `    );`,
    ),
    (src) => src.includes("in by nextPushDeferralSnapshot below rather than by this difference.") &&
      src.includes("{ deferred: 2, recovered: 1, pruned: 0 },"),
  ],
  [
    "and so does the re-offer of the same delta",
    lines(
      `    // The re-offer after a failed write is the SAME delta (the caller only`,
      `    // advances its baseline once the write landed), so a lost write delays`,
      `    // the count by a tick instead of dropping it.`,
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),`,
      `      { deferred: 2, recovered: 1 },`,
      `    );`,
    ),
    lines(
      `    // The re-offer after a failed write is the SAME delta (the caller only`,
      `    // advances its baseline once the write landed), so a lost write delays`,
      `    // the count by a tick instead of dropping it.`,
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),`,
      `      { deferred: 2, recovered: 1, pruned: 0 },`,
      `    );`,
    ),
    // The predicate reads the RE-OFFER block itself (its comment plus the line
    // under it), not "the shape exists somewhere": edit #1 already introduced
    // that exact object, and the first cut of this script let it mask this one.
    (src) =>
      src.includes("the count by a tick instead of dropping it.") &&
      src.includes(
        `      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),\n      { deferred: 2, recovered: 1, pruned: 0 },`,
      ) &&
      (src.split("the count by a tick instead of dropping it.")[1] ?? "").includes(
        "{ deferred: 2, recovered: 1, pruned: 0 },",
      ),
  ],
  [
    "the recovery-only delta carries it too",
    lines(
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 5, recovered: 2 }, { deferred: 6, recovered: 2 }),`,
      `      { deferred: 1, recovered: 0 },`,
      `    );`,
    ),
    lines(
      `    assert.deepEqual(`,
      `      pushDeferralDelta({ deferred: 5, recovered: 2 }, { deferred: 6, recovered: 2 }),`,
      `      { deferred: 1, recovered: 0, pruned: 0 },`,
      `    );`,
    ),
    (src) => src.includes("{ deferred: 1, recovered: 0, pruned: 0 },"),
  ],
  [
    "the cold mirror's shape gains the three prune fields",
    lines(
      `    assert.deepEqual(cold, {`,
      `      deferredTotal: 0,`,
      `      recoveredTotal: 0,`,
      `      stalledTotal: 0,`,
      `      firstStallAt: null,`,
      `      lastStallAt: null,`,
      `      pending: 0,`,
      `      pendingTokens: [],`,
      `      firstDeferredAt: null,`,
      `      lastDeferAt: null,`,
      `      firstRecoveredAt: null,`,
      `      lastRecoveredAt: null,`,
      `      events: [],`,
      `      applied: null,`,
      `    });`,
    ),
    lines(
      `    assert.deepEqual(cold, {`,
      `      deferredTotal: 0,`,
      `      recoveredTotal: 0,`,
      `      stalledTotal: 0,`,
      `      firstStallAt: null,`,
      `      lastStallAt: null,`,
      `      // The prune rule's cursor (2026-09-26): a row written before it existed`,
      `      // reads 0/null, exactly like the other counters' legacy shape.`,
      `      prunedTotal: 0,`,
      `      firstPruneAt: null,`,
      `      lastPruneAt: null,`,
      `      pending: 0,`,
      `      pendingTokens: [],`,
      `      firstDeferredAt: null,`,
      `      lastDeferAt: null,`,
      `      firstRecoveredAt: null,`,
      `      lastRecoveredAt: null,`,
      `      events: [],`,
      `      applied: null,`,
      `    });`,
    ),
    (src) => src.includes("      prunedTotal: 0,\n      firstPruneAt: null,"),
  ],
  [
    "the ACK test's re-offer expectation follows the delta",
    `    assert.deepEqual(reoffered, { deferred: 2, recovered: 0 }, "the delta really is re-offered");`,
    lines(
      `    assert.deepEqual(`,
      `      reoffered,`,
      `      { deferred: 2, recovered: 0, pruned: 0 },`,
      `      "the delta really is re-offered",`,
      `    );`,
    ),
    (src) => src.includes("      reoffered,\n"),
  ],
  [
    "the new registry test's backwards assertion",
    lines(
      `    dm.addDeferredToken("GONE", 9_999);`,
      `    assert.equal(dm.isDeferredToken("GONE"), false, "a retired token is not re-admitted by defer()");`,
      `    assert.equal(dm.deferredPrunedTotal(), 2);`,
    ),
    lines(
      `    // …and a NEW deferral of a pruned mint IS a fresh, live obligation:`,
      `    // defer() is only reached when a card SEND was refused a claim slice,`,
      `    // which happens after the coin passed every gate — age included. The`,
      `    // zombie shape is the opposite one: its coin left the window and is`,
      `    // never re-deferred, only re-seeded from the durable list, which is`,
      `    // exactly what the prune clears.`,
      `    dm.addDeferredToken("GONE", 9_999);`,
      `    assert.equal(`,
      `      dm.isDeferredToken("GONE"),`,
      `      true,`,
      `      "a new deferral re-admits it as a live debt",`,
      `    );`,
      `    dm.dropDeferredToken("GONE");`,
      `    assert.equal(dm.deferredPrunedTotal(), 2, "and the retirement stays counted");`,
    ),
    (src) => src.includes("a new deferral re-admits it as a live debt"),
  ],
];

const problems = [];
let src = read("scripts/test-unit.js");
const changed = [];
for (const [label, oldText, newText, already] of EDITS) {
  if (already(src)) {
    console.log(`skip scripts/test-unit.js: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`scripts/test-unit.js: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  src = src.replace(oldText, newText);
  changed.push(label);
  console.log(`ok   scripts/test-unit.js: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (changed.length === 0) {
  console.log("\nnothing to do — all edits already applied.");
  process.exit(0);
}
fs.writeFileSync(path.join(root, "scripts/test-unit.js"), src);
console.log(`\nwrote scripts/test-unit.js (${src.length} bytes)`);
