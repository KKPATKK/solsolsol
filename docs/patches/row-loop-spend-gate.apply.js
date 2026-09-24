#!/usr/bin/env node
/**
 * Moves the row loop's budget gate from "before every row" to "before every
 * SPEND", so one late pass still covers the whole tracked pool.
 *
 * Why (live 2026-09-24 04:56:13Z, §4.8.1):
 *
 *   ok:17/2 rows 17/30 pairs 30/30 miss 0 lost 0 budget-cut allow 4521
 *   spend[setup 521/2 heal 498/1 ... pairs 0/0 rows 3701/9 holders 284/1 ...]
 *
 * The `rows 3701/9` was read as "411ms per row", which is wrong: the 9 round
 * trips belong to the ~3 ALERTING rows (claim + reservation + final write, 3
 * trips each). The other ~14 rows were QUIET, and a quiet row costs NO round
 * trip of its own — its write rides the single batched claim after the loop
 * (see silentChecks / Db.claimPushWatchChecksMany). So that pass was not short
 * of round trips at all: it hit the loop-top gate and `break`-ed out of the
 * rotation, leaving 13 quiet rows unqueued that would have cost NOTHING to
 * include in the batch it was already paying for.
 *
 * The gate now refuses only what actually spends:
 *   - the pairMiss 2h-delete (one round trip), and
 *   - the alerting path (claim + reservation + send + final write),
 * and a refused row is left completely untouched — the documented rule for
 * `defer-send`, which is what keeps its place at the front of the rotation.
 *
 * The at-most-once machinery is untouched: the claim and the reservation are
 * still two separate CAS statements, the reservation still lands before the
 * send, and `reservePushWatchAlert` still decides the duplicate race.
 *
 * Same discipline as the other patch scripts: exactly one match per
 * replacement, or nothing is written.
 */
const fs = require("fs");

