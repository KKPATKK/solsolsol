// Verify-then-write: the coalescing queue's tests.
const fs = require("fs");

const FILE = "scripts/test-unit.js";
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
// 1. The two source pins that named the old queue.
// ---------------------------------------------------------------------------
patch(
  "pin: which method threw",
  `      "probe (which method threw)": probeSrc.includes("method: call.name,"),
      "probe (the durable copy)": probeSrc.includes("persistDrainError(lastError, queue.length)"),`,
  `      "probe (which method threw)": probeSrc.includes("method: bucket.name,"),
      "probe (the durable copy)": probeSrc.includes(
        "persistDrainError(lastError, owedBuckets().length, owedRecordCount())",
      ),`,
);

// ---------------------------------------------------------------------------
// 2. The reserve test: calls vs records.
// ---------------------------------------------------------------------------
patch(
  "reserve test: records and calls",
  `    const landedOf = (db) => db.landed.length;
    resetTickProbe();
    const db = mkDb();
    // The fake records the writes it actually ran.
    db.recordTokenStatsMany = async (tokens) => { db.landed.push(tokens.length); };
    await runTick(db, 3);
    assert.equal(landedOf(db), 0, "a deferred write does not land inside the tick");
    assert.equal(deferredWriteCount(), 3, "it waits in the queue");

    // (a) With the allowance roomy, the drain lands the whole batch — the
    //     behaviour a healthy tick has always had.
    await drainDeferredWrites(() => 50);
    assert.equal(landedOf(db), 3);
    assert.equal(writeDrainView().pending, 0);
    assert.equal(writeDrainView().heldForTracker, 0, "nothing was held");`,
  `    const landedOf = (db) => db.landed.length;
    resetTickProbe();
    const db = mkDb();
    // The fake records WHAT each call carried, so coalescing is visible.
    db.recordTokenStatsMany = async (tokens) => { db.landed.push(tokens.slice()); };
    await runTick(db, 3);
    assert.equal(landedOf(db), 0, "a deferred write does not land inside the tick");
    assert.equal(deferredWriteCount(), 3, "three records wait");
    // The queue COALESCES (2026-09-27): three calls of one method are ONE round
    // trip carrying three records, so \`pending\` (calls) and \`owedTokens\`
    // (records) are different readings and the backlog is the second one.
    const queued = writeDrainView();
    assert.equal(queued.pending, 1, "one round trip is owed, not one per call");
    assert.equal(queued.owedTokens, 3, "carrying all three records");

    // (a) With the allowance roomy, the drain lands the whole batch in ONE call
    //     — the behaviour a healthy tick has always had, now in one round trip.
    await drainDeferredWrites(() => 50);
    assert.equal(landedOf(db), 1, "one coalesced call lands the batch");
    assert.deepEqual(db.landed[0], ["T0", "T1", "T2"], "carrying every record in call order");
    assert.equal(writeDrainView().pending, 0);
    assert.equal(writeDrainView().owedTokens, 0);
    assert.equal(writeDrainView().heldForTracker, 0, "nothing was held");`,
);

patch(
  "reserve test: the held reading",
  `    const held = writeDrainView();
    assert.equal(held.heldForTracker, 3, "the view names why the batch stopped");
    assert.equal(held.pending, 3, "the entries stay queued");
    assert.equal(held.failures, 0, "held is not failed");
    assert.equal(held.lastError, null, "and it is not a write-drain error");

    // (c) The next drain takes them once the allowance is back.
    await drainDeferredWrites(() => 40);
    assert.equal(landedOf(db), before + 3);
    assert.equal(writeDrainView().pending, 0);
    resetTickProbe();`,
  `    const held = writeDrainView();
    assert.equal(held.heldForTracker, 1, "the view names the CALL it held");
    assert.equal(held.pending, 1, "the call stays owed");
    assert.equal(held.owedTokens, 3, "with all three records behind it");
    assert.equal(held.failures, 0, "held is not failed");
    assert.equal(held.lastError, null, "and it is not a write-drain error");

    // (c) The next drain takes them once the allowance is back — still ONE call.
    await drainDeferredWrites(() => 40);
    assert.equal(landedOf(db), before + 1, "the catch-up is one round trip");
    assert.equal(db.landed[before].length, 3, "carrying all three records");
    assert.equal(writeDrainView().owedTokens, 0);
    resetTickProbe();`,
);

