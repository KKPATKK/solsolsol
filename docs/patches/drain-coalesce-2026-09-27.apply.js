// Verify-then-write: the deferred-write queue coalesces by token.
const fs = require("fs");

const FILE = "src/tickprobe.ts";
let src = fs.readFileSync(FILE, "utf8");
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

// ---------------------------------------------------------------------------
// 1. The queue becomes per-method buckets that merge by token.
// ---------------------------------------------------------------------------
const OLD_QUEUE_DECL = `/**
 * One deferred write waiting for the drain. \`attempts\` counts FAILED runs: an
 * entry leaves the queue when it lands, or after DEFERRED_WRITE_MAX_ATTEMPTS
 * (see drainDeferredWrites for why the queue, not the batch, owns the state).
 */
interface DeferredCall {
  name: string;
  run: () => Promise<unknown>;
  attempts: number;
}

/** Writes waiting for the drain, in call order. */
let queue: DeferredCall[] = [];`;

const NEW_QUEUE_DECL = `/**
 * One COALESCED deferred write: everything owed to ONE Db method on ONE handle.
 *
 * WHY ONE BUCKET PER METHOD INSTEAD OF ONE ENTRY PER CALL (2026-09-27): the
 * queue held every call VERBATIM, and both deferred calls decide what to write
 * from the STORED value — \`recordTokenStatsMany\` only registers a token the
 * stats read did not return, \`updateTokenMaxMcaps\` only raises a maximum — so a
 * write that has not landed yet makes the SAME token look new again on the next
 * tick and queues ANOTHER copy of it. Live 2026-09-27: \`pending\` went 12 → 31
 * in eleven minutes while \`totals.calls\` went 2 → 7, every entry
 * \`heldForTracker\` (the drain never got room), i.e. the queue was feeding
 * itself and could only grow. Coalescing by token makes the backlog BOUNDED by
 * the number of DISTINCT tokens owed rather than by the number of ticks that
 * wanted them, turns a catch-up into ONE round trip per method, and removes the
 * duplicates that were the growth.
 *
 * \`owed\` maps each record's own token to the record still waiting, insertion
 * ordered (Map), so one bucket's payload keeps the order it was absorbed in.
 * \`rank\` fixes the LANDING order ACROSS buckets: a registration must land
 * before a raise for the same token, or the raise's UPDATE matches no row and
 * the high-water mark is silently lost.
 */
interface DeferredBucket {
  name: string;
  rank: number;
  /** The original Db method, captured at install (the wrapper replaces it). */
  call: (...args: unknown[]) => Promise<unknown>;
  owed: Map<string, unknown>;
  /** Merge one absorbed call's arguments into \`owed\` (first-wins / max-wins). */
  absorb: (args: readonly unknown[]) => void;
  /** FAILED runs: an owed batch is dropped after DEFERRED_WRITE_MAX_ATTEMPTS. */
  attempts: number;
}

/** Every bucket this isolate has opened (see DeferredBucket). */
let buckets: DeferredBucket[] = [];
/** Unique keys for records a bucket cannot coalesce by token (see below). */
let opaqueRecords = 0;

/** Records owed across every bucket (0 = nothing to drain). */
function owedRecordCount(): number {
  let n = 0;
  for (const bucket of buckets) n += bucket.owed.size;
  return n;
}

/**
 * The buckets with something owed, in LANDING order (see DeferredBucket.rank).
 * A stable sort, so equal ranks keep the order they were opened in — a rebuilt
 * handle's bucket never overtakes the live one's.
 */
function owedBuckets(): DeferredBucket[] {
  return buckets.filter((bucket) => bucket.owed.size > 0).sort((a, b) => a.rank - b.rank);
}

/**
 * The coalescing key of one deferred record: the token it writes. A record
 * without one (a test double's primitive, or a future call shape) gets a unique
 * key instead, so it keeps its own slot rather than being merged into a
 * stranger's row.
 */
function deferredRecordKey(record: unknown): string {
  if (typeof record === "string" && record.length > 0) return record;
  if (record !== null && typeof record === "object") {
    const token = (record as { token?: unknown }).token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  opaqueRecords += 1;
  return \`#\${opaqueRecords}\`;
}

/**
 * Registration absorbs FIRST-WINS: the FIRST sight of a token is the row's
 * truth (\`recordTokenStatsMany\` is INSERT OR IGNORE, and re-absorbing a later
 * sight would move first_seen_at forward — the pool's age signal).
 */
function absorbFirstWins(owed: Map<string, unknown>, args: readonly unknown[]): void {
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
  for (const record of list) {
    const key = deferredRecordKey(record);
    if (owed.has(key)) continue;
    owed.set(key, record);
  }
}

/**
 * Two raise records merged into one — MAX-WINS on both columns, which is
 * IDENTICAL to landing them in sequence: the statement is raise-only, so the
 * column ends at max(stored, a, b) either way. A finite liquidity reading (0
 * included — a corpse's \$0 LP is its signal) survives a later record that has
 * none.
 */
function mergeRaise(prev: unknown, next: unknown): Record<string, unknown> {
  const a = (prev ?? {}) as { token?: unknown; mcapUsd?: unknown; liquidityUsd?: unknown };
  const b = (next ?? {}) as { token?: unknown; mcapUsd?: unknown; liquidityUsd?: unknown };
  const mcap = Math.max(Number(a.mcapUsd) || 0, Number(b.mcapUsd) || 0);
  const la =
    typeof a.liquidityUsd === "number" && Number.isFinite(a.liquidityUsd)
      ? a.liquidityUsd
      : undefined;
  const lb =
    typeof b.liquidityUsd === "number" && Number.isFinite(b.liquidityUsd)
      ? b.liquidityUsd
      : undefined;
  const liquidityUsd = la === undefined ? lb : lb === undefined ? la : Math.max(la, lb);
  const merged: Record<string, unknown> = {
    token: typeof a.token === "string" && a.token.length > 0 ? a.token : b.token,
    mcapUsd: mcap,
  };
  if (liquidityUsd !== undefined) merged.liquidityUsd = liquidityUsd;
  return merged;
}

/** Raise-only bookkeeping absorbs MAX-WINS (see mergeRaise). */
function absorbMaxWins(owed: Map<string, unknown>, args: readonly unknown[]): void {
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
  for (const record of list) {
    const key = deferredRecordKey(record);
    const prev = owed.get(key);
    owed.set(key, prev === undefined ? record : mergeRaise(prev, record));
  }
}

/**
 * The bucket for one (method, handle) pair, opened on first use: a rebuilt Db
 * handle (the worker's dead-tick rebuild) gets its own, so a record never rides
 * a handle that is no longer the one the scanner writes through.
 */
function bucketFor(
  name: string,
  rank: number,
  call: (...args: unknown[]) => Promise<unknown>,
  absorb: (owed: Map<string, unknown>, args: readonly unknown[]) => void,
): DeferredBucket {
  for (const bucket of buckets) {
    if (bucket.name === name && bucket.call === call) return bucket;
  }
  const owed = new Map<string, unknown>();
  const bucket: DeferredBucket = {
    name,
    rank,
    call,
    owed,
    absorb: (args) => absorb(owed, args),
    attempts: 0,
  };
  buckets.push(bucket);
  return bucket;
}

/**
 * Land what one bucket owes: up to DEFERRED_COALESCE_MAX_PER_CALL records in
 * ONE call. Only the records that actually landed leave the bucket, so a failed
 * call re-offers its whole slice to the next drain — the container's "an entry
 * leaves the queue only once it has landed", now per record.
 */
async function runBucket(bucket: DeferredBucket): Promise<void> {
  const keys: string[] = [];
  const payload: unknown[] = [];
  for (const [key, record] of bucket.owed) {
    keys.push(key);
    payload.push(record);
    if (payload.length >= DEFERRED_COALESCE_MAX_PER_CALL) break;
  }
  const at = dbClock();
  try {
    await bucket.call(payload);
  } finally {
    // Timed where it REALLY ran, exactly like every other censused call.
    noteStep(bucket.name, dbClock() - at);
  }
  for (const key of keys) bucket.owed.delete(key);
}`;

