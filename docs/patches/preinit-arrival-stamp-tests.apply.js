#!/usr/bin/env node
/**
 * Tests for the pre-init cron-arrival stamp (2026-09-24).
 *
 * Three properties, each of which is silent if wrong:
 *   1. the stamp is ONE round trip and NO read (it runs in FRONT of init on the
 *      ticks whose front is already suspect, so it may not spend the
 *      invocation's 50-subrequest budget on a read the way the pre-§1 standalone
 *      bump did);
 *   2. the rule that decides WHEN to stamp: a cold or stale isolate stamps, a
 *      warm one whose last scheduled tick returned pays nothing;
 *   3. the wiring in src/worker.ts: the stamp really sits before
 *      ensureInitialized, every return path moves the flag, and both endpoints
 *      publish the pair — all of it, or none of it.
 *
 * An apply script because scripts/test-unit.js is past the file-tool window.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const anchor = lines('  console.log("\\n===== UNIT TESTS =====");');

const tests = lines(
  "  // ---------- pre-init cron-arrival stamp (src/db.ts + src/worker.ts) ----------",
  "  //",
  "  // The arrival record the worker keeps rides the scan-lock claim, and every",
  "  // path that cannot reach a claim writes it on its own — but ALL of them need",
  "  // init to have run. A tick killed inside init therefore recorded NOTHING, and",
  "  // a stretch of them read exactly like \"the Cron Trigger stopped delivering\":",
  "  // the sampled ring froze for 19 minutes (2026-09-23 23:43:26 -> 00:02:26Z) and",
  "  // again for 2h42m (20:21:26 -> 23:03:26Z) while scans kept landing every ~70s",
  "  // (the HTTP monitor's fallback), and the counter moved 54_546 -> 54_846 over",
  "  // a 10h window — about half of the expected beats were never recorded.",
  "",
  '  await test("Db.stampScheduledArrival: one read-free round trip, the counter in SQL", async () => {',
  "    const t = tmpDb();",
  "    let executes = 0;",
  "    let batches = 0;",
  "    let statements = 0;",
  "    const counting = {",
  "      execute: (a) => { executes++; return t.client.execute(a); },",
  "      batch: (a, m) => { batches++; statements += a.length; return t.client.batch(a, m); },",
  "      close: () => t.client.close(),",
  "    };",
  '    const db = new Db("file:injected", undefined, counting);',
  "    await db.init();",
  "    executes = 0;",
  "    batches = 0;",
  "    statements = 0;",
  "    await db.stampScheduledArrival(1_700_000_000_000);",
  '    assert.equal(executes, 0, "the stamp must not read: it runs where the front is already suspect");',
  '    assert.equal(batches, 1, "the stamp is ONE round trip");',
  '    assert.equal(statements, 3, "counter init + increment + timestamp ride that one batch");',
  "    const first = await db.getWorkerStates([",
  '      "scheduled_arrival_total",',
  '      "scheduled_arrival_at",',
  "    ]);",
  '    assert.equal(first.get("scheduled_arrival_total"), "1", "the counter moves in SQL, with no read");',
  '    assert.equal(first.get("scheduled_arrival_at"), "1700000000000");',
  "    // The wedge shape: a dying isolate stamps EVERY arrival it receives (its",
  "    // flag cannot move until a tick returns), so the counter keeps climbing and",
  "    // the timestamp moves — the pair the reader compares against the claim-riding",
  "    // record to tell \"cron is delivering into a dying front\" from \"cron is gone\".",
  "    await db.stampScheduledArrival(1_700_000_060_000);",
  "    const second = await db.getWorkerStates([",
  '      "scheduled_arrival_total",',
  '      "scheduled_arrival_at",',
  "    ]);",
  '    assert.equal(second.get("scheduled_arrival_total"), "2");',
  '    assert.equal(second.get("scheduled_arrival_at"), "1700000060000");',
  "    await t.cleanup();",
  "  });",
  "",
  '  await test("worker: the pre-init stamp fires only for an arrival whose predecessor never returned", () => {',
  '    const { shouldStampArrival, SCHEDULED_ARRIVAL_SUSPECT_GAP_MS } = require("../dist/worker.js");',
  "    const now = 1_700_000_000_000;",
  '    // 0 is "never finished here", NOT "finished at the epoch": a cold isolate',
  "    // has no proven return to point at, so its arrival is always suspect.",
  "    assert.equal(shouldStampArrival(0, now), true);",
  "    assert.equal(shouldStampArrival(Number.NaN, now), true);",
  "    // A warm isolate whose last scheduled tick returned one cadence ago pays",
  "    // NOTHING — the whole reason this design has no unconditional round trip.",
  "    assert.equal(shouldStampArrival(now - 60_000, now), false);",
  "    assert.equal(",
  "      shouldStampArrival(now - SCHEDULED_ARRIVAL_SUSPECT_GAP_MS, now),",
  "      false,",
  '      "at the bound the gap alone is not a death",',
  "    );",
  "    assert.equal(shouldStampArrival(now - (SCHEDULED_ARRIVAL_SUSPECT_GAP_MS + 1), now), true);",
  "    // The shortest death chain there is (ONE lost arrival = ~60s of flag) has to",
  "    // be caught, so the gap must stay under two cron cadences.",
  "    assert.ok(",
  "      SCHEDULED_ARRIVAL_SUSPECT_GAP_MS < 120_000,",
  '      "a single lost arrival must pass the suspect gap",',
  "    );",
  "  });",
  "",
  '  await test("out-of-window patch: the pre-init arrival stamp is wired before init", () => {',
  "    const strip = (text) =>",
  "      text",
  "        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, \"\")",
  "        .replace(/\\/\\/[^\\n]*/g, \"\")",
  '        .replace(/\\s+/g, "");',
  "    const workerSrc = strip(fs.readFileSync(path.join(__dirname, \"..\", \"src/worker.ts\"), \"utf8\"));",
  "    const dbSrc = strip(fs.readFileSync(path.join(__dirname, \"..\", \"src/db.ts\"), \"utf8\"));",
  "    // The GATE, not merely a mention of the rule: the stripped whitespace turns",
  "    // the call into `if(shouldStampArrival(...)){`, so a condition that is",
  "    // present but neutralised (or moved out of the gate) still fails here.",
  "    const stampCall = workerSrc.indexOf(\"if(shouldStampArrival(scheduledTickFinishedAt,cronAt)){\");",
  "    const scheduledInit = workerSrc.indexOf(\"constinitAt=Date.now();awaitensureInitialized(env);\");",
  "    const flagSets = workerSrc.split(\"scheduledTickFinishedAt=Date.now()\").length - 1;",
  "    const applied = {",
  '      "db (stampScheduledArrival)": dbSrc.includes("asyncstampScheduledArrival(at:number):Promise<void>{"),',
  '      "worker (the rule)": workerSrc.includes("exportfunctionshouldStampArrival("),',
  '      "worker (stamp BEFORE init)":',
  "        stampCall >= 0 && scheduledInit >= 0 && stampCall < scheduledInit,",
  '      "worker (every return moves the flag)": flagSets >= 3,',
  '      "worker (the cold-isolate fallback)": workerSrc.includes("newDb(env.TURSO_DATABASE_URL,env.TURSO_AUTH_TOKEN).stampScheduledArrival("),',
  '      "health (the pair is published)": workerSrc.includes("scheduledArrivalUnaccounted:"),',
  "    };",
  "    const done = Object.entries(applied).filter(([, v]) => v);",
  "    if (done.length === 0) {",
  "      console.log(",
  '        "  ℹ pre-init arrival stamp missing - apply docs/patches/preinit-arrival-stamp.apply.js",',
  "      );",
  "      return;",
  "    }",
  "    const missing = Object.entries(applied)",
  "      .filter(([, v]) => !v)",
  "      .map(([k]) => k);",
  "    // A partial paste is the dangerous state, in both directions: a stamp with",
  "    // no reader is invisible, and a reader with no stamp reports a frozen pair",
  "    // that looks exactly like the blindness this change exists to remove.",
  "    assert.equal(",
  "      missing.length,",
  "      0,",
  "      `partial application is unsafe - missing: ${missing.join(\", \")} (see docs/patches/preinit-arrival-stamp.apply.js)`,",
  "    );",
  "  });",
  "",
  anchor,
);

let text = fs.readFileSync(T, "utf8");
if (text.includes("Db.stampScheduledArrival: one read-free round trip")) {
  console.error("ALREADY   test-unit: the pre-init arrival stamp tests");
  process.exit(1);
}
if (text.indexOf(anchor) < 0) {
  console.error("MISS      test-unit: the UNIT TESTS summary anchor");
  process.exit(1);
}
if (text.indexOf(anchor, text.indexOf(anchor) + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the UNIT TESTS summary anchor");
  process.exit(1);
}
text = text.replace(anchor, tests);
fs.writeFileSync(T, text);
console.log("ok        test-unit: 3 pre-init arrival stamp tests");
