#!/usr/bin/env node
/**
 * §3：tick 喺 front/postscan 死 → tracker 整個 pass 冇行 → 41 分鐘冇 row 被 evaluate。
 *
 * WHAT HAPPENED (live 2026-09-25 01:56–02:36Z, ~41 minutes)
 *   - 31 條 active row 全部 stale 2312s → 2558s（`/debug/push-watch`）。
 *   - 每一個完成嘅 pass 都係 `ok:0/0 deferred:subreq-budget ... rows 0/0`
 *     （6 次連續採樣 + 一個凍結 4.5 分鐘嘅 pass record）。
 *   - `tickProgress.stage` 停喺 `front`／`postscan`，`scanCount 0`、`lastScanMs null`。
 *   - 佢自己喺 02:36:51Z 恢復（`scanCount 0→1`、`deadTickStreak 1`），下一 pass
 *     即刻 `rows 26/30`。
 *
 * WHY: the tick lives at 43–45 of the platform's 50 subrequests
 *   Live `summary.subreqs`: 一個完成嘅 tick `total 43–45`，其中 **Turso 35**
 *   （`{budget 50, unseenAllowance 12, usable 38}`）。tracker pass 係
 *   **最後**一個跑嘅階段（worker's tail），而且係明文嘅「residual claimant」：
 *
 *     "The pass runs last, so it is the residual claimant: measured on a cold
 *      isolate the front (init + scan + completion flush) had already spent 47
 *      of the 50 Workers Free allows ..."                      — src/worker.ts
 *
 *   佢係唯一會**按名 defer**（`deferred:subreq-budget`）嘅階段，所以冇 row 被檢查，
 *   而佢冇任何配額保證 —— 前面邊一個階段都可以用光。
 *
 * 而 write drain 就係最尖嗰個：佢排喺 tracker **前面**，成本係「queue 有幾長」
 *   `drainDeferredWrites()` 由 worker 嘅 `onTickEnd` 觸發（scan 一完就 fire，即係
 *   喺 tracker pass 之前），而且係 `while (queue.length > 0)` ——**冇上限、冇配額
 *   意識**：DB 一恢復，一條 20 條嘅 backlog 就會喺 tracker 之前一次過落 20 個 Turso
 *   round trip。durable record 正正顯示嗰條 backlog：`writeDrainError {method
 *   updateTokenMaxMcaps, "db execute hit the 3000ms hard wall — libsql retry loop
 *   never settled", pending 20}`，而 starvation 散嘅時候 `pending 0`
 *   （`summary.writeDrain`）—— 即係 backlog 一清，tracker 即刻有配額。
 *
 * THE FIX
 *   1. `drainDeferredWrites(subreqLeft = subreqRemaining)`：可注入 ceiling（同
 *      `runTrackerPass(…, subreqLeft)` 一樣嘅形狀，所以測試餵得入）。
 *   2. Drain 喺 `subreqLeft() <= DRAIN_TRACKER_RESERVE` 時**停止**，entry 留在 queue
 *      （佢本來就係「landed 才離開」嘅設計，可以等下一次）。
 *   3. 「held」**唔係 failure**：唔計 `failures`、唔寫 `writeDrainError`、唔試 3 次。
 *      新欄位 `heldForTracker` 講明 batch 係為咩停（`pending 3 failed 0` 同
 *      `pending 3 held 3` 係兩件唔同嘅事）。
 *
 * 未修（講清楚）：scan 自己嘅花費（~17-20，多數係 Turso）＋ tracker 行輪替本身
 *   （一行一個 claim/check UPDATE ⇒ 一次 ~30）令個 tick 長期貼住 50。drain 只係
 *   最尖、最冇價值嗰一段；要再進一步就要**減少** round trip（把 row loop 嘅
 *   claim/check 合併成一個 `batch()`，或喺 scan 側留配額）—— 見 doc 尾。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const CONST = lines(
  "",
  "/**",
  " * Subrequests the write drain leaves for the TRACKER PASS behind it.",
  " *",
  " * WHY A FLOOR (live 2026-09-25, ~41 minutes of starvation): the drain is fired",
  " * from the worker's `onTickEnd` — i.e. as soon as the scan ends, which is",
  " * BEFORE the tracker pass in that invocation's tail — and it walks its queue",
  " * with no ceiling at all: `while (queue.length > 0)`. Its cost is therefore",
  " * \"however long the backlog is\", and a 20-entry backlog is 20 Turso round trips",
  " * spent in front of the one stage that runs LAST and is explicitly the residual",
  " * claimant of the platform's 50-subrequest allowance (see worker.ts's note on",
  " * `subreqRemaining`). The tracker is the only stage that defers by name",
  " * (`deferred:subreq-budget`), so a backlog can starve the whole row rotation",
  " * without ever failing anything: rows went unchecked for 41 minutes while every",
  " * completed pass read `rows 0/0`, and the rotation came back the moment the",
  " * backlog cleared (`summary.writeDrain.pending` 20 → 0).",
  " *",
  " * THE NUMBER: what a pass needs to be WORTH STARTING — its tail writes",
  " * (TRACKER_SUBREQ_RESERVE = 6, see pushwatch.ts) plus a few rows of the rotation",
  " * (one claim/check UPDATE each). 8 + 6 = 14, i.e. about eight rows rather than",
  " * the fifteen the rotation wants on a roomy tick. Held entries are NOT failures:",
  " * the queue is built to keep an entry until it lands, so the next tick's drain",
  " * (or this one, after the pass) takes them — see WriteDrainView.heldForTracker.",
  " */",
  "export const DRAIN_TRACKER_RESERVE = 14;",
);

