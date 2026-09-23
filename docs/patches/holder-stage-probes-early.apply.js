#!/usr/bin/env node
/**
 * One-shot applier: revive the tracker pass's holder stage by STARTING the
 * Birdeye probes behind the pair batch and collecting them after the row loop.
 *
 * WHY A SCRIPT: `src/pushwatch.ts` and `scripts/test-unit.js` are both far
 * beyond the file tools' sync window (everything past ~line 1240 answers "old
 * string not found" — measured again this session), so the deep edits are
 * applied here. Two phases, like docs/patches/tracker-pass-batched-consumer.apply.js:
 * every edit must match EXACTLY ONCE, and any mismatch aborts the whole run with
 * a non-zero exit code, so a partial edit is impossible. The span replacement
 * additionally asserts the tokens it is supposed to be swallowing.
 *
 * WHY THE CHANGE (live 2026-09-23, docs/round-trips.md §4): the stage probed
 * LAST, under the rule "a probe only starts when its whole
 * TRACKER_HOLDER_CAP_MS fits inside the pass deadline", and the row loop always
 * spent that allowance first. Every pass of an hour read `holders 0/0 held0
 * cut4` — four due rows selected, none started — while 35 of the 40 tracked
 * rows carried no `holders_checked_at` at all and the oldest stamp was 368
 * minutes old. The probes now start where the pass still has its allowance and
 * overlap the row loop (HTTP wait vs Turso-turn clock); only the COLLECT
 * (await + ONE batch write) stays at the end, so no write moves and no row time
 * is taken.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

/** @type {Array<{file: string, name: string, apply: (t: string) => string}>} */
const EDITS = [];

/** Abort a whole run rather than write a half-applied change. */
const fail = (msg) => {
  throw new Error(msg);
};

const insertBefore = (name, file, anchor, block) =>
  EDITS.push({
    file,
    name,
    apply: (text) => {
      const first = text.indexOf(anchor);
      if (first < 0) fail(`${name}: anchor not found`);
      if (text.indexOf(anchor, first + 1) >= 0) fail(`${name}: anchor matched twice`);
      return text.slice(0, first) + block + text.slice(first);
    },
  });

const replaceSpan = (name, file, startMarker, endMarker, mustInclude, block) =>
  EDITS.push({
    file,
    name,
    apply: (text) => {
      const first = text.indexOf(startMarker);
      if (first < 0) fail(`${name}: start marker not found`);
      if (text.indexOf(startMarker, first + 1) >= 0)
        fail(`${name}: start marker matched twice`);
      const endAt = text.indexOf(endMarker, first);
      if (endAt < 0) fail(`${name}: end marker not found after the start marker`);
      const end = endAt + endMarker.length;
      const span = text.slice(first, end);
      for (const token of mustInclude) {
        if (!span.includes(token)) fail(`${name}: span is missing \`${token}\``);
      }
      return text.slice(0, first) + block + text.slice(end);
    },
  });

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 1. start the holder probes behind the pair batch
// ---------------------------------------------------------------------------

