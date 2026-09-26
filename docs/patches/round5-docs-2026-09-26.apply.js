#!/usr/bin/env node
/**
 * Round 5 docs (2026-09-26): append §4.29 to docs/round-trips.md.
 *
 * WHY A SCRIPT AND NOT AN EDIT: docs/round-trips.md is 151KB, past the file
 * tools' editing window, and the same is true of every doc this repo appends a
 * numbered section to — the sections are long, the files never shrink, and the
 * append has to land AFTER the previous section's last line or the numbering
 * reads out of order. That is an anchor check, so it belongs in a script that
 * refuses to write when the anchor is missing (a doc edit that half-applies is
 * worse than one that does not apply: §4.29 appearing above §4.28 would still
 * look like a section).
 *
 * Run: node docs/patches/round5-docs-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "round-trips.md");
const src = fs.readFileSync(file, "utf8");

/** The last line of §4.28 — what this section is appended after. */
const ANCHOR = "7 剩 → 頭行照樣出卡。";
/** Guards against running twice on a file that already has the section. */
const MARKER = "### §4.29 tick 嘅 CPU";

const SECTION = `
### §4.29 tick 嘅 CPU：DDL 指紋閘 ＋ 欄位探測合併（2026-09-26）

**先更正一個舊結論。** \`docs/scan-completion-loss.md\` 2026-09-23 嗰段把 dead tick 歸因 subrequest 上限。Cloudflare 自己嘅 analytics
（查法見 \`.github/workflows/cf-invocations.yml\`）講嘅係另一件事：12 小時 3,491 個 invocation 裏面 36 個 \`exceededResources\`，時段同
scan-history 嘅 dead row 一一對上（09:28–09:38 = 10 個 = HKT 17:38 嗰個「連續 10 分鐘冇完成落地」告警），而嗰啲被殺嘅 invocation
只用了 **2–37 個 subrequest**（上限 50）、**≤ 12.4 MB memory**（上限 128 MB）。唯一釘死喺上限嘅係 **CPU：cpuTime 10,000 µs
= Workers Free 嘅 10 ms**，而同一分鐘冇被殺嗰啲讀 13,000–187,000 µs —— 官方講嘅 flexibility 一收，就整分鐘整分鐘殺（每分鐘剛好
1 個，所以「掃描其實仍在運行、丟失嘅係完成寫入」呢句告警用字完全準確）。

**邊個 phase 貴。** Worker 自己嘅 telemetry 只有 wall clock，冇 CPU 維度（\`feedsMs\`／\`poolMs\`／\`evalMs\`／\`pushPhaseMs\` 分唔開
「慢」同「忙」），所以改用 \`scripts/cpu-profile.js\`（唯讀：真上游 payload ＋ repo 自己嘅 parser ＋ production Turso 嘅真 read）。
結論同預期相反：一個 libsql round trip 就算只回 **46 bytes 一行**都要 **2.4–5.8 ms CPU**（一次讀 6 個 key 幾乎一樣 ⇒ 係 per-call，
唔係 per-row），而個 tick 做 ~20–30 個 round trip ⇒ **60–120 ms** —— 大過所有 feed parser 加埋（13 ms）一個數量級。所以呢輪砍嘅係
**round trip 嘅次數**，唔係邊個 feed。

**兩刀（都係 cold isolate 專屬，零覆蓋損失）：**

1. **DDL 指紋閘**。\`init\` 嗰 18 句 \`CREATE … IF NOT EXISTS\` 以前每個冷 isolate 都重跑，量到 **46–189 ms CPU**：tick 最貴嘅單一項。
   而家先 read 一個細 row（\`worker_state.schema_ddl_fingerprint\`，~46 B），同當前 DDL 指紋一樣就唔跑個 batch。指紋由 \`ddl\` 陣列
   本身算（\`schemaFingerprint\`，FNV-1a，8 hex），所以改／加／搬一句都會自動破閘 —— 手寫版本號終有一日會被漏掉嘅失敗，喺呢度路唔通。
   讀取失敗（從未初始化嘅庫）都當唔匹配，即係正正要跑嗰陣。實測真 Turso：**92.2 ms → 9.8 ms**（同一程序內第一次 vs 第二次 init）。
2. **欄位探測合併**。\`addColumnIfMissing\` 以前逐個 column 撞一次 \`ALTER TABLE\`，靠 \`duplicate column name\` 當答案 —— 每個冷 isolate
   一次 round trip × ~12 個（26 個 call site：token_stats 15、chat_settings 7、push_watch 4）。而家一次 batch 讀
   \`SELECT name FROM pragma_table_info(?)\`（\`COLUMN_PROBE_TABLES\` 三張表，實測回 **54 欄**）＋ isolate 內 Set cache，之後 25 個 call 免費。
   降級方向刻意係**舊行為**：讀唔到 ⇒ 照樣逐個 ALTER（重複照吞）；表唔喺名單上 ⇒ 只係 miss cache。

\`scripts/test-schema-gate.js\`（6 條，已入 \`npm run test:unit\`）釘死：指紋對任何一句改動都變、跨句邊界搬字都變、第二次 init
**零 \`ALTER TABLE\`** 同 **零 DDL batch**、指紋唔啱照跑、從未初始化嘅庫照跑，以及 \`COLUMN_PROBE_TABLES\` 覆蓋所有 call site 嘅表。
量測嗰兩條腿留喺 \`scripts/cpu-profile.js\`：raw \`/v2/pipeline\` 嘅 **bound vs literal 對照** —— bound 參數喺 table-valued pragma 入面
係窄啲嘅形狀，靜靜回**少**欄位就會令 round trip 悄悄返嚟（而 pipeline 嘅 \`Value\` 係 internally tagged enum，所以嗰條腿要手寫
\`{type:"text",value:…}\`；兩個版本嘅錯誤計法同 3052 B 嘅真回應樣本一齊記喺 \`countPipelineRows\` 上面）。

**天花板照舊要講清楚**：加埋大概砍 40–50%（tick 由 36–187 ms 落到 ~20–100 ms），仍然係 10 ms 上限嘅 2–10 倍。Paid（cron CPU 10 ms
→ 30 s）係唯一完整解；呢兩刀係未升級前減低突發頻率同嚴重度。

落線紀錄：\`docs/patches/round5-schema-ddl-gate-2026-09-26.apply.js\`、\`docs/patches/round5-column-probe-merge-2026-09-26.apply.js\`。
`;

const problems = [];
if (src.includes(MARKER)) problems.push("§4.29 is already in the file — nothing to do");
if (!src.includes(ANCHOR)) problems.push(`anchor ${JSON.stringify(ANCHOR)} not found (§4.28's last line)`);

if (problems.length > 0) {
  console.error("NOT APPLIED — nothing written:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

fs.writeFileSync(file, src.trimEnd() + "\n" + SECTION, "utf8");
console.log(`appended §4.29 to docs/round-trips.md (${src.length} → ${fs.statSync(file).size} bytes)`);
