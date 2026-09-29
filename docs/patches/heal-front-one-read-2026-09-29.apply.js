/*
 * P0-1/P0-2 (2026-09-29): the tracker heal's opening reads become ONE request.
 *
 * THE FINDING. Live /health `summary.dbTickSteps` on a tick that ran the pass:
 *
 *   findUntrackedPushesAndLedger          1 call   589ms
 *   getWorkerState:push_audit             1 call   289ms
 *   getPushAudit                          1 call   289ms
 *
 * 1.17s of ONE stage's opening bookkeeping, and two of those three requests are
 * the SAME `worker_state.push_audit` row read twice:
 *
 *   - pushwatch.readDeliveredTokens -> Db.getInitialPushAuditTokens (the ring)
 *   - pushwatch.readDeliveredTokens -> Db.getPushAudit               (the ring)
 *
 * plus a third worker_state read for the unconfirmed-card record. The ring read
 * twice is the purest instance in the tick: the same bytes, the same moment.
 *
 * THE FIX, two halves:
 *
 *   1. Db.findUntrackedPushesAndLedger (patched by
 *      docs/patches/boot-one-read-2026-09-29.apply.js) now ALSO carries the
 *      audit ring and the unconfirmed-card record when the caller names the
 *      latter's key. Four statements, ONE request, and `proofsCarried` says so.
 *   2. The heal hands those two raw rows to readDeliveredTokens, which parses
 *      them with the SAME rules the three-request path uses
 *      (db.parsePushAuditRing + db.initialPushAuditTokens + deferrallog's
 *      deliveredCardTokens / parseUnconfirmedCardSends) and reports ZERO extra
 *      trips.
 *
 * So the heal's opening read goes 4 requests -> 1 on every pass, with no
 * staleness question to answer: the ring is still read at exactly the moment
 * readDeliveredTokens always read it. Nothing else moves — the row loop's cut
 * proof and the unconfirmed settle keep their own reads at their own moments.
 *
 * A Db that answers the narrow two-field shape (every heal test double, and any
 * older shape) leaves `proofsCarried` unset, and the heal then calls
 * readDeliveredTokens with nothing carried — the pre-2026-09-29 behaviour, byte
 * for byte. That is why this is additive on both sides.
 *
 * Idempotent: a second run detects the applied marker and leaves the file
 * untouched.
 *
 *   node docs/patches/heal-front-one-read-2026-09-29.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "pushwatch.ts");
let src = fs.readFileSync(file, "utf8");

const APPLIED = "deliveredProofFromRows";
if (src.includes(APPLIED)) {
  console.log("already applied — src/pushwatch.ts untouched");
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

// ---- 1. the value import off ./db ---------------------------------------
swap(
  "import the shared audit-ring parsers",
  `import type { AppConfig } from "./config";
import type { Db } from "./db";`,
  `import type { AppConfig } from "./config";
// Two VALUES off ./db (not just the type): the heal now receives the raw
// \u0060push_audit\u0060 and unconfirmed rows inside its opening batch and parses them
// here, and the parse must be the SAME one Db.getInitialPushAuditTokens and
// Db.getPushAudit use — a second copy of the rule is how the two would
// eventually disagree (see parsePushAuditRing). No cycle: src/db.ts imports
// nothing from this module.
import { initialPushAuditTokens, parsePushAuditRing, type Db } from "./db";`,
);

// ---- 2. readDeliveredTokens: the carried branch ------------------------
swap(
  "readDeliveredTokens: the carried branch + the shared twin",
  ` * Read through a seam rather than by adding a method to the Db interface: the
 * Db doubles the heal tests drive implement the narrower initial-only reader,
 * and both readers are the SAME \u0060push_audit\u0060 worker_state row, so the wider one
 * costs one extra trip per heal pass (only on a pass that found untracked
 * pushes) and nothing at all on a normal tick. A seam without the ring reader
 * degrades to the initial-only set — the pre-widen behaviour, never a crash and
 * never a dropped resend.
 */
