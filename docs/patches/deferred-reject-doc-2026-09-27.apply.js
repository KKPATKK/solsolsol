// Verify-then-write: document the owed coin's reject slot.
const fs = require("fs");

const FILE = "docs/profiles-feed-zeros.md";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

const anchor = `驗收同代價：\`docs/tick-spend-and-profiles-2026-09-25.md\`。
`;

const section = anchor + `
---

# 後續（2026-09-27）：欠卡幣嘅拒絕原因 —— make-up lane 要一個 reject 份額

**症狀。** \`push_deferral.pending\` 由 05:51 起企喺 **1** 足足 95 分鐘，而所有健康計數器都正常：
\`deferObserved 1\`（每 tick 都有一個欠幣被審視）、\`deferPruned 0\`（冇退休）、\`misses 0\`（每 tick 都有 pair、
即係喺最闊窗 26 小時之內）。三個交付來源全部空：\`seen_tokens 0\`（從未 claim）、\`push_watch 0\`（從未追蹤）、
\`push_audit 0\`（從未送出；audit ring 覆蓋 23:41→07:23，包含 05:50）。即係：**筆債係真、make-up 路徑冇壞，
但冇一個讀數講得出邊個閘拒佢。**

**根因。** \`matchCoins\` 嘅 reject log 有 \`REJECT_LOG_MAX = 20\` 格，分兩份：pool slice 有保證份額
（\`feedBudgetStart = 20 − min(poolSlice, 20)\`），feed 幣只可以填最前嗰批。而 make-up lane 係
\`[...evaluated, ...makeup]\`（\`src/dexscreener.ts\`）—— **欠卡幣永遠排喺 feed 名單最尾**，所以每次都由
前面嘅新幣（一堆「流動性 ~$0」）食晒啲格 ⇒ 欠卡幣嘅拒絕就係永遠被剪走嗰條。佢偏偏係整個 log 最值錢嘅一條：
其他 entry 解釋「邊個幣冇卡」，佢解釋「邊筆債點解冇卡」。

**修法（三件，純觀測、零新 round trip、零閘改動）。**

1. **豁免**：\`logBudget && !owed && …\` —— owed 幣同 pool 幣一樣「一定可以記」。\`owed\` 讀一次
   （\`const owed = isDeferredToken(profile.tokenAddress)\`，測試釘住次數 === 1），令 make-up 判定同
   log 預算唔可能對「呢個幣係唔係欠」有第二個答案。
2. **標記**：entry 加 \`owed: true\`，讀數自己講「呢條係一筆欠債、呢個就係拒佢嘅閘」。
3. **份額（關鍵）**：豁免唔夠 —— 硬帽係**最先**檢查（\`rejects.length >= REJECT_LOG_MAX\` 就 return），
   所以 busy feed 一樣可以填晒 20 格再剪走佢。
   \`owedShare = max(0, min(DEFERRED_MAKEUP_MAX(8), pendingCount, 20 − poolShare))\`，
   而 \`feedBudgetStart = 20 − poolShare − owedShare\`。用 lane 自己嘅注入上限做界，亦唔會令預算變負。

**測試（1 條新，行為釘，唔係形式）。** 真 SQLite ＋ 真 Scanner ＋ 30 條 feed 幣 ＋ 一條 make-up 尾巴
（\`OWEDCOIN\`，經 \`addDeferredToken\` 註冊），一個只拒市值嘅 chat：斷言 \`rejects.length ≤ 20\`、
\`owed\` entry 出現一次、\`symbol === "OWED"\`、reason 係市值、而**被預算剪走嗰條 feed 幣仍然唔在**
（證明唔係單純加大 log）。Mutation（改 dist 再還原）：\`!owed\` → \`true\`、\`− owedShare\` → \`− 0\`、
\`{owed:true}\` → \`{}\`，各自令呢條測試 fail。

**驗收（deploy 之後）。** 只要 \`push_deferral.pending ≥ 1\`，\`/health.heartbeat.rejects\` 就應該出現一條
\`owed: true\` 嘅 entry，reason 就係嗰筆債等緊嘅閘；\`pending\` 清零之後應該再見唔到 \`owed\` entry
（冇債就冇豁免、份額亦唔會被佔）。
`;

patch("profiles-feed-zeros §owed-reject", anchor, section);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
