#!/usr/bin/env node
/**
 * Birdeye CU：由一個總數變成「邊個花嘅」＋ 取樣下限嘅答案。
 *
 * THE QUESTION (operator, 2026-09-25): 「用 birdeyeCu 嘅真實月用量重新評估
 * holder probe gap 同卡片側 CU 預算，睇可唔可以收窄取樣下限」。
 *
 * 量到嘅事實（live /health + GitHub，2026-09-25）：
 *
 *   birdeyeCu { day 2026-09-25, today 780, monthCu 2740, pendingCu 0 } @ 08:03Z
 *
 *   * 計數器 2026-09-23 12:54Z 才上線，所以 monthCu 2740 係 43.2 小時嘅總和
 *     ⇒ 63 CU/h ≈ 1,522 CU/日 ≈ 46K/月（今日自己 96.7 CU/h ≈ 70K/月；
 *     入面有大約 340 CU 係我自己嘅 /debug 診斷，見下）。
 *   * 三個消費者：holder probe ≤24 次/日（gap 60）× 20 CU = ≤480 CU/日；
 *     periodic backfill 4 次/日 × 1 chunk（interval 同 lookback 都係 360 分鐘）
 *     × 40 CU = 160 CU/日；其餘 ≥60% 係卡片側（`resolveHolderCount` 每次
 *     enrich 一次 `/defi/token_overview`，20 CU）＋ retries。
 *   * 呢個 counter 之前答唔到「邊個」：`monthCu` 係一個總數，而 probe 同卡片
 *     持有人數**用同一個 endpoint**，所以呢一刀做嘅係逐 endpoint 拆分
 *     （calls + CU），連 0 CU 嘅 `topTraders` 都數呼叫 —— 佢個單價
 *     冇記錄，即係 repo 個 CU 總數其實**低估**咗 Birdeye 自己嘅用量。
 *   * 診斷代價係真嘅：一個 `/debug/backfill` call = chunkCount 7 ⇒ ~280 CU
 *     （＋probe 40 CU）＝一日 probe 預算嘅 2/3。呢個 patch 只係讀數，
 *     唔改任何決定（同 §4.5.1 一樣），但佢令嗰啲 call 之後睇得見。
 *
 * 答案（寫入 docs/round-trips.md §4.14）：**唔收窄**。全機已經 46K/月 > 30K
 * tier，而 probe 只佔 ≤21–36%；gap 60→30 只係把每行 holder 年齡由 ~31 小時
 * 減到 ~15 小時，唔改變任何 gate／發卡，但 +14.4K CU/月。要收窄就要先令卡片
 * 側唔再每次 enrich 都買一次 `token_overview`（durable cache，或者 GMGN 免費
 * `holder_count`）。
 *
 * WHAT (all reporting-only):
 *   1. `chargeBirdeyeCu` 記低每個 endpoint 嘅 calls ＋ CU（0 CU 都數呼叫），
 *      並提供 peek／consume（landed 之後才清 delta 嘅紀律一字不改）。
 *   2. 新 durable row `birdeye_cu_by_v1`，同 `birdeye_cu_v1` 同一個 read
 *      （TAIL_STATE_KEYS）同一個 batch 寫入 ⇒ 零額外 round trip。
 *   3. `/health.birdeyeCu` 加 `recentDays`（逐日總數，新到舊，7 日）同
 *      `byEndpoint { today, month }`；兩個 CU row 併入 /health 本來就有嘅
 *      `getWorkerStates` 批次，所以連原本嗰個獨立讀都收埋（−1 subrequest）。
 *
 * 唔變嘅保證：`monthCu` / `today` / `pendingCu` / `monthlyMax` 逐字不變；
 * 單價表、charge 時機（每次 attempt）、throttle、landed-之後才清 delta 全部
 * 唔變；`birdeye_cu_v1` 一個 byte 都唔改（歷史日子冇拆分 = 冇讀數，唔係 0）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

// ── src/worker.ts ──────────────────────────────────────────────────────────
const W = "src/worker.ts";
const W_TYPE_MARKER = "        /** WHICH endpoint spent it, today and month-to-date";
const W_TYPE_ANCHOR = lines(
  "      let birdeyeCu: {",
  "        day: string;",
  "        today: number;",
  "        monthCu: number;",
  "        pendingCu: number;",
  "        monthlyMax: number;",
  "      } | null = null;",
);
const W_TYPE_REPLACEMENT = lines(
  "      let birdeyeCu: {",
  "        day: string;",
  "        today: number;",
  "        monthCu: number;",
  "        pendingCu: number;",
  "        monthlyMax: number;",
  "        /** Day totals, newest first: `monthCu` as a rate (see the helper). */",
  "        recentDays: Array<{ day: string; cu: number }>;",
  "        /** WHICH endpoint spent it, today and month-to-date (§4.14). */",
  "        byEndpoint: { today: BirdeyeCuCounts; month: BirdeyeCuCounts };",
  "      } | null = null;",
);

