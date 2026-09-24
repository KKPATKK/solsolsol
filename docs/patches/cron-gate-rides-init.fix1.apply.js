#!/usr/bin/env node
/**
 * Tests + record for cron-gate-rides-init.apply.js.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const TESTS = "scripts/test-unit.js";
const DOC = "docs/scan-completion-loss.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{file: string, label: string, old: string, next: string}>} */
const edits = [
  {
    file: TESTS,
    label: "test: import cronGateLoad",
    old:
      'const { scanRaceWindowMs, buildPreTickSplit, preTickView, PRE_TICK_ZERO_STEPS, SCAN_TICK_BUDGET_MS } = require("../dist/worker.js");',
    next:
      'const { scanRaceWindowMs, buildPreTickSplit, preTickView, PRE_TICK_ZERO_STEPS, SCAN_TICK_BUDGET_MS, cronGateLoad } = require("../dist/worker.js");',
  },
  {
    file: TESTS,
    label: "test: the front read plan is pinned",
    old:
      '  await test("worker: the pre-init stamp fires only for an arrival whose predecessor never returned", () => {',
    next: L(
      '  await test("worker: the cron gate reads nothing when init already fetched its keys", () => {',
      "    // The merge this pins: ensureInitialized's ONE statement fetches the",
      "    // heartbeat AND the cron-arrival keys, so a normal cron tick's gate has",
      "    // nothing left to read — no round trip, i.e. no subrequest out of the",
      "    // invocation's 50 and ~190ms of front path back (live 2026-09-24:",
      "    // `init 187 gate 189 claim 245`).",
      '    assert.deepEqual(cronGateLoad(true, true), [], "both caches warm ⇒ the gate reads nothing");',
      '    assert.deepEqual(cronGateLoad(false, true), ["scan_heartbeat"], "a stale heartbeat is the gate to fetch");',
      "    assert.deepEqual(",
      "      cronGateLoad(true, false),",
      '      ["scheduled_tick_total", "scheduled_tick_ring"],',
      '      "no captured cron keys ⇒ it fetches exactly those",',
      "    );",
      "    assert.deepEqual(",
      "      cronGateLoad(false, false),",
      '      ["scan_heartbeat", "scheduled_tick_total", "scheduled_tick_ring"],',
      '      "nothing captured ⇒ the old three-key read, unchanged",',
      "    );",
      "  });",
      "",
      '  await test("worker: the pre-init stamp fires only for an arrival whose predecessor never returned", () => {',
    ),
  },
  {
    file: DOC,
    label: "doc: the init+gate merge is done (pending deploy)",
    old: L(
      "- **未做**：`init`（~187ms）＋ 首 tick 嘅 gate read（~189ms）可以合併（兩者都係第一次 DB 接觸），",
      "  再加 `claim` 嗰個 round trip（live 191–279ms，抖動時 1.1–1.2s）—— 前置仲有 **~0.38s** 可以收。",
    ),
    next: L(
      "- ✅ **已改（`cron-gate-rides-init`，未上線）**：`ensureInitialized` 嗰**一次**讀而家帶埋",
      "  cron-arrival 兩個 key（`scheduled_tick_total` / `scheduled_tick_ring`），所以 cadence gate",
      "  正常情況**唔使讀**（`cronGateLoad` 回傳空 list）。仍然係**一個** subrequest（三個 key 同一句",
      "  SQL），但收回 **~190ms** 前置 wall clock。`lastCronKeysRead` 係 `null`（讀超時）時 gate 自己",
      "  讀返 —— 唔會將「超時」當成「ring 係空」，否則 claim batch 會寫一條 ring 落去而丟咗歷史。",
      "  **上線後要讀**：cron tick 嘅 `preTick.steps.gate` 由 189ms 落到 **~0**（同 `bump 0` 一樣），",
      "  而 `scheduled_tick_at` / `scheduled_tick_ring` 照樣每分鐘前進。",
      "- **仍未做**：`claim` 嗰個 round trip（live 191–279ms，抖動時 1.1–1.2s）—— 前置仲有 ~0.25s。",
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
