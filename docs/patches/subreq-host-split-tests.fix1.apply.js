#!/usr/bin/env node
/**
 * Fix the expected row order in the host-split test.
 *
 * hostRows() sorts by count desc and breaks TIES on the host name, so a
 * reading is stable across polls instead of reordering itself between two
 * identical windows. The first version of the test listed the four count-1
 * hosts in the order the calls were made, which is not the order the reader
 * ever sees — "(unknown)" sorts first.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const old = lines(
  "    assert.deepEqual(view.current.hosts, [",
  "      { host: \"api.telegram.org\", count: 3 },",
  "      { host: \"api.dexscreener.com\", count: 1 },",
  "      { host: \"api.geckoterminal.com\", count: 1 },",
  "      { host: \"solana-meme-db.turso.io\", count: 1 },",
  "      { host: \"(unknown)\", count: 1 },",
  "    ]);",
);

const next = lines(
  "    assert.deepEqual(view.current.hosts, [",
  "      { host: \"api.telegram.org\", count: 3 },",
  "      // Ties break on the host name, so the same spend always reads back in",
  "      // the same order — and \"(\" sorts ahead of the dotted names.",
  "      { host: \"(unknown)\", count: 1 },",
  "      { host: \"api.dexscreener.com\", count: 1 },",
  "      { host: \"api.geckoterminal.com\", count: 1 },",
  "      { host: \"solana-meme-db.turso.io\", count: 1 },",
  "    ]);",
);

let text = fs.readFileSync(T, "utf8");
const at = text.indexOf(old);
if (at < 0) {
  console.error("MISS      test-unit: the host-split expectation");
  process.exit(1);
}
if (text.indexOf(old, at + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the host-split expectation");
  process.exit(1);
}
text = text.slice(0, at) + next + text.slice(at + old.length);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the host-split expectation");
