#!/usr/bin/env node
/**
 * The candidate chain's subrequest fence (2026-09-25).
 *
 * Kept as a script for the same reason every other deep edit in this repo is
 * (see docs/round-trips.md §6): src/scanner.ts (231KB) is far past the file
 * tool's ~50KB edit window, so `str_replace` answers "old string not found" no
 * matter how exact the anchor is. fs.readFileSync/writeFileSync round-trip the
 * bytes exactly.
 *
 * What lands here:
 *   1. ScanSummary gains `chainFloor` / `chainDeferred` — the reading that says
 *      the chain fence fired and how many candidates it deferred (and
 *      `subreqSkip` now names `chain` beside the optional legs).
 *   2. The chain loop's fence: stop STARTING coins once only the completion
 *      flush's own retry ladder is left (`CHAIN_SUBREQ_FLOOR`, defined in the
 *      constant block above).
 *   3. A de-dupe pass: the first run of this script inserted the fence block
 *      twice (its anchor — the deadline break — stays unique after the insert,
 *      so a re-run matched it again). Collapsing the doubled block keeps a
 *      re-run of this script a no-op instead of a third copy.
 *
 * WHY (live 2026-09-25, `/debug/scan-history?rows=500`): 32 of 500 ticks died
 * before their completion flush and 15 of those had the phase ladder frozen at
 * `gate` — the chain's entrance — with a LOW subrequest count (10-30 of the
 * usable 38), because every write after it was refused too. The chain is the
 * only unfenced spend in the scan: the optional front legs stand down at
 * `SCAN_SUBREQ_FLOOR` and the tracker pass carries its own reserve, but a heavy
 * chain (per-candidate enrichment, each leg a fetch) walked the invocation into
 * the 50-subrequest ceiling, and the completion batch — the one call a tick
 * cannot lose — was what the runtime refused. Deferring the coin instead costs
 * one tick of latency (the re-eval pool re-offers it, exactly as the chain
 * deadline break does); dying costs the whole tick, the tracker pass, and the
 * backfilled row the operator reads.
 *
 * Verify-then-write, unique-hit-only: any anchor that is missing or ambiguous
 * aborts the WHOLE run before a single byte is written.
 *
 * Run: node docs/patches/chain-subreq-fence-2026-09-25.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const lines = (...xs) => xs.join("\n");

/** The fence block exactly as it is inserted into the chain loop. */
const FENCE = lines(
  "        // SUBREQUEST FENCE (see CHAIN_SUBREQ_FLOOR): the chain is the last",
  "        // stage of the scan that can spend the invocation's allowance, and",
  "        // the completion flush behind it is the one call the tick cannot",
  "        // lose. Stop STARTING coins once only that flush's own retry ladder",
  "        // is left, and name both the fence and the coins it deferred — the",
  "        // re-eval pool re-offers them next scan, the same trade the deadline",
  "        // break below already makes (a tick of latency, never a lost push).",
  "        // Without this, a heavy chain spent the tail and the runtime refused",
  "        // the completion batch instead: the successor then backfilled",
  "        // `previous tick died before its completion flush` with the phase",
  "        // ladder frozen at `gate` — the chain's own entrance.",
  "        if (subreqsLeft() <= CHAIN_SUBREQ_FLOOR) {",
  "          this.markPhase(diag, \"deferred\", startedAt);",
  "          diag.chainFloor = CHAIN_SUBREQ_FLOOR;",
  "          diag.subreqSkip = [...(diag.subreqSkip ?? []), \"chain\"];",
  "          diag.chainDeferred = candidates.length - processedCandidates;",
  "          console.warn(",
  "            `[scanner] subrequest floor reached with ${subreqsLeft()} left — deferring ${candidates.length - processedCandidates} candidate(s) to next tick`,",
  "          );",
  "          break;",
  "        }",
);

