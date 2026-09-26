#!/usr/bin/env node
/**
 * Round 2 of the Turso round-trip merges (2026-09-26).
 *
 * Kept as a script for the same reason every other deep edit in this repo is
 * (see docs/round-trips.md §6): src/worker.ts (290KB), src/db.ts (178KB),
 * src/pushwatch.ts (210KB) and src/scanner.ts (236KB) are all far past the file
 * tool's ~50KB edit window, so `str_replace` answers "old string not found" no
 * matter how exact the anchor is. fs.readFileSync/writeFileSync round-trip the
 * bytes exactly.
 *
 * WHAT LANDS HERE (2 merges, 1 stamp move)
 *
 *   1. worker.ts — the cold-init block read FOUR `worker_state` rows one at a
 *      time (`axiom_access_token`, `push_deferral`, `push_ledger`,
 *      `skip_capture`). `Db.getWorkerStates` exists for exactly that shape
 *      ("Many keys, ONE round trip") and the tick's front read already uses it;
 *      the four now ride it. 4 round trips -> 1, on every isolate that starts
 *      cold (live 2026-09-25: a census window read `getWorkerState 5 calls /
 *      2559ms`, the single largest method in a ~20-round-trip tick).
 *
 *   2. db.ts + pushwatch.ts + scanner.ts — the tracker pass's ENTRY was three
 *      one-shot statements none of which depends on the others: the RUNNING
 *      stamp on `push_watch_pass`, the `push_watch` listing the pass and its
 *      recap/prune both read, and the single `worker_state` row the settle
 *      stage decides on. `Db.beginTrackerPass` now issues all three as ONE
 *      libsql batch (one HTTP request, executed in order), so the pass pays 3
 *      round trips -> 1. The pre-merge shapes stay reachable as the FALLBACK:
 *      a refused batch loses all three readings (a batch is a transaction), so
 *      the caller re-reads the listing, re-writes the stamp, and the settle
 *      stage reads its row itself — exactly today's cost, paid only when the
 *      batch does not land. A Db without the method (test doubles, the local
 *      runner) keeps the old three-step behaviour.
 *
 *      The RUNNING stamp moves from Scanner.persistPassStart (called before the
 *      pass's entry gate) into that batch. The guarantee it exists for — a pass
 *      that STARTS moves the durable row, so a stuck pass is visible — is kept
 *      (the batch is the pass's first request), with one honest loss documented
 *      in the code: a pass deferred at its ENTRY gate, or one whose entry batch
 *      is refused, publishes its note instead of a `running` stamp. Both paths
 *      write a durable note (see persistPassNote), so the row still moves.
 *
 *   3. test-unit.js — the census test now pins the labelled shape
 *      (`getWorkerState:<key>`, see src/tickprobe.ts), the RUNNING-stamp test
 *      pins who owns the stamp now, and two new cases pin the two merges (the
 *      entry is ONE request, driven against a counting client; the cold-init
 *      read is ONE getWorkerStates, asserted on the source the way every
 *      out-of-window patch in this repo is).
 *
 * Verify-then-write: every anchor is checked (present, unique, span sane)
 * BEFORE a single byte is written, so a half-applied paste cannot happen.
 *
 * Run: node docs/patches/round2-tick-merges-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");

/** How many times `needle` occurs in `src`. */
const hits = (src, needle) => src.split(needle).length - 1;

/**
 * Replace everything from `from` up to (but NOT including) `to` with `newText`.
 * `to` is a KEEP marker, so the tail it names survives verbatim.
 */
function splice(src, from, to, newText, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`${label}: start marker not found`);
  if (hits(src, from) !== 1) throw new Error(`${label}: start marker not unique`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`${label}: end marker not found after the start`);
  if (b - a > 8_000) throw new Error(`${label}: span looks wrong (${b - a} bytes)`);
  return src.slice(0, a) + newText + src.slice(b);
}

/**
 * The `push_watch` listing's field list, as it stood inline in listPushWatch's
 * signature before this script moved it to a named type.
 */
const ROW_TYPE_FALLBACK = lines(
  `\n    token: string;`,
  `    chatId: string;`,
  `    symbol: string | null;`,
  `    pushedAt: number;`,
  `    mcapAtPush: number;`,
  `    peakMcap: number;`,
  `    lastLiquidity: number | null;`,
  `    lastVol5m: number | null;`,
  `    deadTroughMcap: number | null;`,
  `    holdersAtPush: number | null;`,
  `    holdersLast: number | null;`,
  `    holdersCheckedAt: number | null;`,
  `    /** Consecutive 🧨 sell-dominant checks (streak; resets on recovery). */`,
  `    sellDomStreak: number;`,
  `    /** Latest tracker-observed mcap (🏁 recap final value). */`,
  `    lastMcap: number | null;`,
  `    lastChecked: number;`,
  `    lastAlertAt: number;`,
  `    followupsSent: number;`,
  `    lastState: string | null;`,
  `    upStages: string | null;`,
);

