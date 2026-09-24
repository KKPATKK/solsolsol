#!/usr/bin/env node
/**
 * The cold-isolate half of the pre-init arrival stamp (2026-09-24).
 *
 * WHY (live, the first hour after the stamp deployed): the cron trigger
 * delivered EVERY minute (scheduled_tick_at advanced at :02 each minute and the
 * ring's newest entry advanced with it — and cronTick reaches runScan only from
 * the scheduled handler, so both are delivery evidence), the front was healthy,
 * and yet scheduledArrivalTotal stayed ABSENT: the cold-isolate fallback never
 * stamped once. The stamp wrote through Db.get(), which THROWS "Database is not
 * initialized" when no client has been connected — and the fallback is exactly
 * such a handle (a raw `new Db(url, token)` that never ran init, the shape
 * bumpScheduledTickLegacy builds, which is why the legacy bump works and this
 * did not). The worker's catch swallowed the throw, so the stamp was a silent
 * no-op on the ONLY path it was written for.
 *
 * WHY A SCRIPT: scripts/test-unit.js (~10k lines) and docs/round-trips.md sit
 * past the file-tool edit window, so these edits go the way every other record
 * in this directory does (see the file's own §6): verify every anchor matches
 * EXACTLY ONCE first, write nothing unless all of them do, stay re-runnable —
 * an edit that is already present is reported ALREADY, never an error.
 *
 * Run: node docs/patches/preinit-arrival-cold-client.apply.js
 */
const fs = require("fs");
const path = require("path");

const lines = (...xs) => xs.join("\n");

// ------------------------------------------------------------------- db.ts ---
const DB = path.join(__dirname, "..", "..", "src", "db.ts");
const DB_OLD = lines(
  "  async stampScheduledArrival(at: number): Promise<void> {",
  "    await this.get().batch(",
);
const DB_NEW = lines(
  "  async stampScheduledArrival(at: number): Promise<void> {",
  "    // connect(), NOT get(). This write runs BEFORE ensureInitialized, on the",
  "    // arrivals whose front is already suspect — and get() throws \"Database is",
  "    // not initialized\" on a handle whose init has not run. The worker's",
  "    // cold-isolate fallback is exactly such a handle (a raw `new Db(...)` that",
  "    // never calls init, the same shape bumpScheduledTickLegacy builds), so",
  "    // get() here made the stamp a silent no-op on the one path it exists for:",
  "    // live 2026-09-24 the cron trigger was delivering every minute (the ring's",
  "    // newest entry and scheduled_tick_at both advanced, and the front was",
  "    // healthy) while scheduled_arrival_total stayed ABSENT after a deploy —",
  "    // because the cold handle's stamp threw straight into the worker's catch.",
  "    // The unit test below pins the never-initialized handle so this cannot",
  "    // regress back to a write that only works once something else has connected.",
  "    await this.connect().batch(",
);

// --------------------------------------------------------- test-unit.js -----
const TESTS = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
const TEST_ANCHOR = lines(
  '    assert.equal(second.get("scheduled_arrival_at"), "1700000060000");',
  "    await t.cleanup();",
  "  });",
  "",
);
const TEST_SECTION = lines(
  '  await test("Db.stampScheduledArrival: lands on a handle that NEVER ran init (the cold isolate)", async () => {',
  "    const t = tmpDb();",
  "    // The schema and the reader come from an initialized handle...",
  '    const seeded = new Db("file:injected", undefined, t.client);',
  "    await seeded.init();",
  "    // ...while the writer is a SECOND handle that never ran init, which is",
  "    // exactly what the worker's cold-isolate fallback builds: `db === null`",
  "    // before ensureInitialized, so it constructs a raw `new Db(url, token)` and",
  "    // stamps through that. get() throws \"Database is not initialized\" on such a",
  "    // handle, and the worker's own catch swallows it — live 2026-09-24 the cron",
  "    // trigger delivered every minute (the ring's newest entry and",
  "    // scheduled_tick_at both advanced) while scheduled_arrival_total stayed",
  "    // ABSENT after a deploy. The write must go through the lazy connect(), the",
  "    // same primitive bumpScheduledTickLegacy relies on.",
  '    const cold = new Db("file:injected", undefined, t.client);',
  "    await cold.stampScheduledArrival(1_700_000_000_000);",
  "    const read = await seeded.getWorkerStates([",
  '      "scheduled_arrival_total",',
  '      "scheduled_arrival_at",',
  "    ]);",
  '    assert.equal(read.get("scheduled_arrival_total"), "1");',
  '    assert.equal(read.get("scheduled_arrival_at"), "1700000000000");',
  "    await t.cleanup();",
  "  });",
  "",
);

