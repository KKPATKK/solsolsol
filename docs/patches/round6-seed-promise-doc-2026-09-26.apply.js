#!/usr/bin/env node
/*
 * Round 6.2, the record: §4.35 — the seed race, closed.
 *
 * §4.34 shipped a journal stamp that stays fresh. This section records what the
 * freshness exposed: the list was on disk but two ticks still read the make-up
 * lane alone, because the fetch had settled before the row was read. The fix
 * hands the row over as a promise; the live reading of it is still outstanding
 * (it needs the deploy this commit triggers).
 *
 * Run: node docs/patches/round6-seed-promise-doc-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(p, "utf8");

if (src.includes("### §4.35 ")) {
  console.log("= round-trips.md: §4.35 already present");
  process.exit(0);
}

const old = j(
  "**② 嘅 live 讀數（同一時段，新 build）：** `ok:4/1 rows 4/30 … subreq-cut 25`（22:46:58Z）、`ok:5/1 … subreq-cut 25`（22:49:13Z）、",
  "`ok:11/0 rows 11/30 … subreq-cut 19`（22:58:13Z）；deploy 前同一形狀係 `ok:9/0 rows 9/30 … subreq-cut 21`。",
);

const next = old + "\n" + j(
  "",
  "### §4.35 seed 個 race 收口：row 以 promise 交俾 fetch（2026-09-26）",
  "",
  "**live 讀數（`80e230b` deploy 23:04:02Z 之後）：** row 終於識刷新 —— `at` 23:04:08.5 → 23:07:19.9 → 23:08:25.1（修法前凍死 12 分鐘），",
  "23:12:06.8 嗰個被拒 tick 亦讀 `profiles 29`（26 reused ＋ 3 make-up，raw feed `lastRawProfiles 0 / failedTotal 1 / emptyFeedTotal 0`）。",
  "**但仍然有漏：** 23:10:10 同 23:11:15 兩個 scan row 讀 **`profiles 3`**（純 make-up），嗰陣 row 只係兩分鐘新 —— 即係 §4.33 個 caveat 應驗：",
  "fetch 快過 front read 就攞唔到 seed。特別係 429 之後 **client 自己嗰 90 秒 cache-only backoff**，令下一個 fetch **即時被拒**，幾乎一定輸俾 read。",
  "",
  "**修法（round 6.2）：** 個 row 改為以 **promise** 交過去，lane 嘅決定搬入 client，喺 row 已知之後：",
  "",
  "- **scanner**：front read 開成一條 promise（`const frontRead = this.db.readScanFront(SCAN_FRONT_GATE_KEYS)`，放喺 `enterScanMode()` 之後 —— 佢係 tick 嘅 round trip，要食 1.2s DB leash），",
  "  `const profileFeedSeed = frontRead.then(parse…)`，然後 `this.dex.fetchLatestSolanaProfiles(profileFeedSeed)` 照舊喺 tick 開頭 dispatch；",
  "  稍後同一個 tick 用 `await frontRead`、`await profileFeedSeed`（同一個 read、同一個 parse，seed 同 stamp 永遠一致）。",
  "- **client**：`fetchLatestSolanaProfiles(seed?)` **只喺 `failed || feed.length === 0`（即 exactly 佢會 fallback 嘅情形）先 await 條 row** ⇒ 健康 fetch 唔會為 Turso 等，",
  "  被拒 fetch 就得到 caller 已經讀到嗰條 list；row 壞／冇 ⇒ 等於冇 seed（best-effort，唔會 throw）。",
  "",
  "**刻意唔改嘅嘢：** dispatch 位冇搬遲（冷 isolate 嘅 feed 窗保住，見 2026-09-21 嗰次）、front read 仍然只得一句（`subreqs`／`dbSteps` 唔變）、",
  "`noteProfileFeed` 嘅 raw／failed／empty 讀數照舊、reuse 窗 `PROFILE_FEED_REUSE_MS`（10 分鐘）照舊。",
  "",
  "**驗證：** 3 條新 test（refusal 快過 row 都要 serve row；健康 fetch 唔會等 seed —— 用 race 令回歸變 fail 而唔係 hang；row read 壞 = 冇 seed）",
  "＋2 條 wiring pin（read 早過 dispatch、只得一個 `readScanFront`、stamp 同 seed 係同一條 promise）；`scripts/test-dex-last-profiles.js` 由 9 條變 **13 條**、",
  "`npm run test:unit` 全綠、`npm run typecheck` 清、`wrangler deploy --dry-run` OK。突變驗證（只改 `dist/dexscreener.js`，驗完即刻還原）：",
  "拆走 fallback await ⇒「…still served the ROW itself」fail；改成無條件 await ⇒「a healthy fetch never waits on the seed」fail。",
  "",
  "**live 驗收（要 deploy 之後做）：** 429 tick（連 cache-only 嗰種即刻拒）嘅 scan row 應該讀 `profiles ≈ 28`，唔會再有 `2`／`3`。",
  "",
  "落線紀錄：`docs/patches/round6-seed-promise-2026-09-26.apply.js`（client）、`docs/patches/round6-seed-promise-scanner-2026-09-26.apply.js`（scanner）、",
  "`src/dexscreener.ts`（signature ＋ fallback await）、`src/scanner.ts`（promise 化嘅 front read／dispatch）、`scripts/test-dex-last-profiles.js`。",
);

const count = src.split(old).length - 1;
if (count !== 1) {
  console.error(`✗ round-trips.md: §4.34 tail anchor found ${count} times (need exactly 1)`);
  process.exit(1);
}
fs.writeFileSync(p, src.replace(old, next));
console.log("✓ round-trips.md: §4.35 appended");
