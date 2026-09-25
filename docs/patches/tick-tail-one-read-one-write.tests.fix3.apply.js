#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.tests.apply.js` 嘅第三個收尾修正。
 *
 * 測試 2（被拒嘅 batch）斷言咗 `!row.pendingTokens.includes("STALE1")`，但佢係
 * 喺**冇 scanner** 嘅 harness 入面跑：registry 空 ⇒ delta 寫傳俾
 * `nextPushDeferralSnapshot` 嘅 list 係空 ⇒ 佢按設計**保留上一條 row 嘅 list**
 * （「scanner 未 ready 嘅 isolate 唔應該抹走佢未讀到嘅義務」）。所以 STALE1 仍然
 * 喺 row 度 —— 呢個係原本就有嘅行為，唔係今次改動。改為斷言嗰條真正嘅不變式
 * （gauge === list 長度），並喺註解講清楚：有 registry 嘅情況（上一個測試已經
 * seed）才睇得到 drop。
 *
 * 注意：fix4 之後呢個改動已經被還原（seed 咗 registry 就真係睇得到 drop），
 * 所以 marker 揀嘅係**最終狀態**嗰句斷言 —— 順序跑（tests → fix1 → fix2 → fix3
 * → fix4）全部 ok，再跑一次全部都 `already`。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "test 2 asserts the gauge invariant instead of a scanner-free drop",
    marker: 'assert.ok(!row.pendingTokens.includes("STALE1"), "the drop lands with it");',
    anchor: lines(
      '      assert.ok(!row.pendingTokens.includes("STALE1"), "the drop lands with it");',
    ),
    replacement: lines(
      '      assert.equal(',
      '        row.pending,',
      '        row.pendingTokens.length,',
      '        "the gauge is the list it publishes",',
      '      );',
      '      // The drop itself is NOT re-asserted here on purpose: this test runs',
      '      // with an empty shared registry, and nextPushDeferralSnapshot keeps',
      '      // the previous list when the caller has none to publish (an isolate',
      '      // whose scanner is not ready must not erase obligations it has not',
      '      // read). The seeded test above is where that drop is visible.',
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
