#!/usr/bin/env node
/**
 * 讓 scan 讀住個 subrequest 計數器，低水位時唔再花喺**可選**嘅腿上。
 *
 * WHY (live 2026-09-25)
 *   一個 cron tick 嘅 window：`total 32 | turso 29`（另外兩個 sample 24 / 20），
 *   而 tracker pass 永遠係最後一個跑嘅階段 —— 佢有自己嘅 reserve
 *   （TRACKER_SUBREQ_FLOOR 3 / _RESERVE 6，drain 側 DRAIN_TRACKER_RESERVE 14），
 *   但佢**追唔返**前面已經花咗嘅。冷 isolate 上 pass 第一個 Turso call 就係俾
 *   runtime 拒嗰個（`err:Too many subrequests … [rows subreq 12]`）。
 *
 *   全條 tick 入面，唯一真正「可選」嘅工作就係 scan 嘅 discovery 腿：
 *   momentum trending（geoTrend / jupTrend / gmgn / axiom）同最後手段嘅
 *   launch 腿（meteora）＋ 兩個背景任務（Birdeye backfill、crime list 刷新）。
 *   每一條都係 1 個 subrequest，少做一次只係少一個 tick 嘅覆蓋 —— 池同 client
 *   快取都仲在 —— 但**唔會少一張卡**：DexScreener profiles、gecko new_pools、
 *   pump.fun、Jupiter recent 四個主腿照跑，卡片 enrichment 亦**刻意唔 gated**
 *   （docs/round-trips.md §4.4.2：cut 一個付費 call 會改卡片顯示）。
 *
 * Semantics：`marker` = 已應用嘅證據，anchor 必須唯一，refuse to leave the tree
 * half-patched，重跑要 0 file(s) written。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FLOOR = lines(
  "/**",
  " * Subrequests the scan refuses to spend on OPTIONAL work, so the tick's tail",
  " * still fits (`SCAN_SUBREQ_FLOOR`).",
  " *",
  " * WHY A SCAN-SIDE FLOOR (2026-09-25): the invocation's allowance is shared,",
  " * and the tracker pass is its residual claimant — it runs LAST, it defers by",
  " * name (`deferred:subreq-budget`) when the front has already spent the",
  " * allowance, and on a cold isolate its first Turso call is the one the",
  " * runtime refuses (`err:Too many subrequests … [rows subreq 12]`). The pass",
  " * carries its own reserve (TRACKER_SUBREQ_FLOOR / _RESERVE) but it cannot CLAW",
  " * BACK what the scan already spent, and the scan is the only phase with work",
  " * that is genuinely optional: momentum feeds and the last-resort launch legs.",
  " *",
  " * WHAT IT DROPS, in the order the legs would have run: the Meteora",
  " * last-resort launch leg, the GeckoTerminal and Jupiter momentum trending",
  " * legs, the GMGN and Axiom trending legs, the periodic Birdeye backfill and",
  " * the crime-wallet list refresh. Each is one subrequest, and each is a leg",
  " * whose absence costs coverage for ONE tick — the re-eval pool keeps the coin",
  " * and the clients keep their TTL — never a card, and never a primary feed:",
  " * DexScreener's profiles, gecko's new_pools, pump.fun and Jupiter's recent",
  " * launches keep running whatever the counter says. Card enrichment is",
  " * deliberately NOT gated (see docs/round-trips.md §4.4.2: dropping a paid card",
  " * call changes what the card SHOWS), so the floor protects alerts by yielding",
  " * discovery breadth instead.",
  " *",
  " * The number: the tail needs the pass's own tail reserve (6) plus the grouped",
  " * post-scan telemetry (one read + one batch write), the completion flush (one",
  " * batch) and the write drain's tracker slice — 12 VISIBLE subrequests, the",
  " * same arithmetic DRAIN_TRACKER_RESERVE (14) encodes on the write side. Every",
  " * leg it drops is NAMED in the summary (`subreqSkip`), so a quiet momentum",
  " * feed can never be mistaken for an upstream outage.",
  " */",
  "export const SCAN_SUBREQ_FLOOR = 12;",
);

