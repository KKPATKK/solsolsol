#!/usr/bin/env node
/**
 * Record the reservation → final-write span hold in docs/duplicate-cards.md:
 * a new §17.6, and a pointer from the §17.5 bullet it closes.
 *
 * An apply script because the anchors sit past the file-tool window.
 */
const fs = require("fs");

const T = "docs/duplicate-cards.md";
const lines = (...xs) => xs.join("\n");

const bulletOld = lines(
  "* 若果 watchdog 開火而 pass 當時正停喺某一行嘅**送卡**度（reservation 已落），嗰張卡一樣係漏 ——",
  "  同「唔開火、永遠等落去」嘅結果相同，唔會更差；但呢個窗口係已知嘅，屬下一輪要處理嘅對象。",
);
const bulletNew = lines(
  bulletOld,
  "  **2026-09-23 已收：見 §17.6**（唔係「同永遠等一樣」—— 追落去係**靜默漏卡**方向）。",
);

const anchor = "## 十八、";

const section = lines(
  "### 17.6 第三個 bullet 已收：reservation → final-write 嘅 span 交俾 tick 嘅 waitUntil（2026-09-23，已修）",
  "",
  "§17.5 第三點寫「同唔開火、永遠等落去一樣，唔會更差」。追落去係**唔同意**，而且係 §17.3 自己講",
  "「唯一唔可以發生」嘅方向 —— 靜默漏卡：",
  "",
  "* `reservePushWatchAlert` 係**喺送卡之前** commit 嗰個 transition（呢個就係 dedupe 嘅全部意義）。",
  "* 由嗰一刻到該行最後嗰個 `updatePushWatchCheck`，行係「對其他 isolate 嚟講已宣布、但冇任何",
  "  bookkeeping 支持」。",
  "* watchdog 開火 ⇒ `runTrackerPass` return、worker 收尾、**handler return**。被放棄嗰條 pass",
  "  **冇被取消**（§17.3），但**冇任何嘢保住個 isolate**：handler return 一刻，凡係冇交俾 `waitUntil`",
  "  嘅 promise 一律被取消 —— 同 worker `tickWaitUntil` 同一條規矩（`writeDrain` 實測 100% 寫唔到嗰單）。",
  "  嗰段 span 就死喺度。",
  "* 對比「冇 watchdog、永遠等落去」嘅世界：個 pass 揸住個 isolate，個 final write **有機會**落。",
  "  Span 被切就係**一定**唔落 ⇒ 行停喺 **reserved-but-unwritten**，下一個 pass 讀到前進咗嘅 reservation",
  "  （`(last_state, last_alert_at)` 已改），dedupe 就**唔會再發**呢張卡。",
  "",
  "修法（`PushWatcher.holdRowSpan`，落線 script `docs/patches/tracker-row-span-hold.apply.js`）：",
  "",
  "* **揸住嗰段 span**：`holdForTick` 交一個 promise 俾 tick 嘅 `waitUntil`，回傳一個 release handle。",
  "* **建立位**：`checked += 1` 之後、`reserveAlert()` **之前** —— 所以 reservation 自己嗰個寫入都",
  "  喺 span 入面（reservation 落咗而 pass 即刻死，一樣係 reserved-but-unwritten）。",
  "* **釋放位**：兩個出口各一次 —— (a) reservation 輸咗嗰條 `continue`（冇嘢宣布過，即刻放）；",
  "  (b) 行尾最後嗰個 `updatePushWatchCheck` 之後。**WON reservation 之後冇其他出口**：send loop 裏面",
  "  嘅 `break`（send budget 用盡／terminal abandoned／send 超時）全部 fall through 到最後嗰個寫入，",
  "  所以呢兩個 release 冚得晒整個 span。",
  "* **刻意有界**（`TRACKER_ROW_SPAN_HOLD_MS` = `TRACKER_SEND_CAP_MS` ＋ 2 × `TRACKER_ROW_LEASH_MS`",
  "  ＋ 1s slack = 5_000ms）：交俾 `waitUntil` 嘅 promise 如果**永遠唔 settle**，就會拉長 invocation ——",
  "  正係 §17.3 拆走嘅嗰種 stall，而且會推翻 watchdog 自己嘅前提（「pass 內每個 stage 都有界」）。",
  "  所以 hold 有 timer 兜底；因為行一定會行到最後嗰個寫入（見上），timer **只會喺已經 throw 嘅路徑**",
  "  上開火，嗰時再揸住 invocation 純粹係 leak。",
  "* **唔變嘅保證**：pass 嘅決定、reservation 嘅 guard、rollback 語意、cut 卡嘅 proof（§15.4）一律",
  "  冇改；呢刀只係多交一個 promise 俾 tick，**唔加任何 round trip**，亦唔改 note 格式。",
  "",
  "**測試**（`docs/patches/tracker-row-span-hold-tests.apply.js` ＋ `…fix1.apply.js`）：三條性質，每條",
  "錯都係靜默 ——（1）span promise 真係入到 tick 嘅 hook（唔係靠「pass 跑得完」睇得出）；（2）final write",
  "**pending 嗰陣** hold 仲未 settle，而 final write 一完成就**由佢**釋放（唔係等 timer）；（3）reservation",
  "**輸**嗰陣即刻釋放（否則每次輸 race 都揸住個 invocation 幾秒）。另加 bound 嘅兩條關係：要**蓋得住**",
  "span 嘅 worst case，又要**裝得落** pass 自己嘅 envelope（watchdog 嗰 8s）。",
  "",
  "**Negative control**（§17.4 規矩）：淨係閹咗個 hand-off（攞走 `this.holdForTick(held)`）、測試保留",
  "⇒ suite **294 passed, 2 failed**，兩條正正係 `the span hold AND the cut's proof are handed to the tick`",
  "同 `the reservation → final-write span is handed to the tick`；還原之後 **296 passed, 0 failed**。",
  "注意 `…fix1` 嗰刀係必要嘅：§15.4 嗰條 CUT-proof test 原本釘住 `held.length === 1`，而家同一行有",
  "**兩個** promise 搭上個 hook，所以佢改成 2 並寫明邊個係 proof。",
  "",
  "#### 17.6.1 落線（deploy `47ebcfc`，run 35893562830 **success** 1m16s，17:08:26Z→17:09:42Z）",
  "",
  "呢刀**冇新讀數**（唔加 round trip、唔改 note），所以驗收係「唔應該有變化」：",
  "",
  "| 讀邊度 | 讀數（17:10–17:12Z） | 意思 |",
  "|---|---|---|",
  "| `cut:watchdog` | **0 次**（整個 `/debug/scan-history` payload） | watchdog 冇開火 ⇒ 冇未 bound 嘅 await 出現 |",
  "| pass note | `phase:\"done\"`、`trackerMs 1255`、`ok:10/0 rows 10/29 pairs 10/10 … trips 7 db 562ms` | 正常尾段；`cut:watchdog` ／ `err:` 都冇 |",
  "| `/debug/push-watch.issueCount` | **3**（全部 `lost_completion_write`，都係 09-23 04:16Z／01:41Z 嗰幾條舊 row） | 冇新增 issue |",
  "| scan-history ring | 窗口 15:01:13Z→17:10:30Z，dead row **11** 條，最新一條 **16:11:21Z** | deploy（17:09Z）之後冇 dead tick；最後一條早咗成個鐘 |",
  "",
  "真正嘅價值喺**下一次** watchdog 開火嗰陣：嗰行唔應該再出現「reservation 前進咗、bookkeeping 冇動」",
  "嘅形狀（`terminalRowIssues` 嘅 `lost_completion_write`）。順帶一提：舊嗰 3 條 `lost_completion_write`",
  "唔會因為呢刀而消失，佢哋要等 `terminalRowRepair` 收。",
  "",
  anchor,
);

let text = fs.readFileSync(T, "utf8");
if (text.includes("### 17.6 第三個 bullet 已收")) {
  console.error("ALREADY   duplicate-cards: §17.6");
  process.exit(1);
}
for (const [what, needle] of [
  ["the §17.5 third bullet", bulletOld],
  ["the 十八 heading (anchor)", anchor],
]) {
  const at = text.indexOf(needle);
  if (at < 0) {
    console.error(`MISS      duplicate-cards: ${what}`);
    process.exit(1);
  }
  if (text.indexOf(needle, at + 1) >= 0) {
    console.error(`AMBIGUOUS duplicate-cards: ${what}`);
    process.exit(1);
  }
}
text = text.replace(bulletOld, bulletNew).replace(anchor, section);
fs.writeFileSync(T, text);
console.log("ok        duplicate-cards: §17.6 + §17.6.1");
