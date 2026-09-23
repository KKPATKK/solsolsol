#!/usr/bin/env node
/**
 * One-shot applier: make the row loop's SILENT half cost ONE round trip for the
 * whole head instead of one per row (docs/round-trips.md §4.2's "下一步").
 *
 * WHY: the tracker pass's coverage is its trip count. Live 2026-09-23 the note
 * read `rows 5/30 pairs 10/10 spend[setup … rows 1388/5 …] trips 9` — five rows
 * a minute, one ~150-400ms store round trip each — while ~90% of the rows a pass
 * touches have nothing to announce. The silent path already carried its CAS and
 * its check fields in ONE statement (`claimPushWatchCheck`); what it did not do
 * was share that statement with the rest of the head. Now the loop QUEUES the
 * silent rows and writes them with one batched request
 * (`Db.claimPushWatchChecksMany`), each statement byte-for-byte the CAS the
 * per-row path sent.
 *
 * SEMANTICS THAT DO NOT MOVE: the compare-and-swap on `last_checked` (a lost
 * race still skips the row and counts as `lost`), the fields written per row,
 * the atomicity per row (claim + fields in one statement), the pair-miss path
 * (those rows have no claim at all), and the ALERTING path (claim → reserve →
 * send → final write, untouched: a card's reservation must still land before its
 * send). What changes is that a silent row no longer needs its own trip, so a
 * pass's coverage stops being a function of how slow Turso is.
 *
 * WHY A SCRIPT: `src/pushwatch.ts` and `scripts/test-unit.js` are far beyond the
 * file tools' sync window (everything past ~line 1240 of the former answers
 * "old string not found"), so the deep edits are applied here. Every replacement
 * must match EXACTLY ONCE or the whole run aborts with a non-zero exit, so a
 * half-applied change is impossible.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";
const DB = "src/db.ts";

const fail = (msg) => {
  throw new Error(msg);
};

/** @type {Array<{file: string, name: string, old: string, new: string}>} */
const EDITS = [];
const edit = (file, name, old, next) => EDITS.push({ file, name, old, new: next });

// ---------------------------------------------------------------------------
// src/db.ts — the batched claim+write
// ---------------------------------------------------------------------------