/** The deadline break the fence is inserted in front of. */
const DEADLINE_BREAK = lines(
  "        if (this.abortRequested || Date.now() > chainDeadline) {",
  "          this.markPhase(diag, \"deferred\", startedAt);",
  "          console.log(",
  "            `[scanner] chain deadline reached — deferring ${candidates.length - processedCandidates} candidate(s) to next tick`,",
  "          );",
  "          break;",
  "        }",
);

/**
 * [file, label, old, new, skipIf?] — every replacement is exact-match, unique.
 * `skipIf` covers an edit whose ANCHOR stays unique after the insert (the
 * deadline break does), so a re-run reports "already applied" instead of
 * stacking a second copy.
 */
const EDITS = [
  // -------------------------------------------------------------- scanner.ts
  [
    "src/scanner.ts",
    "ScanSummary: the fence's own fields (chainFloor / chainDeferred)",
    lines(
      "   * `backfill`, `crime-refresh`). Present only alongside `subreqFloor`.",
      "   */",
      "  subreqSkip?: string[];",
    ),
    lines(
      "   * `backfill`, `crime-refresh`), plus `chain` when the CANDIDATE CHAIN",
      "   * itself stood down (see CHAIN_SUBREQ_FLOOR). Present only alongside",
      "   * `subreqFloor`.",
      "   */",
      "  subreqSkip?: string[];",
      "  /**",
      "   * Set only on a tick whose candidate chain stopped at the subrequest fence",
      "   * (`CHAIN_SUBREQ_FLOOR`): the allowance it refused to START another coin",
      "   * without — `subreqSkip` then names `chain`.",
      "   */",
      "  chainFloor?: number;",
      "  /**",
      "   * Candidates (coins, not per-chat cards) this tick's chain fence deferred to",
      "   * the next scan; absent = every candidate that reached the chain was",
      "   * processed. This is the reading that separates \"the fence is buying the",
      "   * flush back\" from \"the fence is silently eating candidates every tick\".",
      "   */",
      "  chainDeferred?: number;",
    ),
  ],
  [
    "src/scanner.ts",
    "the chain loop: stop starting coins below the subrequest floor",
    DEADLINE_BREAK,
    lines(FENCE, DEADLINE_BREAK),
    (src) => src.includes(FENCE),
  ],
  [
    "src/scanner.ts",
    "de-dupe: collapse the doubled fence block",
    lines(FENCE, FENCE, DEADLINE_BREAK),
    lines(FENCE, DEADLINE_BREAK),
  ],
  [
    "src/scanner.ts",
    "doc tidy: a stray paren left by the first run's insert",
    "   * (`backfill`, `crime-refresh`), plus `chain` when the CANDIDATE CHAIN",
    "   * `backfill`, `crime-refresh`), plus `chain` when the CANDIDATE CHAIN",
  ],
];

/**
 * Append-only pointers (docs/round-trips.md and docs/profiles-feed-zeros.md are
 * both past the file tool's window too, and an append needs no anchor).
 * Idempotent: skipped when the last line of the block is already there.
 */
