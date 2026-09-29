/*
 * B1 (2026-09-29): the push claim becomes ONE round trip, and Db gains the
 * /debug/db-latency probe (B4).
 *
 * Why a script and not an editor call: this file is synced through the Vly
 * Daytona path, which has silently failed to match an exact anchor in
 * src/scanner.ts / src/worker.ts / scripts/test-unit.js before. The anchor
 * assertions below are what makes that impossible: a mismatch refuses the
 * whole edit instead of applying half of it.
 *
 * Idempotent: a second run detects the applied markers and leaves the file
 * untouched.
 *
 *   node docs/patches/db-latency-2026-09-29.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "db.ts");
let src = fs.readFileSync(file, "utf8");

const APPLIED = "claimShapeOneTrip";
if (src.includes(APPLIED)) {
  console.log("already applied — src/db.ts untouched");
  process.exit(0);
}

/** Replace `old` with `new`, refusing unless it appears exactly once. */
function swap(label, old, neu) {
  const parts = src.split(old);
  if (parts.length !== 2) {
    console.error(`ANCHOR MISS (${parts.length - 1} matches): ${label}`);
    process.exit(1);
  }
  src = parts.join(neu);
  console.log(`ok: ${label}`);
}

// ---- 1. the claim's doc + body: 2 requests -> 1 batch -------------------
swap(
  "claimTokenPush",
  `  /**
   * Atomic push claim: INSERT OR IGNORE into seen_tokens BEFORE sending the
   * card. Overlapping scans (deploy soft-switch isolates, cron + /health
   * both driving a tick) can all pass the isTokenSeen check-then-act window,
   * but only one caller wins this insert — duplicate push cards become
   * impossible at the storage layer. On failed delivery call
   * unclaimTokenPush so the chat-aware re-eval pool can retry later.
   */
  async claimTokenPush(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
      args: [chatId, token, Date.now()],
    });
    const won = Number(res.rowsAffected ?? 0) > 0;
    if (won) {
      await this.bumpTelemetryCounter("telemetry_seen_tokens_count", 1);
    }
    return won;
  }`,
  `  /**
   * Atomic push claim: INSERT OR IGNORE into seen_tokens BEFORE sending the
   * card. Overlapping scans (deploy soft-switch isolates, cron + /health
   * both driving a tick) can all pass the isTokenSeen check-then-act window,
   * but only one caller wins this insert — duplicate push cards become
   * impossible at the storage layer. On failed delivery call
   * unclaimTokenPush so the chat-aware re-eval pool can retry later.
   *
   * ONE ROUND TRIP, NOT TWO (2026-09-29). The claim used to be the insert
   * followed by an AWAITED bumpTelemetryCounter — two sequential Turso
   * requests — while the push path gives the claim a 400ms slice
   * (scanner.CARD_CLAIM_BUDGET_MS). The Worker does not run next to the
   * database (live: ATL/DFW/MIA/DUB/SYD isolates against an
   * \`aws-ap-northeast-1\` database, with a single \`poolMs\` batch request
   * measuring 0-812ms), so a second round trip was enough to push a healthy
   * claim past its bound and DEFER the card — the \`deferred:1\` per tick and
   * \`/debug/deferral.pending\` shape this batching exists to remove. A libsql
   * batch is ONE HTTP request (the statements run in order on one
   * connection), so the slice now covers what it was calibrated for.
   *
   * The counter must still move only when the insert WON, and a batch cannot
   * branch in TypeScript before it is sent — so the second statement asks
   * SQLite itself: \`changes()\` is the row count of the statement just
   * completed (1 when the insert landed, 0 when OR IGNORE skipped it). A lost
   * claim therefore adds exactly what the guarded bump added, and the winning
   * result is still read from the first statement's rowsAffected.
   */
  async claimTokenPush(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().batch(
      [
        {
          sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
          args: [chatId, token, Date.now()],
        },
        {
          sql: \`INSERT INTO worker_state (key, value) VALUES (?, changes())
                ON CONFLICT(key) DO UPDATE SET
                  value = CAST(value AS INTEGER) + changes()\`,
          args: [SEEN_TOKENS_COUNT_KEY],
        },
      ],
      "write",
    );
    return Number(res[0]?.rowsAffected ?? 0) > 0;
  }`,
);