const HELPERS = lines(
  "    // LOW-WATER GATE (see SCAN_SUBREQ_FLOOR). The invocation's allowance is",
  "    // shared with the tick's tail, and the scan is the only phase whose work is",
  "    // optional — so the optional legs below ask this first. A dropped leg is",
  "    // NAMED in the summary, so a quiet feed is never read as an outage.",
  "    //",
  "    // `subreqLeft` is injectable for the same reason the tracker pass takes",
  "    // one: a caller that owns a different window — and every test — can say",
  "    // what \"no room left\" means. No probe = unbounded, i.e. a scanner driven",
  "    // without the worker behaves exactly as it did before this floor existed.",
  "    const subreqsLeft = (): number => {",
  "      const left = subreqLeft();",
  "      return Number.isFinite(left) ? left : Number.POSITIVE_INFINITY;",
  "    };",
  "    const dropOptionalLeg = (leg: string): boolean => {",
  "      if (subreqsLeft() > SCAN_SUBREQ_FLOOR) return false;",
  "      diag.subreqFloor = SCAN_SUBREQ_FLOOR;",
  "      diag.subreqSkip = [...(diag.subreqSkip ?? []), leg];",
  "      return true;",
  "    };",
);

const SUMMARY_FIELDS = lines(
  "  dbSteps?: Record<string, { calls: number; ms: number }>;",
  "  /**",
  "   * Set only on a tick that applied the scan-side subrequest floor",
  "   * (`SCAN_SUBREQ_FLOOR`): the allowance it refused to spend, so /health can",
  "   * tell \"the momentum feeds ran and found nothing\" from \"they were never",
  "   * asked\". The legs themselves are named in `subreqSkip`.",
  "   */",
  "  subreqFloor?: number;",
  "  /**",
  "   * The OPTIONAL legs this tick dropped to protect the tick's tail, by name",
  "   * (`meteora`, `geoTrend`, `gmgn`, `axiom`, `jupTrend`, `backfill`,",
  "   * `crime-refresh`). Present only alongside `subreqFloor`.",
  "   */",
  "  subreqSkip?: string[];",
);

const BACKFILL_OLD = lines(
  "      try {",
  "        diag.backfill = await this.fetchFeedCapped(",
  "          () => this.runPeriodicBackfill(),",
  "          0,",
  "          feedDeadline,",
  "        );",
  "      } catch (err) {",
  "        console.error(",
  '          "[scanner] periodic backfill failed:",',
  "          err instanceof Error ? err.message : err,",
  "        );",
  "      }",
);

const BACKFILL_NEW = lines(
  "      // The backfill is the safety net for discovery GAPS (it re-seeds coins",
  "      // the feeds rolled past), and it pays a Birdeye call AND a DB write — so",
  "      // it is the first thing to yield when the invocation is low (see",
  "      // SCAN_SUBREQ_FLOOR). Its interval gate is unchanged: the next tick with",
  "      // room runs it.",
  '      if (!dropOptionalLeg("backfill")) {',
  "        try {",
  "          diag.backfill = await this.fetchFeedCapped(",
  "            () => this.runPeriodicBackfill(),",
  "            0,",
  "            feedDeadline,",
  "          );",
  "        } catch (err) {",
  "          console.error(",
  '            "[scanner] periodic backfill failed:",',
  "            err instanceof Error ? err.message : err,",
  "          );",
  "        }",
  "      }",
);