const POINTER = "全部細節、代價同驗收步驟：`docs/tick-spend-and-profiles-2026-09-25.md`。";
const APPENDS = [
  [
    "docs/round-trips.md",
    lines(
      "",
      "---",
      "",
      "## 4.19 死 tick 嘅收費閘：candidate chain 自己一個 floor（2026-09-25）",
      "",
      "500 行 scan-history 裡 32 個 `previous tick died before its completion flush`，15 個嘅階段 stamp",
      "停喺 `gate`（chain 入口）而 count 偏低（10–30 / 可用 38）—— 即係爆嘅係 invocation 嘅 50",
      "subrequest，而 stamp 自己都係 subrequest，所以連證據都寫唔入。scan 側一直只有可選腿嘅",
      "`SCAN_SUBREQ_FLOOR` 同 tracker pass 嘅 reserve，**chain 完全冇閘**。",
      "",
      "落咗：`CHAIN_SUBREQ_FLOOR = 3`（＝ completion flush 整條重試梯：attempt 1 ＋ racing retry ＋",
      "backoff retry）—— chain 開始每個 coin 之前問一次，唔夠就 defer＋點名（`summary.chainFloor` /",
      "`chainDeferred` / `subreqSkip` 多一個 `chain`），取捨同隔籬嗰個 deadline break 一樣（coin 留喺",
      "re-eval pool，一次延遲，唔係漏推）。同時 list feed（profiles / boosts）改用 colo edge cache",
      "（`cacheEverything` ＋ `cacheTtl 60` ＋ `cacheTtlByStatus` 把 4xx/5xx 拒之門外），因為",
      "`raw 0` 嘅 27% 對得上 `/debug/dex429` 嘅 17 次/鐘 —— 共用 egress IP 嘅 429，唔係我哋嘅 spacing。",
      "",
      "全部細節、代價同驗收步驟：`docs/tick-spend-and-profiles-2026-09-25.md`。",
    ),
    POINTER,
  ],
  [
    "docs/profiles-feed-zeros.md",
    lines(
      "",
      "---",
      "",
      "# 後續（2026-09-25）：`raw 0` 嘅 27% 係共用 egress IP 嘅 429，用 colo edge cache 收",
      "",
      "上一節嘅修法（tick 開頭就 dispatch profiles call）解決咗「窗口被前段偷走」，但 live 仍然有",
      "133/464 tick（27%）`lastRawProfiles 0`，只靠 8 條 make-up。今次度到：`/debug/dex429` 嘅",
      "durable ring 係 **17 次/鐘**，同 27% × 60 tick ≈ 16 幾乎一樣 ⇒ 每個 429 就係嗰個 tick 嘅",
      "空白。DexScreener 係逐來源 IP 限流，Worker 嘅 egress IP 係全 fleet 共用，所以**我哋自己",
      "點樣 spacing 都補唔返人哋花咗嘅桶**；改得到嘅係「個 request 有冇去到 origin」。",
      "",
      "所以兩個 list feed 改用 gecko leg 一直用嘅 edge-cache 寫法（`cacheEverything` ＋",
      "`cacheTtl 60` ＋ `cacheTtlByStatus` 唔 cache 4xx/5xx），pair batch 刻意唔套（gate/tracker 判嘅",
      "metrics 要新鮮）。順手加咗 `listCacheHits` / `lastListCacheStatus` / `budgetDrops`：之前",
      "「被 429 拒」同「窗口用完、request 根本冇發出」喺 counter 上分唔開。",
      "",
      "驗收同代價：`docs/tick-spend-and-profiles-2026-09-25.md`。",
    ),
    "驗收同代價：`docs/tick-spend-and-profiles-2026-09-25.md`。",
  ],
];

let failed = 0;
for (const [file, text, marker] of APPENDS) {
  const abs = path.join(root, file);
  const src = fs.readFileSync(abs, "utf8");
  if (src.includes(marker)) {
    console.log(`skip ${file}: pointer (already appended)`);
    continue;
  }
  fs.writeFileSync(abs, `${src.replace(/[\s]+$/, "")}\n${text}\n`);
  console.log(`ok   ${file}: pointer appended`);
}
for (const [file, label, oldText, newText, skipIf] of EDITS) {
  const abs = path.join(root, file);
  const src = fs.readFileSync(abs, "utf8");
  const hits = src.split(oldText).length - 1;
  if (typeof skipIf === "function" && hits === 1 && skipIf(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  if (hits === 0 && newText !== oldText && src.includes(newText)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  if (hits !== 1) {
    console.error(
      `ABORT ${file}: anchor "${label}" matched ${hits} times (want exactly 1)`,
    );
    failed += 1;
    continue;
  }
  fs.writeFileSync(abs, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (failed > 0) {
  console.error(`\n${failed} anchor(s) failed — NO file was written for those.`);
  process.exit(1);
}
console.log("\nall anchors applied.");