const PUSHWATCH = "src/pushwatch.ts";
const TESTS = "scripts/test-unit.js";
const DOC = "docs/round-trips.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{file: string, label: string, old: string, next: string}>} */
const edits = [
  {
    file: PUSHWATCH,
    label: "pushwatch: the firstRow exception is gone with the per-row gate",
    old: L("    let firstRow = true;", "    const rowsStart = Date.now();"),
    next: L("    const rowsStart = Date.now();"),
  },
  {
    file: PUSHWATCH,
    label: "pushwatch: the gate moves from the row to the spend",
    old: L(
      "      // Budget check BETWEEN rows: the claim and the alert reservation for a",
      "      // row both happen after this point, so leaving a row to the next tick",
      "      // can never drop an alert (it is re-claimed and re-evaluated then).",
      "      // The FIRST row is never skipped: when the front stages (recap/prune,",
      "      // self-heal, pair batch) run long, breaking here is what silently",
      "      // stopped all post-push monitoring — the pass reported `ok:0/0` with no",
      "      // note while 28 active rows went unrefreshed (2026-09-17). One row per",
      "      // tick is the floor that keeps the tracker moving no matter what",
      "      // DexScreener or Turso are doing.",
      "      if (!firstRow && Date.now() + rowReserveMs() > deadline) {",
      "        budgetCut = true;",
      "        break;",
      "      }",
      "      firstRow = false;",
    ),
    next: L(
      "      // Budget check BETWEEN rows — but it gates the SPENDS, not the rows. A",
      "      // quiet row costs no round trip of its own (its write rides the ONE",
      "      // batched claim after the loop, see silentChecks), so charging it this",
      "      // pass's clock bought nothing and cost plenty: live 2026-09-24",
      "      // 04:56:13Z the loop spent 3_701ms on three alerting rows' claim/",
      "      // reservation/write trips and then `break`-ed out with `rows 17/30` —",
      "      // thirteen QUIET rows that would have joined the very batch the pass",
      "      // was already paying for went unmeasured, and the next pass paid",
      "      // another batch to pick them up.",
      "      //",
      "      // The check now governs the two things a row can actually spend: the",
      "      // pairMiss delete below and the alerting path's claim + reservation +",
      "      // send + final write. The 2026-09-17 incident this gate descends from",
      "      // (front stages ate the budget, the loop `break`-ed, 28 rows went",
      "      // unrefreshed while the note read `ok:0/0`) is answered harder than",
      "      // before: no quiet row is ever left behind, and every refused spend",
      "      // still says so — `budget-cut` plus `defer-send N`.",
      "      const overBudget = Date.now() + rowReserveMs() > deadline;",
    ),
  },
  {
    file: PUSHWATCH,
    label: "pushwatch: the pairMiss helper's clock is measured, not assumed",
    old: L(
      "    /** Room ANOTHER row needs: one observed trip is its first call. */",
      "    const rowReserveMs = (): number =>",
      "      Math.min(TRACKER_ROW_LEASH_MS, tripMs());",
    ),
    next: L(
      "    /**",
      "     * Room a SPEND needs before it may START. The alerting path pays three",
      "     * round trips plus a Telegram send and the pairMiss delete pays one, and",
      "     * neither can be interrupted once begun — a row refused here is left",
      "     * untouched and re-claimed by the next tick (see the gate in the loop).",
      "     */",
      "    const rowReserveMs = (): number =>",
      "      Math.min(TRACKER_ROW_LEASH_MS, tripMs());",
    ),
  },
  {
    file: PUSHWATCH,
    label: "pushwatch: the pairMiss delete is a spend and the gate knows it",
    old: L(
      "        if (row.lastChecked > 0 && now - lastSeen > 2 * 3_600_000) {",
      "          trips += 1;",
      "          await this.db.deletePushWatch(row.token);",
      "        }",
      "        continue;",
    ),
    next: L(
      "        // The delete is this branch's ONLY round trip, so it is the only",
      "        // thing the pass's clock has to refuse (see overBudget above).",
      "        // Skipping it is free: the row stays listed, and the next pass",
      "        // re-finds it either way.",
      "        if (!overBudget && row.lastChecked > 0 && now - lastSeen > 2 * 3_600_000) {",
      "          trips += 1;",
      "          await this.db.deletePushWatch(row.token);",
      "        }",
      "        continue;",
    ),
  },
  {
    file: PUSHWATCH,
    label: "pushwatch: a refused card no longer abandons the rest of the rotation",
    old: L(
      "        if (sendBudgetEnd - Date.now() < needMs) {",
      "          sendDeferred += 1;",
      "          budgetCut = true;",
      "          break;",
      "        }",
    ),
    next: L(
      "        // `continue`, not `break`: a refused row is left COMPLETELY",
      "        // untouched (no claim, no write — see the alerting path below), so",
      "        // the rest of the rotation is still worth walking. Breaking here is",
      "        // what turned a short pass into an unmeasured tail of quiet rows.",
      "        if (overBudget || sendBudgetEnd - Date.now() < needMs) {",
      "          sendDeferred += 1;",
      "          budgetCut = true;",
      "          continue;",
      "        }",
    ),
  },
  {
    file: TESTS,
    label: "test: a late pass now queues the whole pool, not one row",
    old: L(
      '  await test("PushWatcher: the row loop always evaluates a row, even when the pair batch ate the budget", async () => {',
      '    const rows = [watchRow("AAA"), watchRow("BBB")];',
      "    const updated = [];",
      "    const deadlines = [];",
      "    const pairsFor = async (addrs, deadlineMs) => {",
      "      deadlines.push(deadlineMs);",
      "      await new Promise((r) => setTimeout(r, 250));",
      "      return new Map(addrs.map((a) => [a, watchPair(a)]));",
      "    };",
      "    const pw = new PushWatcher(",
      "      watchDb(rows, updated), watchBot, null, loadConfig({}), pairsFor, null,",
      "    );",
      "    // 100ms budget against a 250ms batch: the pass is past its deadline",
      "    // before the loop even starts — the live shape. The first row must run.",
      "    const out = await pw.runTick(Date.now() + 100);",
      '    assert.equal(out.checked, 1, "one row must be evaluated however late the pass is");',
      "    assert.equal(updated.length, 1);",
      "    assert.match(String(out.note), /budget-cut/);",
      "    assert.equal(",
      "      typeof deadlines[0],",
      '      "number",',
      '      "the batch gets a caller deadline so it cannot overrun the pass",',
      "    );",
      "  });",
    ),
    next: L(
      '  await test("PushWatcher: a late pass still queues the WHOLE pool in one trip", async () => {',
      '    const rows = [watchRow("AAA"), watchRow("BBB")];',
      "    const updated = [];",
      "    const deadlines = [];",
      "    const pairsFor = async (addrs, deadlineMs) => {",
      "      deadlines.push(deadlineMs);",
      "      await new Promise((r) => setTimeout(r, 250));",
      "      return new Map(addrs.map((a) => [a, watchPair(a)]));",
      "    };",
      "    const pw = new PushWatcher(",
      "      watchDb(rows, updated), watchBot, null, loadConfig({}), pairsFor, null,",
      "    );",
      "    // 100ms budget against a 250ms batch: the pass is past its deadline",
      "    // before the loop even starts — the live shape. A quiet row spends no",
      "    // round trip of its own, so BOTH rows must still be queued: this used to",
      "    // assert `checked === 1` plus `budget-cut`, i.e. it pinned the `break`",
      "    // that left the live rotation at `rows 17/30` while thirteen quiet rows",
      "    // could have ridden the batch for free.",
      "    const out = await pw.runTick(Date.now() + 100);",
      '    assert.equal(out.checked, 2, `the whole pool must be queued: ${out.note}`);',
      '    assert.equal(updated.length, 2, "and it is paid for in the SAME single trip");',
      "    assert.match(String(out.note), /rows 2\\/2/);",
      "    assert.doesNotMatch(",
      "      String(out.note),",
      "      /budget-cut/,",
      '      "no spend was refused, so nothing may be reported as cut",',
      "    );",
      "    assert.equal(",
      "      typeof deadlines[0],",
      '      "number",',
      '      "the batch gets a caller deadline so it cannot overrun the pass",',
      "    );",
      "  });",
      "",
      '  await test("PushWatcher: one late pass covers all 30 tracked rows in a single batch trip", async () => {',
      "    const rows = Array.from({ length: 30 }, (_, i) => watchRow(`POOL${i}`));",
      "    const updated = [];",
      "    let batchCalls = 0;",
      "    const db = watchDb(rows, updated);",
      "    const innerBatch = db.claimPushWatchChecksMany;",
      "    db.claimPushWatchChecksMany = async (batch) => {",
      "      batchCalls += 1;",
      "      return innerBatch(batch);",
      "    };",
      "    const pw = new PushWatcher(",
      "      db,",
      "      watchBot,",
      "      null,",
      "      loadConfig({}),",
      "      async (addrs) => {",
      "        // The pair batch eats the whole allowance, the live shape that used",
      "        // to cut the rotation short on every slow tick.",
      "        await new Promise((r) => setTimeout(r, 250));",
      "        return new Map(addrs.map((a) => [a, watchPair(a)]));",
      "      },",
      "      null,",
      "    );",
      "    const out = await pw.runTick(Date.now() + 120);",
      '    assert.equal(out.checked, 30, `the whole rotation must be queued: ${out.note}`);',
      '    assert.match(String(out.note), /rows 30\\/30/, `the note must say so: ${out.note}`);',
      '    assert.equal(batchCalls, 1, "thirty rows, one round trip");',
      "    assert.equal(updated.length, 30);",
      "  });",
    ),
  },
  {
    file: DOC,
    label: "doc: §4.8.1 stops recommending the wrong next cut",
    old: L(
      "但已經由「3 個 pass／5–8 分鐘」收到「2 個 pass／~2 分鐘」。要真正一個 pass 掃完，下一刀係減每行嘅",
      "round trip（呢個 411ms／行），唔係再加 head。",
    ),
    next: L(
      "但已經由「3 個 pass／5–8 分鐘」收到「2 個 pass／~2 分鐘」。",
      "",
      "**更正（見 §4.8.2）**：`rows 3701/9` **唔係**「411ms／行」。嗰 9 個 trip 係 ~3 條 alerting",
      "row 嘅（claim ＋ reservation ＋ final write），而 quiet row 本身 **零 trip**（一次過 batch 寫）。",
      "即個 pass 唔係唔夠 round trip，係喺 loop 頂 `break` 走出輪替，剩低 13 條 quiet row 明明可以",
      "搭同一個 batch **免費**寫埋。所以下一刀唔係「減每行 trip」（冇嘢好減），而係把 gate 由每行搬去",
      "每次 spend —— 見 §4.8.2。",
    ),
  },
  {
    file: DOC,
    label: "doc: §4.8.2 — the spend gate",
    old: "## 5. 驗證狀態（本地 + 上線）",
    next: L(
      "### 4.8.2 一刀：budget gate 由「每行」搬去「每次 spend」（未上線）",
      "",
      "**§4.8.1 嗰句「下一刀係減每行嘅 round trip」係錯嘅診斷，要收回。** 睇返 `rows 3701/9`：",
      "9 個 trip **唔係** 17 行攤分（411ms／行），而係 **~3 條 alerting row** 各自嘅 claim／reservation／",
      "final write（3 trip／條）。其餘 ~14 條 quiet row **一個 trip 都唔使** —— 佢哋排隊，由 loop 之後",
      "嗰一個 `claimPushWatchChecksMany` 一次過寫（§4.2 嘅 batching 成果）。",
      "",
      "即 04:56:13Z 嗰個 pass **唔係唔夠 round trip**：佢喺 loop 頂嗰道 gate",
      "`if (!firstRow && Date.now() + rowReserveMs() > deadline) { budgetCut = true; break; }`",
      "**跳出咗成個輪替**，剩低 13 條 quiet row 明明可以搭同一個 batch **免費**寫埋。",
      "",
      "| 位 | 前 | 後 |",
      "| --- | --- | --- |",
      "| loop 頂嘅 gate | 每行之前檢查，超時 `break`（跳走其餘輪替） | 只計一個 `overBudget` flag，唔 break |",
      "| `pairMiss` 嘅 delete | 無條件 `await deletePushWatch`（呢個 branch 唯一嘅 trip） | `!overBudget` 才做 |",
      "| alerting row 嘅 send gate | 唔夠 slice → `break` | `overBudget` 或唔夠 slice → `continue`（該行完全唔碰） |",
      "",
      "**唔變嘅嘢**：at-most-once 嘅機器一模一樣 —— claim 同 reservation 仍然係兩個獨立 CAS、",
      "reservation 仍然喺 send 之前落地、refused 嘅 row 仍然「完全唔碰」（`last_checked` 都唔寫），",
      "所以下一個 tick 用新 budget 喺隊頭再試。改動只係「唔再因為一個唔夠錢嘅 spend，放棄其餘免費嘅行」。",
      "",
      "**單元測試**：舊嗰條「the row loop always evaluates a row, even when the pair batch ate the",
      "budget」（2 條 quiet row、100ms budget 對 250ms batch）斷言 `checked === 1` ＋ `budget-cut`，",
      "即係**釘住舊嘅 break 行為**，已改成 `checked === 2`、`rows 2/2`、**冇** `budget-cut`；另加一條新",
      "test：30 行、pair batch 食晒 allowance，仍然 `rows 30/30`，而 `claimPushWatchChecksMany` 只叫",
      "**一次**（30 行一個 trip）。",
      "",
      "**上線後要讀**（未做）：",
      "",
      "1. 慢 pass 嘅 `rows X/N`：X 應該貼近 N（30），唔再係 17；",
      "2. `budget-cut` **仍然要出**（alerting row 被拒時）＋ `defer-send N` 要有數 —— 呢兩樣證明",
      "   「唔再 break」冇把「拒絕」靜音化；",
      "3. `rows <ms>/<trips>` 嘅 trips 唔應該因為行多咗而上升（quiet row 依然零 trip）。",
      "",
      "## 5. 驗證狀態（本地 + 上線）",
    ),
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
