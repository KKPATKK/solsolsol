/**
 * Record the 2026-09-23 21:14-23:56Z dead-tick resample.
 *
 * WHY A SCRIPT: docs/duplicate-cards.md (~62KB) and docs/round-trips.md (~54KB)
 * are both past the file-tool edit window, so this applies the two insertions
 * the same way the other docs patches in this directory do: verify every anchor
 * matches EXACTLY ONCE first, write nothing unless all of them do, and be
 * re-runnable (a section that already exists is reported ALREADY, not an error).
 *
 * Run: node docs/patches/deadtick-resample-2026-09-23.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");

const SECTION_18_5 = `
### 18.5 2026-09-23 21:14–23:56Z 重取樣：慢滴跌咗，楔形冇跌（17 分鐘內 17 條）

**問**：§17.6 嘅 span hold（\`47ebcfc\` 17:08Z）同 \`docs/round-trips.md\` §4.7 嘅 grouped telemetry
（\`2a6de9a\` 16:43Z）之後，dead-tick 形狀有冇移動？

**窗**：18:01Z 之後冇人手 polling，所以 21:14:17 → 23:56:15Z 呢個 120 行 ring 係迄今最乾淨嘅
「靜默」樣本（151 分鐘）。全部讀數來自 \`/debug/scan-history\`。

| 窗 | 長(min) | dead | 率 | \`ms>=100000\` |
|---|---|---|---|---|
| §18.2 04:44–05:17 | 33 | 10 | 18/h | 1 |
| §5.1 13:52–14:17 | 145 | 21 | 8.7/h | 3 |
| 16:53Z 樣本 | 134 | 12 | 5.4/h | 1 |
| **今晚 21:14–23:56** | **151** | **22** | **8.7/h** | **0** |

**但總率呃人，要拆兩截**（呢個係今晚最重要嘅發現）：

* **慢滴 21:14:17 → 23:26:27（132 min）：5 條 = 2.3/h**（21:35:12、22:16:15、22:38:17、23:01:22、
  23:02:27；全部單條或一對）。比 16:53Z 之前嘅 5.4–8.7/h **跌 2–4 倍**，而 **6 位數偵測延遲
  由每窗 1–3 條變 0 條**：全窗 dead 行 \`ms\` 47k–92k，即每條死 tick 都喺下一秒（60s）就有
  successor 幫佢落 backfill row，冇再出現 100–111s 嘅延遲。OK tick 嘅 \`ms\`（98 條）= min 810 /
  中位 2454 / max 4201。
* **楔形 23:26:27 → 23:43:37（17.2 min）：17 條 = 59/h**，期間**零成功掃描**。22 條裡面 17 條係
  呢一舊。形狀同 2026-09-08／09-19 嘅「中毒 isolate」一樣：claim 贏咗、heartbeat
  \`phase:"scanning"\` 落到、完成 flush 冇。同 §18.3 嘅假設唔同：**唔係 subrequest 爆** ——
  楔形中兩輪生還嘅 tick（23:36:18 = 3.9s；23:45:13 = 3.7s）subrequest 窗係
  **total 30（turso 18 + dexscreener 7 + gecko 2 + jup 2 + gmgn 1）**，離 50 上限仲有 20 條。
* 楔形**無 deploy 喺附近**（最後一次係 17:12Z），亦**自己散**（~23:44，無人碰過）；
  23:47:28 → 23:56:10 連續 7 輪 OK（2.2–3.0s）。
* 楔形期間死嘅 tick 兩種驅動都中：頭 10 條全部貼 cron 節拍（\`:27.1\`–\`:27.2\`，cron arrival
  \`:26.87\`），之後有**非 cron 節拍**（\`:37:19\`、\`:38:24\`、\`:39:24\`、\`:40:28\` —— 疑似外部
  \`/health\` monitor／診斷讀取驅動）；兩輪生還者（\`:36:18\`、\`:45:13\`）都係非 cron 節拍。
  ⇒ **「cron 死、HTTP 活」係未證實嘅線索，唔係結論**（到達記錄喺下面凍結埋，分辨唔到）。
* \`cut:watchdog\` 喺成個 payload **0 次**（§17.5 講嘅「8 秒 watchdog 從來冇響過」今晚再確認）。
* **新讀數（pass 終結寫入）**：楔形中兩輪生還嘅 tick 各自留低一條**唔會終結**嘅
  \`pushWatchPass\`（\`phase:"running"\`、\`trackerMs 0\`、\`at\` = tick 起點 +0.26s／+0.64s），
  之後 23:46／23:47／23:49 三輪 OK 都冇覆寫佢 —— 即係 tick 自己嘅 row 落到（ok、3.7s），
  **pass 嘅終結寫入冇落**。到 23:54:24 嗰輪回復正常：\`phase:"done"\`、\`trackerMs 3398\`、
  \`trips 12 db 1950ms\`。呢個係 §17.3／§17.5「pass 唔 return」形狀**第一次有 live 證據**，
  而同一時間 **8 秒 watchdog 冇寫 cut**（同一輪 OK 之後 invocation 已完）。
* \`outageAlertAt\` = **23:39:22.197Z**（楔形第 13 分鐘）：durable 嘅 no-completion 記錄有 stamp，
  即係 ⚠️ 告警路徑冇死。
* \`gaps\`：兩段（22:52:21→22:54:28 = 127s；21:46:14→21:48:16 = 122s）。
* **順手再中一次 §4.5 未做第一項**：\`scheduledTickAt\`／\`scheduledTickTotal\`（54846）／\`tickRing\`
  由 **23:43:26.871** 起凍結（到 23:56:15 最少 13 分鐘），同一時間 scan row 照落 ⇒ 到達記錄同
  掃描係可以各自獨立停／行。

**判斷**（老實講）：

1. **慢滴有移動**（2.3/h、0 條 6 位數）—— 方向對，但只有一個窗、5 個事件，未夠力話係切造成
   （可能係時段差異）。
2. **楔形冇移動，而且主宰總數**（22 條中 17 條）；同 §18.2／§18.3 一樣係「claim 落到、flush 冇」，
   而且今次量到生還者係 30/50 ⇒ 唔係 subrequest 上限。
3. **兩個 cut 幫唔到楔形，亦唔係楔形成因**（楔形起／散都無 deploy）。
4. 未收：pass 終結寫入冇落（新形狀，tick 本身 ok）、8 秒 watchdog 對呢個形狀都唔響、
   cron 到達記錄再次凍結（§4.5 第一項）。
`;

const SECTION_5_2 = `
### 5.2 dead-tick 形狀重取樣（2026-09-23 21:14–23:56Z，讀數喺 \`docs/duplicate-cards.md\` §18.5）

§4.7／§17.6 落線之後最乾淨嘅一個靜默窗（151 分鐘、120 行 ring）：**慢滴由 5.4–8.7/h 跌到 2.3/h**
（21:14→23:26，5 條），**6 位數偵測延遲 0 條**（baseline 每窗 1–3 條）；但 23:26:27 起有一個
**17 分鐘楔形**（17 條 dead、零成功掃描），佢**無 deploy 喺附近、自己散**，同切唔切冇因果。
生還 tick 嘅 subrequest 窗係 total 30（turso 18）—— 亦即「正常一輪離 50 上限仲有 20 條」。
詳見 §18.5。
`;

/** Insert `text` after `anchor`, which must appear exactly once. */
function applyEdit(relPath, marker, anchor, text) {
  const abs = path.join(root, relPath);
  let content = fs.readFileSync(abs, "utf8");
  if (content.includes(marker)) {
    console.log(`ALREADY  ${relPath}  (${JSON.stringify(marker)})`);
    return;
  }
  let count = 0;
  let at = content.indexOf(anchor);
  while (at !== -1) {
    count += 1;
    at = content.indexOf(anchor, at + anchor.length);
  }
  if (count === 0) {
    console.error(`MISS     ${relPath}  anchor not found: ${JSON.stringify(anchor)}`);
    process.exitCode = 1;
    return;
  }
  if (count > 1) {
    console.error(`AMBIGUOUS ${relPath}  anchor matched ${count}x: ${JSON.stringify(anchor)}`);
    process.exitCode = 1;
    return;
  }
  const insertAt = content.indexOf(anchor) + anchor.length;
  content = content.slice(0, insertAt) + text + content.slice(insertAt);
  fs.writeFileSync(abs, content);
  console.log(`OK       ${relPath}  inserted ${text.trim().split("\n")[0]}`);
}

applyEdit(
  "docs/duplicate-cards.md",
  "### 18.5 2026-09-23 21:14–23:56Z 重取樣",
  "讀法照 §11.3（唔可以只睇 note：note 嘅寫入本身就係會爆預算嗰批）。",
  SECTION_18_5,
);

applyEdit(
  "docs/round-trips.md",
  "### 5.2 dead-tick 形狀重取樣",
  "即係 push 檢查／卡片路徑照跑，問題集中喺「invocation 預算」同「cron 到達信號」。",
  SECTION_5_2,
);

if (process.exitCode) {
  console.error("\nNothing written for the failed anchors — fix them and re-run.");
} else {
  console.log("\nDone. Verify with: git diff --stat");
}
