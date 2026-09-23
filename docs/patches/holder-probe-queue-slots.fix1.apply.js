#!/usr/bin/env node
/**
 * Correction to docs/patches/holder-probe-queue-slots.apply.js, from a LOCAL
 * MEASUREMENT of the real client (scripts/tmp-holder-queue-probe.js, deleted
 * after the run): `Throttle.run` only checks the interval on ENTRY, so calls
 * that queued during the same window wake and fire TOGETHER — they are not
 * serialized one per interval. Four simultaneous getTokenOverview calls with
 * the live 1100ms interval and a 300ms stub endpoint settled at:
 *
 *   302 / 1402 / 1402 / 1404ms
 *
 * i.e. the second and every later probe pay the fetch plus ONE gate, not one
 * gate EACH (the assumption the first script's per-index cap encoded), and the
 * bare 1_200ms fetch cap is what threw them away live (`probe4 miss3`).
 *
 * So: every probe's cap is `TRACKER_HOLDER_CAP_MS + intervalMs` (one gate), and
 * when the stage slice covers that, the WHOLE due head starts — the gate fires
 * them together, so extra probes do not stack cost. Only a slice too short for a
 * gate starts the single probe that does not need one. Same discipline as the
 * other appliers: exactly one match per replacement or nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

const EDITS = [
  {
    file: PW,
    name: "pw: the slice constant carries the measured gate model",
    old: `/**
 * How long the holder stage is willing to WAIT for the probes it started —
 * which is also HOW MANY it can start, because every Birdeye call in the
 * isolate passes through ONE serialized throttle (\`birdeyeRequestIntervalMs\`,
 * 1100ms live): probe i cannot even ISSUE before its turn, so its earliest
 * settle is \`i × interval\`. A stage that starts four of them and waits one
 * cap pays three capped probes — three Birdeye calls spent, three rows parked
 * for TRACKER_HOLDER_BACKOFF_MS — for ONE count: measured live 2026-09-23 as
 * \`probe4 miss3\` on every pass with four due rows, while \`holders_checked_at\`
 * landed for exactly one row a minute (the count the 30-minute refresh needs
 * for 40 tracked rows is 1.33/min). The slice covers two turns
 * (1_100 + 1_200 < 2_400) and is clamped by the pass deadline, so the pass
 * only ever waits for probes it can actually collect; the ones that do not
 * fit stay DUE — reported as \`cut\`, never parked — for the next pass.
 */
const TRACKER_HOLDER_STAGE_MS = 2_400;`,
    new: `/**
 * How long the holder stage is willing to WAIT for the probes it started —
 * which is what decides HOW MANY it may start, because they all queue behind
 * ONE rate gate.
 *
 * Every Birdeye call in the isolate passes through the same throttle
 * (\`birdeyeRequestIntervalMs\`, 1100ms live — the stage shares it with the
 * scan's own Birdeye use). That gate is NOT a per-call queue: calls that
 * arrived during the same window wake and fire TOGETHER, so the second and
 * every later probe pay the fetch plus ONE gate, not one gate each. Measured
 * 2026-09-23 against the real client with a 300ms stub endpoint — four probes
 * dispatched together settled at 302 / 1_402 / 1_402 / 1_404ms. The old shape
 * gave every probe the bare fetch cap, so those three were reported as MISSES:
 * three Birdeye calls spent, three rows parked for TRACKER_HOLDER_BACKOFF_MS,
 * ONE count written — live \`probe4 miss3\` on every pass with four due rows.
 * The slice below covers one gate on top of the fetch cap (1_100 + 1_200 <
 * 2_400) and is clamped by the pass deadline, so the pass never starts a probe
 * it cannot collect; the rows it cannot reach stay DUE (reported as \`cut\`,
 * never parked) for the next pass.
 */