edit(
  DB,
  "db: claimPushWatchChecksMany",
  `        args: [u.holders, u.holders, u.at, u.token],
      })),
      "write",
    );
  }
`,
  `        args: [u.holders, u.holders, u.at, u.token],
      })),
      "write",
    );
  }

  /**
   * The row loop's SILENT half in ONE round trip: claim AND record N rows at
   * once (see PushWatcher.runTick).
   *
   * Every statement is exactly the compare-and-swap \`claimPushWatchCheck\` sends
   * today — \`SET <check fields>, last_checked = ?\` guarded by
   * \`last_checked = ?\` — so the cross-isolate exclusion, the per-row atomicity
   * and the field set are unchanged. What changes is the COUNT: a pass pays one
   * subrequest for the whole head instead of one round trip per observed row.
   * That was the row loop's cost (live 2026-09-23: \`rows 5/30 spend[…] trips 9\`,
   * a ~150-400ms store trip per row) while ~90% of the rows a pass touches have
   * nothing to announce — which is why a pass covered a handful of rows a minute
   * instead of its whole head.
   *
   * Result order follows statement order — the same contract the recap claims
   * rely on — so the caller's \`won[i]\` belongs to \`updates[i]\`: false means
   * another isolate claimed that row first, precisely what the per-row call
   * reported.
   */
  async claimPushWatchChecksMany(
    updates: Array<{
      token: string;
      expectedLastChecked: number;
      now: number;
      v: PushWatchCheckValues;
    }>,
  ): Promise<boolean[]> {
    if (updates.length === 0) return [];
    const res = await this.get().batch(
      updates.map((u) => {
        const set = this.pushWatchCheckSet(u.v, u.now);
        return {
          sql: \`UPDATE push_watch SET \${set.sql}
            WHERE token = ? AND last_checked = ?\`,
          args: [...set.args, u.token, u.expectedLastChecked],
        };
      }),
      "write",
    );
    return res.map((r) => Number(r.rowsAffected ?? 0) > 0);
  }
`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 1. the queue
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: the silent queue is declared with the loop",
  `    let firstRow = true;
    const rowsStart = Date.now();`,
  `    /**
     * Silent rows, QUEUED instead of written one at a time.
     *
     * The loop used to send one \`claimPushWatchCheck\` per observed row — the CAS
     * that proves this isolate owns the row plus that row's check fields, in one
     * statement. That statement is not the problem; paying it N times is, because
     * the pass's allowance is measured in round trips (live 2026-09-23:
     * \`rows 5/30 … spend[rows 1388/5] trips 9\`). So the rows are collected here
     * and the whole queue is sent as ONE batched request after the loop (see
     * Db.claimPushWatchChecksMany), where each statement is still the same CAS.
     */
    const silentChecks: Array<{
      token: string;
      expectedLastChecked: number;
      backfill: boolean;
      v: Parameters<Db["claimPushWatchChecksMany"]>[0][number]["v"];
    }> = [];
    let firstRow = true;
    const rowsStart = Date.now();`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 2. the silent path queues
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: the silent path queues instead of writing",
  `      // SILENT ROW — nothing to announce (or a backfill, whose cards are
      // deliberately suppressed): the claim and the check write are ONE round
      // trip. The claim's compare-and-swap on last_checked is the same
      // cross-isolate exclusion in one statement, and a lost race still skips
      // the row entirely. This is the pass's throughput: ~90% of the rows a
      // pass touches have nothing to say, and they used to cost two store
      // round trips each out of an allowance that fits only a handful.
      if (backfill || evalResult.alerts.length === 0) {
        trips += 1;
        if (
          !(await this.db.claimPushWatchCheck(
            row.token,
            row.lastChecked,
            now,
            checkFields(false),
          ))
        ) {
          claimLost += 1;
          continue;
        }
        checked += 1;
        if (backfill) backfilled += 1;
        continue;
      }`,
  `      // SILENT ROW — nothing to announce (or a backfill, whose cards are
      // deliberately suppressed). The row is QUEUED, not written: the whole queue
      // goes out as ONE batched request after the loop (see silentChecks and
      // Db.claimPushWatchChecksMany). This is the pass's throughput — ~90% of the
      // rows a pass touches have nothing to say — and it used to cost one round
      // trip each out of an allowance that fits only a handful, which is why the
      // rotation covered five rows a minute.
      if (backfill || evalResult.alerts.length === 0) {
        silentChecks.push({
          token: row.token,
          expectedLastChecked: row.lastChecked,
          backfill,
          v: checkFields(false),
        });
        continue;
      }`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 3. the batch write closes the row loop
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: one batched claim+write for the whole silent queue",
  `    spent.rows.ms = Date.now() - rowsStart;
    spent.rows.trips = trips - rowsTrips;`,
  `    // The silent half of the loop, in ONE round trip (see silentChecks). Each
    // statement is the CAS the per-row path sent, and the queue is written even
    // when the loop cut short: those rows were already evaluated, and one trip is
    // cheaper than the single write the first of them would have cost on its own.
    // A rejected batch writes nothing — every queued row stays unclaimed with its
    // place at the front of the rotation, the same state the per-row path reached
    // when its own write failed — and an empty queue costs nothing at all.
    if (silentChecks.length > 0) {
      trips += 1;
      let won: boolean[] = silentChecks.map(() => false);
      try {
        won = await this.db.claimPushWatchChecksMany(silentChecks);
      } catch (err) {
        console.error(
          "[push-watch] silent-row batch failed:",
          err instanceof Error ? err.message : err,
        );
      }
      silentChecks.forEach((s, i) => {
        if (!won[i]) {
          claimLost += 1;
          return;
        }
        checked += 1;
        if (s.backfill) backfilled += 1;
      });
    }
    spent.rows.ms = Date.now() - rowsStart;
    spent.rows.trips = trips - rowsTrips;`,
);

// ---------------------------------------------------------------------------
// scripts/test-unit.js — the doubles gain the batch (mirroring what they did
// per row), and the two tests that pinned the old per-row pricing move to the
// new shape.
// ---------------------------------------------------------------------------

