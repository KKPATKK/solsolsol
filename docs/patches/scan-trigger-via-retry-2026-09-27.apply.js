#!/usr/bin/env node
/*
 * The completion flush is RETRIED when its first attempt does not settle in
 * time (see Db.persistScanCompletion's caller): the batch is re-sent, and the
 * comment there says exactly why that is safe — the heartbeat is an upsert and
 * the history row deletes-then-inserts, so "a first attempt that commits late
 * can never produce a duplicate".
 *
 * A bare `value + 1` breaks that promise: a first attempt that COMMITTED but
 * lost its response would count the same scan twice on the retry. So the
 * increment is gated on the completion's own `at` — the scan_history key the
 * batch already carries — and the guard row is written in the same batch after
 * it. Same three statements, same single round trip, idempotent.
 *
 * Run: node docs/patches/scan-trigger-via-retry-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const notes = [];

function edit(file, name, find, next, marker) {
  const p = path.join(root, file);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  src = src.replace(find, next);
  fs.writeFileSync(p, src);
  notes.push(` ✓ ${name} — patched`);
}

edit(
  "src/db.ts",
  "db: the counter is idempotent per completion",
  `/**
 * Increment one trigger's counter as READ-FREE statements, on the same
 * discipline as scheduledTickStatements: they ride the completion batch the
 * tick already pays for (see persistScanCompletion), so attribution costs
 * ZERO extra round trips — and the row is durable, so it survives the isolate
 * that produced it.
 */