// -------------------------------------------------------- round-trips.md ----
const DOC = path.join(__dirname, "..", "round-trips.md");

const DOC_TEST_OLD = lines(
  "* **測試**：`test-unit.js` 加 3 條 —— Db stamp 一 trip 零 read（counting client 度到",
  "  `executes 0 / batch 1 / statements 3`）、`shouldStampArrival` 規則（含「單一 lost arrival 都要",
  "  捉到」嘅 < 120s 關係）、out-of-window patch guard（半套貼上係危險狀態）。296 → **299 passed, 0 failed**。",
);
const DOC_TEST_NEW = lines(
  "* **測試**：`test-unit.js` 加 3 條 —— Db stamp 一 trip 零 read（counting client 度到",
  "  `executes 0 / batch 1 / statements 3`）、`shouldStampArrival` 規則（含「單一 lost arrival 都要",
  "  捉到」嘅 < 120s 關係）、out-of-window patch guard（半套貼上係危險狀態）。296 → **299 passed, 0 failed**；",
  "  §4.5.3.1 再落一條 cold-handle test ⇒ **300 passed, 0 failed**。",
);

const DOC_VERIFY_ANCHOR = lines(
  "**落線點驗**（deploy 後第一個鐘）：",
  "",
  "1. 健康 warm isolate **唔應該**令 `scheduledArrivalTotal` 動 —— 佢一動就代表嗰個 arrival 嘅前人 tick",
  "   冇返（stamp 只喺呢種 arrival 上開火）。",
);
const DOC_VERIFY_NEXT = lines(
  "### 4.5.3.1 cold isolate 個 stamp 係 no-op：`get()` 對未 init 嘅 handle 會 throw（2026-09-24，已修）",
  "",
  "落線後第一個鐘嘅讀數直接推翻 §4.5.3 嘅 cold-isolate 假設 —— 而且係喺**冇 wedge** 嘅情況下推翻。",
  "",
  "* **現場**（01:43–01:51Z，deploy 之後）：`scheduledTickAt` 每分鐘 :02 前進、ring 最新一格",
  "  01:51:05、scan row 照落 —— 即係 cron **每一分鐘都投遞、而且贏咗 claim**（`cronTick` 只有 scheduled",
  "  handler 會傳入 `runScan`，所以 `scheduled_tick_at`／ring 前進本身就係投遞證據，唔關 HTTP monitor 事）。",
  "  但 `scheduledArrivalTotal` 由頭到尾都係 **null**（key 根本唔存在）＝ cold isolate 一次都冇 stamp 成功。",
  "  ⚠️ ring 係**新到舊**排（`tickRing[0]` 最新），所以睇 ring 尾幾個會誤以為「凍結」—— 睇 ring 要睇頭。",
  "* **原因**：`Db.stampScheduledArrival` 用 `this.get()` 落筆，而 `get()` 喺 `client === null` 時 **throw",
  "  \"Database is not initialized\"**；cold isolate 個 fallback 正正係一個**未 init 過**嘅 raw",
  "  `new Db(url, token)`（同 `bumpScheduledTickLegacy` 同形 —— 分別係後者用 `this.connect()`，所以 legacy",
  "  bump 一直冇事）。寫入 throw，worker 個 catch 靜靜食咗（只有 console.error，冇 reader）。即係 stamp 喺",
  "  **唯一為佢而設**嘅路徑（冷 isolate／死喺 init 之前）上完全冇作用，只有「warm db handle ＋ stale flag」",
  "  呢個罕見組合會真寫入。",
  "* **修法**：改用 `this.connect()`（lazy、唔需要 init —— 同 `bumpScheduledTick` 一樣嘅 primitive），1 行。",
  "  另加一條**回歸測試**：一個 init 過嘅 handle 建 schema ＋ 讀，另一個**冇 init** 嘅 handle 落 stamp，",
  "  斷言讀得到 `1` 同時間戳。呢條測試釘住「stamp 必須喺未 init 嘅 handle 上生效」，所以 `get()` 版本會 fail。",
  "* **點解原本 3 條測試捉唔到**：第一條 test 開頭就 `await db.init()`（即係已經係 warm handle），patch",
  "  guard 只看原始碼有冇接線。**「warm handle 寫得到」同「cold handle 寫得到」係兩件事**，而 stamp 只喺",
  "  cold／死亡路徑開火 —— 呢個就係測試同 production 嘅縫。",
  "* **教訓**：`/health` 上「新 key 一直係 null」唔可以當「冇事發生」—— idle 同 broken 長得一模一樣。",
  "  一個「沉默即健康」嘅儀器，落線第一件事係證明佢**開得著**（逼一個 arrival stamp，或者睇 error log），",
  "  唔係等 wedge 嚟驗。",
  "* **落線 script**：`docs/patches/preinit-arrival-cold-client.apply.js`（`db.ts` ＋ 測試 ＋ 本節）。",
  "",
  "**落線點驗**（deploy 後第一個鐘）：",
  "",
  "0. **cold isolate 一定要 stamp 一次**：deploy 之後任何一個 isolate 都係新嘅 ⇒ 佢收到嘅第一個 cron",
  "   arrival 個 flag 係 0 ⇒ 必定 stamp。修好之後 deploy 後第一個鐘就**應該**見到",
  "   `scheduledArrivalTotal ≥ 1`；若果仍然係 null 而 ring／`scheduledTickAt` 照前進，即係 stamp 仲係死嘅",
  "   （呢個就係 §4.5.3.1 嗰個狀態，唔好再當佢係「健康所以唔動」）。",
  "1. 健康 warm isolate **唔應該**令 `scheduledArrivalTotal` 動 —— 佢一動就代表嗰個 arrival 嘅前人 tick",
  "   冇返（stamp 只喺呢種 arrival 上開火）。",
);

