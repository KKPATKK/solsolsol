#!/usr/bin/env node
/**
 * Late-bound organic doc pointer: appends §4.24 to docs/round-trips.md.
 *
 * Run: node docs/patches/organic-late-bound-doc-pointer-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "docs/round-trips.md");
const src = fs.readFileSync(file, "utf8");

const SECTION = [
  "",
  "---",
  "",
  "## 4.24 有機度第三擊：slot 改成 late-bound，加 worker 探針（2026-09-26）",
  "",
  "§4.23 把 card-only batch 移去 RugCheck 之前——**唔夠**。落線後第一張卡（roon, msgId 5384,",
  "04:26Z）仍然冇 🌱 行。兩個量到嘅原因：",
  "",
  "1. 個 batch 嘅 wall（`enrichDeadline` = tick start + 2200ms）大約就係 **chain 起步** 嘅時間",
  "   （live `seen` 戳 1.4–2.5s，而 seen-check 自己都係一個 read），所以 slot 開喺 2.0–2.5s 對住",
  "   2.2s 牆 = 未開已經死（`bestEffort` 一見 `deadline − now ≤ 0` 即回 fallback）。",
  "2. Jupiter client **自己 throttle 每 500ms 一個 slot**（`JUPITER_REQUEST_INTERVAL_MS`），同 tick",
  "   嘅 discovery 腿同 pair-fallback 共用，所以就算開得切，都可能排喺另一個 call 後面才答。",
  "",
  "修法：🌱 slot 唔再由 chain await —— 同 batch 一齊開，wall 用 **tick deadline**（佢塞住任何人嘅",
  "時間），喺 render 嗰刻讀「最新值」（late-bound，`organicBox`）。同一個 call、同一個計數、同一個",
  "fallback（null → 唔出線）；佢幾時答到，唔再由 chain 嘅時間決定。",
  "",
  "另外加 `/debug/jupiter?organic=<mint>`：用 worker 自己嘅 egress 行同一個 call，報讀數＋latency，",
  "一個 request 分清「冇窗」同「冇資料」——唔使再等下一個 push 循環。",
  "",
  "本地驗收：`npm run typecheck` clean、`npm run test:unit` **358 passed / 0 failed**（前值 357；新增",
  "一條 guard，順手更新兩條 pin 住三格 await 嘅舊 guard）。",
  "",
  "落線紀錄：`docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js`。",
  "",
].join("\n");

if (src.includes("## 4.24 有機度第三擊")) {
  console.log("skip docs/round-trips.md: §4.24 already present");
} else {
  fs.appendFileSync(file, SECTION);
  console.log(`wrote docs/round-trips.md (appended §4.24, ${SECTION.length} bytes)`);
}