patch("queue decl → coalescing buckets", OLD_QUEUE_DECL, NEW_QUEUE_DECL);

// ---------------------------------------------------------------------------
// 2. The bound on one coalesced call, next to the attempt bound.
// ---------------------------------------------------------------------------
patch(
  "the per-call cap constant",
  `export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;`,
  `export const DEFERRED_WRITE_MAX_ATTEMPTS = 3;

/**
 * Records one coalesced call may carry (see DeferredBucket). The payload is a
 * multi-row statement, so the cap bounds its size: one tick's registration is
 * ~23-30 feed profiles and its raises are the pool slice, i.e. 40 keeps a
 * catch-up at the worst case a single tick ALREADY wrote before coalescing,
 * while a long backlog drains in bounded chunks (what did not fit stays owed).
 */
export const DEFERRED_COALESCE_MAX_PER_CALL = 40;`,
);

// ---------------------------------------------------------------------------
// 3. The drain walks buckets instead of entries.
// ---------------------------------------------------------------------------
patch(
  "drain: empty-bucket branch",
  `    if (queue.length === 0) {
      // Nothing was queued: report the empty batch without erasing the last
      // real drain's stamp, so a reader can tell "nothing to do" from "never
      // drained".
      drain = { ...drain, calls: 0, ms: 0, failures: 0, pending: 0, heldForTracker: 0 };`,
  `    if (owedRecordCount() === 0) {
      // Nothing was queued: report the empty batch without erasing the last
      // real drain's stamp, so a reader can tell "nothing to do" from "never
      // drained".
      drain = {
        ...drain,
        calls: 0,
        ms: 0,
        failures: 0,
        pending: 0,
        owedTokens: 0,
        heldForTracker: 0,
      };`,
);