const W_KEYS_MARKER = "          BIRDEYE_CU_BY_STATE_KEY,\n        ]);";
const W_KEYS_ANCHOR = lines("          \"write_drain_error\",", "        ]);");
const W_KEYS_REPLACEMENT = lines(
  "          \"write_drain_error\",",
  "          // Both CU ledgers ride this batch too: /health used to read the",
  "          // total on its own round trip, and the per-endpoint split would",
  "          // have been a third. Same request, so the breakdown is free.",
  "          BIRDEYE_CU_STATE_KEY,",
  "          BIRDEYE_CU_BY_STATE_KEY,",
  "        ]);",
);

const W_READ_ANCHOR = lines(
  "        const rawCu = await db?.getWorkerState(BIRDEYE_CU_STATE_KEY);",
  "        birdeyeCu = {",
  "          ...birdeyeCuStats(parseBirdeyeCuLedger(rawCu ?? null)),",
  "          // This isolate's unpersisted spend is real spend too: the durable",
  "          // row only moves when the throttled sync lands, so the stored",
  "          // total alone under-reads for up to one sync gap.",
  "          pendingCu: birdeyeCuPendingTotal(),",
  "          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,",
  "        };",
);
const W_READ_REPLACEMENT = lines(
  "        const cuDays = parseBirdeyeCuLedger(",
  "          tickState?.get(BIRDEYE_CU_STATE_KEY) ?? null,",
  "        );",
  "        birdeyeCu = {",
  "          ...birdeyeCuStats(cuDays),",
  "          // This isolate's unpersisted spend is real spend too: the durable",
  "          // row only moves when the throttled sync lands, so the stored",
  "          // total alone under-reads for up to one sync gap.",
  "          pendingCu: birdeyeCuPendingTotal(),",
  "          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,",
  "          // The month total alone cannot say whether 46K CU of spend is the",
  "          // holder probe, the card path or a debug endpoint — and the probe",
  "          // and the card share `/defi/token_overview`, so only the CALL",
  "          // count (calibratable against Birdeye's own dashboard) plus the",
  "          // pass note's `probe<N>` can separate them.",
  "          recentDays: birdeyeCuRecentDays(cuDays),",
  "          byEndpoint: birdeyeCuByStats(",
  "            parseBirdeyeCuByLedger(tickState?.get(BIRDEYE_CU_BY_STATE_KEY) ?? null),",
  "          ),",
  "        };",
);

// ── scripts/test-unit.js ───────────────────────────────────────────────────
const T = "scripts/test-unit.js";
const T_W_ANCHOR =
  'const { syncPushLedger, syncSkipCaptureState, syncBirdeyeCu, parseBirdeyeCuLedger, mergeBirdeyeCuLedger, birdeyeCuStats, BIRDEYE_MONTHLY_CU_DEFAULT, SCAN_FLUSH_RESERVE_MS, FLUSH_ATTEMPT_BOUND_MS } = require("../dist/worker.js");';
const T_W_REPLACEMENT =
  'const { syncPushLedger, syncSkipCaptureState, syncBirdeyeCu, parseBirdeyeCuLedger, mergeBirdeyeCuLedger, birdeyeCuStats, parseBirdeyeCuByLedger, mergeBirdeyeCuByLedger, birdeyeCuByStats, birdeyeCuRecentDays, BIRDEYE_MONTHLY_CU_DEFAULT, SCAN_FLUSH_RESERVE_MS, FLUSH_ATTEMPT_BOUND_MS } = require("../dist/worker.js");';
