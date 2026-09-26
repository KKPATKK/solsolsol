/*
 * /health's ONE read, and the counter rule it must share (2026-09-26).
 *
 * WHY THIS IS A FILE OF ITS OWN: the merge's failure mode is not a crash, it is
 * a page that keeps working while quietly paying the round trips the change
 * exists to remove — or, worse, serving a telemetry count that the heal path
 * would have corrected. Both are asserted here instead of only observed live.
 * scripts/test-unit.js is past the editing window, so this guard lives beside
 * the other standalone suites and runs from `npm run test:unit`.
 *
 * WHAT IS PINNED:
 *   1. `readHealthFront` is ONE batch and zero executes, and its second
 *      statement really counts only the ENABLED chats (the listing's length was
 *      all /health ever used, so a disabled row must not appear in the count).
 *   2. The telemetry-counter rule is one function, and it treats the three
 *      states differently: a served value, a DRIFTED (negative) one that must be
 *      re-derived from the live COUNT(*), and an absent one that must be too —
 *      the self-heal that observed telemetry_token_stats_count = -3105.
 *   3. The /health handler really passes those keys to the front, and the four
 *      single-key reads it used to pay are gone from the source: a merge that
 *      keeps the old calls is decoration, and no live reading can tell you which
 *      of two requests paid for a row.
 *
 * Run: node scripts/test-health-front.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const {
  Db,
  parseTelemetryCounter,
  telemetryCounterUsable,
} = require("../dist/db.js");

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

function tmpDb() {
  const p = path.join(
    os.tmpdir(),
    `health-front-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${p}` });
  return {
    p,
    client,
    cleanup: async () => {
      await client.close();
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * A client that reports what the page asked for. `executes` is the number that
 * matters: a read that fell back to single-row calls would still "work" and
 * still return the right page.
 */
function countingClient(client) {
  const seen = { batches: 0, statements: 0, executes: 0, sql: [] };
  return {
    seen,
    execute: (a) => {
      seen.executes++;
      seen.sql.push(String(a.sql).replace(/\s+/g, " ").slice(0, 80));
      return client.execute(a);
    },
    batch: (a) => {
      seen.batches++;
      seen.statements += a.length;
      return client.batch(a);
    },
    close: () => client.close(),
  };
}