/** EDITS: [file, label, (src) => newSrc, alreadyApplied(src)] */
const EDITS = [

  // ------------------------------------------------------------- src/worker.ts
  [
    "src/worker.ts",
    "cold init: four worker_state reads -> ONE getWorkerStates",
    (src) => splice(
      src,
      `          // A Google/SSO Axiom account has no password — its tokens are`,
      `        } catch (err) {\n          initError = err instanceof Error ? err.message : String(err);`,
      lines(
        `          // ONE read for the four rows this boot needs (2026-09-26).`,
        `          //`,
        `          // WHY: an isolate recycles and the next one pays this block again —`,
        `          // four worker_state reads, each a full Turso round trip and, on the`,
        `          // invocation's books, one of its 50 subrequests. getWorkerStates`,
        `          // exists for exactly this shape ("Many keys, ONE round trip", see`,
        `          // db.ts) and the tick's front read already uses it. Live`,
        `          // 2026-09-25: a census window read "getWorkerState 5 calls /`,
        `          // 2559ms" — the largest single method in a ~20-round-trip tick —`,
        `          // and this block is four of those keys on every cold isolate.`,
        `          //`,
        `          // ONE try around the four (they used to have one each): the three`,
        `          // mirrors are best-effort telemetry that a refused read leaves at`,
        `          // its previous value either way, and the axiom flag below is a`,
        `          // nicety the credential check re-derives. A failed read is "no`,
        `          // reading", never "no row": the map simply lacks the key, which is`,
        `          // the same null the four single reads produced.`,
        `          let bootStates: Map<string, string> | null = null;`,
        `          try {`,
        `            bootStates = (await db?.getWorkerStates([`,
        `              "axiom_access_token",`,
        `              PUSH_DEFERRAL_STATE_KEY,`,
        `              PUSH_LEDGER_STATE_KEY,`,
        `              SKIP_CAPTURE_STATE_KEY,`,
        `            ])) ?? null;`,
        `          } catch {`,
        `            // telemetry only — never fail init over a counter read`,
        `          }`,
        `          // A Google/SSO Axiom account has no password — its tokens are`,
        `          // persisted by /debug/axiom-tokens, so the feed is "configured"`,
        `          // whenever a stored access token exists too.`,
        `          const storedAxiomToken = bootStates?.get("axiom_access_token") ?? null;`,
        `          if (storedAxiomToken && config.axiomEnabled) axiomConfigured = true;`,
        `          if (bootStates) {`,
        `            // Mirror the durable deferral counters (src/deferrallog.ts) so this`,
        `            // isolate's heartbeats carry the fleet-wide numbers even before it`,
        `            // has any of its own. A row that does not exist yet loads as an`,
        `            // all-zero snapshot (never null): /health then reads "nothing has`,
        `            // been deferred yet" instead of something indistinguishable from a`,
        `            // missing counter channel, which is what makes the first rise`,
        `            // visible as 0 → 1 rather than null → object.`,
        `            try {`,
        `              pushDeferralSnapshot = loadPushDeferralSnapshot(`,
        `                bootStates.get(PUSH_DEFERRAL_STATE_KEY) ?? null,`,
        `              );`,
        `            } catch {`,
        `              // telemetry only — never fail init over a counter read`,
        `            }`,
        `            // Same for the push-baseline ledger (src/pushledger.ts): a freshly`,
        `            // recycled isolate answers /health with the durable view instead of`,
        `            // null until its first reconciliation comes due.`,
        `            try {`,
        `              pushLedgerMirror = {`,
        `                ...pushLedgerStats(`,
        `                  parsePushLedger(bootStates.get(PUSH_LEDGER_STATE_KEY) ?? null),`,
        `                  Date.now(),`,
        `                ),`,
        `                heal: pushWatchHealStats(),`,
        `              };`,
        `            } catch {`,
        `              // telemetry only — never fail init over a ledger read`,
        `            }`,
        `            // Same for the early-return counters (src/skipcapture.ts): a`,
        `            // recycled isolate answers /health with the fleet totals instead of`,
        `            // zeros until its own first sync comes due.`,
        `            try {`,
        `              skipCaptureMirror = parseSkipCaptureState(`,
        `                bootStates.get(SKIP_CAPTURE_STATE_KEY) ?? null,`,
        `              );`,
        `            } catch {`,
        `              // telemetry only — never fail init over a counter read`,
        `            }`,
        `          }`,
      ),
      "cold init",
    ),
    (src) =>
      src.includes(`bootStates = (await db?.getWorkerStates([`) &&
      !src.includes(`await db?.getWorkerState(PUSH_DEFERRAL_STATE_KEY)`),
  ],

  // ------------------------------------------------------- repairs (idempotent)
  //
  // The first run of this script emitted two malformed spans (the type capture
  // excluded the interface's own braces, and the init splice re-emitted the tail
  // marker it was supposed to keep once). Both are repaired in place so a
  // re-run converges — no git checkout, no manual paste.
  [
    "src/worker.ts",
    "repair: the doubly-emitted init tail",
    (src) =>
      src.replace(
        lines(
          `          initError = err instanceof Error ? err.message : String(err);        } catch (err) {`,
          `          initError = err instanceof Error ? err.message : String(err);`,
        ),
        `          initError = err instanceof Error ? err.message : String(err);`,
      ),
    (src) =>
      !src.includes(`String(err);        } catch (err) {`),
  ],
  [
    "src/db.ts",
    "repair: the row type was emitted INSIDE the class (an interface cannot nest)",
    (src) => {
      const from = `  /**\n   * One \`push_watch\` row as the tracker reads it (see listPushWatch).`;
      const keep = `  /**\n   * The tracker pass's ENTRY, in ONE request (2026-09-26).`;
      const a = src.indexOf(from);
      if (a < 0) throw new Error("in-class row-type doc not found");
      const b = src.indexOf(keep, a + from.length);
      if (b < 0) throw new Error("in-class row-type tail not found");
      if (b - a > 4_000) throw new Error("in-class row-type span looks wrong");
      return src.slice(0, a) + src.slice(b);
    },
    (src) => !src.includes("  export interface PushWatchListRow {"),
  ],
  [
    "src/db.ts",
    "repair: the mapper lost its object literal's closing brace",
    (src) => {
      const broken =
        "        upStages: r.up_stages === null || r.up_stages === undefined ? null : String(r.up_stages),\n\n    });";
      if (!src.includes(broken)) throw new Error("broken mapper tail not found");
      return src.replace(
        broken,
        "        upStages: r.up_stages === null || r.up_stages === undefined ? null : String(r.up_stages),\n      };\n    });",
      );
    },
    (src) =>
      src.includes(
        "        upStages: r.up_stages === null || r.up_stages === undefined ? null : String(r.up_stages),\n      };\n    });",
      ),
  ],

  // ----------------------------------------------------------------- src/db.ts
  [
    "src/db.ts",
    "listPushWatch: the inline row type becomes the exported PushWatchListRow",
    (src) => {
      const from = `  async listPushWatch(limit = 40): Promise<Array<{`;
      const to = `  }>> {`;
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("listPushWatch head");
      const b = src.indexOf(to, a);
      if (b < 0) throw new Error("listPushWatch tail");
      // The type body travels VERBATIM into the exported interface below, so
      // the two signatures cannot drift apart.
      module.exports.__ROW_TYPE__ = src.slice(a + from.length, b);
      return (
        src.slice(0, a) +
        `  async listPushWatch(limit = 40): Promise<PushWatchListRow[]> {` +
        src.slice(b + to.length)
      );
    },
    (src) => src.includes(`async listPushWatch(limit = 40): Promise<PushWatchListRow[]> {`),
  ],
  [
    "src/db.ts",
    "listPushWatch: the mapper moves into mapPushWatchRows (one definition)",
    (src) => {
      const from = lines(
        `    return res.rows.map((row) => {`,
        `      const r = row as Record<string, unknown>;`,
        `      return {`,
        `        token: String(r.token),`,
        `        chatId: String(r.chat_id),`,
        `        symbol: r.symbol === null`,
      );
      const tail = `      };\n    });\n`;
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("mapper head");
      const t = src.indexOf(tail, a);
      if (t < 0) throw new Error("mapper tail");
      const bodyStart = a + `    return res.rows.map((row) => {\n`.length;
      module.exports.__MAPPER_BODY__ = src.slice(bodyStart, t);
      return (
        src.slice(0, a) +
        `    return this.mapPushWatchRows(res.rows);\n` +
        src.slice(t + tail.length)
      );
    },
    (src) => src.includes(`    return this.mapPushWatchRows(res.rows);`),
  ],
  [
    "src/db.ts",
    "the shared row type, at module scope (an interface cannot nest in the class)",
    (src) => {
      // The captured body on a fresh run; the transcribed one when the capture
      // is gone (a re-run skips the extraction edit, so its function never
      // runs). A transcription slip cannot survive: the compiler checks the
      // mapper's object literal against the interface it declares.
      const rowType = module.exports.__ROW_TYPE__ ?? ROW_TYPE_FALLBACK;
      const keep = `export class Db {`;
      const at = src.indexOf(keep);
      if (at < 0 || hits(src, keep) !== 1) throw new Error("class anchor");
      return (
        src.slice(0, at) +
        lines(
          `/**`,
          ` * One \`push_watch\` row as the tracker reads it (see Db.listPushWatch).`,
          ` *`,
          ` * WHY IT IS A NAMED TYPE (2026-09-26): the pass's entry batch returns the`,
          ` * SAME listing (see Db.beginTrackerPass), and a second inline copy of`,
          ` * these twenty fields is a silent way for the two to drift apart — a row`,
          ` * field added on one side only would read as \`undefined\` on the other.`,
          ` * The extraction is byte-for-byte, so both signatures are one definition.`,
          ` */`,
          `export interface PushWatchListRow {` + rowType + `\n  }`,
          ``,
          keep,
        ) +
        src.slice(at + keep.length)
      );
    },
    (src) => src.includes(`\nexport interface PushWatchListRow {`),
  ],
  [
    "src/db.ts",
    "the entry batch: beginTrackerPass + the shared row mapper",
    (src) => {
      const rowType = module.exports.__ROW_TYPE__;
      const mapperBody = module.exports.__MAPPER_BODY__;
      if (typeof rowType !== "string" || typeof mapperBody !== "string") {
        throw new Error("run the type/mapper extractions first (they set the captures)");
      }
      const keep =
        `  /** Persist one tracker check (mcap/liquidity refresh + alert bookkeeping). */`;
      const at = src.indexOf(keep);
      if (at < 0 || hits(src, keep) !== 1) throw new Error("insert point");
      return (
        src.slice(0, at) +
        lines(
          `  /**`,
          `   * The tracker pass's ENTRY, in ONE request (2026-09-26).`,
          `   *`,
          `   * WHY (docs/round-trips.md §4.11: a tick's Turso is ~20 DISTINCT one-shot`,
          `   * statements, not one fat loop — the pass's own note read \`trips 5\`): the`,
          `   * pass opened with three of them, none of which depends on the others:`,
          `   *`,
          `   *   1. the \`push_watch\` listing the pass rotates AND its recap/prune read`,
          `   *      (the same SELECT listPushWatch issues, byte for byte);`,
          `   *   2. the single \`worker_state\` row the settle stage decides on`,
          `   *      (deferrallog.UNCONFIRMED_TERMINAL_STATE_KEY) — a caller that knows`,
          `   *      which row it will need passes the key here and reads it for free;`,
          `   *   3. the RUNNING stamp on \`push_watch_pass\`, so the durable row moves the`,
          `   *      moment a pass starts (a stuck pass must not look like a quiet one).`,
          `   *`,
          `   * A libsql batch is ONE HTTP request whose statements run in order, so all`,
          `   * three ride it: 3 round trips -> 1 on a tick whose binding constraint is`,
          `   * Workers Free's 50 subrequests per invocation, where every Turso round`,
          `   * trip is one. The saving also lands in FRONT of the row rotation, which`,
          `   * is the stage the whole pass exists for.`,
          `   *`,
          `   * A batch is a transaction, so a refusal loses all three readings — the`,
          `   * caller re-reads the listing, re-writes the stamp and lets the settle`,
          `   * stage read its own row (the pre-merge shapes, see PushWatcher.runTick),`,
          `   * i.e. a refused batch costs today's price and never a lost reading.`,
          `   *`,
          `   * \`stateKeys\` empty => no state statement at all (an \`IN ()\` is not SQL)`,
          `   * and an empty map. A caller must read \`states.get(k)\` as "this batch did`,
          `   * not carry that row", never as "the row does not exist" — the same`,
          `   * discipline the scan front's gates keep (Db.readScanFront).`,
          `   */`,
          `  async beginTrackerPass(`,
          `    stampKey: string,`,
          `    stampValue: string,`,
          `    stateKeys: readonly string[],`,
          `    limit: number,`,
          `  ): Promise<{ rows: PushWatchListRow[]; states: Map<string, string> }> {`,
          `    const statements: Array<{`,
          `      sql: string;`,
          `      args: Array<string | number | null>;`,
          `    }> = [];`,
          `    if (stateKeys.length > 0) {`,
          `      statements.push({`,
          `        sql: \`SELECT key, value FROM worker_state WHERE key IN (\${stateKeys`,
          `          .map(() => "?")`,
          `          .join(",")})\`,`,
          `        args: [...stateKeys],`,
          `      });`,
          `    }`,
          `    const stateSlot = statements.length - 1;`,
          `    statements.push({`,
          `      // listPushWatch's own listing, verbatim: the row SET the pass rotates`,
          `      // and the rows its prune keeps are the ones the standalone listing`,
          `      // returns (active rows first, oldest last_checked first).`,
          `      sql: \`SELECT * FROM push_watch`,
          `            ORDER BY CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired') THEN 1 ELSE 0 END,`,
          `                     CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired')`,
          `                          THEN pushed_at ELSE last_checked END ASC`,
          `            LIMIT ?\`,`,
          `      args: [limit],`,
          `    });`,
          `    statements.push({`,
          `      // setWorkerState's own upsert, last: the reads above must not be able`,
          `      // to observe a stamp written for a pass that never got its listing.`,
          `      sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)" +`,
          `        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",`,
          `      args: [stampKey, stampValue],`,
          `    });`,
          `    const res = await this.get().batch(statements, "write");`,
          `    const states = new Map<string, string>();`,
          `    if (stateSlot >= 0) {`,
          `      for (const row of res[stateSlot]?.rows ?? []) {`,
          `        const r = row as Record<string, unknown>;`,
          `        states.set(String(r.key), String(r.value));`,
          `      }`,
          `    }`,
          `    return {`,
          `      rows: this.mapPushWatchRows(res[stateSlot + 1]?.rows ?? []),`,
          `      states,`,
          `    };`,
          `  }`,
          ``,
          `  /**`,
          `   * The shared mapping for a push_watch listing — ONE definition, used by`,
          `   * listPushWatch and by the pass's entry batch (see beginTrackerPass), so`,
          `   * the two cannot drift apart.`,
          `   */`,
          `  private mapPushWatchRows(`,
          `    rows: ReadonlyArray<Record<string, unknown>>,`,
          `  ): PushWatchListRow[] {`,
          `    return rows.map((row) => {`,
          mapperBody,
          `      };`,
          `    });`,
          `  }`,
          ``,
          keep,
        ) +
        src.slice(at + keep.length)
      );
    },
    (src) => src.includes(`  async beginTrackerPass(`),
  ],

  // ------------------------------------------------------------ src/pushwatch.ts
  [
    "src/pushwatch.ts",
    "the pass's entry: ONE batch for stamp + listing + the settle row",
    (src) => {
      const from = lines(
        `    let snapshot: PushWatchRow[] | null = null;`,
        `    try {`,
        `      snapshot = await this.db.listPushWatch(cfg.maxTracked);`,
        `      trips += 1;`,
        `    } catch {`,
        `      /* listing failed — the loop re-reads below, the prune still runs */`,
        `    }`,
      );
      const keep = lines(
        `    const expiring = (snapshot ?? []).filter(`,
      );
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("entry block");
      const b = src.indexOf(keep, a + from.length);
      if (b < 0) throw new Error("entry block tail");
      return (
        src.slice(0, a) +
        lines(
          `    let snapshot: PushWatchRow[] | null = null;`,
          `    /**`,
          `     * The unconfirmed-card record the settle stage below decides on, when the`,
          `     * entry batch carried it (see Db.beginTrackerPass). \`undefined\` = it did`,
          `     * not (no entry batch, or this Db has none), and that stage then reads`,
          `     * the row itself — the pre-merge shape, kept reachable on purpose.`,
          `     */`,
          `    let entryUnconfirmed: string | null | undefined;`,
          `    /**`,
          `     * The pass's ONE entry request (2026-09-26): the RUNNING stamp, the`,
          `     * listing this stage and the prune both read, and the settle row. It is`,
          `     * issued through a Partial<Pick<>> seam so a test double without the`,
          `     * method keeps the three-step behaviour instead of throwing.`,
          `     */`,
          `    const entryRead = (this.db as Partial<Pick<Db, "beginTrackerPass">>)`,
          `      .beginTrackerPass;`,
          `    if (typeof entryRead === "function") {`,
          `      try {`,
          `        const entry = await entryRead.call(`,
          `          this.db,`,
          `          TRACKER_PASS_STATE_KEY,`,
          `          runningPassStamp(),`,
          `          [UNCONFIRMED_TERMINAL_STATE_KEY],`,
          `          cfg.maxTracked,`,
          `        );`,
          `        trips += 1;`,
          `        snapshot = entry.rows;`,
          `        entryUnconfirmed = entry.states.get(UNCONFIRMED_TERMINAL_STATE_KEY) ?? null;`,
          `      } catch {`,
          `        // One request carried three readings, so a refusal lost all three:`,
          `        // fall back to the pre-merge shapes below (the stamp on its own, then`,
          `        // the listing), which is exactly what a pre-merge pass paid.`,
          `        try {`,
          `          await this.db.setWorkerState(TRACKER_PASS_STATE_KEY, runningPassStamp());`,
          `          trips += 1;`,
          `        } catch {`,
          `          /* telemetry only — never fail the pass over its start stamp */`,
          `        }`,
          `      }`,
          `    } else {`,
          `      // A Db without the entry batch: the stamp on its own, as before.`,
          `      try {`,
          `        await this.db.setWorkerState(TRACKER_PASS_STATE_KEY, runningPassStamp());`,
          `        trips += 1;`,
          `      } catch {`,
          `        /* telemetry only */`,
          `      }`,
          `    }`,
          `    if (snapshot === null) {`,
          `      try {`,
          `        snapshot = await this.db.listPushWatch(cfg.maxTracked);`,
          `        trips += 1;`,
          `      } catch {`,
          `        /* listing failed — the loop re-reads below, the prune still runs */`,
          `      }`,
          `    }`,
          keep,
        ) +
        src.slice(b + keep.length)
      );
    },
    (src) => src.includes(`        const entry = await entryRead.call(`),
  ],
  [
    "src/pushwatch.ts",
    "the settle stage consumes the entry batch's read",
    (src) =>
      src.replace(
        `    const settle = await this.settleUnconfirmedCards(now);`,
        `    const settle = await this.settleUnconfirmedCards(now, entryUnconfirmed);`,
      ),
    (src) => src.includes(`this.settleUnconfirmedCards(now, entryUnconfirmed);`),
  ],
  [
    "src/pushwatch.ts",
    "settleUnconfirmedCards: accept the pre-read",
    (src) => {
      const from = lines(
        `  private async settleUnconfirmedCards(`,
        `    now: number,`,
        `  ): Promise<{ rearmed: number; trips: number }> {`,
      );
      const keep = lines(`    this.settleProbed = true;`);
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("settle head");
      const b = src.indexOf(keep, a + from.length);
      if (b < 0) throw new Error("settle tail");
      // The old body's middle (the guard + the read) is rebuilt verbatim around
      // the pre-read branch: the guard's shape is what keeps a settled isolate
      // from paying anything at all.
      const guard = lines(
        `    if (this.settleProbed && this.unconfirmedWrites === 0) {`,
        `      return { rearmed: 0, trips: 0 };`,
        `    }`,
      );
      if (!src.slice(a, b).includes(guard)) throw new Error("settle guard missing");
      return (
        src.slice(0, a) +
        lines(
          `  private async settleUnconfirmedCards(`,
          `    now: number,`,
          `    /**`,
          `     * The record as the pass's ENTRY batch read it (see`,
          `     * Db.beginTrackerPass): \`undefined\` = the batch did not carry it and`,
          `     * this stage reads the row itself, exactly as before. \`null\` is a`,
          `     * reading — the row is absent — so the two cases stay distinguishable`,
          `     * (an absent row is not an unread one).`,
          `     */`,
          `    preRead?: string | null,`,
          `  ): Promise<{ rearmed: number; trips: number }> {`,
          `    // One read while something is pending, plus ONE probe per isolate: a record`,
          `    // left by an isolate that died between the send and its audit has no`,
          `    // in-memory trace, and the durable ring exists for exactly that. After the`,
          `    // first probe, a pass with nothing pending costs no round trip at all.`,
          guard,
          `    let trips = 0;`,
          `    let records: ReturnType<typeof parseUnconfirmedCardSends>;`,
          `    if (preRead !== undefined) {`,
          `      // ZERO round trips: the entry batch already read this row, and reading`,
          `      // it twice would spend a subrequest on the invocation's tightest one.`,
          `      records = parseUnconfirmedCardSends(preRead);`,
          `    } else {`,
          `      const stateRead = (this.db as Partial<Pick<Db, "getWorkerState">>)`,
          `        .getWorkerState;`,
          `      if (typeof stateRead !== "function") return { rearmed: 0, trips: 0 };`,
          `      try {`,
          `        records = parseUnconfirmedCardSends(`,
          `          await stateRead.call(this.db, UNCONFIRMED_TERMINAL_STATE_KEY),`,
          `        );`,
          `        trips += 1;`,
          `      } catch {`,
          `        // Unreadable: keep the probe armed so the next pass tries again — an`,
          `        // unproven card may be waiting on this decision.`,
          `        return { rearmed: 0, trips: 0 };`,
          `      }`,
          `    }`,
          keep,
        ) +
        src.slice(b + keep.length)
      );
    },
    (src) => src.includes(`    preRead?: string | null,`),
  ],
  [
    "src/pushwatch.ts",
    "the pass row's key and the running stamp, named once",
    (src) => {
      const keep = lines(
        `export interface PushWatchRow {`,
      );
      const at = src.indexOf(keep);
      if (at < 0 || hits(src, keep) !== 1) throw new Error("PushWatchRow insert point");
      return (
        src.slice(0, at) +
        lines(
          `/**`,
          ` * The durable \`worker_state\` row \`/health.pushWatchPass\` and /debug read,`,
          ` * and the RUNNING stamp a passing pass writes into it.`,
          ` *`,
          ` * Named HERE because the stamp now rides the pass's entry batch (see`,
          ` * Db.beginTrackerPass) instead of being written by`,
          ` * Scanner.runTrackerPass — one spelling for the row, the value and the`,
          ` * key, so the writer and the readers cannot drift apart. Scanner keeps the`,
          ` * literal in persistPassNote (the coverage line) and that is fine: the two`,
          ` * rows are one key, asserted by the tests.`,
          ` */`,
          `export const TRACKER_PASS_STATE_KEY = "push_watch_pass";`,
          ``,
          `/** The \`phase:"running"\` stamp: a pass in flight, before its first stage. */`,
          `export function runningPassStamp(now = Date.now()): string {`,
          `  return JSON.stringify({ at: now, note: "running", trackerMs: 0, phase: "running" });`,
          `}`,
          ``,
          keep,
        ) +
        src.slice(at + keep.length)
      );
    },
    (src) => src.includes(`export const TRACKER_PASS_STATE_KEY = "push_watch_pass";`),
  ],

  // -------------------------------------------------------------- src/scanner.ts
  [
    "src/scanner.ts",
    "remove the separate RUNNING stamp (it rides the entry batch now)",
    (src) => {
      const from = lines(
        `    // Stamp the row RUNNING before the pass's first stage (see`,
        `    // persistPassStart). The coverage line below is the pass's LAST write, so a`,
        `    // pass that never returns would otherwise leave /health.pushWatchPass`,
        `    // frozen while the row writes it DID make kept landing.`,
        `    await this.persistPassStart();`,
      );
      const keep = lines(`    // The pass runs on the TICK's DB leash, not the default one (see`);
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("stamp call");
      const b = src.indexOf(keep, a + from.length);
      if (b < 0) throw new Error("stamp call tail");
      return (
        src.slice(0, a) +
        lines(
          `    // The RUNNING stamp is no longer written here: it rides the pass's ONE`,
          `    // entry request (Db.beginTrackerPass, 2026-09-26), which the pass issues`,
          `    // before it touches a row — the guarantee this call existed for (a pass`,
          `    // that starts moves the durable row) for one fewer round trip per tick.`,
        ) +
        src.slice(b)
      );
    },
    (src) => !src.includes(`    await this.persistPassStart();`),
  ],
  [
    "src/scanner.ts",
    "delete the now-unused persistPassStart",
    (src) => {
      const from = lines(
        `  /**`,
        `   * Stamp the pass RUNNING before its first stage runs.`,
      );
      const keep = lines(
        `  /**`,
        `   * Public: publish the tick's tracker status for a tick that had NO budget`,
      );
      const a = src.indexOf(from);
      if (a < 0 || hits(src, from) !== 1) throw new Error("persistPassStart head");
      const b = src.indexOf(keep, a + from.length);
      if (b < 0) throw new Error("persistPassStart tail");
      if (b - a > 4_000) throw new Error("persistPassStart span looks wrong");
      return src.slice(0, a) + src.slice(b);
    },
    (src) => !src.includes(`  private async persistPassStart(`),
  ],
  [
    "src/scanner.ts",
    "the stale pointer to persistPassStart",
    (src) =>
      src.replace(
        `     * a pass in flight from a pass that is stuck (see persistPassStart).`,
        `     * a pass in flight from a pass that is stuck (see Db.beginTrackerPass).`,
      ),
    (src) => src.includes(`(see Db.beginTrackerPass).`),
  ],
];