const T_B_ANCHOR =
  'const { parseTokenOverview, BIRDEYE_CU_PRICES, BIRDEYE_CU_LEDGER_DAYS, birdeyeUtcDay, chargeBirdeyeCu, peekBirdeyeCuDelta, consumeBirdeyeCuDelta } = require("../dist/birdeye.js");';
const T_B_REPLACEMENT =
  'const { parseTokenOverview, BIRDEYE_CU_PRICES, BIRDEYE_CU_LEDGER_DAYS, birdeyeUtcDay, chargeBirdeyeCu, peekBirdeyeCuDelta, consumeBirdeyeCuDelta, peekBirdeyeCuByDay, consumeBirdeyeCuByDay } = require("../dist/birdeye.js");';

const T_INSERT_ANCHOR = "  // ---------- Subrequest counter (src/subreqs.ts) ----------";
const T_CLEAN_ANCHOR = lines(
  "  await test(\"worker: syncBirdeyeCu persists the spend and re-offers it after a failed write\", async () => {",
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
);
const T_CLEAN_REPLACEMENT = lines(
  "  await test(\"worker: syncBirdeyeCu persists the spend and re-offers it after a failed write\", async () => {",
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "    consumeBirdeyeCuByDay(peekBirdeyeCuByDay());",
);
const T_STUB_ANCHOR = lines(
  "        batch: (a, m) => t.client.batch(a, m),",
  "        close: () => t.client.close(),",
  "      };",
);
const T_STUB_REPLACEMENT = lines(
  "        // The write half now goes through setWorkerStatesMany (one batch for",
  "        // both CU rows), so \"the write is down\" has to fail the BATCH too —",
  "        // otherwise this stub would let a rejected write land.",
  "        batch: (a, m) => {",
  "          if (",
  "            m === \"write\" &&",
  "            a.some((s) => String(s.sql).includes(\"INSERT INTO worker_state\")),",
  "          ) {",
  "            throw new Error(\"write down\");",
  "          }",
  "          return t.client.batch(a, m);",
  "        },",
  "        close: () => t.client.close(),",
  "      };",
);
const T_FAIL_ASSERT_ANCHOR = lines(
  "      assert.equal(",
  "        peekBirdeyeCuDelta().get(\"2026-09-23\"),",
  "        20,",
  "        \"the delta is still pending after a failed write\",",
  "      );",
);
const T_FAIL_ASSERT_REPLACEMENT = lines(
  "      assert.equal(",
  "        peekBirdeyeCuDelta().get(\"2026-09-23\"),",
  "        20,",
  "        \"the delta is still pending after a failed write\",",
  "      );",
  "      assert.equal(",
  "        peekBirdeyeCuByDay().get(\"2026-09-23\").tokenOverview.calls,",
  "        1,",
  "        \"the split delta is re-offered with the total's\",",
  "      );",
);
const T_FINALLY_ANCHOR = lines(
  "    } finally {",
  "      consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "      await t.cleanup();",
  "    }",
);
const T_FINALLY_REPLACEMENT = lines(
  "    } finally {",
  "      consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "      consumeBirdeyeCuByDay(peekBirdeyeCuByDay());",
  "      await t.cleanup();",
  "    }",
);
const T_FIRST_SYNC_ANCHOR = lines(
  "      const stored = parseBirdeyeCuLedger(await db.getWorkerState(\"birdeye_cu_v1\"));",
  "      assert.equal(stored[\"2026-09-23\"], 40, \"both attempts are billed and persisted\");",
);
const T_FIRST_SYNC_REPLACEMENT = lines(
  "      const stored = parseBirdeyeCuLedger(await db.getWorkerState(\"birdeye_cu_v1\"));",
  "      assert.equal(stored[\"2026-09-23\"], 40, \"both attempts are billed and persisted\");",
  "      // The split row lands in the same batch, so the totals and the",
  "      // breakdown can never disagree about what was spent.",
  "      const byStored = parseBirdeyeCuByLedger(",
  "        await db.getWorkerState(\"birdeye_cu_by_v1\"),",
  "      );",
  "      assert.deepEqual(",
  "        byStored[\"2026-09-23\"],",
  "        { tokenOverview: { calls: 2, cu: 40 } },",
  "        \"two calls, priced, under the endpoint that was called\",",
  "      );",
);

