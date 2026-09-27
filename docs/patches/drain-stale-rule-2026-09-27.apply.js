// Verify-then-write: ONE stale rule, read by the flag and the retire.
const fs = require("fs");

let probe = fs.readFileSync("src/tickprobe.ts", "utf8");
let patched = 0;

function patch(label, from, to) {
  if (probe.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!probe.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  probe = probe.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

patch(
  "the predicate itself",
  `/**
 * What that row holds: the failed drain's own record (see
 * WriteDrainView.lastError) plus \`pending\` — the size of the queue the failure
 * stalled, which is the number that separates a blip from an outage.`,
  `/**
 * Whether a durable drain-failure record is HISTORY rather than a live failure
 * (see WRITE_DRAIN_ERROR_STALE_MS).
 *
 * ONE rule for both readers, because they must never disagree: /health's
 * \`writeDrainErrorStale\` flag and the retirement that deletes a row nobody
 * will ever clear (see the retire in worker.ts's /health). A record without a
 * usable \`at\` is never stale — an unreadable row must not license a write.
 */
export function drainErrorIsStale(
  record: { at?: unknown } | null | undefined,
  now: number,
): boolean {
  if (record === null || record === undefined || typeof record !== "object") return false;
  const at = Number((record as { at?: unknown }).at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > WRITE_DRAIN_ERROR_STALE_MS;
}

/**
 * What that row holds: the failed drain's own record (see
 * WriteDrainView.lastError) plus \`pending\` — the size of the queue the failure
 * stalled, which is the number that separates a blip from an outage.`,
);

if (patched > 0) {
  fs.writeFileSync("src/tickprobe.ts", probe);
  console.log(`wrote src/tickprobe.ts (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write (tickprobe.ts)");
}

// ---------------------------------------------------------------------------
// worker.ts: one import, two call sites.
// ---------------------------------------------------------------------------
let worker = fs.readFileSync("src/worker.ts", "utf8");
let wPatched = 0;

function wPatch(label, from, to) {
  if (worker.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!worker.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  worker = worker.replace(from, to);
  wPatched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

wPatch(
  "import the predicate",
  `  noteDuplicateCards,
  WRITE_DRAIN_ERROR_KEY,
  WRITE_DRAIN_ERROR_STALE_MS,
  type WriteDrainErrorRecord,`,
  `  noteDuplicateCards,
  WRITE_DRAIN_ERROR_KEY,
  WRITE_DRAIN_ERROR_STALE_MS,
  drainErrorIsStale,
  type WriteDrainErrorRecord,`,
);

wPatch(
  "the retire uses the rule",
  `        if (
          db &&
          writeDrainError !== null &&
          writeDrainError.at > 0 &&
          Date.now() - writeDrainError.at > WRITE_DRAIN_ERROR_STALE_MS
        ) {`,
  `        if (db && drainErrorIsStale(writeDrainError, Date.now())) {`,
);

wPatch(
  "the flag uses the same rule",
  `        writeDrainErrorStale:
          writeDrainError === null || !(writeDrainError.at > 0)
            ? null
            : Date.now() - writeDrainError.at > WRITE_DRAIN_ERROR_STALE_MS,`,
  `        // The SAME threshold the retire above applies (see drainErrorIsStale),
        // so a row this handler would delete can never be the one the flag
        // calls live. null keeps its old meaning ("no usable record") — an
        // unreadable row must not read as a boolean either way.
        writeDrainErrorStale:
          writeDrainError === null || !(Number(writeDrainError.at) > 0)
            ? null
            : drainErrorIsStale(writeDrainError, Date.now()),`,
);

if (wPatched > 0) {
  fs.writeFileSync("src/worker.ts", worker);
  console.log(`wrote src/worker.ts (${wPatched} edit${wPatched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write (worker.ts)");
}