insertBefore(
  "pw: holder probes start with the pair batch",
  PW,
  `    let firstRow = true;`,
  `    /**
     * START the holder probes HERE, behind the pair batch, and COLLECT them
     * after the row loop (see the holder stage below).
     *
     * The stage used to probe at the very END of the pass, under a rule this
     * move does not soften: a probe only starts when its whole
     * TRACKER_HOLDER_CAP_MS fits inside the pass deadline. The row loop always
     * spends that allowance first, so the rule made the stage DEAD — measured
     * 2026-09-23 on every pass of an hour: \`holders 0/0 held0 cut4\`, four due
     * rows selected and not one of them started, while 35 of the 40 tracked rows
     * carried no \`holders_checked_at\` at all (oldest stamp 368 minutes — see
     * docs/round-trips.md §4). Starting them one stage earlier buys the probes a
     * turn WITHOUT taking one from the rotation, because the two are not the
     * same kind of time: the probe is I/O-bound HTTP (Birdeye token_overview,
     * 300-900ms live, the reason the cap is 1_200) while the row loop's wall
     * clock is Turso round trips, so probes in flight overlap the rows instead
     * of queueing behind them. Nothing that keeps cards honest moves: every
     * WRITE still happens after the row loop, in the same order as before, and a
     * row gets a count only when its probe PROVED one inside the pass.
     */
    let holderProbeDue = 0;
    let holderProbeHeld = 0;
    let holderProbeMisses = 0;
    const holderProbeWrites: Array<{
      token: string;
      holders: number;
      at: number;
    }> = [];
    const holderProbePending: Array<Promise<void>> = [];
    /** Tokens whose probe had not answered when the pass moved on (→ parked). */
    const holderProbeUnsettled = new Set<string>();
    {
      const birdeye = this.birdeye;
      if (birdeye && cfg.maxHolderChecksPerTick > 0) {
        // A row that MISSED its probe is parked (see TRACKER_HOLDER_BACKOFF_MS)
        // and dropped BEFORE the slice, so a slow head cannot hold the stage's
        // slots while the rows behind it — the ones that answer inside the cap —
        // wait for turns that never come.
        const parked = (r: PushWatchRow) => {
          const failedAt = this.holdersFailedAt.get(r.token);
          if (failedAt === undefined) return false;
          if (now - failedAt >= TRACKER_HOLDER_BACKOFF_MS) {
            this.holdersFailedAt.delete(r.token);
            return false;
          }
          return true;
        };
        const holderHead = activeRows
          .filter(
            (r) =>
              pairs.has(r.token) &&
              (r.holdersCheckedAt === null ||
                now - r.holdersCheckedAt >= cfg.holdersRefreshMin * 60_000),
          )
          .sort((a, b) => (a.holdersCheckedAt ?? 0) - (b.holdersCheckedAt ?? 0))
          .slice(0, cfg.maxHolderChecksPerTick);
        const due = holderHead.filter((r) => !parked(r));
        holderProbeHeld = holderHead.length - due.length;
        holderProbeDue = due.length;
        for (const r of due) {
          // The start condition is UNCHANGED — the whole cap must fit inside
          // the pass deadline — it is simply evaluated where the pass still has
          // its allowance (setup + heal + pairs leave 1.0-3.0s of it).
          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          holderProbeUnsettled.add(r.token);
          holderProbePending.push(
            this.bounded(
              birdeye.getTokenOverview(r.token),
              TRACKER_HOLDER_CAP_MS,
              null,
            )
              .then((overview) => {
                holderProbeUnsettled.delete(r.token);
                if (overview && overview.holderCount !== null) {
                  holderProbeWrites.push({
                    token: r.token,
                    holders: overview.holderCount,
                    at: now,
                  });
                  this.holdersFailedAt.delete(r.token);
                  return;
                }
                // Only a probe that WROTE a count clears the park: a timeout, a
                // malformed body and a throw all mean "no holder data this
                // time".
                holderProbeMisses += 1;
                this.holdersFailedAt.set(r.token, Date.now());
              })
              .catch((err) => {
                holderProbeUnsettled.delete(r.token);
                holderProbeMisses += 1;
                console.error(
                  "[push-watch] holder refresh failed:",
                  err instanceof Error ? err.message : err,
                );
                this.holdersFailedAt.set(r.token, Date.now());
              }),
          );
        }
      }
    }
`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 2. the holder stage becomes the COLLECT
// ---------------------------------------------------------------------------

replaceSpan(
  "pw: holder stage collects what the early probes proved",
  PW,
  `    // Holder refresh (Birdeye CU-bounded): oldest-checked first, alive coins only.`,
  `    spent.holders.trips = trips - holdersTrips;`,
  ["setPushWatchHoldersMany", "TRACKER_HOLDER_CAP_MS", "holdersHeld = head.length - due.length"],
  `    // Holder refresh (Birdeye CU-bounded): the probes were STARTED behind the
    // pair batch (see there); this stage only WAITS for the stragglers and
    // writes what came back. The clock below therefore measures the COLLECT —
    // the probes themselves overlapped the row loop — while \`held\` and \`cut\`
    // keep their meanings: held = rows already parked by an earlier miss, cut =
    // due rows this pass got no count out of (never started, or still in flight
    // when the pass moved on).
    const holdersStart = Date.now();
    const holdersTrips = trips;
    if (holderProbePending.length > 0) {
      // No new unbounded await: every probe is already capped by
      // TRACKER_HOLDER_CAP_MS, and this only decides how long the pass is
      // willing to WAIT for the ones still in flight — the same slice the old
      // stage demanded before it started one.
      await this.bounded(
        Promise.all(holderProbePending),
        Math.max(0, Math.min(TRACKER_HOLDER_CAP_MS, deadline - Date.now())),
        null,
      );
    }
    // Still in flight means nothing was proven, so the row is parked exactly
    // like a probe that missed its cap (only a SUCCESS clears a park) and it
    // counts as cut: it never got a turn inside this pass.
    for (const token of holderProbeUnsettled) {
      this.holdersFailedAt.set(token, Date.now());
    }
    holdersHeld = holderProbeHeld;
    holdersCut = holderProbeDue - holderProbeWrites.length - holderProbeMisses;
    if (holderProbeWrites.length > 0) {
      // The whole stage in ONE round trip (N before this).
      trips += 1;
      try {
        await this.db.setPushWatchHoldersMany(holderProbeWrites);
        for (const w of holderProbeWrites) this.holdersFailedAt.delete(w.token);
      } catch (err) {
        console.error(
          "[push-watch] holder batch write failed:",
          err instanceof Error ? err.message : err,
        );
        // A rejected batch wrote NOTHING: park every row it covered, the
        // same state a row whose own write failed used to reach.
        for (const w of holderProbeWrites) {
          this.holdersFailedAt.set(w.token, Date.now());
        }
      }
    }
    spent.holders.ms = Date.now() - holdersStart;
    spent.holders.trips = trips - holdersTrips;`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 3. the note's holder clock now measures the collect
// ---------------------------------------------------------------------------

EDITS.push({
  file: PW,
  name: "pw: the holder note's clock is the collect, not the probes",
  apply: (text) => {
    const old = `    // Holder-stage visibility, next to its clock: \`holders 1200/1\` alone
    // cannot tell "one probe landed" from "four probes timed out and one row
    // is parked", because the trips count only counts a probe that actually
    // WROTE a count (both shapes read 0 on a miss). Same reasoning as the
    // heal's miss/enrolled pair.`;
    if (!text.includes(old)) fail("pw: holder-note comment not found");
    if (text.indexOf(old, text.indexOf(old) + 1) >= 0)
      fail("pw: holder-note comment matched twice");
    return text.replace(
      old,
      `    // Holder-stage visibility, next to its clock: \`holders 1200/1\` alone
    // cannot tell "one probe landed" from "four probes timed out and one row
    // is parked", because the trips count only counts a probe that actually
    // WROTE a count (both shapes read 0 on a miss). Same reasoning as the
    // heal's miss/enrolled pair. The clock is the COLLECT: the probes start
    // behind the pair batch and overlap the row loop (see the holder stage), so
    // a small \`holders\` reading next to \`trips 1\` is the normal shape.`,
    );
  },
});

// ---------------------------------------------------------------------------
// scripts/test-unit.js — the regression tests
// ---------------------------------------------------------------------------

insertBefore(
  "tu: holder probes start early (starvation fix) + straggler accounting",
  TU,
  `    assert.match(String(third.note), /holders \\d+\\/1/, \`the stage reports the write: \${third.note}\`);
  });
`,
  `
  await test("PushWatcher: holder probes start with the pair batch, so a pass the rows ate still writes a count", async () => {
    // Live 2026-09-23, every pass of an hour: \`holders 0/0 held0 cut4\` — four
    // due rows selected and NOT ONE started, because the probe only began when
    // its whole 1200ms cap fitted in what the row loop had not already spent (35
    // of 40 tracked rows carried no holders_checked_at at all). The probes now
    // start behind the pair batch and only their COLLECT stays after the rows,
    // so the pass still writes the counts it proved — and still in ONE batch.
    const rows = [watchRow("AAA"), watchRow("BBB"), watchRow("CCC"), watchRow("DDD")];
    const updated = [];
    const holderWrites = [];
    let probes = 0;
    const db = {
      ...watchDb(rows, updated),
      // The row loop is the pass's clock (Turso round trips): 400ms per row
      // against a 2s allowance leaves the tail nothing at all.
      claimPushWatchCheck: async (token, _expected, _now, v) => {
        await new Promise((r) => setTimeout(r, 400));
        updated.push([token, v]);
        return true;
      },
      setPushWatchHoldersMany: async (updates) => {
        for (const u of updates) holderWrites.push([u.token, u.holders]);
      },
    };
    const pw = new PushWatcher(
      db,
      watchBot,
      { getTokenOverview: async () => { probes += 1; return { holderCount: 321 }; } },
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 2_000);
    assert.equal(probes, 4, "every due row is probed, not just the head of a queue that never runs");
    assert.equal(holderWrites.length, 4, "every count comes back");
    assert.ok(holderWrites.every(([, holders]) => holders === 321));
    assert.match(String(out.note), /holders \\d+\\/1/, \`one batch write for all of them: \${out.note}\`);
    assert.match(String(out.note), /cut0/, \`every due row got its turn: \${out.note}\`);
  });

  await test("PushWatcher: a probe still in flight when the pass ends is parked and counted as cut", async () => {
    // The park rule is unchanged (only a SUCCESS clears it) and it now also
    // covers the straggler the collector stopped waiting for: the probes start
    // early, so a probe that never answers is a row with NO proof, exactly like
    // one that missed its cap — it must not keep its place at the head of the
    // due list for the next pass to re-burn.
    const rows = [watchRow("AAA")];
    const updated = [];
    let probes = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      watchBot,
      { getTokenOverview: async () => { probes += 1; return new Promise(() => {}); } },
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 1_600);
    assert.equal(probes, 1, "the probe is attempted once");
    assert.equal(pw.holdersFailedAt.has("AAA"), true, "a probe that never answered parks its row");
    assert.match(String(out.note), /held0 cut1/, \`and it is reported as a due row with no count: \${out.note}\`);
  });
`,
);

// ---------------------------------------------------------------------------

const files = [...new Set(EDITS.map((e) => e.file))];
const original = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const next = new Map(files.map((f) => [f, original.get(f)]));
let failures = 0;

for (const e of EDITS) {
  try {
    next.set(e.file, e.apply(next.get(e.file)));
    console.log(`ok        ${e.file} :: ${e.name}`);
  } catch (err) {
    console.error(`FAILED    ${e.file} :: ${e.name} — ${err.message}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n${failures} edit(s) did not apply — NOTHING was written.`);
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