edit(
  TU,
  "tu: termDb gains the batched silent writer",
  `      claimPushWatch: async () => true,
      claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },
      reservePushWatchAlert: async () => true,`,
  `      claimPushWatch: async () => true,
      claimPushWatchChecksMany: async (rows) => {
        for (const r of rows) updated.push([r.token, r.v]);
        return rows.map(() => true);
      },
      claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },
      reservePushWatchAlert: async () => true,`,
);

edit(
  TU,
  "tu: heal double gains the batched silent writer",
  `        getInitialPushAuditTokens: async () => new Set([token]),
        getWorkerState: async () => ledgerValue,
        upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
        recordPushDelivery: async (entry) => { audits.push(entry); },
        claimPushWatch: async () => true,
        claimPushWatchCheck: async () => true,`,
  `        getInitialPushAuditTokens: async () => new Set([token]),
        getWorkerState: async () => ledgerValue,
        upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
        recordPushDelivery: async (entry) => { audits.push(entry); },
        claimPushWatch: async () => true,
        claimPushWatchChecksMany: async (rows) => rows.map(() => true),
        claimPushWatchCheck: async () => true,`,
);

edit(
  TU,
  "tu: second heal double gains the batched silent writer",
  `      getInitialPushAuditTokens: async () => new Set(tokens),
      getWorkerState: async () => ledgerValue,
      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
      claimPushWatch: async () => true,
      claimPushWatchCheck: async () => true,`,
  `      getInitialPushAuditTokens: async () => new Set(tokens),
      getWorkerState: async () => ledgerValue,
      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
      claimPushWatch: async () => true,
      claimPushWatchChecksMany: async (rows) => rows.map(() => true),
      claimPushWatchCheck: async () => true,`,
);

edit(
  TU,
  "tu: recap double gains the batched silent writer",
  `      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => true), pruned: 1 }),
      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),
      claimPushWatch: async () => true,
      claimPushWatchCheck: async () => true,`,
  `      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => true), pruned: 1 }),
      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),
      claimPushWatch: async () => true,
      claimPushWatchChecksMany: async (rows) => rows.map(() => true),
      claimPushWatchCheck: async () => true,`,
);

edit(
  TU,
  "tu: trip-counting double gains the batched silent writer",
  `      claimPushWatch: async () => { calls.total += 1; return true; },
      claimPushWatchCheck: async (token, _expected, _now, v) => {
        calls.total += 1;
        calls.updated.push([token, v]);
        return true;
      },`,
  `      claimPushWatch: async () => { calls.total += 1; return true; },
      claimPushWatchChecksMany: async (rows) => {
        calls.total += 1;
        for (const r of rows) calls.updated.push([r.token, r.v]);
        return rows.map(() => true);
      },
      claimPushWatchCheck: async (token, _expected, _now, v) => {
        calls.total += 1;
        calls.updated.push([token, v]);
        return true;
      },`,
);

edit(
  TU,
  "tu: counting double gains the batched silent writer",
  `      claimPushWatch: async () => { calls.total += 1; return true; },
      claimPushWatchCheck: async () => { calls.total += 1; return true; },`,
  `      claimPushWatch: async () => { calls.total += 1; return true; },
      claimPushWatchChecksMany: async (rows) => {
        calls.total += 1;
        return rows.map(() => true);
      },
      claimPushWatchCheck: async () => { calls.total += 1; return true; },`,
);

edit(
  TU,
  "tu: watchDb gains the batched silent writer",
  `    claimPushWatch: async () => true,
    // The silent row path claims AND writes in one round trip (see
    // Db.claimPushWatchCheck); the fake records it exactly like the two-step
    // write, so \`updated\` still names every row the pass observed.
    claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },`,
  `    claimPushWatch: async () => true,
    // The silent row path claims AND writes in ONE batched round trip for the
    // whole head (see Db.claimPushWatchChecksMany); the fake records every row
    // exactly like the per-row writer did, so \`updated\` still names every row
    // the pass observed.
    claimPushWatchChecksMany: async (rows) => {
      for (const r of rows) updated.push([r.token, r.v]);
      return rows.map(() => true);
    },
    claimPushWatchCheck: async (token, _expected, _now, v) => { updated.push([token, v]); return true; },`,
);

