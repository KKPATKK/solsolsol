#!/usr/bin/env node
/**
 * Take docs/tier2-2026-09-28.md out of orbit.
 *
 * The Tier 2 write-up has been untracked since the day it was written, and it
 * linked to nothing while nothing linked to it — the measurement record of a
 * negative result that only survived in two code comments. Two edits fix that:
 *
 *   1. docs/round-trips.md gets a closing note saying these dials are NOT a
 *      round-trip story (they add no request, host or bucket) and pointing at
 *      the record. Placed there because that doc is where a cost-auditing
 *      reader lands and it is already the day's cross-referenced hub.
 *   2. the Tier 2 doc gets the same "> 相關：" header the other docs in this
 *      repo open with, so the link runs both ways.
 *
 * Anchored + marker-guarded + idempotent: re-running prints "=".
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function sub(file, label, anchor, replacement, marker, append) {
  const target = path.join(root, file);
  const src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${file} :: ${label} (already applied)`);
    return;
  }
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${file} :: ${label} — anchor hits = ${hits} (want 1)`);
    failures += 1;
    return;
  }
  const next = append ? src.replace(anchor, () => anchor + replacement) : src.replace(anchor, () => replacement);
  fs.writeFileSync(target, next);
  console.log(`✓ ${file} :: ${label}`);
}

// 1 — the inbound pointer, appended as the doc's closing note.
sub(
  "docs/round-trips.md",
  "the closing note that points at the Tier 2 record",
  `- 證據要留住：Cloudflare 分析 API 嘅 Free 保留期短，\`scripts/cf-invocations.mjs\` 繼續留（Paid 之後一樣可以
  當佢係「有冇 tick 又封頂」嘅探針）；\`.github/workflows/cf-invocations.yml\` 個 \`schedule:\` 就係為咗呢件事
  而暫時存在。`,
  `

---

## 唔屬於呢條線：同日嘅兩個 feed dial（2026-09-28 Tier 2）

同日另一批改動係兩個 discovery feed 嘅 cap：\`JUPITER_RECENT_LIMIT\` 20 → 30（生效，\`jup 30\`）同
\`DEXSCREENER_BOOSTS_LIMIT\` 20 → 30（量出嚟係 no-op，\`boosts 17\` 改前改後一樣）。

**佢哋同 round trip 無關，所以唔屬於上面任何一節**：兩個 list 本來就每 tick 都抓，改 cap 唔加 request、
唔加 host、唔加 rate-limit bucket（實測 \`dex.http429\` 0、\`budgetDrops\` 0、\`blockedForMs\` 0）。
完整量度（成本表、p50、以及 boosts 嗰個**負面結果**嘅成因：上游 30 行係跨鏈，client 先 filter \`solana\`
後 slice）記錄喺 \`docs/tier2-2026-09-28.md\`。`,
  "## 唔屬於呢條線：同日嘅兩個 feed dial",
  true,
);

// 2 — the outbound header, matching the convention the day's other docs open with.
sub(
  "docs/tier2-2026-09-28.md",
  "the 相關 header",
  `# Tier 2 (2026-09-28): two feeds that discarded rows they already held

Both discovery lists answer more rows than the tick kept, so the question was`,
  `# Tier 2 (2026-09-28): two feeds that discarded rows they already held

> 相關：\`docs/round-trips.md\`（尾段「唔屬於呢條線」一節 —— 呢兩隻 dial 唔加任何 round trip）、
> \`docs/patches/tier2-feeds-2026-09-28.apply.js\` ＋ \`…-fix-…\` ＋ \`…-tests-…\` ＋ \`…-docfix-…\`（逐條 edit）、
> \`src/config.ts\`（boosts 嗰個負面結果嘅正式註解，commit \`92b9efe\`）、\`scripts/test-unit.js\`（\`jup 30\` 嘅 pin）。
> 落線：commit \`e15f570\`，version \`261abe89-ef13-4112-935a-1c674b477ff2\`。

Both discovery lists answer more rows than the tick kept, so the question was`,
  "唔屬於呢條線」一節 —— 呢兩隻 dial 唔加任何 round trip",
  false,
);

console.log(failures === 0 ? "\nboth directions linked" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
