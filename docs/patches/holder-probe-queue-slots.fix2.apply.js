#!/usr/bin/env node
/**
 * Second correction to docs/patches/holder-probe-queue-slots.apply.js: the
 * hanging-probe test pinned the OLD cap (a hanging probe returned at ~1_200ms),
 * which is exactly the number this change moves — the cap now carries one gate
 * on top of the fetch. The test keeps its bound (under 2_000ms) by pumping the
 * gate down to 200ms instead of using the live 1_100, and gains the lower bound
 * that pins the gate as part of the cap.
 */
const fs = require("fs");

const TU = "scripts/test-unit.js";

const old = `    // The holder probe is purely additive (nothing is reserved before it and
    // holders_checked_at is only written on success), so a miss costs nothing
    // beyond its own cap and never holds the pass open — the row is parked for
    // TRACKER_HOLDER_BACKOFF_MS instead of re-burning the cap next tick (see
    // the park test below).
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
    const t0 = Date.now();
    const out = await pw.runTick();
    const elapsed = Date.now() - t0;
    assert.equal(probes, 1, "the probe is attempted once");
    assert.equal(out.checked, 1);
    assert.ok(elapsed < 2_000, \`the pass must return near the holder cap, took \${elapsed}ms\`);`;

const next = `    // The holder probe is purely additive (nothing is reserved before it and
    // holders_checked_at is only written on success), so a miss costs nothing
    // beyond its own cap and never holds the pass open — the row is parked for
    // TRACKER_HOLDER_BACKOFF_MS instead of re-burning the cap next tick (see
    // the park test below). The cap is the fetch plus ONE gate (they all queue
    // behind the shared Birdeye throttle — see TRACKER_HOLDER_STAGE_MS), so a
    // 200ms gate keeps the test quick while still pinning that the gate is IN
    // the cap: the bare fetch number is what collected three of four live
    // probes as misses (\`probe4 miss3\`).
    const rows = [watchRow("AAA")];
    const updated = [];
    let probes = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      watchBot,
      { getTokenOverview: async () => { probes += 1; return new Promise(() => {}); } },
      loadConfig({ BIRDEYE_REQUEST_INTERVAL_MS: "200" }),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const t0 = Date.now();
    const out = await pw.runTick();
    const elapsed = Date.now() - t0;
    assert.equal(probes, 1, "the probe is attempted once");
    assert.equal(out.checked, 1);
    assert.ok(
      elapsed >= 1_300,
      \`the cap carries the 200ms gate (1200 + 200), took \${elapsed}ms\`,
    );
    assert.ok(elapsed < 2_000, \`the pass must return near the holder cap, took \${elapsed}ms\`);`;

const text = fs.readFileSync(TU, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      tu: the hanging-probe test pays the gate too");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS tu: the hanging-probe test pays the gate too");
  process.exit(1);
}
fs.writeFileSync(TU, text.slice(0, first) + next + text.slice(first + old.length));
console.log(`ok        ${TU} (${fs.statSync(TU).size} bytes)`);
