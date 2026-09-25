#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.tests.apply.js` 嘅第四個收尾修正。
 *
 * 測試 2 由頭到尾都應該同測試 1 一樣 seed 共享 registry（`OWED1`）：唔係嘅話
 * delta 寫傳俾 `nextPushDeferralSnapshot` 嘅 list 係空 ⇒ 佢按設計保留上一條
 * row 嘅 list ⇒ `STALE1` 永遠留喺 row 度，每個 tick 都會再 drop 一次 ⇒ 最後
 * 「idle tick 只讀唔寫」嗰個斷言永遠計到 2。seed 咗之後：
 *
 *   - retry 之後嘅 row 真係 `["OWED1"]`（fix3 期間臨時放寬嘅斷言可以還原）；
 *   - idle call 冇嘢可以做 ⇒ 1 個 round trip、0 個 write。
 *
 * 用完一樣要清走（後面有測試斷言 registry 嘅確切數目）。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "test 2 seeds the owed token too (it is what makes the drop visible)",
    marker: 'defer("OWED1", now - 60_000);\n      let failWrites = false;',
    anchor: lines("      let failWrites = false;", "      const flaky = {"),
    replacement: lines(
      "      // The coin still owed rides the SHARED registry here too: without it",
      "      // the delta write has no list to publish and keeps the old one (see",
      "      // nextPushDeferralSnapshot), which would hide the guard's drop.",
      '      new DeferredPushLedger().defer("OWED1", now - 60_000);',
      "      let failWrites = false;",
      "      const flaky = {",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "so the drop assertion comes back (plus the gauge invariant)",
    marker: 'assert.ok(!row.pendingTokens.includes("STALE1"), "the drop lands with it");',
    anchor: lines(
      "      assert.equal(",
      "        row.pending,",
      "        row.pendingTokens.length,",
      '        "the gauge is the list it publishes",',
      "      );",
      "      // The drop itself is NOT re-asserted here on purpose: this test runs",
      "      // with an empty shared registry, and nextPushDeferralSnapshot keeps",
      "      // the previous list when the caller has none to publish (an isolate",
      "      // whose scanner is not ready must not erase obligations it has not",
      "      // read). The seeded test above is where that drop is visible.",
    ),
    replacement: lines(
      '      assert.ok(!row.pendingTokens.includes("STALE1"), "the drop lands with it");',
      "      assert.equal(",
      "        row.pending,",
      "        row.pendingTokens.length,",
      '        "and the gauge is the list it publishes",',
      "      );",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and test 2's seed is put back as well",
    marker: "// Same cleanup as the test above: this seed is shared module state.",
    anchor: lines(
      '      const settled = JSON.parse(await db.getWorkerState("push_deferral"));',
      '      assert.equal(settled.stalledTotal, 3, "and nothing is double-counted");',
      "    } finally {",
      "      await t.cleanup();",
    ),
    replacement: lines(
      '      const settled = JSON.parse(await db.getWorkerState("push_deferral"));',
      '      assert.equal(settled.stalledTotal, 3, "and nothing is double-counted");',
      "      // Same cleanup as the test above: this seed is shared module state.",
      '      require("../dist/scanner.js").forgetDeferredTokens(["OWED1"]);',
      "    } finally {",
      "      await t.cleanup();",
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
