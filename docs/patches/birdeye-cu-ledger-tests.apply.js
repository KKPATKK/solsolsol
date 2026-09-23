#!/usr/bin/env node
/**
 * Unit tests for the Birdeye CU ledger (see birdeye-cu-ledger.apply.js).
 *
 * scripts/test-unit.js is ~466KB, far past the file tools' window, so these
 * ride the same patch discipline as the source edit: every replacement must
 * match EXACTLY once or nothing is written.
 *
 * What is pinned, and why:
 *  - the PRICE TABLE, because §4.4.2's whole conclusion (the card path is the
 *    bot's biggest Birdeye consumer, not the holder probe) is derived from
 *    token_overview = 20 CU, and top_traders must stay 0 until someone
 *    verifies its price — an unpriced endpoint must not invent a number that
 *    then drives a budget decision;
 *  - the billing unit: PER ATTEMPT, accumulated per UTC day;
 *  - the \"only a landed write advances the baseline\" rule (a concurrent charge
 *    stays pending, a failed write re-offers its delta);
 *  - the parser's tolerance (junk day keys / negatives / non-numbers read as
 *    \"no spend\", never as a NaN or a negative month);
 *  - the quota window: `monthCu` is the CALENDAR month, and a day past the
 *    retention window is pruned so the durable row stays small.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";

const lines = (...xs) => xs.join("\n");

const tests = lines(
  "",
  "  // ---------- Birdeye CU ledger (src/birdeye.ts + worker.syncBirdeyeCu) ----------",
  "",
  '  await test("birdeye: the CU price table pins the billed endpoints", async () => {',
  "    // 20 CU per token_overview is what makes the CARD path (40-52 pushes a",
  "    // day = 24-31K CU/month) the bot's biggest Birdeye consumer on its own,",
  "    // so the number is pinned rather than commented.",
  "    assert.equal(BIRDEYE_CU_PRICES.tokenOverview, 20);",
  "    assert.equal(BIRDEYE_CU_PRICES.ohlcv, 35);",
  "    // new_listing is documented as 30-80 CU: the table charges the middle.",
  "    assert.equal(BIRDEYE_CU_PRICES.newListing, 40);",
  "    // top_traders has NO recorded price — an unpriced endpoint must not",
  "    // invent one, so it is charged 0 and cannot silently move a budget.",
  "    assert.equal(BIRDEYE_CU_PRICES.topTraders, 0);",
  "    // The ceiling /health divides the month's spend by is the free tier.",
  "    assert.equal(BIRDEYE_MONTHLY_CU_DEFAULT, 30_000);",
  "  });",
  "",
  '  await test("birdeye: charges accumulate per UTC day and an unpriced call is free", async () => {',
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta()); // clean slate",
  "    const day = birdeyeUtcDay();",
  '    chargeBirdeyeCu("tokenOverview");',
  '    chargeBirdeyeCu("tokenOverview");',
  '    chargeBirdeyeCu("ohlcv");',
  '    chargeBirdeyeCu("topTraders"); // charged 0 — no recorded price',
  "    const pending = peekBirdeyeCuDelta();",
  "    assert.equal(pending.get(day), 20 + 20 + 35, \"two overviews plus one ohlcv\");",
  "    consumeBirdeyeCuDelta(pending);",
  '    assert.equal(peekBirdeyeCuDelta().size, 0, "a consumed delta leaves nothing pending");',
  "  });",
  "",
  '  await test("birdeye: a charge that lands mid-write stays pending", async () => {',
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "    const day = birdeyeUtcDay();",
  '    chargeBirdeyeCu("tokenOverview");',
  "    const snapshot = peekBirdeyeCuDelta();",
  "    // The write is in flight and another request is billed meanwhile.",
  '    chargeBirdeyeCu("tokenOverview");',
  "    consumeBirdeyeCuDelta(snapshot);",
  '    assert.equal(peekBirdeyeCuDelta().get(day), 20, "only the persisted amount is cleared");',
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "  });",
  "",
  '  await test("birdeye: the ledger parser reads good days and drops junk", async () => {',
  "    assert.deepEqual(parseBirdeyeCuLedger(null), {});",
  '    assert.deepEqual(parseBirdeyeCuLedger("not json"), {});',
  '    assert.deepEqual(parseBirdeyeCuLedger(JSON.stringify({ days: ["x"] })), {});',
  "    assert.deepEqual(",
  "      parseBirdeyeCuLedger(",
  "        JSON.stringify({",
  "          days: {",
  '            "2026-09-23": 480,',
  '            "23-09-2026": 9,',
  '            "2026-09-2x": 9,',
  '            "2026-09-24": -1,',
  '            "2026-09-25": "abc",',
  "          },",
  "        }),",
  "      ),",
  '      { "2026-09-23": 480 },',
  '      "only real, non-negative day totals are spend",',
  "    );",
  "  });",
  "",
  '  await test("birdeye: the merge adds deltas and prunes past the retention window", async () => {',
  "    const now = Date.UTC(2026, 8, 23, 12, 0, 0);",
  "    const merged = mergeBirdeyeCuLedger(",
  '      { "2026-09-23": 100, "2026-07-01": 5_000 },',
  '      new Map([["2026-09-23", 20], ["2026-09-22", 40]]),',
  "      now,",
  "    );",
  '    assert.equal(merged["2026-09-23"], 120, "an existing day accumulates");',
  '    assert.equal(merged["2026-09-22"], 40, "a new day is created");',
  '    assert.equal(merged["2026-07-01"], undefined, "a day past the window is pruned");',
  "    assert.ok(",
  "      BIRDEYE_CU_LEDGER_DAYS * 86_400_000 >= 31 * 86_400_000,",
  '      "the retention window must be able to cover a calendar month",',
  "    );",
  "  });",
  "",
  '  await test("birdeye: the stats split today from the calendar month (the quota window)", async () => {',
  '    const days = { "2026-08-31": 900, "2026-09-01": 100, "2026-09-23": 460 };',
  "    assert.deepEqual(",
  "      birdeyeCuStats(days, Date.UTC(2026, 8, 23, 6, 0, 0)),",
  '      { day: "2026-09-23", today: 460, monthCu: 560 },',
  '      "last month\'s row is reported in NEITHER number",',
  "    );",
  "    assert.deepEqual(",
  "      birdeyeCuStats(days, Date.UTC(2026, 8, 24, 0, 30, 0)),",
  '      { day: "2026-09-24", today: 0, monthCu: 560 },',
  '      "a new UTC day starts at zero while the month keeps counting",',
  "    );",
  "  });",
  "",
  '  await test("worker: syncBirdeyeCu persists the spend and re-offers it after a failed write", async () => {',
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "    const t = tmpDb();",
  "    const t0 = Date.UTC(2026, 8, 23, 10, 0, 0);",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  '      chargeBirdeyeCu("tokenOverview", t0);',
  '      chargeBirdeyeCu("tokenOverview", t0);',
  "      await syncBirdeyeCu(t0, db);",
  '      const stored = parseBirdeyeCuLedger(await db.getWorkerState("birdeye_cu_v1"));',
  '      assert.equal(stored["2026-09-23"], 40, "both attempts are billed and persisted");',
  '      assert.equal(peekBirdeyeCuDelta().size, 0, "a landed write clears the delta");',
  "      // A recycled isolate adds ON TOP of the durable total (the read is",
  "      // unconditional) instead of restarting the day at its own zero.",
  '      chargeBirdeyeCu("ohlcv", t0);',
  "      await syncBirdeyeCu(t0 + 1_000, db);",
  '      const second = parseBirdeyeCuLedger(await db.getWorkerState("birdeye_cu_v1"));',
  '      assert.equal(second["2026-09-23"], 75, "35 CU of ohlcv joins the same day");',
  "      // A failed write must RE-OFFER its delta: the spend happened and was",
  "      // billed even though the row did not land.",
  "      const writeFail = {",
  "        execute: (a) => {",
  '          if (String(a.sql).includes("INSERT INTO worker_state")) {',
  '            throw new Error("write down");',
  "          }",
  "          return t.client.execute(a);",
  "        },",
  "        batch: (a, m) => t.client.batch(a, m),",
  "        close: () => t.client.close(),",
  "      };",
  '      const downDb = new Db(t.p, undefined, writeFail);',
  "      await downDb.init();",
  '      chargeBirdeyeCu("tokenOverview", t0);',
  "      await assert.rejects(() => syncBirdeyeCu(t0 + 2_000, downDb), /write down/);",
  "      assert.equal(",
  '        peekBirdeyeCuDelta().get("2026-09-23"),',
  "        20,",
  '        "the delta is still pending after a failed write",',
  "      );",
  "    } finally {",
  "      consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
);

const edits = [
  {
    name: "the birdeye import line",
    old: 'const { parseTokenOverview } = require("../dist/birdeye.js");',
    next:
      "const { parseTokenOverview, BIRDEYE_CU_PRICES, BIRDEYE_CU_LEDGER_DAYS, birdeyeUtcDay, chargeBirdeyeCu, peekBirdeyeCuDelta, consumeBirdeyeCuDelta } = require(\"../dist/birdeye.js\");",
  },
  {
    name: "the worker import line",
    old: 'const { syncPushLedger, syncSkipCaptureState, SCAN_FLUSH_RESERVE_MS, FLUSH_ATTEMPT_BOUND_MS } = require("../dist/worker.js");',
    next:
      "const { syncPushLedger, syncSkipCaptureState, syncBirdeyeCu, parseBirdeyeCuLedger, mergeBirdeyeCuLedger, birdeyeCuStats, BIRDEYE_MONTHLY_CU_DEFAULT, SCAN_FLUSH_RESERVE_MS, FLUSH_ATTEMPT_BOUND_MS } = require(\"../dist/worker.js\");",
  },
  {
    name: "the tests themselves",
    old: lines(
      '  console.log("\\n===== UNIT TESTS =====");',
      "  for (const line of results) console.log(line);",
    ),
    next:
      tests +
      lines(
        '  console.log("\\n===== UNIT TESTS =====");',
        "  for (const line of results) console.log(line);",
      ),
  },
];

let text = fs.readFileSync(T, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      test-unit: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS test-unit: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        test-unit: " + e.name);
}
fs.writeFileSync(T, text);