export function scanTriggerStatements(
  via: ScanTrigger,
): Array<{ sql: string; args: Array<string | number | null> }> {
  const key = SCAN_TRIGGER_COUNTER_KEYS[via];
  return [
    {
      // The row must exist before the UPDATE can increment it.
      sql: \`INSERT OR IGNORE INTO worker_state (key, value) VALUES ('\${key}', '0')\`,
      args: [],
    },
    {
      sql: \`UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = '\${key}'\`,
      args: [],
    },
  ];
}`,
  `/**
 * The completion timestamp of the last COUNTED scan (see
 * scanTriggerStatements): the idempotence key for a retried flush, and a
 * reading of its own — it is the \`at\` of the newest scan_history row the
 * counters account for.
 */
export const SCAN_TRIGGER_GUARD_KEY = "scan_trigger_last_at";

/**
 * Increment one trigger's counter as READ-FREE statements, on the same
 * discipline as scheduledTickStatements: they ride the completion batch the
 * tick already pays for (see persistScanCompletion), so attribution costs
 * ZERO extra round trips — and the row is durable, so it survives the isolate
 * that produced it.
 *
 * IDEMPOTENT UNDER THE FLUSH RETRY, which is the reason for \`at\`: the retry
 * re-sends the SAME batch (a first attempt that committed but lost its response
 * must not count the scan twice), and the other statements in that batch are
 * idempotent for the same reason (upsert heartbeat, delete-then-insert history).
 * The increment is therefore gated on the completion's own \`at\` and the guard
 * row is written after it, in the same transaction.
 */
export function scanTriggerStatements(
  via: ScanTrigger,
  at: number,
): Array<{ sql: string; args: Array<string | number | null> }> {
  const key = SCAN_TRIGGER_COUNTER_KEYS[via];
  return [
    {
      // The row must exist before the UPDATE can increment it.
      sql: \`INSERT OR IGNORE INTO worker_state (key, value) VALUES ('\${key}', '0')\`,
      args: [],
    },
    {
      // NULL guard (first ever completion) IS NOT the stamp -> counts; the
      // same stamp again (the retry) -> no-op.
      sql: \`UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
             WHERE key = '\${key}'
               AND (SELECT value FROM worker_state WHERE key = '\${SCAN_TRIGGER_GUARD_KEY}') IS NOT ?\`,
      args: [String(at)],
    },
    {
      sql: \`INSERT INTO worker_state (key, value) VALUES ('\${SCAN_TRIGGER_GUARD_KEY}', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value\`,
      args: [String(at)],
    },
  ];
}`,
  "export const SCAN_TRIGGER_GUARD_KEY",
);

edit(
  "src/db.ts",
  "db: the guard gets the completion's at",
  `    if (via !== null && history !== null) {
      // Attribution rides the flush (see ScanTrigger): zero extra round trips,
      // and only a completion that is being written is counted.
      ops.push(...scanTriggerStatements(via));
    }`,
  `    if (via !== null && history !== null) {
      // Attribution rides the flush (see ScanTrigger): zero extra round trips,
      // and only a completion that is being written is counted — keyed on its
      // own \`at\` so a retried flush cannot count it twice.
      ops.push(...scanTriggerStatements(via, history.at));
    }`,
  "ops.push(...scanTriggerStatements(via, history.at));",
);

// ---------------------------------------------------------------------------
// Tests: the statement shape (three statements, guard arg) and the retry.
// ---------------------------------------------------------------------------
edit(
  "scripts/test-unit.js",
  "test: statement shape + guard",
  `    const stmts = scanTriggerStatements("http");
    assert.equal(stmts.length, 2, "insert-or-ignore + increment");
    assert.ok(stmts[0].sql.includes("INSERT OR IGNORE INTO worker_state"));
    assert.ok(stmts[1].sql.includes("CAST(CAST(value AS INTEGER) + 1 AS TEXT)"));
    assert.ok(
      stmts[0].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http) &&
        stmts[1].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http),
      "both statements address the trigger's own row",
    );
    assert.equal(stmts[0].args.length + stmts[1].args.length, 0, "no read, no bind");`,
  `    const stmts = scanTriggerStatements("http", 1_700_000_000_000);
    assert.equal(stmts.length, 3, "insert-or-ignore + gated increment + guard stamp");
    assert.ok(stmts[0].sql.includes("INSERT OR IGNORE INTO worker_state"));
    assert.ok(stmts[1].sql.includes("CAST(CAST(value AS INTEGER) + 1 AS TEXT)"));
    assert.ok(
      stmts[0].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http) &&
        stmts[1].sql.includes(SCAN_TRIGGER_COUNTER_KEYS.http),
      "both statements address the trigger's own row",
    );
    // The increment is gated on the completion's own timestamp, so a retried
    // flush (same batch, same \`at\`) cannot count the same scan twice.
    assert.ok(stmts[1].sql.includes("IS NOT ?") && stmts[1].args[0] === "1700000000000");
    assert.ok(stmts[2].sql.includes("ON CONFLICT(key)"), "the guard is stamped last");
    assert.equal(stmts[0].args.length + stmts[2].args.length, 1, "no read; one bind for the guard");`,
  "insert-or-ignore + gated increment + guard stamp",
);

edit(
  "scripts/test-unit.js",
  "test: a retried flush cannot double-count",
  `      // A heartbeat-only flush is NOT a scan: no increment (the payload is a`,
  `      // THE RETRY: the identical completion (same \`at\`, same trigger) is
      // written again — which is exactly what the flush's second attempt does
      // when the first one committed but lost its response. It must NOT count
      // twice.
      await db.persistScanCompletion(
        "x",
        { at, ok: true, ms: 10, err: null, profiles: 1, pool: 2, candidates: 3, pushed: 4 },
        null,
        "http",
      );
      assert.equal(await read(SCAN_TRIGGER_COUNTER_KEYS.http), 1, "a retried flush is not a second scan");
      // A heartbeat-only flush is NOT a scan: no increment (the payload is a`,
  "a retried flush is not a second scan",
);
for (const note of notes) console.log(note);
console.log(`\n${notes.filter((n) => n.startsWith(" ✓")).length} patched, ${notes.filter((n) => n.startsWith(" =")).length} already applied`);
