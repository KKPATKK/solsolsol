#!/usr/bin/env node
/*
 * Docs for docs/patches/scan-trigger-via-2026-09-27.apply.js:
 *  - docs/round-trips.md §4.40 (the measurement, the three changes, the tests,
 *    the mutations and the live acceptance points);
 *  - docs/uptime-monitor.md: the monitor ping is a rescue, not a driver;
 *  - wrangler.toml: what SCAN_INTERVAL_SECONDS now means (completion + jitter
 *    budget) and how the fallback's two-cadence rescue reads against it.
 *
 * Run: node docs/patches/scan-trigger-via-doc-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const notes = [];

function edit(file, name, find, next, marker) {
  const p = path.join(root, file);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  src = src.replace(find, next);
  fs.writeFileSync(p, src);
  notes.push(` ✓ ${name} — patched`);
}

// ---------------------------------------------------------------------------
// 1. round-trips §4.40 — appended after §4.39.
// ---------------------------------------------------------------------------
const section = [
  "",
  "### §4.40 掃描係邊個跑：fallback 60s 太早、gate margin 太窄、`via` 要落地（2026-09-27）",
  "",
  "**起點係一個我自己報錯咗嘅歸因。** §4.39 用 window owner 讀到 `[http] 21`（一個 HTTP fallback 真正掃描），",
  "當時寫住「dedupe 用 `scan_heartbeat.at`（scan 開始時間）」。做完 cron ring 對照之後要更正兩樣：",
  "",
  "- `scan_heartbeat.at` 係**完成時間** —— completion flush 用 `flushedAt` 覆寫咗 claim batch 嘅 start stamp",
  "  （live 見到 claim `05:14:06` → done `05:14:09`）。",
  "- 真正嘅驅動係**派送遲**：兩個 gate 用唔同 margin 打對台 ——",
  "",
  "```",
  "tick 完成遲 (:2x) → 下一個 tick 讀 age ~35-45s < gate 50s → skip（照樣付 init／gate／outage 嘅 front）",
  "→ 之後任何一個過咗自己 60s trigger gate 嘅 HTTP 請求見到 age ≥ 60s → fallback 真掃描（http window）",
  "→ 佢一完成，又令下一個 tick skip → 循環",
  "```",
  "",
  "**量度（05:13-05:30Z，唯讀）。** `scheduled_tick_ring`（handler entry，每分鐘一個，`cronAt = Date.now()`）",
  "對照 `scan_history`：ring 嘅 90 分鐘窗口內 76 個 completion，**26 個（34%）對唔上任何 cron arrival** ——",
  "12 個喺 arrival 之前完成（一定係 fallback），14 個喺 arrival 之後 12-21 秒（一個 tick 嘅 front 唔可能咁長；",
  "05:27:27 嗰個 completion 嘅 `subreqs.current.owner` 讀 `\"http\"`、total 21，最接近嘅 arrival 離 race start 19 秒）。",
  "全期 300 個 completion／347 分鐘（0.86/min）入面 45 個 gap 係 90-120s 嘅洞，而每個 :2x 完成後面就跟一個。",
  "ring 亦顯示 90 個 arrival 有 18 個 ≥ :10（最遲 :29）——即係舊嘅 10s margin 根本唔夠。",
  "",
  "**三樣改動：**",
  "",
  "1. **Fallback 變真救援。** `scanRescueGapMs(scanGapMs) = max(120s, 2 × interval)`：要**兩個 cadence** 冇完成，",
  "   一個 HTTP 請求才准自己掃。遲到 <1 cadence 嘅 tick 仍然係佢自己掃，fallback 只喺嗰樣都失敗之後接手；",
  "   舊嘅 60s 門檻正正落喺「late tick 仍然擁有」嘅窗入面。",
  "2. **Tick gate 用 jitter budget。** `scanGateMs(interval)`：",
  "   - interval ＝一個 cron period（60s）⇒ gate ＝ **30s**（ring 量到最遲 :29）。一個遲完成嘅掃描唔再令",
  "     下一個 tick 白白輸一分鐘 —— 佢會 catch up（同一個 scan lock 之下，唔會疊住跑）。",
  "   - interval > 一個 cron period ⇒ margin 縮到「一個 period 以上剩幾多 room」：90s ⇒ gate **70s**，仍然",
  "     skip 隔個 tick（唔會靜靜哋變成 60s）。overlap 由 scan lock 負責，唔係 gate。",
  "3. **`via` 落地（`cron`｜`http`｜`manual`）。** 由 handler **參數**傳入 —— 唔可以係 module state：pass 嘅",
  "   delivery 同一個 isolate 會覆寫 module 讀數（今次已經見到 tick 嘅 flush 出 `owner:\"pass\"`）。寫入**兩個**",
  "   heartbeat（scanning ＋ done）同 completion payload；completion batch 內加一條 read-free counter statement",
  "   （`scan_trigger_cron`／`_http`／`_manual`：`INSERT OR IGNORE` ＋ `CAST(CAST(value AS INTEGER) + 1 AS TEXT)`），",
  "   **零額外 round trip**。front statement（`WEDGE_READ_KEYS`）帶埋三條 key ⇒ `/health.heartbeat.scanTriggers`",
  "   ＝ `{cron, http, manual}`（滯後一次完成，同 `deferral` 一樣嘅「上次確認寫入」語意）。",
  "",
  "**測試（4 條新 ＋ 2 條改）：** `scanGateMs(60_000) === 30_000`、`scanGateMs(90_000) === 70_000`（且 > 60s）、",
  "`scanGateMs(300_000) === 270_000`、`scanGateMs(1_000) === scanGateMs(60_000)`；`scanRescueGapMs(60_000) === 120_000`、",
  "`(90_000) === 180_000`、`(300_000) === 600_000`；三個 call site 嘅 `via`（whitespace-flattened source pin）＋",
  "`via:scanVia,` 出現 2 次；`scanTriggerStatements`（2 條 statement、逐個 trigger 一條 row、零 bind）＋",
  "`parseScanTriggerCounts`（null／junk／負數 ⇒ 0）；真 DB：完成掃描計數、heartbeat-only flush 唔計、",
  "冇 tag 唔計、`scanTriggers` 三條 key 讀返嚟啱、heartbeat 記住 `via`。舊 pin 改成 `now-at<rescueGapMs`。",
  "",
  "**Mutation（改編譯後 dist 再還原）：** counter `+ 1` → `+ 0` ⇒ 2 條 fail；`scanGateMs` 嘅 60s 分支改返",
  "`interval - 10s` ⇒ 1 條 fail；`scanRescueGapMs` 由 `× 2` 改 `× 1` ⇒ 1 條 fail。",
  "",
  "**本地驗證：** `npx tsc --noEmit` 清（途中撞到 `*/` 喺 JSDoc 裡面提早收 comment —— `TRACKER_CRON` 嘅",
  "expression 唔可以照抄入註釋）；`node scripts/test-unit.js` ＝ **379 passed / 0 failed**；其餘 6 個 suite 全綠；",
  "`npx wrangler deploy --dry-run` OK。",
  "",
  "**驗收點（live，deploy 之後）：**",
  "",
  "1. `/health.heartbeat.scanTriggers` 開始有數：`cron` 隨每分鐘升，`http` 唔應該再每三分鐘追一次。",
  "2. `scan_history` 對 cron ring：對唔上 arrival 嘅 completion 應該由 26/76 跌到接近 0；90-120s 洞（45/299）",
  "   應該同步跌，因為前一分鐘遲完成唔再令下一個 tick 輸一分鐘。",
  "3. `/health.heartbeat.via` 喺 done 行應該讀 `\"cron\"`。",
  "4. 出卡／defer 讀數不變：`push_watch_pass` 照樣 `via:\"cron-pass\"`、`defer-send 0`、`issueCount 0`。",
  "",
  "**落線紀錄：** `docs/patches/scan-trigger-via-2026-09-27.apply.js`（22 個 edit：db ＋ worker）、",
  "`docs/patches/scan-trigger-via-tests-2026-09-27.apply.js`（＋ `-test-fixes`、`-title-fix`）；",
  "`src/db.ts`（`ScanTrigger`／`scanTriggerStatements`／`parseScanTriggerCounts`／`persistScanCompletion(via)`）、",
  "`src/worker.ts`（`scanGateMs`／`scanRescueGapMs`／`runScan(via)`／`scanTriggerMirror`）、`scripts/test-unit.js`。",
  "",
].join("\n");

