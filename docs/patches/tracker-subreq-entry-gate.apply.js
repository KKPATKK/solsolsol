#!/usr/bin/env node
/**
 * The pass needs a gate at the DOOR, not only between its stages.
 *
 * WHY — the live reading that sent me here. The first delivery of the two
 * ceilings (docs/patches/tracker-subreq-budget.apply.js, commit 159af44) put
 * `outOfBudget()` at the two BETWEEN-stage gates and on the row loop, and the
 * live verification four minutes after that deploy showed BOTH halves of the
 * result at once:
 *
 *     14:19:53Z  ok:26/1 rows 26/30 … defer-send 4 undelivered 1 subreq-cut 4
 *                <- the new row gate doing exactly its job
 *     14:18:57Z  err:Too many subrequests by single Worker invocation
 *     14:19:16Z  err:Too many subrequests by single Worker invocation
 *     14:19:33Z  err:Too many subrequests by single Worker invocation
 *     14:20:12Z  err:Too many subrequests by single Worker invocation
 *     14:23:25Z  err:Too many subrequests by single Worker invocation
 *
 * The gap is structural, not a tuning miss. Both gates run AFTER a stage, so a
 * pass ENTERED with less room than that stage's own first read costs still
 * throws inside it — the setup listing is one read, the heal is one, and the
 * head pair batch is one. On a cold isolate the front (init + scan +
 * completion flush) can be at 45 before the pass is offered anything
 * (`heartbeat.subreqs.current` read 47 with its phase ring ending
 * `send:autobuy 46`), and at that point the pass's first listing read is
 * exactly what the runtime refuses. TRACKER_SUBREQ_FLOOR only protected what
 * came AFTER a stage, never entry into it.
 *
 * One gate closes it, and it is the same gate the pass already owns: consult
 * `outOfBudget()` before the setup starts. The cost of a deferral here is one
 * durable note write by the caller, against a pass that would otherwise die
 * having measured nothing — and, on the ticks that used to die, the deferral
 * sync and the write drain behind the pass now run with the invocation's last
 * few subrequests still intact.
 *
 * Residual band, stated rather than hidden: entering the rotation with
 * TRACKER_SUBREQ_FLOOR (3) to 5 left can still leave too little for the
 * pass-note persist that runs AFTER runTick returns. That failure is the
 * instrumented one — it lands as a `writeDrainError` record or an `err:` note,
 * not as a silent hole — so it is left for a measurement to justify widening
 * the gate rather than guessed at here.
 *
 * An apply script because src/pushwatch.ts and the tests at the end of
 * scripts/test-unit.js both sit past the file-tool window; every anchor must
 * match exactly once or nothing is written.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ----------------------------------------------------------- pushwatch.ts --
  {
    file: "src/pushwatch.ts",
    what: "the entry gate: refuse the pass at the door",
    // The marker is a fragment of the text the replacement WRITES, character
    // for character: an earlier version ended this line with a period while the
    // replacement ends it with a comma, so the guard read the patched tree as
    // unpatched and the patch reported MISS on a tree that already had it.
    marker: "// ENTRY gate — the one this pass did not have until 2026-09-24, and",
    anchor: lines(
      "      get trips() {",
      "        return trips;",
      "      },",
      "    };",
      "    // Case-closed recaps: every coin leaving the window gets ONE summary",
    ),
    replacement: lines(
      "      get trips() {",
      "        return trips;",
      "      },",
      "    };",
      "    // ENTRY gate — the one this pass did not have until 2026-09-24, and",
      "    // the one the live `err:Too many subrequests` runs proved it needed.",
      "    // The other two sit BETWEEN stages, which protects what follows a",
      "    // stage but not entry into it: a pass handed less room than a stage's",
      "    // own first read costs throws INSIDE that stage, and the setup listing",
      "    // is one read. Measured after the first delivery of these two",
      "    // ceilings (commit 159af44): the row gate worked (`subreq-cut 4` at",
      "    // 14:19:53Z) while 5 ticks in the same window still died — a cold",
      "    // isolate's front can be at 45 before the pass is offered anything",
      "    // (`heartbeat.subreqs.current` read 47, ring ending `send:autobuy 46`),",
      "    // which makes the pass's first listing the call the runtime refuses.",
      "    //",
      "    // The clock is asked here too, deliberately: it makes this the pass's",
      "    // single entry condition, so a caller cannot start a pass that was",
      "    // already over its deadline on the wall. A deferral here costs one",
      "    // durable note write and no measurement — strictly better than dying",
      "    // having measured nothing.",
      "    if (outOfBudget()) return deferred;",
      "    // Case-closed recaps: every coin leaving the window gets ONE summary",
    ),
  },

  // ------------------------------------------------------- scripts/test-unit --
  {
    file: "scripts/test-unit.js",
    what: "the entry gate, and the between-stage gate it must not replace",
    marker: "the setup never started — the pass is refused at the door",
    anchor: lines(
      "  await test(\"PushWatcher: a starved INVOCATION defers the pass by name (not a starved tick)\", async () => {",
      "    const db = termDb([termRow()]);",
      "    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
      "    // 2 left: below TRACKER_SUBREQ_FLOOR, so the rotation cannot even start —",
      "    // but the pass must say WHICH ceiling stopped it, because \"deferred:\" alone",
      "    // used to mean the clock.",
      "    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 2);",
      "    assert.match(String(out.note), /^deferred:subreq-budget /, \"the note names the ceiling, not just that it deferred\");",
      "    assert.equal(out.checked, 0, \"no row was touched — the pass could not pay for one\");",
      "    assert.equal(db.updated.length, 0, \"and nothing was written on the way out\");",
      "  });",
    ),
    replacement: lines(
      "  // A counter on the listing, because the two gates below are told apart by",
      "  // WHERE the pass stops: the entry gate must fire before the setup's own",
      "  // first read, the between-stage gate after it. Both defer by the same",
      "  // name, so without this the suite could not say which one it had proved.",
      "  const countListings = (db) => {",
      "    const listing = db.listPushWatch;",
      "    const state = { listings: 0 };",
      "    db.listPushWatch = async (...args) => {",
      "      state.listings += 1;",
      "      return listing(...args);",
      "    };",
      "    return state;",
      "  };",
      "",
      "  await test(\"PushWatcher: a starved INVOCATION defers the pass by name (not a starved tick)\", async () => {",
      "    const db = termDb([termRow()]);",
      "    const reads = countListings(db);",
      "    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
      "    // 2 left: below TRACKER_SUBREQ_FLOOR, so the rotation cannot even start —",
      "    // but the pass must say WHICH ceiling stopped it, because \"deferred:\" alone",
      "    // used to mean the clock.",
      "    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 2);",
      "    assert.match(String(out.note), /^deferred:subreq-budget /, \"the note names the ceiling, not just that it deferred\");",
      "    assert.equal(out.checked, 0, \"no row was touched — the pass could not pay for one\");",
      "    assert.equal(db.updated.length, 0, \"and nothing was written on the way out\");",
      "    assert.equal(reads.listings, 0, \"the setup never started — the pass is refused at the door, not inside its first read (the 14:19Z live shape)\");",
      "  });",
      "",
      "  await test(\"PushWatcher: a pass that runs out MID-pass defers at a stage gate, not inside a stage\", async () => {",
      "    const db = termDb([termRow()]);",
      "    const reads = countListings(db);",
      "    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
      "    // Room at the door, gone by the first between-stage gate: the setup HAS",
      "    // run (and its reading is what the real invocation would have spent),",
      "    // so this is the between-stage gate's job — the entry gate must not have",
      "    // swallowed it, and a pass that starts a stage it cannot pay for is the",
      "    // exact throw this change set out to remove.",
      "    let probe = 0;",
      "    const out = await pw.runTick(Date.now() + 5_000, undefined, () => (probe++ === 0 ? 50 : 2));",
      "    assert.match(String(out.note), /^deferred:subreq-budget /, \"the ceiling names itself here too\");",
      "    assert.equal(reads.listings, 1, \"the setup ran — so this is the between-stage gate, not the door\");",
      "    assert.equal(out.checked, 0, \"and the row loop was never entered\");",
      "  });",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard now counts the entry gate as well",
    marker: "// ENTRY, between-stage, between-stage — all three, or the door is open",
    anchor: lines(
      '        (pushwatchSrc.split("if(outOfBudget())returndeferred;").length - 1) === 2 &&',
    ),
    replacement: lines(
      "        // ENTRY, between-stage, between-stage — all three, or the door is open",
      "        // and a starved pass dies inside its own first read (the 14:19Z live",
      "        // shape). Counting the GATE, not the comment that describes it.",
      '        (pushwatchSrc.split("if(outOfBudget())returndeferred;").length - 1) === 3 &&',
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
