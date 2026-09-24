#!/usr/bin/env node
/**
 * Two repairs that share one cause: a number that only existed inside a warm
 * isolate, and a row that was written before its guard existed (2026-09-24).
 *
 * REPAIR 1 — the drain's failure reason never reached /health.
 * src/tickprobe.ts already records the reason on `WriteDrainView.lastError`, and
 * /health reports that view inside the stored heartbeat's `summary`. But the
 * view is MODULE state, and the isolate that accumulates a backlog is not the
 * one answering the request: the live read behind the field showed
 * `writeDrain {pending 47, totals {calls 57, ms 17759, failures 38}}` while the
 * poll landed on a pristine isolate reporting `writeDrain {at 0}`. So the record
 * now also goes to a durable worker_state row (WRITE_DRAIN_ERROR_KEY, written by
 * persistDrainError in src/tickprobe.ts) and /health reads THAT — one extra key
 * on a read the handler already batches, i.e. no extra round trip. The reader
 * also learns which METHOD threw (`recordTokenStatsMany` vs
 * `updateTokenMaxMcaps`): both write the same table through the same client, and
 * the two have different fixes.
 *
 * REPAIR 2 — a stored baseline that is not a reading.
 * The heal's guard (docs/patches/pushwatch-zero-mcap-baseline.apply.js) stops
 * NEW `mcap_at_push 0` rows but cannot rewrite what shipped before it (live:
 * 💲 and 玉兔). TWO things make the repair's TRIGGER the hard part, and both are
 * measured, not assumed:
 *   - the rotation cannot reach them — `activeRows` drops terminal ('rug')
 *     rows, which is exactly the state a drained coin reaches (the live row
 *     carried a 💧 card in its audit);
 *   - neither can the pass's own listing, which is the obvious cheap trigger
 *     because it is already in hand: `listPushWatch` is capped at
 *     PUSH_WATCH_MAX_TRACKED and sorts active rows FIRST, so with 30 active
 *     rows the listing is exactly the live shape `rows 30/30` — every slot
 *     active, the row to repair absent, and a filter over it matches nothing
 *     forever.
 * So the repair is ONE guarded UPDATE against the whole table, run ONCE per
 * isolate (see `baselineRepairDone`). Once per isolate is enough by
 * construction: only pre-guard code could create such a row, so there is no
 * stream of new ones to chase and every isolate converges on its first pass.
 * Afterwards the statement matches nothing, so what remains is its one round
 * trip on that isolate's first pass — stated plainly rather than implied.
 *
 * An apply script because src/db.ts, src/worker.ts and src/pushwatch.ts all sit
 * past the file-tool window; every anchor must match exactly once or nothing is
 * written, and an edit whose dependency is missing is skipped rather than
 * half-applied.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ---------------------------------------------------------------- db.ts --
  {
    file: "src/db.ts",
    what: "Db.repairPushWatchBaselines",
    marker: "repairPushWatchBaselines",
    anchor: lines(
      "  async claimPushWatchCheck(",
      "    token: string,",
      "    expectedLastChecked: number,",
      "    now: number,",
      "    v: PushWatchCheckValues,",
      "  ): Promise<boolean> {",
    ),
    replacement: lines(
      "  /**",
      "   * Repair rows whose stored push baseline is not a READING.",
      "   *",
      "   * `mcap_at_push` is the denominator of every derived number on a row: the",
      "   * recap's 推送 line, `chgSincePush` (against `max(baseline, 1)`, src/",
      "   * pushwatch.ts), and the dead-state resurrection floor (`(dead_trough_mcap",
      "   * ?? mcap_at_push) * RESURRECTION_MULT`). A row carrying 0 there therefore",
      "   * reports a seven-figure percentage move and re-arms a resurrection on ANY",
      "   * later reading. Live 2026-09-24 (/debug/push-watch): two rows (💲, 玉兔)",
      "   * were in that state — enrolled by the tracker's self-heal from a pair whose",
      "   * source had no price. The heal's own guard refuses to seed another one (see",
      "   * docs/patches/pushwatch-zero-mcap-baseline.apply.js), but a guard cannot",
      "   * rewrite what is already stored, which is this method's whole job.",
      "   *",
      "   * The substitute is the row's OWN `peak_mcap`: the highest real reading the",
      "   * tracker took for that coin, i.e. the only valuation evidence left once the",
      "   * push-time one never existed. The push ledger cannot help by construction —",
      "   * these rows have no `initial` entry to copy from (that is what",
      "   * /debug/push-audit shows for both), which is exactly why the heal had to",
      "   * fall back to a live price in the first place.",
      "   *",
      "   * Deliberately NOT the live market cap, which is the obvious-looking choice:",
      "   * for a row with no recorded trough the floor above is built from this",
      "   * column, so repairing a corpse's baseline to its current price re-arms the",
      "   * very false resurrection this repair exists to stop (1.5 × a dead coin's",
      "   * price is a number it can reach again by accident). A peak-based floor asks",
      "   * the coin to regain 1.5 × what it once reached, which is what \"revived\"",
      "   * should mean.",
      "   *",
      "   * Both WHERE terms are guards, not filters: `mcap_at_push <= 0` re-asserts",
      "   * the defect ON the write, so a concurrent isolate that already repaired the",
      "   * row — or a genuinely fresh baseline — can never be overwritten, and",
      "   * `peak_mcap > 0` is the honesty guard: a row with no positive reading",
      "   * anywhere is left alone rather than handed an invented number.",
      "   *",
      "   * Deliberately UNPARAMETERISED — the whole table rather than a token list",
      "   * from the caller. A list would be easier to justify but cannot work: the",
      "   * two row sources a pass holds are the rotation (which drops terminal rows,",
      "   * and a drained coin IS terminal) and the listing (capped at",
      "   * PUSH_WATCH_MAX_TRACKED with active rows first, so at 30 active rows it is",
      "   * exactly the live `rows 30/30` shape — full, and holding only active rows).",
      "   * The caller therefore runs this once per isolate; see the baseline-repair",
      "   * stage in PushWatcher.runTick.",
      "   *",
      "   * Returns how many rows changed, so the caller can report it: 0 on every",
      "   * attempt after the backlog is fixed, which is what keeps the caller's cost",
      "   * bounded rather than recurring.",
      "   */",
      "  async repairPushWatchBaselines(): Promise<number> {",
      "    const res = await this.get().execute({",
      "      sql: `UPDATE push_watch",
      "              SET mcap_at_push = peak_mcap",
      "            WHERE mcap_at_push <= 0",
      "              AND peak_mcap > 0`,",
      "      args: [],",
      "    });",
      "    return Number(res.rowsAffected ?? 0);",
      "  }",
      "",
      "  async claimPushWatchCheck(",
      "    token: string,",
      "    expectedLastChecked: number,",
      "    now: number,",
      "    v: PushWatchCheckValues,",
      "  ): Promise<boolean> {",
    ),
  },

  // ------------------------------------------------------------- worker.ts --
  {
    file: "src/worker.ts",
    what: "import WriteDrainErrorRecord",
    marker: "WriteDrainErrorRecord,",
    anchor: lines(
      "import {",
      "  installTickProbe,",
      "  dbStepView,",
      "  writeDrainView,",
      "  drainDeferredWrites,",
      "  noteDuplicateCards,",
      '} from "./tickprobe";',
    ),
    replacement: lines(
      "import {",
      "  installTickProbe,",
      "  dbStepView,",
      "  writeDrainView,",
      "  drainDeferredWrites,",
      "  noteDuplicateCards,",
      "  type WriteDrainErrorRecord,",
      '} from "./tickprobe";',
    ),
  },
  {
    file: "src/worker.ts",
    what: "/health: declare writeDrainError",
    marker: "let writeDrainError",
    anchor: lines(
      "      let tokenStatsCount: number | null = null;",
      "      let pushedTotal: number | null = null;",
    ),
    replacement: lines(
      "      let tokenStatsCount: number | null = null;",
      "      let pushedTotal: number | null = null;",
      "      // The drain's own record of its last failure, read from its durable row",
      "      // (see WRITE_DRAIN_ERROR_KEY in src/tickprobe.ts) rather than from this",
      "      // isolate's mirror: the isolate that accumulates a backlog is not the one",
      "      // answering this request — live 2026-09-24, a poll landing on a pristine",
      "      // isolate reported `writeDrain {at 0}` while 47 writes waited elsewhere,",
      "      // so the reason has to be readable from ANY isolate.",
      "      let writeDrainError: WriteDrainErrorRecord | null = null;",
    ),
  },
  {
    file: "src/worker.ts",
    what: "/health: read + parse the drain's record",
    marker: '"write_drain_error",',
    anchor: lines(
      "        const tickState = await db?.getWorkerStates([",
      '          "scheduled_tick_total",',
      '          "scheduled_tick_at",',
      '          "scheduled_arrival_total",',
      '          "scheduled_arrival_at",',
      "        ]);",
      '        const rawTotal = tickState?.get("scheduled_tick_total") ?? null;',
      '        const rawAt = tickState?.get("scheduled_tick_at") ?? null;',
      '        const rawArrivalTotal = tickState?.get("scheduled_arrival_total") ?? null;',
      '        const rawArrivalAt = tickState?.get("scheduled_arrival_at") ?? null;',
      "        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
      "        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
      "        scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;",
      "        scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;",
    ),
    replacement: lines(
      "        const tickState = await db?.getWorkerStates([",
      '          "scheduled_tick_total",',
      '          "scheduled_tick_at",',
      '          "scheduled_arrival_total",',
      '          "scheduled_arrival_at",',
      "          // The failed drain's record rides THIS read (the handler already",
      "          // batches these keys into one request, so it costs no extra round",
      "          // trip) — see WRITE_DRAIN_ERROR_KEY in src/tickprobe.ts.",
      '          "write_drain_error",',
      "        ]);",
      '        const rawTotal = tickState?.get("scheduled_tick_total") ?? null;',
      '        const rawAt = tickState?.get("scheduled_tick_at") ?? null;',
      '        const rawArrivalTotal = tickState?.get("scheduled_arrival_total") ?? null;',
      '        const rawArrivalAt = tickState?.get("scheduled_arrival_at") ?? null;',
      "        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;",
      "        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;",
      "        scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;",
      "        scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;",
      "        // A malformed or absent row reads as \"no record\" rather than failing",
      "        // the page: this is forensics, and an unreadable row must never cost",
      "        // the health read an operator is using to diagnose exactly that kind of",
      "        // breakage.",
      '        const rawDrainError = tickState?.get("write_drain_error") ?? null;',
      "        if (rawDrainError !== null) {",
      "          try {",
      "            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;",
      "          } catch {",
      "            writeDrainError = null;",
      "          }",
      "        }",
    ),
  },
  {
    file: "src/worker.ts",
    what: "/health: expose writeDrainError",
    marker: "writeDrainError,",
    anchor: lines(
      "        tokenStatsCount,",
      "        pushedTotal,",
      "        birdeyeCu,",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
    replacement: lines(
      "        tokenStatsCount,",
      "        pushedTotal,",
      "        birdeyeCu,",
      "        // WHY the last deferred write failed (method + error + when + how many",
      "        // were waiting). This is the answer the field's absence asked for: live",
      "        // 2026-09-24, `writeDrain {pending 47, totals {calls 57, ms 17759,",
      "        // failures 38}}` with no cause on any public surface. The in-memory",
      "        // mirror (`heartbeat.summary.writeDrain.lastError`) still reports the",
      "        // same thing, but only from an isolate that has drained since.",
      "        writeDrainError,",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
  },

  // ---------------------------------------------------------- pushwatch.ts --
  {
    file: "src/pushwatch.ts",
    what: "module state: the one-shot repair flag",
    marker: "let baselineRepairDone = false;",
    anchor: lines("let healLastAt: number | null = null;"),
    replacement: lines(
      "let healLastAt: number | null = null;",
      "/**",
      " * The baseline repair (see the stage in runTick) is attempted ONCE per",
      " * ISOLATE, which is why the flag lives here next to the other module-scope",
      " * healer state and not inside the pass.",
      " *",
      " * Once is enough by construction: only code from before the heal's own",
      " * baseline guard could have written a row for it to find (see",
      " * docs/patches/pushwatch-zero-mcap-baseline.apply.js), so there is no stream",
      " * of new ones to chase. And once is all the pass can afford — the pass's",
      " * allowance is 1.2-1.6s against ~110-200ms round trips, and this statement",
      " * can only find rows on the very first pass after a deploy that carries it.",
      " * The trade is stated rather than hidden: an isolate whose pool is already",
      " * clean still pays this ONE round trip, on its first pass, and never again.",
      " */",
      "let baselineRepairDone = false;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "pass budget: the repair stage",
    marker: "repair: { ms: 0, trips: 0 }",
    anchor: lines(
      "      holders: { ms: 0, trips: 0 }, // Birdeye holder probes (additive; see TRACKER_HOLDER_CAP_MS)",
      "    };",
    ),
    replacement: lines(
      "      holders: { ms: 0, trips: 0 }, // Birdeye holder probes (additive; see TRACKER_HOLDER_CAP_MS)",
      "      // Baseline repair (see Db.repairPushWatchBaselines): ONE guarded UPDATE",
      "      // against the whole push_watch table, attempted once per isolate — so it",
      "      // reads as a trip on the first pass after a deploy and 0/0 forever after.",
      "      repair: { ms: 0, trips: 0 },",
      "    };",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "pass counter: repairedBaselines",
    marker: "let repairedBaselines = 0;",
    anchor: lines(
      "    let healMissing = 0;",
      "    let healEnrolled = 0;",
      "    let healCut = false;",
      "    let healSkipped = false;",
    ),
    replacement: lines(
      "    let healMissing = 0;",
      "    let healEnrolled = 0;",
      "    let healCut = false;",
      "    let healSkipped = false;",
      "    /**",
      "     * Rows this pass REPAIRED (see the baseline-repair stage). Declared next to",
      "     * the heal counters and BEFORE stageNote(), which reads it: the early",
      "     * returns below call stageNote() too, and a `let` declared further down",
      "     * would put them in its temporal dead zone (the same trap the holder-probe",
      "     * counters document).",
      "     */",
      "    let repairedBaselines = 0;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stageNote: report the repair",
    marker: "repair ${spent.repair.ms}",
    needs: ["repair: { ms: 0, trips: 0 }", "let repairedBaselines = 0;"],
    anchor: lines(
      "      ` holders ${spent.holders.ms}/${spent.holders.trips}` +",
      "      ` held${holdersHeld} cut${holdersCut}` +",
      "      ` probe${holderProbeStarted} miss${holderProbeMisses}` +",
      '      `${holderGateBlocked ? " cu-gate" : ""}]`;',
    ),
    replacement: lines(
      "      ` holders ${spent.holders.ms}/${spent.holders.trips}` +",
      "      ` held${holdersHeld} cut${holdersCut}` +",
      "      ` probe${holderProbeStarted} miss${holderProbeMisses}` +",
      "      // Only when there WAS one: the repair is a one-off backlog fix, and a",
      "      // permanent `repair 0/0 fixed0` would be one more number to read on",
      "      // every line of every note forever.",
      "      `${",
      "        repairedBaselines > 0",
      '          ? ` repair ${spent.repair.ms}/${spent.repair.trips} fixed${repairedBaselines}`',
      '          : ""',
      "      }` +",
      '      `${holderGateBlocked ? " cu-gate" : ""}]`;',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "run the one-shot repair",
    marker: "repairPushWatchBaselines(",
    needs: [
      "repair: { ms: 0, trips: 0 }",
      "let repairedBaselines = 0;",
      "let baselineRepairDone = false;",
    ],
    anchor: lines(
      "    const rows: PushWatchRow[] =",
      "      snapshot !== null",
      "        ? snapshot.filter((r) => r.pushedAt >= windowCutoff)",
      "        : ((trips += 1), await this.db.listPushWatch(cfg.maxTracked));",
    ),
    replacement: lines(
      "    const rows: PushWatchRow[] =",
      "      snapshot !== null",
      "        ? snapshot.filter((r) => r.pushedAt >= windowCutoff)",
      "        : ((trips += 1), await this.db.listPushWatch(cfg.maxTracked));",
      "    // A stored baseline that is not a READING is not a missing value but a",
      "    // POISONED one (live 2026-09-24: two rows carried mcap_at_push 0 — see",
      "    // docs/patches/pushwatch-zero-mcap-baseline.apply.js for what it poisons).",
      "    // The heal's guard stops new ones and this fixes the old ones, once per",
      "    // isolate, with ONE statement against the whole table.",
      "    //",
      "    // NOT driven by `rows` above, which is the tempting source (it is already",
      "    // in hand): it is capped at cfg.maxTracked with active rows first, so the",
      "    // live listing reads `rows 30/30` — every slot active and the row that",
      "    // needs the repair absent, because the shape a 0 baseline produces ends up",
      "    // terminal (a drained 💧 row), and terminal rows sort last. The rotation",
      "    // below cannot reach it either, for the same reason: it evaluates",
      "    // activeRows only.",
      "    if (!baselineRepairDone) {",
      "      baselineRepairDone = true;",
      "      trips += 1;",
      "      spent.repair.trips += 1;",
      "      const repairStarted = Date.now();",
      "      try {",
      "        repairedBaselines = await this.db.repairPushWatchBaselines();",
      "      } catch {",
      "        // Best-effort, like the rest of the pass's bookkeeping: the rows keep",
      "        // their 0 baseline and the NEXT isolate's first pass tries again. The",
      "        // flag stays set on purpose — a database that is down must not turn",
      "        // this into a per-pass cost.",
      "      }",
      "      spent.repair.ms += Date.now() - repairStarted;",
      "    }",
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  // A half-applied file is the dangerous state: an edit whose dependency is
  // missing would compile to something this script does not describe.
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
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
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
