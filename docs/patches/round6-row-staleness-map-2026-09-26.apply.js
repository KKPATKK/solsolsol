#!/usr/bin/env node
/*
 * Round 6.3, the record: §4.36 — when the durable profile row can go stale,
 * and why the 10-minute reuse window stays where it is.
 *
 * No source change rides with this section on purpose: the numbers say the
 * window still covers the failure it bounds, and this repo moves a constant
 * only when a reading makes it move (see the LIST_FEED_CACHE_TTL_S open
 * question, which is still waiting for its own reading).
 *
 * Run: node docs/patches/round6-row-staleness-map-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(p, "utf8");

if (src.includes("### §4.36 ")) {
  console.log("= round-trips.md: §4.36 already present");
  process.exit(0);
}

const old = j(
  "落線紀錄：`docs/patches/round6-seed-promise-2026-09-26.apply.js`（client）、`docs/patches/round6-seed-promise-scanner-2026-09-26.apply.js`（scanner）、",
  "`src/dexscreener.ts`（signature ＋ fallback await）、`src/scanner.ts`（promise 化嘅 front read／dispatch）、`scripts/test-dex-last-profiles.js`。",
);

const next = old + "\n" + j(
  "",
  "### §4.36 durable profile row 幾時會 stale？10 分鐘 reuse 窗要唔要拉長？（2026-09-26）",
  "",
  "**Row 幾時會變舊（唯一寫入條件）：** `Scanner.stampProfileFeedSnapshot()` 只喺「fetch 唔 failed **而且** list 非空」嘅 tick 寫 row，",
  "所以 `dex_profiles_last.at` = 最後一次「有得用」嘅 fetch。會令佢一路變舊嘅 regime 只有四種：",
  "",
  "| # | 機制 | 實測 |",
  "|---|---|---|",
  "| 1 | profiles 被 429（連隨其後嘅 cache-only 90s 都令 1-2 個 tick 冇 origin 機會） | 50 條 episode 跨 2.4 小時、gap p50 138 s；**429 regime（cluster）最長 24.7 分鐘**（8 個 cluster：24.7 / 23.1 / 12.2 / 11.9 / 9.0 … 分鐘） |",
  "| 2 | edge cache MISS 之後又被拒 —— 真正嘅 streak-maker | 帳本 404 hits / **8 misses**（2xx list 回答，≈2%）；一 MISS 撞正拒絕，90s cache-only 令跟住 1-2 個 tick 都冇 origin 可用 |",
  "| 3 | 200 但空（masked feed）：成功但 list 空 ⇒ **唔會**刷新 row，而 tick 照 reuse | `emptyFeedTotal 0`（今日）；見 docs/profiles-feed-zeros.md |",
  "| 4 | 機械性：tick 節奏／寫入被丟 | gap p50 61-67 s、max 120 s（10 分鐘 ≈ 5-10 個 tick）；`flushScanFront` 丟一批 = 最多一個 tick 冇刷新，下一個成功即補 |",
  "",
  "**反直覺嘅關鍵：regime 長度 ≠ row 老幾多。** 429 regime 可以跑 24.7 分鐘，但 row 唔會跟住舊 —— **任何一個 HIT 或 200 都刷新 row**，而 edge cache 幾乎每 tick 都 HIT。",
  "deploy（23:27:53Z）之後 17 個 tick（23:29-23:46）入面有 **5 次 429 episode**（23:30:06、23:31:09、23:33:06、23:37:18、23:41:11），",
  "**17 個 tick 全部讀 `profiles 27-30`、low(≤4) row 0 條**；row 抽樣 age 13 秒。真正嘅「冇得用」streak 係 cache-only × MISS 綑綁出嚟嘅：",
  "pre-fix 120-tick 樣本最長 **4 個 tick ≈ 3.9 分鐘**（25 條 run，34/103 條 low row），live 最大 row age（23:31:11 嗰個被拒 tick）= **4.9 分鐘**。",
  "",
  "**決定：10 分鐘窗唔動。** 理由：",
  "",
  "1. 邊際係量出嚟嘅：最長 streak ~4-5 分鐘 vs 窗 10 分鐘 ⇒ ~2-2.5×。",
  "2. 窗 lapse 嘅代價細而且自我修正：嗰個 tick 跌返 make-up lane（2-4 條幣），pool rotation／pairs／gate 全部照跑，下一個成功 fetch 就補返。",
  "3. 個窗同時係**診斷**：`profiles` 跌到 make-up 大細係 operator 一路睇開嘅警報（今晚 33% low-row 就係咁搵到）；`feedMakeup` 係 isolate-local、只在該 tick 嘅 summary 出現，唔可以完全代替。",
  "4. 拉長只對「>10 分鐘冇得用」嘅 streak 有用（從未見過），同時會令同一個警報遲 2× 出現，換嚟嘅只係「多 10 分鐘重覆評估同一批 ~26 條幣」——",
  "   而 re-eval pool 本身已經用 3 分鐘（near）／18 分鐘（far）sweep 覆蓋嗰批幣。",
  "",
  "**Tripwire（幾時應該返嚟拉長）：** 見到**連續 ≥6 個 tick** 讀 make-up 大細（`profiles` 2-4）、而 `dex_429` 仍然熱、`dex_list_cache_misses` 有升",
  "⇒ streak 已經唔再係 1-2 個 tick、而係跟住 regime 行；屆時要按 regime 長度（≥30 分鐘）size，並接受 `profiles` 警報延遲。",
  "（caveat：`dex_list_cache_*` 係**兩條 list leg 合計**（profiles ＋ boosts），所以 misses 升係 whole-list-feed 訊號，唔係 profiles 專屬。）",
  "",
  "**唯讀儀器：** `scripts/read-heartbeat.js`（`dex_profiles_last`／`dex_429_*`／`dex_list_cache_*`）、`/debug/scan-history`（tick 節奏 ＋ `profiles`）、",
  "`/health.heartbeat.summary.feedMakeup`（raw／failed／empty，isolate-local）。",
);

const count = src.split(old).length - 1;
if (count !== 1) {
  console.error(`✗ round-trips.md: §4.35 tail anchor found ${count} times (need exactly 1)`);
  process.exit(1);
}
fs.writeFileSync(p, src.replace(old, next));
console.log("✓ round-trips.md: §4.36 appended");