const DOC_HEADING = "### 4.9 write drain 唔可以食 tracker 嘅 subrequest 配額（2026-09-25）";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "**Live：41 分鐘冇任何 row 被 evaluate。** 31 條 active row 全部 stale",
  "2312s → 2558s；每一個完成嘅 pass 都係 `ok:0/0 deferred:subreq-budget … rows 0/0`；",
  "`tickProgress.stage` 停喺 `front`／`postscan`，`scanCount 0`；02:36:51Z 自己恢復，",
  "下一個 pass 即刻 `rows 26/30`。",
  "",
  "**原因：個 tick 長期住喺平台 50 個 subrequest 嘅 43–45。** `summary.subreqs` 顯示一個",
  "完成嘅 tick `total 43–45`，其中 Turso 35（`budget 50 / unseenAllowance 12 / usable 38`）。",
  "tracker pass 係最後一個跑嘅階段，而且係明文嘅 residual claimant（worker.ts 自己寫：冷",
  "isolate 上 front 已經用咗 47/50，pass 第一個 Turso call 就係俾 runtime 拒嗰個）。",
  "",
  "**最尖嗰一段係 write drain**：佢由 `onTickEnd` fire，即係喺 tracker **之前**，而",
  "`while (queue.length > 0)` 冇任何 ceiling —— backlog 幾長就食幾多個 round trip。",
  "Durable record 正正係一條 20 條嘅 backlog（`writeDrainError {method",
  "updateTokenMaxMcaps, \"db execute hit the 3000ms hard wall — libsql retry loop never",
  "settled\", pending 20}`），而 starvation 散嗰刻 `summary.writeDrain.pending` 係 0。",
  "",
  "**修正**（`docs/patches/drain-yields-tracker.apply.js`）：",
  "",
  "| | 之前 | 之後 |",
  "|---|---|---|",
  "| drain 嘅上限 | 冇（backlog 幾長食幾長） | `subreqLeft() <= DRAIN_TRACKER_RESERVE`（14）就停 |",
  "| 停咗嘅 entry | — | 留在 queue（「landed 才離開」），下一 tick／pass 之後再落 |",
  "| 讀數 | `pending` | `pending` ＋ `heldForTracker`（held **唔係** failure：唔計 `failures`、唔寫 durable 錯、唔消耗 3 次重試） |",
  "",
  "**未修**：scan 自己嘅 ~17–20（多數係 Turso）＋ tracker 行輪替（一行一個 claim/check",
  "UPDATE ⇒ 一次 ~30）令個 tick 貼住 50，drain 只係最尖、最冇產品價值嗰段。要再收窄就要",
  "**減 round trip**：把 row loop 嘅 claim/check 合併成一個 `batch()`（30 → 1–2），或者喺",
  "scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。",
);

