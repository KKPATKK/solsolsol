#!/usr/bin/env node
/*
 * Two follow-ups for docs/patches/scan-trigger-via-tests-2026-09-27.apply.js:
 *
 *  1. The round-6.4 pin asserts the BOOT_STATE_KEYS initialiser as one exact
 *     string. The counters join that list (`...SCAN_TRIGGER_STATE_KEYS`), so the
 *     pin is split into "the four boot rows are still there" + "the counters
 *     ride the same list" — the same two facts, without pinning the comment
 *     text between them.
 *  2. The new persistScanCompletion test wrote the literal "x" as a heartbeat
 *     and then JSON-parsed it back. "x" is not JSON, so the assertion threw.
 *     Use a real heartbeat payload instead (the point of that assertion is the
 *     `via` field, which needs a parseable row to read).
 *
 * Run: node docs/patches/scan-trigger-via-test-fixes-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");
const notes = [];

function edit(name, find, next, marker) {
  if (src.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  src = src.replace(find, next);
  notes.push(` ✓ ${name} — patched`);
}

edit(
  "pin: the boot rows plus the counters that ride the same list",
  `      "worker (the four boot rows ride the front's ONE statement)":
        workerSrc.includes(
          'exportconstBOOT_STATE_KEYS=["axiom_access_token",PUSH_DEFERRAL_STATE_KEY,PUSH_LEDGER_STATE_KEY,SKIP_CAPTURE_STATE_KEY,];',
        ) &&
        workerSrc.includes("...BOOT_STATE_KEYS,];"),`,
  `      "worker (the four boot rows ride the front's ONE statement)":
        workerSrc.includes(
          'exportconstBOOT_STATE_KEYS=["axiom_access_token",PUSH_DEFERRAL_STATE_KEY,PUSH_LEDGER_STATE_KEY,SKIP_CAPTURE_STATE_KEY,',
        ) &&
        // ...and the per-trigger scan counters ride the same list (2026-09-27):
        // a recycled isolate answers "cron vs fallback" from the same read.
        workerSrc.includes("...SCAN_TRIGGER_STATE_KEYS,];") &&
        workerSrc.includes("...BOOT_STATE_KEYS,];"),`,
  "the per-trigger scan counters ride the same list",
);

edit(
  "test: the counter test parses its own heartbeat",
  `      // A heartbeat-only flush is NOT a scan: no increment.
      await db.persistScanCompletion("x", null, null, "http");
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // No tag at all (an older caller): still no increment, and no throw.
      await db.persistScanCompletion("x", { at: at + 1, ok: true, ms: 5, err: null, profiles: 0, pool: 0, candidates: 0, pushed: 0 });
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // Cron counts on its own row, and the published snapshot is the trio.
      await db.persistScanCompletion(
        "x",`,
  `      // A heartbeat-only flush is NOT a scan: no increment (the payload is a
      // real heartbeat, because the last assertion parses the row back).
      await db.persistScanCompletion(
        JSON.stringify({ at: at + 1, ok: true, phase: "scanning", via: "http" }),
        null,
        null,
        "http",
      );
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // No tag at all (an older caller): still no increment, and no throw.
      await db.persistScanCompletion(
        JSON.stringify({ at: at + 2, ok: true, phase: "scanning" }),
        { at: at + 1, ok: true, ms: 5, err: null, profiles: 0, pool: 0, candidates: 0, pushed: 0 },
      );
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // Cron counts on its own row, and the published snapshot is the trio.
      await db.persistScanCompletion(
        JSON.stringify({ at: at + 3, ok: true, phase: "done", via: "cron" }),`,
  "the counter test parses its own heartbeat",
);

edit(
  "test: the tag read back is the cron row's",
  `      assert.equal(JSON.parse(String(hb)).via, "http", "the heartbeat keeps the trigger that wrote it");`,
  `      assert.equal(
        JSON.parse(String(hb)).via,
        "cron",
        "the heartbeat keeps the trigger that wrote it (the last flush was cron)",
      );`,
  "the heartbeat keeps the trigger that wrote it (the last flush was cron)",
);

fs.writeFileSync(file, src);
for (const note of notes) console.log(note);
console.log(`\n${notes.filter((n) => n.startsWith(" ✓")).length} patched, ${notes.filter((n) => n.startsWith(" =")).length} already applied`);
