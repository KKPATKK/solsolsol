#!/usr/bin/env node
/**
 * Third holder patch, and the one the live reading asked for: the pass note
 * could not tell "four probes started and all four missed their cap" from
 * "nothing was due at all" — both read `holders 0/0 held0 cut0`, because a miss
 * writes nothing and a row that misses is checked, so it leaves the head of the
 * rotation before its park can show up as `held`. That ambiguity is exactly why
 * the starvation in docs/round-trips.md §4.1 stayed invisible for an hour.
 *
 * So the note gains the two counters the stage was missing:
 *   `... held${held} cut${cut} probe${started} miss${misses}]`
 * started = probes this pass actually began, misses = probes that settled
 * WITHOUT a count (a cap timeout, a throw, or a body with no holderCount —
 * every one of which parks its row for TRACKER_HOLDER_BACKOFF_MS).
 *
 * The counters are declared up with `holdersHeld`/`holdersCut`, next to
 * `stageNote()`: stageNote() is also called by the pass's early returns, which
 * run BEFORE the dispatch block, so a `let` down there would put those calls in
 * its temporal dead zone. `holderProbeDue`/`holderProbeHeld` move up with them
 * for the same reason (one home for the stage's counters).
 *
 * Same discipline as its sibling scripts: every replacement must match EXACTLY
 * ONCE, or the run aborts with a non-zero exit and nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";
const TU = "scripts/test-unit.js";

const fail = (msg) => {
  throw new Error(msg);
};

/** @type {Array<{file: string, name: string, old: string, new: string}>} */
const EDITS = [];
const edit = (file, name, old, next) => EDITS.push({ file, name, old, new: next });

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 1. the counters live next to the note
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: holder counters declared beside the note",
  `    let holdersHeld = 0;
    let holdersCut = 0;
    const stageNote = () =>`,
  `    let holdersHeld = 0;
    let holdersCut = 0;
    // Holder-PROBE counters, declared HERE and not next to the dispatch below:
    // stageNote() reads them, and stageNote() is also called by this pass's
    // early returns (the deferrals and the empty-rotation exits), which run
    // BEFORE the dispatch block — a \`let\` declared down there would put every
    // one of those calls in its temporal dead zone.
    let holderProbeDue = 0;
    let holderProbeHeld = 0;
    /** Probes this pass actually STARTED (see the dispatch behind the pairs). */
    let holderProbeStarted = 0;
    /** Probes that settled WITHOUT a count: capped, threw, or no holderCount. */
    let holderProbeMisses = 0;
    const stageNote = () =>`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 2. the note names both shapes
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: probe/miss in the holder segment",
  `      \` holders \${spent.holders.ms}/\${spent.holders.trips}\` +
      \` held\${holdersHeld} cut\${holdersCut}]\`;`,
  `      \` holders \${spent.holders.ms}/\${spent.holders.trips}\` +
      \` held\${holdersHeld} cut\${holdersCut}\` +
      \` probe\${holderProbeStarted} miss\${holderProbeMisses}]\`;`,
);

edit(
  PW,
  "pw: the holder-note comment names probe/miss",
  `    // heal's miss/enrolled pair. The clock is the COLLECT: the probes start
    // behind the pair batch and overlap the row loop (see the holder stage), so
    // a small \`holders\` reading next to \`trips 1\` is the normal shape.`,
  `    // heal's miss/enrolled pair. The clock is the COLLECT: the probes start
    // behind the pair batch and overlap the row loop (see the holder stage), so
    // a small \`holders\` reading next to \`trips 1\` is the normal shape.
    // \`probe\`/\`miss\` close the last of that ambiguity, live-verified
    // 2026-09-23: \`holders 0/0 held0 cut0\` reads either way, because a miss
    // writes nothing AND the row it missed was just checked — it leaves the
    // head of the rotation before its park can ever show up as \`held\`.`,
);

// ---------------------------------------------------------------------------
// src/pushwatch.ts — 3. the dispatch counts what it started
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: the dispatch counts started probes",
  `          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          holderProbeUnsettled.add(r.token);`,
  `          if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
          holderProbeStarted += 1;
          holderProbeUnsettled.add(r.token);`,
);

edit(
  PW,
  "pw: the dispatch block no longer re-declares them",
  `    let holderProbeDue = 0;
    let holderProbeHeld = 0;
    let holderProbeMisses = 0;
    const holderProbeWrites: Array<{`,
  `    const holderProbeWrites: Array<{`,
);

// ---------------------------------------------------------------------------
// scripts/test-unit.js — pin the new fields where they matter
// ---------------------------------------------------------------------------

edit(
  TU,
  "tu: the starvation test names its probes and misses",
  `    assert.match(String(out.note), /holders \\d+\\/1/, \`one batch write for all of them: \${out.note}\`);
    assert.match(String(out.note), /cut0/, \`every due row got its turn: \${out.note}\`);`,
  `    assert.match(String(out.note), /holders \\d+\\/1/, \`one batch write for all of them: \${out.note}\`);
    assert.match(String(out.note), /cut0/, \`every due row got its turn: \${out.note}\`);
    assert.match(String(out.note), /probe4 miss0/, \`all four were started and all four answered: \${out.note}\`);`,
);

edit(
  TU,
  "tu: the no-room test names the zero it starts",
  `    assert.match(String(out.note), /holders \\d+\\/0 held0 cut1/, \`the due row is reported as cut: \${out.note}\`);`,
  `    assert.match(
      String(out.note),
      /held0 cut1 probe0 miss0/,
      \`the due row is reported as cut and no probe was started: \${out.note}\`,
    );`,
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
