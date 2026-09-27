#!/usr/bin/env node
/*
 * Tests for docs/patches/scan-trigger-via-2026-09-27.apply.js:
 *   1. the fallback's rescue threshold (two missed cadences) and the tick
 *      gate's jitter budget — the two mode invariants (60s scans every tick,
 *      90s still skips every other one) are arithmetic, so they are asserted
 *      here instead of watched live;
 *   2. `via` must travel as a PARAMETER (three call sites name their trigger,
 *      both heartbeats carry it) — the pass's own delivery shares the isolate,
 *      so a module-scope tag would be rewritten under it;
 *   3. the durable counters: read-free increments, one key per trigger, and
 *      the increment rides the completion batch (never a heartbeat-only flush);
 *   4. the existing fallback ORDER pin updated to the new threshold name.
 *
 * Run: node docs/patches/scan-trigger-via-tests-2026-09-27.apply.js
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

// ---------------------------------------------------------------------------
// 1. The existing fallback-order pin: the dedupe threshold changed name.
// ---------------------------------------------------------------------------
edit(
  "pin: the fallback dedupes on the rescue gap",
  `    const dedupe = fallback.indexOf('if(typeofat==="number"&&now-at<SCAN_TRIGGER_INTERVAL_MS)return;');`,
  `    const dedupe = fallback.indexOf('if(typeofat==="number"&&now-at<rescueGapMs)return;');`,
  'now-at<rescueGapMs)return;',
);

edit(
  "pin: and the rescue gap is the two-cadence threshold",
  `    assert.ok(stamp >= 0 && cadence > stamp, "the request's pre-scan slice is still measured from its entry");
    assert.ok(dedupe > cadence, "both early returns come first");`,
  `    assert.ok(stamp >= 0 && cadence > stamp, "the request's pre-scan slice is still measured from its entry");
    assert.ok(dedupe > cadence, "both early returns come first");
    // The dedupe threshold is what makes this a RESCUE (2026-09-27): one
    // cadence made it fire into every minute whose tick was merely late, and
    // 26 of 76 completions in a measured 90-minute window were its scans.
    assert.ok(
      fallback.includes("constrescueGapMs=scanRescueGapMs(scanGapMs);"),
      "the fallback's threshold is the two-missed-cadence rescue gap",
    );`,
  "the fallback's threshold is the two-missed-cadence rescue gap",
);

// ---------------------------------------------------------------------------
// 2. The new tests, appended before the summary block.
// ---------------------------------------------------------------------------
edit(
  "tests: cadence arithmetic + attribution + counters",
  `  console.log("\\n===== UNIT TESTS =====");`,
  `  await test("cadence gates: a rescue needs two missed cadences, and 60s/90s modes stay apart", () => {
    const { scanGateMs, scanRescueGapMs, SCAN_CRON_PERIOD_MS, SCAN_GATE_JITTER_MS } =
      require("../dist/worker.js");
    // 60s (the default): scan on EVERY tick — the gate only refuses a scan
    // that completed less than the jitter budget ago. That is the fix for the
    // measured pattern (2026-09-27: every :2x completion was followed by a
    // ~100s hole because a flat 10s margin read age ~35-45s and skipped).
    assert.equal(scanGateMs(60_000), 60_000 - 30_000);
    assert.equal(SCAN_GATE_JITTER_MS, 30_000, "the jitter budget is the measured one");
    // 90s: only the room above one cron period is available, so the gate stays
    // strictly above 60s and the setting keeps skipping every other tick
    // instead of silently becoming a 60s scan.
    assert.equal(scanGateMs(90_000), 70_000);
    assert.ok(
      scanGateMs(90_000) > SCAN_CRON_PERIOD_MS,
      "an interval longer than the cron period must still gate to every-other tick",
    );
    assert.equal(scanGateMs(300_000), 270_000);
    for (const interval of [60_000, 75_000, 90_000, 120_000, 300_000]) {
      const gate = scanGateMs(interval);
      assert.ok(gate > 0 && gate < interval, \`the threshold sits inside the interval (\${interval})\`);
      assert.equal(gate, scanGateMs(interval), "pure");
    }
    // Below one cron period reads as one cron period (the cron IS the floor).
    assert.equal(scanGateMs(1_000), scanGateMs(60_000));
    // The fallback: two missed cadences, 120s floor — one late tick (<60s) is
    // not a rescue case, which is exactly what stops it taking over a minute
    // the tick still owns.
    assert.equal(scanRescueGapMs(60_000), 120_000);
    assert.equal(scanRescueGapMs(90_000), 180_000);
    assert.equal(scanRescueGapMs(300_000), 600_000);
    assert.ok(scanRescueGapMs(60_000) > scanGateMs(60_000) * 2, "a rescue is never one gate late");
  });

  await test("scan trigger attribution: \\\`via\\\` is a parameter, and every call site names its trigger", () => {
    const workerSrc = fs
      .readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8")
      .replace(/\\s+/g, "");
    // Every path that can scan passes its trigger EXPLICITLY. A default would
    // let a new caller stay silent; the tag is what makes "cron vs fallback"
    // answerable from /health at all (26 of 76 completions were the fallback's
    // in the measured window).
    assert.ok(
      workerSrc.includes('awaitrunScan(hbRaw,env,cronTick,"cron");'),
      "the scheduled tick tags itself cron",
    );
    assert.ok(
      workerSrc.includes('awaitrunScan(hbRaw,env,null,"http");'),
      "the HTTP fallback tags itself http",
    );
    assert.ok(
      workerSrc.includes('awaitrunScan(undefined,env,null,"manual");'),
      "/debug/tick tags itself manual",
    );
    // The tag rides BOTH heartbeats (the scanning row is what a killed tick
    // leaves behind; the done row is what /health serves between ticks), and
    // it comes from the LOCAL, never from module state: the pass's own
    // delivery lands on this isolate and overwrites module-scope readings
    // (measured: a tick's done heartbeat published owner:"pass").
    assert.equal(
      workerSrc.split("via:scanVia,").length - 1,
      2,
      "the scanning heartbeat and the completion payload both carry via",
    );
    assert.ok(workerSrc.includes("constscanVia:ScanTrigger=via;"), "via is captured as a local");
    // ...and the completion batch is told which counter to increment: the tag
    // is the flush call's last argument (whitespace stripped, so the shape is
    // exact), i.e. the same round trip the flush already pays.
    assert.ok(
      workerSrc.includes("scanVia,)??Promise.resolve();"),
      "the flush passes the tag into the completion batch",
    );
    // The counts /health publishes ride the front statement, so the reading
    // costs no extra subrequest — and a cold isolate primes them at boot.
    assert.ok(workerSrc.includes("scanTriggerMirror=parseScanTriggerCounts(kb);"));
    assert.ok(workerSrc.includes("scanTriggerMirror=parseScanTriggerCounts(bootStates);"));
    assert.ok(workerSrc.includes("scanTriggers:scanTriggerMirror,"), "both heartbeats publish the counts");
  });

  await test("Db.scanTriggerStatements / parseScanTriggerCounts: read-free, per trigger, total", () => {
    const { scanTriggerStatements, parseScanTriggerCounts, SCAN_TRIGGER_COUNTER_KEYS } =
      require("../dist/db.js");
    const stmts = scanTriggerStatements("http");
    assert.equal(stmts.length, 2, "insert-or-ignore + increment");
    assert.ok(stmts[0].sql.includes("INSERT OR IGNORE INTO worker_state"));
    assert.ok(stmts[1].sql.includes("CAST(CAST(value AS INTEGER) + 1 AS TEXT)"));
    assert.ok(
      stmts[0].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http) &&
        stmts[1].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http),
      "both statements address the trigger's own row",
    );
    assert.equal(stmts[0].args.length + stmts[1].args.length, 0, "no read, no bind");
    assert.equal(
      new Set(Object.values(SCAN_TRIGGER_COUNTER_KEYS)).size,
      3,
      "one row per trigger — cron can never bump the fallback's counter",
    );
    // Telemetry never throws and never invents a count.
    assert.deepEqual(parseScanTriggerCounts(null), { cron: 0, http: 0, manual: 0 });
    assert.deepEqual(parseScanTriggerCounts(undefined), { cron: 0, http: 0, manual: 0 });
    assert.deepEqual(
      parseScanTriggerCounts(
        new Map([
          [SCAN_TRIGGER_COUNTER_KEYS.cron, "12"],
          [SCAN_TRIGGER_COUNTER_KEYS.http, "junk"],
          [SCAN_TRIGGER_COUNTER_KEYS.manual, "-3"],
        ]),
      ),
      { cron: 12, http: 0, manual: 0 },
    );
  });

  await test("persistScanCompletion: the trigger counter rides the completion batch", async () => {
    const t = tmpDb();
    try {
      const { parseScanTriggerCounts, SCAN_TRIGGER_COUNTER_KEYS } = require("../dist/db.js");
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const at = Date.now();
      const read = async (key) => {
        const rows = await t.client.execute({
          sql: "SELECT value FROM worker_state WHERE key = ?",
          args: [key],
        });
        return rows.rows.length === 0 ? null : Number(rows.rows[0].value);
      };
      // A completed scan counts, in the SAME call that writes its row.
      await db.persistScanCompletion(
        JSON.stringify({ at, ok: true, phase: "done", via: "http" }),
        { at, ok: true, ms: 10, err: null, profiles: 1, pool: 2, candidates: 3, pushed: 4 },
        null,
        "http",
      );
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.cron), null, "the other counters are untouched");
      // A heartbeat-only flush is NOT a scan: no increment.
      await db.persistScanCompletion("x", null, null, "http");
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // No tag at all (an older caller): still no increment, and no throw.
      await db.persistScanCompletion("x", { at: at + 1, ok: true, ms: 5, err: null, profiles: 0, pool: 0, candidates: 0, pushed: 0 });
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1);
      // Cron counts on its own row, and the published snapshot is the trio.
      await db.persistScanCompletion(
        "x",
        { at: at + 2, ok: true, ms: 5, err: null, profiles: 0, pool: 0, candidates: 0, pushed: 0 },
        null,
        "cron",
      );
      const states = await db.getWorkerStates([
        SCAN_TRIGGER_COUNTER_KEYS.cron,
        SCAN_TRIGGER_COUNTER_KEYS.http,
        SCAN_TRIGGER_COUNTER_KEYS.manual,
      ]);
      assert.deepEqual(parseScanTriggerCounts(states), { cron: 1, http: 1, manual: 0 });
      // And the tag itself is durable where /health reads it.
      const hb = await db.getWorkerState("scan_heartbeat");
      assert.equal(JSON.parse(String(hb)).via, "http", "the heartbeat keeps the trigger that wrote it");
    } finally {
      await t.cleanup();
    }
  });

  console.log("\\n===== UNIT TESTS =====");`,
  "cadence gates: a rescue needs two missed cadences",
);

fs.writeFileSync(file, src);
for (const note of notes) console.log(note);
console.log(`\n${notes.filter((n) => n.startsWith(" ✓")).length} patched, ${notes.filter((n) => n.startsWith(" =")).length} already applied`);
