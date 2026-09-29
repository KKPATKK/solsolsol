/*
 * Tests for docs/patches/heal-front-one-read-2026-09-29.apply.js (P0-1/P0-2).
 *
 * Three claims, in the order they matter:
 *   1. the widened Db read really is ONE request and really carries the two
 *      proof rows — and the narrow call still does not (the widening is opt-in,
 *      which is what lets every existing heal fixture keep its old shape);
 *   2. deliveredProofFromRows answers EXACTLY what the two separate ring
 *      readers answer for the same row — the carried path must not be able to
 *      disagree with the seam path about what "delivered" means;
 *   3. a real pass takes the carried path: the coin is enrolled, the ring is
 *      never read through the seam (zero requests), and a 補發 still goes out
 *      when the ring proves nothing.
 *
 * Idempotent.
 *
 *   node docs/patches/heal-front-one-read-2026-09-29.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("the carried read must not be undone")) {
  console.log("already applied — scripts/test-unit.js untouched");
  process.exit(0);
}

function swap(label, old, neu) {
  const parts = src.split(old);
  if (parts.length !== 2) {
    console.error(`ANCHOR MISS (${parts.length - 1} matches): ${label}`);
    process.exit(1);
  }
  src = parts.join(neu);
  console.log(`ok: ${label}`);
}

swap(
  "append the heal-front tests",
  `  console.log("\\n===== UNIT TESTS =====");`,
  `  // ---------- the heal's opening read is ONE request (src/db.ts + src/pushwatch.ts) ----------
  //
  // P0-1/P0-2 (2026-09-29). One pass's heal opening used to be FOUR Turso
  // requests: the untracked list + ledger, then the \`push_audit\` ring TWICE
  // (the initial-only set through getInitialPushAuditTokens, then the whole ring
  // again through getPushAudit) and the unconfirmed-card record. Live
  // \`summary.dbTickSteps\` on one tick: \`findUntrackedPushesAndLedger 589\`,
  // \`getWorkerState:push_audit 289\`, \`getPushAudit 289\` — 1.17s of one stage's
  // opening bookkeeping, and the ring read twice is the purest instance of it in
  // the whole tick (same row, same moment, two requests).
  await test("db.findUntrackedPushesAndLedger: the proof rows ride the SAME request, and only when asked", async () => {
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    const now = Date.now();
    // A pushed coin with no push_watch row: seen_tokens is the listing's source.
    assert.equal(await db.claimTokenPush("chat-h", "HEALONE"), true);
    const ring = [{ kind: "initial", token: "HEALONE", at: now }];
    const unconf = JSON.stringify([{ chatId: "chat-h", token: "OTHER", at: now }]);
    await db.setWorkerState("push_audit", JSON.stringify(ring));
    await db.setWorkerState("unconfirmed_card_sends", unconf);
    await db.setWorkerState("push_ledger", "{\\"entries\\":[]}");

    // Count the requests: a delegate rather than a spy on the client object,
    // because libsql's client keeps its methods on the prototype.
    let batches = 0;
    const counting = new Db("file:injected", undefined, {
      execute: (a) => t.client.execute(a),
      batch: (a, m) => {
        batches += 1;
        return t.client.batch(a, m);
      },
      close: () => t.client.close(),
    });

    // WIDE: four statements, one request, both proof rows present.
    const wide = await counting.findUntrackedPushesAndLedger(
      now - 3_600_000,
      "push_ledger",
      10,
      "unconfirmed_card_sends",
    );
    assert.equal(batches, 1, \`the wide read must be ONE request, got \${batches}\`);
    assert.equal(wide.proofsCarried, true, "…and it says the rows are its own");
    assert.equal(wide.auditRaw, JSON.stringify(ring), "the ring, as the row holds it");
    assert.equal(wide.unconfirmedRaw, unconf, "the unconfirmed record, verbatim");
    assert.deepEqual(
      wide.missing.map((m) => m.token),
      ["HEALONE"],
      "the untracked listing is unchanged — the extra rows are additive",
    );
    assert.equal(
      wide.ledgerRaw,
      "{\\"entries\\":[]}",
      "and so is the ledger row that already rode it",
    );

    // NARROW: the two-statement shape every older caller and narrow Db double
    // uses. No proof rows may appear, or a caller would read a row it never
    // asked for as if it were proof.
    batches = 0;
    const narrow = await counting.findUntrackedPushesAndLedger(
      now - 3_600_000,
      "push_ledger",
      10,
    );
    assert.equal(batches, 1, "the narrow read is still ONE request");
    assert.equal(narrow.proofsCarried, undefined, "…and carries no proof claim");
    assert.equal(narrow.auditRaw, undefined, "…and no ring");
    assert.equal(narrow.unconfirmedRaw, undefined, "…and no unconfirmed record");
    await t.cleanup();
  });

  await test("deliveredProofFromRows: the carried read answers exactly what the two ring readers do", async () => {
    const { deliveredProofFromRows } = require("../dist/pushwatch.js");
    const ring = [
      { kind: "initial", token: "A", at: 1 },
      { kind: "resend", token: "B", at: 2 },
      { kind: "followup", token: "C", at: 3 },
      { kind: "pushed-row", token: "D", at: 4 },
      { token: "E", at: 5 },
    ];
    const carried = deliveredProofFromRows(
      JSON.stringify(ring),
      JSON.stringify([{ chatId: "c", token: "F", at: 6 }]),
    );
    // The seam path, spelled out: the initial-only set (the rule
    // Db.getInitialPushAuditTokens applies) UNION the wider delivered kinds
    // (deferrallog.deliveredCardTokens) — which is what readDeliveredTokens
    // built out of TWO requests into this same row.
    const viaSeam = new Set([
      ...new Set(
        ring
          .filter((e) => e.kind === "initial" && e.token)
          .map((e) => String(e.token)),
      ),
      ...deliveredCardTokens(ring),
    ]);
    assert.deepEqual(
      [...carried.tokens].sort(),
      [...viaSeam].sort(),
      "the carried read must not be able to disagree with the seam path",
    );
    assert.ok(carried.tokens.has("A"), "an initial send is proof");
    assert.ok(carried.tokens.has("B"), "…and so is a 補發 (the resend kind)");
    assert.ok(
      !carried.tokens.has("C"),
      "…but a tracker follow-up is NOT (that is deliveredFollowupTokens' question)",
    );
    assert.ok(!carried.tokens.has("E"), "an untagged entry proves nothing");
    assert.deepEqual([...carried.unconfirmed], ["F"], "the record is parsed the same way");

    // Absent and unreadable rows are "nothing proven", never a throw: the heal's
    // gate must stay fail-open in the never-miss direction.
    for (const bad of [null, ""]) {
      assert.equal(deliveredProofFromRows(bad, bad).tokens.size, 0, \`ring \${bad}\`);
      assert.equal(deliveredProofFromRows(bad, bad).unconfirmed.size, 0, \`record \${bad}\`);
    }
    assert.equal(
      deliveredProofFromRows("{", "nope").tokens.size,
      0,
      "a corrupt ring proves nothing",
    );
  });

  await test("PushWatcher self-heal: carried proof costs no request, and still re-sends an unproven card", async () => {
    const { PushWatcher: PW } = require("../dist/pushwatch.js");
    const mint = "CARRIED1";
    const pushedAt = Date.now() - 300_000; // inside the 15-minute resend grace
    const enrolled = [];
    const sent = [];
    let ringReads = 0;
    const pair = (token) => ({
      chainId: "solana", url: "", pairAddress: \`p-\${token}\`,
      baseToken: { address: token, name: token, symbol: token },
      priceUsd: "0.001", marketCap: 12_000,
      volume: { h24: 1_000_000, h1: 20_000, m5: 1_000 },
      priceChange: { m5: 1, h1: 5 },
      txns: { m5Buys: 10, m5Sells: 8, h1Buys: 100, h1Sells: 80 },
      liquidity: { usd: 50_000 }, pairCreatedAt: pushedAt,
    });
    const pairsFor = async (addrs) => new Map(addrs.map((a) => [a, pair(a)]));
    const db = (auditRaw) => ({
      listPushWatch: async () => [],
      prunePushWatch: async () => 0,
      findUntrackedPushes: async () => [],
      // The widened return: \`proofsCarried\` only on the call that named the
      // unconfirmed key, which is the heal's own.
      findUntrackedPushesAndLedger: async (_since, _ledgerKey, _limit, unconfirmedKey) => ({
        missing: [{ token: mint, chatId: "c", pushedAt }],
        ledgerRaw: null,
        auditRaw,
        unconfirmedRaw: null,
        ...(unconfirmedKey === undefined ? {} : { proofsCarried: true }),
      }),
      claimRecapsAndPrune: async (list) => ({ won: list.map(() => false), pruned: 0 }),
      markRecapClaimed: async () => false,
      markRecapClaimedMany: async (list) => list.map(() => false),
      // The three-request seam. With the rows carried, neither ring reader may
      // be reached — that is the request this change removes.
      getInitialPushAuditTokens: async () => { ringReads += 1; return new Set(); },
      getPushAudit: async () => { ringReads += 1; return []; },
      getWorkerState: async () => null,
      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
      recordPushDelivery: async () => {},
      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),
      claimPushWatchChecksMany: async (rows) => rows.map(() => true),
      claimPushWatchCheck: async () => true,
      updatePushWatchCheck: async () => {},
      deletePushWatch: async () => {},
      setPushWatchHolders: async () => {},
    });
    const bot = {
      api: {
        sendMessage: async (_chatId, text) => {
          sent.push(String(text));
          return { message_id: 9 };
        },
      },
    };
    const mk = (auditRaw) =>
      new PW(db(auditRaw), bot, null, loadConfig({}), pairsFor, null);

    // (a) the ring PROVES the first card was delivered: enroll, never re-send.
    await mk(JSON.stringify([{ kind: "initial", token: mint, at: pushedAt }])).runTick();
    assert.equal(enrolled.length, 1, "a proven delivery is still enrolled for tracking");
    assert.ok(
      !sent.some((t) => t.includes("補發")),
      \`a delivered card must not be re-sent: \${JSON.stringify(sent)}\`,
    );
    assert.equal(
      ringReads,
      0,
      "the carried rows must not be undone by a request of their own",
    );

    // (b) the ring proves NOTHING: the 補發 goes out — still with no extra read.
    sent.length = 0;
    await mk(null).runTick();
    assert.equal(enrolled.length, 2, "the unproven coin is enrolled too");
    assert.ok(
      sent.some((t) => t.includes("補發")),
      \`an unproven card is re-sent: \${JSON.stringify(sent)}\`,
    );
    assert.equal(ringReads, 0, "…and the ring is still not read again");
  });

  console.log("\\n===== UNIT TESTS =====");`,
);

fs.writeFileSync(file, src);
console.log("scripts/test-unit.js written");
