#!/usr/bin/env node
/*
 * Follow-up to tracker-own-invocation-doc-2026-09-27.apply.js: §4.38 should
 * say out loud why TRACKER_PASS_SUBREQ_RESERVE stays at 12 now that the pass
 * normally runs in its own invocation (a reader will ask).
 *
 * Run: node docs/patches/tracker-own-invocation-doc-reserve-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(file, "utf8");
const marker = "**落線紀錄：** `docs/patches/tracker-own-invocation-2026-09-27.apply.js`";

if (src.includes("**`TRACKER_PASS_SUBREQ_RESERVE` 照留 12")) {
  console.log(" = already applied");
  process.exit(0);
}

const NOTE = [
  "**`TRACKER_PASS_SUBREQ_RESERVE` 照留 12 —— 但佢嘅角色變咗。** 呢個常數係 scan 嘅窗口（`scanSubreqLeft`），",
  "以前係「留返畀 tick 尾嗰個 pass」。而家 pass 正常喺自己嘅 invocation ⇒ 呢 12 個係留畀**fallback**",
  "（第二條 trigger 冇派嘅時候）。唔收細佢係刻意嘅：真死 trigger 嘅話，fallback 就係主路徑，",
  "而 12 ＝ entry 3 ＋ tail 6 ＋ 一張卡 3 —— 就係「跑得完、出得一張卡」嘅最低消費（§4.37 之前嗰個",
  "「執剩單位數 ⇒ 0–1 張」形狀，正正係 12 以下）。健康形狀嘅代價係 scan 每 tick 讓 12 個（~3 個 pair batch、",
  "~90 隻幣）；如果 live 見到 scan 嘅 `subreqSkip` 上升、覆蓋跌，下一個槓桿就係**令呢個 reserve 條件化**",
  "（front 已經帶住 pass row，所以判斷唔使額外 round trip）。",
  "",
].join("\n");

const at = src.indexOf(marker);
if (at < 0) throw new Error("the 落線紀錄 anchor is missing — is §4.38 applied?");
const next = src.slice(0, at) + NOTE + src.slice(at);
fs.writeFileSync(file, next);
if (!fs.readFileSync(file, "utf8").includes("**`TRACKER_PASS_SUBREQ_RESERVE` 照留 12")) {
  throw new Error("the write did not verify");
}
console.log(" ✓ docs/round-trips.md: the reserve constant's new role is written down");
