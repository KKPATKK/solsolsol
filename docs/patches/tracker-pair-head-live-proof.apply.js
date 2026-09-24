#!/usr/bin/env node
/**
 * Records the LIVE proof for §4.8 (tracker pair head 10 → 30) after
 * `0938959` → Deploy Worker run 35953548509 landed at ~03:58Z.
 *
 * Why a script for a docs-only change: docs/round-trips.md is past the size
 * where the editor tooling can match into it (see §6), the same reason
 * tracker-pair-head-whole-pool.apply.js exists.
 *
 * What the sample showed (04:31–05:05Z):
 *   - `pairs 30/30` on both real passes  → the head IS the whole pool, one request.
 *   - `rows 3/30` (slow DB) → `rows 17/30` → checked went 10 → 17.
 *   - every tracked row (30) sat at 52–55s → one pile instead of three.
 *   - `budget-cut` STILL fires: `rows 3701/9` = ~411ms per row, so 30 rows
 *     (~12.3s) cannot fit the loop's ~4.5s. The cut rows are re-served next
 *     pass, so a full cycle is ~2 passes, not the predicted 1.
 *   - the one pile is the batch CLAIM's stamp (it covers all 30), so it does
 *     NOT prove all 30 were re-evaluated: 13 rows a pass are stamped-not-read.
 *
 * Same discipline as the other patch scripts: exactly one match per
 * replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/round-trips.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "doc: §4.8 is no longer 未上線",
    old: "## 4.8 追蹤池 head：10 → 30，一個 pass 掃完全池（2026-09-24，未上線）",
    next: "## 4.8 追蹤池 head：10 → 30，一個 pass 掃完全池（2026-09-24，已上線）",
  },
  {
    label: "doc: the four things to read become the four things read",
    old: L(
      "**上線後要讀**（未做）：",
      "",
      "1. `rows X/N` 嘅 X 由 10 升到貼近 N，`pairs N/N`；",
      "2. active 行嘅年齡由**三堆變一堆**（最舊 < 3 分鐘）；",
      "3. `allow` 同 `trackerMs` 嘅差距縮返，但唔可以出現 `budget-cut` 或 `cut:watchdog`；",
      "4. subrequest 窗：掃描 pair phase 而家連 head（最多 30 個 address）一齊 ask，而且 append 喺",
      "   最後（超 budget 只會剪走 tracker 嘅 pre-fetch），正常 tick 最多多 1 條，要盯住 50 上限",
      "   （§4.6 量到嘅生還 tick 窗 ≈ 30）。",
    ),
    next: L(
      "### 4.8.1 上線後讀數（2026-09-24 04:31–05:05Z）",
      "",
      "`0938959` → Deploy Worker run **35953548509 success** ✅（03:56:43Z push、1m14s、~03:58Z 落線）。",
      "",
      "| 要讀嘅嘢 | 讀數 | 判讀 |",
      "| --- | --- | --- |",
      "| `pairs N/N` | `pairs 30/30`（04:33:14Z、04:56:13Z 兩個 pass） | head 已係全池：**一個 request 食 30 個 address**，同 10 個嗰時一樣一條 subrequest |",
      "| `rows X/N` | `rows 3/30`（04:33，慢 DB）→ **`rows 17/30`**（04:56） | 一個 pass 由 checked **10 → 17 行**；N ＝ `activeRows.length`（pool 30），所以 17/30 ＝ 一個 pass 行咗 17 行 |",
      "| tracked 行年齡 | 30 行（`dead` 9／`null` 15／`weak` 4／`up200` 1／`ignite` 1）**全部 52–55s**；`rug` 13／`unwatched` 1 照樣幾個鐘頭唔掃 | **三堆變一堆**，達到目標（比「最舊 < 3 分鐘」更好） |",
      "| `budget-cut` | **照樣出現**（兩個 pass 都有） | 同預測相反 —— 見下 |",
      "| `cut:watchdog` | **冇出現** | watchdog 前提仍然 hold（新嘅 8_600 冇咬） |",
      "| subrequest 窗 | `/health.heartbeat.subreqs.recent` 最高 **37／50**；DB 佔 29–30 條／窗 | 冇撞上限，DB 仍然係大頭（同 §4.6） |",
      "| scan pair phase | ring `ms === 5000`（race cut）由 02:40–03:56 嘅 76 分鐘 **2 條**，變 03:58–04:52 嘅 52 分鐘 **4 條** | 多出嗰兩條落喺 04:30 桶（同時 `db 4462ms`）→ 睇唔到 head 直接造成，但**唔算「冇變」**，要再抽一段乾淨時段才算證 |",
      "",
      "**`budget-cut` 冇消失，而原因唔係 head**（04:56:13Z）：",
      "",
      "```",
      "ok:17/2 rows 17/30 pairs 30/30 miss 0 lost 0 budget-cut allow 4521",
      "spend[setup 521/2 heal 498/1 miss0 enrolled0 pairs 0/0 rows 3701/9 holders 284/1 held0 cut3 probe1 miss0] trips 16 db 5163ms",
      "trackerMs 6080",
      "```",
      "",
      "`rows 3701/9` ＝ row loop **每行 ~411ms**（pair batch 反而 0ms —— 180s 快取命中）。30 行 × 411ms ≈",
      "**12.3s**，而 row loop 嘅預算係 `allow − reserve ≈ 4.5s − 0.6s`。即 head 由 10 升到 30 之後，瓶頸",
      "仍然係「每行嘅 Turso 成本」而唔係 head：cut 咗嗰 13 行留喺隊列（`last_checked` 最舊先），下一個",
      "pass 接手。所以**一個 pass 掃 17 行、全池一輪 ≈ 2 個 pass（~2 分鐘）**，未做到預期嘅 1 個 pass，",
      "但已經由「3 個 pass／5–8 分鐘」收到「2 個 pass／~2 分鐘」。要真正一個 pass 掃完，下一刀係減每行嘅",
      "round trip（呢個 411ms／行），唔係再加 head。",
      "",
      "**一個讀數陷阱（raise head 之後新出現）**：`rows X/N` 嘅 X 係 `checked`（真係行過嘅行），但隊列",
      "stamp 係 batch claim 一次過蓋全池（§4.2 省 trip 嘅設計），所以 30 行一齊 52–55s **只證明 claim 蓋咗",
      "章**，唔證明 30 行都重新評估過 —— 每 pass 有 30 − 17 ＝ **13 行「蓋咗章、冇重新評估」**，而佢哋",
      "照樣排去隊尾（以前 head 10 ＝ checked 10，冇剩呢個形狀）。要盯：抽兩次相隔幾分鐘嘅表，睇",
      "`lastMcap`／`chgSincePushPct` 有冇真係更新，唔可以只睇年齡。",
      "",
      "**另一個失敗形狀（同 head 無關）**：Turso 一慢，tracker 會被整個 defer —— 04:34:13Z／04:35:12Z",
      "兩個 pass 係 `deferred:tick-budget allow 0`／`allow 308`、`rows 0/0`，同一時間 `db 4462ms`、",
      "`setup 2003/2`（正常係 `db 1056ms`、`setup 346/3`）。呢個就係中間一度見到 tracked 行企到 13–19",
      "分鐘嘅原因：**抽讀數一定要連 `deferral` 一齊睇**，單睇一兩個 pass 會誤判成 regression。",
      "",
      "**四點結論**：(1) head 30 落線、`pairs 30/30` 一條 request ✅；(2) 年齡三堆變一堆 ✅；",
      "(3) checked 10 → 17、全池一輪 2 pass ✅ 但未到 1 pass，而且 `budget-cut` **仍然出現** ❌；",
      "(4) subrequest 冇撞 50 上限、`cut:watchdog` 冇出現 ✅。",
    ),
  },
  {
    label: "doc: §5 unit-test count 302 → 303",
    old: "**302 passed, 0 failed** ✅（§十九（duplicate-cards）新增 2 條 no-mark",
    next: L(
      "**303 passed, 0 failed** ✅（§4.8 新增 1 條「pair batch 問全池」test ＋ 改寫 1 條 strict-subset",
      "  test 成 40 行 fixture；之前 302 ＝ §十九（duplicate-cards）嗰 2 條 no-mark",
    ),
  },
  {
    label: "doc: §5 deploy runs — §4.8's push",
    old: "* `4021c35`（duplicate-cards §十九 no-mark dedupe）→ Deploy Worker run 35947790374 **success** ✅",
    next: L(
      "* `4021c35`（duplicate-cards §十九 no-mark dedupe）→ Deploy Worker run 35947790374 **success** ✅",
      "* `b6f07e0`（§十九 no-mark 第一小時紀錄）→ Deploy Worker run 35948129083 **success** ✅（1m20s）",
      "* `0938959`（§4.8 追蹤池 head 10 → 30）→ Deploy Worker run **35953548509 success** ✅（1m14s，",
      "  03:56:43Z；落線讀數見 §4.8.1）",
    ),
  },
  {
    label: "doc: §5 live-reading index gains §4.8.1",
    old: "  §5.1（note／history 觀察）、§4.7.1（grouped telemetry：durable 半已證）",
    next: L(
      "  §5.1（note／history 觀察）、§4.7.1（grouped telemetry：durable 半已證）、§4.8.1（head 10 → 30：",
      "  `pairs 30/30`、checked 10 → 17、三堆變一堆，`budget-cut` 仍在）",
    ),
  },
];

const text = fs.readFileSync(DOC, "utf8");
let out = text;
let failed = false;
for (const e of edits) {
  const first = out.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (out.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  out = out.slice(0, first) + e.next + out.slice(first + e.old.length);
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
fs.writeFileSync(DOC, out);
console.log(`wrote ${DOC}`);