async function readDeliveredTokens(database: Db): Promise<{
  tokens: Set<string>;
  unconfirmed: Set<string>;
  trips: number;
}> {
  const initial = await database.getInitialPushAuditTokens();
  let trips = 1;`,
  ` * Read through a seam rather than by adding a method to the Db interface: the
 * Db doubles the heal tests drive implement the narrower initial-only reader,
 * and both readers are the SAME \u0060push_audit\u0060 worker_state row, so the wider one
 * costs one extra trip per heal pass (only on a pass that found untracked
 * pushes) and nothing at all on a normal tick. A seam without the ring reader
 * degrades to the initial-only set — the pre-widen behaviour, never a crash and
 * never a dropped resend.
 *
 * 2026-09-29: the row is no longer read TWICE here. Db's heal-opening batch
 * carries it (see findUntrackedPushesAndLedger's widened return), and this
 * function parses what that batch handed over through deliveredProofFromRows
 * below — the SAME rules, zero trips. The seam path stays for every caller that
 * carries nothing, which is what keeps the heal tests' narrow doubles and any
 * older Db shape on exactly the behaviour they had.
 */
async function readDeliveredTokens(
  database: Db,
  /**
   * The two rows a caller has ALREADY read (findUntrackedPushesAndLedger's
   * widened return): the delivery audit ring and the unconfirmed-card record.
   * Present on the heal, undefined everywhere else.
   */
  carried?: { auditRaw: string | null; unconfirmedRaw: string | null },
): Promise<{
  tokens: Set<string>;
  unconfirmed: Set<string>;
  trips: number;
}> {
  // The zero-trip twin: same parsers, same two sets, no request. A caller that
  // already holds the rows must not pay for them again, and must not be able to
  // disagree with the seam path below about what they mean.
  if (carried) {
    return {
      ...deliveredProofFromRows(carried.auditRaw, carried.unconfirmedRaw),
      trips: 0,
    };
  }
  const initial = await database.getInitialPushAuditTokens();
  let trips = 1;`,
);

// ---- 3. the shared pure parser ------------------------------------------
swap(
  "deliveredProofFromRows",
  `/**
 * Heal-path counters (module scope, same shape as src/poolfallback.ts's).`,
  `/**
 * The delivered/unconfirmed proof sets out of rows ALREADY read: the zero-trip
 * twin of readDeliveredTokens, and the only place the two agree.
 *
 * Both readers of the ring run over the SAME parsed array — the initial-only
 * set (db.initialPushAuditTokens) and the wider delivered kinds
 * (deferrallog.deliveredCardTokens) — which is exactly what the seam path did
 * with two requests into the same row, and the union is what licenses the
 * heal's 補發 gate. The unconfirmed record is \`deferrallog\`'s own rule, so the
 * three-state send reads the same in both paths.
 *
 * Exported for the unit suite: the property worth pinning is that this and the
 * three-request seam path return the SAME sets for the same row.
 */
export function deliveredProofFromRows(
  auditRaw: string | null,
  unconfirmedRaw: string | null,
): { tokens: Set<string>; unconfirmed: Set<string> } {
  const ring = parsePushAuditRing(auditRaw);
  return {
    tokens: new Set([
      ...initialPushAuditTokens(ring),
      ...deliveredCardTokens(ring),
    ]),
    unconfirmed: new Set(
      parseUnconfirmedCardSends(unconfirmedRaw).map((r) => r.token),
    ),
  };
}

/**
 * Heal-path counters (module scope, same shape as src/poolfallback.ts's).`,
);

// ---- 4. the heal's opening read carries the proof rows ------------------
swap(
  "heal: one opening read carries the proof rows",
  `      let ledgerRaw: string | null = null;
      if (!healSkipped && !healYield) {
        trips += 1;
        const healRead = await this.db.findUntrackedPushesAndLedger(
          now - cfg.windowHours * 3_600_000,
          PUSH_LEDGER_STATE_KEY,
          10,
        );
        missing = healRead.missing;
        ledgerRaw = healRead.ledgerRaw;
        healMissing = missing.length;
      }`,
  `      let ledgerRaw: string | null = null;
      /**
       * The delivered-card proof rows the opening read CARRIED (see
       * findUntrackedPushesAndLedger's widened return, 2026-09-29): the
       * \u0060push_audit\u0060 ring and the unconfirmed-card record, read in the same
       * request as the untracked list above. Undefined when the Db answers the
       * narrow two-field shape (the heal tests' doubles), and the proof read
       * below then pays its own requests exactly as it always did.
       */
      let carriedProof:
        | { auditRaw: string | null; unconfirmedRaw: string | null }
        | undefined;
      if (!healSkipped && !healYield) {
        trips += 1;
        const healRead = await this.db.findUntrackedPushesAndLedger(
          now - cfg.windowHours * 3_600_000,
          PUSH_LEDGER_STATE_KEY,
          10,
          // Names the unconfirmed-card record's row, which is what makes the
          // SAME batch also carry \u0060push_audit\u0060 (see the widened doc): one
          // request for the untracked list, the ledger, the audit ring and this
          // record, against the four the heal used to pay before its first
          // enrollment.
          UNCONFIRMED_CARD_STATE_KEY,
        );
        missing = healRead.missing;
        ledgerRaw = healRead.ledgerRaw;
        if (healRead.proofsCarried) {
          carriedProof = {
            auditRaw: healRead.auditRaw ?? null,
            unconfirmedRaw: healRead.unconfirmedRaw ?? null,
          };
        }
        healMissing = missing.length;
      }`,
);

swap(
  "heal: hand the proof rows to the reader",
  `        const proof = await readDeliveredTokens(this.db);`,
  `        const proof = await readDeliveredTokens(this.db, carriedProof);`,
);

fs.writeFileSync(file, src);
console.log("src/pushwatch.ts written");