// ---------------------------------------------------------------------------
// 3. The new test: the merge rules themselves.
// ---------------------------------------------------------------------------
patch(
  "coalescing semantics test",
  `  await test("tickprobe: the census names what a tick's scan paid, per method", async () => {`,
  `  await test("tickprobe: the deferred queue coalesces per token", async () => {
    // WHY (2026-09-27): both deferred calls decide what to write from the STORED
    // value — the registration only writes a token the stats read did not
    // return, the raise only raises a maximum — so a write that has not landed
    // makes the SAME token look new again on the next tick and queues another
    // copy of it. Live: \`pending\` 12 → 31 in eleven minutes with every entry
    // \`heldForTracker\` (the drain never got room), i.e. the queue fed itself.
    // Coalescing bounds the backlog by DISTINCT tokens and makes a catch-up one
    // call per method.
    const {
      installTickProbe,
      drainDeferredWrites,
      resetTickProbe,
      writeDrainView,
      deferredWriteCount,
      DEFERRED_COALESCE_MAX_PER_CALL,
    } = require("../dist/tickprobe.js");
    const calls = [];
    const db = {
      recordTokenStatsMany: async (records) => {
        calls.push({ name: "register", tokens: records.map((r) => r.token) });
      },
      updateTokenMaxMcaps: async (records) => { calls.push({ name: "raise", records }); },
    };
    const tick = async (fn) => {
      const seam = { runOnce: async () => { await fn(); } };
      installTickProbe(seam, { db, deferWrites: true });
      await seam.runOnce();
    };
    resetTickProbe();

    await tick(async () => {
      await db.recordTokenStatsMany([
        { token: "A", firstSeenAt: 100 },
        { token: "B", firstSeenAt: 100 },
      ]);
      await db.updateTokenMaxMcaps([{ token: "A", mcapUsd: 5, liquidityUsd: 1000 }]);
    });
    await tick(async () => {
      await db.recordTokenStatsMany([{ token: "A", firstSeenAt: 900 }]);
      await db.updateTokenMaxMcaps([{ token: "A", mcapUsd: 9 }]);
    });
    assert.equal(deferredWriteCount(), 2, "two distinct tokens, not four records");
    const drained = await drainDeferredWrites(() => 50);
    assert.equal(drained.calls, 2, "one call per method, whatever the record count");
    assert.equal(drained.owedTokens, 0, "nothing left owed");
    assert.deepEqual(
      calls,
      [
        { name: "register", tokens: ["A", "B"] },
        {
          name: "raise",
          records: [{ token: "A", mcapUsd: 9, liquidityUsd: 1000 }],
        },
      ],
      "registration lands first and keeps the FIRST sight; the raise keeps the MAX on both columns (a finite liquidity survives a record without one)",
    );

    // The cap: a backlog longer than one call may carry drains in chunks, and
    // what did not fit stays owed.
    calls.length = 0;
    await tick(async () => {
      for (let i = 0; i < DEFERRED_COALESCE_MAX_PER_CALL + 3; i += 1) {
        await db.recordTokenStatsMany([{ token: \`C\${i}\`, firstSeenAt: 1 }]);
      }
    });
    assert.equal(
      writeDrainView().owedTokens,
      DEFERRED_COALESCE_MAX_PER_CALL + 3,
      "every record is owed",
    );
    const first = await drainDeferredWrites(() => 50);
    assert.equal(first.calls, 1, "one call");
    assert.equal(
      calls[0].tokens.length,
      DEFERRED_COALESCE_MAX_PER_CALL,
      "capped at what one statement may carry",
    );
    assert.equal(writeDrainView().owedTokens, 3, "the rest stays owed");
    await drainDeferredWrites(() => 50);
    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(writeDrainView().owedTokens, 0);

    // LANDING ORDER: a registration must beat the raise for the same token, or
    // the raise's UPDATE matches no row and the high-water mark is lost — so
    // the order is fixed by rank, not by which bucket was opened first.
    resetTickProbe();
    const order = [];
    const db2 = {
      recordTokenStatsMany: async () => { order.push("register"); },
      updateTokenMaxMcaps: async () => { order.push("raise"); },
    };
    const tick2 = async (fn) => {
      const seam = { runOnce: async () => { await fn(); } };
      installTickProbe(seam, { db: db2, deferWrites: true });
      await seam.runOnce();
    };
    await tick2(async () => { await db2.updateTokenMaxMcaps([{ token: "Z", mcapUsd: 3 }]); });
    await tick2(async () => { await db2.recordTokenStatsMany([{ token: "Z", firstSeenAt: 1 }]); });
    await drainDeferredWrites(() => 50);
    assert.deepEqual(
      order,
      ["register", "raise"],
      "the raise lands after the registration it depends on",
    );
    resetTickProbe();
  });

  await test("tickprobe: the census names what a tick's scan paid, per method", async () => {`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
