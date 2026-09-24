#!/usr/bin/env node
/**
 * fix1 for the pre-init arrival stamp tests: pin the GATE, not a mention.
 *
 * The first version asserted the ORDER of `shouldStampArrival(...)` against the
 * scheduled handler's `ensureInitialized` — and stayed green under the negative
 * control, because `if (false && shouldStampArrival(...))` still contains the
 * text. The stripped source turns the real gate into
 * `if(shouldStampArrival(scheduledTickFinishedAt,cronAt)){`, which a neutralised
 * condition cannot satisfy. Safe to run twice.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const old =
  '    const stampCall = workerSrc.indexOf("shouldStampArrival(scheduledTickFinishedAt,cronAt)");';
const next = [
  "    // The GATE, not merely a mention of the rule: the stripped whitespace turns",
  "    // the call into `if(shouldStampArrival(...)){`, so a condition that is",
  "    // present but neutralised (or moved out of the gate) still fails here.",
  '    const stampCall = workerSrc.indexOf("if(shouldStampArrival(scheduledTickFinishedAt,cronAt)){");',
].join("\n");

const text = fs.readFileSync(T, "utf8");
if (text.includes(next)) {
  console.log("ok        test-unit: the wiring pin checks the gate");
  process.exit(0);
}
if (text.indexOf(old) < 0) {
  console.error("MISS      test-unit: the stampCall pin (apply the tests patch first)");
  process.exit(1);
}
if (text.indexOf(old, text.indexOf(old) + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the stampCall pin");
  process.exit(1);
}
fs.writeFileSync(T, text.replace(old, next));
console.log("ok        test-unit: the wiring pin checks the gate");
