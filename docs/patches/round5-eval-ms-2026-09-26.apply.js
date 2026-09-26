#!/usr/bin/env node
/**
 * Round 6, docs half: §4.32 — measuring the eval phase, and what it found.
 *
 * The measurement legs live in scripts/cpu-profile.js (the `eval:` rows); this
 * is the record of why they exist, what they read, and what was landed because
 * of them.
 *
 * Run: node docs/patches/round5-eval-ms-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "docs", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

const SECTION = [
  "",
  "### §4.32 eval 階段：唯一未量過嘅 phase，量完發現係 `Intl.NumberFormat`（2026-09-26）",
  "",
  "**點解係最後一個缺口。** §4.29 量咗 DB round trip、feeds 各自嘅 parser、pool 讀；`evalMs` 係唯一冇 CPU 讀數嘅 phase，而佢嘅 wall clock 係最長嘅",
  "（現場：`feedsMs 613 / poolMs 183 / evalMs 891`，總共 1.9s）。`evalMs` 由 `const evalStart = Date.now()` 到 `diag.evalMs = …`，包住 pair 階段、逐個幣嘅閘、",
  "enrichment 鏈、render 同 send —— 入面嘅 I/O 都已經喺別處定價，所以缺口係「每個幣行嘅 JS」，即 `Scanner.matchCoins`。",
  "",
  "**量法**（`scripts/cpu-profile.js` 新嘅 `eval:` 腿，同樣係「dist/ 嘅真函數 + 真輸入」）：真 pool rows（`getReevalPool`，現場 393–477 行）、",
  "真 pair payload（真 GET，唔齊就補 fetch，否則就係低報緊要量嘅嘢）、真 `chat_settings`，然後直接叫 `scanner.matchCoins(...)`，用 `process.cpuUsage()` 計 CPU。",
  "",
  "**讀數（改之前，暖機後）：**",
  "",
  "| 腿 | CPU | 換算 |",
  "|---|---|---|",
  "| `matchCoins` 344 coins（113 pairs） | 3.84–4.55 ms | ~11 µs／coin |",
  "| `matchCoins` 113 **paired** coins（gate path） | **4.6–8.5 ms** | **40–73 µs／coin** |",
  "| `matchCoins` 690 coins（doubled） | 15.63 ms | 線性 |",
  "| `fmtUsd ×100`（暖） | 2.73 / 2.55 / 2.52 ms | **~25 µs／呼叫** |",
  "| `new Intl.NumberFormat + format ×100` **#1（冷，付 ICU）** | **15.07 ms** | 一次性／isolate |",
  "| `matchCoins` #1（Intl 未暖時，另一個 run） | **41.95 ms** | 冷 isolate 要付 |",
  "",
  "**答案：係 `fmtUsd`。** `src/format.ts` 每次呼叫都 `new Intl.NumberFormat(...)`，而 `matchCoins` 每個被拒嘅幣都喺**呼叫現場**砌 reject 字串",
  "（\"流动性 $x < $y\" 之類，每個字串 1–2 次 `fmtUsd`）—— 即係 `50 µs／被拒幣` 對比實測 `40–73 µs／coin`，完全對得上。而且 reject 訊息係**先砌後才知會唔會入**",
  "（log 上限 20 條）：~94 個被拒嘅幣，大部份嘅字串砌完即掉。",
  "",
  "**落線**：`fmtUsd` 嘅 formatter 改成按 option set cache（`cachedNumberFormat`，最多 4 個 entry：compact ＋ 三個小數位）。`Intl.NumberFormat` 嘅 `format()` 係無狀態嘅",
  "—— 同一個 instance 可以共用 —— 而 option set 係封閉集合，所以 cache 係有界嘅。",
  "",
  "**改之後（同一個 script、同一批資料）：**",
  "",
  "| 腿 | 之前 | 之後 |",
  "|---|---|---|",
  "| `fmtUsd ×100`（暖） | 2.73 / 2.55 / 2.52 ms | **0.79 / 0.11 / 0.11 ms** |",
  "| `matchCoins` 345 coins（111 pairs） | 3.84–4.55 ms | **0.31–0.41 ms** |",
  "| `matchCoins` 113 paired（gate path） | 4.6–8.5 ms | **0.26–0.36 ms** |",
  "| `matchCoins` 690 coins（doubled） | 15.63 ms | **2.10 ms** |",
  "",
  "即係 eval 階段嘅逐幣 JS 由 ~5–15 ms 落到 ~0.3–2 ms。同一個 cache 亦順手改善**出卡**（`render.ts` 每張卡幾次 `fmtUsd`）同 pushwatch 訊息。",
  "呢個係 §4.29 之後第一刀**唔係**砍 round trip 嘅 —— 佢砍嘅係 10 ms CPU 預算裏面嘅純計算，一 刀大約等於 1–3 個 DB round trip（每個 2.4–5.8 ms）。",
  "",
  "**要老實講嘅三點：**",
  "",
  "1. **冷 isolate 嗰 15 ms 冇得砍。** 第一次用 `Intl` 就要初始化 ICU/data（實測 15.07 ms），改前改後都要付 —— 之前係喺 eval 階段第一次砌 reject 字串時付。",
  "   （改前 `matchCoins #1` 41.95 ms ≈ ICU 15 ms ＋ V8 對 matchCoins/fmtUsd 嘅 JIT/IC 暖機；改後同一條腿 1.41 ms，因為 ICU 已由前面嘅探針付咗。）",
  "2. **Node 唔等於 workerd。** 兩邊都係 V8，所以 share 可以搬、絕對值唔可以（同一句寫喺 `scripts/cpu-profile.js` 開頭）。要當係「呢件事係最大單一項」嘅證據，唔係「production 一定係 0.3 ms」。",
  "3. **evalMs 嘅 wall clock 依然係 I/O。** 修完之後逐幣 JS 唔再係槓桿：`evalMs ~840–1000 ms` 係 pair fetch、seen claim、enrichment 嘅等待，唔係 CPU。",
  "   所以 eval 階段唔會再有「砍 computation」嘅一刀；要再壓就係壓 round trip 數（§4.29 嗰條線）。",
  "",
  "**測試**：`scripts/test-usd-formatter.js`（4 條，已入 `npm run test:unit`）釘死三件事：每個分支嘅**輸出字串**一模一樣（12 個值，含 0/負/NaN/Infinity/三個小數位邊界/compact）、",
  "分支之間**真係唔同 shape**（keys 撞咗就會靜靜用錯 options）、以及**N 次呼叫只 construction 4 次**（用真 `Intl.NumberFormat` 計數器，改前係 160 次）。我驗過呢個 guard 真係會咬：",
  "把 cache 拆走（突變 `dist`）→ 160 次 construction → 測試會 fail。另外 `src/format.ts` 有 source guard：只可以兩處 `new Intl.NumberFormat(`（兩個 maker），第三處就係漏 cache 嘅呼叫點。",
  "",
  "落線紀錄：`src/format.ts`（formatter cache）、`scripts/cpu-profile.js`（`eval:` 量測腿）、`scripts/test-usd-formatter.js`。",
  "",
].join("\n");

if (src.includes("### §4.32 eval 階段")) {
  console.error("✗ §4.32 already present — nothing written");
  process.exit(1);
}
fs.writeFileSync(file, src + SECTION);
console.log(`✓ docs/round-trips.md: §4.32 appended (${src.length} → ${src.length + SECTION.length} characters)`);
