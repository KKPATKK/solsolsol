#!/usr/bin/env node
/**
 * `scan-front-one-read-one-write.tests.apply.js` 嘅收尾 —— 兩個**測試本身**嘅
 * 問題（唔係 src 嘅問題）：
 *
 *   1. `Db.init()` 自己會跑 launch_ms migration 同寫 `schema_alter_v2_done`
 *      （db.ts 嘅 SQL `schema_alter_v2_done` 判斷 ＋ `resumeLaunchBackfill`）。
 *      所以測試 1 想驗「absent row 唔會被發明出嚟」就要先**刪**咗佢 —— 唔係
 *      佢唔存在，而係 init 幫我哋寫咗。
 *   2. raw INSERT 入 `token_stats` 要填所有 NOT NULL 欄（`first_m5_vol`）。
 *      （正常路徑係 `recordTokenStatsMany`，但呢個測試想直接擺一條 stale row。）
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "scripts/test-unit.js";

const DELETE_ANCHOR = lines(
  "      await db.setWorkerState(\"token_stats_last_prune\", String(now));",
  "      await db.setWorkerState(\"birdeye_backfill_at\", String(now));",
);

const DELETE_NEW = lines(
  "      await db.setWorkerState(\"token_stats_last_prune\", String(now));",
  "      await db.setWorkerState(\"birdeye_backfill_at\", String(now));",
  "      // init() runs the launch_ms migration itself, so by now the flag EXISTS",
  "      // (db.ts's init). Remove it: this case is about a gate row that was never",
  "      // written, which has to stay absent from the map instead of being invented.",
  "      await t.client.execute({",
  "        sql: \"DELETE FROM worker_state WHERE key = 'schema_alter_v2_done'\",",
  "        args: [],",
  "      });",
);

const INSERT_ANCHOR = lines(
  "        sql: \"INSERT INTO token_stats (token, first_seen_at, first_seen_age_min, launch_ms) VALUES (?, ?, ?, ?)\",",
  "        args: [\"OLD1\", now - 40 * 3_600_000, 2400, now - 40 * 3_600_000],",
);

const INSERT_NEW = lines(
  "        sql: \"INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms) VALUES (?, ?, ?, ?, ?)\",",
  "        args: [\"OLD1\", now - 40 * 3_600_000, 0, 2400, now - 40 * 3_600_000],",
);

const PATCHES = [
  {
    file: FILE,
    what: "the absent-gate case deletes the row init wrote for it",
    marker: "sql: \"DELETE FROM worker_state WHERE key = 'schema_alter_v2_done'\",",
    anchor: DELETE_ANCHOR,
    replacement: DELETE_NEW,
  },
  {
    file: FILE,
    what: "the stale token_stats row fills every NOT NULL column",
    marker: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol",
    anchor: INSERT_ANCHOR,
    replacement: INSERT_NEW,
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
