#!/usr/bin/env node
/**
 * Round 3 doc pointer: appends §4.21 to docs/round-trips.md. The file is far
 * past the file tool's edit window, so this is an append with an idempotency
 * check (the section heading) instead of an anchor replacement.
 *
 * Run: node docs/patches/round3-doc-pointer-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "docs/round-trips.md");
const src = fs.readFileSync(file, "utf8");

const SECTION = `
---

## 4.21 Round 3：admission stamp 騎上 scan-lock claim（2026-09-26）

§4.20 留低嘅 labelled census 今次點名咗排頭嗰個：**\`setWorkerState:tick_progress\` 每 tick 5 個
request**（phase ladder：admission ＋ front／pair／gate ＋ postscan），係 ~21-request tick 裡最大
嘅單一 DB 項。但 ladder 嘅第一個 stamp——「tick 被接納、仲未入 scan」——claim batch 本身已經寫住：
同一個 batch 內嘅 heartbeat upsert 就係 \`{at: startedAt, phase: "scanning"}\`，同一個 \`at\`。
所以 admission stamp **騎上 claim batch**（\`Db.claimScanLock\` 第 7 個參數 \`tickProgressJson\`）：
每 tick 少一個 request，而且 admission 讀數同 claim 原子一齊落，唔會再有「贏咗 claim、stamp 未到」
嘅窗。

守衛同 historyStmt 一樣嘅 EXISTS 慣用法——\`INSERT..SELECT\` 嘅 \`WHERE EXISTS (… key =
'scan_lock' AND value = ?)\` 帶住**本 tick 自己嘅 lock value**，所以輸咗 lease（= 冇入 scan）嘅 tick
唔可能 stamp 一個佢冇行到嘅 phase；claim batch 被拒 = stamp 跟住冇，即 pre-merge 形狀。claim 三條
arm（win／row-vanished retry／stale-holder takeover）都收呢個 stamp，\`winBatch\` 嘅空檢查亦加咗
\`progressStmt\`，令「只有 stamp」嘅 claim 一樣行 batch 路徑。另外 \`tickProgressNote\` 對未量度嘅
preRace（admission record 係 claim 之前建嘅，pre-race split 未存在）改印 \`preRace n/a\`，唔會扮
成一個唔使時間嘅 phase。

本地驗收：\`npm run typecheck\` clean、\`npm run test:unit\` **354 passed / 0 failed**（前值 353；
\`tick-progress-record.apply.js\` 嘅 guard 由 pin \`notePhase("scan")\` 改為 pin「record 喺 claim
前建好並傳入 claim」，新增一條 round-3 out-of-window guard），\`npx wrangler deploy --dry-run\` 過。
落線後驗收：census 嘅 \`setWorkerState:tick_progress\` 應由 5 → 4／tick，\`tick_progress\` 行嘅
\`at\` 同 \`scan_heartbeat\` 嘅 \`at\` 差 < 10ms。

全部細節：\`docs/round3-admission-stamp-2026-09-26.md\`；落線紀錄：
\`docs/patches/round3-admission-stamp-2026-09-26.apply.js\` ＋
\`docs/patches/round3-admission-stamp-tests-2026-09-26.apply.js\` ＋
\`docs/patches/round3-doc-pointer-2026-09-26.apply.js\`。
`;

if (src.includes("## 4.21 Round 3")) {
  console.log("skip docs/round-trips.md: §4.21 already present");
} else {
  fs.appendFileSync(file, SECTION);
  console.log(`wrote docs/round-trips.md (appended §4.21, ${SECTION.length} bytes)`);
}
