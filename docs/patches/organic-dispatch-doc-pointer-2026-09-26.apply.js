#!/usr/bin/env node
/**
 * Organic-dispatch doc pointer: appends §4.23 to docs/round-trips.md. The file
 * is far past the file tool's edit window, so this is an append with an
 * idempotency check (the section heading).
 *
 * Run: node docs/patches/organic-dispatch-doc-pointer-2026-09-26.apply.js
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
  "## 4.23 有機度條線又唔見咗：card-only batch 移去 RugCheck 之前（2026-09-26）",
  "",
  "卡片嘅 🌱 有機度（＋1h 交易者）再次失蹤，同 2026-09-17 嗰次同一個病：**資料在、窗冇**。查證：",
  "當日 5 張推送卡嘅 mint（MuseXT 03:27、MAX 03:22、LESTER 03:07、DDOS 03:06、D/ACC 02:44）用",
  "正常網絡問 Jupiter 個 search endpoint，全部有 `organicScore`（55–68，label medium）——上游健康。",
  "",
  "病因：card-only display batch（GMGN／Arkham／Jupiter organic 三格）係喺 RugCheck await **之後**",
  "才開，而佢個 wall 係 `enrichDeadline = tick start + 2200ms`（`4200 − 1500 − 500`）。RugCheck 個",
  "`getReport` 係**每 tick 都真係打一次**（`rugcheckFetchedAt` 係 per-isolate cache，isolate 一回收",
  "就冇），而 live 相位戳顯示 `seen` 落喺 1.8–2.1s、RugCheck await 跟住——即係 dispatch 已經係",
  "2.0–3.0s，`bestEffort` 一見 `deadline − now ≤ 0` 就即刻回 fallback，三格未開就已經死。",
  "",
  "修法係一個 **MOVE**：三格移去 RugCheck **之前**（但仍然喺 supply-flow gate 同 seen-check 之後，",
  "免得為一張唔會推嘅卡開三個 call；flow 停用時嗰個 gate 係即時 return，所以實際上等於 loop 入口），",
  "白賺 RugCheck 嗰 ~0.2–0.8s。同一個 call、同一個 deadline、同一個 await 位置（Axiom 步驟之後），",
  "只係 overlap 改變——chain 嘅總 wall time 不變。",
  "",
  "本地驗收：`npm run typecheck` clean、`npm run test:unit` **357 passed / 0 failed**（前值 356；新增",
  "一條 order guard：batch 必須喺 RugCheck mark 之前、`const rugcheck = await …` 之前，同時仍然喺",
  "flagged-gate 同 seen-check 之後）。落線後睇：有推送嘅 tick，`/debug/tick` 嘅 `organic` 計數器",
  "應該 0 → 1，卡片出返 🌱 行。",
  "",
  "落線紀錄：`docs/patches/organic-dispatch-before-rugcheck-2026-09-26.apply.js`。",
  "",
].join("\n");

if (src.includes("## 4.23 有機度條線又唔見咗")) {
  console.log("skip docs/round-trips.md: §4.23 already present");
} else {
  fs.appendFileSync(file, SECTION);
  console.log(`wrote docs/round-trips.md (appended §4.23, ${SECTION.length} bytes)`);
}
