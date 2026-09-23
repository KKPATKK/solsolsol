#!/usr/bin/env node
/**
 * Add the reservation → final-write span-hold tests to scripts/test-unit.js.
 *
 * An apply script because test-unit.js is past the file-tool window (the same
 * reason, and the same shape, as the other *.apply.js scripts here).
 *
 * WHY THESE CASES
 * The hold's whole value is a property that is invisible in the pass's own
 * output: an abandoned pass no longer dies between a committed reservation and
 * the write that records it. Three things have to hold, and each is pinned
 * here, because getting any of them wrong is silent:
 *   1. the span promise actually reaches the tick's waitUntil (an un-held span
 *      is exactly the bug — it just looks fine when the pass finishes);
 *   2. it stays pending across the final write and is released BY it (a hold
 *      released early protects nothing);
 *   3. a LOST reservation releases at once (a hold left to its timer on every
 *      lost race would pin the invocation for seconds per pass).
 * Plus the bound itself, so the timer can never be shortened below the span's
 * worst case or grown past the pass's own envelope.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const requireOld =
  'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair } = require("../dist/pushwatch.js");';
const requireNew =
  'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair, TRACKER_ROW_SPAN_HOLD_MS } = require("../dist/pushwatch.js");';

const anchor =
  '  await test("PushWatcher: a hanging Birdeye holder probe is capped and skipped", async () => {';

const tests = lines(
  '  await test("PushWatcher: the reservation → final-write span is HELD for the tick", async () => {',
  "    // docs/duplicate-cards.md §17.5, third bullet. The reservation commits the",
  "    // transition BEFORE the send, so between it and the final",
  "    // `updatePushWatchCheck` the row is announced to every other isolate with",
  "    // none of the bookkeeping that says so. An abandoned pass used to die in",
  "    // that gap (nothing kept the isolate alive for it), and the next pass read",
  "    // the reservation and refused to re-fire: a silent missing card.",
  "    const alerting = (token) =>",
  '      watchRow(token, { mcapAtPush: 10_000, peakMcap: 10_000 });',
  "    // 10x the push mcap, so the row really has a card to send.",
  "    const pairsUp = async (addrs) =>",
  "      new Map(addrs.map((a) => [a, { ...watchPair(a), marketCap: 100_000 }]));",
  "",
  "    // ---- the span is held, and the FINAL WRITE releases it ----------------",
  "    const updated = [];",
  "    const db = watchDb([alerting(\"AAA\")], updated);",
  "    // Hold the final write pending: that is the one moment the row is",
  "    // reserved-but-unwritten, and therefore the only moment the hold is",
  "    // load-bearing.",
  "    let finishFinal;",
  "    db.updatePushWatchCheck = (token, v) =>",
  "      new Promise((res) => {",
  "        finishFinal = () => { updated.push([token, v]); res(); };",
  "      });",
  "    const held = [];",
  "    const pw = new PushWatcher(",
  "      db,",
  "      watchBot,",
  "      null,",
  "      loadConfig({}),",
  "      pairsUp,",
  "      null,",
  "    );",
  "    const running = pw.runTick(Date.now() + 2_500, (p) => held.push(p));",
  "    for (let i = 0; i < 60 && !finishFinal; i += 1) {",
  "      await new Promise((r) => setTimeout(r, 10));",
  "    }",
  '    assert.ok(finishFinal, "the pass reached the row\'s final write");',
  '    assert.equal(held.length, 1, "the reservation → final-write span is handed to the tick");',
  "    let settled = false;",
  "    void held[0].then(() => { settled = true; });",
  "    await new Promise((r) => setTimeout(r, 0));",
  '    assert.equal(settled, false, "still held while the final write is in flight");',
  "    finishFinal();",
  "    await running;",
  "    await new Promise((r) => setTimeout(r, 0));",
  '    assert.equal(settled, true, "the final write releases the hold (not the timer)");',
  '    assert.equal(updated.length, 1, "the row\'s bookkeeping landed");',
  "",
  "    // ---- a LOST reservation releases at once ------------------------------",
  "    const updated2 = [];",
  "    const db2 = watchDb([alerting(\"BBB\")], updated2);",
  "    db2.reservePushWatchAlert = async () => false;",
  "    const held2 = [];",
  "    const pw2 = new PushWatcher(db2, watchBot, null, loadConfig({}), pairsUp, null);",
  "    const t0 = Date.now();",
  "    await pw2.runTick(Date.now() + 2_500, (p) => held2.push(p));",
  "    const elapsed2 = Date.now() - t0;",
  '    assert.equal(held2.length, 1, "the span is held even across a reservation attempt");',
  "    let settled2 = false;",
  "    void held2[0].then(() => { settled2 = true; });",
  "    await new Promise((r) => setTimeout(r, 0));",
  '    assert.equal(settled2, true, "a lost reservation releases the span immediately");',
  "    assert.ok(",
  "      elapsed2 < TRACKER_ROW_SPAN_HOLD_MS,",
  '      `the pass returned before the timer could have released it (${elapsed2}ms)`,',
  "    );",
  '    assert.equal(updated2.length, 1, "the loser still writes its check fields");',
  "",
  "    // ---- the bound itself ------------------------------------------------",
  "    // It has to COVER the span's worst case (the send window plus the audit",
  "    // insert and the final write, each inside the row leash) or the hold",
  "    // releases while the span is still running, and it has to FIT INSIDE the",
  "    // pass's own envelope (the watchdog's 8s overrun) or a hold could outlive",
  "    // the pass it exists to protect.",
  "    assert.ok(",
  "      TRACKER_ROW_SPAN_HOLD_MS >= 1_000 + 2 * 1_500,",
  '      "covers the send cap plus two row-leash writes",',
  "    );",
  "    assert.ok(",
  "      TRACKER_ROW_SPAN_HOLD_MS <= 8_000,",
  '      "fits inside the pass envelope the watchdog bounds",',
  "    );",
  "  });",
  "",
  anchor,
);

let text = fs.readFileSync(T, "utf8");
if (text.includes("the reservation → final-write span is HELD for the tick")) {
  console.error("ALREADY   test-unit: the span-hold tests");
  process.exit(1);
}
for (const [what, needle] of [
  ["the pushwatch require", requireOld],
  ["the holder-probe test (anchor)", anchor],
]) {
  const at = text.indexOf(needle);
  if (at < 0) {
    console.error(`MISS      test-unit: ${what}`);
    process.exit(1);
  }
  if (text.indexOf(needle, at + 1) >= 0) {
    console.error(`AMBIGUOUS test-unit: ${what}`);
    process.exit(1);
  }
}
text = text.replace(requireOld, requireNew).replace(anchor, tests);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the span-hold tests");
