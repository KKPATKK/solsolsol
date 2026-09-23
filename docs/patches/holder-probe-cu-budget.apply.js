#!/usr/bin/env node
/**
 * Put the holder probe on a Birdeye CU budget.
 *
 * `/defi/token_overview` is billed 20 CU per call and the free tier is
 * 30_000 CU a MONTH — about 50 calls a day for the whole bot — while the stage
 * probed once per pass (1_440 calls/day) and, before 2026-09-23, four times per
 * pass (5_760/day). A probe is billed whether or not its count lands, so the
 * three changes here are one budget story:
 *
 *  1. A minimum GAP between probes, stamped durably in worker_state
 *     (`holder_probe_at`): default 60 minutes = 24 probes/day ≈ 480 CU/day ≈
 *     14.4K CU/month, which leaves room for the card path and the periodic
 *     new_listing backfill inside 30K. The stamp is read at most once per gap
 *     (a satisfied gap is answered from memory) and written once per probe, so
 *     the guard costs at most 2 round trips per hour.
 *  2. The fetch cap comes from config (PUSH_WATCH_HOLDER_CAP_MS, default
 *     2_400ms = the endpoint's live median): a cap under the endpoint's own
 *     latency pays for calls it then discards, so this is the hit-rate dial.
 *  3. The park is 3 minutes instead of 10, DOUBLING per consecutive miss up to
 *     30: with the probe rate CU-bounded, a row that misses must not also sit
 *     out ten of the (now scarce) turns, while a chronically slow row — always
 *     the oldest `holders_checked_at`, so always at the head of the due list —
 *     must not take every probe from the rows behind it.
 *
 * src/config.ts carries the two new knobs. The counter/field/dispatch edits sit
 * below the file tools' ~line-1000 window in src/pushwatch.ts (see
 * docs/round-trips.md §6). Same discipline: every replacement must match
 * EXACTLY once or nothing is written at all.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const B = "`";

const edits = [
  {
    name: "the park constant: 3 minutes, doubling, plus the stamp key",
    old:
      " * pass after pass. Ten minutes sits well under the 30-minute refresh\n" +
      " * interval (PUSH_WATCH_HOLDERS_REFRESH_MIN), so a parked row still gets ~3\n" +
      " * attempts per refresh window, and only MISSES park — a success clears it.\n" +
      " */\n" +
      "const TRACKER_HOLDER_BACKOFF_MS = 10 * 60_000;",
    next:
      " * pass after pass. Only MISSES park — a success clears it.\n" +
      " *\n" +
      " * 2026-09-23: 10 minutes → 3, DOUBLING per consecutive miss up to\n" +
      " * TRACKER_HOLDER_PARK_MAX_MS. Three minutes is what \"faster coverage\" costs\n" +
      " * when the probe rate is CU-bounded (a probe is billed whether or not its\n" +
      " * count lands, and the stage keeps a gap of PUSH_WATCH_HOLDER_MIN_GAP_MIN), so\n" +
      " * a row that misses should not also sit out ten scarce turns. The ladder\n" +
      " * stops the other failure: a chronically slow row is ALWAYS the oldest\n" +
      " * `holders_checked_at`, so with a flat park it takes every probe and the 29\n" +
      " * rows behind it never get a turn — the starvation the flat 10-minute park was\n" +
      " * introduced to break, one CU budget smaller. 3 → 6 → 12 → 24, capped at 30.\n" +
      " */\n" +
      "const TRACKER_HOLDER_BACKOFF_MS = 3 * 60_000;\n" +
      "/** Longest a holder row may be parked by the miss ladder above (ms). */\n" +
      "const TRACKER_HOLDER_PARK_MAX_MS = 30 * 60_000;\n" +
      "/** worker_state key holding the last holder-probe stamp (see the CU gate). */\n" +
      'const HOLDER_PROBE_STAMP_KEY = "holder_probe_at";',
  },
  {
    name: "the miss-streak map and the probe stamp",
    old: "  private readonly holdersFailedAt = new Map<string, number>();",
    next:
      "  private readonly holdersFailedAt = new Map<string, number>();\n" +
      "  /**\n" +
      "   * Consecutive misses per parked row (see TRACKER_HOLDER_BACKOFF_MS): the\n" +
      "   * park LENGTH doubles with each one, so a chronically slow row cannot take\n" +
      "   * every probe a CU-bounded rate allows. Cleared by a count, like the park.\n" +
      "   */\n" +
      "  private readonly holderMissStreak = new Map<string, number>();\n" +
      "  /**\n" +
      "   * Epoch ms of the last holder probe (see the CU gate in the holder\n" +
      "   * dispatch). Also carries the DURABLE stamp (worker_state\n" +
      "   * `holder_probe_at`) once it has been read, so a satisfied gap is answered\n" +
      "   * from memory and the read costs one round trip per gap, not per pass.\n" +
      "   */\n" +
      "  private holderProbeAt: number | null = null;",
  },
  {
    name: "the CU-gate counters beside the holder ones",
    old: "    let holderProbeDue = 0;",
    next:
      "    let holderProbeDue = 0;\n" +
      "    /** This pass's probe was refused by the CU gap (see cfg.holderMinGapMin). */\n" +
      "    let holderGateBlocked = false;\n" +
      "    /** A probe started, so the durable CU stamp still has to land (see below). */\n" +
      "    let holderStampPending = false;",
  },
  {
    name: "the note says WHY a pass probed nothing",
    old:
      "      " + B + " probe${holderProbeStarted} miss${holderProbeMisses}]" + B + ";",
    next:
      "      " + B + " probe${holderProbeStarted} miss${holderProbeMisses}" + B + " +\n" +
      "      " + B + "${holderGateBlocked ? \" cu-gate\" : \"\"}]" + B + ";",
  },
  {
    name: "the park check walks the ladder",
    old:
      "          if (now - failedAt >= TRACKER_HOLDER_BACKOFF_MS) {\n" +
      "            this.holdersFailedAt.delete(r.token);\n" +
      "            return false;\n" +
      "          }",
    next:
      "          if (now - failedAt >= this.holderParkMs(r.token)) {\n" +
      "            this.holdersFailedAt.delete(r.token);\n" +
      "            return false;\n" +
      "          }",
  },
  {
    name: "the fetch cap comes from config",
    old:
      "        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);\n" +
      "        // What ONE probe is allowed to cost: its fetch plus the single gate it\n" +
      "        // may queue behind — the same quantity the stage's collect waits out\n" +
      "        // (see TRACKER_HOLDER_CAP_MS / TRACKER_HOLDER_STAGE_MS).\n" +
      "        const probeCapMs = TRACKER_HOLDER_CAP_MS + intervalMs;",
    next:
      "        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);\n" +
      "        const fetchCapMs = cfg.holderCapMs;\n" +
      "        // What ONE probe is allowed to cost: its fetch plus the single gate it\n" +
      "        // may queue behind — the same quantity the stage's collect waits out\n" +
      "        // (see TRACKER_HOLDER_CAP_MS / TRACKER_HOLDER_STAGE_MS).\n" +
      "        const probeCapMs = fetchCapMs + intervalMs;",
  },
  {
    name: "the CU gap before the slot count",
    old: "        const holderSlots = Math.min(cfg.maxHolderChecksPerTick, 1);",
    next:
      "        //\n" +
      "        // CU GATE (see docs/round-trips.md §4.5): a probe is BILLED whether or\n" +
      "        // not its count lands (`/defi/token_overview` = 20 CU, and the free tier\n" +
      "        // is 30K CU a MONTH ≈ 50 calls a DAY for the whole bot), so the stage\n" +
      "        // also keeps a minimum GAP between probes. The stamp rides worker_state\n" +
      "        // so the cap holds across isolates; a satisfied gap is answered from\n" +
      "        // memory, so this read costs one round trip per gap rather than one per\n" +
      "        // pass, and the write (below, after the row loop) one per probe.\n" +
      "        const gapMs = Math.max(0, cfg.holderMinGapMin) * 60_000;\n" +
      "        let cuGateOpen = true;\n" +
      "        if (gapMs > 0) {\n" +
      "          let lastAt = this.holderProbeAt ?? 0;\n" +
      "          if (now - lastAt >= gapMs) {\n" +
      "            try {\n" +
      "              const raw = await this.db.getWorkerState(HOLDER_PROBE_STAMP_KEY);\n" +
      "              trips += 1;\n" +
      "              lastAt = Math.max(lastAt, raw ? Number(raw) || 0 : 0);\n" +
      "              this.holderProbeAt = lastAt;\n" +
      "            } catch {\n" +
      "              /* unreadable → the in-memory stamp still caps THIS isolate */\n" +
      "            }\n" +
      "          }\n" +
      "          cuGateOpen = now - lastAt >= gapMs;\n" +
      "        }\n" +
      "        if (!cuGateOpen) holderGateBlocked = true;\n" +
      "        const holderSlots = cuGateOpen\n" +
      "          ? Math.min(cfg.maxHolderChecksPerTick, 1)\n" +
      "          : 0;",
  },
  {
    name: "the start guard uses the config cap and stamps the probe",
    old:
      "          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;\n" +
      "          holderProbeStarted += 1;\n" +
      "          holderProbeUnsettled.add(r.token);",
    next:
      "          if (Date.now() + fetchCapMs > deadline) break;\n" +
      "          holderProbeStarted += 1;\n" +
      "          holderStampPending = true;\n" +
      "          this.holderProbeAt = now;\n" +
      "          holderProbeUnsettled.add(r.token);",
  },
  {
    name: "a landed count clears the park and its ladder",
    old:
      "                  this.holdersFailedAt.delete(r.token);\n" +
      "                  return;",
    next:
      "                  this.clearHolderPark(r.token);\n" +
      "                  return;",
  },
  {
    name: "a probe with no count parks through the ladder",
    old:
      "                holderProbeMisses += 1;\n" +
      "                this.holdersFailedAt.set(r.token, Date.now());\n" +
      "              })\n" +
      "              .catch((err) => {",
    next:
      "                holderProbeMisses += 1;\n" +
      "                this.parkHolderRow(r.token, Date.now());\n" +
      "              })\n" +
      "              .catch((err) => {",
  },
  {
    name: "a thrown probe parks through the ladder too",
    old:
      "                this.holdersFailedAt.set(r.token, Date.now());\n" +
      "              }),",
    next:
      "                this.parkHolderRow(r.token, Date.now());\n" +
      "              }),",
  },
  {
    name: "the collect: stamps the CU budget, then parks/clears through the ladder",
    old:
      "    for (const token of holderProbeUnsettled) {\n" +
      "      this.holdersFailedAt.set(token, Date.now());\n" +
      "    }\n" +
      "    holdersHeld = holderProbeHeld;\n" +
      "    holdersCut = holderProbeDue - holderProbeWrites.length - holderProbeMisses;\n" +
      "    if (holderProbeWrites.length > 0) {\n" +
      "      // The whole stage in ONE round trip (N before this).\n" +
      "      trips += 1;\n" +
      "      try {\n" +
      "        await this.db.setPushWatchHoldersMany(holderProbeWrites);\n" +
      "        for (const w of holderProbeWrites) this.holdersFailedAt.delete(w.token);\n" +
      "      } catch (err) {\n" +
      "        console.error(\n" +
      '          "[push-watch] holder batch write failed:",\n' +
      "          err instanceof Error ? err.message : err,\n" +
      "        );\n" +
      "        // A rejected batch wrote NOTHING: park every row it covered, the\n" +
      "        // same state a row whose own write failed used to reach.\n" +
      "        for (const w of holderProbeWrites) {\n" +
      "          this.holdersFailedAt.set(w.token, Date.now());\n" +
      "        }\n" +
      "      }\n" +
      "    }",
    next:
      "    for (const token of holderProbeUnsettled) {\n" +
      "      this.parkHolderRow(token, Date.now());\n" +
      "    }\n" +
      "    // The CU stamp lands HERE, after the row loop, so a probe never delays the\n" +
      "    // rotation with its bookkeeping — and it lands for a MISS too (a miss is a\n" +
      "    // billed Birdeye call, and nothing else records it for the next isolate).\n" +
      "    // One round trip per pass that probed, bounded by the budget it\n" +
      "    // implements; a failure costs this isolate's memory of the stamp, not the\n" +
      "    // probe's count.\n" +
      "    if (holderStampPending) {\n" +
      "      try {\n" +
      "        trips += 1;\n" +
      "        await this.db.setWorkerState(HOLDER_PROBE_STAMP_KEY, String(now));\n" +
      "      } catch {\n" +
      "        /* telemetry-grade: the in-memory stamp still covers this isolate */\n" +
      "      }\n" +
      "    }\n" +
      "    holdersHeld = holderProbeHeld;\n" +
      "    holdersCut = holderProbeDue - holderProbeWrites.length - holderProbeMisses;\n" +
      "    if (holderProbeWrites.length > 0) {\n" +
      "      // The whole stage in ONE round trip (N before this).\n" +
      "      trips += 1;\n" +
      "      try {\n" +
      "        await this.db.setPushWatchHoldersMany(holderProbeWrites);\n" +
      "        for (const w of holderProbeWrites) this.clearHolderPark(w.token);\n" +
      "      } catch (err) {\n" +
      "        console.error(\n" +
      '          "[push-watch] holder batch write failed:",\n' +
      "          err instanceof Error ? err.message : err,\n" +
      "        );\n" +
      "        // A rejected batch wrote NOTHING: park every row it covered, the\n" +
      "        // same state a row whose own write failed used to reach.\n" +
      "        for (const w of holderProbeWrites) {\n" +
      "          this.parkHolderRow(w.token, Date.now());\n" +
      "        }\n" +
      "      }\n" +
      "    }",
  },
  {
    name: "the park/ladder helpers",
    old: "  async runTick(",
    next:
      "  /**\n" +
      "   * Park a row whose holder probe missed, DOUBLING the wait per consecutive\n" +
      "   * miss (see TRACKER_HOLDER_BACKOFF_MS): the first miss costs 3 minutes, so a\n" +
      "   * row comes back quickly under a CU-bounded probe rate, while a row that\n" +
      "   * keeps missing — always the oldest `holders_checked_at`, so always at the\n" +
      "   * head of the due list — stops taking every scarce probe from the rows\n" +
      "   * behind it.\n" +
      "   */\n" +
      "  private parkHolderRow(token: string, at: number): void {\n" +
      "    this.holdersFailedAt.set(token, at);\n" +
      "    const streak = Math.min((this.holderMissStreak.get(token) ?? 0) + 1, 8);\n" +
      "    this.holderMissStreak.set(token, streak);\n" +
      "  }\n" +
      "\n" +
      "  /** A landed count clears both the park and its ladder. */\n" +
      "  private clearHolderPark(token: string): void {\n" +
      "    this.holdersFailedAt.delete(token);\n" +
      "    this.holderMissStreak.delete(token);\n" +
      "  }\n" +
      "\n" +
      "  /** How long this row's next park lasts (see TRACKER_HOLDER_BACKOFF_MS). */\n" +
      "  private holderParkMs(token: string): number {\n" +
      "    const streak = this.holderMissStreak.get(token) ?? 1;\n" +
      "    return Math.min(\n" +
      "      TRACKER_HOLDER_BACKOFF_MS * 2 ** Math.min(streak - 1, 3),\n" +
      "      TRACKER_HOLDER_PARK_MAX_MS,\n" +
      "    );\n" +
      "  }\n" +
      "\n" +
      "  async runTick(",
  },
];

let text = fs.readFileSync(PW, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      pw: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS pw: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        pw: " + e.name);
}
fs.writeFileSync(PW, text);
