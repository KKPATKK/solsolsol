#!/usr/bin/env node
/**
 * Deferred-prune cursor fix (2026-09-26): count the retirements on the LEDGER,
 * not in the module-level registry.
 *
 * WHY THIS EXISTS. The prune's counter rides the deferral CURSOR
 * (`pushDeferralDelta(baseline, totals)` + the `applied` marker), and the
 * dead-tick rebuild resets that baseline to zero because the rebuilt Scanner's
 * counters restart there — the pairing only works if the counter restarts with
 * the Scanner. `deferredPrunedTotal()` lives in src/deferredmakeup.ts, which is
 * MODULE state: a rebuild (Scanner + baseline replaced, module state kept)
 * would then offer every retirement since boot as a fresh delta, once per
 * rebuild, and the durable `prunedTotal` would inflate.
 *
 * The fix is the shape `recovered` already uses: the count belongs to
 * `DeferredPushLedger`, incremented when an observation retires something, so
 * the rebuild's zeroed baseline is matched by a zeroed counter. The registry's
 * own cumulative stays — it is what `/debug/deferral`'s per-isolate view
 * reports ("this isolate retired N since it booted") — and the two are
 * documented as different questions.
 *
 * Also re-points the wiring guard at the ledger-mediated call site.
 *
 * Run: node docs/patches/deferred-prune-cursor-fix-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/scanner.ts",
    "the ledger owns the retirement cursor",
    lines(
      `export class DeferredPushLedger {`,
      `  private recoveredCount = 0;`,
      ``,
      `  constructor(private readonly maxEntries = 500) {}`,
    ),
    lines(
      `export class DeferredPushLedger {`,
      `  private recoveredCount = 0;`,
      `  private prunedCount = 0;`,
      ``,
      `  constructor(private readonly maxEntries = 500) {}`,
    ),
    (src) => src.includes("private prunedCount = 0;"),
  ],
  [
    "src/scanner.ts",
    "a retirement is counted where this scanner sees it happen",
    lines(
      `  /**`,
      `   * Obligations the registry RETIRED as unpayable (see noteDeferredCoin):`,
      `   * the coin aged past every enabled chat's max age, or had no pair data`,
      `   * for DEFERRED_PRUNE_ATTEMPTS consecutive make-up observations.`,
      `   *`,
      `   * Cumulative like \`recovered\`, and the worker folds it into the durable`,
      `   * row on the same cursor discipline (baseline + applied marker). It is`,
      `   * not only telemetry: a tick whose only new fact is a retirement has to`,
      `   * REWRITE that row, because the row is what carries the pending list`,
      `   * this shrank — a recycled isolate re-seeds from it.`,
      `   */`,
      `  get pruned(): number {`,
      `    return deferredPrunedTotal();`,
      `  }`,
      ``,
    ),
    lines(
      `  /**`,
      `   * Feed one owed coin's make-up facts to the registry and count the`,
      `   * retirement here when it happens (see noteDeferredCoin).`,
      `   *`,
      `   * The count is LOCAL — this scanner's own — for the reason \`recovered\` is:`,
      `   * it is a CURSOR (worker baseline + applied marker), and the dead-tick`,
      `   * rebuild zeroes that baseline together with the Scanner that owns this`,
      `   * ledger, while the registry's cumulative survives it (module state).`,
      `   * Reporting the registry's total here would re-offer every retirement`,
      `   * since boot as fresh, once per rebuild.`,
      `   */`,
      `  noteCoinAge(token: string, ageMs: number | null, windowMaxAgeMs: number): void {`,
      `    if (noteDeferredCoin(token, { ageMs, windowMaxAgeMs })) this.prunedCount += 1;`,
      `  }`,
      ``,
      `  /**`,
      `   * Obligations this scanner RETIRED as unpayable (see noteDeferredCoin):`,
      `   * the coin aged past every enabled chat's max age, or had no pair data`,
      `   * for DEFERRED_PRUNE_ATTEMPTS consecutive make-up observations.`,
      `   *`,
      `   * Cumulative like \`recovered\`, and the worker folds it into the durable`,
      `   * row on the same cursor discipline (baseline + applied marker). It is`,
      `   * not only telemetry: a tick whose only new fact is a retirement has to`,
      `   * REWRITE that row, because the row is what carries the pending list`,
      `   * this shrank — a recycled isolate re-seeds from it. That write is also`,
      `   * why the counter must restart with the Scanner (see noteCoinAge).`,
      `   */`,
      `  get pruned(): number {`,
      `    return this.prunedCount;`,
      `  }`,
      ``,
    ),
    (src) => src.includes("get pruned(): number {\n    return this.prunedCount;"),
  ],
  [
    "src/scanner.ts",
    "and matchCoins reports through the ledger",
    lines(
      `      if (isDeferredToken(profile.tokenAddress)) {`,
      `        noteDeferredCoin(profile.tokenAddress, {`,
      `          ageMs: pair ? Date.now() - pair.pairCreatedAt : null,`,
      `          windowMaxAgeMs: widestMaxAgeMs,`,
      `        });`,
      `      }`,
    ),
    lines(
      `      if (isDeferredToken(profile.tokenAddress)) {`,
      `        this.deferredPushes.noteCoinAge(`,
      `          profile.tokenAddress,`,
      `          pair ? Date.now() - pair.pairCreatedAt : null,`,
      `          widestMaxAgeMs,`,
      `        );`,
      `      }`,
    ),
    (src) => src.includes("this.deferredPushes.noteCoinAge("),
  ],
  [
    "src/scanner.ts",
    "the now-unused registry-total import goes away",
    lines(
      `import {`,
      `  addDeferredToken,`,
      `  deferredPrunedTotal,`,
      `  deferredTokenList,`,
    ),
    lines(
      `import {`,
      `  addDeferredToken,`,
      `  deferredTokenList,`,
    ),
    (src) => !src.includes("  deferredPrunedTotal,"),
  ],
  [
    "scripts/test-unit.js",
    "the wiring guard follows the ledger-mediated call site",
    lines(
      `    const hookAt = scannerSrc.indexOf("noteDeferredCoin(profile.tokenAddress,{");`,
    ),
    lines(
      `    const hookAt = scannerSrc.indexOf("this.deferredPushes.noteCoinAge(");`,
    ),
    (src) => src.includes('scannerSrc.indexOf("this.deferredPushes.noteCoinAge(")'),
  ],
  [
    "scripts/test-unit.js",
    "and the age/window assertions move to the new call shape",
    lines(
      `        scannerSrc.includes(`,
      `          "ageMs:pair?Date.now()-pair.pairCreatedAt:null,windowMaxAgeMs:widestMaxAgeMs,",`,
      `        ) &&`,
      `        hookAt >= 0 &&`,
      `        skipAt > hookAt &&`,
      `        scannerSrc.includes("if(isDeferredToken(profile.tokenAddress)){"),`,
    ),
    lines(
      `        scannerSrc.includes(`,
      `          "this.deferredPushes.noteCoinAge(profile.tokenAddress,pair?Date.now()-pair.pairCreatedAt:null,widestMaxAgeMs,);",`,
      `        ) &&`,
      `        hookAt >= 0 &&`,
      `        skipAt > hookAt &&`,
      `        scannerSrc.includes("if(isDeferredToken(profile.tokenAddress)){"),`,
    ),
    (src) => src.includes("this.deferredPushes.noteCoinAge(profile.tokenAddress,"),
  ],
  [
    "scripts/test-unit.js",
    "and the ledger's own counter is what the summary reads",
    lines(
      `        scannerSrc.includes("getpruned():number{returndeferredPrunedTotal();}") &&`,
    ),
    lines(
      `        scannerSrc.includes("getpruned():number{returnthis.prunedCount;}") &&`,
      `        scannerSrc.includes(`,
      `          "noteCoinAge(token:string,ageMs:number|null,windowMaxAgeMs:number):void{if(noteDeferredCoin(token,{ageMs,windowMaxAgeMs}))this.prunedCount+=1;}",`,
      `        ) &&`,
    ),
    (src) => src.includes("getpruned():number{returnthis.prunedCount;}"),
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
