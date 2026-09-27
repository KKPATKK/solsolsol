// Verify-then-write: the /health reader retires a stale drain row.
const fs = require("fs");

let src = fs.readFileSync("src/worker.ts", "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

patch(
  "import the row's key",
  `  noteDuplicateCards,
  WRITE_DRAIN_ERROR_STALE_MS,
  type WriteDrainErrorRecord,`,
  `  noteDuplicateCards,
  WRITE_DRAIN_ERROR_KEY,
  WRITE_DRAIN_ERROR_STALE_MS,
  type WriteDrainErrorRecord,`,
);

patch(
  "the retire, at the parse site",
  `        const rawDrainError = tickState?.get("write_drain_error") ?? null;
        if (rawDrainError !== null) {
          try {
            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;
          } catch {
            writeDrainError = null;
          }
        }`,
  `        const rawDrainError = tickState?.get("write_drain_error") ?? null;
        if (rawDrainError !== null) {
          try {
            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;
          } catch {
            writeDrainError = null;
          }
        }
        // RETIRE A STALE RECORD (2026-09-27). The row is cleared by the isolate
        // that WROTE it (see clearPersistedDrainError), so an isolate recycled
        // before its own recovery leaves it standing forever: live that day a
        // poll read a record from 2026-09-25 (2.2 days old, \`pending 30\`) while
        // every drain behind it had landed. The reader that RENDERS the field
        // is the one place that sees it from any isolate, and /health is polled
        // every minute, so retiring it here costs ONE write per incident:
        // nothing to do when there is no row, and a LIVE row stays the writer's
        // own to clear — this only touches what WRITE_DRAIN_ERROR_STALE_MS
        // already calls history. Durable like the clear (waited on, not
        // floating: an un-awaited write is cancelled when the handler returns).
        if (
          db &&
          writeDrainError !== null &&
          writeDrainError.at > 0 &&
          Date.now() - writeDrainError.at > WRITE_DRAIN_ERROR_STALE_MS
        ) {
          const retiring = db
            .setWorkerState(WRITE_DRAIN_ERROR_KEY, "")
            .catch(() => undefined);
          try {
            ctx.waitUntil(retiring);
          } catch {
            // A caller without a live context (tests) must not see a rejection.
            void retiring;
          }
        }`,
);

if (patched > 0) {
  fs.writeFileSync("src/worker.ts", src);
  console.log(`wrote src/worker.ts (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}

// ---------------------------------------------------------------------------
// The summary type names the coalesced reading (it already rides the wire).
// ---------------------------------------------------------------------------
let summary = fs.readFileSync("src/scanner.ts", "utf8");
let sPatched = 0;

function sPatch(label, from, to) {
  if (summary.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!summary.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  summary = summary.replace(from, to);
  sPatched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

sPatch(
  "summary.writeDrain names the backlog",
  `  writeDrain?: {
    calls: number;
    ms: number;
    at: number;
    failures: number;
    totals: { calls: number; ms: number; failures: number };
  } | null;`,
  `  writeDrain?: {
    calls: number;
    ms: number;
    at: number;
    failures: number;
    totals: { calls: number; ms: number; failures: number };
    /** CALLS still owed (the queue coalesces per token, so this is 0-2). */
    pending?: number;
    /** Records still owed behind those calls — the backlog (see tickprobe). */
    owedTokens?: number;
    /** Calls held back for the tracker pass behind the drain. */
    heldForTracker?: number;
  } | null;`,
);

if (sPatched > 0) {
  fs.writeFileSync("src/scanner.ts", summary);
  console.log(`wrote src/scanner.ts (${sPatched} edit${sPatched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write (scanner.ts)");
}
