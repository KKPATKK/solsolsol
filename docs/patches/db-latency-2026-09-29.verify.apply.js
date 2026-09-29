/*
 * Follow-up to B1/B4 (2026-09-29): the probe must PROVE the batched claim's
 * `changes()` arithmetic on the live engine, not just measure latencies.
 *
 *   1. the claim's counter statements become shared constants (the probe runs
 *      the SAME upsert the claim runs, row swapped),
 *   2. measureLatency inserts under a FRESH key per sample and reports the
 *      probe counter before/after, so `changesVerdict` can check the delta,
 *   3. it cleans its per-call rows up and leaves the 1:1 counter row behind.
 *
 * Anchored + idempotent.
 *
 *   node docs/patches/db-latency-2026-09-29.verify.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "db.ts");
let src = fs.readFileSync(file, "utf8");

if (src.includes("DbLatencyMeasurement")) {
  console.log("already applied — src/db.ts untouched");
  process.exit(0);
}

function swap(label, old, neu) {
  const parts = src.split(old);
  if (parts.length !== 2) {
    console.error(`ANCHOR MISS (${parts.length - 1} matches): ${label}`);
    process.exit(1);
  }
  src = parts.join(neu);
  console.log(`ok: ${label}`);
}

// ---- 1. import the measurement type -----------------------------------
swap(
  "import type",
  `  type DbLatencyOp,
  type DbLatencyRaw,
} from "./dblatency";`,
  `  type DbLatencyMeasurement,
  type DbLatencyOp,
  type DbLatencyRaw,
} from "./dblatency";`,
);

// ---- 2. the shared counter statements ---------------------------------
swap(
  "counter SQL constants",
  `export const SEEN_TOKENS_COUNT_KEY = "telemetry_seen_tokens_count";`,
  `export const SEEN_TOKENS_COUNT_KEY = "telemetry_seen_tokens_count";

/**
 * The two statements that move the counter above, as SQL text.
 *
 * Constants because TWO callers must run them verbatim: the claim and release
 * paths (one batch each) and the /debug/db-latency probe, whose whole job is
 * to prove that a statement following an INSERT inside a batch sees THAT
 * insert's row count (\`changes()\`). Inlining either copy would let the probe
 * keep passing while the claim it describes drifted away from it.
 *
 * \`changes()\` is the delta because a batch cannot branch in TypeScript before
 * it is sent: 1 when the row before it landed, 0 when INSERT OR IGNORE skipped
 * it — see claimTokenPush.
 */
const CLAIM_COUNTER_UPSERT_SQL = \`INSERT INTO worker_state (key, value) VALUES (?, changes())
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(value AS INTEGER) + changes()\`;
const CLAIM_COUNTER_RELEASE_SQL = \`INSERT INTO worker_state (key, value) VALUES (?, -changes())
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(value AS INTEGER) - changes()\`;`,
);

// ---- 3. claim/unclaim use them ----------------------------------------
swap(
  "claim uses the constant",
  `        {
          sql: \`INSERT INTO worker_state (key, value) VALUES (?, changes())
                ON CONFLICT(key) DO UPDATE SET
                  value = CAST(value AS INTEGER) + changes()\`,
          args: [SEEN_TOKENS_COUNT_KEY],
        },`,
  `        { sql: CLAIM_COUNTER_UPSERT_SQL, args: [SEEN_TOKENS_COUNT_KEY] },`,
);
swap(
  "release uses the constant",
  `        {
          sql: \`INSERT INTO worker_state (key, value) VALUES (?, -changes())
                ON CONFLICT(key) DO UPDATE SET
                  value = CAST(value AS INTEGER) - changes()\`,
          args: [SEEN_TOKENS_COUNT_KEY],
        },`,
  `        { sql: CLAIM_COUNTER_RELEASE_SQL, args: [SEEN_TOKENS_COUNT_KEY] },`,
);

// ---- 4. measureLatency: fresh keys + the counter check ----------------
const startAnchor =
  "  /**\n   * Times the round-trip shapes the tick's hot path depends on, FROM THIS";
const endAnchor =
  "\n  /**\n   * Delivery audit ring (worker_state JSON, last N entries): records the";