const T_NEW_TESTS = lines(
  "  await test(\"birdeye: the split ledger counts calls per endpoint, priced or not\", async () => {",
  "    consumeBirdeyeCuDelta(peekBirdeyeCuDelta());",
  "    consumeBirdeyeCuByDay(peekBirdeyeCuByDay()); // clean slate on BOTH halves",
  "    const day = birdeyeUtcDay();",
  "    chargeBirdeyeCu(\"tokenOverview\");",
  "    chargeBirdeyeCu(\"tokenOverview\");",
  "    chargeBirdeyeCu(\"newListing\");",
  "    chargeBirdeyeCu(\"topTraders\");",
  "    const by = peekBirdeyeCuByDay().get(day);",
  "    assert.deepEqual(by.tokenOverview, { calls: 2, cu: 40 });",
  "    assert.deepEqual(by.newListing, { calls: 1, cu: 40 });",
  "    // The unpriced endpoint keeps the 0-CU rule it always had, but its CALL",
  "    // is recorded: it is billed by the vendor at a price this repo never",
  "    // recorded, i.e. the one hole in `monthCu` that a call count can show.",
  "    assert.deepEqual(by.topTraders, { calls: 1, cu: 0 });",
  "    assert.equal(by.ohlcv, undefined, \"an endpoint never called has no cell\");",
  "    // The mid-write rule, cell by cell: what the landed write persisted is",
  "    // cleared, and a charge that arrived meanwhile stays pending.",
  "    const snapshot = peekBirdeyeCuByDay();",
  "    chargeBirdeyeCu(\"tokenOverview\");",
  "    consumeBirdeyeCuByDay(snapshot);",
  "    assert.deepEqual(",
  "      peekBirdeyeCuByDay().get(day).tokenOverview,",
  "      { calls: 1, cu: 20 },",
  "      \"only the persisted cell is cleared\",",
  "    );",
  "    consumeBirdeyeCuByDay(peekBirdeyeCuByDay());",
  "    assert.equal(peekBirdeyeCuByDay().size, 0, \"a consumed snapshot leaves nothing\");",
  "  });",
  "",
  "  await test(\"birdeye: the split parser, merge and stats follow the totals' window\", async () => {",
  "    assert.deepEqual(parseBirdeyeCuByLedger(null), {});",
  "    assert.deepEqual(parseBirdeyeCuByLedger(\"not json\"), {});",
  "    assert.deepEqual(parseBirdeyeCuByLedger(JSON.stringify({ days: [\"x\"] })), {});",
  "    assert.deepEqual(",
  "      parseBirdeyeCuByLedger(",
  "        JSON.stringify({",
  "          days: {",
  "            \"2026-09-24\": {",
  "              tokenOverview: { calls: 3, cu: 60 },",
  "              nonsense: { calls: 9, cu: 9 },",
  "              newListing: { calls: 1, cu: \"abc\" },",
  "            },",
  "            \"2026-09-2x\": { tokenOverview: { calls: 1, cu: 20 } },",
  "            \"2026-09-25\": { tokenOverview: { calls: -1, cu: 20 } },",
  "            \"2026-09-26\": {},",
  "          },",
  "        }),",
  "      ),",
  "      { \"2026-09-24\": { tokenOverview: { calls: 3, cu: 60 } } },",
  "      \"an unknown endpoint, a junk day, a bad number and an empty day are dropped\",",
  "    );",
  "    const now = Date.UTC(2026, 8, 25, 12, 0, 0);",
  "    const merged = mergeBirdeyeCuByLedger(",
  "      {",
  "        \"2026-09-24\": { tokenOverview: { calls: 2, cu: 40 } },",
  "        \"2026-07-01\": { ohlcv: { calls: 1, cu: 35 } },",
  "      },",
  "      new Map([",
  "        [",
  "          \"2026-09-24\",",
  "          {",
  "            tokenOverview: { calls: 1, cu: 20 },",
  "            newListing: { calls: 1, cu: 40 },",
  "          },",
  "        ],",
  "      ]),",
  "      now,",
  "    );",
  "    assert.deepEqual(",
  "      merged[\"2026-09-24\"].tokenOverview,",
  "      { calls: 3, cu: 60 },",
  "      \"cells accumulate\",",
  "    );",
  "    assert.deepEqual(",
  "      merged[\"2026-09-24\"].newListing,",
  "      { calls: 1, cu: 40 },",
  "      \"a new endpoint appears on a day that already had cells\",",
  "    );",
  "    assert.equal(merged[\"2026-07-01\"], undefined, \"the SAME retention window as the totals\");",
  "    const stats = birdeyeCuByStats(",
  "      {",
  "        \"2026-08-31\": { ohlcv: { calls: 1, cu: 35 } },",
  "        \"2026-09-24\": { tokenOverview: { calls: 3, cu: 60 } },",
  "        \"2026-09-25\": { newListing: { calls: 1, cu: 40 } },",
  "      },",
  "      now,",
  "    );",
  "    assert.deepEqual(stats.today, { newListing: { calls: 1, cu: 40 } });",
  "    assert.deepEqual(",
  "      stats.month,",
  "      {",
  "        tokenOverview: { calls: 3, cu: 60 },",
  "        newListing: { calls: 1, cu: 40 },",
  "      },",
  "      \"last month's row is in NEITHER reading\",",
  "    );",
  "    // The per-day readout: what turns `monthCu` (one number, window unknown)",
  "    // into the rate the gap decision is made on.",
  "    assert.deepEqual(",
  "      birdeyeCuRecentDays({ \"2026-09-23\": 2740, \"2026-09-25\": 780, \"2026-09-24\": 1960 }, 2),",
  "      [",
  "        { day: \"2026-09-25\", cu: 780 },",
  "        { day: \"2026-09-24\", cu: 1960 },",
  "      ],",
  "      \"newest first, and the limit is a limit\",",
  "    );",
  "  });",
  "",
);