const PATCHES = [
  // ── src/tickprobe.ts ─────────────────────────────────────────────────────
  {
    file: "src/tickprobe.ts",
    what: "the drain can be handed a ceiling, like the tracker pass",
    marker: 'import { markSubreqPhase, subreqRemaining } from "./subreqs";',
    anchor: 'import { markSubreqPhase } from "./subreqs";',
    replacement: 'import { markSubreqPhase, subreqRemaining } from "./subreqs";',
  },
  {
    file: "src/tickprobe.ts",
    what: "and the floor it honours is named with the incident",
    marker: "DRAIN_TRACKER_RESERVE",
    anchor: "export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;",
    replacement: lines(
      "export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;",
      CONST,
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the view names what was held back",
    marker: "  heldForTracker: number;",
    anchor: lines(
      "  pending: number;",
      "  /** Cumulative since the isolate booted, so the effect is readable either way. */",
    ),
    replacement: lines(
      "  pending: number;",
      "  /**",
      "   * Entries this drain did NOT touch because the tracker pass behind it still",
      "   * needed the invocation's subrequest allowance (see DRAIN_TRACKER_RESERVE).",
      "   * Deliberately separate from `pending`, which also counts a batch stopped by",
      "   * a failure: `pending 3 failures 0` is a held batch, `pending 3 failures 1` is",
      "   * a database that just refused a write. Neither drops anything.",
      "   */",
      "  heldForTracker: number;",
      "  /** Cumulative since the isolate booted, so the effect is readable either way. */",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the module's first view carries it",
    marker:
      "let drain: WriteDrainView = {\n  calls: 0,\n  ms: 0,\n  at: 0,\n  failures: 0,\n  lastError: null,\n  pending: 0,\n  heldForTracker: 0,",
    anchor: lines(
      "let drain: WriteDrainView = {",
      "  calls: 0,",
      "  ms: 0,",
      "  at: 0,",
      "  failures: 0,",
      "  lastError: null,",
      "  pending: 0,",
      "  totals: { calls: 0, ms: 0, failures: 0 },",
      "};",
    ),
    replacement: lines(
      "let drain: WriteDrainView = {",
      "  calls: 0,",
      "  ms: 0,",
      "  at: 0,",
      "  failures: 0,",
      "  lastError: null,",
      "  pending: 0,",
      "  heldForTracker: 0,",
      "  totals: { calls: 0, ms: 0, failures: 0 },",
      "};",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "so does the reset",
    marker:
      "    pending: 0,\n    heldForTracker: 0,\n    totals: { calls: 0, ms: 0, failures: 0 },\n  };\n  cardSend =",
    anchor: lines(
      "  drain = {",
      "    calls: 0,",
      "    ms: 0,",
      "    at: 0,",
      "    failures: 0,",
      "    lastError: null,",
      "    pending: 0,",
      "    totals: { calls: 0, ms: 0, failures: 0 },",
      "  };",
    ),
    replacement: lines(
      "  drain = {",
      "    calls: 0,",
      "    ms: 0,",
      "    at: 0,",
      "    failures: 0,",
      "    lastError: null,",
      "    pending: 0,",
      "    heldForTracker: 0,",
      "    totals: { calls: 0, ms: 0, failures: 0 },",
      "  };",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the drain takes the ceiling and stops at it",
    marker: "export async function drainDeferredWrites(\n  subreqLeft: () => number = subreqRemaining,",
    anchor: lines(
      "export async function drainDeferredWrites(): Promise<WriteDrainView> {",
    ),
    replacement: lines(
      "/**",
      " * `subreqLeft` is the invocation's remaining allowance (src/subreqs.ts),",
      " * injectable for the same reason the tracker pass takes one: so a caller that",
      " * owns a different window — and every test — can say what \"no room left\"",
      " * means. The default reads the live counter.",
      " */",
      "export async function drainDeferredWrites(",
      "  subreqLeft: () => number = subreqRemaining,",
      "): Promise<WriteDrainView> {",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "and the batch leaves the tracker's slice alone",
    marker: "subreqLeft() <= DRAIN_TRACKER_RESERVE",
    anchor: lines(
      "  let lastError: WriteDrainView[\"lastError\"] = null;",
      "  try {",
    ),
    replacement: lines(
      "  let lastError: WriteDrainView[\"lastError\"] = null;",
      "  // Entries this drain walked past to keep the tracker pass's slice intact.",
      "  let heldForTracker = 0;",
      "  try {",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the loop body checks it before every write",
    marker: "      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {",
    anchor: lines(
      "    while (queue.length > 0) {",
      "      const call = queue[0];",
    ),
    replacement: lines(
      "    while (queue.length > 0) {",
      "      // The tracker pass runs BEHIND this drain in the same invocation (the",
      "      // worker fires the drain from onTickEnd and calls runTrackerPass in its",
      "      // tail), and it is the stage that both needs the most round trips and has",
      "      // no reservation of its own — it defers by name instead. So the drain",
      "      // yields: a held entry is not lost, it just waits (see the queue's own",
      "      // \"an entry leaves it only once it has landed\").",
      "      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {",
      "        heldForTracker = queue.length;",
      "        break;",
      "      }",
      "      const call = queue[0];",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the empty batch reports nothing held",
    marker: "calls: 0, ms: 0, failures: 0, pending: 0, heldForTracker: 0",
    anchor: "      drain = { ...drain, calls: 0, ms: 0, failures: 0, pending: 0 };",
    replacement:
      "      drain = { ...drain, calls: 0, ms: 0, failures: 0, pending: 0, heldForTracker: 0 };",
  },
  {
    file: "src/tickprobe.ts",
    what: "and a batch that ran reports what it left",
    marker: "    pending: queue.length,\n    heldForTracker,",
    anchor: lines(
      "    lastError,",
      "    pending: queue.length,",
      "    totals: {",
    ),
    replacement: lines(
      "    lastError,",
      "    pending: queue.length,",
      "    heldForTracker,",
      "    totals: {",
    ),
  },
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the drain's floor gets a behavioural test",
    marker: "the write drain yields the tracker's slice",
    anchor: lines(
      '  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {',
    ),
    replacement: lines(
      '  await test("tickprobe: the write drain yields the tracker\'s slice instead of spending it", async () => {',
      "    // Live 2026-09-25: 41 minutes with no row evaluated. The tick sits at 43–45",
      "    // of the platform's 50 subrequests, the tracker pass runs LAST as the",
      "    // residual claimant, and the write drain ahead of it had no ceiling at all",
      "    // — so a 20-entry backlog was 20 Turso round trips spent in front of the one",
      "    // stage that cannot run without them.",
      '    const { installTickProbe, drainDeferredWrites, resetTickProbe, writeDrainView, deferredWriteCount, DRAIN_TRACKER_RESERVE } = require("../dist/tickprobe.js");',
      "    const mkDb = () => ({",
      "      landed: [],",
      "      recordTokenStatsMany: async (tokens) => { mkDb.count += tokens.length; },",
      "      updateTokenMaxMcaps: async () => {},",
      "      getTokenStatsMany: async () => [],",
      "    });",
      "    const runTick = async (db, n) => {",
      "      const seam = {",
      "        runOnce: async () => {",
      "          for (let i = 0; i < n; i++) await db.recordTokenStatsMany([`T${i}`]);",
      "        },",
      "      };",
      "      installTickProbe(seam, { db, deferWrites: true });",
      "      await seam.runOnce();",
      "    };",
      "    const landedOf = (db) => db.landed.length;",
      "    resetTickProbe();",
      "    const db = mkDb();",
      "    // The fake records the writes it actually ran.",
      "    db.recordTokenStatsMany = async (tokens) => { db.landed.push(tokens.length); };",
      "    await runTick(db, 3);",
      '    assert.equal(landedOf(db), 0, "a deferred write does not land inside the tick");',
      '    assert.equal(deferredWriteCount(), 3, "it waits in the queue");',
      "",
      "    // (a) With the allowance roomy, the drain lands the whole batch — the",
      "    //     behaviour a healthy tick has always had.",
      "    await drainDeferredWrites(() => 50);",
      "    assert.equal(landedOf(db), 3);",
      "    assert.equal(writeDrainView().pending, 0);",
      '    assert.equal(writeDrainView().heldForTracker, 0, "nothing was held");',
      "",
      "    // (b) With only the tracker's reserve left, the batch is HELD — and held is",
      "    //     not failed: nothing lands, nothing is dropped, nothing is counted",
      "    //     against the durable write-drain error.",
      "    await runTick(db, 3);",
      "    const before = landedOf(db);",
      "    await drainDeferredWrites(() => DRAIN_TRACKER_RESERVE);",
      '    assert.equal(landedOf(db), before, "the tracker\'s slice is not spent");',
      "    const held = writeDrainView();",
      '    assert.equal(held.heldForTracker, 3, "the view names why the batch stopped");',
      '    assert.equal(held.pending, 3, "the entries stay queued");',
      '    assert.equal(held.failures, 0, "held is not failed");',
      '    assert.equal(held.lastError, null, "and it is not a write-drain error");',
      "",
      "    // (c) The next drain takes them once the allowance is back.",
      "    await drainDeferredWrites(() => 40);",
      "    assert.equal(landedOf(db), before + 3);",
      "    assert.equal(writeDrainView().pending, 0);",
      "    resetTickProbe();",
      "  });",
      "",
      '  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {',
    ),
  },
  // ── repairs: `pending` is the LAST drain's report, not the live queue ─────
  {
    file: "scripts/test-unit.js",
    what: "the queued length is read from the queue, not from the last drain",
    marker: 'deferredWriteCount(), 3, "it waits in the queue"',
    anchor: '    assert.equal(writeDrainView().pending, 3, "it waits in the queue");',
    replacement: '    assert.equal(deferredWriteCount(), 3, "it waits in the queue");',
  },
  {
    file: "scripts/test-unit.js",
    what: "and that helper is imported",
    marker: 'deferredWriteCount, DRAIN_TRACKER_RESERVE } = require("../dist/tickprobe.js");',
    anchor: '    const { installTickProbe, drainDeferredWrites, resetTickProbe, writeDrainView, DRAIN_TRACKER_RESERVE } = require("../dist/tickprobe.js");',
    replacement: '    const { installTickProbe, drainDeferredWrites, resetTickProbe, writeDrainView, deferredWriteCount, DRAIN_TRACKER_RESERVE } = require("../dist/tickprobe.js");',
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

{
  const file = "docs/round-trips.md";
  const text = bufferOf(file);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the drain floor is documented`);
  } else {
    buffers.set(file, `${text.trimEnd()}\n${DOC}\n`);
    console.log(`ok        ${file}: the drain floor is documented`);
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
