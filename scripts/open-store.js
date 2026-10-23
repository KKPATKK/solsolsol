/*
 * WHERE THE OFF-BODY TOOLS READ FROM — one place that decides it (2026-10-22).
 *
 * WHY THIS EXISTS. Every operator tool outside the Worker needs the same
 * answer: "which store holds the state I am about to read?" Until now each
 * script answered it for itself, and `scripts/read-heartbeat.js` answered it
 * WRONG — `new Db(config.tursoUrl, ...)`, the READ-ONLY Turso archive frozen at
 * the 2026-10-15 cutover — while printing readings that looked live. The
 * instrument was a day behind production and reported `ok=true` (2026-10-22
 * 01:47Z: `ageS=88097` next to a /health row 12 seconds old). A store decided
 * per script is exactly the arrangement that lets that happen twice.
 *
 * THE RULE, in one sentence: live D1 by default, the frozen archive only when
 * `--archive` asks for it, `source:` printed before the first reading, and no
 * fallback between the two — an unreachable D1 fails the run rather than
 * answering from an older store.
 *
 * THE PAIR THAT ANSWERS: the REST binding (scripts/d1-rest.js) + the Workers
 * transport (src/d1.ts), the same two the migration and the backfill use, so
 * the SQL these tools run is byte-for-byte the SQL production runs and the
 * result shape is libsql's (`{rows, rowsAffected}`) either way.
 *
 * TWO SEAMS, because there are two shapes of caller here:
 *   openTarget(argv) -> { kind, live, select }   raw SQL: `select(sql, args)`
 *   openDb(argv)     -> { kind, live, db }       `Db` methods (getReevalPool…)
 * `openDb` includes `init()` because `Db.get()` refuses an uninitialised
 * client; on live D1 that init is the fingerprint-gated batch production runs
 * on every cold isolate (one ~46-byte read when the stamp matches), and no
 * caller here passes a `front`, so no gate that WOULD write can move a stamp.
 *
 * READ-ONLY BY CONSTRUCTION on both seams: nothing in this module writes a
 * row, and the archive branch refuses to build a Db at all without its creds.
 *
 * Run (as a library): const { openTarget } = require("./open-store.js");
 *                     const t = await openTarget(process.argv.slice(2));
 *                     console.log(`source: ${t.kind}`);
 *                     const rows = (await t.select("SELECT 1", [])).rows;
 */
"use strict";

const { createClient } = require("@libsql/client");

const { Db } = require("../dist/db.js");
const { loadConfig } = require("../dist/config.js");
const d1 = require("../dist/d1.js");
const d1Rest = require("./d1-rest.js");

/** The database the Worker writes, resolved by name when no id is exported. */
const D1_DATABASE_NAME_FALLBACK = "solana-meme-bot";

/** The label every archive-backed run carries (see the header). */
const ARCHIVE_KIND =
  "Turso archive (READ-ONLY — NOT live; the pre-2026-10-15-cutover copy)";

/** `--archive` is the ONLY way to reach the frozen copy. */
function archiveWanted(argv = process.argv.slice(2)) {
  return argv.includes("--archive");
}

/**
 * The live binding: by id when exported, else BY NAME with one read-only list
 * call (no create — `scripts/d1-copy.js ensure` is the only thing allowed to
 * make databases). Missing credentials are an error naming both ways to
 * proceed, never a silent switch of store.
 */
async function openD1Binding() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!process.env.D1_DATABASE_ID && !(accountId && apiToken)) {
    throw new Error(
      "no live store: D1 needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN " +
        "(or an explicit D1_DATABASE_ID). Pass --archive to read the frozen " +
        "Turso copy on purpose.",
    );
  }
  const api = d1Rest.createD1Rest({ accountId, apiToken });
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
  return {
    id,
    named,
    explicit: Boolean(process.env.D1_DATABASE_ID),
    binding: d1Rest.createRestBinding(api, id),
  };
}

/** The frozen copy, only on `--archive`. */
function archiveTarget() {
  const cfg = loadConfig(process.env);
  if (!cfg.tursoUrl) {
    throw new Error("--archive needs TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)");
  }
  const client = createClient({
    url: cfg.tursoUrl,
    authToken: cfg.tursoAuthToken,
  });
  return { kind: ARCHIVE_KIND, live: false, cfg, client };
}

/**
 * The one read seam both stores answer: `{sql, args}` in, `{rows}` out —
 * libsql's shape, which is also what src/d1.ts's transport normalises D1 into.
 */
function selectOf(target) {
  if (target.client) return (sql, args = []) => target.client.execute({ sql, args });
  const transport = d1.createD1Transport(target.binding);
  return (sql, args = []) => transport.execute({ sql, args });
}

/**
 * Which store, answered before any reading: `{ kind, live, select }`.
 * `kind` is meant to be printed (`source: …`) — the whole point of this module
 * is that a reader can never again mistake a frozen row for a fresh one.
 */
async function openTarget(argv = process.argv.slice(2)) {
  if (archiveWanted(argv)) {
    const target = archiveTarget();
    return { ...target, select: selectOf(target) };
  }
  const liveBinding = await openD1Binding();
  const target = {
    kind: `D1 ${liveBinding.id}${liveBinding.explicit ? "" : ` (named "${liveBinding.named}")`} — LIVE`,
    live: true,
    binding: liveBinding.binding,
  };
  return { ...target, select: selectOf(target) };
}

/**
 * A `Db` on the chosen store, with `init()` already run (see the header on why
 * that is not a write). Same `{ kind, live }` labels as openTarget, so a script
 * that needs the Db methods prints the same `source:` line.
 */
async function openDb(argv = process.argv.slice(2)) {
  const target = await openTarget(argv);
  const db = target.live
    ? new Db("", undefined, undefined, target.binding)
    : new Db(target.cfg.tursoUrl, target.cfg.tursoAuthToken);
  await db.init();
  return { kind: target.kind, live: target.live, db };
}

module.exports = {
  ARCHIVE_KIND,
  D1_DATABASE_NAME_FALLBACK,
  archiveWanted,
  openDb,
  openD1Binding,
  openTarget,
};