edit(
  "docs/round-trips.md",
  "§4.40",
  "**落線紀錄：** `docs/patches/tick-front-2026-09-27.apply.js`（19 個 edit）、",
  section + "\n**落線紀錄（§4.39）：** `docs/patches/tick-front-2026-09-27.apply.js`（19 個 edit）、",
  "### §4.40 掃描係邊個跑",
);

// ---------------------------------------------------------------------------
// 2. uptime-monitor.md — the ping is a rescue, not a cadence participant.
// ---------------------------------------------------------------------------
edit(
  "docs/uptime-monitor.md",
  "rescue note",
  "- 每次 `/health` 請求 → Worker 背景跑一次完整掃描（waitUntil 保持 isolate\n  存活直到掃描完成）→ 寫入心跳。\n- 外部監控每 1 分鐘 ping → 掃描維持在 ~1 分鐘一次（cron 的 60s 間隔閘門\n  對齊 1 分鐘 cron；監控 ping 只是補充驅動，不會加速超過閘門）。",
  "- 每次 `/health` 請求 → Worker 背景**檢查**一次心跳（waitUntil 保持 isolate\n  存活直到完成）。自 2026-09-27 起，只有當最後一次**完成**的掃描已經隔咗\n  **兩個 cadence**（`scanRescueGapMs` = `max(120s, 2 × SCAN_INTERVAL_SECONDS)`）才會真的跑掃描：\n  遲到不足一個 cadence 的 tick 自己會掃，所以 ping 係**救援**而唔係 cadence 的一部分\n  （實測 2026-09-27：舊的 60s 門檻令 90 分鐘內 76 個 completion 有 26 個其實係 ping 跑嘅）。",
  "所以 ping 係**救援**而唔係 cadence 的一部分",
);

