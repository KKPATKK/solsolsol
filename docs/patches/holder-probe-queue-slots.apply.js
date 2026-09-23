#!/usr/bin/env node
/**
 * One-shot applier: make the holder stage start only the probes its slice can
 * actually COLLECT, and give each probe a cap that covers its turn in the
 * serialized Birdeye throttle (docs/round-trips.md §4.4).
 *
 * WHY: every Birdeye call in the isolate goes through ONE serialized throttle
 * (`birdeyeRequestIntervalMs`, 1100ms live — the stage shares it with the
 * scan's own Birdeye use), so probe i cannot even ISSUE before its turn; its
 * earliest settle is i × interval. The stage started the whole due head and
 * then waited a single TRACKER_HOLDER_CAP_MS, i.e. at most ONE turn. Live
 * 2026-09-23, every pass with four due rows read `probe4 miss3`:
 *
 *   `… spend[… holders 1175/1 held0 cut0 probe4 miss3] trips 5 db 698ms`
 *
 * three Birdeye calls spent, three rows parked for TRACKER_HOLDER_BACKOFF_MS
 * (10 minutes) — for ONE count, while `holders_checked_at` landed for exactly
 * one row a minute (the 30-minute refresh over 40 tracked rows needs 1.33/min).
 * Those three "misses" are not Birdeye failures: they are the queue, charged to
 * the rows as failures.
 *
 * WHAT MOVES: the stage's wait becomes TRACKER_HOLDER_STAGE_MS (2_400, two
 * turns: 1_100 + 1_200), clamped by the pass deadline exactly as before; the
 * dispatch starts only `1 + floor((slice − cap) / interval)` probes; each probe
 * keeps its own cap, now `cap + probeIndex × interval`. Nothing about what a
 * probe WRITES moves: still one count per row, still only on success, still one
 * batched write, still a park on a real miss. The rows that get no turn are
 * left DUE (reported as `cut`, never parked) for the next pass — the same place
 * they sat in when the stage started four and collected one.
 *
 * WHY A SCRIPT: `src/pushwatch.ts` and `scripts/test-unit.js` are far beyond the
 * file tools' sync window (everything past ~50KB answers "old string not
 * found"), so the deep edits are applied here. Every replacement must match
 * EXACTLY ONCE or the whole run aborts with a non-zero exit, so a half-applied
 * change is impossible.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

/**
 * One replacement, applied to the raw file text. Every old string appears
 * exactly once in its file or the run aborts before writing anything.
 */
