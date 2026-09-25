#!/usr/bin/env node
/**
 * 路徑 B：tracker pass 卡死／被殺，而唯一嘅證據係一個寫死咗嘅 `running`。
 *
 * WHAT HAPPENED (live 2026-09-25 02:56–03:0xZ, second episode)
 *   - `pushWatchPass = {phase: "running", note: "running", trackerMs: 0}` 卡住 60s+
 *     （下一個 tick 又開一個新 pass ⇒ 個 record 永遠停在 running）。
 *   - row 新鮮度 **fresh 0/31 → 1/30**（即係輪替停咗，唔係「慢」）。
 *   - 但個 tick 本身好健康：`tickProgress {stage postscan, ms 2530, subreqs 10}`、
 *     心跳 `phase done`、`dex http429 0 / blockedForMs 0`、`subreqs current 10–16`。
 *   - 而 drain 亦冇新失敗（`writeDrainErrorAgeMin 172`）。
 *   ⇒ 唔係 subrequest 撞頂（路徑 A，已修），亦唔係 feed。最可能係 Turso 3,000ms
 *     hard wall 落喺 pass 自己嘅 stage（listing／claim batch／note persist）。
 *
 * WHY THE ONLY EVIDENCE WAS A STUCK `running`
 *   1. pass 開頭寫 `running`、**最後一步**才寫最終 note（`pushWatchPass`），
 *      所以被殺＝永遠 running。
 *   2. pass 內部嘅 DB stage 其實**已經**逐個 try/catch（listing、recap claim、
 *      silent batch 都係「失敗就算」）⇒ 唔會 throw 出嚟；失敗只會變成
 *      `claimLost` 一個數字，而嗰個數字**只喺最後嗰個 note 度出現**。
 *   3. 所以要喺 DB 寫唔入嘅時候睇到實情，就只可以靠**記憶體**通道。
 *
 * THE FIX
 *   - `trackerPassPulse()`（pushwatch.ts，module state）：最後一個 pass 嘅
 *     `{at, doneAt, stage, checked, alerted, claimLost, note}`，喺 pass 開頭、row
 *     loop 之後（checked/claimLost 已知嗰刻）、同 pass 結尾更新。**零 DB 寫入**。
 *   - worker 每個 tick 嘅 heartbeat summary 加 `pushWatchLive`（上次 pass 嘅 pulse）
 *     同 `pushWatchFail`（worker 自己 catch 到嘅 throw，連 stage）⇒ 一條 `/health`
 *     就睇得到「pass 有冇行完、停喺邊個 stage、checked 幾多、claimLost 幾多」，
 *     即使 DB 當時寫唔入任何嘢。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PULSE = lines(
  "",
  "/**",
  " * The LAST pass's own account of itself, kept in MODULE MEMORY and nowhere",
  " * else (see trackerPassPulse).",
  " *",
  " * WHY memory: a pass that is killed mid-flight leaves its durable coverage row",
  " * (PUSH_WATCH_PASS_KEY) reading `running` — the row is written at the pass's",
  " * start and only overwritten at its very end — and every failure INSIDE the pass",
  " * is already swallowed by a stage-local catch (the listing, the recap claim and",
  " * the silent-row batch all fail soft). So during a database episode the durable",
  " * record cannot say what happened: the reason travels as a count (`claimLost`)",
  " * that only ever lands in the final note, i.e. in the write that just failed.",
  " * Live 2026-09-25: 60s+ of `phase: running` with rows going stale while the tick",
  " * itself was healthy (`postscan 2530ms`, 10 subrequests, no feed 429s).",
  " *",
  " * WHY these fields: they are the three questions the durable row could not",
  " * answer — did the pass FINISH (`doneAt`), WHERE did it stop (`stage`), and did",
  " * the rotation actually move (`checked`, `claimLost`). Read by the worker's",
  " * heartbeat summary as `pushWatchLive`, so one /health request carries it.",
  " */",
  "export interface TrackerPassPulse {",
  "  /** When the pass started (epoch ms). */",
  "  at: number;",
  "  /** When it returned, or null while it is in flight (or was killed). */",
  "  doneAt: number | null;",
  "  /** The pass's stage name: entry / setup / settle / heal / rows / holders. */",
  "  stage: string;",
  "  /** Rows evaluated so far (final once doneAt is set). */",
  "  checked: number;",
  "  /** Rows whose transition produced a card (final once doneAt is set). */",
  "  alerted: number;",
  "  /**",
  "   * Rows the claim batch did NOT win — a cross-isolate race OR a batch that",
  "   * failed outright. A pass that ends with `checked 0` and a large `claimLost`",
  "   * is a database refusing its writes, not a rotation with nothing to do.",
  "   */",
  "  claimLost: number;",
  "  /** The coverage note, once the pass returns (null while in flight). */",
  "  note: string | null;",
  "}",
  "",
  "let passPulse: TrackerPassPulse | null = null;",
  "",
  "/** The last pass's pulse, or null before this isolate has run one. */",
  "export function trackerPassPulse(): TrackerPassPulse | null {",
  "  return passPulse === null ? null : { ...passPulse };",
  "}",
  "",
  "/** Start a pulse (the pass's first act, next to `passStage = \"entry\"`). */",
  "function beginPassPulse(at: number): void {",
  "  passPulse = {",
  "    at,",
  "    doneAt: null,",
  "    stage: \"entry\",",
  "    checked: 0,",
  "    alerted: 0,",
  "    claimLost: 0,",
  "    note: null,",
  "  };",
  "}",
  "",
  "/** Update the pulse in place; a no-op when no pass has started. */",
  "function notePassPulse(fields: Partial<TrackerPassPulse>): void {",
  "  if (passPulse === null) return;",
  "  passPulse = { ...passPulse, ...fields };",
  "}",
);

