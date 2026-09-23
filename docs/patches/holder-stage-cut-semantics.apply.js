#!/usr/bin/env node
/**
 * Follow-up to docs/patches/holder-stage-probes-early.apply.js, two corrections
 * the first run's test output made concrete.
 *
 * 1. The test I wrote for the "straggler" path cannot happen: the dispatch only
 *    starts a probe whose whole cap fits inside the pass deadline, so the
 *    probe's own cap always fires before the pass deadline and the collector
 *    always waits long enough for it. What IS reachable is the other half of
 *    `cut` — a pass that reaches the stage with less than the cap left starts
 *    NO probe and reports its due rows as cut. That is what the test now pins,
 *    and the code keeps the still-in-flight park as a safety net (starved
 *    timers) instead of describing it as a normal path.
 *
 * 2. The collector's own comment said the same impossible thing.
 *
 * Same discipline as the parent script: every replacement must match EXACTLY
 * ONCE, or the whole run aborts with a non-zero exit and nothing is written.
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
// src/pushwatch.ts
// ---------------------------------------------------------------------------

edit(
  PW,
  "pw: the still-in-flight park is a safety net, not a path",
  `    // Still in flight means nothing was proven, so the row is parked exactly
    // like a probe that missed its cap (only a SUCCESS clears a park) and it
    // counts as cut: it never got a turn inside this pass.
    for (const token of holderProbeUnsettled) {`,
  `    // Still in flight means nothing was proven, so the row is parked exactly
    // like a probe that missed its cap (only a SUCCESS clears a park). This is a
    // SAFETY NET rather than a path: the dispatch above only starts a probe
    // whose whole cap fits inside the pass deadline, so the probe's own cap
    // always fires first and the wait below always covers it — unless the event
    // loop starved the timers, which is precisely the case that must not end
    // with a row looking checked when no count ever arrived.
    for (const token of holderProbeUnsettled) {`,
);

edit(
  PW,
  "pw: cut means no turn, not an abandoned probe",
  `    // keep their meanings: held = rows already parked by an earlier miss, cut =
    // due rows this pass got no count out of (never started, or still in flight
    // when the pass moved on).`,
  `    // keep their meanings: held = rows already parked by an earlier miss, cut =
    // due rows this pass got no count out of (no room to start their probe, or —
    // only when the timers were starved — a probe still in flight).`,
);

// ---------------------------------------------------------------------------
// scripts/test-unit.js — replace the impossible straggler test
// ---------------------------------------------------------------------------

edit(
  TU,
  "tu: pin the reachable half of cut (no room to start)",
  `  await test("PushWatcher: a probe still in flight when the pass ends is parked and counted as cut", async () => {
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
  });`,
  `  await test("PushWatcher: a pass with no room for the probes reports its due rows as cut", async () => {
    // \`cut\` keeps the meaning it had before the probes moved: due rows this pass
    // got NO count out of. The probes still only start when the whole cap fits
    // inside the pass deadline (that is what the row loop protects), so a pass
    // that reaches the stage with less than the cap left starts nothing — the
    // shape the live starvation hid as \`holders 0/0 held0 cut4\` on every pass.
    const rows = [watchRow("AAA")];
    const updated = [];
    let probes = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      watchBot,
      { getTokenOverview: async () => { probes += 1; return { holderCount: 321 }; } },
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    // 1s allowance: less than the 1200ms cap a probe needs, so none starts.
    const out = await pw.runTick(Date.now() + 1_000);
    assert.equal(probes, 0, "a probe with no room for its cap is never started");
    assert.equal(pw.holdersFailedAt.has("AAA"), false, "and nothing is parked for a probe that never ran");
    assert.match(String(out.note), /holders \\d+\\/0 held0 cut1/, \`the due row is reported as cut: \${out.note}\`);
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
