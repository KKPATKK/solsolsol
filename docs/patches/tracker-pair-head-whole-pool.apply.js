#!/usr/bin/env node
/**
 * Make ONE tracker pass cover the whole rotation: TRACKER_PAIR_HEAD 10 → 30.
 *
 * Why (measured, live 2026-09-24):
 *   - The pool is 30 active rows (cfg.maxTracked, hard-capped at 30 in
 *     config.ts) out of a 46-row table (15-16 terminal: rug / unwatched, which
 *     are skipped on purpose). Active rows' `last_checked` came in THREE waves
 *     of ten — 03:46:28Z `{0s: 10, 120s: 10, 360s: 10, 420s: 1}` (oldest
 *     7.3min), 03:31:13Z `{120s: 10, 210s: 10, 480s: 9}` (oldest 8.3min) —
 *     i.e. one pass per ~2 minutes, three passes per cycle, 10 rows each.
 *   - But the pass never spent its allowance (03:29:07Z):
 *     `ok:10/0 rows 10/29 pairs 10/10 miss 0 lost 0 allow 4873
 *      spend[setup 346/3 heal 214/1 pairs 335/0 rows 136/1 ... ] trips 7
 *      db 1056ms`, trackerMs 1376 — ten silent rows land in ONE store round
 *     trip (136ms) since the batched claims (docs/round-trips.md §4.2), so the
 *     pass ended with ~3.4s of its 4.9s unused and NO budget-cut. The binding
 *     limit was the head constant itself, not the time and not Turso.
 *   - Cost of the wider batch: ONE DexScreener request either way, because the
 *     client already batches by 30 (`/latest/dex/tokens/<addresses>` takes 30
 *     per request — DexScreenerClient.fetchPairsForTokens). Only the payload
 *     grows, hence TRACKER_PAIRS_BUDGET_MS 600 → 1_200 (measured: 10 addresses
 *     = 335ms) and the watchdog's enumerated chain 8_000 → 8_600ms.
 *   - Not every tick yields a pass at all: 03:30:08Z, one minute after a
 *     healthy ten-row pass, read `ok:0/0 pairs-empty … trips 4 db 550ms` (the
 *     DexScreener batch answered nothing, dex429 window). Rows are untouched
 *     (no judgment, no deletion) but that tick covered ZERO rows — with a
 *     10-row head that costs a third of a cycle, with a 30-row head one tick.
 *
 * The two constants, the tick-budget comment and TRACKER_PASS_OVERRUN_MS sit
 * ABOVE the ~line-1000 / ~50KB window where str_replace stops matching in these
 * files (docs/round-trips.md §6) and are already applied by the file tools.
 * This script carries the part below that window: the scanner's pre-fetch
 * comment (so the widened head's cost is written down where it is paid), the
 * two tests whose premise was "the head is a strict subset of the pool", and
 * the doc section.
 *
 * Same discipline as every other script in here: exactly one match per
 * replacement or nothing is written at all.
 */
const fs = require("fs");

const SCANNER = "src/scanner.ts";
const TESTS = "scripts/test-unit.js";
const DOC = "docs/round-trips.md";