// ── docs/round-trips.md ────────────────────────────────────────────────────
const D = "docs/round-trips.md";
const D_HEADING = "## 4.14 Birdeye CU：由一個總數到「邊個花嘅」，同取樣下限嘅答案（2026-09-25）";
const D_SECTION = lines(
  "",
  "---",
  "",
  D_HEADING,
  "",
  "Operator 問：用 `birdeyeCu` 嘅真實月用量重新評估 holder probe gap 同卡片側 CU 預算，",
  "睇可唔可以收窄取樣下限？——**答案係唔收窄**，但答得成之前先要修好個讀數，因為 §4.5.1",
  "嗰個 counter 只答得到「幾多」，答唔到「邊個」。",
  "",
  "### 1. 量到嘅數（live，2026-09-25 08:03Z）",
  "",
  "```",
  "birdeyeCu { day \"2026-09-25\", today 780, monthCu 2740, pendingCu 0, monthlyMax 30000 }",
  "```",
  "",
  "* 計數器**2026-09-23 12:54Z 才上線**（§4.5.1 嘅 deploy），所以 `monthCu` 2740 係",
  "  **43.2 小時**嘅總和，唔係一個月 ⇒ 63 CU/h ≈ **1,522 CU/日 ≈ 46K CU/月**。",
  "  而今日自己係 96.7 CU/h（≈70K/月），不過入面有大約 **340 CU 係我自己嘅診斷**：",
  "  一個 `/debug/backfill` 就係 `chunkCount 7` × 40 CU ≈ 280 CU（＋new_listing probe 40）",
  "  —— 即係**一次診斷等於一日 probe 預算嘅 2/3**。",
  "* 三個消費者同佢哋嘅**上限**（config 推出嚟，唔係估）：",
  "",
  "  | 消費者 | 單價 | 次數/日 | CU/日 | 佔比 |",
  "  | --- | --- | --- | --- | --- |",
  "  | holder probe（`PUSH_WATCH_HOLDER_MIN_GAP_MIN = 60`） | 20 CU | ≤24 | **≤480** | ≤21–36% |",
  "  | periodic backfill（`BIRDEYE_BACKFILL_INTERVAL_MIN = 360`，lookback 360 ⇒ 1 chunk） | 40 CU | 4 | **160** | ~11% |",
  "  | 卡片側 `resolveHolderCount`（每次 enrich 一次 `token_overview`） | 20 CU | 每次 unseen candidate 入 enrich | **其餘 ≥60%** | — |",
  "  | 卡片側 `resolveTraderData`（`top_traders`，**冇記錄單價** ⇒ charge 0） | 0 CU | 同上（同一次 enrich） | 唔入賬 | 未知 |",
  "",
  "  `getFirstMinuteVolume` / `getMinMarketCapUsd`（ohlcv 35 CU）喺 repo 內**冇任何 call site**",
  "  ⇒ §4.4.2 表入面「首分鐘量、最低市值」嗰兩項已經係死 code，唔再係消費者。",
  "* 一個重要嘅誠實邊界：上表加起來 46K/月 > 30K free tier，但 Birdeye **冇**頂 —— 實測",
  "  `/debug/birdeye-overview?address=…` 597ms 正常回 `holderCount 622`，冇 429。所以一係",
  "  account 已經係 paid，一係 `token_overview = 20 CU` 高估咗 ≥33%，一係 `top_traders` 嘅",
  "  未記錄單價令實況更差。**任何以 CU 為單位嘅決定都要先答呢條**，而答佢需要 calls 對數。",
  "",
  "### 2. 做咗嘅：`byEndpoint` ＋ `recentDays`（純讀數，唔改任何決定）",
  "",
  "* `chargeBirdeyeCu` 除咗總數，再記每個 endpoint 嘅 `{ calls, cu }`（**0 CU 都數呼叫**：",
  "  `top_traders` 係 vendor 真收費、repo 冇單價嘅嗰隻，佢嘅呼叫數就係 `monthCu` 嘅窿）。",
  "  同一個 isolate scope、同一條 drain 紀律：read 無條件、**landed 之後才清 delta**、",
  "  寫入途中到達嘅 charge 留在 pending（逐格驗）。",
  "* 新 durable row `birdeye_cu_by_v1`，行 shape `{ v: 1, days: { \"YYYY-MM-DD\": { endpoint: { calls, cu } } } }`。",
  "  **`birdeye_cu_v1` 一個 byte 都唔改** —— 歷史日子冇拆分就係「冇讀數」，唔會扮 0。",
  "  兩條 row 喺 tail 嘅**同一個 read**（`TAIL_STATE_KEYS`）同**同一個 batch**寫入",
  "  ⇒ 零額外 round trip，總數同拆分唔可能對唔上。",
  "* `/health.birdeyeCu` 加 `recentDays`（逐日總數，新到舊，7 日）同 `byEndpoint { today, month }`；",
  "  兩條 CU row 併入 /health 本來就有嘅 `getWorkerStates` 批次，順手收埋原本嗰個獨立讀（−1 subrequest）。",
  "",
  "### 3. 答案：唔收窄（而且唔係「暫時」）",
  "",
  "1. **全機已經超支**：46K CU/月 vs 30K tier。",
  "2. **probe 唔係大頭**：≤480 CU/日（≤21–36%），而其餘 ≥60% 係卡片側。",
  "3. **收窄買到嘅嘢比想像中少**：gap 60 → 30 令 probe 由 480 → 960 CU/日（**+14.4K/月**），",
  "   而因為「一個 pass 一個 probe」（§4.3），每行嘅持有人數刷新由 **~31 小時** 縮到 **~15 小時**",
  "   —— 唔改變任何 gate、發卡條件或者卡片語意，純粹係卡面個持有人數幾新。",
  "4. **要收窄，先要卡片側唔再重複買**：一張卡嘅 `token_overview`（20 CU）而家係**每次 enrich**",
  "   都買一次，而 enrich 唔止發卡嗰次（defer／重評都會再入 enrich）。省到嗰邊，gap 60 → 30",
  "   甚至 20 就有預算（30 分鐘 = 28.8K/月，20 分鐘 = 43.2K/月 —— 仍然要同卡片側分）。",
  "   §4.4.2 已經記低兩個唔使錢嘅方向（durable holder cache、GMGN 免費 `holder_count`），",
  "   兩者都會改卡面數字嘅新鮮度／來源，所以係一個要明講嘅決定，唔應該夾埋喺讀數刀做。",
  "",
  "### 4. 落線點驗（下一個鐘）",
  "",
  "1. `curl /health | jq .birdeyeCu.recentDays` 有 ≥2 日、新到舊。",
  "2. `curl /health | jq .birdeyeCu.byEndpoint.month` 有 `tokenOverview` / `newListing`",
  "   （`ohlcv` 應該**完全唔出現**，因為冇 call site），而 `topTraders.calls` > 0 即係確認",
  "   「repo 個 CU 總數低估咗 vendor 嘅收費」。",
  "3. `byEndpoint.month.tokenOverview.calls` = 卡片 enrich 次數 ＋ probe 次數；probe 嘅次數由",
  "   pass note 嘅 `probe<N>`（§4.4.1）數得到，所以**卡片側 = calls − probes** ——",
  "   呢個就係下一步「卡片側值唔值得買」嘅數。",
  "4. 同 Birdeye dashboard 嘅當日用量對數：如果 vendor 讀數係 repo 讀數嘅 1/20，咁 20 CU/次",
  "   就係高估，全盤預算決定（包括 gap）都要重算。",
  "",
  "**測試**（`scripts/test-unit.js`）：`birdeye: the split ledger counts calls per endpoint, priced or not`",
  "（calls/CU 分開、0 CU 都數、空 endpoint 冇格、mid-write 逐格）＋ `birdeye: the split parser, merge and stats",
  "follow the totals' window`（unknown endpoint／junk day／bad number／空日全 drop、合併、剪枝同 totals 同一個窗、",
  "today vs month、`recentDays` 排序）＋ 舊 `worker: syncBirdeyeCu …` 測試擴充（同一個 batch 寫兩條 row、",
  "rejected batch 兩邊 delta 一齊 re-offer；write-down stub 改成連 batch 都失敗）。",
);

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
const once = (text, needle) => text.split(needle).length - 1;