const PATCHES = [
  // ---- the counter, the floor, and the seam the worker hands it through -----
  {
    file: "src/scanner.ts",
    what: "the scan can read the invocation's allowance",
    marker: 'import { subreqRemaining } from "./subreqs";',
    anchor: 'import { parseAxiomTokenInfo } from "./axiom";',
    replacement: lines(
      'import { parseAxiomTokenInfo } from "./axiom";',
      "// The invocation's shared subrequest allowance (see SCAN_SUBREQ_FLOOR).",
      "// The scan is the only phase with OPTIONAL work, so it is the one that",
      "// yields it — the tracker pass cannot claw back what the front spent.",
      'import { subreqRemaining } from "./subreqs";',
    ),
  },
  {
    file: "src/scanner.ts",
    what: "the floor is a named constant with its arithmetic",
    marker: "export const SCAN_SUBREQ_FLOOR = 12;",
    anchor: "export const SCAN_TICK_DEADLINE_MS = 4_200;",
    replacement: lines("export const SCAN_TICK_DEADLINE_MS = 4_200;", FLOOR),
  },
  {
    file: "src/scanner.ts",
    what: "runOnce takes the probe (default = the live counter)",
    marker: "async runOnce(subreqLeft: () => number = subreqRemaining)",
    anchor: "  async runOnce(): Promise<void> {",
    replacement: "  async runOnce(subreqLeft: () => number = subreqRemaining): Promise<void> {",
  },
  {
    file: "src/scanner.ts",
    what: "the summary can say the floor was applied, and to what",
    marker: "subreqSkip?: string[];",
    anchor: "  dbSteps?: Record<string, { calls: number; ms: number }>;",
    replacement: SUMMARY_FIELDS,
  },
  {
    file: "src/scanner.ts",
    what: "the gate exists, next to the diag it names the skips on",
    marker: "const dropOptionalLeg = (leg: string): boolean => {",
    anchor: lines("      rejects: [],", "    };"),
    replacement: lines("      rejects: [],", "    };", HELPERS),
  },
  // ---- the optional legs, in the order they would have run -----------------
  {
    file: "src/scanner.ts",
    what: "the crime-wallet refresh is optional (it pays a fetch AND a hydrate)",
    marker: 'if (this.crimeWallets && !dropOptionalLeg("crime-refresh"))',
    anchor: lines(
      "      if (this.crimeWallets) {",
      "        try {",
      "          await this.crimeWallets.refreshIfStale();",
    ),
    replacement: lines(
      '      if (this.crimeWallets && !dropOptionalLeg("crime-refresh")) {',
      "        try {",
      "          await this.crimeWallets.refreshIfStale();",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "the Meteora last resort yields",
    marker: 'meteoraFallbackLimit > 0 && !dropOptionalLeg("meteora")',
    anchor: "      if (this.meteora && this.config.meteoraFallbackLimit > 0) {",
    replacement:
      '      if (this.meteora && this.config.meteoraFallbackLimit > 0 && !dropOptionalLeg("meteora")) {',
  },
  {
    file: "src/scanner.ts",
    what: "the GeckoTerminal momentum leg yields",
    marker: '!dropOptionalLeg("geoTrend")',
    anchor: "      if (this.gecko && this.config.geckoterminalTrendingLimit > 0) {",
    replacement:
      '      if (this.gecko && this.config.geckoterminalTrendingLimit > 0 && !dropOptionalLeg("geoTrend")) {',
  },
  {
    file: "src/scanner.ts",
    what: "the GMGN momentum leg yields",
    marker: '!dropOptionalLeg("gmgn")',
    anchor: "      if (this.gmgn && this.config.gmgnTrendingLimit > 0) {",
    replacement:
      '      if (this.gmgn && this.config.gmgnTrendingLimit > 0 && !dropOptionalLeg("gmgn")) {',
  },
  {
    file: "src/scanner.ts",
    what: "the Axiom momentum leg yields (its session reads are Turso calls too)",
    marker: '!dropOptionalLeg("axiom")',
    anchor: "      if (this.axiom && this.config.axiomTrendingLimit > 0) {",
    replacement:
      '      if (this.axiom && this.config.axiomTrendingLimit > 0 && !dropOptionalLeg("axiom")) {',
  },
  {
    file: "src/scanner.ts",
    what: "the Jupiter momentum leg yields",
    marker: '!dropOptionalLeg("jupTrend")',
    anchor: "      if (this.jupiter && this.config.jupiterTrendLimit > 0) {",
    replacement:
      '      if (this.jupiter && this.config.jupiterTrendLimit > 0 && !dropOptionalLeg("jupTrend")) {',
  },
  {
    file: "src/scanner.ts",
    what: "the periodic backfill yields (it is the only optional leg that WRITES)",
    marker: 'if (!dropOptionalLeg("backfill")) {',
    anchor: BACKFILL_OLD,
    replacement: BACKFILL_NEW,
  },
  // ---- the seam, wired in both directions ----------------------------------
  {
    file: "src/worker.ts",
    what: "the tick hands its own allowance to the scan",
    marker: "scanner.runOnce(subreqRemaining),",
    anchor: "        scanner.runOnce(),",
    replacement: lines(
      "        // The scan is handed the invocation's remaining allowance so its",
      "        // OPTIONAL legs can yield before they starve the tail (see",
      "        // SCAN_SUBREQ_FLOOR): the tracker pass runs after this scan and is",
      "        // the residual claimant of the same 50.",
      "        scanner.runOnce(subreqRemaining),",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the probe's runOnce wrapper forwards the probe it was given",
    marker: "target.runOnce = async (subreqLeft?: () => number)",
    anchor: lines(
      "  target.runOnce = async (): Promise<unknown> => {",
      "    tickStartedAt = now();",
    ),
    replacement: lines(
      "  // The probe is forwarded, not dropped: the wrapper owns the worker's call",
      "  // site (`scanner.runOnce(subreqRemaining)`), and a scanner that silently",
      "  // fell back to the module counter would make the floor's seam dead in",
      "  // production while every test still passed.",
      "  target.runOnce = async (subreqLeft?: () => number): Promise<unknown> => {",
      "    tickStartedAt = now();",
    ),
  },
  // ── repair: only an ARMED backfill can be reported as dropped ───────────
  {
    file: "src/scanner.ts",
    what: "name the backfill only when the leg was going to run at all",
    marker: "const backfillArmed =",
    anchor: lines('      if (!dropOptionalLeg("backfill")) {', "        try {"),
    replacement: lines(
      "      // Only an ARMED backfill can be *dropped*: with no Birdeye client, or",
      "      // with the interval gate disabled, the leg was never going to run — and",
      "      // a skip name in the summary must never report a decision the floor did",
      "      // not actually make (see dropOptionalLeg).",
      "      const backfillArmed =",
      "        this.birdeye !== null && this.config.birdeyeBackfillEnabled;",
      '      if (!(backfillArmed && dropOptionalLeg("backfill"))) {',
      "        try {",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "the seam's own type carries the probe",
    marker: "runOnce: (subreqLeft?: () => number) => Promise<unknown>;",
    anchor: "export interface TickProbeSeam {\n  runOnce: () => Promise<unknown>;",
    replacement: lines(
      "export interface TickProbeSeam {",
      "  /**",
      "   * The tick's scan. The optional probe is the invocation's remaining",
      "   * subrequest allowance (see SCAN_SUBREQ_FLOOR in src/scanner.ts); the",
      "   * wrapper FORWARDS it instead of swallowing it. A scanner that takes no",
      "   * argument (every earlier shape, and every test double) still satisfies",
      "   * this: fewer parameters is assignable.",
      "   */",
      "  runOnce: (subreqLeft?: () => number) => Promise<unknown>;",
    ),
  },
  {
    file: "src/tickprobe.ts",
    what: "and the scanner actually receives it",
    marker: "return await runOnce(subreqLeft);",
    anchor: "      return await runOnce();",
    replacement: "      return await runOnce(subreqLeft);",
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
