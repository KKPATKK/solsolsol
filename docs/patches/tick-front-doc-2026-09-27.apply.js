#!/usr/bin/env node
/*
 * Appends §4.39 to docs/round-trips.md — the write-up of the conditional
 * tracker slice, the owned subrequest windows and the cold-init boot merge
 * (see docs/patches/tick-front-2026-09-27.apply.js).
 *
 * Run: node docs/patches/tick-front-doc-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

if (src.includes("### §4.39 ")) {
  console.log(" = already applied");
  process.exit(0);
}

const SECTION = [
  "",
  "### §4.39 pass 走咗之後：slice 條件化、window 認主人、cold-init 少一個 read（2026-09-27）",
  "",
  "**三件事，一個主題：** §4.38 之後 pass 已經由自己嘅 cron delivery 擁有（durable row 全部 `via:\"cron-pass\"`，",
  "14 分鐘零 `via:\"tick\"`），所以 tick 身上兩樣嘢變成過時：(1) 佢仍然幫 pass 留 12 個 subrequest；(2) 個 counter",
  "仍然係「兩個 owner 一齊數」而講唔出邊個花咗。第三件係順手執到嘅 cold-init 重複 read。",
  "",
  "**1. `TRACKER_PASS_SUBREQ_RESERVE` 由常數變成問題。** `scanSubreqLeft` 以前無條件減 12，",
  "而 scan 嘅 low-water gate 係 `subreqsLeft() > SCAN_SUBREQ_FLOOR (12)` —— 即係 `spent >= usable - 24 ≈ 14`",
  "就要 drop optional legs。但當 pass 交咗俾 delivery，呢 12 個係為一個**唔會跑**嘅 pass 而留。現在：",
  "",
  "- `scanSubreqLeft(remaining, reserve = 12)`：算術一樣，slice 變成參數（default 保住所有舊 caller 同舊讀數）。",
  "- `Scanner.trackerPassSlice(windowMs, slice, atMs)`：row 新鮮 ⇒ **0**，否則 slice。",
  "- 兩個決定共用**同一個讀數**：`Scanner.peerPassAgeMs(at, windowMs)`（row age，唔答就 null）。",
  "  Pass 自己喺 `startedAt` 問，而 **scan 喺 `startedAt + SCAN_TICK_BUDGET_MS` 問** —— 即係呢個 invocation",
  "  最遲幾時可以開 pass。喺最尾問嘅意思係：如果嗰刻 row 都仲新鮮，pass stage 到嗰陣必然都係讓路。",
  "  兩邊唔會為咗一條「喺中間跨過 window」嘅 row 而講唔同嘅話（嗰種情況會變成 release 咗 slice 但 pass 照跑，",
  "  然後 entry-gate `deferred:subreq-budget`）。",
  "- 冇 front row（standalone scanner、front read 失敗）⇒ **fail safe**：slice 照留（＝未 split 之前嘅行為）。",
  "",
  "**2. Window 認主人：`SubreqOwner`。** 呢個 counter 係 per module，而一個 isolate 每分鐘服務**兩個** invocation",
  "（scan tick 同 pass delivery）—— 所以一個唔講主人嘅 window 係讀唔出答案嘅：tick 嘅 front 同 pass 嘅轉盤",
  "同樣顯示成一句 `turso: N`。而家 `beginSubreqWindow(at, owner)` 帶 tag，`beginPreTick(entryAt, owner)` 傳落去，",
  "`subreqView()` 每個 window（current ＋ recent）都出 `owner`：`\"scan\"`（scheduled 但唔係 pass 嘅 delivery）、",
  "`\"pass\"`（pass 自己嘅 cron）、`\"http\"`（HTTP fallback 條路），唔講就 `\"unknown\"`（唔估）。",
  "「tick front 花咗幾多」由此變成有答案嘅問題。",
  "",
  "**3. Cold-init 嘅 boot read 併上 front 嗰一句。** `ensureInitialized` 嘅 front statement（`WEDGE_READ_KEYS`）",
  "係每個 isolate 嘅**第一個** read，而 init boot 區塊 ~300ms 之後喺**同一個** invocation 再讀四條 key",
  "（`axiom_access_token` ＋ 三個 mirror）—— 一個免費讀得到嘅第二個 round trip。現在：",
  "",
  "- 新 `BOOT_STATE_KEYS` 被 `WEDGE_READ_KEYS` spread 入去（一條 list，兩處唔會 drift）。",
  "- front read 落地即記落 `lastBootKeysRead`（`map: null` ＝ **冇讀數**，唔可以當「冇 row」，因為其中一條 key",
  "  決定 Axiom client 起唔起）。",
  "- boot 區塊喺 `HEARTBEAT_REUSE_MS`（2s，同 invocation）之內就用嗰個 map ⇒ **零 subrequest**；",
  "  逾時／null 就照舊讀自己嘅（merge 嘅失敗形狀 ＝ 舊形狀，唔會少 row）。",
  "- 量度背景：live census 讀到 `getWorkerStates 5 calls / 616ms`，係 front 最大嘅單一項，而冷 isolate 上面",
  "  boot read 就係其中一個。",
  "",
  "**測試（3 條新／改）：**",
  "",
  "- `subreq reserve: …`：加咗 `scanSubreqLeft(30, 0) === 30`、`(2, 0) === 2`、`(30, 4) === 26`，",
  "  同一個 whitespace-flattened pin 釘死**成個 call 形狀**（`scanOwner.runOnce(() => scanSubreqLeft(subreqRemaining(),",
  "  scanOwner.trackerPassSlice(TRACKER_PASS_FALLBACK_FRESH_MS, TRACKER_PASS_SUBREQ_RESERVE, startedAt + SCAN_TICK_BUDGET_MS)))`）",
  "  —— slice 唔再係常數，係要**問**。",
  "- `Scanner.trackerPassSlice: the slice is released only when the pass WILL stand down`：",
  "  冇 row ⇒ 12；40 秒前嘅 row ⇒ 0；**同一個 row 但問喺 tick 尾（＋200s）⇒ 12**（一致性嘅釘）；",
  "  `phase:\"skip\"` ⇒ 12（冇跑過 pass 嘅 tick 唔係 owner）；`windowMs 0` ⇒ 12。",
  "- `subreqs: a window names which invocation opened it`：scan → pass 先後開窗，current／recent 各自帶主人；",
  "  唔講 ⇒ `unknown`。",
  "- 跟住走嘅 pin：boot read 由「一個 `getWorkerStates`」改成「`BOOT_STATE_KEYS` 騎上 `WEDGE_READ_KEYS`",
  "  ＋ boot 區塊優先讀 `lastBootKeysRead`，自己讀只做 fallback」。",
  "",
  "**本地驗證：** `npx tsc --noEmit` 清（途中撞到 TS18047 —— slice probe 喺 closure 裡面摸唔到 module-level",
  "`scanner` 嘅 narrowing，改用 call site 嘅 `scanOwner` local，同一個 capture 兩個用途）；",
  "`node scripts/test-unit.js` ＝ **374 passed / 0 failed**；其餘 6 個 suite（6＋5＋9＋4＋13＋…）全綠；",
  "`npx wrangler deploy --dry-run` OK。",
  "",
  "**驗收點（live，deploy 之後）：**",
  "",
  "1. `/health.subreqs` 嘅 window 開始帶 `owner`：tick 自己嘅窗讀 `\"scan\"`、pass delivery 讀 `\"pass\"`、",
  "   HTTP fallback 讀 `\"http\"` ⇒ 由此可以逐個 owner 算 spend（呢個係本輪之後所有 front 讀數嘅前提）。",
  "2. 健康形狀下 tick 嘅 optional legs 唔應該再咁早 drop：`summary.subreqSkip` 唔會再點名 boosts／meteora 之類，",
  "   直到 `spent` 接近 26（之前 ~14）。覆蓋率（`profiles`／`pool`／`candidates`）應該跟住升。",
  "3. Pass 照樣 `via:\"cron-pass\"`、`rows 30/30`、`defer-send 0`；tick 嗰邊繼續零 `via:\"tick\"`。",
  "4. 冷 isolate 嘅 front 少一個 `getWorkerStates`（`subreqs.current.total` 同 hosts 嘅 `turso` 各少 1 至 2），",
  "   而 boot 嘅 mirror（`deferral`／`pushLedger`／`skipCapture`）照樣有值 —— 佢哋係嗰個 merge 最容易讀錯嘅地方。",
  "",
  "**落線紀錄：** `docs/patches/tick-front-2026-09-27.apply.js`（19 個 edit）、",
  "`docs/patches/tick-front-scanowner-2026-09-27.apply.js` ＋ `-fix`（capture 位置）、",
  "`docs/patches/tick-front-tests-2026-09-27.apply.js`；`src/subreqs.ts`（`SubreqOwner` ＋ window owner）、",
  "`src/worker.ts`（`scanSubreqLeft(reserve)`／`BOOT_STATE_KEYS`／`lastBootKeysRead`／`beginPreTick(owner)`／",
  "tick 嘅 probe）、`src/scanner.ts`（`peerPassAgeMs`／`trackerPassSlice`）、`scripts/test-unit.js`。",
  "",
].join("\n");

const next = src.endsWith("\n") ? src + SECTION : src + "\n" + SECTION;
fs.writeFileSync(file, next);
if (!fs.readFileSync(file, "utf8").includes("### §4.39 ")) {
  throw new Error("the write did not verify");
}
console.log(" ✓ docs/round-trips.md §4.39 appended");
