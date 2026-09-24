#!/usr/bin/env node
/**
 * THE PHASE LADDER — subdividing `prog none`.
 *
 * WHY (2026-09-24, live). tick-progress-record.apply.js shipped the pre-flush
 * record and the successor's note; the first four deaths it captured ALL read
 * the same thing:
 *
 *   20:04:20.093Z ms 60171 [prog none: the row still holds an earlier tick's
 *   20:05:20.264Z ms 59980  stamp (at 1790280200095)]
 *   20:06:20.244Z ms 63824
 *   21:43:31.376Z ms 96151 [prog none: the row still holds an earlier tick's
 *                            stamp (at 1790286145702)]
 *
 * 1790280200095 / 1790286145702 are the PRE-FLUSH stamps of the healthy 20:03
 * (ms 2642) and 21:42 (ms 4801) ticks. So four of four dead ticks never wrote
 * a record of their own: the record could say "before the flush", which is
 * where the entire tick lives. That is the reading this patch splits.
 *
 * WHAT IT ADDS. The same `tick_progress` row, stamped again at each phase
 * boundary the tick crosses, through one strictly-ordered queue that the tick
 * never awaits:
 *
 *   scan  — the worker, once the tick is admitted (cron/gate/init/claim done,
 *           the scan itself not yet entered). Written before `scanner.runOnce()`.
 *   front — the discovery-feed phase returned (`diag.feedsMs`).
 *   pair  — the pool read AND the pair fetch returned, Jupiter fallback
 *           included (`diag.pairs`).
 *   gate  — the candidate chain is entered: registration read, eval, the
 *           per-chat gates, the push (stamped just before the registration
 *           loop, which is the last Turso round trip in front of them).
 *
 * plus the existing postscan / postscan-late / flush-* stages, which now ride
 * the same queue so a phase stamp can never overtake the record.
 *
 * THE COST MODEL (the only reason this is not four awaited writes):
 *   - ONE worker_state write per stamp, i.e. one subrequest. Nothing else.
 *   - NEVER awaited: the tick queues and walks on, so a stamp costs the tick
 *     ZERO wall clock. The write lands ~200ms later, while the tick is already
 *     in the next phase.
 *   - STRICTLY ordered (tickPhaseLadder): two writes to one row in flight at
 *     once could land out of order and let a LATER phase describe an earlier
 *     one. Each stamp chains on the previous one's settlement, and a refusal
 *     is absorbed so one refused write cannot stall the queue.
 *   - Only the last stamp to land survives, which is the point: the row names
 *     the LAST phase the tick reached AND stamped in time. A phase whose write
 *     never landed reads as the phase before it — a bounded unknown, the same
 *     discipline the missing record itself is reported with.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const DOC_HEADING = "## 2026-09-24（補）：死喺邊個階段 —— 細分 `prog none`";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "`tick_progress` 只寫喺 flush 之前，結果第一個上線之後嘅四次死亡，全部讀到同一句：",
  "",
  "| at | ms | err |",
  "|---|---|---|",
  "| 20:04:20.093Z | 60171 | `prog none: the row still holds an earlier tick's stamp (at 1790280200095)` |",
  "| 20:05:20.264Z | 59980 | 同上 |",
  "| 20:06:20.244Z | 63824 | 同上 |",
  "| 21:43:31.376Z | 96151 | 同上，held `1790286145702` |",
  "",
  "兩個 held 值（`20:03:20.095Z`、`21:42:25.702Z`）都係前一個**健康** tick 嘅 pre-flush stamp。",
  "即係話：四次死亡，無一次寫到自己嘅 record。record 只答到「flush 之前」，而 flush 之前就係成個 tick。",
  "",
  "## 加咗啲乜",
  "",
  "同一個 `tick_progress` row，行過每個階段邊界就再蓋一次，全部經一條嚴格排序嘅 queue，而 tick **唔等**佢：",
  "",
  "| stage | 邊個蓋 | 意思 |",
  "|---|---|---|",
  "| `scan` | worker（`scanner.runOnce()` 之前） | 已經入場：cron/gate/init/claim 過咗，scan 仲未開始 |",
  "| `front` | scanner（`diag.feedsMs`） | discovery feed 階段返咗 |",
  "| `pair` | scanner（`diag.pairs`） | pool read ＋ pair fetch（含 Jupiter fallback）返咗 |",
  "| `gate` | scanner（registration loop 之前） | 候選鏈入咗：registration read、eval、每 chat 嘅 gate、push |",
  "",
  "之後仍然係舊有嘅 `postscan` / `postscan-late` / `flush-hung` / `flush-failed` / `flush-retry-failed`，",
  "只係佢哋而家**排喺同一條 queue 尾**，所以階段 stamp 唔可能越過個 record。",
  "",
  "## 成本同界線",
  "",
  "- 每個 stamp = 一個 worker_state 寫入 = **1 個 subrequest**，冇其他。",
  "- **永遠唔 await**：tick 蓋完就走，成本係 0 wall clock；寫入大約 200ms 後落地，嗰時 tick 已經入咗下一階段。",
  "- **嚴格排序**（`tickPhaseLadder`）：同一行兩個 write 同時飛，落錯次序就會用「後一個階段」去描述一個未曾到過嗰度嘅 tick。",
  "  每個 stamp 排喺前一個 settle 之後，而拒絕會被 queue 食掉，所以一次被拒唔會卡死後面。",
  "- **只有最後落地嗰個 stamp 留低**，呢個就係要點：row 講嘅係「tick 到過、而寫入趕得及落地」嘅最後階段。",
  "  一個趕唔及落地嘅階段，會讀成前一階段 —— 有界嘅未知，同「冇 record」本身嘅處理一樣。",
  "- 死亡早過任何 stamp（連 `scan` 都落唔到）＝ 死喺 claim/init 前段，`prog none` 嗰句而家講明呢點。",
);

const PATCHES = [
  // ── src/worker.ts ────────────────────────────────────────────────────────
  {
    file: "src/worker.ts",
    what: "the record's stage field names the ladder it now carries",
    marker: "THE PHASE LADDER (see tickPhaseLadder)",
    anchor: lines(
      "  /**",
      "   * Where the tick was when it stamped: `postscan` (scan finished, flush in",
      "   * front of it), `postscan-late` (same point, but too late to wait for the",
      "   * stamp), `flush-hung`, `flush-failed`, `flush-retry-failed`.",
      "   */",
    ),
    replacement: lines(
      "  /**",
      "   * Where the tick was when it stamped.",
      "   *",
      "   * THE PHASE LADDER (see tickPhaseLadder) — stamped as the tick crosses each",
      "   * boundary, so a death BEFORE the flush can still be attributed to a phase:",
      "   * `scan` (admitted, the scan not yet entered), `front` (the discovery feeds",
      "   * returned), `pair` (the pool read and the pair fetch returned), `gate` (the",
      "   * candidate chain: registration, eval, the per-chat gates, the push).",
      "   *",
      "   * THE FLUSH STAGES, stamped once the scan is over: `postscan` (flush in",
      "   * front of it), `postscan-late` (same point, but too late to wait for the",
      "   * stamp), `flush-hung`, `flush-failed`, `flush-retry-failed`.",
      "   */",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the record's field list gets a name, so a stamp can be passed around",
    marker: "export interface TickProgressFields {",
    anchor: lines(
      "/** Build one. Time is taken here so `t`/`ms` can never disagree. */",
      "export function tickProgressRecord(fields: {",
      "  at: number;",
      "  stage: string;",
      "  payloadBytes: number;",
      "  scanMs: number;",
      "  preRaceMs: number;",
      "  subreqs: number;",
      "  cut: boolean;",
      "  err: string | null;",
      "}): string {",
    ),
    replacement: lines(
      "/**",
      " * What one stamp carries. `at` is the tick's startedAt — the value that keys",
      " * the record to ONE tick, which is what lets the successor refuse to credit",
      " * another tick's stamp to this death (see tickProgressNote).",
      " */",
      "export interface TickProgressFields {",
      "  at: number;",
      "  stage: string;",
      "  payloadBytes: number;",
      "  scanMs: number;",
      "  preRaceMs: number;",
      "  subreqs: number;",
      "  cut: boolean;",
      "  err: string | null;",
      "}",
      "",
      "/** Build one. Time is taken here so `t`/`ms` can never disagree. */",
      "export function tickProgressRecord(fields: TickProgressFields): string {",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the ladder itself",
    marker: "export interface TickPhaseLadder {",
    anchor: lines(
      "  return JSON.stringify(rec);",
      "}",
      "",
      "/**",
      " * Parse one back; null when it is not a record this code wrote. Strict on",
    ),
    replacement: lines(
      "  return JSON.stringify(rec);",
      "}",
      "",
      "/**",
      " * The tick's PHASE LADDER (see TICK_PROGRESS_KEY): the same one row, stamped",
      " * again as the tick crosses each phase boundary, so a tick that dies BEFORE",
      " * its pre-flush record can still be attributed to a phase instead of to the",
      " * whole pre-flush stretch.",
      " *",
      " * WHY (2026-09-24, live). The pre-flush record only lands once the scan is",
      " * over, and four of the first four deaths it captured (20:04-20:06Z, 21:43Z)",
      " * never wrote one of their own: every note read `prog none: the row still",
      " * holds an earlier tick's stamp`, i.e. the record could only say \"before the",
      " * flush\", which is where the entire tick lives. The phases in that stretch",
      " * are `scan` (admitted, scan not yet entered), `front` (the discovery feeds",
      " * returned), `pair` (the pool read and the pair fetch returned) and `gate`",
      " * (the candidate chain entered).",
      " *",
      " * THE COST MODEL, which is the only reason this is not four awaited writes:",
      " *",
      " *   - Each stamp is ONE worker_state write (one subrequest). Nothing else.",
      " *   - The ladder NEVER awaits them: the tick queues a stamp and walks on, so a",
      " *     stamp costs the tick ZERO wall clock. The write lands ~200ms later,",
      " *     while the tick is already in the next phase — which matters because the",
      " *     late tick is the one that dies, and this telemetry must never be the",
      " *     reason.",
      " *   - The queue is STRICTLY ordered: two writes to ONE row in flight at once",
      " *     could land out of order and let a LATER phase describe a tick that never",
      " *     got there. Each stamp chains on the previous one's settlement, and",
      " *     refusals are absorbed so one refused write cannot stall the row behind",
      " *     it.",
      " *   - The pre-flush record rides the SAME queue, which is what keeps the row",
      " *     honest: what the successor reads is the last stamp written, not a phase",
      " *     stamp that overtook it.",
      " *",
      " * Only the last stamp to land survives, and that is the reading: the row names",
      " * the last phase the tick reached AND stamped in time. A phase whose write",
      " * never landed reads as the phase before it — a bounded unknown.",
      " */",
      "export interface TickPhaseLadder {",
      "  /** Queue one stamp. Resolves when its own write has settled. */",
      "  stamp(fields: TickProgressFields): Promise<unknown>;",
      "  /** The queue as of this call — what the pre-flush record queues behind. */",
      "  tail(): Promise<unknown>;",
      "}",
      "",
      "export function tickPhaseLadder(",
      "  write: (recordJson: string) => Promise<unknown>,",
      "): TickPhaseLadder {",
      "  let tail: Promise<unknown> = Promise.resolve();",
      "  const stamp = (fields: TickProgressFields) => {",
      "    const json = tickProgressRecord(fields);",
      "    // `.then(run, run)`: a refused PREDECESSOR must not cancel the stamps",
      "    // behind it — a lost stamp is a reading, a stalled ladder is a lost row.",
      "    const run = () => write(json);",
      "    const chained = tail.then(run, run);",
      "    // The queue absorbs the refusal; the caller still gets the real promise.",
      "    tail = chained.then(",
      "      () => {},",
      "      () => {},",
      "    );",
      "    return chained;",
      "  };",
      "  return { stamp, tail: () => tail };",
      "}",
      "",
      "/**",
      " * Parse one back; null when it is not a record this code wrote. Strict on",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the note drops the batch size a phase stamp never had",
    marker: "A PHASE stamp carries no batch",
    anchor: lines(
      "  const bits = [",
      "    `prog ${rec.stage}`,",
      "    `+${rec.ms}ms`,",
      "    `${rec.payloadBytes}B`,",
      "    `subreqs ${rec.subreqs}`,",
      "    `preRace ${rec.preRaceMs}ms`,",
      "  ];",
    ),
    replacement: lines(
      "  const bits = [`prog ${rec.stage}`, `+${rec.ms}ms`];",
      "  // A PHASE stamp carries no batch (payloadBytes 0): the size only means",
      "  // something once the record describes a flush (see tickPhaseLadder).",
      "  if (rec.payloadBytes > 0) bits.push(`${rec.payloadBytes}B`);",
      "  bits.push(`subreqs ${rec.subreqs}`, `preRace ${rec.preRaceMs}ms`);",
    ),
  },
  {
    file: "src/worker.ts",
    what: "an earlier stamp now means what the ladder made it mean",
    marker: "so it died before its first phase stamp",
    anchor: lines(
      "    return rec.at < deadAt",
      "      ? none(`the row still holds an earlier tick's stamp (at ${rec.at})`)",
      "      : ` [prog other (at ${rec.at} ≠ ${deadAt})]`.slice(0, limit);",
    ),
    replacement: lines(
      "    return rec.at < deadAt",
      "      ? none(",
      "          `the row still holds an earlier tick's stamp (at ${rec.at}): this tick never landed its own, so it died before its first phase stamp`,",
      "        )",
      "      : ` [prog other (at ${rec.at} ≠ ${deadAt})]`.slice(0, limit);",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the ladder is declared OUTSIDE the inner try (the pre-flush record races it from that try's finally)",
    marker: "hoisted out of the inner try",
    anchor: lines(
      "    // fires when ticks genuinely stop.",
      "    try {",
    ),
    replacement: lines(
      "    // fires when ticks genuinely stop.",
      "    // ── the phase ladder, hoisted out of the inner try (see",
      "    // tickPhaseLadder) ───────────────────────────────────────────────",
      "    // The tick's durable whereabouts, queued and never awaited. Declared",
      "    // HERE, outside the inner try, because the pre-flush record that rides",
      "    // this queue is written in that try's `finally` block — which cannot see",
      "    // a binding declared in the try's body (tsc caught exactly that).",
      "    const ladder = tickPhaseLadder((json) => {",
      "      const client = db;",
      "      if (!client) return Promise.resolve();",
      "      try {",
      "        const write = client.setWorkerState(TICK_PROGRESS_KEY, json);",
      "        // Swallowed at the source: an unhandled rejection can take the",
      "        // isolate down with it, and a phase stamp is the least important",
      "        // thing the invocation does.",
      "        write.catch(() => {});",
      "        return write;",
      "      } catch {",
      "        return Promise.resolve();",
      "      }",
      "    });",
      "    try {",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the tick wires the scanner and stamps `scan` before the scan",
    marker: "const notePhase = (phase: string) =>",
    anchor: lines(
      "      });",
      "      await Promise.race([",
      "        scanner.runOnce(),",
    ),
    replacement: lines(
      "      });",
      "      // The phase stamp the worker itself owns (see tickPhaseLadder): the",
      "      // tick is admitted, the scan not yet entered. The three phases INSIDE",
      "      // the scan are stamped through the scanner's hook below — without it",
      "      // the row would stop here, which is where four of four captured deaths",
      "      // stopped.",
      "      const notePhase = (phase: string) =>",
      "        void ladder.stamp({",
      "          at: startedAt,",
      "          stage: phase,",
      "          payloadBytes: 0,",
      "          scanMs: 0,",
      "          preRaceMs: preTick?.preRaceMs ?? 0,",
      "          subreqs: subreqView().current.total,",
      "          cut: false,",
      "          err: null,",
      "        });",
      "      if (scanner) scanner.onTickPhase = notePhase;",
      "      notePhase(\"scan\");",
      "      // Wired only for the duration of the scan: the hook is unwired after",
      "      // the race, so the tail (the tracker pass) cannot stamp a phase the",
      "      // scan never had.",
      "      await Promise.race([",
      "        scanner.runOnce(),",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the hook is unwired once the scan is over",
    marker: "scanner.onTickPhase = null;",
    anchor: lines(
      "            resolve();",
      "          }, scanRaceMs);",
      "        }),",
      "      ]);",
      "      lastScanOk = !timedOut;",
    ),
    replacement: lines(
      "            resolve();",
      "          }, scanRaceMs);",
      "        }),",
      "      ]);",
      "      // The scan is over: unwire the phase hook, so the tick's tail (the",
      "      // tracker pass) cannot stamp a phase the scan never had. The pre-flush",
      "      // record below takes over from here (see TICK_PROGRESS_KEY).",
      "      if (scanner) scanner.onTickPhase = null;",
      "      lastScanOk = !timedOut;",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the pre-flush record rides the same queue",
    marker: "The pre-flush record rides the phase ladder's queue",
    anchor: lines(
      "      const noteProgress = (stage: string, why?: string | null) => {",
      "        if (!db) return null;",
      "        let write: Promise<unknown>;",
      "        try {",
      "          write = db.setWorkerState(",
      "            TICK_PROGRESS_KEY,",
      "            tickProgressRecord({",
      "              at: startedAt,",
      "              stage,",
      "              payloadBytes: flushJson.length,",
      "              scanMs: flushedMs,",
      "              preRaceMs: preTick?.preRaceMs ?? 0,",
      "              subreqs: subreqView().current.total,",
      "              cut: timedOut,",
      "              err: why ?? lastScanError,",
      "            }),",
      "          );",
      "        } catch {",
      "          return null;",
      "        }",
      "        // Swallowed at the source: an unhandled rejection can take the",
      "        // isolate down with it, and this write is the least important thing",
      "        // the invocation does.",
      "        write.catch(() => {});",
      "        return write;",
      "      };",
    ),
    replacement: lines(
      "      // The pre-flush record rides the phase ladder's queue: the row must end",
      "      // with THIS stamp, not with a phase stamp that overtook it (see",
      "      // tickPhaseLadder). Awaited only by the caller below, and only while the",
      "      // tick can still afford it.",
      "      const noteProgress = (stage: string, why?: string | null) =>",
      "        ladder.stamp({",
      "          at: startedAt,",
      "          stage,",
      "          payloadBytes: flushJson.length,",
      "          scanMs: flushedMs,",
      "          preRaceMs: preTick?.preRaceMs ?? 0,",
      "          subreqs: subreqView().current.total,",
      "          cut: timedOut,",
      "          err: why ?? lastScanError,",
      "        });",
    ),
  },
  {
    file: "src/worker.ts",
    // The race's setTimeout ends with `);`, and the entry above shipped the
    // anchor's own `,` into the replacement — tsc caught it as TS1109 at the
    // arrow's closing brace, one line below. Kept as its own entry so the
    // already-patched tree is repaired instead of hand-edited.
    what: "the race's setTimeout call keeps its semicolon",
    marker: "}, scanRaceMs);",
    anchor: lines(
      "          }, scanRaceMs),",
      "        }),",
      "      ]);",
    ),
    replacement: lines(
      "          }, scanRaceMs);",
      "        }),",
      "      ]);",
    ),
  },
  {
    file: "scripts/test-unit.js",
    // The first form of this test asserted the WRONG property: it reused a
    // writer that refuses EVERY call, so the stamp behind the refusal rejected
    // for its own reason and `await after` failed the test — pinning the test's
    // bug rather than the ladder's. What matters is that a refusal does not
    // STALL the queue, so the refusal has to be a one-off.
    what: "the ladder's refusal test pins the queue, not a second refusal",
    marker: "const flaky = tickPhaseLadder(",
    anchor: lines(
      "    const failing = tickPhaseLadder(async () => {",
      '      throw new Error("refused");',
      "    });",
      '    const refused = failing.stamp(fields("pair"));',
      '    const after = failing.stamp(fields("gate"));',
      "    await assert.rejects(refused);",
      "    await after;",
    ),
    replacement: lines(
      "    let attempts = 0;",
      "    const flaky = tickPhaseLadder(async () => {",
      "      attempts += 1;",
      '      if (attempts === 1) throw new Error("refused");',
      "    });",
      '    const refused = flaky.stamp(fields("pair"));',
      '    const after = flaky.stamp(fields("gate"));',
      "    await assert.rejects(refused);",
      "    await after;",
      "    // The queue absorbed the refusal: the stamp BEHIND it was still attempted",
      "    // and landed. A stalled queue would leave the row naming a phase the tick",
      "    // had long left — which is the failure this test exists to catch.",
      "    assert.equal(attempts, 2);",
    ),
  },
  // ── src/scanner.ts ───────────────────────────────────────────────────────
  {
    file: "src/scanner.ts",
    what: "the phase hook the worker wires for the duration of a tick",
    marker: "onTickPhase: ((phase: string) => void) | null = null;",
    anchor: lines("  trackerPassOverrunMs = TRACKER_PASS_OVERRUN_MS;"),
    replacement: lines(
      "  trackerPassOverrunMs = TRACKER_PASS_OVERRUN_MS;",
      "  /**",
      "   * The tick's phase stamp hook (see the worker's tickPhaseLadder /",
      "   * TICK_PROGRESS_KEY). The worker wires it for the duration of a tick and",
      "   * unwires it after the scan: the front phases (feeds, pool read, pair fetch)",
      "   * and the gate all run INSIDE this class, so without the hook the tick's",
      "   * durable whereabouts would stop at \"the scan started\" — which is where",
      "   * four of four captured deaths stopped.",
      "   *",
      "   * null = no stamp wanted (a standalone Scanner, or a tick that already",
      "   * ended). Telemetry only: a stamp may never cost or break the scan.",
      "   */",
      "  onTickPhase: ((phase: string) => void) | null = null;",
      "",
      "  /** One phase stamp, never thrown into the scan (see onTickPhase). */",
      "  private stampPhase(phase: string): void {",
      "    const hook = this.onTickPhase;",
      "    if (!hook) return;",
      "    try {",
      "      hook(phase);",
      "    } catch {",
      "      /* a stamp is telemetry */",
      "    }",
      "  }",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "front: the discovery feeds returned",
    marker: 'this.stampPhase("front");',
    anchor: lines("      diag.feedsMs = Date.now() - feedsStart;"),
    replacement: lines(
      '      // The discovery-feed phase is behind us (see the worker\'s phase ladder).',
      '      this.stampPhase("front");',
      "      diag.feedsMs = Date.now() - feedsStart;",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "pair: the pool read and the pair fetch returned",
    marker: 'this.stampPhase("pair");',
    anchor: lines("      diag.pairs = pairsByToken.size;"),
    replacement: lines(
      '      // The pool read AND the pair fetch are behind us (Jupiter fallback',
      '      // included): the front window is closed.',
      '      this.stampPhase("pair");',
      "      diag.pairs = pairsByToken.size;",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "gate: the candidate chain is entered",
    marker: 'this.stampPhase("gate");',
    anchor: lines(
      "      const newStats: TokenStats[] = [];",
      "      for (const profile of feedProfiles) {",
    ),
    replacement: lines(
      '      // Past the registration read: what follows is the candidate chain — eval,',
      '      // the per-chat gates, the push (see the worker\'s phase ladder).',
      '      this.stampPhase("gate");',
      "      const newStats: TokenStats[] = [];",
      "      for (const profile of feedProfiles) {",
    ),
  },
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the new helper is imported",
    marker: "tickPhaseLadder } = require",
    anchor: lines(
      'const { tradeFingerprint, deadTickBackfillInfo, TICK_PROGRESS_KEY, tickProgressRecord, parseTickProgress, tickProgressNote } = require("../dist/worker.js");',
    ),
    replacement: lines(
      'const { tradeFingerprint, deadTickBackfillInfo, TICK_PROGRESS_KEY, tickProgressRecord, parseTickProgress, tickProgressNote, tickPhaseLadder } = require("../dist/worker.js");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "a phase stamp's note is pinned",
    marker: "a phase stamp names its phase",
    anchor: lines("    assert.match(hit, /preRace 158ms/);"),
    replacement: lines(
      "    assert.match(hit, /preRace 158ms/);",
      "    // A PHASE stamp (the ladder that names scan/front/pair/gate) carries no",
      "    // batch at all, so its note must not read `0B` — the size means something",
      "    // only once the record describes a flush (see tickPhaseLadder).",
      "    const phase = tickProgressNote(",
      '      tickProgressRecord({ at, stage: "pair", payloadBytes: 0, scanMs: 0, preRaceMs: 158, subreqs: 12, cut: false, err: null }),',
      "      at,",
      "    );",
      '    assert.match(phase, /prog pair/, "a phase stamp names its phase");',
      "    assert.match(phase, /subreqs 12/);",
      '    assert.ok(!/0B/.test(phase), "and claims no batch it never had");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the ladder's ordering and its refusal-tolerance are pinned",
    marker: "tickPhaseLadder: phase stamps are strictly ordered",
    anchor: lines(
      '  await test("out-of-window patch: the pre-flush record is written BEFORE the flush and read by the successor (docs/patches/tick-progress-record.apply.js)", () => {',
    ),
    replacement: lines(
      '  await test("tickPhaseLadder: phase stamps are strictly ordered and never awaited by the tick", async () => {',
      "    const seen = [];",
      "    let release = null;",
      "    const held = new Promise((resolve) => {",
      "      release = resolve;",
      "    });",
      "    const ladder = tickPhaseLadder(async (json) => {",
      "      seen.push(JSON.parse(json).stage);",
      "      if (seen.length === 1) await held;",
      "    });",
      "    const fields = (stage) => ({",
      "      at: 7,",
      "      stage,",
      "      payloadBytes: 0,",
      "      scanMs: 0,",
      "      preRaceMs: 0,",
      "      subreqs: 1,",
      "      cut: false,",
      "      err: null,",
      "    });",
      '    const first = ladder.stamp(fields("scan"));',
      '    const second = ladder.stamp(fields("front"));',
      "    // The second write must not even START before the first settles: two",
      "    // writes to ONE row in flight at once could land out of order and let a",
      "    // later phase describe a tick that never got there.",
      "    await new Promise((resolve) => setTimeout(resolve, 5));",
      '    assert.deepEqual(seen, ["scan"], "the second stamp waits for the first");',
      "    release();",
      "    await Promise.all([first, second]);",
      '    assert.deepEqual(seen, ["scan", "front"], "and then lands in order");',
      "    // A refused stamp is a reading, not a stopped ladder: the queue absorbs",
      "    // it, so the phases behind it still land (a stalled queue would leave the",
      "    // row describing a phase the tick had long left).",
      "    let attempts = 0;",
      "    const flaky = tickPhaseLadder(async () => {",
      "      attempts += 1;",
      '      if (attempts === 1) throw new Error("refused");',
      "    });",
      '    const refused = flaky.stamp(fields("pair"));',
      '    const after = flaky.stamp(fields("gate"));',
      "    await assert.rejects(refused);",
      "    await after;",
      "    // The queue absorbed the refusal: the stamp BEHIND it was still attempted",
      "    // and landed. A stalled queue would leave the row naming a phase the tick",
      "    // had long left — which is the failure this test exists to catch.",
      "    assert.equal(attempts, 2);",
      "  });",
      "",
      '  await test("out-of-window patch: the pre-flush record is written BEFORE the flush and read by the successor (docs/patches/tick-progress-record.apply.js)", () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard covers the ladder (all-or-none with the code)",
    // NOT `const scannerSrc = …`: this file already reads scanner.ts in other
    // tests, so that fragment made the marker match an unrelated declaration
    // and the entry skipped itself. The marker has to be something ONLY this
    // entry writes — the helper it introduces.
    marker: "const scanBefore = (a, b) => {",
    anchor: lines(
      '    const workerSrc = read("src/worker.ts");',
      '    const testSrc = read("scripts/test-unit.js");',
    ),
    replacement: lines(
      '    const workerSrc = read("src/worker.ts");',
      '    const scannerSrc = read("src/scanner.ts");',
      '    const testSrc = read("scripts/test-unit.js");',
      "    const scanBefore = (a, b) => {",
      "      const ia = scannerSrc.indexOf(a);",
      "      const ib = scannerSrc.indexOf(b);",
      "      return ia >= 0 && ib >= 0 && ia < ib;",
      "    };",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard's ladder entries",
    marker: "the phase ladder is what writes the row",
    anchor: lines(
      '      "tests (this guard)": testSrc.includes("tickProgressNote(rec,at"),',
      "    };",
    ),
    replacement: lines(
      '      "worker (the phase ladder is what writes the row, so no phase stamp can overtake the record)":',
      '        workerSrc.includes("tickPhaseLadder(") &&',
      '        workerSrc.includes("ladder.stamp({"),',
      '      "worker (the tick queues its first stamp before the scan and unwires the hook after it)":',
      '        workerSrc.includes(\'notePhase("scan")\') &&',
      '        workerSrc.includes("scanner.onTickPhase=notePhase;") &&',
      '        workerSrc.includes("scanner.onTickPhase=null;"),',
      '      "scanner (the hook, and the four phase names in the order the tick crosses them)":',
      '        scannerSrc.includes("onTickPhase:((phase:string)=>void)|null=null;") &&',
      '        scannerSrc.includes(\'this.stampPhase("front");\') &&',
      "        scanBefore('this.stampPhase(\"front\");', 'this.stampPhase(\"pair\");') &&",
      "        scanBefore('this.stampPhase(\"pair\");', 'this.stampPhase(\"gate\");'),",
      '      "tests (this guard)": testSrc.includes("tickProgressNote(rec,at"),',
      "    };",
    ),
  },
];

// Per-file BUFFERS, not a per-entry read: several entries target one file, and
// computing each from the file on disk would make the last write win (which is
// how the first run of this script lost every earlier edit to src/worker.ts).
const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (text.includes(patch.marker)) {
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

// The doc: appended, so it has no anchor to miss.
{
  const file = "docs/scan-completion-loss.md";
  const text = bufferOf(file);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the phase ladder is documented`);
  } else {
    buffers.set(file, `${text.trimEnd()}\n${DOC}`);
    console.log(`ok        ${file}: the phase ladder is documented`);
  }
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
