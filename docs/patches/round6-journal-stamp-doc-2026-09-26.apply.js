#!/usr/bin/env node
/*
 * Round 6 follow-up, the record: §4.34 — the journal that never landed.
 *
 * §4.33 shipped two fixes at 22:44:06Z. Nine minutes and four successful ticks
 * later the durable journal row was still absent, so this section records the
 * reading, the race that produced it, and the fix (see
 * docs/patches/round6-journal-stamp-2026-09-26.apply.js) — including the honest
 * note that the fix's live reading is still outstanding.
 *
 * Run: node docs/patches/round6-journal-stamp-doc-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(p, "utf8");

if (src.includes("### §4.34 ")) {
  console.log("= round-trips.md: §4.34 already present");
  process.exit(0);
}

const old = j(
  "落線紀錄：`src/dexscreener.ts`（`ProfileFeedSnapshot`／`parseProfileFeedSnapshot`／seed＋snapshot API）、`src/db.ts`（`DEX_PROFILES_LAST_KEY` 入 `SCAN_FRONT_GATE_KEYS`）、",
  "`src/scanner.ts`（front read seed ＋ front write journal）、`src/worker.ts`（slice 9 → 13）、`src/pushwatch.ts`（維護讓路）、`scripts/test-dex-last-profiles.js`（新）、`scripts/test-unit.js`。",
);

const next = old + "\n" + j(
  "",
  "### §4.34 個 journal 冇落地：fetch 快過 front read 就當「已經寫咗」（2026-09-26）",
  "",
  "**live 讀數（deploy 22:44:06Z 之後）：** 四次成功 tick（scan row `profiles 28`、`dex_list_cache_last: HIT`）＋九分鐘之後，",
  "`dex_profiles_last` 依然係 `-`（absent），而 `dex_list_cache_hits` 一直升（331 → 338）。即係 §4.33 ① 個 journal **冇落地**：",
  "條 list 冇跨過 isolate 邊界，43% 被拒嘅 tick 照舊只剩 make-up lane。",
  "",
  "**根因（唔係 DB，係 race）：** profiles fetch 係喺 front read **之前** dispatch（`profilesCall` 建喺 scanner.ts:2615，front read 喺 ~2734），",
  "所以 fetch 答得快 —— edge-cache HIT、或者任何快過 Turso 嗰 ~100ms round trip 嘅 200 —— 就會喺 front read 之前已經寫入 `dex.lastGoodProfiles`。",
  "而 seed 之後嗰句係讀 **client 自己嘅 live list**：",
  "",
  "```ts",
  "this.profileFeedStampedAt = this.dex.lastGoodProfilesSnapshot()?.at ?? null;",
  "```",
  "",
  "⇒ 嗰個 stamp 就係今個 tick 自己啲新 list，`stampProfileFeedSnapshot()` 見到 `snap.at === this.profileFeedStampedAt`，",
  "當成「row 已經有呢條 list」而 **skip 咗個 write**。只有「fetch 慢過 front read」嘅幸運 tick 寫得入 ——",
  "實測嗰次係 **22:56:11.553Z**（deploy 之後 12 分鐘，個 row 一有就會被 seed／reuse）。但因為 stamp 用錯來源，",
  "下一個快 tick 唔會刷新個 row，佢只會一路變舊，10 分鐘 reuse 窗一到，被拒嘅 tick 又跌返 `profiles 2`。",
  "",
  "**修法：** stamp 一定嚟自 **front read 讀到嗰行**（同 seed 共用同一個 parse），唔可以讀 client：",
  "",
  "```ts",
  "const profileFeedRow = parseProfileFeedSnapshot(",
  "  front.gates.get(DEX_PROFILES_LAST_KEY) ?? null,",
  ");",
  "this.dex.seedLastGoodProfiles(profileFeedRow);",
  "this.profileFeedStampedAt = profileFeedRow?.at ?? null;",
  "```",
  "",
  "咁兩邊都啱：row 唔存在 ⇒ 一定寫；row 就係今個 tick reuse 嗰條 list ⇒ 照 skip（唔會重覆寫自己）。",
  "寫入依舊騎住 tick 本身已經出嘅 front write（一張 ~1.2KB 嘅 REPLACE），**零新 round trip**。",
  "",
  "**驗證：** 新 test「a list fetched BEFORE the front read still journals (the live miss)」（fetch 快過 read 都要寫；",
  "同一條 row 再被 reuse 就照 skip）＋ wiring 兩條 pin（stamp 一定係 `profileFeedRow?.at`；舊嘅",
  "`this.dex.lastGoodProfilesSnapshot()?.at` 版本一定唔可以再出現），`npm run test:unit` **397 綠**、`npm run typecheck` 清、",
  "`wrangler deploy --dry-run` OK。",
  "",
  "**live 驗收（要 deploy 之後做）：** `dex_profiles_last` 應該**每個成功 tick 都刷新**（唔再靠慢 tick）；429 tick 嘅 scan row",
  "由 `profiles 2` 變返 `profiles ≈ 26`，即係 seed 條 lane 真係跨到 isolate。",
  "",
  "落線紀錄：`docs/patches/round6-journal-stamp-2026-09-26.apply.js`（apply script，verify-then-write）、`src/scanner.ts`",
  "（`profileFeedStampedAt` field doc ＋ seed 段）、`scripts/test-dex-last-profiles.js`（+1 條 test ＋ 2 條 wiring pin）。",
  "",
  "**② 嘅 live 讀數（同一時段，新 build）：** `ok:4/1 rows 4/30 … subreq-cut 25`（22:46:58Z）、`ok:5/1 … subreq-cut 25`（22:49:13Z）、",
  "`ok:11/0 rows 11/30 … subreq-cut 19`（22:58:13Z）；deploy 前同一形狀係 `ok:9/0 rows 9/30 … subreq-cut 21`。",
  "即係 slice 13 之後**每個 pass 出到 0–1 張卡**（之前 0 張），`heal-yield` 標籤同 `repair … fixed0` 都見到 = 新 build 真係行緊；",
  "但 19–26 行仍然帶卡被拒（backlog 遠大於一個 pass 清得完嘅量），所以下一條槓桿（claim＋reserve 合併，4 → 3／卡）",
  "照舊係真正嘅吞吐修法。",
);

const count = src.split(old).length - 1;
if (count !== 1) {
  console.error(`✗ round-trips.md: §4.33 anchor found ${count} times (need exactly 1)`);
  process.exit(1);
}
fs.writeFileSync(p, src.replace(old, next));
console.log("✓ round-trips.md: §4.34 appended");