/** @type {Array<{file: string, label: string, old: string, next: string}>} */
const edits = [
  {
    file: SCANNER,
    label: "sc: the pre-fetch now carries the whole pool, appended last",
    old:
      "      // TRACKER_PAIR_HEAD extra addresses, so the extra cost is at most one\n" +
      "      // more batch in a phase that already dispatches several.",
    next:
      "      // TRACKER_PAIR_HEAD extra addresses — the tracker pool's ceiling, i.e.\n" +
      "      // the whole rotation — so the extra cost is at most one more batch in a\n" +
      "      // phase that already dispatches several. They are appended LAST, so a\n" +
      "      // batch the phase's deadline skips is the tracker's pre-fetch, never one\n" +
      "      // of the scan's own coins (whose pairs the gates need THIS tick).",
  },
  {
    file: TESTS,
    label: "test: the uncovered-row guard, on a pool bigger than the cap",
    old:
      "    // 24 tracked coins, one DexScreener request. Asking for all of them spent\n" +
      "    // the pass's only mandatory call on addresses the loop never evaluates —\n" +
      "    // and a slow batch then made every row a pair miss, so the pass did\n" +
      "    // nothing at all (`pairs 0/30 miss 30`, live 2026-09-18). The head the\n" +
      "    // batch covers is deliberately NOT hard-coded here: the point is that it\n" +
      "    // is a strict subset of the watch list (and that only covered rows can be\n" +
      "    // blamed), not the size of the head on any given day.\n" +
      "    const rows = [];\n" +
      "    for (let i = 0; i < 24; i++) rows.push(watchRow(`T${i}`));",
    next:
      "    // The head the batch covers IS the pool's ceiling now (TRACKER_PAIR_HEAD\n" +
      "    // = 30 = cfg.maxTracked — see pushwatch), so a watch list BIGGER than the\n" +
      "    // cap is the only shape left in which the batch is a strict subset — and\n" +
      "    // that is exactly the shape the second half of this test's name is about:\n" +
      "    // only the rows the batch COVERED may be blamed (a coin must never be\n" +
      "    // judged delisted, and so deleted, off a request it was never part of —\n" +
      "    // live 2026-09-18 `pairs 0/30 miss 30`). The size is read from the\n" +
      "    // constant rather than hard-coded, so widening the head cannot silently\n" +
      "    // retire this guard.\n" +
      "    const rows = [];\n" +
      "    for (let i = 0; i < 40; i++) rows.push(watchRow(`T${i}`));",
  },
  {
    file: TESTS,
    label: "test: the head is the constant, not a number of the day",
    old:
      "    assert.ok(\n" +
      "      asked[0] > 0 && asked[0] < rows.length,\n" +
      "      `batch asked for ${asked[0]} of ${rows.length} addresses, expected the queue head`,\n" +
      "    );",
    next:
      "    assert.equal(\n" +
      "      asked[0],\n" +
      "      TRACKER_PAIR_HEAD,\n" +
      "      `batch asked for ${asked[0]} of ${rows.length} addresses, expected the head`,\n" +
      "    );",
  },
  {
    file: TESTS,
    label: "test: the 40-row fixture's note",
    old: "    assert.match(String(out.note), /rows 1\\/24/);",
    next: "    assert.match(String(out.note), /rows 1\\/40/);",
  },
  {
    file: TESTS,
    label: "test: one pass asks for the whole rotation",
    // Anchored on the assertion's message and the test's closing brace — the
    // line above it builds a RegExp from a template literal, and its escaping
    // is not worth reproducing here.
    old:
      "      `rows outside the batch must not be reported as misses: ${out.note}`,\n" +
      "    );\n" +
      "  });",
    next:
      "      `rows outside the batch must not be reported as misses: ${out.note}`,\n" +
      "    );\n" +
      "  });\n" +
      "\n" +
      "  await test(\"PushWatcher: the pair batch asks for the WHOLE rotation when the pool fits the cap\", async () => {\n" +
      "    // The point of the whole-pool head (2026-09-24). The rotation queue IS\n" +
      "    // the watch listing (LIMIT cfg.maxTracked = 30, hard-capped in\n" +
      "    // config.ts), so one pass can now evaluate every active row: before\n" +
      "    // this, a pass stopped at ten and a full cycle took three passes — live\n" +
      "    // 03:46:28Z age waves of ten rows at 0s / 120s / 360s — while the pass\n" +
      "    // had ~3.4s of its 4.9s allowance unspent (03:29:07Z: `rows 10/29`,\n" +
      "    // `spend[... rows 136/1 ...]`, trackerMs 1376, no budget-cut).\n" +
      "    const rows = [];\n" +
      "    for (let i = 0; i < 29; i++) rows.push(watchRow(`T${i}`));\n" +
      "    const updated = [];\n" +
      "    const asked = [];\n" +
      "    const pairsFor = async (addrs) => {\n" +
      "      asked.push(addrs.length);\n" +
      "      return new Map([[\"T0\", watchPair(\"T0\")]]);\n" +
      "    };\n" +
      "    const pw = new PushWatcher(\n" +
      "      watchDb(rows, updated), watchBot, null, loadConfig({}), pairsFor, null,\n" +
      "    );\n" +
      "    const out = await pw.runTick();\n" +
      "    assert.equal(asked.length, 1, \"still ONE DexScreener request\");\n" +
      "    assert.equal(asked[0], rows.length, `asked for ${asked[0]} of ${rows.length}`);\n" +
      "    assert.match(String(out.note), /rows 1\\/29/);\n" +
      "    assert.match(String(out.note), /pairs 1\\/29/);\n" +
      "    assert.match(String(out.note), /miss 28\\b/);\n" +
      "  });",
  },
  {
    file: TESTS,
    label: "test: the published head IS the rotation when the pool fits the cap",
    old:
      "    assert.ok(\n" +
      "      head.length > 0 && head.length < rows.length,\n" +
      "      `head size ${head.length} of ${rows.length}`,\n" +
      "    );",
    next:
      "    assert.equal(\n" +
      "      head.length,\n" +
      "      rows.length,\n" +
      "      `the head published for the scanner IS the whole rotation when the pool fits the cap: ${head.length} of ${rows.length}`,\n" +
      "    );",
  },
  {
    file: DOC,
    label: "doc: §4.8, the whole-pool head",
    old: "## 5. 驗證狀態（本地 + 上線）",
    next:
      "## 4.8 追蹤池 head：10 → 30，一個 pass 掃完全池（2026-09-24，未上線）\n" +
      "\n" +
      "**問題唔喺「掃唔掃到」，而喺「幾時掃到」。** `/debug/push-watch?limit=500`（03:46:28Z）\n" +
      "顯示表 46 行 ＝ **31 active ＋ 15 terminal**（`rug` / `unwatched`，故意唔掃）。但 active 行嘅\n" +
      "`last_checked` 年齡一直係**三堆、每堆十行**：\n" +
      "\n" +
      "| 抽樣（Z） | 年齡波浪（30s 桶 → 行數） | 最舊 |\n" +
      "|---|---|---|\n" +
      "| 03:29Z | `2min:10 / 4min:10 / 5min:10` | 5.2min |\n" +
      "| 03:31:13Z | `120s:10 / 210s:10 / 480s:9` | 8.3min |\n" +
      "| 03:46:28Z | `0:10 / 120s:10 / 360s:10 / 420s:1` | 7.3min |\n" +
      "\n" +
      "即一個 pass 只掃 10 行、全池一輪 3 個 pass、最舊嗰批 5–8 分鐘。**但個 pass 根本冇用盡\n" +
      "allowance**（03:29:07Z）：\n" +
      "\n" +
      "```\n" +
      "ok:10/0 rows 10/29 pairs 10/10 miss 0 lost 0 allow 4873\n" +
      "spend[setup 346/3 heal 214/1 miss0 enrolled0 pairs 335/0 rows 136/1 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 7 db 1056ms\n" +
      "trackerMs 1376\n" +
      "```\n" +
      "\n" +
      "10 行 silent claim 而家係**一個 trip / 136ms**（§4.2 嘅 batching 成果），成個 pass 只用\n" +
      "1.4s／4.9s，冇 `budget-cut`。所以停喺 10 行純粹係 `TRACKER_PAIR_HEAD` **呢個 head 上限**，\n" +
      "唔係時間、唔係 Turso。\n" +
      "\n" +
      "**改動**：\n" +
      "\n" +
      "| 位 | 前 | 後 | 理由 |\n" +
      "|---|---|---|---|\n" +
      "| `pushwatch.TRACKER_PAIR_HEAD` | 10 | **30** | ＝ `cfg.maxTracked`（config.ts 硬 cap 30），而 listing 係 active 行按 `last_checked` 最舊先排 → head 就係輪替隊列本身 |\n" +
      "| `pushwatch.TRACKER_PAIRS_BUDGET_MS` | 600 | **1_200** | 批次由 10 個 address 變 30 個，**仍然係一個 request**（`/latest/dex/tokens` 一請求食 30 個 address，見 `DexScreenerClient.fetchPairsForTokens` 嘅 30 分批）；10 個實測 335ms，30 個要 ~3 倍 payload 嘅餘裕 |\n" +
      "| `scanner.TRACKER_PASS_OVERRUN_MS` | 8_000 | **8_600** | watchdog 嘅前提係「枚舉得完嘅 bounded 鏈」：pair batch 600 → 1_200，鏈尾跟住加 600 |\n" +
      "\n" +
      "**唔變嘅保證**：`pairMiss` 只喺 loop 內部加（`pairMiss += 1`）—— 批次冇 cover 到嘅行\n" +
      "（pool > cap 嘅形狀）唔會被 blame，所以亦唔會觸發「2 小時搵唔到」嘅刪行；批次一個都冇回\n" +
      "仍然係 `pairs-empty`（唔判斷、唔寫、唔刪），下個 tick 重試；row loop 嘅 reserve 同 heal 嘅\n" +
      "deadline 都由 `TRACKER_PAIRS_BUDGET_MS` 推算，所以一個慢批次一樣要讓路畀啲行。\n" +
      "\n" +
      "**一個附帶修好**：holder stage 嘅候選集係 `pairs.has(token)`，即係以前 head 以外嘅行\n" +
      "**永遠冇機會**被 probe；而家 due list 係全 pool 按 `holdersCheckedAt` 排序，最舊嗰行一定\n" +
      "食到每 pass 唯一嘅 slot。\n" +
      "\n" +
      "**active 31 > cap 30**：listing 嘅 `LIMIT ?` ＝ 30，排序係 active 行最舊先，所以多出嚟嗰行\n" +
      "係**最新檢查**嗰行；下一 pass 佢就係最舊，自然回到隊列 —— 唔會餓死，只係快取／慢取之分。\n" +
      "\n" +
      "**上線後要讀**（未做）：\n" +
      "\n" +
      "1. `rows X/N` 嘅 X 由 10 升到貼近 N，`pairs N/N`；\n" +
      "2. active 行嘅年齡由**三堆變一堆**（最舊 < 3 分鐘）；\n" +
      "3. `allow` 同 `trackerMs` 嘅差距縮返，但唔可以出現 `budget-cut` 或 `cut:watchdog`；\n" +
      "4. subrequest 窗：掃描 pair phase 而家連 head（最多 30 個 address）一齊 ask，而且 append 喺\n" +
      "   最後（超 budget 只會剪走 tracker 嘅 pre-fetch），正常 tick 最多多 1 條，要盯住 50 上限\n" +
      "   （§4.6 量到嘅生還 tick 窗 ≈ 30）。\n" +
      "\n" +
      "## 5. 驗證狀態（本地 + 上線）",
  },
];

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, "utf8"));
  return cache.get(file);
};

let failed = false;
for (const e of edits) {
  const text = read(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  cache.set(e.file, text.slice(0, first) + e.next + text.slice(first + e.old.length));
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
for (const [file, text] of cache) fs.writeFileSync(file, text);