patch(
  "drain: the bucket loop",
  `    while (queue.length > 0) {
      // The tracker pass runs BEHIND this drain in the same invocation (the
      // worker fires the drain from onTickEnd and calls runTrackerPass in its
      // tail), and it is the stage that both needs the most round trips and has
      // no reservation of its own — it defers by name instead. So the drain
      // yields: a held entry is not lost, it just waits (see the queue's own
      // "an entry leaves it only once it has landed").
      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {
        heldForTracker = queue.length;
        break;
      }
      const call = queue[0];
      calls += 1;
      try {
        await call.run();
        queue.shift();
      } catch (err) {
        failures += 1;
        call.attempts += 1;
        const message = err instanceof Error ? err.message : err;
        lastError = {
          method: call.name,
          name: err instanceof Error ? err.name : "Error",
          message: typeof message === "string" ? message : String(message),
          at: dbClock(),
        };
        if (call.attempts >= DEFERRED_WRITE_MAX_ATTEMPTS) {
          queue.shift();
          console.error(
            \`[tickprobe] deferred \${call.name} failed \${call.attempts}x — dropping it:\`,
            message,
          );
        } else {
          console.error(
            \`[tickprobe] deferred \${call.name} failed (attempt \${call.attempts}/\${DEFERRED_WRITE_MAX_ATTEMPTS}) — kept for the next drain:\`,
            message,
          );
        }
        // Stop the batch here: the database is what just failed, so another
        // round trip would only burn what is left of this invocation.
        break;
      }
    }`,
  `    // One round trip per BUCKET, not per record (see DeferredBucket): the
    // backlog is measured in records (\`owedTokens\`) but paid for in calls.
    const ready = owedBuckets();
    while (ready.length > 0) {
      // The tracker pass runs BEHIND this drain in the same invocation (the
      // worker fires the drain from onTickEnd and calls runTrackerPass in its
      // tail), and it is the stage that both needs the most round trips and has
      // no reservation of its own — it defers by name instead. So the drain
      // yields: a held bucket is not lost, it just waits (see the queue's own
      // "an entry leaves it only once it has landed").
      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {
        heldForTracker = ready.length;
        break;
      }
      const bucket = ready.shift();
      if (!bucket) break;
      calls += 1;
      try {
        await runBucket(bucket);
      } catch (err) {
        failures += 1;
        bucket.attempts += 1;
        const message = err instanceof Error ? err.message : err;
        lastError = {
          method: bucket.name,
          name: err instanceof Error ? err.name : "Error",
          message: typeof message === "string" ? message : String(message),
          at: dbClock(),
        };
        const owed = bucket.owed.size;
        if (bucket.attempts >= DEFERRED_WRITE_MAX_ATTEMPTS) {
          bucket.owed.clear();
          console.error(
            \`[tickprobe] deferred \${bucket.name} failed \${bucket.attempts}x — dropping \${owed} record(s):\`,
            message,
          );
        } else {
          console.error(
            \`[tickprobe] deferred \${bucket.name} failed (attempt \${bucket.attempts}/\${DEFERRED_WRITE_MAX_ATTEMPTS}) — \${owed} record(s) kept for the next drain:\`,
            message,
          );
        }
        // Stop the batch here: the database is what just failed, so another
        // round trip would only burn what is left of this invocation.
        break;
      }
    }`,
);

