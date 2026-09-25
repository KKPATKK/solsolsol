#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.tests.apply.js` 嘅收尾修正。
 *
 * 第一次跑完之後有兩個**測試本身**嘅問題（src 冇事）：
 *
 * 1. 測試 2 一開始就把 flaky client 設成「write 即 throw」，但 `taildb.init()`
 *    本身就會寫 schema（write-mode batch）—— init 先炸，測試冇行到。改為 init
 *    之後才武裝。
 * 2. 測試 1 斷言 `pendingTokens === ["OWED1"]`，但 delta 寫嘅 list 係
 *    `deferredPushTokens()`（共享 registry）：生產由 `refreshMirror()` →
 *    `scanner.seedDeferredTokens()` 填，測試冇 scanner 所以係空。改為自己
 *    seed（同 test-deferred-priority.js 一樣）+ 斷言「該欠嘅仍然欠、唔該欠嘅
 *    冇咗」。
 * 3. 順手：兩個測試開頭/尾清走本 process 之前累積嘅 skip-capture 同 Birdeye
 *    delta，令 round trip 數目淨係計 tail 自己嘅。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const ARMED = lines(
  '      let failWrites = false;',
  '      const flaky = {',
);

const ARM_AFTER_INIT = lines(
  '      const taildb = new Db(t.p, undefined, flaky);',
  '      await taildb.init();',
  '      failWrites = true;',
  '      const { syncPushDeferralCounters } = require("../dist/worker.js");',
  '      // Three qualifying candidates, no card, nothing refused a claim: the',
);

const SEED = lines(
  '      await db.upsertPushWatch({',
  '        token: "W1", chatId: "c", symbol: "W1",',
  '        pushedAt: now - 60_000, mcapAtPush: 67_056, liquidityUsd: 50_000,',
  '      });',
  '      // The coin still owed is in the SHARED registry, as it is in production',
  '      // (the tail\'s own refreshMirror seeds it from the row it just read), and',
  '      // any delta this process accumulated earlier is drained — so the',
  '      // round-trip count below is the tail\'s own.',
  '      new DeferredPushLedger().defer("OWED1", now - 60_000);',
  '      require("../dist/skipcapture.js").resetSkipCapture();',
  '      const birdeye = require("../dist/birdeye.js");',
  '      birdeye.consumeBirdeyeCuDelta(birdeye.peekBirdeyeCuDelta());',
  '      let roundTrips = 0;',
  '      const counting = {',
);

const DROP_ASSERT = lines(
  '      assert.ok(',
  '        !row.pendingTokens.includes("STALE1"),',
  '        "the delivered obligation is dropped in the same transaction",',
  '      );',
  '      assert.ok(',
  '        row.pendingTokens.includes("OWED1"),',
  '        "and the one still owed is still owed",',
  '      );',
  '      assert.equal(',
  '        row.pending,',
  '        row.pendingTokens.length,',
  '        "the gauge is the list it publishes",',
  '      );',
);

const IDLE_DRAIN = lines(
  '      // Drained once more: this call must read and write nothing of its own.',
  '      require("../dist/skipcapture.js").resetSkipCapture();',
  '      consumeBirdeyeCuDelta(peekBirdeyeCuDelta());',
  '      let roundTrips = 0;',
  '      const counting = {',
  '        execute: (a) => t.client.execute(a),',
  '        batch: (a, m) => { roundTrips += 1; return t.client.batch(a, m); },',
  '        close: () => t.client.close(),',
  '      };',
  '      const idle = new Db(t.p, undefined, counting);',
);

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "test 2 arms its flaky client only after init's own schema writes",
    marker: "      let failWrites = false;",
    anchor: lines("      let failWrites = true;", "      const flaky = {"),
    replacement: ARMED,
  },
  {
    file: "scripts/test-unit.js",
    what: "and arms it once the Db is up",
    marker: "      failWrites = true;",
    anchor: lines(
      '      const taildb = new Db(t.p, undefined, flaky);',
      '      await taildb.init();',
      '      const { syncPushDeferralCounters } = require("../dist/worker.js");',
      '      // Three qualifying candidates, no card, nothing refused a claim: the',
    ),
    replacement: ARM_AFTER_INIT,
  },
  {
    file: "scripts/test-unit.js",
    what: "test 1 seeds the shared registry and drains foreign deltas",
    marker: 'new DeferredPushLedger().defer("OWED1"',
    anchor: lines(
      '      await db.upsertPushWatch({',
      '        token: "W1", chatId: "c", symbol: "W1",',
      '        pushedAt: now - 60_000, mcapAtPush: 67_056, liquidityUsd: 50_000,',
      '      });',
      '      let roundTrips = 0;',
      '      const counting = {',
    ),
    replacement: SEED,
  },
  {
    file: "scripts/test-unit.js",
    what: "so the drop is asserted as \"the audited one is gone, the owed one stays\"",
    marker: '        "and the one still owed is still owed",',
    anchor: lines(
      '      assert.deepEqual(',
      '        row.pendingTokens,',
      '        ["OWED1"],',
      '        "the delivered obligation is dropped in the same transaction",',
      '      );',
      '      assert.equal(row.pending, 1, "and the gauge follows the trimmed list");',
    ),
    replacement: DROP_ASSERT,
  },
  {
    file: "scripts/test-unit.js",
    what: "test 2's idle call gets a clean slate of its own",
    marker: "      // Drained once more: this call must read and write nothing of its own.",
    anchor: lines(
      '      let roundTrips = 0;',
      '      const counting = {',
      '        execute: (a) => t.client.execute(a),',
      '        batch: (a, m) => { roundTrips += 1; return t.client.batch(a, m); },',
      '        close: () => t.client.close(),',
      '      };',
      '      const idle = new Db(t.p, undefined, counting);',
    ),
    replacement: IDLE_DRAIN,
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
