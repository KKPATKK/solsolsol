#!/usr/bin/env node
/**
 * One-shot applier: wire the tracker pass's consumer side onto the batched Db
 * methods added for the 50-subrequest budget (Workers Free counts every Turso
 * HTTP request as a subrequest), and move its unit-test fakes to the same
 * shape.
 *
 * WHY A SCRIPT: `src/pushwatch.ts` and `scripts/test-unit.js` are both far
 * beyond the ~50KB edit window the file tools can reach (everything past
 * ~line 1000 answers "old string not found"), so the deep edits are applied
 * here, in two phases: every replacement must match EXACTLY ONCE before
 * anything is written, and any mismatch aborts the whole run with a non-zero
 * exit code. Nothing is written on a partial match.
 *
 * What it changes (src/pushwatch.ts):
 *   1. recap claims + prune  → ONE batch (Db.claimRecapsAndPrune)
 *   2. heal untracked list + ledger row → ONE batch (Db.findUntrackedPushesAndLedger)
 *   3. holder writes         → ONE batch after the loop (Db.setPushWatchHoldersMany)
 *
 * What it changes (scripts/test-unit.js): the fakes gain those three methods
 * (counting one round trip each, exactly like the pass counts them) and the
 * assertions that named the old per-call shape move with them.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

/** @type {Array<{file: string, name: string, old: string, new: string}>} */
const EDITS = [];

const edit = (file, name, old, next) => EDITS.push({ file, name, old, new: next });

// ---------------------------------------------------------------------------
// src/pushwatch.ts
// ---------------------------------------------------------------------------

// 1. recap claims: the DELETE now rides the same batch.
edit(
  PW,
  "pw: recap claims ride the prune batch",
  `      // Claims FIRST, in ONE batched round trip, then the cards: the
      // claim-before-send guarantee is unchanged (a batch is one request,
      // executed in order), but N expiring rows now cost 1 trip instead of N.
      let won: boolean[];
      try {
        won = await this.db.markRecapClaimedMany(expiring.map((r) => r.token));
        trips += 1;
      } catch {
        won = expiring.map(() => false); // best-effort: no card without a claim
      }`,
  `      // Claims FIRST, in the SAME batched round trip as the prune that
      // follows them, then the cards: the claim-before-send guarantee is
      // unchanged (a batch is one request, executed in statement order), but N
      // expiring rows plus the bulk DELETE now cost 1 subrequest instead of
      // N+1 — on an invocation whose real budget is Workers Free's 50
      // subrequests (Turso's HTTP transport counts one per statement batch),
      // that is the difference between this stage and a whole tick.
      let won: boolean[] = expiring.map(() => false);
      try {
        const claimed = await this.db.claimRecapsAndPrune(
          expiring.map((r) => r.token),
          windowCutoff,
        );
        won = claimed.won;
        trips += 1;
      } catch {
        /* best-effort: no card without a claim */
      }`,
);

// 2. the standalone prune: only the passes with nothing to claim.
edit(
  PW,
  "pw: standalone prune only when nothing was claimed",
  `    // The prune deletes exactly the rows past the window. When the listing was
    // COMPLETE (fewer rows than the limit, so nothing sat outside it) and held
    // no such row, the DELETE provably matches nothing — skip the round trip.
    const listingComplete = snapshot !== null && snapshot.length < cfg.maxTracked;
    const pruneNeeded =
      !listingComplete || (snapshot ?? []).some((r) => r.pushedAt < windowCutoff);
    if (pruneNeeded) {
      await this.db.prunePushWatch(windowCutoff);
      trips += 1;
    }`,
  `    // The prune deletes exactly the rows past the window, and whenever a row
    // was claimed above it rode that very batch (claimRecapsAndPrune deletes
    // exactly the rows past the window). This arm is left for the passes with
    // NOTHING to claim — a listing that failed, or an unwatched-only tail —
    // and even then a COMPLETE listing holding no past-window row still skips
    // the round trip outright.
    const listingComplete = snapshot !== null && snapshot.length < cfg.maxTracked;
    const pruneNeeded =
      !listingComplete || (snapshot ?? []).some((r) => r.pushedAt < windowCutoff);
    if (pruneNeeded && expiring.length === 0) {
      await this.db.prunePushWatch(windowCutoff);
      trips += 1;
    }`,
);

