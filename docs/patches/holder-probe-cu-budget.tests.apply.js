#!/usr/bin/env node
/**
 * Test half of docs/patches/holder-probe-cu-budget.apply.js.
 *
 * Two edits: the park test needs the CU gap OFF (it runs three passes and
 * expects the third to probe — with the default 60-minute gap the second and
 * third would be gated), and the new test pins the gap itself: a pass inside
 * the gap starts NO probe, says `cu-gate`, and leaves its due rows due (never
 * parked — nothing about them failed).
 *
 * scripts/test-unit.js is far past the file tools' edit window (see
 * docs/round-trips.md §6). Same discipline: every replacement must match
 * EXACTLY once or nothing is written at all.
 */
const fs = require("fs");

const TU = "scripts/test-unit.js";

const edits = [
  {
    name: "the park test probes without the CU gap",
    old:
      "        getTokenOverview: async () => {\n" +
      "          probes += 1;\n" +
      "          // The first probe misses its cap; every later one answers.\n" +
      '          if (probes === 1) return new Promise(() => {});\n' +
      "          return { holderCount: 123 };\n" +
      "        },\n" +
      "      },\n" +
      "      loadConfig({}),",
    next:
      "        getTokenOverview: async () => {\n" +
      "          probes += 1;\n" +
      "          // The first probe misses its cap; every later one answers.\n" +
      '          if (probes === 1) return new Promise(() => {});\n' +
      "          return { holderCount: 123 };\n" +
      "        },\n" +
      "      },\n" +
      "      // The CU gap OFF: this test is about the PARK (three passes, and the\n" +
      "      // third must probe). The gap itself is pinned by its own test below.\n" +
      '      loadConfig({ PUSH_WATCH_HOLDER_MIN_GAP_MIN: "0" }),',
  },
  {
    name: "the new CU-gap test",
    old: '  await test("PushWatcher: a pass with no room for the probes reports its due rows as cut", async () => {',
    next:
      '  await test("PushWatcher: the holder probe keeps a CU gap, so a pass cannot spend the Birdeye budget", async () => {\n' +
      "    // A probe is BILLED whether or not its count lands: /defi/token_overview is\n" +
      "    // 20 CU and the free tier is 30K CU a MONTH — about 50 calls a DAY for the\n" +
      "    // whole bot — while the 1-minute cron probing once a pass would be 1_440\n" +
      "    // calls/day (and 4 probes a pass, the shape before 2026-09-23, 5_760/day).\n" +
      "    // So the stage keeps PUSH_WATCH_HOLDER_MIN_GAP_MIN between probes, stamped\n" +
      "    // durably in worker_state so the cap survives isolate rotation, and a pass\n" +
      "    // inside the gap reports its due rows as `cut` and says `cu-gate`: nothing\n" +
      "    // about those rows failed, so none of them is parked.\n" +
      "    const rows = [watchRow(\"AAA\"), watchRow(\"BBB\")];\n" +
      "    const updated = [];\n" +
      "    const holderWrites = [];\n" +
      "    let probes = 0;\n" +
      "    const db = {\n" +
      "      ...watchDb(rows, updated),\n" +
      "      setPushWatchHoldersMany: async (updates) => {\n" +
      "        for (const u of updates) holderWrites.push([u.token, u.holders]);\n" +
      "      },\n" +
      "    };\n" +
      "    const pw = new PushWatcher(\n" +
      "      db,\n" +
      "      watchBot,\n" +
      "      { getTokenOverview: async () => { probes += 1; return { holderCount: 321 }; } },\n" +
      "      loadConfig({}),\n" +
      "      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),\n" +
      "      null,\n" +
      "    );\n" +
      "    const first = await pw.runTick();\n" +
      "    assert.equal(probes, 1, \"the first pass spends its one probe\");\n" +
      "    assert.equal(holderWrites.length, 1, \"and its count lands\");\n" +
      "    assert.doesNotMatch(String(first.note), /cu-gate/, `nothing was gated: ${first.note}`);\n" +
      "    const second = await pw.runTick();\n" +
      "    assert.equal(probes, 1, \"a pass inside the gap starts no probe at all\");\n" +
      "    assert.match(String(second.note), /cu-gate/, `and says why: ${second.note}`);\n" +
      "    assert.match(\n" +
      "      String(second.note),\n" +
      "      /held0 cut2 probe0 miss0/,\n" +
      "      `the rows that are still due stay due, never parked: ${second.note}`,\n" +
      "    );\n" +
      "  });\n" +
      "\n" +
      '  await test("PushWatcher: a pass with no room for the probes reports its due rows as cut", async () => {',
  },
];

let text = fs.readFileSync(TU, "utf8");
for (const e of edits) {
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      tu: " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS tu: " + e.name);
    process.exit(1);
  }
  text = text.slice(0, first) + e.next + text.slice(first + e.old.length);
  console.log("ok        tu: " + e.name);
}
fs.writeFileSync(TU, text);