patch(
  "drain: the view it reports",
  `    pending: queue.length,
    heldForTracker,
    totals: {`,
  `    pending: owedBuckets().length,
    owedTokens: owedRecordCount(),
    heldForTracker,
    totals: {`,
);

patch(
  "drain: the durable failure record",
  `  if (lastError !== null) {
    await persistDrainError(lastError, queue.length);`,
  `  if (lastError !== null) {
    await persistDrainError(lastError, owedBuckets().length, owedRecordCount());`,
);

// ---------------------------------------------------------------------------
// 4. The view's fields, the writer's signature, and the counter.
// ---------------------------------------------------------------------------
patch(
  "WriteDrainView.owedTokens",
  `  pending: number;
  /**
   * Entries this drain did NOT touch because the tracker pass behind it still
   * needed the invocation's subrequest allowance (see DRAIN_TRACKER_RESERVE).`,
  `  pending: number;
  /**
   * RECORDS still owed behind those calls — the backlog, which \`pending\` cannot
   * express any more: the queue coalesces per token (see DeferredBucket), so one
   * owed call can carry dozens of records and \`pending\` stays 0-2 whatever the
   * backlog is. THIS is the number that used to grow without bound (live
   * 2026-09-27: 12 → 31 in eleven minutes) and the one that says how far the
   * token_stats bookkeeping is behind.
   */
  owedTokens: number;
  /**
   * Entries this drain did NOT touch because the tracker pass behind it still
   * needed the invocation's subrequest allowance (see DRAIN_TRACKER_RESERVE).`,
);

patch(
  "drain literal gains owedTokens",
  `let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
  heldForTracker: 0,`,
  `let drain: WriteDrainView = {
  calls: 0,
  ms: 0,
  at: 0,
  failures: 0,
  lastError: null,
  pending: 0,
  owedTokens: 0,
  heldForTracker: 0,`,
);

patch(
  "WriteDrainErrorRecord gains owedTokens",
  `export type WriteDrainErrorRecord = NonNullable<WriteDrainView["lastError"]> & {
  pending: number;
};`,
  `export type WriteDrainErrorRecord = NonNullable<WriteDrainView["lastError"]> & {
  pending: number;
  /**
   * Records the failure stalled (see WriteDrainView.owedTokens) — the backlog
   * the reader needs, since \`pending\` counts coalesced CALLS and is 0-2.
   * Optional because a record written before 2026-09-27 does not carry it.
   */
  owedTokens?: number;
};`,
);

patch(
  "persistDrainError carries the backlog",
  `async function persistDrainError(
  error: NonNullable<WriteDrainView["lastError"]>,
  pending: number,
): Promise<void> {
  if (stateWriter === null) return;
  try {
    await stateWriter(WRITE_DRAIN_ERROR_KEY, JSON.stringify({ ...error, pending }));`,
  `async function persistDrainError(
  error: NonNullable<WriteDrainView["lastError"]>,
  pending: number,
  owedTokens: number,
): Promise<void> {
  if (stateWriter === null) return;
  try {
    await stateWriter(
      WRITE_DRAIN_ERROR_KEY,
      JSON.stringify({ ...error, pending, owedTokens }),
    );`,
);

