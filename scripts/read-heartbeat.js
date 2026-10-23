#!/usr/bin/env node
/*
 * The production tick's own telemetry, read WITHOUT the Worker's help.
 *
 * WHY THIS EXISTS. The tick's per-step readings (`dbSteps`, `modeRead`,
 * `preTick`) are published in the completion summary, which is durable — it
 * lands in worker_state.scan_heartbeat with the flush batch. The obvious way to
 * read them is /health, and that is exactly the way that lies: /health and
 * /debug/* are Worker invocations on the SAME isolate, they read the same
 * worker_state keys (`scan_heartbeat`, `trade_mode_override`, ...) through the
 * same per-isolate step counter, and `dbSteps` is MODULE state — so a probe
 * request can add the very round trips it is trying to count (or hide them, by
 * warming the override's cache before the tick's prefetch runs). Reading the
 * row from outside the Worker is the only reading that cannot move the number
 * it reports, which is the same reason scripts/cpu-profile.js refuses to write.
 *
 * IT READS D1 (2026-10-22, the whole point of this edit). It used to build
 * `new Db(config.tursoUrl, ...)`, i.e. the READ-ONLY Turso archive — so "the
 * production heartbeat" was a frozen row and the output never named its store,
 * so nobody could tell. Run live 2026-10-22 01:47:53Z it printed
 * `@ 2026-10-22T01:20:45Z ageS=88097` while /health's D1 row read
 * `at 2026-10-23T01:41:40Z`: the probe was a day behind production and looked
 * healthy. Now D1 by default — the same REST binding + src/d1.ts transport the
 * migration and scripts/raydium-attribution.js use, so the SQL runs through the
 * pair production runs — `source:` printed on EVERY run, and no silent
 * fallback: if D1 cannot be reached the script fails instead of answering from
 * an older store. `--archive` asks for the frozen copy on purpose.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs only — no `Db.init()` (that is a DDL
 * batch), no DDL, no worker_state write, no counter, no rotation slot, no
 * uptime. The two statements below are Db.getWorkerState's / Db.getWorkerStates'
 * own SQL, copied because calling them needs `Db.init()` first (Db.get()
 * refuses an uninitialised client) — which is exactly the write this probe must
 * not do. Keep them in sync with src/db.ts.
 *
 * Run: node scripts/read-heartbeat.js        (D1: CLOUDFLARE_ACCOUNT_ID +
 *                                             CLOUDFLARE_API_TOKEN, or an
 *                                             explicit D1_DATABASE_ID)
 *      node scripts/read-heartbeat.js 3 70   (3 samples, 70s apart)
 *      node scripts/read-heartbeat.js --keys dex_list_cache_hits,dex_list_cache_last
 *        (any durable worker_state row, by name — one SELECT for the list, the
 *         same read-only discipline, for the questions that are about a ROW and
 *         not the heartbeat; `-` means the row is absent, which is a different
 *         reading from an empty one)
 *      node scripts/read-heartbeat.js --archive
 *        (the pre-cutover Turso copy — rows stop when D1 took over; a heartbeat
 *         there is history, never "now")
 */
"use strict";

const { createClient } = require("@libsql/client");

const { loadConfig } = require("../dist/config.js");
const { SCHEMA_DDL_FINGERPRINT_KEY } = require("../dist/db.js");
const d1 = require("../dist/d1.js");
const d1Rest = require("./d1-rest.js");

/** The database the Worker writes, resolved by name when no id is exported. */
const D1_DATABASE_NAME_FALLBACK = "solana-meme-bot";

/** worker_state is (key TEXT PRIMARY KEY, value TEXT) — see Db.getWorkerState. */
const ROW_SQL = "SELECT value FROM worker_state WHERE key = ?";
const ROWS_SQL = (n) =>
  `SELECT key, value FROM worker_state WHERE key IN (${Array(n)
    .fill("?")
    .join(",")})`;

/** Print one field, or a dash when the tick predates that reading. */
const show = (label, value) =>
  console.log(`  ${label}: ${value === undefined || value === null ? "-" : JSON.stringify(value)}`);

/** Rows of a SELECT — libsql and the D1 transport both answer `.rows`. */
const rowsOf = (res) => res?.rows ?? [];

/** One row's `value`, or null: Db.getWorkerState's own answer shape. */
function rowValue(res) {
  const row = rowsOf(res)[0];
  if (!row) return null;
  const v = row.value;
  return v === null || v === undefined ? null : String(v);
}

/**
 * WHERE THE ROWS COME FROM — named on every run (see the header): D1 live by
 * default, the frozen archive only when `--archive` asks for it. No fallback
 * between the two stores: a probe that quietly switches source is the bug this
 * function exists to fix.
 */