// 3. the heal's opening reads: untracked list + ledger row in one batch.
edit(
  PW,
  "pw: heal reads the ledger with the untracked list",
  `      }> = [];
      if (!healSkipped) {
        trips += 1;
        missing = await this.db.findUntrackedPushes(
          now - cfg.windowHours * 3_600_000,
          10,
        );
        healMissing = missing.length;
      }`,
  `      }> = [];
      /**
       * The heal's push-baseline ledger row, read in the SAME batched round
       * trip as the untracked list (see findUntrackedPushesAndLedger): it used
       * to be a SECOND subrequest out of the invocation's 50, paid only once
       * something was missing — which is exactly when the pass is closest to
       * its budget cut.
       */
      let ledgerRaw: string | null = null;
      if (!healSkipped) {
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
);

// 4. the ledger parse: no round trip of its own any more.
edit(
  PW,
  "pw: ledger parsed from the batched read",
  `        const ledger = parsePushLedger(
          await this.db.getWorkerState(PUSH_LEDGER_STATE_KEY),
        );
        trips += 1;`,
  `        // (read with the untracked list above — ONE round trip for both, see
        // findUntrackedPushesAndLedger)
        const ledger = parsePushLedger(ledgerRaw);`,
);

// 5. holder stage: collect the counts, write them in ONE batch.
edit(
  PW,
  "pw: holder writes collected for one batch",
  `      const due = head.filter((r) => !parked(r));
      holdersHeld = head.length - due.length;
      for (let i = 0; i < due.length; i++) {`,
  `      const due = head.filter((r) => !parked(r));
      holdersHeld = head.length - due.length;
      // Holder counts proven this pass, written in ONE batch after the loop
      // (see setPushWatchHoldersMany): N probed rows used to cost N subrequests
      // on an invocation whose budget is 50.
      const holderWrites: Array<{ token: string; holders: number; at: number }> =
        [];
      for (let i = 0; i < due.length; i++) {`,
);

edit(
  PW,
  "pw: holder probe collects, batch flushes after the loop",
  `        let wrote = false;
        try {
          const overview = await this.bounded(
            this.birdeye.getTokenOverview(r.token),
            TRACKER_HOLDER_CAP_MS,
            null,
          );
          if (overview && overview.holderCount !== null) {
            trips += 1;
            await this.db.setPushWatchHolders(r.token, overview.holderCount, now);
            wrote = true;
          }
        } catch (err) {
          console.error(
            "[push-watch] holder refresh failed:",
            err instanceof Error ? err.message : err,
          );
        }
        // Only a probe that WROTE a count clears the park: a timeout, a
        // malformed body and a throw all mean "no holder data this time".
        if (wrote) this.holdersFailedAt.delete(r.token);
        else this.holdersFailedAt.set(r.token, Date.now());
      }
    }`,
  `        // The WRITE is deferred to the one batch after the loop (see
        // setPushWatchHoldersMany): the probe, its cap and the park rule are
        // unchanged — a probe that returned no count parks its row right here,
        // and a rejected batch parks every row it covered below.
        let probed = false;
        try {
          const overview = await this.bounded(
            this.birdeye.getTokenOverview(r.token),
            TRACKER_HOLDER_CAP_MS,
            null,
          );
          if (overview && overview.holderCount !== null) {
            holderWrites.push({
              token: r.token,
              holders: overview.holderCount,
              at: now,
            });
            probed = true;
          }
        } catch (err) {
          console.error(
            "[push-watch] holder refresh failed:",
            err instanceof Error ? err.message : err,
          );
        }
        // Only a probe that WROTE a count clears the park: a timeout, a
        // malformed body and a throw all mean "no holder data this time".
        if (!probed) this.holdersFailedAt.set(r.token, Date.now());
      }
      if (holderWrites.length > 0) {
        // The whole stage in ONE round trip (N before this).
        trips += 1;
        try {
          await this.db.setPushWatchHoldersMany(holderWrites);
          for (const w of holderWrites) this.holdersFailedAt.delete(w.token);
        } catch (err) {
          console.error(
            "[push-watch] holder batch write failed:",
            err instanceof Error ? err.message : err,
          );
          // A rejected batch wrote NOTHING: park every row it covered, the
          // same state a row whose own write failed used to reach.
          for (const w of holderWrites) {
            this.holdersFailedAt.set(w.token, Date.now());
          }
        }
      }
    }`,
);

// ---------------------------------------------------------------------------
// scripts/test-unit.js — the fakes must expose the batched shape
// ---------------------------------------------------------------------------

// F1: the terminal-card fake (shared by the settle tests).
edit(
  TU,
  "tu: terminal-card fake gains the batched methods",
  `      deletePushWatch: async () => {},
      setPushWatchHolders: async () => {},
      recordPushDelivery: async () => {},`,
  `      deletePushWatch: async () => {},
      setPushWatchHolders: async () => {},
      setPushWatchHoldersMany: async () => {},
      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => false), pruned: 0 }),
      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),
      recordPushDelivery: async () => {},`,
);

// F2: the heal/ledger fake (mk).
edit(
  TU,
  "tu: mk fake serves the merged heal read",
  `        findUntrackedPushes: async () => [{ token, chatId: "c", pushedAt }],`,
  `        findUntrackedPushes: async () => [{ token, chatId: "c", pushedAt }],
        findUntrackedPushesAndLedger: async () => ({
          missing: [{ token, chatId: "c", pushedAt }],
          ledgerRaw: ledgerValue,
        }),
        claimRecapsAndPrune: async (list) => ({ won: list.map(() => false), pruned: 0 }),`,
);

// F3: the multi-token heal fake (fakeDb).
edit(
  TU,
  "tu: fakeDb serves the merged heal read",
  `      findUntrackedPushes: async () => tokens.map((t) => ({ token: t, chatId: "c", pushedAt })),`,
  `      findUntrackedPushes: async () => tokens.map((t) => ({ token: t, chatId: "c", pushedAt })),
      findUntrackedPushesAndLedger: async () => ({
        missing: tokens.map((t) => ({ token: t, chatId: "c", pushedAt })),
        ledgerRaw: ledgerValue,
      }),
      claimRecapsAndPrune: async (list) => ({ won: list.map(() => false), pruned: 0 }),`,
);

// F4: the shared row-loop fake (watchDb).
edit(
  TU,
  "tu: watchDb fake gains the batched methods",
  `  const watchDb = (rows, updated) => ({
    listPushWatch: async () => rows,
    prunePushWatch: async () => 0,
    findUntrackedPushes: async () => [],`,
  `  const watchDb = (rows, updated) => ({
    listPushWatch: async () => rows,
    prunePushWatch: async () => 0,
    findUntrackedPushes: async () => [],
    findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),
    claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => false), pruned: 0 }),
    setPushWatchHoldersMany: async () => {},`,
);

// F5: the chronic-heal test: the heal's opening read is the slow one now.
edit(
  TU,
  "tu: chronic-heal test slows the merged read",
  `      findUntrackedPushes: async () => [
        { token: "MISS1", chatId: "c", pushedAt: Date.now() - 300_000 },
      ],`,
  `      findUntrackedPushesAndLedger: async () => {
        await slow(600);
        return {
          missing: [{ token: "MISS1", chatId: "c", pushedAt: Date.now() - 300_000 }],
          ledgerRaw: null,
        };
      },`,
);

// F6: the heal-skipped test: nothing may be read when the slice is denied.
edit(
  TU,
  "tu: heal-skipped test counts the merged read",
  `      findUntrackedPushes: async () => {
        healReads += 1;
        return [{ token: "MISS1", chatId: "c", pushedAt: Date.now() - 300_000 }];
      },`,
  `      findUntrackedPushesAndLedger: async () => {
        healReads += 1;
        return {
          missing: [{ token: "MISS1", chatId: "c", pushedAt: Date.now() - 300_000 }],
          ledgerRaw: null,
        };
      },`,
);

// F7: the trip-accounting test (claims + prune + listing).
edit(
  TU,
  "tu: trip-accounting test counts the merged claim batch",
  `  await test("PushWatcher: one listing per tick, recap claims batched, no no-op prune, trips reported", async () => {
    // 2026-09-17 round-trip merge: the pass read push_watch TWICE per tick
    // (recap pass + row loop), claimed every expiring row with its own request,
    // and always ran the prune even when it provably deleted nothing. On a
    // pass budget of ~1s those round trips are what starves the rotation, so
    // the mocks count every call and the pass must report the same number.`,
  `  await test("PushWatcher: one listing per tick, claims + prune in ONE batch, trips reported", async () => {
    // 2026-09-17 round-trip merge: the pass read push_watch TWICE per tick
    // (recap pass + row loop), claimed every expiring row with its own request,
    // and always ran the prune even when it provably deleted nothing. On a
    // pass budget of ~1s those round trips are what starves the rotation, so
    // the mocks count every call and the pass must report the same number.
    // 2026-09-23: the claims AND the DELETE now ride ONE batch
    // (Db.claimRecapsAndPrune) — the invocation's real ceiling is Workers
    // Free's 50 subrequests, and Turso's HTTP transport is one per batch.`,
);

edit(
  TU,
  "tu: trip-accounting fake moves to the merged batch",
  `      prunePushWatch: async () => { calls.prune += 1; calls.total += 1; return 1; },
      markRecapClaimedMany: async (tokens) => {
        calls.claims.push(tokens);
        calls.total += 1;
        return tokens.map(() => true);
      },
      findUntrackedPushes: async () => { calls.total += 1; return []; },`,
  `      claimRecapsAndPrune: async (tokens) => {
        calls.claims.push(tokens);
        calls.total += 1;
        return { won: tokens.map(() => true), pruned: 1 };
      },
      findUntrackedPushesAndLedger: async () => {
        calls.total += 1;
        return { missing: [], ledgerRaw: null };
      },`,
);

edit(
  TU,
  "tu: trip-accounting assertion: the DELETE rides the batch",
  `    assert.equal(calls.prune, 1, "a row past the window still triggers the prune");`,
  `    assert.equal(
      calls.prune, 0,
      "the DELETE rides the recap-claim batch instead of spending its own round trip",
    );`,
);

// F8: the bounded-recap-send test.
edit(
  TU,
  "tu: bounded-recap fake moves to the merged batch",
  `      prunePushWatch: async () => 1,
      markRecapClaimedMany: async (tokens) => tokens.map(() => true),
      findUntrackedPushes: async () => [],`,
  `      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => true), pruned: 1 }),
      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),`,
);

// F9: the no-op-prune test.
edit(
  TU,
  "tu: no-op-prune fake moves to the merged batch",
  `      markRecapClaimedMany: async (tokens) => { calls.total += 1; return tokens.map(() => true); },
      findUntrackedPushes: async () => { calls.total += 1; return []; },`,
  `      claimRecapsAndPrune: async (tokens) => {
        calls.total += 1;
        return { won: tokens.map(() => true), pruned: 0 };
      },
      findUntrackedPushesAndLedger: async () => {
        calls.total += 1;
        return { missing: [], ledgerRaw: null };
      },`,
);

// F10: the park test observes the batch instead of per-row writes.
edit(
  TU,
  "tu: park test observes the holder batch",
  `      setPushWatchHolders: async (token, count) => {
        holderWrites.push([token, count]);
      },`,
  `      setPushWatchHoldersMany: async (updates) => {
        for (const u of updates) holderWrites.push([u.token, u.holders]);
      },`,
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
