#!/usr/bin/env node
/**
 * Add the grouped-post-scan-telemetry test to scripts/test-unit.js.
 *
 * Written as an apply script rather than a file edit because test-unit.js is
 * past the file-tool window (the same reason, and the same shape, as
 * subreq-host-split-tests.apply.js).
 *
 * WHY THIS CASE
 * The three 5-minute syncs (push-baseline ledger, skip-capture counters, Birdeye
 * CU ledger) each owned a read, and the ledger sync owned four — six Turso round
 * trips when they came due together, which is the common 5-minute shape, on an
 * invocation whose budget is 50 subrequests (docs/round-trips.md §4.6.2). They
 * are one batched read + one batched write now, and the risk in that change is
 * silent: the slimmer projections could drift from listPushWatch /
 * listEnabledChats and the ledger would reconcile against a different set of
 * rows than it used to. So this pins both halves at once — ONE client call, and
 * identical rows/band — with the ORDER BY ... LIMIT copied verbatim.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const anchor =
  '  await test("worker: syncSkipCaptureState accumulates reasons across isolates", async () => {';

const tests = lines(
  '  await test("worker: the grouped post-scan telemetry read is ONE round trip and its rows match its sources", async () => {',
  "    const t = tmpDb();",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      const now = Date.now();",
  "      await db.saveChatSettings({",
  '        chatId: "c", ...DEFAULT_SETTINGS,',
  "        minMarketCapUsd: 40_000, maxMarketCapUsd: 380_000, enabled: true,",
  "      });",
  "      // A DISABLED chat must not widen the band — the same filter",
  "      // listEnabledChats applies.",
  "      await db.saveChatSettings({",
  '        chatId: "off", ...DEFAULT_SETTINGS,',
  "        minMarketCapUsd: 1, maxMarketCapUsd: 9_999_999, enabled: false,",
  "      });",
  "      await db.upsertPushWatch({",
  '        token: "T1", chatId: "c", symbol: "T1",',
  "        pushedAt: now - 60_000, mcapAtPush: 67_056, liquidityUsd: 50_000,",
  "      });",
  "      await db.upsertPushWatch({",
  '        token: "T2", chatId: "c", symbol: "T2",',
  "        pushedAt: now - 120_000, mcapAtPush: 55_000, liquidityUsd: 40_000,",
  "      });",
  '      await db.setWorkerState("push_ledger", \'{"entries":[],"updatedAt":0}\');',
  '      await db.setWorkerState("push_audit", JSON.stringify([',
  '        { chatId: "c", token: "T1", symbol: "T1", messageId: 1, mcapAtPush: 67_056, at: now },',
  "      ]));",
  '      await db.setWorkerState("skip_capture", "not json");',
  '      await db.setWorkerState("birdeye_cu_v1", \'{"v":1,"days":{"2026-09-23":20}}\');',
  "",
  "      // A counting client: the claim is ROUND TRIPS, so count client calls",
  "      // rather than statements.",
  "      let batchCalls = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => { batchCalls += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const led = new Db(t.p, undefined, counting);",
  "      // init() is idempotent DDL, and it runs through the counting client,",
  "      // so reset the counter after it and measure only the read under test.",
  "      await led.init();",
  "      batchCalls = 0;",
  "      const grouped = await led.readPostScanTelemetry(",
  '        "push_ledger", "push_audit", "skip_capture", "birdeye_cu_v1",',
  "      );",
  '      assert.equal(batchCalls, 1, "all four state rows + both listings ride ONE request");',
  "",
  "      // Same rows as the originals (same ORDER BY ... LIMIT for the watch set).",
  "      const rows = await db.listPushWatch(60);",
  "      assert.deepEqual(",
  "        grouped.pushWatch.map((r) => r.token),",
  "        rows.map((r) => r.token),",
  '        "same set and order as listPushWatch",',
  "      );",
  "      assert.deepEqual(",
  "        grouped.chats,",
  "        (await db.listEnabledChats()).map((c) => ({",
  "          minMarketCapUsd: c.minMarketCapUsd,",
  "          maxMarketCapUsd: c.maxMarketCapUsd,",
  "        })),",
  '        "same enabled band as listEnabledChats",',
  "      );",
  '      assert.equal(grouped.states.get("push_ledger"), \'{"entries":[],"updatedAt":0}\');',
  '      assert.equal(grouped.states.get("birdeye_cu_v1"), \'{"v":1,"days":{"2026-09-23":20}}\');',
  '      assert.equal(grouped.states.get("skip_capture"), "not json");',
  "      assert.equal(grouped.states.size, 4);",
  "",
  "      // The write half is one request for N keys too.",
  "      let writes = 0;",
  "      const counting2 = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => { writes += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const wdb = new Db(t.p, undefined, counting2);",
  "      await wdb.init();",
  "      writes = 0;",
  "      await wdb.setWorkerStatesMany([",
  '        { key: "a", value: "1" },',
  '        { key: "b", value: "2" },',
  "      ]);",
  '      assert.equal(writes, 1, "N keys, ONE write request");',
  '      assert.equal(await db.getWorkerState("a"), "1");',
  '      assert.equal(await db.getWorkerState("b"), "2");',
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
  anchor,
);

const marker =
  '  await test("worker: the grouped post-scan telemetry read is ONE round trip and its rows match its sources", async () => {';

let text = fs.readFileSync(T, "utf8");
// Idempotent: drop a previous run's block, so the script can be fixed and
// re-run while it is being brought up. (The repo's other apply scripts are
// one-shot because they needed only one run; this one did not.)
if (text.includes(marker)) {
  const from = text.indexOf(marker);
  const to = text.indexOf(anchor, from);
  if (to < 0) {
    console.error("MISS      test-unit: the end of a previous block");
    process.exit(1);
  }
  text = text.slice(0, from) + text.slice(to);
}
const at = text.indexOf(anchor);
if (at < 0) {
  console.error("MISS      test-unit: the skip-capture sync test (anchor)");
  process.exit(1);
}
if (text.indexOf(anchor, at + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the skip-capture sync test (anchor)");
  process.exit(1);
}
text = text.slice(0, at) + tests + text.slice(at + anchor.length);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the grouped post-scan telemetry test");
