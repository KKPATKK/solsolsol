#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.tests.apply.js` 嘅第五個收尾修正：清理重複。
 *
 * fix3 同 fix4 互相取代嗰陣（fix3 一度仲用緊「未還原」嘅 marker），其中一次重跑
 * 令測試 2 嘅 gauge 斷言出現咗兩份。呢個 script 收返一份，並且落一句
 * 可以當 marker 嘅註解（唯一、重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "one gauge assertion, not two",
    marker: "      // The gauge is the list it publishes — one assertion, not two.",
    anchor: lines(
      "      assert.equal(",
      "        row.pending,",
      "        row.pendingTokens.length,",
      '        "and the gauge is the list it publishes",',
      "      );",
      "      assert.equal(",
      "        row.pending,",
      "        row.pendingTokens.length,",
      '        "and the gauge is the list it publishes",',
      "      );",
    ),
    replacement: lines(
      "      // The gauge is the list it publishes — one assertion, not two.",
      "      assert.equal(",
      "        row.pending,",
      "        row.pendingTokens.length,",
      '        "and the gauge is the list it publishes",',
      "      );",
    ),
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
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
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
