#!/usr/bin/env node
/**
 * The CUT-proof test now sees TWO promises ride the tick, not one.
 *
 * It pinned `held.length === 1` when the cut's proof was the only thing the pass
 * handed to `waitUntil`. The reservation → final-write span hold
 * (docs/patches/tracker-row-span-hold.apply.js) rides the same hook for the same
 * row, so the assertion has to name both — and keep naming which one is the
 * proof, because that is the one whose settlement writes the audit entry.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const oldString =
  '    assert.equal(held.length, 1, "the cut\'s proof promise is handed to the tick");';
const newString = lines(
  "    // TWO promises ride the tick for this row: the reservation → final-write",
  "    // span hold (holdRowSpan — created before the reservation, released by",
  "    // the final write) and this cut's proof. The SECOND is the one whose",
  "    // settlement writes the audit entry.",
  "    assert.equal(",
  "      held.length,",
  "      2,",
  '      "the span hold AND the cut\'s proof are handed to the tick",',
  "    );",
);

let text = fs.readFileSync(T, "utf8");
if (!text.includes(oldString)) {
  console.error("MISS      test-unit: the cut-proof held length");
  process.exit(1);
}
if (text.indexOf(oldString, text.indexOf(oldString) + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the cut-proof held length");
  process.exit(1);
}
text = text.replace(oldString, newString);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the cut-proof test names both held promises");
