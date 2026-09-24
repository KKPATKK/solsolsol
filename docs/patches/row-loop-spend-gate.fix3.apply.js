#!/usr/bin/env node
/**
 * Records the post-deploy reading for §4.8.2/§4.8.3 (the spend gate), read
 * 2026-09-24 06:22–06:27Z off /health.pushWatchPass.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/round-trips.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "doc: §4.8.2 is no longer 未上線",
    old: "### 4.8.2 一刀：budget gate 由「每行」搬去「每次 spend」（未上線）",
    next: "### 4.8.2 一刀：budget gate 由「每行」搬去「每次 spend」（2026-09-24，已上線）",
  },
  {
    label: "doc: the three things to read become the readings",
    old: L(
      "**上線後要讀**（未做）：",
      "",
      "1. 慢 pass 嘅 `rows X/N`：X 應該貼近 N（30），唔再係 17；",
      "2. `budget-cut` **仍然要出**（alerting row 被拒時）＋ `defer-send N` 要有數 —— 呢兩樣證明",
      "   「唔再 break」冇把「拒絕」靜音化；",
      "3. `rows <ms>/<trips>` 嘅 trips 唔應該因為行多咗而上升（quiet row 依然零 trip）。",
    ),
    next: L(
      "### 4.8.3 上線後讀數（2026-09-24 06:22–06:27Z）",
      "",
      "`050e121` → Deploy Worker run **35963736602 success** ✅（1m20s，06:16:53Z push、~06:18Z 落線）。",
      "",
      "| 要讀嘅嘢 | 讀數 | 判讀 |",
      "| --- | --- | --- |",
      "| `rows X/N` | **`rows 30/30`** 連續三個 pass（06:22:39／06:25:40／06:26:39Z） | 一個 pass 掃完全池 —— **目標達到**（同日前 04:56 係 17/30，head 10 嗰時係 10/29） |",
      "| `rows <ms>/<trips>` | `rows 214/1`、`rows 230/1`、`rows 240/1` | **30 行一個 trip**（之前 17 行要 9 trip／3_701ms）|",
      "| `budget-cut` | **冇出現**（三個 pass 都冇） | 冇 spend 被拒 → 冇嘢要 cut，同預期一致 |",
      "| 成本 | `trackerMs 1_527–1_825`（allow 4_728–4_779）、`trips 5`、`db 1_292–1_573ms` | pass 由 6_080ms 落到 ~1.6s，trip 由 16 落到 5 |",
      "| `pairs N/N` | `pairs 30/30`，pair trip 0–31ms（快取命中） | §4.8 嗰條冇回退：仍然一個 request |",
      "| tracked 行年齡 | 29/30 行 **27s**（＋1 行 86s）＝一個堆 | 一個 pass 就刷完全池 |",
      "| `cut:watchdog` | **冇出現** | watchdog 前提仍然 hold |",
      "",
      "06:22:39Z 原文：",
      "",
      "```",
      "ok:30/0 rows 30/30 pairs 30/30 miss 0 lost 0 allow 4784",
      "spend[setup 364/2 heal 415/1 miss0 enrolled0 pairs 0/0 rows 214/1 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 6 db 1348ms",
      "```",
      "",
      "**未證嘅一半（老實講）**：三個抽樣 pass 都係 `ok:30/0` —— **冇一條 alerting row**，所以",
      "「被拒嘅 card 仍然會出聲」（`defer-send N` ＋ `budget-cut`）今次 **live 抽唔到**，只由 unit test",
      "釘住：`a card that cannot be sent leaves its row untouched` 斷言 `defer-send 1` ＋ `budget-cut`，",
      "而 fix1 把 `overBudget` 由 send gate 拿返出嚟之後佢仍然綠。要等一條真 alerting row 出現，",
      "先可以話 live 都證實。",
    ),
  },
  {
    label: "doc: §5 deploy runs — the spend gate's push",
    old: L(
      "* `0938959`（§4.8 追蹤池 head 10 → 30）→ Deploy Worker run **35953548509 success** ✅（1m14s，",
      "  03:56:43Z；落線讀數見 §4.8.1）",
    ),
    next: L(
      "* `0938959`（§4.8 追蹤池 head 10 → 30）→ Deploy Worker run **35953548509 success** ✅（1m14s，",
      "  03:56:43Z；落線讀數見 §4.8.1）",
      "* `050e121`（§4.8.2 spend gate）→ Deploy Worker run **35963736602 success** ✅（1m20s，",
      "  06:16:53Z；落線讀數見 §4.8.3）",
    ),
  },
  {
    label: "doc: §5 live-reading index gains §4.8.3",
    old: "  `pairs 30/30`、checked 10 → 17、三堆變一堆，`budget-cut` 仍在）",
    next: L(
      "  `pairs 30/30`、checked 10 → 17、三堆變一堆，`budget-cut` 仍在）、§4.8.3（spend gate：",
      "  `rows 30/30`、30 行一個 trip）",
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
