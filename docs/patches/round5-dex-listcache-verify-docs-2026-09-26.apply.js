#!/usr/bin/env node
/**
 * Round 5f, docs half: §4.31 — the two mistakes Round 5e shipped, the live
 * evidence that exposed them, and the post-fix readings.
 *
 * Appended after §4.30 (which is where the change itself is recorded), because
 * the correction is its own lesson: the page looked plausible the whole time
 * and the durable row said otherwise.
 *
 * Run: node docs/patches/round5-dex-listcache-verify-docs-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "docs", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

const SECTION = [
  "",
  "### §4.31 邊緣 cache 帳本：第一次 deploy 個兩個錯，同向 durable row 學到嘅嘢（2026-09-26）",
  "",
  "**頁面睇唔出錯。** deploy 完之後 `/health` 一樣 `ok`、tick 一樣 1.7–2.8s、profiles 一樣 24，而 `dexListCache` 一直係 `null`。",
  "係改用唔經 Worker 嘅讀法（`node scripts/read-heartbeat.js --keys …`，今次加嘅 `--keys` 模式，read-only by construction）先見到真相：",
  "",
  "```",
  "dex_list_cache_hits:    -        ← 冇",
  "dex_list_cache_misses:  \"2\"      ← 有",
  "dex_list_cache_last:    -        ← 冇",
  "schema_ddl_fingerprint: \"e62d9a2a\"   ← 對照組（已知會存在）",
  "```",
  "",
  "8 個 tick 只寫過一次，而且個 `2` 係一個**暖** isolate 帶住上一個 tick 嘅 outcome 寫落去 —— 呢個「罕有嘅成功」本身就係線索。",
  "",
  "**錯 1：journal 擺喺 tick 嘅錯誤一端。** 我擺咗喺 summary 建構之前，理由係「同 `dex:` 快照同一個窗口」。但個 build 喺 **profiles 結果 await 之前**",
  "（fetch 喺 tick 頭開始、feed 階段才 await）、亦喺 boosts fetch 之前 ⇒ **冷 isolate（＝絕大多數 tick）喺自己個 fetch 未答之前就 journal，delta 永遠空，",
  "窗口跟 isolate 一齊死**。而家改喺本 tick 自己嘅 list fetch 之後、front 嗰個**唯一 write** 之前 ⇒ 窗口係本 tick 產生嘅，而且行係搭一個本身已經要出嘅 request。",
  "測試加咗一條**次序 guard**（profiles await < boosts < pool < journal < flush，而且唔可以喺 diag 之前）：我驗過佢真係會咬 —— 用返舊位置，四條謂詞全部 fail。",
  "",
  "**錯 2：拒絕被當成 miss。** `misses` 原本連非 2xx 都計，而現場 12 分鐘內就有 4 次 429（`dex_429_total` 4287）。但 `cacheTtlByStatus` 淨係 200–299 有 TTL",
  "⇒ **429 從來唔係 edge cache 嘅候選，唔可以當成「entry 過期」嘅證據**，而且佢自己有 `http429` 計數器。而家只有 2xx 才會入帳（2xx 但冇 header 照樣算 miss，",
  "理由見帳本註解：hit 係唯一需要 header 去證明自己嘅結果）。",
  "",
  "**修正後嘅 live 讀數**（deploy `871df6b`，run `36252847526`）：",
  "",
  "| 時間（Z） | 讀法 | 值 |",
  "|---|---|---|",
  "| 15:45:36 | durable row | `hits 4`、`misses 8`、`last HIT` |",
  "| 15:46:0x | `/health.dexListCache` | `{hits:4, misses:8, hitPct:33.3, lastStatus:\"HIT\"}` |",
  "| 15:48:10 | durable row | `hits 6`、`misses 8`、`last HIT`（遞增中） |",
  "",
  "成本：同一個 tick 嘅 step 表照舊 `writeScanFront {calls 1, ms 45}`、`dbMs 125`、tick 1903–2545ms —— 行係搭 front 本身嗰個 request，冇新 step、冇新 round trip。",
  "",
  "**兩件要講清楚嘅事**：",
  "",
  "1. 舊邏輯寫落嘅 `misses 2` 留在 row 度（對一個會以千計嘅分母係噪音）：手寫 Turso DELETE 正是呢啲 read-only 儀器存在嘅理由。",
  "2. `hitPct 33.3` 唔可以當結論：窗口只有幾分鐘、仲包含修正前嘅 2 個樣本，而且 `lastStatus` 淨係講最後一個 label。要答 `LIST_FEED_CACHE_TTL_S`（60 vs 180）",
  "   就要等 miss 佔比喺**正常時段**（`http429` 平穩）企穩 —— 呢個就係 §4.30 講嘅數據條件，而家終於有得收。",
  "",
  "落線紀錄：`docs/patches/round5-dex-listcache-timing-2026-09-26.apply.js`（source ＋ guard）、`scripts/read-heartbeat.js --keys`（診斷儀器）。",
  "",
].join("\n");

if (src.includes("### §4.31 邊緣 cache 帳本")) {
  console.error("✗ §4.31 already present — nothing written");
  process.exit(1);
}
if (!src.includes("§4.31")) {
  console.error("✗ §4.30 does not reference §4.31 yet — nothing written");
  process.exit(1);
}
fs.writeFileSync(file, src + SECTION);
console.log(`✓ docs/round-trips.md: §4.31 appended (${src.length} → ${src.length + SECTION.length} characters)`);
