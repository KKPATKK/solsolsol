/*
 * P0-3 (2026-09-29): a recycled isolate's Db.init() becomes ONE read.
 *
 * THE FINDING. Live 2026-09-29, /health: a cron tick's front split reads
 * `preStart 1006ms [bump 0 init 1008 gate 0 outage 0 rest 0]` — i.e. `init` IS
 * the whole front on the ticks that matter. The fingerprint gate is working
 * (scripts/test-schema-gate.js pins that a second init runs NO DDL batch at
 * all), so the ~1.0s is NOT the DDL. It is the FOUR single-purpose Turso
 * requests init still issued one after another:
 *
 *   1. the DDL fingerprint marker          (SELECT value FROM worker_state ...)
 *   2. the nine migration-flag reads       (batched, but its own request)
 *   3. the column probe                    (COLUMN_PROBE_TABLES pragma batch)
 *   4. the telemetry-seed marker           (getWorkerState)
 *
 * Four requests at the ~250-290ms per Turso round trip this Worker's egress
 * measures (`dbTickSteps.readScanFront 284`, `getPushAudit 289`, ...) is the
 * ~1.0s. The gate removed the DDL's CPU from a Workers-Free tick; what it left
 * on the WALL CLOCK is the round trips its own legs each paid separately.
 *
 * THE FIX. One batch carrying all four questions — the same rows, in the same
 * order — then each consumer takes its slice of that ONE reply. The only path
 * that still pays separately is the batch having FAILED, which is the database
 * whose `worker_state` does not exist yet (the never-initialized one), and that
 * path re-reads the flags after the DDL exactly as it did before.
 *
 * The column probe is carried ONLY when the fingerprint matched: on a mismatch
 * those rows were read BEFORE the DDL landed, so priming the column cache with
 * them would answer "column missing" for a column the DDL just added — the
 * silent migration skip the schema-gate suite exists to prevent.
 *
 * Why a script and not an editor call: this file is synced through the Vly
 * Daytona path, which has silently failed to match an exact anchor in
 * src/scanner.ts / src/worker.ts / src/db.ts before. The anchor assertions
 * below are what makes that impossible: a mismatch refuses the whole edit
 * instead of applying half of it.
 *
 * Idempotent: a second run detects the applied marker and leaves the file
 * untouched.
 *
 *   node docs/patches/boot-one-read-2026-09-29.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "db.ts");
let src = fs.readFileSync(file, "utf8");

const APPLIED = "TELEMETRY_SEED_MARKER_KEY";
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

// ---- 1. the flag order + the pure audit-ring helpers ---------------------
swap(
  "module scope: flag keys, telemetry marker, audit-ring helpers",
  `export function schemaFingerprint(statements: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const statement of statements) {
    for (let i = 0; i < statement.length; i++) {
      h ^= statement.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}`,
  `export function schemaFingerprint(statements: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const statement of statements) {
    for (let i = 0; i < statement.length; i++) {
      h ^= statement.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The one-time migration flags that \u0060init\u0060 asks for, in the ORDER its
 * reads index them (2026-09-29).
 *
 * WHY DATA AND NOT NINE INLINE STATEMENTS. The boot batch below (\u0060init\u0060's
 * ONE read) and the destructuring that consumes its slice have to agree about
 * the order, and the previous shape put the statements in one place and the
 * positions in another — which is how \u0060schema_alter_v4\u0060 /
 * \u0060settings_v5\u0060 were crossed once already (the comment that used to sit on
 * those two lines said so). One list, one order, both sides derived from it.
 */
export const MIGRATION_FLAG_KEYS = [
  "settings_v2_applied",
  "schema_alter_v1_done",
  "schema_alter_v2_done",
  "settings_v3_applied",
  "settings_v4_applied",
  "schema_alter_v3_done",
  "settings_v5_applied",
  "schema_alter_v4_done",
  "settings_v6_applied",
] as const;

/**
 * The telemetry-seed marker (see the seed block at the end of \u0060init\u0060).
 * Keyed here because the boot read asks for it as a ROW while the seed block
 * writes it inside SQL text; both spell the same name.
 */
export const TELEMETRY_SEED_MARKER_KEY = "telemetry_counts_seeded_v1";

/** The \u0060batch\u0060 reply shape (see Db.init's boot read). */
type BatchRows = Awaited<ReturnType<Client["batch"]>>;

