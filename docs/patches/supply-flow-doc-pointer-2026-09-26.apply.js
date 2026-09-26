#!/usr/bin/env node
/**
 * Supply-flow doc pointer: appends §4.22 to docs/round-trips.md. The file is far
 * past the file tool's edit window, so this is an append with an idempotency
 * check (the section heading) instead of an anchor replacement.
 *
 * Run: node docs/patches/supply-flow-doc-pointer-2026-09-26.apply.js
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
  "## 4.22 供應流（🕸）落閘：卡片冇咗條線，檢查亦唔再跑（2026-09-26）",
  "",
  "卡片上嘅 `🕸 供應流` 係 legacy enrichment 群嘅第三條線（Bundler / Top10 / 供應流）。",
  'AXIOM_ENABLED = "0"（2026-09-19）之後 Axiom summary 唔再頂替嗰個群，所以條線又出現喺每張卡；',
  "而佢背後係全張卡最貴嘅一步：每個 coin 一次 Helius 分析（`getTokenLargestAccounts` ＋",
  "`getTokenTransfers`，~10 RPC，受 `SUPPLY_FLOW_BUDGET_MS` 限），加一個 `token_stats` 寫入，",
  "每 `SUPPLY_FLOW_REFRESH_MIN` 對每個 coin 再跑一次。",
  "",
  '落閘：`SUPPLY_FLOW_ENABLED = "false"`（wrangler.toml，operator 唔想再見到條線）。',
  "",
  "- **分析半邊**：`resolveSupplyFlow` 喺 `!cfg.enabled` 即刻 return `unknown` —— 冇 RPC、冇 budget",
  "  計算、冇 write（呢個 gate 本身已經存在，唔使改）。",
  "- **顯示半邊**（今次新增）：卡嘅 `supplyFlowClean` 由 `boolean` 變 `boolean | null`；`null` ＝",
  '  停用 ＝ **成條線唔出**（唔係印「—（未分析）」placeholder），scanner 停用時傳 `null`。同一',
  "  「no data, no line」立場 GMGN / Arkham / crime 一向用開。",
  "",
  "代價（講明）：只有 CONFIRMED flag 才會擋推，而嗰個 block 都跟住冇 —— 本來會被擋嘅 coin 而家照推，",
  '形狀同今日「未分析」卡一樣（detector 一向 best-effort，從來唔係 gate）。手動 `/flow` 指令照用：',
  "analyzer 用到才建，唔用零成本。",
  "",
  "本地驗收：`npm run typecheck` clean；`npm run test:unit` **356 passed / 0 failed**（前值 354；",
  "新增一條行為測試 —— `null` ＝ 冇線、`false`/`true` 照舊 —— 同一條 source-shape guard；並更新",
  "`drop-card-birdeye-lines` guard 嘅簽名斷言）；`npx wrangler deploy --dry-run` 見到",
  '`env.SUPPLY_FLOW_ENABLED ("false")`。',
  "",
  "落線紀錄：`docs/patches/disable-supply-flow-2026-09-26.apply.js`。",
  "",
].join("\n");

if (src.includes("## 4.22 供應流")) {
  console.log("skip docs/round-trips.md: §4.22 already present");
} else {
  fs.appendFileSync(file, SECTION);
  console.log(`wrote docs/round-trips.md (appended §4.22, ${SECTION.length} bytes)`);
}