// ------------------------------------------------------------------ test-unit.js
const CENSUS_TEST_FROM = lines(
  `    const { installTickProbe, resetTickProbe, dbTickStepView, dbStepView } = require("../dist/tickprobe.js");`,
  `    let clock = 1_000;`,
);
const CENSUS_TEST_KEEP = lines(
  `  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {`,
);
const CENSUS_TEST_NEW = lines(
  `    const { installTickProbe, resetTickProbe, dbTickStepView, dbStepView, dbStepLabel } = require("../dist/tickprobe.js");`,
  `    let clock = 1_000;`,
  `    const db = {`,
  `      getWorkerState: async () => { clock += 7; return null; },`,
  `      setWorkerState: async () => { clock += 3; },`,
  `      getTokenStatsMany: async () => { clock += 1; return []; },`,
  `    };`,
  `    resetTickProbe();`,
  `    const seam = {`,
  `      runOnce: async () => {`,
  `        await db.getWorkerState("k");`,
  `        await db.setWorkerState("k", "v");`,
  `      },`,
  `    };`,
  `    installTickProbe(seam, { db }, () => clock);`,
  `    // A call OUTSIDE the tick belongs to no tick's census: the worker's`,
  `    // /health handlers share this same handle.`,
  `    await db.getWorkerState("outside");`,
  `    await seam.runOnce();`,
  `    const census = dbTickStepView();`,
  `    // The KEY is in the label (2026-09-26): getWorkerState is the shared read`,
  `    // of ~40 rows, so "5 calls" could not say WHICH five — and the next merge`,
  `    // (this census's whole purpose) needs the names.`,
  `    assert.deepEqual(`,
  `      Object.keys(census).sort(),`,
  `      ["getWorkerState:k", "setWorkerState:k"],`,
  `      "the census names the KEY of every worker_state call the tick paid for",`,
  `    );`,
  `    assert.equal(census["getWorkerState:k"].calls, 1, "a delta, not a cumulative — the call before the tick is not this tick's");`,
  `    assert.equal(census["getWorkerState:k"].ms, 7, "and the ms are the tick's own");`,
  `    assert.equal(census["setWorkerState:k"].calls, 1);`,
  `    assert.equal(census["setWorkerState:k"].ms, 3);`,
  `    assert.equal(census.getTokenStatsMany, undefined, "a method the tick never touched is omitted, so the census is a list of what cost something");`,
  `    // The cumulative view is still the whole isolate's: together the two`,
  `    // readings say "this tick" AND "since boot" — and it names the outside`,
  `    // call's own key, which is what makes a cold isolate's boot reads readable.`,
  `    const cumulative = dbStepView();`,
  `    assert.equal(cumulative["getWorkerState:outside"].calls, 1, "the outside call is in the isolate view, under its own key");`,
  `    assert.equal(cumulative["getWorkerState:k"].calls, 1);`,
  `    assert.equal(dbStepLabel("getWorkerState", ["scan_heartbeat"]), "getWorkerState:scan_heartbeat");`,
  `    assert.equal(dbStepLabel("setWorkerState", ["k", "v"]), "setWorkerState:k");`,
  `    assert.equal(dbStepLabel("getWorkerState", []), "getWorkerState", "no key = the bare method name, never a dangling colon");`,
  `    assert.equal(dbStepLabel("claimScanLock", ["x"]), "claimScanLock", "every other method keeps its own name");`,
  `    resetTickProbe();`,
  `  });`,
);