// ---------------------------------------------------------------------------
// 3. wrangler.toml — what SCAN_INTERVAL_SECONDS means now.
// ---------------------------------------------------------------------------
edit(
  "wrangler.toml",
  "SCAN_INTERVAL_SECONDS comment",
  "# Minimum gap between scans, in seconds. The cron trigger still fires every\n# minute, but the worker skips the scan when the previous one finished less\n# than this long ago (cross-isolate via the DB heartbeat). 60 = scan every",
  "# Minimum gap between scans, in seconds. The cron trigger still fires every\n# minute, but the worker skips the scan when the previous one COMPLETED less\n# than `scanGateMs(this)` ago — this value minus a jitter budget, cross-isolate\n# via the DB heartbeat (src/worker.ts). The budget is 30s at 60s and shrinks to\n# whatever room stays above one cron period for longer intervals, which is what\n# keeps 90 skipping every other tick instead of silently becoming 60. The\n# monitor-driven HTTP fallback is a pure RESCUE since 2026-09-27: it needs\n# max(120s, 2 x this) of silence before it scans at all, so a tick that is\n# merely late still scans for itself. 60 = scan every",
  "a pure RESCUE since 2026-09-27",
);

for (const note of notes) console.log(note);
console.log(`\n${notes.filter((n) => n.startsWith(" ✓")).length} patched, ${notes.filter((n) => n.startsWith(" =")).length} already applied`);