function patch(file, marker, anchor, replacement, what) {
  const text = bufferOf(file);
  if (typeof marker === "string" && text.includes(marker)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  const at = text.indexOf(anchor);
  if (at < 0) {
    console.error(`MISS      ${file}: ${what}`);
    failed = true;
    return;
  }
  if (once(text, anchor) !== 1) {
    console.error(`AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  buffers.set(file, text.replace(anchor, replacement));
  console.log(`ok        ${file}: ${what}`);
}

patch(W, W_TYPE_MARKER, W_TYPE_ANCHOR, W_TYPE_REPLACEMENT, "the readout carries the split and the days");
patch(W, W_KEYS_MARKER, W_KEYS_ANCHOR, W_KEYS_REPLACEMENT, "both CU rows ride the health read");
patch(W, "birdeyeCuByStats(", W_READ_ANCHOR, W_READ_REPLACEMENT, "/health reads them from that batch");
patch(T, "parseBirdeyeCuByLedger, mergeBirdeyeCuByLedger", T_W_ANCHOR, T_W_REPLACEMENT, "the worker exports are imported");
patch(T, "peekBirdeyeCuByDay, consumeBirdeyeCuByDay", T_B_ANCHOR, T_B_REPLACEMENT, "the birdeye exports are imported");
patch(T, T_CLEAN_REPLACEMENT, T_CLEAN_ANCHOR, T_CLEAN_REPLACEMENT, "the sync test starts from a clean split");
patch(T, "INSERT INTO worker_state\")) {", T_STUB_ANCHOR, T_STUB_REPLACEMENT, "the write-down stub fails the batch too");
patch(T, "the split delta is re-offered with the total's", T_FIRST_SYNC_ANCHOR, T_FIRST_SYNC_REPLACEMENT, "both rows are asserted after a landed write");
patch(T, "peekBirdeyeCuByDay().get(\"2026-09-23\").tokenOverview.calls", T_FAIL_ASSERT_ANCHOR, T_FAIL_ASSERT_REPLACEMENT, "and after a rejected one");
patch(T, "consumeBirdeyeCuByDay(peekBirdeyeCuByDay());\n      await t.cleanup();", T_FINALLY_ANCHOR, T_FINALLY_REPLACEMENT, "the test cleans both halves");
patch(T, "the split ledger counts calls per endpoint", T_INSERT_ANCHOR, T_NEW_TESTS + T_INSERT_ANCHOR, "the split tests are added");

{
  const text = bufferOf(D);
  if (text.includes(D_HEADING)) {
    console.log(`already   ${D}: the evaluation is documented`);
  } else {
    buffers.set(D, `${text.trimEnd()}\n${D_SECTION}\n`);
    console.log(`ok        ${D}: the evaluation is documented`);
  }
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
