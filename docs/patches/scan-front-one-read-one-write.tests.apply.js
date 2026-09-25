#!/usr/bin/env node
/**
 * `scan-front-one-read-one-write.apply.js` 嘅測試（docs/round-trips.md §4.13）。
 *
 * 兩個測試都驅動**真**函數 + 一個數 round trip 嘅 libsql client（同 §4.12 嘅
 * tail 測試同一套 harness）：
 *
 *   1. **front 係一個讀**：`Db.readScanFront` 一個 `batch("read")` 就攞齊
 *      enabled chats 同三條 gate row；之後 `pruneOldTokenStats(front)` 同
 *      `resumeLaunchBackfill(front)` 都**唔會**再讀；佢哋排隊嘅 bookkeeping
 *      由 `Db.writeScanFront` 一次寫落地。
 *   2. **到期嘅 prune**：deletes 照跑，但 counter（ADD）同 interval stamp 都
 *      入 front 嘅同一個 batch —— 以前係兩條獨立寫；空 buffer 唔算一個 request。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "scripts/test-unit.js";

const IMPORT_OLD =
  "const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS } = require(\"../dist/db.js\");";

const IMPORT_NEW =
  "const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS } = require(\"../dist/db.js\");";

const ANCHOR = "  console.log(\"\\n===== UNIT TESTS =====\");";

const TESTS = lines(
  "  // ---------- the scan front: ONE read, ONE write (src/db.ts + src/scanner.ts) ----------",
  "  //",
  "  // §4.11's measurement: a tick's Turso is ~20 DISTINCT one-shot statements, not",
  "  // one fat loop. §4.12 took the tail (six round trips -> two). The front's own",
  "  // maintenance legs were the rest of it: the enabled-chats listing, the",
  "  // launch_ms migration's completion flag, the token_stats prune's interval stamp",
  "  // and the Birdeye backfill's stamp were FOUR single-row lookups paid on EVERY",
  "  // tick, for one `worker_state` read with a chat row beside it. These two cases",
  "  // drive the real methods against a counting client.",
  "  await test(\"scanner: the scan front is ONE read, and its legs pay no reads of their own\", async () => {",
  "    const t = tmpDb();",
  "    const now = Date.now();",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.saveChatSettings({ chatId: \"c\", ...DEFAULT_SETTINGS, enabled: true });",
  "      await db.saveChatSettings({ chatId: \"d\", ...DEFAULT_SETTINGS, enabled: true });",
  "      await db.saveChatSettings({ chatId: \"off\", ...DEFAULT_SETTINGS, enabled: false });",
  "      // Two gates whose interval has NOT elapsed, so their legs return without",
  "      // touching the database at all — which is what makes the read count below",
  "      // the front's own. `schema_alter_v2_done` is deliberately ABSENT: a row",
  "      // that was never written has to stay indistinguishable from one that is",
  "      // not there, not from a read that did not happen.",
  "      await db.setWorkerState(\"token_stats_last_prune\", String(now));",
  "      await db.setWorkerState(\"birdeye_backfill_at\", String(now));",
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
  "      assert.equal(reads, 1, \"the whole front read is ONE request\");",
  "      assert.equal(executes, 0, \"...and one batch, not an execute\");",
  "      assert.equal(front.chats.length, 2, \"only the enabled chats come back\");",
  "      assert.equal(front.gates.get(\"token_stats_last_prune\"), String(now));",
  "      assert.ok(",
  "        !front.gates.has(\"schema_alter_v2_done\"),",
  "        \"a row that was never written is absent from the map, not invented\",",
  "      );",
  "      assert.equal(front.writes.length, 0, \"nothing is written until the front is flushed\");",
  "      // The prune's interval gate: not due, so no DELETE and — the point — no",
  "      // read of its own.",
  "      assert.equal(await fdb.pruneOldTokenStats(now - 60_000, front), 0);",
  "      assert.equal(reads, 1, \"the prune's gate rode the front's read\");",
  "      assert.equal(executes, 0, \"a prune that is not due costs nothing at all\");",
  "      // The launch_ms migration: the flag is absent, so this is the one tick",
  "      // that runs it. On an empty token_stats the first chunk collects nothing,",
  "      // which is the migration's own completion condition.",
  "      assert.equal(await fdb.resumeLaunchBackfill(4_000, front), true);",
  "      assert.equal(reads, 1, \"the resume's gate rode the front's read too\");",
  "      assert.deepEqual(",
  "        front.writes.map((w) => w.key),",
  "        [\"schema_alter_v2_done\"],",
  "        \"its completion flag is queued on the front, not written on its own\",",
  "      );",
  "      assert.equal(writes, 0, \"...so nothing has been written yet\");",
  "      await fdb.writeScanFront(front.writes);",
  "      assert.equal(writes, 1, \"the front's bookkeeping lands in ONE write\");",
  "      assert.equal(await fdb.getWorkerState(\"schema_alter_v2_done\"), \"1\");",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
  "  await test(\"scanner: a due prune rides the front's ONE write, counter and stamp together\", async () => {",
  "    const t = tmpDb();",
  "    const now = Date.now();",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.saveChatSettings({ chatId: \"c\", ...DEFAULT_SETTINGS, enabled: true });",
  "      await db.setWorkerState(\"token_stats_last_prune\", \"1\"); // long overdue",
  "      await db.setWorkerState(\"telemetry_token_stats_count\", \"10\");",
  "      // One stale, never-pushed row: older than the re-eval window and absent",
  "      // from seen_tokens, which is exactly what the prune may delete.",
  "      await t.client.execute({",
  "        sql: \"INSERT INTO token_stats (token, first_seen_at, first_seen_age_min, launch_ms) VALUES (?, ?, ?, ?)\",",
  "        args: [\"OLD1\", now - 40 * 3_600_000, 2400, now - 40 * 3_600_000],",
  "      });",
  "      let reads = 0;",
  "      let writes = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => { if (m === \"read\") reads += 1; else writes += 1; return t.client.batch(a, m); },",
  "        close: () => t.client.close(),",
  "      };",
  "      const fdb = new Db(t.p, undefined, counting);",
  "      await fdb.init();",
  "      reads = 0;",
  "      writes = 0;",
  "      const front = await fdb.readScanFront(SCAN_FRONT_GATE_KEYS);",
  "      assert.equal(reads, 1, \"the front read is one request\");",
  "      reads = 0;",
  "      // The re-eval window is the prune's cutoff in production (scanner's",
  "      // RE_EVAL_WINDOW_MS = 30h), which the stale row above is past.",
  "      const deleted = await fdb.pruneOldTokenStats(now - 30 * 60 * 60_000, front);",
  "      assert.ok(deleted >= 1, \"the due prune deleted the stale row\");",
  "      assert.equal(reads, 0, \"...without a read of its own: the gate was in the front\");",
  "      assert.deepEqual(",
  "        front.writes.map((w) => w.key),",
  "        [\"telemetry_token_stats_count\", \"token_stats_last_prune\"],",
  "        \"both bookkeeping rows are queued on the front\",",
  "      );",
  "      assert.equal(front.writes[0].add, true, \"the counter is an ADD, never an overwrite\");",
  "      assert.equal(writes, 0, \"nothing written yet\");",
  "      await fdb.writeScanFront(front.writes);",
  "      assert.equal(writes, 1, \"counter + stamp land in ONE write, not two\");",
  "      assert.equal(",
  "        Number(await fdb.getWorkerState(\"telemetry_token_stats_count\")),",
  "        10 - deleted,",
  "        \"the counter moved by exactly what was deleted\",",
  "      );",
  "      assert.ok(Number(await fdb.getWorkerState(\"token_stats_last_prune\")) > 0);",
  "      await fdb.writeScanFront([]);",
  "      assert.equal(writes, 1, \"an empty buffer is not a request at all\");",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
  ANCHOR,
);

const PATCHES = [
  {
    file: FILE,
    what: "the front's gate key set comes from dist/db.js",
    marker: "DB_REQUEST_TIMEOUT_MS, SCAN_FRONT_GATE_KEYS }",
    anchor: IMPORT_OLD,
    replacement: IMPORT_NEW,
  },
  {
    file: FILE,
    what: "the two front cases (round-trip counting)",
    marker: "scanner: the scan front is ONE read, and its legs pay no reads of their own",
    anchor: ANCHOR,
    replacement: TESTS,
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