async function openReadTarget(argv) {
  if (argv.includes("--archive")) {
    const config = loadConfig(process.env);
    if (!config.tursoUrl) {
      throw new Error("--archive needs TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)");
    }
    const client = createClient({
      url: config.tursoUrl,
      authToken: config.tursoAuthToken,
    });
    return {
      kind:
        "Turso archive (READ-ONLY — NOT live; the pre-2026-10-15-cutover copy)",
      select: (sql, args) => client.execute({ sql, args }),
    };
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!process.env.D1_DATABASE_ID && !(accountId && apiToken)) {
    throw new Error(
      "no live store: D1 needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN " +
        "(or an explicit D1_DATABASE_ID). Pass --archive only to read the " +
        "frozen Turso copy on purpose.",
    );
  }
  const api = d1Rest.createD1Rest({ accountId, apiToken });
  // By id when given, else BY NAME with one read-only list call (no create:
  // `scripts/d1-copy.js ensure` is the only thing allowed to make databases).
  const named = process.env.D1_DATABASE_NAME || D1_DATABASE_NAME_FALLBACK;
  const id =
    process.env.D1_DATABASE_ID ||
    (await api.listDatabases()).find((db) => db.name === named)?.uuid ||
    null;
  if (!id) {
    throw new Error(
      `D1_DATABASE_ID is unset and the account has no database named "${named}"`,
    );
  }
  const transport = d1.createD1Transport(d1Rest.createRestBinding(api, id));
  return {
    kind: `D1 ${id}${process.env.D1_DATABASE_ID ? "" : ` (named "${named}")`} — LIVE`,
    select: (sql, args = []) => transport.execute({ sql, args }),
  };
}

async function main() {
  // The first two positional args are the sample count / gap — but a flag
  // (`--archive`, `--keys ...`) in argv[2] is not a number, and NaN would
  // silently run ZERO samples and print only the source line.
  const n2 = Number(process.argv[2]);
  const n3 = Number(process.argv[3]);
  const samples = Number.isFinite(n2) && n2 >= 1 ? Math.floor(n2) : 1;
  const gapSeconds = Number.isFinite(n3) && n3 > 0 ? n3 : 70;
  const target = await openReadTarget(process.argv.slice(2));
  console.log(`source: ${target.kind}`);

  const keyArg = process.argv.indexOf("--keys");
  if (keyArg !== -1) {
    const keys = String(process.argv[keyArg + 1] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      console.error("--keys needs a comma-separated list of worker_state keys");
      process.exit(1);
    }
    // ONE request for the whole list (see Db.getWorkerStates): reading rows by
    // name must not cost a round trip each, which is the same reason the tick
    // batches them.
    const res = await target.select(ROWS_SQL(keys.length), keys);
    const rows = new Map(rowsOf(res).map((r) => [String(r.key), String(r.value)]));
    console.log(`worker_state @ ${new Date().toISOString()}`);
    for (const key of keys) show(key, rows.get(key));
    process.exit(0);
  }

  for (let i = 1; i <= samples; i++) {
    const raw = rowValue(await target.select(ROW_SQL, ["scan_heartbeat"]));
    if (!raw) {
      console.log(`sample ${i}: no heartbeat row yet`);
    } else {
      let hb;
      try {
        hb = JSON.parse(raw);
      } catch (err) {
        console.log(`sample ${i}: heartbeat unparseable — ${err.message}`);
        hb = null;
      }
      if (hb) {
        const s = hb.summary ?? {};
        console.log(
          `sample ${i} @ ${new Date(hb.at ?? 0).toISOString()}  ` +
            `ok=${hb.ok} phase=${hb.phase} ms=${hb.ms} ageS=${Math.round((Date.now() - (hb.at ?? 0)) / 1000)}`,
        );
        show("preTick.steps", s.preTick?.steps);
        show("preTick.preStartMs/preRaceMs/raceMs", [
          s.preTick?.preStartMs,
          s.preTick?.preRaceMs,
          s.preTick?.raceMs,
        ]);
        show("dbSteps", s.dbSteps);
        show("modeRead", s.modeRead);
        show("dbMs", s.dbMs);
      }
      if (hb) {
        // The DDL gate's own evidence (see SCHEMA_DDL_FINGERPRINT_KEY in
        // src/db.ts): this row is what lets the NEXT cold isolate skip the
        // 18-statement batch, and its value identifies the exact statement
        // list that database is stamped with. Absent = the gate is unarmed and
        // every isolate is still paying the batch; present = a recycled
        // isolate's init is one ~46-byte read instead.
        const fp = rowValue(
          await target.select(ROW_SQL, [SCHEMA_DDL_FINGERPRINT_KEY]),
        );
        show("schema_ddl_fingerprint", fp);
      }
    }
    if (i < samples) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read-heartbeat failed:", err);
  process.exit(1);
});
