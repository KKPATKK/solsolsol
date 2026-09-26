#!/usr/bin/env node
/**
 * Deferred-prune doc pointer (2026-09-26): docs/round-trips.md §4.26.
 *
 * docs/round-trips.md is far past the file tool's edit window, so the section
 * is appended by this verify-then-write patch, exactly like §4.21-§4.25.
 *
 * The section text is built from SINGLE-QUOTED strings on purpose: it is full
 * of markdown backticks, and a missed escape inside a template literal is how
 * a doc patch lands mangled text instead of failing loudly.
 *
 * Run: node docs/patches/deferred-prune-doc-pointer-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const ANCHOR =
  '`docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js` ＋ `docs/patches/round4-mode-giffy-fix-2026-09-26.apply.js`。';

const SECTION = lines(
  '',
  '---',
  '',
  '## 4.26 欠卡清單自動退場：推唔到嘅 obligation 唔再食 make-up 位（2026-09-26）',
  '',
  '**問題（用戶問「呢 20 條 … 可以怎樣清理」）。** 我先答「唔影響任何 push」—— **錯**，一實測就反轉：',
  '',
  '- `missingDeferredTokens`（src/deferredmakeup.ts）係 **oldest-first**，上限 `DEFERRED_MAKEUP_MAX = 8`／tick，',
  '  而 live tick 讀 `feedMakeup.injectedTotal 8 / lastInjected 8` ⇒ **每一 tick 8/8 個 make-up 位**都畀最舊嗰 8 條食晒；',
  '- 用 `/debug/token` 對 `launch_ms`：嗰 8 條係 47.6／120.2／126.2／156.4／165.1／165.3／166.6／167.0 小時大，',
  '  而最闊 enabled chat 嘅卡窗上限係 **26 小時** ⇒ 8/8 都係**證明推唔到**；',
  '- 後果唔止浪費 8 個 pair 地址／tick：第 9 條之後永遠拎唔到 make-up 位 —— 其中一條係實測 **7.7h 嘅真義務**',
  '  （喺 80min–26h 卡窗內），排最尾，等同一世都冇 priority。',
  '',
  '**規則。** obligation 喺下面兩個事實成立時**退場**（只會減少，永遠唔會多出一張卡）：',
  '',
  '| reason | 判定 | 為何安全 |',
  '| --- | --- | --- |',
  '| `too-old` | 幣齡 > 最闊 enabled chat 嘅 `maxAgeMinutes` | 用嘅係**閘門自己嗰個數**（`Date.now() - pair.pairCreatedAt`）＋最闊窗口，即係每個 chat 都會照樣 reject；年齡單調遞增，過咗就永遠過咗，所以第一次觀測就退 |',
  '| `no-pair` | 連續 `DEFERRED_PRUNE_ATTEMPTS = 3` 次觀測都冇 pair 資料 | 上游一 tick 失手（budget 切、429、last-good 重用）唔應該殺真義務；run 中間任何一次 in-window 觀測會歸零 |',
  '',
  '- **「太新」故意唔退**：細幣會長大入窗。',
  '- 被退嘅幣**仍然留喺 re-eval pool**（deferral 本身唔落庫），所以最壞情況係冇咗「強制 make-up 優先」，唔會冇咗張卡',
  '  —— 同 `deliveredDeferredTokens` 嘅取捨同一個方向。',
  '- **觀測點**：`Scanner.matchCoins`。欠單嘅幣一定經呢度（make-up lane 注入嘅、pool slice 帶嘅，兩者嘅 pair 都交去同一個 loop），',
  '  所以 hook 只係每 profile 一次 `isDeferredToken` map 命中 ＋（命中時）一次純函數判定：**零額外 request、零額外 Turso round trip**。',
  '',
  '**為何 durable row 要多一個 counter。** 退場會縮短 registry，而 row 嘅 `pendingTokens` 就係由 registry 寫出去 ——',
  '即係「縮短」本身要等一個**會寫 row 嘅 tick** 才落地。所以 `pruned` 行 **cursor**（同 `deferred`／`recovered` 一樣：',
  'scanner 累計數 − worker baseline，加 `applied` marker 防重複），而 `delta.pruned > 0` 就係令「只有退場、冇其他事」嘅 tick 都會寫 row 嘅原因。',
  '',
  '**cursor 擺邊度（一個實作陷阱，已修）。** 一開始 `prunedTotal` 擺喺 module 級 registry，但 dead-tick rebuild 會**重設 worker baseline',
  '同 Scanner**（因為 rebuilt scanner 嘅計數由零起）—— 而 module state 唔會重建，結果每次 rebuild 都會將「開機以來所有退場」',
  '當成新 delta 重覆寫入。所以個計數搬去 `DeferredPushLedger`（同 `recovered` 一樣嘅歸屬）：rebuild 之後 baseline 0 對 counter 0。',
  'registry 自己嘅 `prunedTotal` 留低做 **isolate 視角**（`/debug/deferral` 嗰個），兩者係唔同問題。',
  '',
  '**探針 `/debug/deferral`**（read-only）。一個 request 答兩邊：',
  '',
  '- `durable`：row 本身 —— pending list ＋ 四個 counter（deferred/recovered/stalled/pruned）＋ prune 首末時間戳；',
  '  呢度**即時重讀** worker_state 而唔係用 tick 鏡像，所以冷 isolate 都答到實況；',
  '- `isolate`：本 isolate 嘅 registry —— 每條欠單欠咗幾久（`owedMin`）、連續幾次 no-pair miss、上次判定用嘅窗口（`windowMaxAgeMin`），',
  '  同最近退場嘅理由＋判定年齡（`lastPruned`，ring 12 條）。',
  '',
  '**驗收點（落線後點睇）**：`durable.pending 20 → 跌`，同時 `durable.prunedTotal` 升，`lastPruned` 逐條講理由 ——',
  '第一批應該係最舊嗰 8 條、reason 全部 `too-old`。一個 tick 只能觀測「被注入嘅」8 條，所以僵屍尾會**一波 8 條**咁退',
  '（tick 1 → tick 2 → tick 3 清完），同時 make-up lane 即刻開始有真義務可用。',
  '',
  '**代價（講明）**：`too-old` 用嘅 `pairCreatedAt` 係 DexScreener 揀嘅 pair；如果同一 mint 之後另開新池（`pairCreatedAt` 變細），',
  '極端情況下條 obligation 會提早退 —— 影響同上（冇 priority，卡唔會冇）。`no-pair` 嘅 3 次 slack 亦係同一方向：寧願慢一拍退，唔好殺真義務。',
  '',
  '本地驗收：`npm run typecheck` clean；`npm run test:unit` **362 passed / 0 failed**（前值 359）——',
  '新增 registry 行為測試（too-old 即退／真義務同 too-fresh 留低／no-pair 三次 run 同 reset／探針 view）、',
  'durable cursor 測試（累加、首末時間戳、applied marker、legacy row 讀 0/null、**legacy marker 唔可以 ACK 一個未寫嘅退場 delta**）、',
  '同一條 out-of-window wiring guard；三條舊測試（`pushDeferralDelta` ×2、`loadPushDeferralSnapshot`）照新形狀 re-point。',
  '`npx wrangler deploy --dry-run` 過（1562.41 KiB）。',
  '',
  '落線紀錄：`docs/patches/deferred-prune-2026-09-26.apply.js`（src/scanner.ts ＋ src/worker.ts）、',
  '`docs/patches/deferred-prune-tests-2026-09-26.apply.js`、`docs/patches/deferred-prune-tests-fixes-2026-09-26.apply.js`、',
  '`docs/patches/deferred-prune-cursor-fix-2026-09-26.apply.js`（deferredmakeup.ts / deferrallog.ts 用普通 edit）。',
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "docs/round-trips.md",
    "§4.26: an unpayable obligation is retired (and the probe that shows why)",
    ANCHOR,
    ANCHOR + "\n" + SECTION,
    (src) => src.includes("## 4.26 欠卡清單自動退場"),
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
