/*
 * The last-good profile list's durable journal (2026-09-26).
 *
 * WHY THIS IS A FILE OF ITS OWN: the failure this change removes is a tick that
 * LOOKS healthy — `profiles: 2` is a legal reading (the make-up lane) — while
 * the discovery source was refused. The client already had the reuse lane; what
 * could silently break is the part that now crosses the isolate boundary, so
 * these are the things asserted here instead of watched for live:
 *
 *   1. What the journal row accepts and refuses: a half-written row must read
 *      as "no snapshot", never as a list of garbage tokens.
 *   2. A refused fetch serves the SEEDED list — the whole point — and a stale
 *      seed is ignored (the reuse window is unchanged at PROFILE_FEED_REUSE_MS).
 *   3. The freshest list wins in both directions, and a REUSED list keeps the
 *      fetch's own stamp (so the tick never re-journals what it just read).
 *   4. The row rides the front's EXISTING read and write: the key is in
 *      SCAN_FRONT_GATE_KEYS (one statement, not a new round trip) and a REPLACE
 *      through the real Db.writeScanFront lands and reads back.
 *   5. The scanner is wired to both ends (source guard) — a journal nothing
 *      seeds from, or a seed nothing writes, is exactly the silence this is
 *      meant to end.
 *
 * Run: node scripts/test-dex-last-profiles.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { loadConfig } = require("../dist/config.js");
const {
  DexScreenerClient,
  parseProfileFeedSnapshot,
  PROFILE_FEED_REUSE_MS,
  PROFILE_FEED_LAST_MAX,
} = require("../dist/dexscreener.js");
const {
  Db,
  SCAN_FRONT_GATE_KEYS,
  DEX_PROFILES_LAST_KEY,
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

/** A 200 list answering with those tokens. */
const okList = (tokens) =>
  new Response(
    JSON.stringify(tokens.map((t) => ({ chainId: "solana", tokenAddress: t }))),
    { status: 200 },
  );
/** The refusal this whole change exists for. */
const refused = () =>
  new Response(JSON.stringify({ error: "nope" }), { status: 429 });

/** A client with no throttle wait, so each leg answers immediately. */
const client = () =>
  new DexScreenerClient(loadConfig({ DEX_REQUEST_INTERVAL_MS: "0" }));