const RUNNING_TEST_FROM = lines(
  `  await test("Scanner.runTrackerPass: the note row is stamped RUNNING before the pass works, and a skipped tick still moves it", async () => {`,
);
const RUNNING_TEST_KEEP = lines(
  `  await test("Scanner.runTrackerPass: the watchdog abandons a pass that never returns, and says so", async () => {`,
);
const RUNNING_TEST_NEW = lines(
  `  await test("Scanner.runTrackerPass: the note is the scanner's only write — the RUNNING stamp rides the pass's entry batch", async () => {`,
  `    // WHY (2026-09-23): the coverage line is the pass's LAST write, so any pass`,
  `    // that does not return left /health.pushWatchPass frozen while its row`,
  `    // writes kept landing (live: row \`SRI\` lastChecked 02:45:13Z, note \`at\``,
  `    // 02:36:26Z).`,
  `    //`,
  `    // WHY IT CHANGED (2026-09-26): the RUNNING stamp used to be a round trip of`,
  `    // the scanner's own, immediately before the pass — one of the three one-shot`,
  `    // statements the pass's entry paid. It now rides Db.beginTrackerPass (the`,
  `    // pass's first request, issued before it touches a row), so the scanner`,
  `    // writes exactly ONE row per pass: the note. The stamp's own landing is`,
  `    // pinned by the "a pass's entry is ONE request" case, against a real Db.`,
  `    const { Scanner } = require("../dist/scanner.js");`,
  `    const cfg = loadConfig({});`,
  `    const writes = [];`,
  `    const db = {`,
  `      setWorkerState: async (key, value) => {`,
  `        assert.equal(key, "push_watch_pass", "the note row is the durable one /health and /debug read");`,
  `        writes.push(JSON.parse(value));`,
  `      },`,
  `    };`,
  `    const scanner = new Scanner(`,
  `      db, { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,`,
  `    );`,
  `    // A watcher that writes nothing of its own: what the RUNNING stamp was for`,
  `    // lives in the entry batch now (see the next test's source assertions), so`,
  `    // the scanner's own path must be exactly one write.`,
  `    let writesWhenPassRan = null;`,
  `    scanner.pushWatcher = {`,
  `      headTokens: () => [],`,
  `      onPush: async () => {},`,
  `      runTick: async () => {`,
  `        writesWhenPassRan = writes.length;`,
  `        return {`,
  `          checked: 3, alerted: 0, trips: 7,`,
  `          note: "rows 3/29 pairs 6/6 miss 0 lost 0 trips 7",`,
  `          undeliveredTotal: 0, recoveredUndelivered: 0,`,
  `        };`,
  `      },`,
  `    };`,
  `    scanner.lastSummary = {};`,
  `    await scanner.runTrackerPass(Date.now() + 2_500);`,
  `    assert.equal(writesWhenPassRan, 0, "the scanner no longer writes a RUNNING stamp of its own — the pass's entry batch owns it");`,
  `    assert.equal(writes.length, 1, \`one write per pass, the note (got \${writes.length})\`);`,
  `    assert.equal(writes[0].phase, "done");`,
  `    assert.match(String(writes[0].note), /^ok:3\\/0 rows 3\\/29/);`,
  `    assert.equal(typeof writes[0].trackerMs, "number");`,
  `    // A tick whose envelope was spent before the pass ever started.`,
  `    await scanner.noteTrackerSkipped("tick 11500ms timed-out");`,
  `    assert.equal(writes.length, 2);`,
  `    assert.equal(writes[1].phase, "skip");`,
  `    assert.equal(writes[1].note, "skip:tick 11500ms timed-out");`,
  `    assert.equal(writes[1].trackerMs, 0, "no pass ran, so there is no pass duration to report");`,
  `  });`,
  ``,
);

