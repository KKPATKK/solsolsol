#!/usr/bin/env node
/*
 * Apply the tests for A (front split) and C (rebuild marker through the claim).
 *
 * Tests live in two files because the two halves are different kinds of claim:
 *   - scripts/test-unit.js     the FORMATTERS (arithmetic, caps, the note).
 *   - scripts/test-tick-path.js the RECOVERY RULE (a claim-shaped heartbeat
 *                              carrying the marker must NOT rebuild).
 * The wiring guards (does the claim actually publish it / does the err actually
 * print the split) go in test-unit.js, which already reads src/worker.ts.
 *
 * Idempotent + self-verifying (see the other docs/patches/*.apply.js scripts):
 * ✓ applied, = already present, ✗ anchor missing (file moved on) -> exit 1.
 *
 * Run: node docs/patches/front-split-tests-2026-09-28.apply.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const UNIT = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
const TICK = path.join(__dirname, "..", "..", "scripts", "test-tick-path.js");

const UNIT_TESTS = `  await test("front split (A): the whole pre-scan envelope is named, remainder included", () => {
    // The live 2026-09-28 reading this note exists for: preRace 4320ms printed
    // as "json 0 + claim 1440" — a third of the number a reader opens it for.
    // The other 2880ms WAS the reading, and it had no name at all.
    const live = buildPreTickSplit({
      entryAt: 1_000_000,
      steps: { bump: 0, init: 0, gate: 0, outage: 0, json: 0, claim: 1_440 },
      startedAt: 1_000_000,
      raceAt: 1_004_320,
      raceMs: scanRaceWindowMs(4_320),
    });
    const note = frontSplitNote(live);
    assert.match(note, /^front 4320ms = /);
    assert.match(note, /preStart 0ms \\[bump 0 init 0 gate 0 outage 0 rest 0\\]/);
    assert.match(note, /preRace 4320ms \\[json 0 claim 1440 rest 2880\\]/);
    assert.match(note, /rest 2880/, "the unattributed remainder is the reading");
    // The shape a death-driven COLD REBUILD produces: \`init\` named on the
    // preStart half — the half the ADMISSION stamp can carry, and that stamp is
    // the only durable one a tick killed before the race ever leaves.
    const cold = buildPreTickSplit({
      entryAt: 1_000_000,
      steps: { bump: 0, init: 2_880, gate: 240, outage: 0, json: 0, claim: 1_440 },
      startedAt: 1_003_120,
      raceAt: 1_007_440,
      raceMs: scanRaceWindowMs(4_320),
    });
    assert.match(frontSplitNote(cold), /^front 7440ms = /);
    assert.match(
      frontSplitNote(cold),
      /preStart 3120ms \\[bump 0 init 2880 gate 240 outage 0 rest 0\\]/,
    );
    assert.equal(
      preStartSplitNote(1_000_000, 1_003_120, {
        bump: 0,
        init: 2_880,
        gate: 240,
        outage: 0,
        json: 0,
        claim: 0,
      }),
      "preStart 3120ms [bump 0 init 2880 gate 240 outage 0 rest 0]",
    );
    // Unmeasured is reported as unmeasured, never as a zero-cost front.
    assert.equal(frontSplitNote(null), "front n/a");
    assert.equal(frontSplitNote(undefined), "front n/a");
    assert.equal(
      frontSplitNote({
        at: 0,
        steps: PRE_TICK_ZERO_STEPS,
        preStartMs: null,
        preRaceMs: null,
        raceMs: null,
      }),
      "front n/a",
    );
    // A remainder can never read as negative: a step measured longer than the
    // window it sits in must not print "-40ms".
    assert.match(
      preStartSplitNote(0, 1_000, {
        bump: 0,
        init: 1_400,
        gate: 0,
        outage: 0,
        json: 0,
        claim: 0,
      }),
      /rest 0\\]$/,
    );
  });

  await test("front split (A): it survives into the record, and the note prints it before cut/err", () => {
    const at = 1_700_000_000_000;
    const shape = {
      at,
      stage: "scan",
      payloadBytes: 0,
      scanMs: 0,
      preRaceMs: 0,
      subreqs: 4,
      cut: false,
      err: null,
    };
    const front =
      "front 4320ms = preStart 0ms [bump 0 init 0 gate 0 outage 0 rest 0] + " +
      "preRace 4320ms [json 0 claim 1440 rest 2880]";
    const raw = tickProgressRecord({ ...shape, front });
    assert.equal(
      parseTickProgress(raw).front,
      front,
      "the split round-trips through the durable row",
    );
    assert.match(tickProgressNote(raw, at), /rest 2880/);
    // A record written before the split existed stays honest: null, and simply
    // omitted — never dressed up as a front that cost nothing.
    const old = tickProgressRecord(shape);
    assert.equal(parseTickProgress(old).front, null);
    assert.doesNotMatch(tickProgressNote(old, at), /front /);
    // Bounded on both ends, and the SPLIT is the survivor: a capped split plus
    // a capped error text must still leave the split inside the note's limit.
    const hugeRaw = tickProgressRecord({
      ...shape,
      stage: "postscan",
      payloadBytes: 12_000,
      scanMs: 5_000,
      preRaceMs: 4_320,
      subreqs: 38,
      cut: true,
      front: "x".repeat(500),
      err: "y".repeat(400),
    });
    const huge = parseTickProgress(hugeRaw);
    assert.equal(huge.front.length, TICK_PROGRESS_FRONT_MAX, "the field is capped");
    assert.equal(huge.err.length, TICK_PROGRESS_ERR_MAX, "the err cap is what was raised");
    assert.ok(TICK_PROGRESS_ERR_MAX > 185, "and it fits the race-window message it was raised for");
    const note = tickProgressNote(hugeRaw, at);
    assert.ok(note.length <= 240, "the note is still bounded");
    assert.match(note, /xxxx/, "the split survives the truncation; the err text does not");
  });

  await test("wiring (A + C): the split reaches the record, the marker reaches the CLAIM", () => {
    const workerSrc = fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8");
    // A: both halves are published — the whole envelope in the error a reader
    // opens, and as far as it is known on every durable stamp.
    assert.ok(
      workerSrc.includes("ms, \${frontSplitNote(preTick)})\`"),
      "the race-window err carries the whole front split, not just json+claim",
    );
    assert.ok(
      !workerSrc.includes("preRace \${preTick.preRaceMs}ms = json \${preTick.steps.json}"),
      "the two-part form (which hid two thirds of a 4.3s front) is gone",
    );
    assert.ok(
      workerSrc.includes("front: frontSplitNote(preTick),"),
      "the phase and postscan stamps carry the whole split",
    );
    assert.ok(
      workerSrc.includes("front: preStartSplitNote(preTickEntryAt, startedAt, preTick.steps),"),
      "the admission stamp carries the preStart half a killed tick can leave",
    );
    assert.ok(
      workerSrc.includes("if (rec.front) bits.push(rec.front);"),
      "the successor's note prints it, before cut/err",
    );
    // C: the marker must ride the CLAIM. Written only by the rebuild's own
    // announce, it is erased by the very next claim — and then the recovering
    // tick's own stale heartbeat reads as another death on every later tick of
    // the same stretch, each one paying a cold re-init.
    assert.ok(workerSrc.includes("let rebuildMarker: number | null = null;"), "the mirror exists");
    assert.ok(
      workerSrc.includes(
        "verdict.rebuild ? now : deadNow !== null ? heartbeatRebuiltAt(prevRaw) : null",
      ),
      "set on a rebuild, carried while the death stands, cleared when it does not",
    );
    assert.ok(
      workerSrc.includes("rebuiltAt: rebuildMarker,"),
      "the claim heartbeat republishes it",
    );
  });

  console.log("\\n===== UNIT TESTS =====");`;

const TICK_TESTS = `    assert.deepEqual(deadTickRebuildDecision(marked, now, stale), { rebuild: false });
    // THE SHAPE THE FIX SHIPS (2026-09-28, change C): the CLAIM heartbeat now
    // republishes the marker, so the row a later tick reads after a stretch is
    // still marked. Written only by the rebuild's own announce, the marker was
    // erased by the very next claim — and the recovering tick's own stale
    // heartbeat then read as a NEW death on every later tick, paying a cold
    // re-init per tick for the whole length of the stretch.
    const claimAfterRebuild = JSON.stringify({
      at: now - 60_000,
      via: "cron",
      ok: true,
      phase: "scanning",
      ms: null,
      rebuiltAt: now - 59_500,
    });
    assert.deepEqual(deadTickRebuildDecision(claimAfterRebuild, now, stale), { rebuild: false });
    // ...and the CLEARED shape (a claim whose predecessor was healthy) still
    // earns a rebuild: the marker is scoped to a stretch, not permanent, so it
    // can never wedge the recovery off for good.
    assert.deepEqual(
      deadTickRebuildDecision(
        JSON.stringify({ at: now - 60_000, ok: true, phase: "scanning", rebuiltAt: null }),
        now,
        stale,
      ),
      { rebuild: true, deadAt: now - 60_000 },
    );`;

const EDITS = [
  {
    file: UNIT,
    name: "test-unit: the three A+C tests, before the summary line",
    marker: 'await test("front split (A): the whole pre-scan envelope is named',
    from: '  console.log("\\n===== UNIT TESTS =====");',
    to: UNIT_TESTS,
  },
  {
    file: TICK,
    name: "test-tick-path: a claim-shaped marked heartbeat must not rebuild",
    marker: "const claimAfterRebuild = JSON.stringify({",
    from: "    assert.deepEqual(deadTickRebuildDecision(marked, now, stale), { rebuild: false });",
    to: TICK_TESTS,
  },
];

function main() {
  let failures = 0;
  let applied = 0;
  const byFile = new Map();

  for (const edit of EDITS) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, fs.readFileSync(edit.file, "utf8"));
    const src = byFile.get(edit.file);
    if (src.includes(edit.marker)) {
      console.log(`  = ${edit.name}`);
      continue;
    }
    const first = src.indexOf(edit.from);
    if (first === -1) {
      console.log(`  ✗ ${edit.name} — anchor NOT FOUND`);
      failures += 1;
      continue;
    }
    if (src.indexOf(edit.from, first + 1) !== -1) {
      console.log(`  ✗ ${edit.name} — anchor is not unique`);
      failures += 1;
      continue;
    }
    byFile.set(
      edit.file,
      src.slice(0, first) + edit.to + src.slice(first + edit.from.length),
    );
    applied += 1;
    console.log(`  ✓ ${edit.name}`);
  }

  if (failures === 0) {
    for (const [file, content] of byFile) fs.writeFileSync(file, content);
  } else {
    console.log("  (not written: an anchor failed)");
    process.exit(1);
  }
  console.log(`\nOK — ${applied} applied, ${EDITS.length - applied - failures} already present`);
  process.exit(0);
}

main();