function tmpDb() {
  const p = path.join(
    os.tmpdir(),
    `dex-prof-last-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return { p, client: createClient({ url: `file:${p}` }) };
}

async function main() {
  // ---------- what the row accepts ----------
  await test("the journal row: a snapshot round-trips, anything else reads as absent", () => {
    assert.deepEqual(
      parseProfileFeedSnapshot(JSON.stringify({ at: 123, tokens: ["A", "B"] })),
      { at: 123, tokens: ["A", "B"] },
    );
    assert.equal(parseProfileFeedSnapshot(null), null, "no row = no snapshot");
    assert.equal(parseProfileFeedSnapshot(""), null);
    assert.equal(parseProfileFeedSnapshot("{not json"), null, "a half-written row is not a list");
    assert.equal(
      parseProfileFeedSnapshot(JSON.stringify({ at: 0, tokens: ["A"] })),
      null,
      "an at of 0 is not a fetch stamp",
    );
    assert.equal(
      parseProfileFeedSnapshot(JSON.stringify({ at: 1, tokens: [] })),
      null,
      "an empty list has nothing to reuse",
    );
    assert.equal(parseProfileFeedSnapshot(JSON.stringify({ at: 1, tokens: "A" })), null);
    assert.deepEqual(
      parseProfileFeedSnapshot(JSON.stringify({ at: 1, tokens: ["A", 7, null, "B"] })),
      { at: 1, tokens: ["A", "B"] },
      "non-strings are dropped, never evaluated as tokens",
    );
    const big = Array.from({ length: PROFILE_FEED_LAST_MAX * 2 }, (_, i) => `T${i}`);
    assert.equal(
      parseProfileFeedSnapshot(JSON.stringify({ at: 1, tokens: big })).tokens.length,
      PROFILE_FEED_LAST_MAX,
      "the read guard bounds the row",
    );
  });

  // ---------- a refused fetch serves the seed ----------
  await test("a 429 tick evaluates the SEEDED list instead of the make-up coins alone", async () => {
    globalThis.fetch = async () => refused();
    const dex = client();
    const seededAt = Date.now() - 60_000;
    dex.seedLastGoodProfiles({ at: seededAt, tokens: ["SEED_A", "SEED_B"] });
    const out = await dex.fetchLatestSolanaProfiles();
    assert.deepEqual(
      out.map((p) => p.tokenAddress),
      ["SEED_A", "SEED_B"],
      "the refused fetch served the last good list",
    );
    const snap = dex.lastGoodProfilesSnapshot();
    assert.equal(snap.at, seededAt, "and the list keeps the FETCH's stamp, not this tick's");
    assert.deepEqual(snap.tokens, ["SEED_A", "SEED_B"]);
  });

  await test("a stale seed is ignored: the reuse window is unchanged", async () => {
    globalThis.fetch = async () => refused();
    const dex = client();
    dex.seedLastGoodProfiles({
      at: Date.now() - PROFILE_FEED_REUSE_MS - 1_000,
      tokens: ["OLD_A"],
    });
    const out = await dex.fetchLatestSolanaProfiles();
    assert.deepEqual(out, [], "past the window the tick is back to the make-up lane alone");
  });

  await test("the freshest list wins, in both directions", async () => {
    globalThis.fetch = async () => okList(["FRESH_A"]);
    const dex = client();
    dex.seedLastGoodProfiles({ at: Date.now() - 5 * 60_000, tokens: ["OLD_A"] });
    const out = await dex.fetchLatestSolanaProfiles();
    assert.deepEqual(
      out.map((p) => p.tokenAddress),
      ["FRESH_A"],
      "a successful fetch is the fresh list",
    );
    const snap = dex.lastGoodProfilesSnapshot();
    assert.deepEqual(snap.tokens, ["FRESH_A"], "and it is what the tick journals");
    assert.ok(snap.at > Date.now() - 5_000, "with its own fetch stamp");
    // (b) an older row cannot displace a fresher in-isolate list.
    dex.seedLastGoodProfiles({ at: snap.at - 1_000, tokens: ["ROW_A"] });
    assert.deepEqual(
      dex.lastGoodProfilesSnapshot().tokens,
      ["FRESH_A"],
      "the older row does not displace it",
    );
  });

  await test("a reused list is NOT re-journaled (its stamp does not move)", async () => {
    globalThis.fetch = async () => refused();
    const dex = client();
    const at = Date.now() - 120_000;
    dex.seedLastGoodProfiles({ at, tokens: ["SEED_A"] });
    await dex.fetchLatestSolanaProfiles();
    assert.equal(
      dex.lastGoodProfilesSnapshot().at,
      at,
      "the stamp stays the fetch's — the scanner's write is skipped for it",
    );
  });

  // ---------- the front carries the row ----------
  await test("the key rides the front's read list (one statement, no new round trip)", () => {
    assert.ok(
      SCAN_FRONT_GATE_KEYS.includes(DEX_PROFILES_LAST_KEY),
      "the seed needs the row in the read that already goes out",
    );
  });

  await test("through the real Db: a REPLACE lands as a snapshot and reads back", async () => {
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    await db.writeScanFront([
      {
        key: DEX_PROFILES_LAST_KEY,
        value: JSON.stringify({ at: 777, tokens: ["A", "B"] }),
        add: false,
      },
    ]);
    const front = await db.readScanFront(SCAN_FRONT_GATE_KEYS);
    assert.deepEqual(
      parseProfileFeedSnapshot(front.gates.get(DEX_PROFILES_LAST_KEY) ?? null),
      { at: 777, tokens: ["A", "B"] },
      "the row the front read carries is the snapshot",
    );
    await db.writeScanFront([
      {
        key: DEX_PROFILES_LAST_KEY,
        value: JSON.stringify({ at: 778, tokens: ["C"] }),
        add: false,
      },
    ]);
    const front2 = await db.readScanFront(SCAN_FRONT_GATE_KEYS);
    assert.deepEqual(
      parseProfileFeedSnapshot(front2.gates.get(DEX_PROFILES_LAST_KEY) ?? null),
      { at: 778, tokens: ["C"] },
      "a REPLACE, not an accumulate — a snapshot is not a counter",
    );
  });

  // ---------- the fast fetch that beats the front read ----------
  await test("a list fetched BEFORE the front read still journals (the live miss)", async () => {
    // The ordering the live bug ran on (2026-09-26T22:44-22:50Z): the fetch is
    // dispatched above the front read, so an edge-cache HIT — and every 200
    // that beats Turso's ~100ms — is already in the client when the row is
    // read. The scanner derives its skip stamp from the ROW it read; deriving
    // it from the client stamped this tick's own fresh list and skipped the
    // write, leaving `dex_profiles_last` absent for nine minutes of successful
    // ticks.
    globalThis.fetch = async () => okList(["FAST_A"]);
    const dex = client();
    const row = parseProfileFeedSnapshot(null); // the read found no row
    dex.seedLastGoodProfiles(row); // …and seeded nothing
    const out = await dex.fetchLatestSolanaProfiles();
    const snap = dex.lastGoodProfilesSnapshot();
    assert.deepEqual(out.map((p) => p.tokenAddress), ["FAST_A"]);
    assert.ok(
      snap !== null && snap.at !== (row?.at ?? null),
      "a snapshot newer than the row is journaled, however early the fetch landed",
    );

    // The other half of the rule, once the row carries that very list: a REUSED
    // list keeps the row's stamp, so the scanner's `snap.at === stamped` skip
    // still spares the redundant write.
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    await db.writeScanFront([
      { key: DEX_PROFILES_LAST_KEY, value: JSON.stringify(snap), add: false },
    ]);
    const front = await db.readScanFront(SCAN_FRONT_GATE_KEYS);
    const row2 = parseProfileFeedSnapshot(
      front.gates.get(DEX_PROFILES_LAST_KEY) ?? null,
    );
    globalThis.fetch = async () => refused();
    const dex2 = client();
    dex2.seedLastGoodProfiles(row2);
    await dex2.fetchLatestSolanaProfiles();
    assert.equal(
      dex2.lastGoodProfilesSnapshot().at,
      row2?.at ?? null,
      "the reused list keeps the ROW's stamp — no re-write, and the reuse lane works",
    );
  });

  // ---------- the scanner is wired to both ends ----------
  await test("the scanner seeds from the front read and journals exactly once", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "scanner.ts"),
      "utf8",
    );
    const read = src.indexOf("readScanFront(SCAN_FRONT_GATE_KEYS)");
    const seed = src.indexOf("seedLastGoodProfiles(");
    assert.ok(read !== -1, "the front read exists");
    assert.ok(seed !== -1, "the seed exists");
    assert.ok(seed > read, "the seed comes after the read that carries the row");
    assert.ok(
      src.includes("front.gates.get(DEX_PROFILES_LAST_KEY) ?? null"),
      "and it parses the row, not a retyped shape",
    );
    assert.ok(
      src.includes("const profileFeedRow = parseProfileFeedSnapshot("),
      "with the parsed row held in one place, so the seed and the stamp cannot drift",
    );
    const calls = src.split("this.stampProfileFeedSnapshot();").length - 1;
    assert.equal(calls, 1, "the journal runs on the tick's own journal block");
    assert.ok(
      src.includes("snap.at === this.profileFeedStampedAt"),
      "and a reused list is skipped by stamp rather than re-written",
    );
    // …and the stamp is the ROW's, taken from the parse this seed already does.
    // Reading it off the client (the live bug) made a fetch that beat the front
    // read look journaled; the pin is on BOTH halves, so neither can come back.
    assert.ok(
      src.includes("this.profileFeedStampedAt = profileFeedRow?.at ?? null"),
      "the stamp is the front-read row's, so the tick's own fresh list still journals",
    );
    assert.ok(
      !src.includes(
        "this.profileFeedStampedAt = this.dex.lastGoodProfilesSnapshot()?.at ?? null",
      ),
      "and never the client's live list, which the pre-read fetch has already written",
    );
  });

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