patch(
  "deferredWriteCount = records owed",
  `/** How many deferred writes are still waiting (0 = nothing queued). */
export function deferredWriteCount(): number {
  return queue.length;
}`,
  `/**
 * How many deferred RECORDS are still waiting (0 = nothing queued). Records,
 * not calls: the queue coalesces per token (see DeferredBucket), so this is the
 * backlog a reader means by "how much bookkeeping is behind" — the number of
 * owed CALLS is \`writeDrainView().pending\`.
 */
export function deferredWriteCount(): number {
  return owedRecordCount();
}`,
);

// ---------------------------------------------------------------------------
// 5. installTickProbe's deferral rules.
// ---------------------------------------------------------------------------
patch(
  "wrapDb's deferral rules",
  `  // Writes: registration + raise-only bookkeeping, neither read by the gates.
  wrapDbMethod(target, "recordTokenStatsMany", deferWrites);
  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites);`,
  `  // Writes: registration + raise-only bookkeeping, neither read by the gates.
  // The merge rules are the two coalescing absorbs (see DeferredBucket), and
  // the ranks fix the order they LAND in: a registration must exist before a
  // raise for the same token can match it.
  wrapDbMethod(target, "recordTokenStatsMany", deferWrites, absorbFirstWins, 0);
  wrapDbMethod(target, "updateTokenMaxMcaps", deferWrites, absorbMaxWins, 1);`,
);

patch(
  "wrapDbMethod takes the absorb rule",
  `function wrapDbMethod(
  target: Record<string, unknown>,
  name: string,
  defer: boolean,
): void {`,
  `function wrapDbMethod(
  target: Record<string, unknown>,
  name: string,
  defer: boolean,
  /**
   * The coalescing rule for a deferred call (see DeferredBucket). REQUIRED when
   * \`defer\` is on: the probe refuses to defer a call it cannot merge by token,
   * because the un-coalesced queue is what grew without bound.
   */
  absorb?: (owed: Map<string, unknown>, args: readonly unknown[]) => void,
  rank = 0,
): void {`,
);

patch(
  "wrapDbMethod: deferral branch queues into the bucket",
  `    queue.push({
      name,
      attempts: 0,
      run: async () => {
        const at = dbClock();
        try {
          return await call.apply(target, args);
        } finally {
          noteStep(label, dbClock() - at);
        }
      },
    });
    return Promise.resolve();`,
  `    // Deferred: the scanner keeps its already-resolved promise, the record
    // goes into this method's bucket, and the drain lands it (see
    // drainDeferredWrites / runBucket — the timing note is taken there, where
    // the call REALLY runs).
    bucketFor(name, rank, call, absorb).absorb(args);
    return Promise.resolve();`,
);

patch(
  "wrapDbMethod: the guard covers the rule",
  `    const label = dbStepLabel(name, args);
    if (!defer || !tickActive) {`,
  `    const label = dbStepLabel(name, args);
    if (!defer || !tickActive || !absorb) {`,
);

patch(
  "header: the queue is no longer per-call FIFO",
  ` * is handed an already-resolved promise, the real call is queued FIFO, and the
 * worker drains the queue AFTER its completion flush (see the worker's`,
  ` * is handed an already-resolved promise, the real call is queued (FIFO across
 * methods, coalesced per token since 2026-09-27 — see DeferredBucket), and the
 * worker drains the queue AFTER its completion flush (see the worker's`,
);

// ---------------------------------------------------------------------------
// 6. resetTickProbe clears the buckets.
// ---------------------------------------------------------------------------
patch(
  "resetTickProbe clears the buckets",
  `  stamps = [];
  queue = [];`,
  `  stamps = [];
  buckets = [];
  opaqueRecords = 0;`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
