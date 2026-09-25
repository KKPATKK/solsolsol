#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.tests.apply.js` 嘅第二個收尾修正。
 *
 * 測試 1 為咗模擬「該欠嘅幣仍然欠」而 seed 咗共享 registry（`DeferredPushLedger`
 * 嘅 `defer` 寫入 `deferredTokenList()`，同 `Scanner.seedDeferredTokens` 同一個
 * registry —— 呢個 class 嘅 `pendingCount` 就係讀佢）。嗰個 token 一定要喺測試
 * 尾清走：`scripts/test-unit.js` 後面有個測試（`DeferredPushLedger: a deferred
 * coin is counted as recovered…`）斷言 `pendingCount` 嘅確切數目，剩一個就會炸。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "test 1 puts the shared registry back the way it found it",
    marker: 'forgetDeferredTokens(["OWED1"])',
    anchor: lines(
      '      assert.ok(',
      '        ledger.entries.some((e) => e.token === "W1"),',
      '        "the ledger reconciliation landed in the same batch",',
      '      );',
      '    } finally {',
      '      await t.cleanup();',
    ),
    replacement: lines(
      '      assert.ok(',
      '        ledger.entries.some((e) => e.token === "W1"),',
      '        "the ledger reconciliation landed in the same batch",',
      '      );',
      '      // The seed lives in the SHARED registry (deferredTokenList), which',
      '      // later tests in this file assert exact counts against: put it back.',
      '      require("../dist/scanner.js").forgetDeferredTokens(["OWED1"]);',
      '    } finally {',
      '      await t.cleanup();',
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