const ENTRY_TEST = lines(
  `  // ---------- the tracker pass's ENTRY: ONE request (src/db.ts + pushwatch) ----`,
  `  //`,
  `  // §4.11 measured a tick's Turso as ~20 DISTINCT one-shot statements and the`,
  `  // pass's own note names itself \`trips 5\` — the biggest remaining cluster. Its`,
  `  // entry was three of those statements (the RUNNING stamp, the push_watch`,
  `  // listing, the settle stage's single row), none of which depends on the`,
  `  // others, so they ride ONE batch (one HTTP request, statements in order). This`,
  `  // drives the real Db method against a counting client, because the merge's`,
  `  // whole promise is a ROUND TRIP count.`,
  `  await test("db: a pass's entry is ONE request — stamp, listing and the settle row together", async () => {`,
  `    const t = tmpDb();`,
  `    const now = Date.now();`,
  `    try {`,
  `      const db = new Db(t.p, undefined, t.client);`,
  `      await db.init();`,
  `      await db.saveChatSettings({ chatId: "c", ...DEFAULT_SETTINGS, enabled: true });`,
  `      await db.setWorkerState("unconfirmed_terminal_cards", "[]");`,
  `      // One tracked row, through the writer the scanner itself uses.`,
  `      await db.upsertPushWatchMany([`,
  `        {`,
  `          token: "ENTRY_ROW",`,
  `          chatId: "c",`,
  `          symbol: "ENTRY",`,
  `          pushedAt: now - 60_000,`,
  `          mcapAtPush: 50_000,`,
  `          liquidityUsd: 20_000,`,
  `        },`,
  `      ]);`,
  `      let batches = 0;`,
  `      let executes = 0;`,
  `      const counting = {`,
  `        execute: (a) => { executes += 1; return t.client.execute(a); },`,
  `        batch: (a, m) => { batches += 1; return t.client.batch(a, m); },`,
  `        close: () => t.client.close(),`,
  `      };`,
  `      const fdb = new Db(t.p, undefined, counting);`,
  `      await fdb.init();`,
  `      batches = 0;`,
  `      executes = 0;`,
  `      const entry = await fdb.beginTrackerPass(`,
  `        "push_watch_pass",`,
  `        JSON.stringify({ at: now, note: "running", trackerMs: 0, phase: "running" }),`,
  `        ["unconfirmed_terminal_cards"],`,
  `        30,`,
  `      );`,
  `      assert.equal(batches, 1, "the whole entry is ONE request");`,
  `      assert.equal(executes, 0, "...and one batch, not an execute");`,
  `      assert.equal(entry.rows.length, 1, "the listing comes back");`,
  `      assert.equal(entry.rows[0].token, "ENTRY_ROW");`,
  `      assert.equal(entry.states.get("unconfirmed_terminal_cards"), "[]", "the settle row rode the same request");`,
  `      assert.equal(`,
  `        JSON.parse(await fdb.getWorkerState("push_watch_pass")).phase,`,
  `        "running",`,
  `        "the RUNNING stamp landed with it: a pass that starts moves the row in the same request, not in a second one",`,
  `      );`,
  `      // The listing is listPushWatch's own: same row set, same order, same shape.`,
  `      const standalone = await fdb.listPushWatch(30);`,
  `      assert.deepEqual(entry.rows, standalone, "the entry's listing IS listPushWatch's");`,
  `      assert.equal(standalone.length, 1);`,
  `      // A caller with no state rows to read pays the same ONE request, and an`,
  `      // empty map is "not carried", never "the row is absent".`,
  `      batches = 0;`,
  `      const bare = await fdb.beginTrackerPass("push_watch_pass", "{}", [], 30);`,
  `      assert.equal(batches, 1, "no state keys is still one request");`,
  `      assert.equal(bare.states.size, 0);`,
  `      assert.ok(!bare.states.has("unconfirmed_terminal_cards"));`,
  `    } finally {`,
  `      await t.cleanup();`,
  `    }`,
  `  });`,
  ``,
  `  await test("out-of-window patch: the cold-init reads and the pass entry are ONE request each", () => {`,
  `    // The two merges of docs/patches/round2-tick-merges-2026-09-26.apply.js live`,
  `    // past the file tool's edit window, and a half-applied paste is the worst of`,
  `    // both — so the shape is asserted on the source, the way every other`,
  `    // out-of-window patch in this repo is.`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`,
  `        .replace(/\\/\\/[^\\n]*/g, "")`,
  `        .replace(/\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const workerSrc = read("src/worker.ts");`,
  `    const dbSrc = read("src/db.ts");`,
  `    const pushwatchSrc = read("src/pushwatch.ts");`,
  `    const scannerSrc = read("src/scanner.ts");`,
  `    const applied = {`,
  `      "worker (the four boot rows ride ONE getWorkerStates)":`,
  `        workerSrc.includes(`,
  `          'bootStates=(awaitdb?.getWorkerStates(["axiom_access_token",PUSH_DEFERRAL_STATE_KEY,PUSH_LEDGER_STATE_KEY,SKIP_CAPTURE_STATE_KEY,]))??null;',`,
  `        ),`,
  `      "worker (and none of the four pays its own round trip)":`,
  `        !workerSrc.includes('awaitdb?.getWorkerState("axiom_access_token")') &&`,
  `        !workerSrc.includes("awaitdb?.getWorkerState(PUSH_DEFERRAL_STATE_KEY)") &&`,
  `        !workerSrc.includes("awaitdb?.getWorkerState(PUSH_LEDGER_STATE_KEY)") &&`,
  `        !workerSrc.includes("awaitdb?.getWorkerState(SKIP_CAPTURE_STATE_KEY)"),`,
  `      "db (the entry batch exists, and returns the shared row type)":`,
  `        dbSrc.includes("exportinterfacePushWatchListRow{") &&`,
  `        dbSrc.includes("asyncbeginTrackerPass(") &&`,
  `        dbSrc.includes("asynclistPushWatch(limit=40):Promise<PushWatchListRow[]>") &&`,
  `        dbSrc.includes("privatemapPushWatchRows("),`,
  `      "pushwatch (the pass reads its entry through the batch, with the fallbacks kept)":`,
  `        pushwatchSrc.includes('Partial<Pick<Db,"beginTrackerPass">>') &&`,
  `        pushwatchSrc.includes("awaitentryRead.call(this.db,") &&`,
  `        pushwatchSrc.includes("awaitthis.db.listPushWatch(cfg.maxTracked);") &&`,
  `        pushwatchSrc.includes("this.settleUnconfirmedCards(now,entryUnconfirmed);") &&`,
  `        pushwatchSrc.includes("preRead?:string|null,"),`,
  `      "scanner (the RUNNING stamp is no longer its own write)":`,
  `        !scannerSrc.includes("awaitthis.persistPassStart();") &&`,
  `        !scannerSrc.includes("privateasyncpersistPassStart("),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the round-2 tick merges are missing - apply docs/patches/round2-tick-merges-2026-09-26.apply.js",`,
  `      );`,
  `      return;`,
  `    }`,
  `    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);`,
  `    assert.deepEqual(missing, [], \`half-applied: \${missing.join(", ")}\`);`,
  `  });`,
  ``,
);

const TEST_ANCHOR = `  console.log("\\n===== UNIT TESTS =====");`;

function editTestUnit(src) {
  let out = src;
  if (!out.includes(CENSUS_TEST_NEW)) {
    out = splice(out, CENSUS_TEST_FROM, CENSUS_TEST_KEEP, CENSUS_TEST_NEW, "census test");
  }
  if (!out.includes(`the scanner's only write`)) {
    out = splice(out, RUNNING_TEST_FROM, RUNNING_TEST_KEEP, RUNNING_TEST_NEW, "running-stamp test");
  }
  // REPAIR (2026-09-26): the census splice's replacement text ends at `  });`
  // with no trailing newline, and the KEEP marker it runs into starts at column
  // 0 of its own line — so the two tests landed on ONE line
  // (`  });  await test("evaluateWatch...`). JS does not care; a reader does,
  // and every other case in this file is separated the same way.
  out = out.replace(
    `  });  await test("evaluateWatch: a band crossed while the row is paced still fires"`,
    `  });\n\n  await test("evaluateWatch: a band crossed while the row is paced still fires"`,
  );
  // NB: the anchor must be the TEST NAME, not the bare phrase — the RUNNING
  // test's own comment quotes "a pass's entry is ONE request" (2026-09-26: the
  // first run of this script inserted that comment and then read it back as
  // proof this block had landed, so the entry test was silently skipped).
  if (!out.includes(`db: a pass's entry is ONE request`)) {
    const at = out.indexOf(TEST_ANCHOR);
    if (at < 0) throw new Error("unit-test tail anchor not found");
    out = out.slice(0, at) + ENTRY_TEST + out.slice(at);
  }
  return out;
}

// ---------------------------------------------------------------------- runner
const problems = [];
const out = new Map();

function step(file, label, fn) {
  try {
    const before = out.has(file) ? out.get(file) : read(file);
    const after = fn(before);
    out.set(file, after);
    console.log(`ok   ${file}: ${label}`);
  } catch (err) {
    problems.push(`${file}: ${label} — ${err.message}`);
    console.error(`ABORT ${file}: ${label} — ${err.message}`);
  }
}

// VERIFY-THEN-WRITE: every edit is applied to an in-memory copy first, and the
// files are written only after every anchor resolved.
for (const [file, label, fn, already] of EDITS) {
  const before = out.has(file) ? out.get(file) : read(file);
  if (already(before)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  step(file, label, fn);
}
{
  const file = "scripts/test-unit.js";
  const before = read(file);
  if (
    before.includes(CENSUS_TEST_NEW) &&
    before.includes(`the scanner's only write`) &&
    // The TEST NAME again: `a pass's entry is ONE request` alone is quoted by
    // the RUNNING test's comment above, which is how the skip check lied once.
    before.includes(`db: a pass's entry is ONE request`)
  ) {
    console.log(`skip ${file}: the round-2 test cases (already applied)`);
  } else {
    step(file, "the census label, the RUNNING-stamp owner and the two merge cases", editTestUnit);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}

// ---------------------------------------------------------------------- repair
// REPAIR (2026-09-26): the entry test's "no single-key read" leg was written as
// a whole-FILE ban on `await db?.getWorkerState("axiom_access_token")`, and that
// read is still legitimate in three other places — the axiom token refresh
// paths re-check it — so the assertion failed the first time the block actually
// landed. It is scoped to the cold-init region instead: that region is what the
// merge changed, and `getWorkerState(` cannot match `getWorkerStates(`.
{
  const file = "scripts/test-unit.js";
  const src = read(file);
  const OLD = lines(
    `      "worker (and none of the four pays its own round trip)":`,
    `        !workerSrc.includes('awaitdb?.getWorkerState("axiom_access_token")') &&`,
    `        !workerSrc.includes("awaitdb?.getWorkerState(PUSH_DEFERRAL_STATE_KEY)") &&`,
    `        !workerSrc.includes("awaitdb?.getWorkerState(PUSH_LEDGER_STATE_KEY)") &&`,
    `        !workerSrc.includes("awaitdb?.getWorkerState(SKIP_CAPTURE_STATE_KEY)"),`,
  );
  const NEW = lines(
    `      "worker (and the cold-init block pays no single-key read of its own)": (() => {`,
    `        // SCOPED to the block (2026-09-26): a whole-FILE ban on the`,
    `        // axiom_access_token read fails on three legitimate callers (the axiom`,
    `        // token refresh paths re-check it) — which is what the first run of`,
    `        // this assertion showed. The cold-init region is what the merge`,
    `        // changed — and \`getWorkerState(\` cannot match \`getWorkerStates(\`.`,
    `        const from = workerSrc.indexOf("bootStates=(awaitdb?.getWorkerStates([");`,
    `        const to = workerSrc.indexOf(`,
    `          "}catch(err){initError=errinstanceofError?err.message:String(err);",`,
    `          from,`,
    `        );`,
    `        return from >= 0 && to > from && !workerSrc.slice(from, to).includes("getWorkerState(");`,
    `      })(),`,
  );
  if (!src.includes(OLD)) {
    console.log(`skip ${file}: the scoped cold-init assertion (already applied)`);
  } else if (hits(src, OLD) !== 1) {
    problems.push(`cold-init assertion repair — anchor matched ${hits(src, OLD)} times`);
  } else {
    fs.writeFileSync(path.join(root, file), src.replace(OLD, NEW));
    console.log(`ok   ${file}: the cold-init assertion is scoped to the block it is about`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} repair anchor(s) failed — the file was NOT repatched.`);
  process.exit(1);
}
console.log("\nall anchors applied.");