const TRACKER_HOLDER_STAGE_MS = 2_400;`,
  },
  {
    file: PW,
    name: "pw: one gate per probe, whole head when the slice covers it",
    old: `        // How many probes this pass may START: one for the cap, plus one per
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
    new: `        // What a probe costs on top of its fetch: ONE gate (see
        // TRACKER_HOLDER_STAGE_MS for the measured shape — the gate fires the
        // calls that queued behind it together, so extra probes do not stack
        // cost). A slice that covers gate + fetch can serve the WHOLE due head;
        // a shorter one is only worth the single probe that needs no gate,
        // because every other probe would be collected as a miss and parked.
        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);
        const probeCapMs = TRACKER_HOLDER_CAP_MS + intervalMs;
        const stageMs = Math.max(
          0,
          Math.min(TRACKER_HOLDER_STAGE_MS, deadline - Date.now()),
        );
        const holderSlots = stageMs >= probeCapMs ? cfg.maxHolderChecksPerTick : 1;
        for (const r of due) {
          // The start condition is UNCHANGED — the whole cap must fit inside
          // the pass deadline — it is simply evaluated where the pass still has
          // its allowance (setup + heal + pairs leave 1.0-3.0s of it).
          if (holderProbeStarted >= holderSlots) break;
          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          holderProbeStarted += 1;
          holderProbeUnsettled.add(r.token);
          holderProbePending.push(
            this.bounded(
              birdeye.getTokenOverview(r.token),
              probeCapMs,
              null,
            )`,
  },
  {
    file: TU,
    name: "tu: the starvation test names the gate cost",
    old: `    // The other half of that move: probes are STARTED behind the pairs, so the
    // dispatch sees the pass's whole allowance — and still must not start what
    // the collect cannot reach (see the slot test below). This pass hands the
    // stage a ~1_950ms slice, which after the 1200ms fetch cap covers ONE turn
    // of the serialized Birdeye throttle, so exactly one probe starts.`,
    new: `    // The other half of that move: probes are STARTED behind the pairs, so the
    // dispatch sees the pass's whole allowance — and still must not start what
    // the collect cannot reach (see the slot test below). This pass hands the
    // stage a ~1_950ms slice, which is less than the 1_200 + 1_100 one gate
    // costs, so only the single probe that needs no gate starts.`,
  },
  {
    file: TU,
    name: "tu: the slot test pins the measured gate shape",
    old: `    // One serialized throttle serves every Birdeye call in the isolate
    // (BIRDEYE_REQUEST_INTERVAL_MS, 1100ms live — the stage shares it with the
    // scan's own Birdeye use), so probe i cannot even issue before its turn:
    // its earliest settle is i × interval. Live 2026-09-23 every pass with four
    // due rows read \`probe4 miss3\` — three calls spent and three rows parked
    // for the 10-minute backoff, for ONE count. The dispatch now starts only the
    // probes its slice covers, and each probe's cap includes its turn in that
    // queue.`,
    new: `    // One rate gate serves every Birdeye call in the isolate
    // (BIRDEYE_REQUEST_INTERVAL_MS, 1100ms live — the stage shares it with the
    // scan's own Birdeye use). It is not a per-call queue: calls that arrived
    // in the same window fire TOGETHER, so probe 0 pays the fetch and every
    // later probe pays the fetch plus ONE gate (measured against the real
    // client: 302 / 1_402 / 1_402 / 1_404ms). Live 2026-09-23 every pass with
    // four due rows read \`probe4 miss3\` — three calls spent and three rows
    // parked for the 10-minute backoff, for ONE count — because each probe's
    // cap was the bare fetch cap.`,
  },
  {
    file: TU,
    name: "tu: the slot test asserts the whole head once the gate fits",
    old: `    const out = await pw.runTick();
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
    // how three of four probes used to be thrown away.`,
    new: `    const out = await pw.runTick();
    assert.equal(probes, 4, "the slice covers gate + fetch, so the whole due head starts");
    assert.equal(holderWrites.length, 4, "every count comes back, in the one batch");
    assert.match(String(out.note), /probe4 miss0/, \`nothing is thrown away to the gate: \${out.note}\`);
    assert.match(String(out.note), /held0 cut0/, \`every due row got its turn: \${out.note}\`);

    // The cap carries the GATE, not just the fetch: with a 200ms interval both
    // hanging probes settle at 1_400 — one gate plus the fetch cap — where the
    // bare 1_200 used to collect them as misses.`,
  },
  {
    file: TU,
    name: "tu: the hanging-probe assertion names the gate",
    old: `    assert.ok(
      elapsed >= 1_300,
      \`probe 1 is capped at 1200 + its 200ms turn, so the pass waits for it: \${elapsed}ms\`,
    );`,
    new: `    assert.ok(
      elapsed >= 1_300,
      \`each cap carries the 200ms gate (1200 + 200), so the pass waits for it: \${elapsed}ms\`,
    );`,
  },
];

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