const EDITS = [
  {
    file: PW,
    name: "pw: start only the probes the stage slice can collect",
    old: `        const due = holderHead.filter((r) => !parked(r));
        holderProbeHeld = holderHead.length - due.length;
        holderProbeDue = due.length;
        for (const r of due) {
          // The start condition is UNCHANGED — the whole cap must fit inside
          // the pass deadline — it is simply evaluated where the pass still has
          // its allowance (setup + heal + pairs leave 1.0-3.0s of it).
          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          holderProbeStarted += 1;
          holderProbeUnsettled.add(r.token);
          holderProbePending.push(
            this.bounded(
              birdeye.getTokenOverview(r.token),
              TRACKER_HOLDER_CAP_MS,
              null,
            )`,
    new: `        const due = holderHead.filter((r) => !parked(r));
        holderProbeHeld = holderHead.length - due.length;
        holderProbeDue = due.length;
        // How many probes this pass may START: one for the cap, plus one per
        // whole throttle interval its slice can cover (see
        // TRACKER_HOLDER_STAGE_MS). Starting more is not "trying harder" — the
        // extras cannot issue before the collect gives up, so they are
        // guaranteed misses that also park their rows.
        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);
        const stageMs = Math.max(
          0,
          Math.min(TRACKER_HOLDER_STAGE_MS, deadline - Date.now()),
        );
        const holderSlots =
          1 +
          Math.floor(Math.max(0, stageMs - TRACKER_HOLDER_CAP_MS) / intervalMs);
        for (const r of due) {
          // The start condition is UNCHANGED — the whole cap must fit inside
          // the pass deadline — it is simply evaluated where the pass still has
          // its allowance (setup + heal + pairs leave 1.0-3.0s of it).
          if (holderProbeStarted >= holderSlots) break;
          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          // Its turn in that queue is part of its cost: probe i waits up to i
          // intervals before its own fetch starts, so its cap covers the WAIT
          // plus the fetch. Capping the wait instead is the \`probe4 miss3\`
          // shape this replaces.
          const probeIndex = holderProbeStarted;
          holderProbeStarted += 1;
          holderProbeUnsettled.add(r.token);
          holderProbePending.push(
            this.bounded(
              birdeye.getTokenOverview(r.token),
              TRACKER_HOLDER_CAP_MS + probeIndex * intervalMs,
              null,
            )`,
  },
  {
    file: PW,
    name: "pw: the collect waits the stage slice, not one cap",
    old: `      // No new unbounded await: every probe is already capped by
      // TRACKER_HOLDER_CAP_MS, and this only decides how long the pass is
      // willing to WAIT for the ones still in flight — the same slice the old
      // stage demanded before it started one.
      await this.bounded(
        Promise.all(holderProbePending),
        Math.max(0, Math.min(TRACKER_HOLDER_CAP_MS, deadline - Date.now())),
        null,
      );`,
    new: `      // No new unbounded await: every probe is already capped by its own
      // queue-aware slice (TRACKER_HOLDER_CAP_MS + probeIndex × interval), and
      // this only decides how long the pass is willing to WAIT for the ones
      // still in flight — the stage slice the dispatch above sized the started
      // probes to fit inside (TRACKER_HOLDER_STAGE_MS).
      await this.bounded(
        Promise.all(holderProbePending),
        Math.max(0, Math.min(TRACKER_HOLDER_STAGE_MS, deadline - Date.now())),
        null,
      );`,
  },
  {
    file: TU,
    name: "tu: the starvation test's probe count follows the slice",
    old: `    // so the pass still writes the counts it proved — and still in ONE batch.
    const rows = [watchRow("AAA"), watchRow("BBB"), watchRow("CCC"), watchRow("DDD")];`,
    new: `    // so the pass still writes the counts it proved — and still in ONE batch.
    // The other half of that move: probes are STARTED behind the pairs, so the
    // dispatch sees the pass's whole allowance — and still must not start what
    // the collect cannot reach (see the slot test below). This pass hands the
    // stage a ~1_950ms slice, which after the 1200ms fetch cap covers ONE turn
    // of the serialized Birdeye throttle, so exactly one probe starts.
    const rows = [watchRow("AAA"), watchRow("BBB"), watchRow("CCC"), watchRow("DDD")];`,
  },
  {
    file: TU,
    name: "tu: the starvation test pins the slot shape",
    old: `    const out = await pw.runTick(Date.now() + 2_000);
    assert.equal(probes, 4, "every due row is probed, not just the head of a queue that never runs");
    assert.equal(holderWrites.length, 4, "every count comes back");
    assert.ok(holderWrites.every(([, holders]) => holders === 321));
    assert.match(String(out.note), /holders \\d+\\/1/, \`one batch write for all of them: \${out.note}\`);
    assert.match(String(out.note), /cut0/, \`every due row got its turn: \${out.note}\`);
    assert.match(String(out.note), /probe4 miss0/, \`all four were started and all four answered: \${out.note}\`);
  });`,
    new: `    const out = await pw.runTick(Date.now() + 2_000);
    assert.equal(probes, 1, "the slice covers one queue turn, so one probe starts");
    assert.equal(holderWrites.length, 1, "and the count it proves still lands");
    assert.ok(holderWrites.every(([, holders]) => holders === 321));
    assert.match(String(out.note), /holders \\d+\\/1/, \`one batch write for it: \${out.note}\`);
    assert.match(
      String(out.note),
      /held0 cut3 probe1 miss0/,
      \`the rows the stage could not reach stay due, not parked: \${out.note}\`,
    );
  });

  await test("PushWatcher: holder probe slots follow the Birdeye throttle, so the pass stops paying for probes it cannot collect", async () => {
    // One serialized throttle serves every Birdeye call in the isolate
    // (BIRDEYE_REQUEST_INTERVAL_MS, 1100ms live — the stage shares it with the
    // scan's own Birdeye use), so probe i cannot even issue before its turn:
    // its earliest settle is i × interval. Live 2026-09-23 every pass with four
    // due rows read \`probe4 miss3\` — three calls spent and three rows parked
    // for the 10-minute backoff, for ONE count. The dispatch now starts only the
    // probes its slice covers, and each probe's cap includes its turn in that
    // queue.
    const rows = [watchRow("AAA"), watchRow("BBB"), watchRow("CCC"), watchRow("DDD")];
    const updated = [];
    const holderWrites = [];
    let probes = 0;
    const db = {
      ...watchDb(rows, updated),
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
    const out = await pw.runTick();
    assert.equal(probes, 2, "the 2_400ms slice covers two turns, so two probes start — not four");
    assert.equal(holderWrites.length, 2, "both counts land in the one batch");
    assert.match(String(out.note), /probe2 miss0/, \`both slots are used: \${out.note}\`);
    assert.match(
      String(out.note),
      /held0 cut2/,
      \`the rows that got no turn stay due for the next pass, not parked: \${out.note}\`,
    );

    // The cap covers the QUEUE, not just the fetch: probe 1 is allowed its
    // whole turn (here 200ms) ON TOP of the 1200ms fetch cap, so two hanging
    // probes settle at 1200 and 1400 — not both at the first number, which is
    // how three of four probes used to be thrown away.
    const hangRows = [watchRow("AAA"), watchRow("BBB")];
    const hangUpdated = [];
    let hangProbes = 0;
    const hangPw = new PushWatcher(
      watchDb(hangRows, hangUpdated),
      watchBot,
      { getTokenOverview: async () => { hangProbes += 1; return new Promise(() => {}); } },
      loadConfig({ BIRDEYE_REQUEST_INTERVAL_MS: "200" }),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const t0 = Date.now();
    const hangOut = await hangPw.runTick();
    const elapsed = Date.now() - t0;
    assert.equal(hangProbes, 2, "a hanging probe does not stop the second slot from starting");
    assert.ok(
      elapsed >= 1_300,
      \`probe 1 is capped at 1200 + its 200ms turn, so the pass waits for it: \${elapsed}ms\`,
    );
    assert.ok(elapsed < 2_300, \`and returns as soon as they settle: \${elapsed}ms\`);
    assert.match(String(hangOut.note), /probe2 miss2/, \`two turns, two misses: \${hangOut.note}\`);
  });`,
  },
];

// ---------------------------------------------------------------------------
// Apply: every old string must appear EXACTLY ONCE, or nothing is written.
// ---------------------------------------------------------------------------

const staged = new Map();
for (const e of EDITS) {
  if (!staged.has(e.file)) staged.set(e.file, fs.readFileSync(e.file, "utf8"));
  const text = staged.get(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.name}`);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.name}`);
    process.exit(1);
  }
  staged.set(e.file, text.slice(0, first) + e.new + text.slice(first + e.old.length));
  console.log(`staged    ${e.name}`);
}

for (const [file, text] of staged) {
  fs.writeFileSync(file, text);
  console.log(`ok        ${file} (${text.length} bytes)`);
}
