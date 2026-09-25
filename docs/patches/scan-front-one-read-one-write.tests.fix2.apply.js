#!/usr/bin/env node
/**
 * `scan-front-one-read-one-write.tests.fix2.apply.js` —— fix1 之後仲有兩個
 * **測試本身**嘅問題（唔係 src）：
 *
 *   1. fix1 擺咗個 DELETE 喺 `fdb.init()` **之前** —— 但 `Db.init()` 自己會跑
 *      launch_ms migration 同寫 `schema_alter_v2_done`（db.ts），所以 init
 *      一跑就喺條 row 上面再寫一次，測試 1 照樣讀到個 flag。DELETE 要擺喺
 *      init **之後**。
 *   2. fix1 嗰個 INSERT patch 冇 apply 到：佢個 marker
 *      `INSERT INTO token_stats (token, first_seen_at, first_m5_vol` 早就有
 *      另一個測試用咗，所以俾人當成「已應用」。改用一句獨有嘅 args line 做
 *      marker，順手補埋 `first_m5_vol`（NOT NULL）。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "scripts/test-unit.js";

const MOVE_ANCHOR = lines(
  "      // init() runs the launch_ms migration itself, so by now the flag EXISTS",
  "      // (db.ts's init). Remove it: this case is about a gate row that was never",
  "      // written, which has to stay absent from the map instead of being invented.",
  "      await t.client.execute({",
  "        sql: \"DELETE FROM worker_state WHERE key = 'schema_alter_v2_done'\",",
  "        args: [],",
  "      });",
  "      let reads = 0;",
  "      let writes = 0;",
  "      let executes = 0;",
  "      const counting = {",
  "        execute: (a) => { executes += 1; return t.client.execute(a); },",
  "        batch: (a, m) => { if (m === \"read\") reads += 1; else writes += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const fdb = new Db(t.p, undefined, counting);",
  "      await fdb.init();",
  "      reads = 0;",
  "      writes = 0;",
  "      executes = 0;",
  "      const front = await fdb.readScanFront(SCAN_FRONT_GATE_KEYS);",
);

const MOVE_NEW = lines(
  "      let reads = 0;",
  "      let writes = 0;",
  "      let executes = 0;",
  "      const counting = {",
  "        execute: (a) => { executes += 1; return t.client.execute(a); },",
  "        batch: (a, m) => { if (m === \"read\") reads += 1; else writes += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const fdb = new Db(t.p, undefined, counting);",
  "      await fdb.init();",
  "      reads = 0;",
  "      writes = 0;",
  "      executes = 0;",
  "      // ORDER MATTERS: Db.init() runs the launch_ms migration itself (db.ts),",
  "      // which WRITES schema_alter_v2_done on its way up. The row is deleted",
  "      // AFTER init — this case is about a gate that was never written, and it",
  "      // has to stay absent from the map instead of being invented by the reader.",
  "      await t.client.execute({",
  "        sql: \"DELETE FROM worker_state WHERE key = 'schema_alter_v2_done'\",",
  "        args: [],",
  "      });",
  "      const front = await fdb.readScanFront(SCAN_FRONT_GATE_KEYS);",
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
    what: "the absent-gate delete moves AFTER Db.init() (init writes that row)",
    marker: "      // ORDER MATTERS: Db.init() runs the launch_ms migration itself (db.ts),",
    anchor: MOVE_ANCHOR,
    replacement: MOVE_NEW,
  },
  {
    file: FILE,
    what: "the stale token_stats row fills its NOT NULL first_m5_vol",
    marker: "args: [\"OLD1\", now - 40 * 3_600_000, 0, 2400, now - 40 * 3_600_000],",
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
