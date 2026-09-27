// Verify-then-write: finish the coalescing change (reset literal + honest docs).
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

patch(
  "resetTickProbe's drain literal",
  `  drainErrorPersisted = false;
  drain = {
    calls: 0,
    ms: 0,
    at: 0,
    failures: 0,
    lastError: null,
    pending: 0,
    heldForTracker: 0,`,
  `  drainErrorPersisted = false;
  drain = {
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
  "pending's own doc",
  `  /**
   * Calls still waiting after this drain (0 = the queue is empty). A failed
   * write is NOT dropped: it stays at the head of the queue and is retried by
   * the next drain, so \`failures > 0\` with \`pending > 0\` reads as "the last
   * tick's batch did not land yet", not "lost".
   */
  pending: number;`,
  `  /**
   * CALLS still waiting after this drain (0 = nothing owed). A failed call is
   * NOT dropped: its records stay in their bucket and are retried by the next
   * drain, so \`failures > 0\` with \`pending > 0\` reads as "the last tick's
   * batch did not land yet", not "lost". Bounded by the number of deferred
   * methods (one call per method, see DeferredBucket) — read \`owedTokens\` for
   * the backlog behind them.
   */
  pending: number;`,
);

patch(
  "the attempt bound's own doc",
  `/**
 * How many times one deferred write may fail before it is dropped. The calls
 * are idempotent (INSERT OR IGNORE / raise-only UPDATE), so retrying is free of
 * consequence; the bound exists so a database that is down for hours cannot
 * grow the in-memory queue without limit.
 */`,
  `/**
 * How many times a deferred BATCH may fail before its records are dropped. The
 * calls are idempotent (INSERT OR IGNORE / raise-only UPDATE), so retrying is
 * free of consequence; the bound exists so a database that is down for hours
 * cannot hold the same records forever (it counts FAILURES per bucket, and the
 * scanner re-issues whatever it still needs — see DeferredBucket).
 */`,
);

patch(
  "the reserve's history mentions the bucket",
  ` * BEFORE the tracker pass in that invocation's tail — and it walks its queue
 * with no ceiling at all: \`while (queue.length > 0)\`. Its cost is therefore
 * "however long the backlog is", and a 20-entry backlog is 20 Turso round trips`,
  ` * BEFORE the tracker pass in that invocation's tail — and it used to walk its
 * queue with no ceiling at all (an entry per call). Its cost was therefore
 * "however long the backlog is", and a 20-entry backlog is 20 Turso round trips`,
);

patch(
  "the lastError doc's queue entry",
  `   * WHY THE METHOD, not just the text: both deferred methods write the SAME
   * table through the same client, so "turso 522" alone does not say whether
   * the registration INSERT or the max-mcap UPDATE is the one that cannot
   * land — and those two have different fixes (batch size vs. a raise-only
   * statement). The name is the queue entry's own, i.e. the real Db method.`,
  `   * WHY THE METHOD, not just the text: both deferred methods write the SAME
   * table through the same client, so "turso 522" alone does not say whether
   * the registration INSERT or the max-mcap UPDATE is the one that cannot
   * land — and those two have different fixes (batch size vs. a raise-only
   * statement). The name is the failing bucket's own, i.e. the real Db method.`,
);

patch(
  "the 'one entry leaves' doc",
  ` * reject). The queue now owns the retry — an entry leaves it only once it has
 * landed — so a cancelled drain costs one tick of latency instead of a
 * permanent gap in token_stats (see drainDeferredWrites).`,
  ` * reject). The queue now owns the retry — a record leaves it only once it has
 * landed — so a cancelled drain costs one tick of latency instead of a
 * permanent gap in token_stats (see drainDeferredWrites).`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
