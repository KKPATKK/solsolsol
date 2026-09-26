#!/usr/bin/env node
/**
 * Deferred-prune same-tick refresh (2026-09-26): the retirement counters must
 * be refreshed on the summary the tick's OWN tail writes.
 *
 * WHAT THE FIRST DEPLOY SHOWED. The rule was live and the make-up lane was
 * feeding it (live `/health`: `profiles 8` from `lastRawProfiles 0` +
 * `injectedTotal 8`, `agedEval 10` — the evaluation ran), yet `durable
 * .prunedTotal` stayed 0 and every probe still showed `windowMaxAgeMin: null`.
 * The cause was not the hook: it was WHEN the summary's counters are captured.
 *
 * The diag object is built at tick START (`deferPruned: this.deferredPushes
 * .pruned`, the value at that instant) and the durable write reads it at the
 * tail (see syncPushDeferralCounters) — so a retirement performed DURING the
 * tick could only surface in the NEXT tick's summary. That is survivable for a
 * counter that accumulates for days (`deferRecovered` has the same lag), but
 * not for this one: cron ticks normally land on FRESHLY RECYCLED isolates (one
 * tick per isolate), so "next tick" never comes, and the row keeps the full
 * pending list — which the next cold isolate then re-seeds into its registry,
 * undoing the in-memory drop. The prune had no way to persist.
 *
 * THE FIX is the pattern the recovery path already uses: the moment a counter
 * moves, refresh the per-tick summary field (the recover site does exactly
 * this for `deferRecovered`/`deferPending`). Here it is one refresh right after
 * matchCoins returns, carrying three things:
 *
 *  - `deferPruned` (the retirements this tick just made) — this is what makes
 *    the delta reach the row on the SAME tick;
 *  - `deferPending` (the shrunken gauge);
 *  - `deferObserved`, a new per-tick observable: how many OWED coins this
 *    tick's evaluation judged at all. That is the number that separates "the
 *    hook never fired" from "it fired and nothing qualified" — the exact
 *    ambiguity this incident cost an hour to — and it is read as a diff of the
 *    ledger's cumulative counter, so a rebuilt scanner cannot skew it.
 *
 * src/scanner.ts, scripts/test-unit.js and docs/round-trips.md are all far past
 * the file tool's edit window, so this is a verify-then-write patch.
 *
 * Run: node docs/patches/deferred-prune-same-tick-refresh-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const DOC_ANCHOR = lines(
  `落線紀錄：\`docs/patches/deferred-prune-2026-09-26.apply.js\`（src/scanner.ts ＋ src/worker.ts）、`,
);
const DOC_NOTE = lines(
  `**落線後第一個 bug（同日修）：counter 一定要喺同一 tick refresh。** 第一次 deploy 之後，規則明明行緊`,
  '（`/health`：`profiles 8` ＝ `lastRawProfiles 0` ＋ `injectedTotal 8`，`agedEval 10` 證明評估有行），',
  '但 `durable.prunedTotal` 一直 0、探針 `windowMaxAgeMin` 一直 null。原因唔係 hook，而係 **summary 嘅 counter 幾時影快相**：',
  'diag 係 tick 開頭建好（`deferPruned` 係嗰一刻嘅值），而 durable 寫入係 tick 尾讀 summary ⇒ 呢個 tick 退嘅 obligation',
  '只會喺**下一個 tick** 嘅 summary 出現。對累積幾日嘅 counter（`deferRecovered` 同款滯後）無所謂，但呢個唔得：',
  'cron tick 通常落喺**新 recycle 嘅 isolate**（一個 isolate 只行一個 tick），所以「下一個 tick」永遠唔會嚟，',
  'row 繼續揸住成張 pending list，而下一個冷 isolate 又會由 row re-seed 返落 registry —— **退咗都等於冇退**。',
  '',
  '修法就係 recovery path 已經用緊嘅模式（recover 嗰度即場寫 `diag.deferRecovered`／`diag.deferPending`）：',
  '`matchCoins` 之後即刻 refresh —— `deferPruned`（今個 tick 退幾多 ⇒ 同一 tick 就寫入 row）、`deferPending`（收縮後嘅 gauge），',
  '同一個**新觀測值 `deferObserved`**：今個 tick 有幾多條**欠單**真係畀評估睇過。呢個數字就係「hook 冇行」同「行咗但冇嘢退」',
  '之間嘅分界（今次就係喺呢個歧義上面嘥咗一個鐘），而佢用 ledger 累計值嘅前後差計，所以 rebuilt scanner 都唔會歪。',
  '',
  DOC_ANCHOR,
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/scanner.ts",
    "the ledger counts the coins it judges (the per-tick observable)",
    lines(
      `  noteCoinAge(token: string, ageMs: number | null, windowMaxAgeMs: number): void {`,
      `    if (noteDeferredCoin(token, { ageMs, windowMaxAgeMs })) this.prunedCount += 1;`,
      `  }`,
    ),
    lines(
      `  noteCoinAge(token: string, ageMs: number | null, windowMaxAgeMs: number): void {`,
      `    this.observedCount += 1;`,
      `    if (noteDeferredCoin(token, { ageMs, windowMaxAgeMs })) this.prunedCount += 1;`,
      `  }`,
      ``,
      `  /**`,
      `   * Owed coins this scanner has JUDGED (every noteCoinAge call, retired or`,
      `   * not). Cumulative, and read as a within-tick diff by the caller that`,
      `   * publishes it — that diff is what tells "the hook never fired" (a cold`,
      `   * registry at scan time) apart from "it fired and nothing qualified",`,
      `   * which is otherwise indistinguishable from a silent prune rule.`,
      `   */`,
      `  get observed(): number {`,
      `    return this.observedCount;`,
      `  }`,
    ),
    (src) => src.includes("this.observedCount += 1;"),
  ],
  [
    "src/scanner.ts",
    "…and holds the field",
    lines(`  private recoveredCount = 0;`, `  private prunedCount = 0;`),
    lines(
      `  private recoveredCount = 0;`,
      `  private prunedCount = 0;`,
      `  private observedCount = 0;`,
    ),
    (src) => src.includes("private observedCount = 0;"),
  ],
  [
    "src/scanner.ts",
    "the summary carries the per-tick observable",
    lines(
      `   * acceptance point is this rising while \`deferPending\` falls.`,
      `   */`,
      `  deferPruned?: number;`,
    ),
    lines(
      `   * acceptance point is this rising while \`deferPending\` falls.`,
      `   */`,
      `  deferPruned?: number;`,
      `  /**`,
      `   * Owed coins this tick's evaluation JUDGED (see noteDeferredCoin). 0 on a`,
      `   * tick whose registry was cold at scan time, or whose evaluation never`,
      `   * ran — the number that tells a silent rule from an unfed one.`,
      `   */`,
      `  deferObserved?: number;`,
    ),
    (src) => src.includes("deferObserved?: number;"),
  ],
  [
    "src/scanner.ts",
    "and publishes it with the other deferral counters",
    lines(
      `      deferPruned: this.deferredPushes.pruned,`,
      `      rejects: [],`,
    ),
    lines(
      `      deferPruned: this.deferredPushes.pruned,`,
      `      deferObserved: 0,`,
      `      rejects: [],`,
    ),
    (src) => src.includes("deferObserved: 0,"),
  ],
  [
    "src/scanner.ts",
    "the refresh after matchCoins is what lands the retirement on THIS tick",
    lines(
      `      const agedEval = { count: 0 };`,
      `      const candidates = this.matchCoins(`,
    ),
    lines(
      `      const agedEval = { count: 0 };`,
      `      // Owed coins this evaluation is about to judge (see noteDeferredCoin):`,
      `      // read as a diff of the ledger's cumulative counter, so a rebuilt`,
      `      // scanner — whose counters restart at zero — cannot skew it.`,
      `      const deferObservedBefore = this.deferredPushes.observed;`,
      `      const candidates = this.matchCoins(`,
    ),
    (src) => src.includes("const deferObservedBefore = this.deferredPushes.observed;"),
  ],
  [
    "src/scanner.ts",
    "and it refreshes the tick's own counters (the fix itself)",
    lines(
      `      diag.agedEval = agedEval.count;`,
      `      diag.candidates = candidates.length;`,
    ),
    lines(
      `      diag.agedEval = agedEval.count;`,
      `      diag.candidates = candidates.length;`,
      `      // The prune's counters belong to THIS tick, so they are refreshed`,
      `      // here — the same pattern the recovery path uses for`,
      `      // deferRecovered/deferPending at its send site. The diag object is`,
      `      // built at tick start and the durable write reads it at the tail, so`,
      `      // leaving these at their start-of-tick values would push a`,
      `      // retirement into the NEXT tick's summary — which normally never`,
      `      // comes (cron ticks land on freshly recycled isolates), leaving the`,
      `      // row with the full pending list, which the next cold isolate then`,
      `      // re-seeds into its registry. Measured on the first deploy:`,
      `      // deployments of make-up coins went out every tick, agedEval moved,`,
      `      // and prunedTotal still read 0 — the rule had no way to persist.`,
      `      diag.deferObserved = this.deferredPushes.observed - deferObservedBefore;`,
      `      diag.deferPruned = this.deferredPushes.pruned;`,
      `      diag.deferPending = this.deferredPushes.pendingCount;`,
    ),
    (src) => src.includes("diag.deferObserved = this.deferredPushes.observed - deferObservedBefore;"),
  ],
  [
    "scripts/test-unit.js",
    "the wiring guard pins the same-tick refresh",
    lines(
      `      "scanner (the ledger and the summary carry the cursor)":`,
      `        scannerSrc.includes("getpruned():number{returnthis.prunedCount;}") &&`,
    ),
    lines(
      `      "scanner (the ledger and the summary carry the cursor)":`,
      `        scannerSrc.includes("getpruned():number{returnthis.prunedCount;}") &&`,
      `        scannerSrc.includes("getobserved():number{returnthis.observedCount;}") &&`,
      `        // The refresh runs on the TICK'S OWN summary: without it a`,
      `        // retirement only reaches the next summary, which normally never`,
      `        // comes (one tick per freshly recycled isolate) — the first`,
      `        // deploy's measured failure.`,
      `        scannerSrc.includes(`,
      `          "diag.deferObserved=this.deferredPushes.observed-deferObservedBefore;",`,
      `        ) &&`,
      `        scannerSrc.includes("diag.deferPruned=this.deferredPushes.pruned;") &&`,
      `        scannerSrc.includes("diag.deferPending=this.deferredPushes.pendingCount;") &&`,
      `        scannerSrc.includes(`,
      `          "constdeferObservedBefore=this.deferredPushes.observed;",`,
      `        ) &&`,
    ),
    (src) =>
      src.includes('scannerSrc.includes("diag.deferPruned=this.deferredPushes.pruned;")'),
  ],
  [
    "scripts/test-unit.js",
    "and the summary's new field is part of the shape",
    lines(
      `        scannerSrc.includes("deferPruned?:number;") &&`,
      `        scannerSrc.includes("deferPruned:this.deferredPushes.pruned,"),`,
    ),
    lines(
      `        scannerSrc.includes("deferPruned?:number;") &&`,
      `        scannerSrc.includes("deferPruned:this.deferredPushes.pruned,") &&`,
      `        scannerSrc.includes("deferObserved?:number;") &&`,
      `        scannerSrc.includes("deferObserved:0,"),`,
    ),
    (src) => src.includes('scannerSrc.includes("deferObserved?:number;")'),
  ],
  [
    "scripts/test-unit.js",
    "the ledger-method assertion follows its new body",
    lines(
      `        scannerSrc.includes(`,
      `          "noteCoinAge(token:string,ageMs:number|null,windowMaxAgeMs:number):void{if(noteDeferredCoin(token,{ageMs,windowMaxAgeMs}))this.prunedCount+=1;}",`,
      `        ) &&`,
    ),
    lines(
      `        scannerSrc.includes(`,
      `          "noteCoinAge(token:string,ageMs:number|null,windowMaxAgeMs:number):void{this.observedCount+=1;if(noteDeferredCoin(token,{ageMs,windowMaxAgeMs}))this.prunedCount+=1;}",`,
      `        ) &&`,
    ),
    (src) => src.includes("this.observedCount+=1;if(noteDeferredCoin"),
  ],
  [
    "docs/round-trips.md",
    "§4.26 records the same-tick refresh lesson",
    DOC_ANCHOR,
    DOC_NOTE,
    (src) => src.includes("落線後第一個 bug（同日修）：counter 一定要喺同一 tick refresh"),
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