// ---- 2. the release path: same shape, plus the counter fix -------------
swap(
  "unclaimTokenPush",
  `  /** Release a push claim after a failed delivery (retry stays possible). */
  async unclaimTokenPush(chatId: string, token: string): Promise<void> {
    await this.get().execute({
      sql: "DELETE FROM seen_tokens WHERE chat_id = ? AND token = ?",
      args: [chatId, token],
    });
    await this.bumpTelemetryCounter("telemetry_seen_tokens_count", -1);
  }`,
  `  /**
   * Release a push claim after a failed delivery (retry stays possible).
   *
   * Same one-round-trip shape as claimTokenPush — the delete and the counter
   * ride one batch, with \`changes()\` supplying the delta instead of a second
   * awaited call. It lands a small correctness fix on the way: the old version
   * always subtracted 1, even for a release whose row never existed
   * ("deleting a row that never landed is a no-op", see boundClaim), which
   * walked the cached count down over time. Subtracting the DELETE's own row
   * count keeps the counter equal to the table.
   */
  async unclaimTokenPush(chatId: string, token: string): Promise<void> {
    await this.get().batch(
      [
        {
          sql: "DELETE FROM seen_tokens WHERE chat_id = ? AND token = ?",
          args: [chatId, token],
        },
        {
          sql: \`INSERT INTO worker_state (key, value) VALUES (?, -changes())
                ON CONFLICT(key) DO UPDATE SET
                  value = CAST(value AS INTEGER) - changes()\`,
          args: [SEEN_TOKENS_COUNT_KEY],
        },
      ],
      "write",
    );
  }`,
);

// ---- 3. the probe itself (B4's measurement half) -----------------------
swap(
  "Db.measureLatency",
  `  /**
   * Delivery audit ring (worker_state JSON, last N entries): records the`,
  `  /**
   * Times the round-trip shapes the tick's hot path depends on, FROM THIS
   * ISOLATE — the only place a Worker->Turso measurement means anything (a
   * laptop or CI box reaches the database over a different path). Read-mostly
   * by construction: the only writes touch the two fixed probe rows
   * (db_latency_probe / db_latency_probe_count), never a table the push path
   * reads, and the claim's own table is deliberately absent — see
   * src/dblatency.ts for what each op answers.
   *
   * A failed sample is recorded as its wall time instead of thrown: a call
   * that timed out IS the reading this probe is looking for, and one bad op
   * must not cost the whole report.
   */
  async measureLatency(
    samples: number = DB_LATENCY_SAMPLES,
  ): Promise<DbLatencyRaw> {
    const n = clampLatencySamples(samples);
    const raw: DbLatencyRaw = {};
    const time = async (
      op: DbLatencyOp,
      fn: () => Promise<unknown>,
    ): Promise<void> => {
      const t0 = Date.now();
      try {
        await fn();
      } catch {
        // The wait is the measurement; the error is not this probe's business.
      }
      const list = raw[op] ?? (raw[op] = []);
      list.push(Date.now() - t0);
    };
    // The probe's two statements. Shapes, not identities: the same INSERT OR
    // IGNORE plus counter upsert the claim runs, on rows no tick reads.
    const insertProbe = {
      sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES (?, ?)",
      args: [DB_LATENCY_PROBE_KEY, "0"],
    };
    const countProbe = {
      sql: \`INSERT INTO worker_state (key, value) VALUES (?, 1)
            ON CONFLICT(key) DO UPDATE SET
              value = CAST(value AS INTEGER) + 1\`,
      args: [DB_LATENCY_PROBE_COUNT_KEY],
    };
    for (let i = 0; i < n; i++) {
      // Re-read per sample so a mid-probe rebuild of the client (dead-tick
      // reset) cannot leave the rest of the report measuring a dead proxy.
      const c = this.get();
      await time("select1", () => c.execute("SELECT 1"));
      await time("readRow", () =>
        c.execute({
          sql: "SELECT value FROM worker_state WHERE key = ?",
          args: ["scan_heartbeat"],
        }),
      );
      await time("writeUpsert", () => c.execute(countProbe));
      // The claim's two shapes, statement for statement. Two requests vs one
      // is the ONLY difference, which is what CARD_CLAIM_BUDGET_MS cares
      // about.
      await time("claimShapeTwoTrip", async () => {
        await c.execute(insertProbe);
        await c.execute(countProbe);
      });
      await time("claimShapeOneTrip", () => c.batch([insertProbe, countProbe], "write"));
    }
    return raw;
  }

  /**
   * Delivery audit ring (worker_state JSON, last N entries): records the`,
);

fs.writeFileSync(file, src);
console.log("wrote src/db.ts");
