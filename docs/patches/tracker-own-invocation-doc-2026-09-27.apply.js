#!/usr/bin/env node
/*
 * Appends §4.38 to docs/round-trips.md — the write-up of the tracker pass's
 * own cron invocation (see docs/patches/tracker-own-invocation-2026-09-27.apply.js).
 *
 * Run: node docs/patches/tracker-own-invocation-doc-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

if (src.includes("### §4.38 ")) {
  console.log(" = already applied");
  process.exit(0);
}

const SECTION = [
  "",
  "### §4.38 追蹤 pass 搬去自己一個 invocation：唔再同 scan 分嗰 38 個 subrequest（2026-09-27）",
  "",
  "**動機（live 01:31–01:57Z，§4.37 落線之後）：** §4.37 令一張卡平咗一個 round trip，但卡嘅**數量**冇動 ——",
  "連續抽樣 8 個 pass，**每一個都 `defer-send == subreq-cut`**（0／1／6／10／17…），一次 `budget-cut` 都冇。",
  "拒絕唔係時鐘、亦唔係 Turso latency：`db 110ms` 嘅 pass 照樣拒 10 行，`db 3421ms` 嘅拒 6 行，數字只跟住 subrequest 走。",
  "",
  "真正嘅因係「pass 開波之前 tick 已經食咗幾多」——`tickProgress {stage:\"postscan\"}` 同同一個 invocation 嘅 pass note 配對：",
  "",
  "| front（postscan subreqs，usable 38） | pass 結果 |",
  "|---|---|",
  "| 39 | `ok:0/0 deferred:subreq-budget trips 0` ← **入口閘**，一行都冇 check |",
  "| 23 | `rows 30/30`、`defer-send 0` |",
  "| 18–20 | `rows 24–29/30`、`defer-send 1–10`（每行撞 `TRACKER_SUBREQ_RESERVE`） |",
  "",
  "pass 係 tick 嘅**最後一棒**，所以永遠只執到前幾棒剩低嘅：front＋scan＋flush 用 18–39 個，pass 就得單位數。",
  "而一張卡（claim＋reserve batch、Telegram、delivery-audit 讀同寫、final check 寫）實測 4–5 個 ⇒",
  "一個執剩嘅 claimant 出 0–1 張，同 pass note 嘅 `alerted 0–1` 完全對得上。**要救卡，就要救 pass 嘅 window，唔係再平一張卡。**",
  "",
  "**做法：第二個 cron trigger，pass 自己一個 invocation。**",
  "",
  "- `wrangler.toml` `[triggers].crons` 一句變兩句：`\"* * * * *\"`（scan tick，照舊）＋ `\"*/1 * * * *\"`（pass ＝ `worker.TRACKER_CRON`）。",
  "- `worker.scheduled` 見到 `event.cron` 命中 `TRACKER_CRON` 就入 `runTrackerInvocation`：",
  "  `beginPreTick`（**自己一個 subrequest window**）→ bounded init（`FRONT_INIT_BOUND_MS`）→ **一個** pass",
  "  （`TRACKER_PASS_BUDGET_MS`、`subreqRemaining`、`via:\"cron-pass\"`）→ return。",
  "  佢喺 `scheduledTicks`、cron-arrival stamp、cadence gate **之前** return：嗰三樣都係數 **scan arrival**",
  "  （注入嘅 cadence gate 同 outage check 都係比較佢哋），一個唔 scan 嘅 delivery 唔應該推佢哋。",
  "- `isTrackerCron` 係純函數、**逐字元**比對（只 trim 外面）。Cloudflare 交低嘅 `event.cron` 就係設定嗰串字",
  "  （見下面 platform facts），所以「裡面 spacing 唔同」≠ 我哋嘅 trigger；喺已經有兩個 trigger 嘅世界，",
  "  一 string 唔 match 就係 scan tick，唔會有 delivery 靜靜雞掉包。",
  "- `runTrackerInvocation` 亦要傳 `waitUntil`（`tickWaitUntil`）：CUT 卡嘅 delivery proof 係 pass tail 開嘅",
  "  未 await promise，handler 一 return 就會被取消 —— 同 tick 嘅理由一樣。",
  "",
  "**fallback：pass 嘅 row 就係 ownership clock。** 呢個 trigger 係新嘅，而平台對呢個 Worker 有前科",
  "（`docs/uptime-monitor.md`：cron 靜靜雞停派）。所以第二個 trigger 係 **owner，唔係 requirement**：",
  "",
  "- `SCAN_FRONT_GATE_KEYS` 加多一條 `push_watch_pass`（**免費**：同一句 SELECT，IN-list 多一個 key，唔多一個 request）。",
  "  `Scanner` 記住佢（`peerPassRow`，front 清空都留到 —— 佢係 pass 唯一要問嘅嘢）。",
  "- tick 叫 pass 時傳 `{ peerPassFreshMs: TRACKER_PASS_FALLBACK_FRESH_MS (120s), via: \"tick\" }`。",
  "  row 年輕過 120s ⇒ **企埋一邊**，唔寫任何 durable row，只出 `yield:peer-pass Ns`（pulse stage `peer-pass`）。",
  "  唔寫係重點：個 row 就係 ownership clock，yield 若果重寫，fallback 就會永遠瞓著（死 trigger 永遠冇人發現）。",
  "- `passRowAgeMs` 有三種「答唔到」：冇 row／`phase:\"skip\"`（冇跑過 pass 嘅 tick 唔可以代表 ownership）／",
  "  未來 stamp（讀 0，唔可以負；clock skew 唔應該開第二個 pass）。三種都係「你跑啦」。",
  "- `skip:*` row 亦開始寫 `via:\"tick\"`；`via` 只喺 caller 講嗰陣寫，其他 caller（包括所有測試）嘅 row 一個 byte 都唔變。",
  "",
  "**120s 嘅算術：** pass delivery 每 ~60s 寫一次 row，而 tick 讀嗰個係自己 front 嘅 copy（tick 開波 3–5s 讀，",
  "所以最多舊一分鐘）。120s ＝「嗰一分鐘 ＋ 一個 cron 週期」，所以連一個遲到嘅 tick 都會讓；",
  "而 trigger 真死嘅話，fallback 大約每 3 分鐘跑一次 —— 就係之前 live 見到嘅 `rows 24–30/30` 形狀嘅節奏。",
  "最壞情況係 pass 嘅 cadence，永遠唔會係「冇人宣佈嘅卡」。",
  "",
  "**platform facts（2026-09-27 查 Cloudflare 官方 docs 核實）：** cron trigger 數目上限係 per-account（Free 5 個），兩句冇問題；",
  "`event.cron` 係設定嘅字串本身 ⇒ 逐字元比對係啱嘅；Cron Trigger 喺 Free plan 嘅 CPU 上限係 **10ms**",
  "（同 scan tick 一樣）—— 呢次拆分**唔會**少咗 CPU：兩個 invocation 各自 10ms，而 pass 係 I/O-bound（等 round trip），",
  "唔係 CPU-bound；Cron Trigger 嘅 duration 上限係 15 分鐘，遠大於 pass 嘅 5s 預算。",
  "",
  "**測試（3 條新，加 3 條 pin 跟住走）：**",
  "",
  "- `passRowAgeMs: a row that cannot answer never holds the ownership window`（absent／junk／`at:0`／`phase:\"skip\"`／未來 stamp）。",
  "- `TRACKER_CRON: the pass's own delivery is routed, and wrangler.toml matches it character for character`",
  "  —— 直接讀 `wrangler.toml`：兩句都要在，第一句（scan）唔可以係 pass 嘅 delivery。",
  "- `Scanner.runTrackerPass: a fresh peer pass in the front makes the tick stand down, and writes nothing`",
  "  —— 新鮮 ⇒ `yield:peer-pass`、**零 durable write**；舊 row ⇒ 真係跑，row 帶 `via:\"tick\"`；",
  "  冇 options（＝pass 自己嘅 delivery）⇒ 照跑，row 帶 `via:\"cron-pass\"`。",
  "- 跟住走嘅 pin：`worker (stamp BEFORE init)` 嘅 init anchor 收窄到 **scheduled handler**（`runTrackerInvocation` 有同一段",
  "  prologue，而佢喺檔案更前）；`{via:\"cron-pass\"}` 個 pin 之前多打咗個 comma，永遠 match 唔到，順手修返；",
  "  `persistPassNote(errNote, …, \"done\", options?.via)` 跟住新 call。",
  "",
  "**本地驗證：** `npx tsc --noEmit` 清；`node scripts/test-unit.js` ＝ **372 passed / 0 failed**；",
  "其餘 6 個 suite（6＋5＋9＋4＋13＋…）全綠；`npx wrangler deploy --dry-run` OK（兩個 triggers 都收貨）。",
  "",
  "**驗收點（live，deploy 之後）：**",
  "",
  "1. pass note 由 `ok:0/0 deferred:subreq-budget` ／ `defer-send == subreq-cut` 變成 `ok:≥N/…` 而且 **`alerted ≥2`**；`subreq-cut` 應該貼近 0。",
  "2. row 帶 `via:\"cron-pass\"`（pass 自己嘅 delivery）；tick 嗰邊只出 `yield:peer-pass Ns`。",
  "3. 追蹤池最舊未 check 行由 16 分鐘回落（30 行／分鐘嘅節奏＝一輪 ~1 分鐘）。",
  "4. `/debug/push-watch.issueCount` 保持 0；`dup-skip` 冇異常（權威守衛冇動）。",
  "5. 萬一第二條 trigger 冇派：`via:\"tick\"` 嘅 pass 每 ~3 分鐘出現 ⇒ fallback 有效，唔係靜靜死。",
  "",
  "**落線紀錄：** `docs/patches/tracker-own-invocation-2026-09-27.apply.js`（20 個 edit）、",
  "`docs/patches/tracker-own-invocation-comment-fix-2026-09-27.apply.js`（block comment 食咗個 `*/`，見下）、",
  "`docs/patches/tracker-own-invocation-pins-2026-09-27.apply.js`（3 條 source pin 跟住走）；",
  "`wrangler.toml`（第二句 cron）、`src/worker.ts`（`TRACKER_CRON`／`isTrackerCron`／`TRACKER_PASS_FALLBACK_FRESH_MS`／",
  "`runTrackerInvocation`／routing／tick 嘅 fallback 參數）、`src/scanner.ts`（`TrackerPassRunOptions`／`peerPassRow`／yield／`via`）、",
  "`src/pushwatch.ts`（`passRowAgeMs`／`notePeerPassYield`）、`src/db.ts`（front 帶 row）、`scripts/test-unit.js`。",
  "",
  "**一個誠實嘅註腳：** 第一個 apply script 嘅註釋裡寫咗 `*/1  *  *  *  *` 做例子，而 `*/` 喺 `/** … */` 裡面就係**收口** ——",
  "worker.ts 由嗰行開始 parse 爛（tsc TS1109 之後一大串）。第二個 apply script 幫佢改成文字描述。教訓：",
  "block comment 裡面寫 cron 表達式，永遠唔好寫成星號加斜線。",
  "",
].join("\n");

const next = src.endsWith("\n") ? src + SECTION : src + "\n" + SECTION;
fs.writeFileSync(file, next);
const back = fs.readFileSync(file, "utf8");
if (!back.includes("### §4.38 ") || !back.includes("tracker-own-invocation-pins-2026-09-27.apply.js")) {
  throw new Error("the write did not verify");
}
console.log(" ✓ docs/round-trips.md §4.38 appended");