/**
 * A \u0060worker_state.push_audit\u0060 ring as read from its row: an array of
 * entries, or \u0060[]\u0060 for an absent / unreadable / non-array value.
 * Tolerant on purpose — every reader of this ring treats "nothing readable" as
 * "nothing proven", and a parse that threw would turn a diagnostics row into a
 * failed heal.
 *
 * Exported and pure because the ring now has THREE readers that must agree:
 * Db.getPushAudit, Db.getInitialPushAuditTokens and the tracker pass's carried
 * proof parser (pushwatch.deliveredProofFromRows), which receives the RAW row
 * inside the heal's ONE read instead of paying a request of its own.
 */
export function parsePushAuditRing(
  raw: string | null | undefined,
): Array<{ kind?: string; token?: string; sig?: string; at?: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as never) : [];
  } catch {
    return [];
  }
}

/**
 * Every token with an "initial" audit entry, out of an ALREADY-PARSED ring
 * (see parsePushAuditRing). The rule lives here so Db.getInitialPushAuditTokens
 * and the tracker heal's carried read cannot drift — they answer the same
 * question off the same row, and only one of them pays a request for it.
 */
export function initialPushAuditTokens(
  ring: ReadonlyArray<{ kind?: string; token?: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const entry of ring) {
    if (entry?.kind === "initial" && entry.token) out.add(String(entry.token));
  }
  return out;
}`,
);

// ---- 2. init: four reads -> the ONE boot read ---------------------------
swap(
  "init: the boot read",
  `    // See the fingerprint gate comment above \u0060ddl\u0060. ONE small read decides
    // whether the batch runs at all: the row is a single short string (~46
    // bytes on the wire), against ~8KB of statements and their results.
    const ddlFingerprint = schemaFingerprint(ddl);
    let storedFingerprint: string | null = null;
    try {
      const known = await c.batch(
        [
          {
            sql: "SELECT value FROM worker_state WHERE key = ?",
            args: [SCHEMA_DDL_FINGERPRINT_KEY],
          },
        ],
        "read",
      );
      storedFingerprint =
        known[0]?.rows.length > 0 ? String(known[0].rows[0].value) : null;
    } catch {
      // Every \u0060worker_state\u0060 failure mode — table absent (a database that
      // has never been initialized), refused read, timeout — means an
      // UNKNOWN schema, which is exactly when the DDL should run. Swallowing
      // it here is required, not optional: a gate that could throw would
      // turn a cheap optimisation into a way for init to fail on the one
      // database it has never seen.
      storedFingerprint = null;
    }
    if (storedFingerprint !== ddlFingerprint) {`,
  `    // THE BOOT READ (2026-09-29): ONE request answers every question this boot
    // block asks.
    //
    // See the fingerprint gate comment above \u0060ddl\u0060: the marker is one small
    // row (~46 bytes on the wire) against ~8KB of statements, so the gate is
    // worth a read of its own. What the gate is NOT worth is the rest of the
    // block paying a request EACH — and that is what a recycled isolate was
    // billed for. The four questions (the marker, the nine migration flags, the
    // column probe and the telemetry-seed marker) were four sequential Turso
    // round trips because each was written where it was needed instead of where
    // it could be paid for. Measured live 2026-09-29: a cron tick's front split
    // reads \u0060preStart 1006 init 1008\u0060 — \u0060init\u0060 IS the front — while the
    // Worker's egress measures ~250-290ms per Turso request (\u0060dbTickSteps\u0060).
    // Four of them IS the second. The gate is doing its job inside it
    // (scripts/test-schema-gate.js pins that a SECOND init runs no DDL at all);
    // what was left is the round trips its own legs each paid separately.
    //
    // A libsql batch is ONE HTTP request — the statements run in order on one
    // connection — so the same rows in the same order now cost what the marker
    // read alone used to. Every consumer below takes its slice of that ONE
    // reply. The only path that still pays separately is this batch having
    // FAILED, which is the database whose \u0060worker_state\u0060 does not exist yet
    // (the never-initialized one, i.e. the one the DDL below has just created);
    // that path re-reads the flags after the DDL, exactly as it did before.
    const ddlFingerprint = schemaFingerprint(ddl);
    /** One \u0060worker_state\u0060 row by key, in the boot batch's own shape. */
    const flagRead = (
      key: string,
    ): { sql: string; args: Array<string | null> } => ({
      sql: "SELECT value FROM worker_state WHERE key = ?",
      args: [key],
    });
    // Slice offsets into the boot batch, named so the readers below cannot
    // drift from the order the statements are sent in (the destructuring used
    // to be positional across two separate arrays — see MIGRATION_FLAG_KEYS).
    const FLAG_INDEX = 1;
    const PROBE_INDEX = FLAG_INDEX + MIGRATION_FLAG_KEYS.length;
    const TELEMETRY_INDEX = PROBE_INDEX + COLUMN_PROBE_TABLES.length;
    let boot: BatchRows | null = null;
    try {
      boot = await c.batch(
        [
          flagRead(SCHEMA_DDL_FINGERPRINT_KEY),
          ...MIGRATION_FLAG_KEYS.map(flagRead),
          ...COLUMN_PROBE_TABLES.map((table) => ({
            sql: "SELECT name FROM pragma_table_info(?)",
            args: [table] as Array<string | null>,
          })),
          flagRead(TELEMETRY_SEED_MARKER_KEY),
        ],
        "read",
      );
    } catch {
      // Every \u0060worker_state\u0060 failure mode — table absent (a database that
      // has never been initialized), refused read, timeout — means an
      // UNKNOWN schema, which is exactly when the DDL should run. Swallowing
      // it here is required, not optional: a gate that could throw would
      // turn a cheap optimisation into a way for init to fail on the one
      // database it has never seen.
      //
      // It ALSO means the whole boot read failed, so \u0060flags\u0060 below re-reads
      // its slice on its own after the DDL: the pre-2026-09-29 shape, paid only
      // by the one database that has no \u0060worker_state\u0060 yet.
      boot = null;
    }
    const bootRes = boot;
    const storedFingerprint =
      bootRes && bootRes[0]?.rows.length > 0
        ? String(bootRes[0].rows[0].value)
        : null;
    if (storedFingerprint !== ddlFingerprint) {`,
);

// ---- 3. init: the flags slice + the carried column probe ----------------
swap(
  "init: flags slice + carried column probe",
  `      } catch {
        /* telemetry-grade: the gate must never be able to fail init */
      }
    }

    // Flag reads in ONE batched read round trip.
    const flags = await c.batch(
      [
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v2_applied'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v1_done'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v2_done'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v3_applied'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v4_applied'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v3_done'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v5_applied'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'schema_alter_v4_done'",
          args: [],
        },
        {
          sql: "SELECT value FROM worker_state WHERE key = 'settings_v6_applied'",
          args: [],
        },
      ],
      "read",
    );`,
  `      } catch {
        /* telemetry-grade: the gate must never be able to fail init */
      }
    }

    // The column probe: the slice the boot read above already carried, but ONLY
    // when the schema those rows describe is the one already in place. On a
    // mismatch they were read BEFORE the DDL landed, so priming the cache with
    // them would answer "column missing" for a column the DDL just added — the
    // silent migration skip scripts/test-schema-gate.js exists to prevent. The
    // carry is dropped in that case and the lazy probe runs after the DDL.
    if (bootRes && storedFingerprint === ddlFingerprint) {
      this.columnProbeRows = COLUMN_PROBE_TABLES.map(
        (_, i) =>
          (bootRes[PROBE_INDEX + i]?.rows ?? []) as Array<
            Record<string, unknown>
          >,
      );
    }

    // The migration flags: the boot read's own slice, or a batch of their own
    // when that read failed (a database with no \u0060worker_state\u0060 yet — the one
    // the DDL above has just created). Same rows, same ORDER as before, and the
    // destructuring below is unchanged.
    const flags: BatchRows = bootRes
      ? bootRes.slice(FLAG_INDEX, PROBE_INDEX)
      : await c.batch(MIGRATION_FLAG_KEYS.map(flagRead), "read");`,
);

// ---- 4. init: the telemetry-seed marker rides the boot read -------------
swap(
  "init: telemetry marker from the boot read",
  `    const telemetrySeeded = await this.getWorkerState(
      "telemetry_counts_seeded_v1",
    );`,
  `    // The seed marker rode the boot read too (see above): on a recycled
    // isolate this was the FOURTH and last request the pre-2026-09-29 init paid
    // separately. A failed boot read falls back to the single-key read, which
    // is the shape every path had before.
    const telemetrySeeded = bootRes
      ? (bootRes[TELEMETRY_INDEX]?.rows.length ?? 0) > 0
        ? String(bootRes[TELEMETRY_INDEX].rows[0].value)
        : null
      : await this.getWorkerState(TELEMETRY_SEED_MARKER_KEY);`,
);

// ---- 5. the carry field -------------------------------------------------
swap(
  "columnProbeRows field",
  `  private columnCache: Set<string> | null = null;

  /**
   * Whether \u0060table.column\u0060 exists — WITHOUT a round trip of its own once`,
  `  private columnCache: Set<string> | null = null;

  /**
   * Column rows the boot read ALREADY carried (see Db.init's ONE read). Set
   * only when that read's schema matched the running DDL, consumed by the first
   * readColumnNames() below, and cleared there whatever happens next.
   */
  private columnProbeRows: Array<Array<Record<string, unknown>>> | null = null;

  /**
   * Whether \u0060table.column\u0060 exists — WITHOUT a round trip of its own once`,
);

// ---- 6. readColumnNames: consume the carry ------------------------------
swap(
  "readColumnNames: take the carry before the probe",
  `  private async readColumnNames(): Promise<Set<string>> {
    const found = new Set<string>();
    try {
      const res = await this.get().batch(
        COLUMN_PROBE_TABLES.map((table) => ({
          sql: "SELECT name FROM pragma_table_info(?)",
          args: [table],
        })),
        "read",
      );
      COLUMN_PROBE_TABLES.forEach((table, i) => {
        for (const row of res?.[i]?.rows ?? []) {
          found.add(columnKey(table, String(row.name ?? "")));
        }
      });
    } catch (err) {`,
  `  private async readColumnNames(): Promise<Set<string>> {
    const found = new Set<string>();
    // The carry is taken AND CLEARED unconditionally: rows a previous boot left
    // behind must never answer a later probe, and a carry left set after a
    // failure would be reused by the next call as if it were fresh.
    const carried = this.columnProbeRows;
    this.columnProbeRows = null;
    try {
      const rows: Array<ReadonlyArray<Record<string, unknown>>> =
        carried ??
        (
          await this.get().batch(
            COLUMN_PROBE_TABLES.map((table) => ({
              sql: "SELECT name FROM pragma_table_info(?)",
              args: [table],
            })),
            "read",
          )
        ).map((res) => res?.rows ?? []);
      COLUMN_PROBE_TABLES.forEach((table, i) => {
        for (const row of rows[i] ?? []) {
          found.add(columnKey(table, String(row.name ?? "")));
        }
      });
    } catch (err) {`,
);

// ---- 7. getInitialPushAuditTokens shares the parse ---------------------
swap(
  "getInitialPushAuditTokens: the shared parse",
  `  async getInitialPushAuditTokens(): Promise<Set<string>> {
    const raw = await this.getWorkerState("push_audit");
    if (!raw) return new Set();
    try {
      const list = JSON.parse(raw) as Array<{ kind?: string; token?: string }>;
      return new Set(
        list
          .filter((e) => e.kind === "initial" && e.token)
          .map((e) => String(e.token)),
      );
    } catch {
      return new Set();
    }
  }`,
  `  async getInitialPushAuditTokens(): Promise<Set<string>> {
    // The rule is initialPushAuditTokens, shared with the tracker heal's
    // CARRIED read (see findUntrackedPushesAndLedger): the two answer the same
    // question off the same row, and one of them does not pay a request for it,
    // so a rule kept in two places would eventually disagree.
    return initialPushAuditTokens(
      parsePushAuditRing(await this.getWorkerState("push_audit")),
    );
  }`,
);

// ---- 8. findUntrackedPushesAndLedger carries the proof rows ------------
swap(
  "findUntrackedPushesAndLedger: signature + doc",
  `   * non-empty, which on a starved pass pushed the enrollments themselves into
   * the budget cut. Same rows, same order, one request.
   */
  async findUntrackedPushesAndLedger(
    sinceMs: number,
    ledgerKey: string,
    limit = 10,
  ): Promise<{
    missing: Array<{ token: string; chatId: string; pushedAt: number }>;
    ledgerRaw: string | null;
  }> {`,
  `   * non-empty, which on a starved pass pushed the enrollments themselves into
   * the budget cut. Same rows, same order, one request.
   *
   * WIDENED 2026-09-29 (the same fix, one stage over). The heal asks its next
   * question immediately after this read — "was a card for this token ever
   * DELIVERED?" — and answered it with three MORE requests: the initial-only
   * audit set, the unconfirmed-card record, and the whole ring again
   * (pushwatch.readDeliveredTokens). Live \u0060dbTickSteps\u0060 on one tick:
   * \u0060findUntrackedPushesAndLedger 589\u0060, \u0060getWorkerState:push_audit 289\u0060,
   * \u0060getPushAudit 289\u0060 — 1.17s of opening bookkeeping for one stage.
   *
   * So when the caller names the unconfirmed record's key, the SAME batch also
   * carries \u0060worker_state.push_audit\u0060 and that row: four statements, ONE
   * request, and \u0060proofsCarried\u0060 says they are this read's own. The audit ring
   * is read even on a pass whose untracked list comes back empty — it rides a
   * request that was already going out, and the alternative (a conditional
   * second request) is the cost this exists to remove.
   *
   * \u0060proofsCarried\u0060 is explicit rather than "auditRaw is defined" so a
   * caller whose Db is a narrow double (the heal tests') is told plainly that
   * the rows are NOT here and must ask readDeliveredTokens itself.
   */
  async findUntrackedPushesAndLedger(
    sinceMs: number,
    ledgerKey: string,
    limit = 10,
    /** The unconfirmed-card record's key (deferrallog.UNCONFIRMED_CARD_STATE_KEY).
     * Spelled as a parameter rather than imported because src/deferrallog.ts
     * imports THIS module. Only the heal passes it. */
    unconfirmedKey?: string,
  ): Promise<{
    missing: Array<{ token: string; chatId: string; pushedAt: number }>;
    ledgerRaw: string | null;
    /** The \u0060push_audit\u0060 ring as THIS request read it (parse it with
     * parsePushAuditRing). Present iff \u0060proofsCarried\u0060. */
    auditRaw?: string | null;
    /** The unconfirmed-card record as THIS request read it. */
    unconfirmedRaw?: string | null;
    /** Whether the two rows above are this read's own (see the doc). */
    proofsCarried?: boolean;
  }> {`,
);

swap(
  "findUntrackedPushesAndLedger: the widened batch",
  `        { sql: "SELECT value FROM worker_state WHERE key = ?", args: [ledgerKey] },
      ],
      "read",
    );
    const missing = (res[0]?.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        chatId: String(r.chat_id),
        pushedAt: Number(r.pushed_at ?? 0),
      };
    });
    const ledgerRow = (res[1]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    return { missing, ledgerRaw: ledgerRow ? String(ledgerRow.value) : null };
  }`,
  `        { sql: "SELECT value FROM worker_state WHERE key = ?", args: [ledgerKey] },
        // The proof rows (see the widened doc above): the delivery audit ring
        // and the unconfirmed-card record. Appended only when the caller named
        // the second key, so a caller that wants nothing else still pays the
        // narrow two-statement shape.
        ...(unconfirmedKey
          ? [
              {
                sql: "SELECT value FROM worker_state WHERE key = 'push_audit'",
                args: [] as Array<string | null>,
              },
              {
                sql: "SELECT value FROM worker_state WHERE key = ?",
                args: [unconfirmedKey] as Array<string | null>,
              },
            ]
          : []),
      ],
      "read",
    );
    const missing = (res[0]?.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        chatId: String(r.chat_id),
        pushedAt: Number(r.pushed_at ?? 0),
      };
    });
    const ledgerRow = (res[1]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!unconfirmedKey) {
      return { missing, ledgerRaw: ledgerRow ? String(ledgerRow.value) : null };
    }
    const proofRow = (i: number) =>
      (res[i]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    const auditEntry = proofRow(2);
    const unconfirmedEntry = proofRow(3);
    return {
      missing,
      ledgerRaw: ledgerRow ? String(ledgerRow.value) : null,
      auditRaw: auditEntry ? String(auditEntry.value) : null,
      unconfirmedRaw: unconfirmedEntry ? String(unconfirmedEntry.value) : null,
      proofsCarried: true,
    };
  }`,
);

fs.writeFileSync(file, src);
console.log("src/db.ts written");
