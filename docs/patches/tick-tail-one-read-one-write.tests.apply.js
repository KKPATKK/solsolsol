#!/usr/bin/env node
/**
 * `tick-tail-one-read-one-write.apply.js` 嘅測試同文件。
 *
 * 1. `scripts/test-unit.js`：現有嘅 grouped-read 測試由「四個 key」擴到
 *    「caller 俾嘅 key set」（五條 row，包 `push_deferral`）；另加兩個**真**
 *    函數測試：
 *      - `worker: the whole tick tail is ONE read and ONE write` —— 真
 *        `syncPushDeferralCounters` ＋ 一個數 round trip 嘅 libsql client：
 *        duplicate guard 嘅 drop、telemetry merge、deferral row 全部
 *        **一個讀一個寫** 落地。
 *      - `worker: a rejected tail batch lands nothing and re-offers the delta`
 *        —— write 被拒時乜都唔動（連 shrink 都唔會自己一個落地），retry 原封
 *        不動再試一次（唔會 drop、唔會 double count），再下一個 tick 冇嘢做
 *        就只讀一次。
 * 2. `docs/round-trips.md` §4.12：成因（6 個 round trip 嘅清單）、新形狀、
 *    保留嘅紀律、價錢同量度方法。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const NEW_TESTS = lines(
  "  await test(\"worker: the whole tick tail is ONE read and ONE write\", async () => {",
  "    // Live 2026-09-25: the tail read its rows separately (the deferral row,",
  "    // then the audit ring + ledger row + watch listing, then a second",
  "    // four-row telemetry batch) and wrote separately (shrink, telemetry,",
  "    // deferral delta), so a tick with everything due spent SIX Turso round",
  "    // trips deciding what to write — every one of them a subrequest out of",
  "    // the invocation's 50, with the tracker pass spending the same budget",
  "    // LAST. This drives the real function against a counting client.",
  "    const t = tmpDb();",
  "    const now = Date.now();",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.saveChatSettings({",
  "        chatId: \"c\", ...DEFAULT_SETTINGS,",
  "        minMarketCapUsd: 40_000, maxMarketCapUsd: 380_000, enabled: true,",
  "      });",
  "      // Two pending obligations: one the audit ring proves delivered (the",
  "      // duplicate the guard exists to forget), one genuinely still owed.",
  "      await db.setWorkerState(\"push_deferral\", JSON.stringify({",
  "        deferredTotal: 5, recoveredTotal: 1, stalledTotal: 0,",
  "        pending: 2, pendingTokens: [\"STALE1\", \"OWED1\"], events: [],",
  "      }));",
  "      await db.setWorkerState(\"push_audit\", JSON.stringify([",
  "        { chatId: \"c\", token: \"STALE1\", symbol: \"S\", messageId: 1, kind: \"initial\", at: now - 30_000 },",
  "      ]));",
  "      await db.setWorkerState(\"push_ledger\", '{\"entries\":[],\"updatedAt\":0}');",
  "      await db.upsertPushWatch({",
  "        token: \"W1\", chatId: \"c\", symbol: \"W1\",",
  "        pushedAt: now - 60_000, mcapAtPush: 67_056, liquidityUsd: 50_000,",
  "      });",
  "      let roundTrips = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => { roundTrips += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const taildb = new Db(t.p, undefined, counting);",
  "      await taildb.init();",
  "      roundTrips = 0;",
  "      const { syncPushDeferralCounters } = require(\"../dist/worker.js\");",
  "      // No counter movement on purpose: the only deferral write due is the",
  "      // duplicate guard's shrink, which is the half that used to pay its own",
  "      // round trips before the telemetry even ran.",
  "      await syncPushDeferralCounters(",
  "        { pushPhase: \"done\", candidates: 0, pushed: 0, cardSendDeferred: 0, deferPending: 1 },",
  "        taildb,",
  "        now,",
  "      );",
  "      assert.equal(roundTrips, 2, \"the whole tail: ONE read, ONE write\");",
  "      const row = JSON.parse(await db.getWorkerState(\"push_deferral\"));",
  "      assert.deepEqual(",
  "        row.pendingTokens,",
  "        [\"OWED1\"],",
  "        \"the delivered obligation is dropped in the same transaction\",",
  "      );",
  "      assert.equal(row.pending, 1, \"and the gauge follows the trimmed list\");",
  "      assert.equal(row.deferredTotal, 5, \"no counters moved, so none were added\");",
  "      // The ledger merge rides the same read (the audit entry and the watch",
  "      // row are what it reconciles) and lands in the same write.",
  "      const ledger = JSON.parse(await db.getWorkerState(\"push_ledger\"));",
  "      assert.ok(",
  "        ledger.entries.some((e) => e.token === \"W1\"),",
  "        \"the ledger reconciliation landed in the same batch\",",
  "      );",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
  "  await test(\"worker: a rejected tail batch lands nothing and re-offers the delta\", async () => {",
  "    // The one-batch shape is only safe if a failure is all-or-nothing: no",
  "    // shrink without its delta, no telemetry without the row it belongs to.",
  "    // The held-back counter drives this DELIBERATELY (it is independent of",
  "    // the cursor baseline, which is module state shared with the test above).",
  "    const t = tmpDb();",
  "    const now = Date.now();",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.setWorkerState(\"push_deferral\", JSON.stringify({",
  "        deferredTotal: 5, recoveredTotal: 1, stalledTotal: 0,",
  "        pending: 2, pendingTokens: [\"STALE1\", \"OWED1\"], events: [],",
  "      }));",
  "      await db.setWorkerState(\"push_audit\", JSON.stringify([",
  "        { chatId: \"c\", token: \"STALE1\", symbol: \"S\", messageId: 1, kind: \"initial\", at: now - 30_000 },",
  "      ]));",
  "      let failWrites = true;",
  "      const flaky = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => {",
  "          if (m === \"write\" && failWrites) throw new Error(\"Too many subrequests\");",
  "          return t.client.batch(a, m);",
  "        },",
  "        close: () => t.client.close(),",
  "      };",
  "      const taildb = new Db(t.p, undefined, flaky);",
  "      await taildb.init();",
  "      const { syncPushDeferralCounters } = require(\"../dist/worker.js\");",
  "      // Three qualifying candidates, no card, nothing refused a claim: the",
  "      // held-back delta (see heldBackCandidates) is 3 and must be persisted.",
  "      await syncPushDeferralCounters(",
  "        { pushPhase: \"done\", candidates: 3, pushed: 0, cardSendDeferred: 0, deferPending: 2 },",
  "        taildb,",
  "        now,",
  "      );",
  "      const frozen = JSON.parse(await db.getWorkerState(\"push_deferral\"));",
  "      assert.equal(frozen.stalledTotal, 0, \"a rejected batch is not a partial application\");",
  "      assert.equal(frozen.deferredTotal, 5);",
  "      assert.deepEqual(",
  "        frozen.pendingTokens,",
  "        [\"STALE1\", \"OWED1\"],",
  "        \"not even the shrink landed on its own\",",
  "      );",
  "      // The retry: same held-back amount (this tick has no new ones), now",
  "      // past the telemetry throttle — it must land ONCE.",
  "      failWrites = false;",
  "      const later = now + 6 * 60_000;",
  "      await syncPushDeferralCounters(",
  "        { pushPhase: \"done\", candidates: 0, pushed: 0, cardSendDeferred: 0, deferPending: 2 },",
  "        taildb,",
  "        later,",
  "      );",
  "      const row = JSON.parse(await db.getWorkerState(\"push_deferral\"));",
  "      assert.equal(row.stalledTotal, 3, \"the re-offered held-back delta lands\");",
  "      assert.equal(row.deferredTotal, 5, \"and the cursor delta is not invented\");",
  "      assert.ok(!row.pendingTokens.includes(\"STALE1\"), \"the drop lands with it\");",
  "      // A third tick with nothing new: the deltas were cleared, so the tail",
  "      // reads (one request) and writes nothing at all.",
  "      let roundTrips = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => { roundTrips += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const idle = new Db(t.p, undefined, counting);",
  "      await idle.init();",
  "      roundTrips = 0;",
  "      await syncPushDeferralCounters(",
  "        { pushPhase: \"done\", candidates: 0, pushed: 0, cardSendDeferred: 0, deferPending: 0 },",
  "        idle,",
  "        later + 60_000,",
  "      );",
  "      assert.equal(roundTrips, 1, \"an idle tail is ONE read and no write\");",
  "      const settled = JSON.parse(await db.getWorkerState(\"push_deferral\"));",
  "      assert.equal(settled.stalledTotal, 3, \"and nothing is double-counted\");",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
);

const DOC_4_12 = lines(
  "**下一步（已做，見 §4.12）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped",
  "telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同",
  "「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。",
  "",
  "---",
  "",
  "## 4.12 tick tail：一個讀 + 一個寫（2026-09-25）",
  "",
  "§4.11 留低嘅下一刀：把 tail 嗰幾條一次性 state op 合併。做咗。",
  "",
  "**之前**（一個「全部到期」嘅 tick）",
  "",
  "| # | 動作 | round trip |",
  "|---|---|---|",
  "| 1 | `getWorkerState(push_deferral)` | 1 讀 |",
  "| 2 | duplicate guard：`getPushAudit()`；有 pending 時再加 `push_ledger` ＋ `listPushWatch(60)` | 1–3 讀 |",
  "| 3 | 有 deliver-proof 就寫 shrunken row | 1 寫 |",
  "| 4 | `syncPostScanTelemetry()`：`readPostScanTelemetry(4 keys)` ＋ 有嘢變就 `setWorkerStatesMany` | 1 讀 ＋ 1 寫 |",
  "| 5 | delta 落地 | 1 寫 |",
  "",
  "合計 **最多 6 個 Turso round trip**。",
  "",
  "**現在**",
  "",
  "- `Db.readPostScanTelemetry(stateKeys, limit)`：key set 由 caller 決定（worker 嘅",
  "  `TAIL_STATE_KEYS` = `push_deferral` / `push_ledger` / `push_audit` /",
  "  `skip_capture` / `birdeye_cu_v1`），SQL 用 `IN (?, …)` —— 同上面",
  "  `getWorkerStates(keys)` 一模一樣。兩個 listing（`push_watch` 60 行、enabled",
  "  chats）照舊，ORDER BY … LIMIT 不變。",
  "- `syncPushDeferralCounters(summary)` 變成整個 tail：**一個讀**（全部 row 一次）",
  "  → duplicate guard（純函數，唔再 await 自己嘅讀）→ shrink、三個 telemetry",
  "  merge、delta **一個 batch 寫**（`setWorkerStatesMany`）。",
  "- `syncPostScanTelemetry` / `runPostScanTelemetry` 退役。讀已經喺 tail 開頭",
  "  發生，所以 throttle 判斷搬入 tail，merge 本身變成 pure planner",
  "  `planPostScanTelemetry`（read 入；writes ＋ landed 之後才套嘅 side effect 出）。",
  "  三個 `*_SYNC_BOUND_MS` 跟住退役：一個讀一個寫唔需要三段 900ms race，tail 由",
  "  call site 一個 `DEFERRAL_SYNC_BOUND_MS` 包住。",
  "",
  "**紀律冇變**（呢個係合併，唔係簡化）",
  "",
  "- duplicate guard 依然第一個跑，in-memory drop 即刻應用 —— 同 §4.9 一樣：真正",
  "  阻止重複卡嘅係 in-memory 嗰半，寫入只係阻止日後 recycle 再 seed 返。",
  "- 所有 in-memory 前進（`pushDeferralBaseline`、`stalledUnflushed`、mirrors、三個",
  "  delta 嘅清除）**只在 batch landed 之後**。一個被拒嘅 batch 等於三條失敗嘅",
  "  單獨寫：乜都冇動，下個 tick 原封不動再試。shrink 亦因此唔會「自己一個落地」",
  "  而 delta 冇。",
  "- telemetry throttle 照舊「試過就前進」（best-effort；delta 未清就係 re-offer",
  "  機制）。",
  "- 同一條 row 兩次寫（shrink ＋ delta）嘅次序不變：後面嗰個 supersede 前面嗰個，",
  "  最終 row 同兩次獨立寫 byte-identical。",
  "",
  "**價錢**：每個 tick 都讀 5 條 row ＋ 60 行 watch ＋ chats（以前 idle tick 只讀",
  "2 條 row）。仍然係**一個** request；多咗約 35 行 rows-read/tick（≈50K/日，同 pool",
  "query 唔同量級）。換到：idle tick 2 讀 → 1 讀；全部到期嘅 tick 6 → **2** 個",
  "round trip。",
  "",
  "**量度**：`heartbeat.summary.dbTickSteps` 會顯示 `readPostScanTelemetry` 1 call",
  "（以前 `getWorkerState` ×2–3 ＋ `getPushAudit` ＋ `listPushWatch` ＋",
  "`readPostScanTelemetry`）同 `setWorkerStatesMany` ≤1 call（以前最多 3 個",
  "`setWorkerState`）。",
);

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "the grouped read's fifth row is the deferral snapshot it now serves",
    marker: 'await db.setWorkerState("push_deferral", \'{"pendingTokens":["P"],"deferredTotal":3}\');',
    anchor: lines(
      '      await db.setWorkerState("skip_capture", "not json");',
      '      await db.setWorkerState("birdeye_cu_v1", \'{"v":1,"days":{"2026-09-23":20}}\');',
    ),
    replacement: lines(
      '      await db.setWorkerState("skip_capture", "not json");',
      '      await db.setWorkerState("birdeye_cu_v1", \'{"v":1,"days":{"2026-09-23":20}}\');',
      '      await db.setWorkerState("push_deferral", \'{"pendingTokens":["P"],"deferredTotal":3}\');',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and the call passes a key set",
    marker: 'const grouped = await led.readPostScanTelemetry([',
    anchor: lines(
      "      const grouped = await led.readPostScanTelemetry(",
      '        "push_ledger", "push_audit", "skip_capture", "birdeye_cu_v1",',
      "      );",
      '      assert.equal(batchCalls, 1, "all four state rows + both listings ride ONE request");',
    ),
    replacement: lines(
      "      const grouped = await led.readPostScanTelemetry([",
      '        "push_ledger", "push_audit", "skip_capture", "birdeye_cu_v1", "push_deferral",',
      "      ]);",
      '      assert.equal(batchCalls, 1, "all FIVE state rows + both listings ride ONE request");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and every row it asked for comes back",
    marker: '        "the deferral snapshot the duplicate guard trims rides the same request",',
    anchor: lines(
      '      assert.equal(grouped.states.get("skip_capture"), "not json");',
      "      assert.equal(grouped.states.size, 4);",
    ),
    replacement: lines(
      '      assert.equal(grouped.states.get("skip_capture"), "not json");',
      "      assert.equal(",
      '        grouped.states.get("push_deferral"),',
      '        \'{"pendingTokens":["P"],"deferredTotal":3}\',',
      '        "the deferral snapshot the duplicate guard trims rides the same request",',
      "      );",
      "      assert.equal(grouped.states.size, 5);",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the tail's own two tests (one read + one write, and a rejected batch)",
    marker: 'await test("worker: the whole tick tail is ONE read and ONE write", async () => {',
    anchor: '  await test("worker: syncSkipCaptureState accumulates reasons across isolates", async () => {',
    replacement: lines(NEW_TESTS, '  await test("worker: syncSkipCaptureState accumulates reasons across isolates", async () => {'),
  },
  {
    file: "docs/round-trips.md",
    what: "§4.12: the round-trip inventory of a tick tail, before and after",
    marker: "## 4.12 tick tail：一個讀 + 一個寫",
    anchor: lines(
      "**下一步（未做）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped",
      "telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同",
      "「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。",
    ),
    replacement: DOC_4_12,
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
