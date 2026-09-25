#!/usr/bin/env node
/**
 * `docs/round-trips.md` §4.13：scan 嘅 front 一個讀 + 一個寫（2026-09-25）。
 * 順手把 §4.11 嗰句「下一步（已做，見 §4.12）」補上第二刀。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "docs/round-trips.md";

const NEXT_STEP_OLD = lines(
  "**下一步（已做，見 §4.12）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped",
  "telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同",
  "「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。",
);

const NEXT_STEP_NEW = lines(
  "**下一步（已做，見 §4.12）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped",
  "telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同",
  "「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。",
  "",
  "**再下一步（已做，見 §4.13）**：front 階段同一招 —— 三條 maintenance gate row",
  "（`schema_alter_v2_done` / `token_stats_last_prune` / `birdeye_backfill_at`）同",
  "enabled chats，四個 round trip 收成一個讀；佢哋嘅 bookkeeping 收成一個 batch 寫。",
);

const SECTION = lines(
  "---",
  "",
  "## 4.13 scan 嘅 front：一個讀 + 一個寫（2026-09-25）",
  "",
  "§4.11 留低嘅第二刀（第一刀係 §4.12 嘅 tail）：**front 階段嘅一次性 state op**。",
  "",
  "**之前**（每個 tick 都係咁，唔理有冇嘢做）",
  "",
  "| # | 動作 | round trip |",
  "|---|---|---|",
  "| 1 | `listEnabledChats()`（scan 嘅第一個讀） | 1 讀 |",
  "| 2 | `resumeLaunchBackfill` → `getWorkerState(schema_alter_v2_done)` | 1 讀（migration 完成之前） |",
  "| 3 | `pruneOldTokenStats` → `getWorkerState(token_stats_last_prune)` | 1 讀（**每 tick**，就算唔到期） |",
  "| 4 | `runPeriodicBackfill` → `getWorkerState(birdeye_backfill_at)` | 1 讀（**每 tick**） |",
  "| 5 | 到期嘅 prune：counter bump ＋ interval stamp | 最多 2 寫 |",
  "",
  "四條讀全部係「一條 `worker_state` row ＋ 隔籬一個 chat listing」——同一條 `batch()`",
  "可以一次做完，同 §4.12 一模一樣嘅形狀。",
  "",
  "**現在**",
  "",
  "- `Db.readScanFront(SCAN_FRONT_GATE_KEYS)`：**一個** `batch([stateRows, chats], \"read\")`。",
  "  key set 由 caller 決定（`SCAN_FRONT_GATE_KEYS` = `schema_alter_v2_done` /",
  "  `token_stats_last_prune` / `birdeye_backfill_at`），chats 半邊係逐字",
  "  `SELECT * FROM chat_settings WHERE enabled = 1`，`mapRow` 亦係同一個。",
  "- `Db.writeScanFront(entries)`：front 嘅 bookkeeping 一個 batch。`add: true` 嘅 entry",
  "  用 `bumpTelemetryCounter` **逐字一樣**嘅 SQL（`CAST(value AS INTEGER) + excluded.value`），",
  "  delta 0 唔入 batch（同以前 delta 0 唔寫一樣）。",
  "- 三條腿改成食 pre-read：`Db.gateOf(front, key)`（db 內部）／",
  "  `Scanner.stampFront(key, value)`（scanner 內部）。**冇 front 嘅 caller**（command handler、",
  "  diagnostic、test）行為完全不變 —— 仍然自己讀自己寫。",
  "- `Scanner.flushScanFront()` 喺 pool 階段之後叫一次（正常路徑），scan 嘅 `finally`",
  "  再叫一次（提早 return 嘅路徑：subrequest floor cut、stop check、空 pool）。buffer 空就係",
  "  no-op，所以唔會多一個 request。",
  "",
  "**保留嘅紀律**",
  "",
  "- **「absent」唔等於「冇讀過」**：gate row 唔喺 map 入面 = 條 row 從未寫過，係一個",
  "  **讀數**。所以 `gateOf` 同 scanner 嗰句 inline lookup 都係 `get() ?? null`，冇 fallback",
  "  re-read —— 一個唔存在嘅 flag 唔可以因為「順手」而變成一次多餘嘅 round trip，",
  "  亦唔可以變成「假設佢存在」。",
  "- **被拒嘅 batch = 全部冇寫**：每一條 row 都係「呢個 maintenance job 上次幾時跑」，",
  "  下個 tick 由頭推導，所以 flush 只 log 唔 throw —— scan 唔會因為 bookkeeping 而失敗。",
  "  buffer 喺寫之前清空，所以一個被拒嘅 counter 唔會加兩次。",
  "- chats 半邊嘅 projection／ORDER／`mapRow` 完全唔變，所以 pool bounds 用嘅係同一組",
  "  chats row。",
  "",
  "**價錢**：冇。四個讀 ＋ 最多兩個寫 → **一個讀 ＋ 最多一個寫**。以前 idle tick 嘅",
  "15–16 個 Turso statement 裡面，呢四條固定出現嘅 gate 讀冇咗三個。",
  "",
  "**量度**：`heartbeat.summary.dbTickSteps`（scan window 嘅 census）同 `dbSteps`",
  "（cumulative per isolate）—— `readScanFront` 係 census 一分了（`src/tickprobe.ts`），所以",
  "**before** 係 `getWorkerState` ×2–3 ＋ `listEnabledChats` 1，**after** 係",
  "`readScanFront` **1** ＋ `listEnabledChats` **0** ＋（有 bookkeeping 嗰個 tick）",
  "`writeScanFront` **1**。",
  "",
  "**測試**（`scripts/test-unit.js`，兩個都數真 client 嘅 round trip）：",
  "`scanner: the scan front is ONE read, and its legs pay no reads of their own`（front read =",
  "1 個 read batch、0 個 execute；absent 嘅 gate row 唔會出現喺 map；prune 唔到期 ⇒ 0 個新 request；",
  "resume 嘅完成旗係**排隊**而唔係自己寫；`writeScanFront` = 1 個 write）同",
  "`scanner: a due prune rides the front's ONE write, counter and stamp together`",
  "（到期 prune：deletes 照跑、讀數 0；counter（ADD）＋ interval stamp 入同一個 batch，",
  "counter 剛好減咗 deleted；空 buffer 唔算一個 request）。",
);

const PATCHES = [
  {
    file: FILE,
    what: "§4.11's next step is marked done twice over",
    marker: "**再下一步（已做，見 §4.13）**",
    anchor: NEXT_STEP_OLD,
    replacement: NEXT_STEP_NEW,
  },
];

const SECTION_MARKER = "## 4.13 scan 嘅 front：一個讀 + 一個寫";

// §4.13 goes at the END of the file: append rather than anchor on the last
// paragraph (which the previous section owns and may be edited later).
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
if (bufferOf(FILE).includes(SECTION_MARKER)) {
  console.log(`already   ${FILE}: §4.13`);
} else {
  const text = bufferOf(FILE);
  buffers.set(FILE, `${text.replace(/\n+$/, "\n")}\n${SECTION}\n`);
  console.log(`ok        ${FILE}: §4.13 appended`);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
