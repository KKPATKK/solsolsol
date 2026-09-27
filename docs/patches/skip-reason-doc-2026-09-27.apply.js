// Verify-then-write: document the tick-level skip reasons.
const fs = require("fs");

const FILE = "docs/scan-completion-loss.md";
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

// NOTE: this file's last line carries no trailing newline in the repo, so the
// anchor must not either — the section supplies its own separators.
const anchor = `修正：\`/health.scheduledTickHoleMs\` —— 距離上一次 cron tick claim 幾久，一個有 threshold 嘅數字（健康 60s 節奏讀 60–120s）。`;

const section = anchor + `

---

# 2026-09-27：tick 到咗但冇掃描 —— 每一層都講返自己點解

## 量度（live，07:35–08:20Z）

| 時間 | 形狀 |
|---|---|
| 07:38:35 前 | 完美 60s 節奏 |
| **07:39:32** | 一行 \`ok:false\`、\`ms 132430\`（132 秒）嘅 completion —— 異常起點 |
| 07:41:49 → 08:11:14 | **~2 分鐘一次**（14 個 ≥90s 洞，最大 170s）；期間每個 completion 都 \`ok:true\`、ms 1.3–4.4s |
| 08:12:36 後 | 回復 60s |

排除咗嘅：cron ring 每 60 秒一個（max gap 63.9s，投遞正常）；\`crossIsolateScanSkips 0\`、
\`deadTickStreak 0\`、\`skipCapture.total 0\`、heartbeat \`skip: null\`、\`scheduledArrivalTotal\` 全窗只 +4
（佢專門數「前一個 tick 冇返嚟」）。即係：2 分鐘週期裡面中間嗰個 arrival **到咗 handler、但冇任何痕跡** ——
冇 completion、冇 skip 計數、冇 log 讀得到（Cloudflare log 我哋睇唔到）、冇 durable 記錄。

## 根因（可供性缺口，唔止一層）

掃描唔行嘅路徑有四條，而**全部**都靜默（或者只 log 落 Cloudflare 而我哋冇 reader）：

| 層 | 路徑 | 之前嘅痕跡 |
|---|---|---|
| scheduled handler | init 被切／失敗 ⇒ \`!scanner\` ⇒ 記錄 arrival 之後 return | **零**（只得一個 arrival bump） |
| scheduled handler | cadence gate（\`scanGateMs\`）skip | 一行 log（睇唔到）|
| \`runScan\` | \`if (!scanner) return;\`（HTTP／manual 路徑） | **零** |
| \`runScan\` | 跨 isolate lease 輸咗 | \`crossIsolateScanSkips\`（module state，只喺服務 /health 嗰個 invocation 見到）|
| \`Scanner.runOnce\` | \`previous-scan-still-running\`／\`no-chats-enabled\`／\`empty-feed-and-pool\` | ✅ 已有（skipCapture 攔截器）|

## 修法：同一個讀數，四條路徑一齊報（純觀測、零額外 round trip）

\`src/skipcapture.ts\` 加 \`noteSkipReason(reason)\`：寫入同一個 capture（同一組 counters、同一個
snapshot、同一條 durable row），所以「呢個 tick 點解冇做嘢」只有一個答案，唔理佢喺邊層停。

- 理由名：\`init-no-scanner\`（handler 同 runScan 兩處）、\`cron-gate\`、\`scan-lock-lost\`。
- **零額外 round trip**：delta 騎**下一個成功 completion 嘅 tail 寫入**（同 scanner 自己嘅理由一樣，
  一個 read ＋ 一個 write，而且係一個已經喺度嘅 write）。
- **install 要保留**（關鍵）：\`init-no-scanner\` 正正發生喺「未建過 scanner」嘅 isolate，所以 capture 要
  lazy 建立；而舊版 \`installSkipCapture\` 每次都**重新建立** capture（＋重設 persist baseline）⇒ 下一個
  tick 建 scanner 嗰下就會靜靜哋丟走嗰個理由。現在 install 保留 capture 同 baseline（baseline 一直追住
  「已落地嘅數」，所以保留佢唔會重覆計）。
- \`/health.heartbeat.skip\` / \`skipAt\` 同 \`skip_capture\` row 即刻多咗呢四個理由，\`skipAt < at\` 嘅舊語意
  不變（理由永遠唔會無中生有）。

## 測試（2 條新：1 行為 ＋ 1 source pin）

- 行為：\`noteSkipReason\` 喺**未 install** 時記錄 → 之後 \`installSkipCapture\` 保留 → delta 照樣欠
  durable row → scanner 自己嘅理由加入同一個 counters → 落地之後 re-install 唔會 re-offer 舊數 →
  空字串唔算理由。
- Source pin（whitespace-squashed，\`indexOf\`/slice 形式，避免被註解搞到脆弱）：四條 call site 各自喺
  自己嘅分支（gate 由 log 到 \`writeScheduledTick\` 之間、lease 由 log 之後 400 字、handler 嘅
  reason→\`bumpScheduledTickLegacy\`、runScan 嘅 reason→\`return\`），加 install 保留嘅寫法。

**Mutation（改 dist／src 再還原）**：install 改返「重新建立 capture」⇒ 3 條測試 fail（包含新嗰條）；
抽走 \`cron-gate\` reason ⇒ pin fail；抽走 handler 嘅 reason ⇒ pin fail。

## 驗收（deploy 之後）

1. 60s 模式下 \`skip_capture.counts\` 應該**主要係 0**（gate 好少咬）；\`init-no-scanner\`／\`scan-lock-lost\`
   一出現就係真事，而且**有數字可追**。
2. 再有「arrival 到咗但冇 scan」嘅窗口，\`/health.heartbeat.skip\` 會直接講邊個理由（唔再係 \`null\`）。
3. 90s／120s 模式：\`cron-gate\` 應該約等於 skip 嘅比例（半數／三分二），令「gate 做緊嘢」同
   「tick 死咗」喺同一個讀數上分得開。
`;

patch("scan-completion-loss §skip reasons", anchor, section);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
