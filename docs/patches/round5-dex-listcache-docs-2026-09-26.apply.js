#!/usr/bin/env node
/**
 * Round 5e, docs half: record the durable list-cache ledger in
 * docs/round-trips.md as §4.30 (the repo's running record of what changed and
 * why). Appended, never rewritten — the file is 155KB and other entries cite it.
 *
 * Run: node docs/patches/round5-dex-listcache-docs-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "docs", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

const ANCHOR =
  "落線紀錄：`docs/patches/round5-schema-ddl-gate-2026-09-26.apply.js`、`docs/patches/round5-column-probe-merge-2026-09-26.apply.js`。\n";

const SECTION = [
  "",
  "### §4.30 邊緣 cache 嘅 hit:miss 由 isolate 記憶變成 durable row（2026-09-26）",
  "",
  "**問題唔係 cache 壞，係讀數冇。** 想答「`LIST_FEED_CACHE_TTL_S = 60`（啱啱等於一個 tick）會唔會令 entry 喺下一 tick 問之前就過期」，",
  "就要 hit:miss 比；而 `listCacheHits` / `lastListCacheStatus` 係 **client 嘅 module state**，isolate 每 tick 換 ⇒ 一個 tick 讀到",
  "`listCacheHits 0、lastListCacheStatus null、http429 0、budgetDrops 0`，而同一 tick 明明 `profiles: 2`。即係修好咗都證明唔到，壞咗都睇唔到。",
  "",
  "**三件事落咗線：**",
  "",
  "1. **帳本搬去 module scope ＋ 加 misses。** 一個 accumulator（`hits` / `misses` / `status`），`getStats()` 由佢讀；delta 係同 baseline 嘅差。",
  "   一條規則決定乜嘢係 hit（`/^(HIT|REVALIDATED)$/i`），而**冇 `cf-cache-status` header 而家算 miss** —— 以前呢種回應兩邊都唔計，",
  "   即係一條永遠冇 header 嘅 lane 會喺讀數入面消失。",
  "2. **peek / consume ＋ per-part landed ack。** 掃描器 peek → 每行寫完先 commit 自己嗰部分：寫唔到嘅下一 tick 再交（唔會漏），",
  "   寫到嘅唔會寫第二次（唔會重複計）。剩低唯一損失寫明喺 code：**front 嗰個 batch 一寫就清空 buffer 且唔會重交**（見 `flushScanFront`），",
  "   所以一個 front 冇落地嘅 tick 會少一段窗口 —— 而嗰個 tick 嘅 summary 一樣冇咗，比例唔會因此偏。",
  "3. **寫入搭 tick 自己嗰個 front write（0 個新 round trip）**，而 delta 就喺 summary 拎 `dex:` 快照嘅同一點拎，所以 durable 行同頁面嗰個快照",
  "   講同一個窗口（pushWatch 一樣嘅 one-tick carry）。伺服器端三個 row：`dex_list_cache_hits` / `_misses`（ADD）＋ `dex_list_cache_last`（replace，",
  "   只喺 label 變咗先寫）。key 名由 `src/dexscreener.ts` export，寫嘅（scanner）同讀嘅（/health）**import 同一個常數**，唔會兩邊打錯字走樣。",
  "",
  "**/health 嗰邊 0 個新 round trip**：三個 key 加落今朝已經做咗嘅 `Db.readHealthFront` 嗰個 batch（一句 statement 加 key 唔加 request），",
  "數值照行 `parseTelemetryCounter` / `telemetryCounterUsable` 同一條規則，出 `dexListCache {hits, misses, hitPct, lastStatus}`。",
  "`null`（未有任何 tick 報過）同 `0/0` 係兩個讀數：ADD 係零根本唔會寫（見 `ScanFrontWrite.add` / `frontStamp`）。",
  "`src/db.ts` 嘅 `bumpTelemetryCounter` 由 private 變 public，做冇 front 時（standalone Scanner）嘅 ADD 路 —— 唔另開第二份 ADD SQL。",
  "",
  "**TTL 未改，係故意的。** 而家個數係數據問題而唔係理論問題，所以 guard（`scripts/test-deferred-priority.js` 釘死 60。",
  "佢個理由係「HIT 一定比 10 分鐘 reuse lane 新鮮」，同 hit:miss 冇衝突）照企，直到 durable 讀數顯示 `http429` 平穩而 misses 佔比明顯",
  "—— 即係 origin 被問係因為 entry 過期。嗰陣先改 60 → 180，同時更新 guard 同 `LIST_FEED_CACHE_TTL_S` 上面嘅 OPEN QUESTION。",
  "",
  "**測試**：`scripts/test-dex-list-cache.js`（7 條，已入 `npm run test:unit`）釘死：hit/miss 嘅定義（含冇 header 算 miss）、peek 唔會 advance、",
  "consume 只 commit 落地嘅行、兩條 ADD 真係經**真** `Db.writeScanFront` **累加**（1 + 2 = 3：replace 會靜靜變 2 然後永久少計）、零 ADD 唔寫 row、",
  "以及 /health 用 import 嘅常數而唔係字面值。另外 `test-deferred-priority.js` 嗰個 `listCacheHits === 1` 改成 baseline-relative —— 帳本由 client state",
  "變 module state（就係畀掃描器逐 tick journal 嘅前提），個位數固定 1 已經唔再成立。",
  "",
  "落線紀錄：`docs/patches/round5-dex-listcache-client-2026-09-26.apply.js`、`docs/patches/round5-dex-listcache-wire-2026-09-26.apply.js`、",
  "`docs/patches/round5-dex-listcache-health-2026-09-26.apply.js`。",
  "",
].join("\n");

if (src.includes("### §4.30 邊緣 cache 嘅 hit:miss")) {
  console.error("✗ §4.30 already present — nothing written");
  process.exit(1);
}
if (!src.endsWith(ANCHOR)) {
  console.error("✗ the file does not end where this patch expects — nothing written");
  process.exit(1);
}
fs.writeFileSync(file, src + SECTION);
console.log(
  `✓ docs/round-trips.md: §4.30 appended (${src.length} → ${src.length + SECTION.length} characters)`,
);