edit(
  TU,
  "tu: the holder starvation test spends the pass with the BATCH",
  `      // The row loop is the pass's clock (Turso round trips): 400ms per row
      // against a 2s allowance leaves the tail nothing at all.
      claimPushWatchCheck: async (token, _expected, _now, v) => {
        await new Promise((r) => setTimeout(r, 400));
        updated.push([token, v]);
        return true;
      },`,
  `      // The row loop is the pass's clock (Turso round trips): one batched trip
      // that costs the whole 2s allowance leaves the tail nothing at all.
      claimPushWatchChecksMany: async (rows) => {
        await new Promise((r) => setTimeout(r, 400 * rows.length));
        for (const r of rows) updated.push([r.token, r.v]);
        return rows.map(() => true);
      },`,
);

edit(
  TU,
  "tu: the silent-cost test now pins ONE trip for the whole head",
  `  await test("PushWatcher: a silent row claims and writes in ONE round trip, and only when it fits", async () => {
    // The loop spent TWO store round trips on every row it merely observed — a
    // separate claim, then the check write — and reserved a flat 900ms before
    // starting one, five times a silent row's true cost. Both are what capped
    // the pass at a single row per tick (live \`rows 1/29 ... budget-cut\` on
    // tick after tick) while ~90% of the rows a pass touches have nothing to
    // announce.
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const claims = [];
    const writes = [];
    const updated = [];
    const db = {
      ...watchDb(rows, updated),
      claimPushWatch: async (token) => { claims.push(token); return true; },
      claimPushWatchCheck: async (token) => {
        writes.push(token);
        await new Promise((r) => setTimeout(r, 500));
        return true;
      },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    // 1200ms budget, ~500ms per write: BOTH silent rows fit. The old shape
    // reserved a flat 900ms per row and stopped after the first (700ms left <
    // 900ms) — that cap, on ~90% silent rows, is what held the pass to one row
    // per tick and the 29-row rotation to tens of minutes.
    const out = await pw.runTick(Date.now() + 1_200);
    assert.equal(out.checked, 2, "both silent rows fit: one write each");
    assert.deepEqual(claims, [], "a silent row does not spend a separate claim");
    assert.deepEqual(writes, ["AAA", "BBB"], "one write per row");
    assert.equal(updated.length, 0, "the two-step writer is not used for a silent row");
    assert.ok(!/budget-cut/.test(String(out.note)), \`nothing may be cut: \${out.note}\`);
  });`,
  `  await test("PushWatcher: the whole head's silent claims and writes cost ONE trip", async () => {
    // The loop spent ONE store round trip on every row it merely observed
    // (~150-400ms live each), which capped the pass at a handful of rows a
    // minute (live \`rows 5/30 … spend[rows 1388/5] trips 9\`) while ~90% of the
    // rows a pass touches have nothing to announce. The silent half is now
    // queued and written as ONE batched request, so the same allowance covers
    // the whole head.
    const rows = [watchRow("AAA"), watchRow("BBB"), watchRow("CCC"), watchRow("DDD")];
    const claims = [];
    const batches = [];
    const updated = [];
    const db = {
      ...watchDb(rows, updated),
      claimPushWatch: async (token) => { claims.push(token); return true; },
      claimPushWatchCheck: async () => {
        throw new Error("the per-row silent writer must not be used any more");
      },
      claimPushWatchChecksMany: async (rows2) => {
        batches.push(rows2.map((u) => u.token));
        for (const u of rows2) updated.push([u.token, u.v]);
        return rows2.map(() => true);
      },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 2_000);
    assert.equal(out.checked, 4, "every silent row in the head is recorded");
    assert.deepEqual(batches, [["AAA", "BBB", "CCC", "DDD"]], "ONE batch for all four");
    assert.deepEqual(claims, [], "a silent row still spends no separate claim");
    assert.match(String(out.note), /rows \\d+\\/1/, \`the loop's whole cost is one trip: \${out.note}\`);
  });`,
);

