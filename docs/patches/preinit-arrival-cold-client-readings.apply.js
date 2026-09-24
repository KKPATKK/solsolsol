#!/usr/bin/env node
/**
 * Record the live proof that the cold-isolate fix works (2026-09-24).
 *
 * The reading is the point: `edbd57d` shipped the stamp and the cold isolate
 * never stamped once, while `a9711fd` (connect() instead of get()) stamped on
 * the FIRST cron arrival of a fresh isolate and then stayed quiet — both halves
 * of the design, observed rather than assumed. Chasing the pre-fix reading is
 * what produced §4.5.3.1, so the pair belongs in the section together.
 *
 * Same discipline as every other record script here (see the file's own §6):
 * verify each anchor matches EXACTLY ONCE, write nothing unless all do, and
 * stay re-runnable (an edit already present is reported ALREADY).
 *
 * Run: node docs/patches/preinit-arrival-cold-client-readings.apply.js
 */
const fs = require("fs");
const path = require("path");

const T = path.join(__dirname, "..", "round-trips.md");
const lines = (...xs) => xs.join("\n");

// --------------------------------------------------- §4.5.3.1 readings ------
const VERIFY_ANCHOR = lines(
  "**落線點驗**（deploy 後第一個鐘）：",
  "",
  "0. **cold isolate 一定要 stamp 一次**：deploy 之後任何一個 isolate 都係新嘅 ⇒ 佢收到嘅第一個 cron",
);
const VERIFY_NEXT = lines(
  "**落線讀數**（2026-09-24；`edbd57d` 見到 stamp 冇開火 → `a9711fd` 修好後驗證）：",
  "",
  "* **修之前**（01:43–01:51Z，`edbd57d`）：`scheduledTickAt` 每分鐘 :02 前進、ring 最新一格 01:51:05、",
  "  scan row 照落，但 `scheduledArrivalTotal` **一直係 null**（＝cold isolate 一次都冇 stamp 成功）——",
  "  就係 §4.5.3.1 嗰個診斷。**呢個係「沉默即健康」儀器最危險嘅一刻**：個 key 冇出現，睇落好似",
  "  「冇事發生」，實際上係儀器死咗。",
  "* **修之後**（`a9711fd` deploy 完成後，02:00–02:01Z）：`scheduledArrivalTotal` = **1**、",
  "  `scheduledArrivalAt` = **01:59:02.941Z** —— 即係 deploy 後**第一個** cron arrival（新 isolate 嘅",
  "  flag 係 0 ⇒ 必定 stamp）—— 之後 tick 繼續每分鐘照行（`scheduledTickAt` 02:00:02.887Z）而個 counter",
  "  **停在 1**。兩個設計目標（cold isolate stamp 一次／warm isolate 零成本）**同時**照住預期出現。",
  "  `scheduledArrivalUnaccounted` = false（`arrivalAt` 01:59:02 ≤ `tickAt` 02:00:02 ⇒ 最新投遞自己入咗賬）。",
  "* **落線點驗第 0 點已證**：deploy 之後個數字**開得著**，所以之後「唔動」先至真係代表「健康」。",
  "",
  "**落線點驗**（deploy 後第一個鐘）：",
  "",
  "0. **cold isolate 一定要 stamp 一次**：deploy 之後任何一個 isolate 都係新嘅 ⇒ 佢收到嘅第一個 cron",
);

// --------------------------------------------------- §5 verification list ---
const COUNT_ANCHOR = lines(
  "* `node scripts/test-deferred-priority.js` ✅、`node scripts/test-tick-path.js` ✅",
  "* push `bba1312` → Deploy Worker to Cloudflare **success**（1m9s）✅；`21521eb`（§4.2 row loop）",
);
const COUNT_NEXT = lines(
  "* `node scripts/test-deferred-priority.js` ✅、`node scripts/test-tick-path.js` ✅",
  "* `edbd57d`（§4.5.3 pre-init arrival stamp）→ Deploy Worker run 35944044690 **success** ✅；",
  "  `a9711fd`（§4.5.3.1 cold-handle fix）→ run 35945163059 **success** ✅（落線讀數見 §4.5.3.1）",
  "* push `bba1312` → Deploy Worker to Cloudflare **success**（1m9s）✅；`21521eb`（§4.2 row loop）",
);

const JOBS = [
  {
    label: "§4.5.3.1 live readings",
    done: "**落線讀數**（2026-09-24；`edbd57d` 見到 stamp 冇開火",
    anchor: VERIFY_ANCHOR,
    next: VERIFY_NEXT,
  },
  {
    label: "§5 deploy runs",
    done: "`a9711fd`（§4.5.3.1 cold-handle fix）",
    anchor: COUNT_ANCHOR,
    next: COUNT_NEXT,
  },
];

const text = fs.readFileSync(T, "utf8");

// Pass 1: verify every pending anchor is present exactly once.
let failed = false;
const pending = [];
for (const job of JOBS) {
  if (text.includes(job.done)) {
    console.log(`ALREADY   ${job.label}`);
    continue;
  }
  const at = text.indexOf(job.anchor);
  if (at < 0) {
    console.error(`MISS      ${job.label}`);
    failed = true;
    continue;
  }
  if (text.indexOf(job.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${job.label}`);
    failed = true;
    continue;
  }
  pending.push(job);
}
if (failed) process.exit(1);
if (pending.length === 0) {
  console.log("ok        the cold-isolate reading is already recorded");
  process.exit(0);
}

// Pass 2: write.
let out = text;
for (const job of pending) {
  out = out.replace(job.anchor, job.next);
  console.log(`ok        ${job.label}`);
}
fs.writeFileSync(T, out);
console.log(`ok        ${pending.length} insertions written to docs/round-trips.md`);
