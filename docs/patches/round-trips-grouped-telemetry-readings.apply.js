#!/usr/bin/env node
/**
 * Record the grouped post-scan telemetry deploy in docs/round-trips.md: §4.7.1
 * (the live readings) plus the deploy itself in §5's lists.
 *
 * An apply script because the anchors sit past the file-tool window.
 */
const fs = require("fs");

const T = "docs/round-trips.md";
const lines = (...xs) => xs.join("\n");

const anchor = "## 5. 驗證狀態（本地 + 上線）";

const section = lines(
  "#### 4.7.1 上線後讀數（deploy `2a6de9a`，run 35890757964 **success** 1m20s，2026-09-23 16:43–16:47Z）",
  "",
  "1. **durable 半真係寫到落去**：`/health.birdeyeCu` 由 §4.5.2 抽樣嗰陣嘅 `monthCu 0 / pendingCu 40`",
  "   一路升 —— 連續三個樣本係 `today 80 / monthCu 80 / pendingCu 0` → `120 / 120 / 0`。呢個係",
  "   **grouped batch write** 落地嘅直接證據（三個 sync 嘅 row 而家係同一個 `batch` 出街）；",
  "   `pendingCu 0` 亦代表 charge 之後 flush 有追得上（唔再係「手動 probe 嘅 isolate 唔會掃描」嗰個卡住形狀）。",
  "2. **cron 到達記錄冇再停**：`scheduledTickTotal 54620`、`scheduledTickAt 16:46:26.898Z`，而 `now` 係",
  "   16:47:03Z ⇒ 每個 tick 都前進。§5.1 第 3 點嗰個「`scheduled_tick_total` 凍住」**今次冇出現** ——",
  "   但呢個係觀察而唔係已修（§4.5 未做第一項照舊）。",
  "3. **死 tick 冇再出現**：120 行 scan-history ring 嘅 dead row 係 **0**（§5.1 抽樣係 21–24 條），",
  "   而 `ms >= 100000` 只有 **1 條**，時間戳 15:17:25Z —— **早過今次 deploy**（16:43Z），即係新",
  "   deploy 之後冇再出 6 位數 ms；`cut:watchdog` 亦冇出現。最近六條 row 嘅 `ms` 係 2221–2638（正常）。",
  "4. **pass 正常**：`/debug/scan-history.pushWatchPass` 係 `phase:\"done\"`，note 尾段",
  "   `… spend[setup 239/2 heal 249/1 … rows 858/5 holders 2564/0 held0 cut3 probe1 miss1] trips 11 db 1217ms`",
  "   —— 冇 `err:`、冇 `cut:watchdog`；`/debug/push-watch.issueCount` = **3**，三條都係舊 row",
  "   （REALLY 04:16Z、APECAT 01:41Z…），同今次 deploy 無關。",
  "5. **老實講：per-tick 嘅 turso 計數今次證明唔到**。`/health.heartbeat.subreqs` 抽到嘅 window",
  "   turso 數係 8／24／25／27／41，而 total 係 18／35／36／39／56 —— 變異大到冇辦法喺 /health 上",
  "   認出「邊個 window 係 5 分鐘邊界嗰個」（counter 冇 stamp「今次有冇跑 telemetry」）。所以「少 4–7 個",
  "   request」呢句**只由 unit test 釘住**（一個 counting client 度到整個讀係 1 個 call、寫係 1 個 call），",
  "   live 冇獨立證據。要 live 量就要喺 window 入面加一個 telemetry 讀數（下一刀）。",
  "",
  anchor,
);

const deployTail =
  "  CU 帳簿）→ run 35863485480 **success**（1m21s，12:54:28Z）✅";
const deployNew = lines(
  "  CU 帳簿）→ run 35863485480 **success**（1m21s，12:54:28Z）✅；`43c6f2c`／`cc333db`（§4.6",
  "  subrequest counter ＋ host split）→ run 35881957854／35886716005 **success**✅；`2a6de9a`（§4.7",
  "  grouped telemetry）→ run 35890757964 **success**（1m20s，16:43:47Z→16:45:07Z）✅",
);

const readingsTail =
  "  §4.5.2（CU 帳簿：charge 半已證、durable 半未證）、§5.1（note／history 觀察）";
const readingsNew = lines(
  "  §4.5.2（CU 帳簿：charge 半已證、durable 半未證）、§4.6.2（subreq counter：DB 佔 63–83%）、",
  "  §5.1（note／history 觀察）、§4.7.1（grouped telemetry：durable 半已證）",
);

let text = fs.readFileSync(T, "utf8");
if (text.includes("#### 4.7.1 上線後讀數")) {
  console.error("ALREADY   round-trips: §4.7.1");
  process.exit(1);
}
for (const [what, needle] of [
  ["the §5 heading", anchor],
  ["the §5 deploy tail", deployTail],
  ["the §5 readings tail", readingsTail],
]) {
  const at = text.indexOf(needle);
  if (at < 0) {
    console.error(`MISS      round-trips: ${what}`);
    process.exit(1);
  }
  if (text.indexOf(needle, at + 1) >= 0) {
    console.error(`AMBIGUOUS round-trips: ${what}`);
    process.exit(1);
  }
}
text = text.replace(anchor, section);
text = text.replace(deployTail, deployNew);
text = text.replace(readingsTail, readingsNew);
fs.writeFileSync(T, text);
console.log("ok        round-trips: §4.7.1 + the §5 deploy/readings lists");