edit(
  TU,
  "tu: the degraded-trip test moves to the batched shape",
  `  await test("PushWatcher: a degraded round trip stops the loop before it starts another row", async () => {
    // The loop's reserve is priced in the cost THIS pass is paying per round
    // trip (see TRACKER_ROW_LEASH_MS), not in healthy-Turso units: at ~900ms a
    // trip the old flat 300ms check was happy to start the second row, whose
    // first claim can then outlive the tick. Live 2026-09-23 03:10Z: a pass
    // started, checked ONE row, and sat at \`running\` for 55s while the other
    // 29 rows went unchecked and the tick's own tail never ran
    // (docs/duplicate-cards.md 14.1/14.6). A deferred row is not lost — it is
    // re-read and re-claimed next tick — so stopping early is the cheap side.
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const writes = [];
    const db = {
      ...watchDb(rows, []),
      claimPushWatch: async () => true,
      claimPushWatchCheck: async (token) => {
        writes.push(token);
        await new Promise((r) => setTimeout(r, 900)); // one degraded trip
        return true;
      },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    // 1500ms for a 900ms trip: the first row fits, and the second must NOT be
    // started — its own trip alone would land past the deadline.
    const out = await pw.runTick(Date.now() + 1_500);
    assert.equal(out.checked, 1, \`the second row is deferred, not started (checked \${out.checked})\`);
    assert.deepEqual(writes, ["AAA"], "only the row that fits is written");
    assert.match(String(out.note), /budget-cut/, \`the pass says why: \${out.note}\`);
    assert.equal(out.alerted, 0);
  });`,
  `  await test("PushWatcher: a degraded store is paid ONCE for the whole silent queue", async () => {
    // The per-row pricing this test used to pin (a flat reserve before starting
    // another row) belongs to the ALERTING path now, where a send really cannot
    // be cut in half. A silent row costs no trip of its own, so a degraded store
    // is paid once for the whole queue: the pass's coverage stops being a
    // function of how slow Turso is (the shape that held it to one row a tick,
    // live \`rows 1/29 … budget-cut\`, while 29 rows went unrefreshed).
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const batches = [];
    const db = {
      ...watchDb(rows, []),
      claimPushWatch: async () => true,
      claimPushWatchChecksMany: async (rows2) => {
        batches.push(rows2.map((u) => u.token));
        await new Promise((r) => setTimeout(r, 900)); // one degraded trip
        return rows2.map(() => true);
      },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    // 1500ms allowance, one 900ms degraded trip: both rows land inside it.
    const out = await pw.runTick(Date.now() + 1_500);
    assert.equal(batches.length, 1, "one degraded trip, not one per row");
    assert.deepEqual(batches[0], ["AAA", "BBB"]);
    assert.equal(out.checked, 2, \`both rows are recorded (checked \${out.checked})\`);
    assert.equal(out.alerted, 0);
  });`,
);

// ---------------------------------------------------------------------------

const files = [...new Set(EDITS.map((e) => e.file))];
const original = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const next = new Map(files.map((f) => [f, original.get(f)]));
let failures = 0;

for (const e of EDITS) {
  const text = next.get(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.file} :: ${e.name}`);
    failures += 1;
    continue;
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.file} :: ${e.name} (${e.old.length} bytes matched twice)`);
    failures += 1;
    continue;
  }
  next.set(e.file, text.slice(0, first) + e.new + text.slice(first + e.old.length));
  console.log(`ok        ${e.file} :: ${e.name}`);
}

if (failures > 0) {
  console.error(`\n${failures} edit(s) did not match — NOTHING was written.`);
  process.exit(1);
}

for (const f of files) {
  const before = original.get(f);
  const after = next.get(f);
  if (before === after) {
    console.log(`unchanged ${f}`);
    continue;
  }
  fs.writeFileSync(f, after);
  console.log(
    `wrote     ${f} (${Buffer.byteLength(before)} → ${Buffer.byteLength(after)} bytes)`,
  );
}
console.log(`\n${EDITS.length} edits applied cleanly.`);
