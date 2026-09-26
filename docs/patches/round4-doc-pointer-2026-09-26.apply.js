#!/usr/bin/env node
/**
 * Round 4 doc pointer (2026-09-26): docs/round-trips.md §4.25.
 *
 * docs/round-trips.md is far past the file tool's edit window, so the section
 * is appended by this verify-then-write patch, exactly like §4.21-§4.24.
 *
 * The section text is built from SINGLE-QUOTED strings on purpose: it is full
 * of markdown backticks, and a missed escape inside a template literal is how
 * a doc patch lands mangled text instead of failing loudly.
 *
 * Run: node docs/patches/round4-doc-pointer-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const ANCHOR =
  '落線紀錄：`docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js`。';

const SECTION = lines(
  '',
  '---',
  '',
  '## 4.25 Round 4：`trade_mode_override` 搭上 tick-front 嗰一句（2026-09-26）',
  '',
  '**揀邊個做。** 上一輪留低兩個候選，標籤化 census 一睇就分開：',
  '',
  '| 候選 | live 讀數 | 結論 |',
  '| --- | --- | --- |',
  '| `getWorkerState:trade_mode_override` | 連續三個 tick 都係 **1 call / 86–117ms**（`modeRead reads 1 reuses 0`） | 抵郁 —— 最後一個「每 tick 一次」嘅單 key read |',
  '| `getWorkerState:scan_heartbeat` | cron tick **0 call** | 已經合併完 —— 郁唔到乜 |',
  '',
  '`scan_heartbeat` 嘅消費者早就共用同一句（`WEDGE_READ_KEYS`，加 `lastHeartbeatRead` 嘅 2s 重用窗），',
  'census 見到嘅單 key read 全部來自診斷／fallback 路徑（`/debug/tick` 唔傳 heartbeat、',
  '`checkOutageAndAlert` 冇 `hbAt` 時自己讀）—— 設計如此，冇嘢好慳。真正每 tick 都付嘅淨返 mode',
  'override 嗰行：prefetch 一定係冷快取，因為 tick 相隔 60s 而 `MODE_OVERRIDE_TTL_MS` 只有 15s。',
  '',
  '**合併。** Tick front 喺 `ensureInitialized` 已經出咗一句 `getWorkerStates`（`WEDGE_READ_KEYS`）；',
  '一句已經要出去嘅 statement 加多個 key **唔會多一個 subrequest**，所以：',
  '',
  '1. `trade_mode_override` 加入 `WEDGE_READ_KEYS`（list 順手 export，令個 ride 可以喺線下斷言 ——',
  '   同 `cronGateLoad` 一樣嘅理由）；',
  '2. `frontModeOverrideRead()` 將嗰次讀數（值 ＋ 讀取時間）交去 tick 嘅 `onTickStart` hook，喺',
  '   **prefetch 之前** prime 落 TradeService 快取 —— prefetch 變 no-op，於是成個 tick 對 mode 零 read。',
  '   三態契約係重點：`{ raw: null }` 係**真讀數**（行唔存在 = 冇 override），要照 prime；**冇讀數**',
  '   （冇 front read／batch timeout（`map === null`）／讀數舊過 `HEARTBEAT_REUSE_MS`）**唔准 prime**，',
  '   畀 prefetch 自己照舊讀 —— 慢，但唔會無中生有一個 mode，即係 fail-safe 方向；',
  '3. `/health` 唔再為同一行付第二次：個 key 加入佢本來就出嘅 `getWorkerStates` batch，驗證過嘅值由',
  '   嗰次讀取提供，順手 prime 埋 service，所以 `effectiveMode` 都唔使再自己讀。',
  '',
  '驗證規則順手收歸一個：`parseTradeModeOverride`（src/db.ts）本來就係 `Db.getTradeModeOverride` 用嘅',
  '規則，而家 batch 讀者（/health、primed cache）用返同一條 —— 唔會出現兩把尺，亦唔使為咗搭車而',
  '複製驗證邏輯。',
  '',
  '**代價（講明）**：新鮮度性質不變 —— primed 值同自己讀嘅值一樣用 `MODE_OVERRIDE_TTL_MS` 過期，',
  '而 worker 只會用「年輕過 `HEARTBEAT_REUSE_MS`」嘅 front read prime；`/setmode` 由另一個 isolate',
  '翻嘅延遲上限仍然係 15 秒。front read 失敗／太舊 → 完全退回今日行為（prefetch 自己讀一個 round',
  'trip）。舊嘅 ride 唔會覆蓋新嘅快取（兩個 caller 可以任何次序到）。',
  '',
  '**觀測（落線後驗收點）**：`summary.modeRead` 多一個 `primes` 計數器 —— 食到 ride 嘅 tick 應該讀',
  '`primes 1 / reads 0`；而 `summary.dbTickSteps` 唔應該再出現 `getWorkerState:trade_mode_override`。',
  '（`reads` 保持「呢個 service 自己付嘅 round trip」嘅意思，所以兩個數字要一齊睇。）',
  '',
  '本地驗收：`npm run typecheck` clean；`npm run test:unit` **359 passed / 0 failed**（前值 358；新增一條',
  'round-4 out-of-window guard，並把 `tick-progress-record` guard 嘅 /health 斷言照三個 key 嘅新形狀',
  're-point）；`npx wrangler deploy --dry-run` 過。`scripts/test-tick-path.js` 補咗 ride 嘅行為測試',
  '（primed／null 讀數／過期／junk／先後次序）。',
  '',
  '落線紀錄：`docs/patches/round4-mode-rides-front-2026-09-26.apply.js`（本體：src/db.ts ＋',
  'src/worker.ts；jupiter.ts 用普通 edit）、`docs/patches/round4-mode-rides-front-tests-2026-09-26.apply.js`、',
  '`docs/patches/round4-mode-rides-front-fixes-2026-09-26.apply.js`、',
  '`docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js`。',
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "docs/round-trips.md",
    "§4.25: the trade-mode override rides the tick-front batch",
    ANCHOR,
    ANCHOR + "\n" + SECTION,
    (src) => src.includes("## 4.25 Round 4：`trade_mode_override` 搭上 tick-front"),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