const DOC_COUNT_OLD = lines(
  "* `node scripts/test-unit.js` → **299 passed, 0 failed** ✅（§4.5.3 新增 3 條 pre-init arrival test；",
  "  再之前係 296 —— §17.6 嗰 3 條 row-span-hold test；295 ＝ §4.7 嗰 1 條 grouped-telemetry test；",
);
const DOC_COUNT_NEW = lines(
  "* `node scripts/test-unit.js` → **300 passed, 0 failed** ✅（§4.5.3.1 新增 1 條 cold-handle test；",
  "  再之前 299 —— §4.5.3 嗰 3 條 pre-init arrival test；296 —— §17.6 嗰 3 條 row-span-hold test；",
  "  295 ＝ §4.7 嗰 1 條 grouped-telemetry test；",
);

// Each job: `done` is the witness that this piece is already in place.
const JOBS = [
  {
    file: DB,
    label: "db.ts stampScheduledArrival uses connect()",
    done: "await this.connect().batch(",
    anchor: DB_OLD,
    next: DB_NEW,
  },
  {
    file: TESTS,
    label: "test-unit.js cold-handle regression test",
    done: "lands on a handle that NEVER ran init",
    anchor: TEST_ANCHOR,
    next: TEST_ANCHOR + TEST_SECTION,
  },
  {
    file: DOC,
    label: "round-trips §4.5.3 test count",
    done: "§4.5.3.1 再落一條 cold-handle test",
    anchor: DOC_TEST_OLD,
    next: DOC_TEST_NEW,
  },
  {
    file: DOC,
    label: "round-trips §4.5.3.1 + the cold-isolate check",
    done: "### 4.5.3.1 cold isolate 個 stamp 係 no-op",
    anchor: DOC_VERIFY_ANCHOR,
    next: DOC_VERIFY_NEXT,
  },
  {
    file: DOC,
    label: "round-trips §5 test count",
    done: "**300 passed, 0 failed** ✅（§4.5.3.1",
    anchor: DOC_COUNT_OLD,
    next: DOC_COUNT_NEW,
  },
];

// Pass 1: verify. Every pending job's anchor must match exactly once.
let failed = false;
const pending = [];
for (const job of JOBS) {
  const text = fs.readFileSync(job.file, "utf8");
  if (job.done && text.includes(job.done)) {
    console.log(`ALREADY   ${job.label}`);
    continue;
  }
  const at = text.indexOf(job.anchor);
  if (at < 0) {
    console.error(`MISS      ${job.label} (${path.relative(process.cwd(), job.file)})`);
    failed = true;
    continue;
  }
  if (text.indexOf(job.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${job.label} — the anchor matches more than once`);
    failed = true;
    continue;
  }
  pending.push(job);
}
if (failed) {
  console.error("\nnothing written — fix the anchors above (a half-applied stamp is invisible)");
  process.exit(1);
}
if (pending.length === 0) {
  console.log("ok        the cold-isolate fix is already in place");
  process.exit(0);
}

// Pass 2: write, re-reading each file so two jobs in one file both apply.
for (const job of pending) {
  const text = fs.readFileSync(job.file, "utf8");
  fs.writeFileSync(job.file, text.replace(job.anchor, job.next));
  console.log(`ok        ${job.label}`);
}
console.log(`ok        ${pending.length} edits written`);