async function main() {
  // ---------- the counter rule ----------
  await test("parseTelemetryCounter: integer-shaped rows only, negatives kept", () => {
    assert.equal(parseTelemetryCounter("12"), 12);
    assert.equal(parseTelemetryCounter("-3105"), -3105, "the drifted value is kept — it is the heal's signal");
    assert.equal(parseTelemetryCounter("0"), 0);
    assert.equal(parseTelemetryCounter(null), null, "an absent row is not zero");
    assert.equal(parseTelemetryCounter(undefined), null);
    assert.equal(parseTelemetryCounter(""), null);
    assert.equal(parseTelemetryCounter("abc"), null);
    assert.equal(parseTelemetryCounter("1.5"), null, "a counter is an integer row");
    assert.equal(parseTelemetryCounter("12abc"), null);
  });

  await test("telemetryCounterUsable: absent and negative both mean re-derive", () => {
    assert.equal(telemetryCounterUsable(0), true, "zero is a real reading");
    assert.equal(telemetryCounterUsable(12), true);
    assert.equal(telemetryCounterUsable(-1), false);
    assert.equal(telemetryCounterUsable(null), false);
  });

  // ---------- the page's one read, against a real database ----------
  await test("readHealthFront: ONE batch, zero executes, enabled chats only", async () => {
    const t = tmpDb();
    const counting = countingClient(t.client);
    const db = new Db("file:injected", undefined, counting);
    // The REAL schema, not a hand-made one: Db.get() refuses a read before
    // init, and seeding through the real API is what keeps this test honest
    // about the columns the page's statements actually touch. init()'s own
    // trips are not what this test measures, so the counters are reset after
    // the seeding and before the call under test.
    await db.init();
    await db.setWorkerState("push_watch_pass", '{"rows":15}');
    await db.setWorkerState("telemetry_token_stats_count", "42");
    await t.client.batch(
      [
        { sql: `INSERT INTO chat_settings (chat_id, enabled) VALUES ('on-1', 1)`, args: [] },
        { sql: `INSERT INTO chat_settings (chat_id, enabled) VALUES ('on-2', 1)`, args: [] },
        { sql: `INSERT INTO chat_settings (chat_id, enabled) VALUES ('off-1', 0)`, args: [] },
      ],
      "write",
    );
    counting.seen.batches = 0;
    counting.seen.statements = 0;
    counting.seen.executes = 0;
    counting.seen.sql = [];
    const front = await db.readHealthFront([
      "push_watch_pass",
      "telemetry_token_stats_count",
      // A key nothing writes: presence in the map is what says the row was READ,
      // so a row that does not exist must be missing from it. (Both telemetry
      // counters are seeded by init itself, so neither can stand in for this
      // case — that is why the probe key is here rather than one of them.)
      "health_front_absent_probe",
    ]);
    assert.equal(counting.seen.batches, 1, "the front must be exactly ONE request");
    assert.equal(counting.seen.statements, 2, "the key list plus the chats count");
    assert.equal(
      counting.seen.executes,
      0,
      `no single-row fallback (paid for: ${counting.seen.sql.join(" | ")})`,
    );
    assert.equal(front.states.get("push_watch_pass"), '{"rows":15}');
    assert.equal(front.states.get("telemetry_token_stats_count"), "42");
    assert.equal(
      front.states.has("health_front_absent_probe"),
      false,
      "a row that does not exist must be ABSENT from the map, not empty — presence is what says the read happened",
    );
    assert.equal(front.enabledChats, 2, "the disabled chat must not be counted");
    await t.cleanup();
  });

  await test("countTokenStats: the heal still overrides a drifted (negative) row", async () => {
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    // The drifted state, observed live at -3105: the incremental bumps walked
    // past zero across isolates, so every later bump is off too.
    await db.setWorkerState("telemetry_token_stats_count", "-3105");
    await t.client.batch(
      [
        {
          sql: `INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms)
                VALUES ('A', 1, 1, 1, 1)`,
          args: [],
        },
        {
          sql: `INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms)
                VALUES ('B', 1, 1, 1, 1)`,
          args: [],
        },
      ],
      "write",
    );
    const healed = await db.countTokenStats();
    assert.equal(healed, 2, "a negative row must be re-derived from the live COUNT(*), not served");
    assert.equal(
      await db.getWorkerState("telemetry_token_stats_count"),
      "2",
      "and the heal must re-seed the row so later bumps start from truth",
    );
    await t.cleanup();
  });

  // ---------- the wiring, in the source that has to pay for it ----------
  await test("src/worker.ts: /health passes the keys to the front and keeps no single read", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8");
    const open = src.indexOf("readHealthFront([");
    assert.ok(open > 0, "the handler must call readHealthFront");
    const call = src.slice(open, open + src.slice(open).indexOf("]);"));
    for (const key of [
      "push_watch_pass",
      "telemetry_token_stats_count",
      "telemetry_seen_tokens_count",
    ]) {
      assert.ok(call.includes(`"${key}"`), `the front's key list must carry ${key}`);
    }
    for (const gone of [
      'await db?.getWorkerState("push_watch_pass")',
      "enabledChats = (await db?.listEnabledChats())?.length ?? null;",
      "tokenStatsCount = (await db?.countTokenStats()) ?? null;",
      "pushedTotal = (await db?.countSeenTokens()) ?? null;",
    ]) {
      assert.equal(
        src.includes(gone),
        false,
        `${gone} is still paid for — the merge is decoration until it is gone`,
      );
    }
    // The heal must survive as the ONLY remaining caller of each counter, or a
    // drifted row is served as a number.
    assert.equal((src.match(/await db\?\.countTokenStats\(\)/g) ?? []).length, 1);
    assert.equal((src.match(/await db\?\.countSeenTokens\(\)/g) ?? []).length, 1);
  });

  console.log(results.join("\n"));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("health-front suite crashed:", err);
  process.exit(1);
});