const i = src.indexOf(startAnchor);
const j = src.indexOf(endAnchor);
if (i < 0 || j < 0 || j <= i) {
  console.error("ANCHOR MISS: measureLatency block boundaries");
  process.exit(1);
}
const block = `  /**
   * Times the round-trip shapes the tick's hot path depends on, FROM THIS
   * ISOLATE — the only place a Worker->Turso measurement means anything (a
   * laptop or CI box reaches the database over a different path).
   *
   * Read-mostly by construction: the only writes touch worker_state probe rows
   * (see src/dblatency.ts), never a table the push path reads, and the claim's
   * own table is deliberately absent.
   *
   * It also CHECKS the batched claim's arithmetic instead of trusting it. Each
   * sample inserts under a fresh key, so the two-trip shape's insert wins
   * (changes() = 1 → the counter moves once) and the one-trip shape's insert on
   * that same key loses (changes() = 0 → the counter must NOT move). The
   * counter is read before and after and handed back with the samples, where
   * dblatency.changesVerdict turns "2 per sample" into verified / mismatch.
   *
   * A failed sample is recorded as its wall time instead of thrown: a call
   * that timed out IS the reading this probe is looking for, and one bad op
   * must not cost the whole report.
   */
  async measureLatency(
    samples: number = DB_LATENCY_SAMPLES,
  ): Promise<DbLatencyMeasurement> {
    const n = clampLatencySamples(samples);
    const raw: DbLatencyRaw = {};
    const counterBefore = await this.readProbeCounter();
    const nonce = Date.now().toString(36);
    const keys: string[] = [];
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
    for (let i = 0; i < n; i++) {
      // FRESH key per sample: that is what makes the two shapes differ in a
      // way the counter can see (see the method doc). The rows are deleted at
      // the end of the call, so nothing accumulates but the counter.
      const key = \`\${DB_LATENCY_PROBE_KEY}:\${nonce}:\${i}\`;
      keys.push(key);
      const insertProbe = {
        sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES (?, ?)",
        args: [key, "0"],
      };
      // The claim's OWN statement, on a probe row: the probe exists to prove
      // this SQL, so it must not carry a second copy of it.
      const countProbe = {
        sql: CLAIM_COUNTER_UPSERT_SQL,
        args: [DB_LATENCY_PROBE_COUNT_KEY],
      };
      const bumpProbe = {
        sql: \`INSERT INTO worker_state (key, value) VALUES (?, 1)
              ON CONFLICT(key) DO UPDATE SET
                value = CAST(value AS INTEGER) + 1\`,
        args: [DB_LATENCY_PROBE_COUNT_KEY],
      };
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
      await time("writeUpsert", () => c.execute(bumpProbe));
      // The claim's two shapes, statement for statement. Two requests vs one
      // is the ONLY difference, which is what CARD_CLAIM_BUDGET_MS cares
      // about.
      await time("claimShapeTwoTrip", async () => {
        await c.execute(insertProbe);
        await c.execute(countProbe);
      });
      await time("claimShapeOneTrip", () =>
        c.batch([insertProbe, countProbe], "write"),
      );
    }
    const counterAfter = await this.readProbeCounter();
    // One request retires this call's rows. A leftover probe row would be
    // inert, so a failure here never fails the report.
    try {
      await this.get().batch(
        keys.map((key) => ({
          sql: "DELETE FROM worker_state WHERE key = ?",
          args: [key],
        })),
        "write",
      );
    } catch {
      /* inert leftover */
    }
    return { samples: n, raw, counterBefore, counterAfter };
  }

  /**
   * The probe's counter row as a number (see measureLatency). An absent row is
   * 0 — the probe's first call has none yet, and that is a real reading. An
   * unreadable row is null, which makes changesVerdict answer "unavailable"
   * instead of inventing a verdict from a guess.
   */
  private async readProbeCounter(): Promise<number | null> {
    try {
      const raw = await this.getWorkerState(DB_LATENCY_PROBE_COUNT_KEY);
      if (raw === null || raw === undefined || raw === "") return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
`;

src = src.slice(0, i) + block + src.slice(j);
console.log("ok: measureLatency block");
fs.writeFileSync(file, src);
console.log("wrote src/db.ts");