const PATCHES = [
  // ── src/pushwatch.ts ─────────────────────────────────────────────────────
  {
    file: "src/pushwatch.ts",
    what: "the pulse exists, with the reason it is memory-only",
    marker: "export function trackerPassPulse()",
    anchor: "export const TRACKER_PAIR_HEAD = 30;",
    replacement: lines("export const TRACKER_PAIR_HEAD = 30;", PULSE),
  },
  {
    file: "src/pushwatch.ts",
    what: "the pass opens its pulse (after the clock it stamps it with)",
    marker: "beginPassPulse(now);",
    anchor: lines(
      "    const cfg = this.config.pushWatch;",
      "    const now = Date.now();",
    ),
    replacement: lines(
      "    const cfg = this.config.pushWatch;",
      "    const now = Date.now();",
      "    // Open the pulse the worker reads (trackerPassPulse) on the same clock the",
      "    // pass itself runs on: it survives a database that cannot take the note.",
      "    beginPassPulse(now);",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the row loop reports what it actually managed to evaluate",
    marker: 'notePassPulse({ stage: "rows", checked, alerted, claimLost });',
    anchor: "    spent.rows.ms = Date.now() - rowsStart;",
    replacement: lines(
      '    notePassPulse({ stage: "rows", checked, alerted, claimLost });',
      "    spent.rows.ms = Date.now() - rowsStart;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "and the pass closes it with its note",
    marker: "notePassPulse({\n      doneAt: Date.now(),",
    anchor: lines(
      "    return {",
      "      checked,",
      "      alerted,",
      "      deduped: dupSkipped,",
      "      note,",
      "      trips,",
    ),
    replacement: lines(
      "    // The pulse closes with the same numbers the note carries, but without a",
      "    // round trip: this is the reading a database episode cannot take away.",
      "    notePassPulse({",
      "      doneAt: Date.now(),",
      '      stage: this.passStage ?? "done",',
      "      checked,",
      "      alerted,",
      "      claimLost,",
      "      note,",
      "    });",
      "    return {",
      "      checked,",
      "      alerted,",
      "      deduped: dupSkipped,",
      "      note,",
      "      trips,",
    ),
  },
  // ── src/worker.ts ────────────────────────────────────────────────────────
  {
    file: "src/worker.ts",
    what: "the worker can read the pulse",
    marker: "  trackerPassPulse,",
    anchor: lines(
      "  pushWatchHealStats,",
      "  revivedBaseline,",
      "  terminalRowIssues,",
    ),
    replacement: lines(
      "  pushWatchHealStats,",
      "  revivedBaseline,",
      "  terminalRowIssues,",
      "  trackerPassPulse,",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the leaf is declared”, next to the tick it belongs to",
    marker: "let trackerPassFailure:",
    anchor: "export const SCAN_TICK_BUDGET_MS = 9_500;",
    replacement: lines(
      "export const SCAN_TICK_BUDGET_MS = 9_500;",
      "",
      "/**",
      " * The last tracker pass that THREW, with the isolate's own pulse of what it",
      " * had managed to do (see trackerPassPulse in pushwatch.ts).",
      " *",
      " * WHY it is module state and not a durable row: the pass writes its coverage",
      " * row twice — `running` at the start, the note at the very end — so a pass",
      " * that is killed mid-flight (or whose final write the database refuses) leaves",
      " * a durable record that says `running` forever. Live 2026-09-25: 60s+ of",
      " * `phase: running` with the rotation stalled while the tick itself was healthy.",
      " * The heartbeat summary carries this on the NEXT tick (the summary is built",
      " * before the pass runs), which is enough for a single /health read to name the",
      " * stage and the counters instead of a bare `running`.",
      " */",
      "let trackerPassFailure: {",
      "  at: number;",
      "  message: string;",
      "  live: ReturnType<typeof trackerPassPulse>;",
      "} | null = null;",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the pass failure stops being console-only, and a pass that ran clears it",
    marker: "live: trackerPassPulse(),",
    anchor: lines(
      "            subreqRemaining,",
      "          );",
      "        } catch (err) {",
      '          console.error(',
      '            "[worker] tracker pass failed:",',
      "            err instanceof Error ? err.message : err,",
      "          );",
      "        }",
    ),
    replacement: lines(
      "            subreqRemaining,",
      "          );",
      "          // The pass returned: its rotation ran, so the last failure is history.",
      "          trackerPassFailure = null;",
      "        } catch (err) {",
      "          // A pass can also be killed mid-flight (no catch ever runs), which is",
      "          // why the pulse below rides EVERY heartbeat: it carries the stage and",
      "          // the counters of whatever the last attempt managed to do.",
      "          const message = err instanceof Error ? err.message : String(err);",
      "          trackerPassFailure = {",
      "            at: Date.now(),",
      "            message: message.slice(0, 200),",
      "            live: trackerPassPulse(),",
      "          };",
      '          console.error("[worker] tracker pass failed:", message);',
      "        }",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the heartbeat carries both",
    marker: "view.pushWatchLive = trackerPassPulse();",
    anchor: "            view.writeDrain = writeDrainView();",
    replacement: lines(
      "            view.writeDrain = writeDrainView();",
      "            // The tracker's own account of its last pass, and the last failure",
      "            // the worker itself caught. Both are MODULE state on purpose: the",
      "            // pass's durable coverage row reads `running` for a pass that was",
      "            // killed, and the write that would have said why is the one the",
      "            // database just refused (live 2026-09-25).",
      "            view.pushWatchLive = trackerPassPulse();",
      "            view.pushWatchFail = trackerPassFailure;",
    ),
  },
  // ── repair: the call first landed before the clock it reads ──────────────
  {
    file: "src/pushwatch.ts",
    what: "drop the misplaced call next to passStage",
    marker: '    this.passStage = "entry";\n    this.subreqProbe =',
    anchor: lines(
      '    this.passStage = "entry";',
      "    // ... and publish the same thing to the pulse the worker reads",
      "    // (trackerPassPulse): it survives a database that cannot take the note.",
      "    beginPassPulse(now);",
    ),
    replacement: lines('    this.passStage = "entry";'),
  },
  {
    file: "src/pushwatch.ts",
    what: "and put it after `const now`",
    // NOTE: the marker is the CALL, not the placement: this entry's own replacement puts
    // two comment lines between `const now` and the call, so a placement-shaped
    // marker goes absent again the moment it is applied and every re-run inserts
    // another copy (see tracker-pass-pulse.fix1.apply.js). Entry 2 above already
    // carries the same marker, so on a patched tree this one reports `already`.
    marker: "beginPassPulse(now);",
    anchor: lines(
      "    const cfg = this.config.pushWatch;",
      "    const now = Date.now();",
    ),
    replacement: lines(
      "    const cfg = this.config.pushWatch;",
      "    const now = Date.now();",
      "    // Open the pulse the worker reads (trackerPassPulse) on the same clock the",
      "    // pass itself runs on: it survives a database that cannot take the note.",
      "    beginPassPulse(now);",
    ),
  },
  // ── the stage has to be LIVE, not a three-point snapshot ─────────────────
  // A pass killed INSIDE the row loop never reaches the publish below it, so a
  // pulse that only learned its stage at entry/rows/end reported `entry` for
  // exactly the incident this change exists for (live 2026-09-25 02:56Z). Each
  // stage now tells the pulse its own name where it tells the pass.
  {
    file: "src/pushwatch.ts",
    what: 'the pulse learns "setup" where the pass does',
    marker: 'notePassPulse({ stage: "setup" });',
    anchor: '    this.passStage = "setup";',
    replacement: lines(
      '    this.passStage = "setup";',
      '    notePassPulse({ stage: "setup" });',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: 'the pulse learns "settle" where the pass does',
    marker: 'notePassPulse({ stage: "settle" });',
    anchor: '    this.passStage = "settle";',
    replacement: lines(
      '    this.passStage = "settle";',
      '    notePassPulse({ stage: "settle" });',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: 'the pulse learns "heal" where the pass does',
    marker: 'notePassPulse({ stage: "heal" });',
    anchor: '    this.passStage = "heal";',
    replacement: lines(
      '    this.passStage = "heal";',
      '    notePassPulse({ stage: "heal" });',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: 'the pulse learns "rows" BEFORE the loop, not after it',
    marker: 'notePassPulse({ stage: "rows" });',
    anchor: '    this.passStage = "rows";',
    replacement: lines(
      '    this.passStage = "rows";',
      '    notePassPulse({ stage: "rows" });',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: 'the pulse learns "holders" where the pass does',
    marker: 'notePassPulse({ stage: "holders" });',
    anchor: '    this.passStage = "holders";',
    replacement: lines(
      '    this.passStage = "holders";',
      '    notePassPulse({ stage: "holders" });',
    ),
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
